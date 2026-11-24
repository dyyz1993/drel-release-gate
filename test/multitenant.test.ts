import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import worker from '../src/index';
import { TenantStore } from '../src/tenant-store';
import { issueTicket } from '../src/ticket';

const oidcIssuer = 'https://token.actions.githubusercontent.com';
const oidcAudience = 'https://approve.example.com';
const repository = 'owner/repo';
const sha = 'b'.repeat(40);
const workflowRef = 'owner/repo/.github/workflows/release.yml@refs/heads/main';

function makeStorage() {
  const values = new Map<string, unknown>();
  return {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
    transaction: async (callback: (txn: {
      get: (key: string) => Promise<unknown>;
      put: (key: string, value: unknown) => Promise<void>;
    }) => Promise<void>) => {
      await callback({
        get: async (key: string) => values.get(key),
        put: async (key: string, value: unknown) => {
          values.set(key, value);
        },
      });
    },
  };
}

// Signs a token for the fixture's run; `claims` replace individual OIDC claims.
async function signOidc(
  fixture: { oidcPrivateKey: string },
  claims: Record<string, unknown>
): Promise<string> {
  return new SignJWT({
    repository,
    run_id: '12345',
    run_attempt: '2',
    sha,
    workflow_ref: workflowRef,
    ref: 'refs/heads/main',
    actor: 'release-bot',
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'oidc-key' })
    .setIssuer(oidcIssuer)
    .setAudience(oidcAudience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(await importPKCS8(fixture.oidcPrivateKey, 'RS256'));
}

async function makeOidcAndAppKey() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicJwk = publicKey.export({ format: 'jwk' });
  const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const fixture = {
    oidcPrivateKey: privatePem,
    jwks: { keys: [{ ...publicJwk, kid: 'oidc-key', alg: 'RS256', use: 'sig' }] },
    appPrivateKey: appKey.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
  return { ...fixture, jwt: await signOidc(fixture, {}) };
}

function makeEnv(fixture: Awaited<ReturnType<typeof makeOidcAndAppKey>>) {
  const store = new TenantStore({ storage: makeStorage() } as any);
  const tenants = {
    idFromName: () => 'global',
    get: () => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) =>
        store.fetch(new Request(String(input), init)),
    }),
  };
  return {
    REPO: repository,
    ENVIRONMENT: 'production',
    GITHUB_APP_ID: '123456',
    GITHUB_APP_PRIVATE_KEY: fixture.appPrivateKey,
    UI_SHARED_SECRET: 'ui-secret-value-long-enough',
    TICKET_SECRET: 't'.repeat(32),
    ADMIN_SECRET: 'admin-secret-value-long-enough',
    OIDC_ISSUER: oidcIssuer,
    OIDC_AUDIENCE: oidcAudience,
    GITHUB_OIDC_JWKS_URL: 'https://example.com/jwks',
    TENANTS: tenants,
    APPROVALS: {
      idFromName: () => 'ticket',
      get: () => ({
        fetch: async (input: RequestInfo | URL) => {
          const path = new URL(String(input)).pathname;
          return path === '/claim'
            ? Response.json({ claimed: true })
            : Response.json({ released: true });
        },
      }),
    },
  } as any;
}

function projectBody(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'ten_1',
    projectId: 'prj_1',
    repository,
    installationId: 9001,
    allowedWorkflowRefs: [workflowRef],
    environments: [{
      name: 'production',
      minApprovals: 1,
    }],
    ...overrides,
  };
}

async function createProject(env: ReturnType<typeof makeEnv>, overrides: Record<string, unknown> = {}) {
  const response = await worker.fetch(new Request('https://example.com/v1/admin/projects', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.ADMIN_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(projectBody(overrides)),
  }), env);
  expect(response.status).toBe(200);
}

// `branchHeads` maps a branch name to its head sha, or to the Response GitHub gives for it.
function makeGithubFetch(jwks: unknown, branchHeads: Record<string, string | Response> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/jwks') return Response.json(jwks);
    const branchPrefix = `/repos/${repository}/branches/`;
    if (url.pathname.startsWith(branchPrefix)) {
      const head = branchHeads[decodeURIComponent(url.pathname.slice(branchPrefix.length))];
      if (head instanceof Response) return head;
      return head
        ? Response.json({ name: 'branch', commit: { sha: head } })
        : new Response('not found', { status: 404 });
    }
    if (url.pathname === '/app/installations/9001/access_tokens') {
      return Response.json({ token: 'installation-token', expires_at: '2030-01-01' });
    }
    if (url.pathname === `/repos/${repository}/actions/runs/12345`) {
      return Response.json({
        run_id: 12345,
        run_attempt: 2,
        status: 'waiting',
        conclusion: null,
        head_sha: sha,
        html_url: 'https://github.com/owner/repo/actions/runs/12345',
        head_branch: 'main',
        created_at: '2026-10-27T00:00:00Z',
        updated_at: '2026-10-27T00:00:00Z',
      });
    }
    if (url.pathname === `/repos/${repository}/environments/production`) {
      return Response.json({ id: 77 });
    }
    if (url.pathname === `/repos/${repository}/actions/runs/12345/pending_deployments`) {
      if (init?.method === 'POST') return Response.json([{ id: 99 }]);
      return Response.json([{ environment: { id: 77 }, id: 99 }]);
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('multi-tenant approval routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a project policy through the admin route', async () => {
    const fixture = await makeOidcAndAppKey();
    const env = makeEnv(fixture);
    const response = await worker.fetch(new Request('https://example.com/v1/admin/projects', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ADMIN_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(projectBody()),
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      tenantId: 'ten_1',
      projectId: 'prj_1',
      policyVersion: 1,
    });
  });

  it('issues a tenant-scoped ticket from GitHub OIDC', async () => {
    const fixture = await makeOidcAndAppKey();
    const env = makeEnv(fixture);
    vi.stubGlobal('fetch', makeGithubFetch(fixture.jwks));
    await worker.fetch(new Request('https://example.com/v1/admin/projects', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ADMIN_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(projectBody()),
    }), env);

    const response = await worker.fetch(new Request('https://example.com/v1/ci/tickets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fixture.jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ environment: 'production', requestId: 'apr_123' }),
    }), env);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({
      requestId: 'apr_123',
      tenantId: 'ten_1',
      projectId: 'prj_1',
      policyVersion: 1,
    });
    expect(body.ticket).toMatch(/^ey/);
  });

  it('does not issue a ticket when OIDC proves a different repository', async () => {
    const fixture = await makeOidcAndAppKey();
    const env = makeEnv(fixture);
    vi.stubGlobal('fetch', makeGithubFetch(fixture.jwks));
    const wrongRepoJwt = await new SignJWT({
      repository: 'other/repo',
      run_id: '12345',
      run_attempt: '2',
      sha,
      workflow_ref: workflowRef,
      ref: 'refs/heads/main',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'oidc-key' })
      .setIssuer(oidcIssuer)
      .setAudience(oidcAudience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(await importPKCS8(fixture.oidcPrivateKey, 'RS256'));
    const response = await worker.fetch(new Request('https://example.com/v1/ci/tickets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${wrongRepoJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ environment: 'production' }),
    }), env);
    expect(response.status).toBe(404);
  });

  it('accepts a scoped ticket without a device identity assertion', async () => {
    const fixture = await makeOidcAndAppKey();
    const env = makeEnv(fixture);
    const admin = await worker.fetch(new Request('https://example.com/v1/admin/projects', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ADMIN_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(projectBody()),
    }), env);
    expect(admin.status).toBe(200);

    const ticket = await issueTicket({
      repo: repository,
      runId: 12345,
      environment: 'production',
      requestId: 'apr_123',
      nonce: 'nonce-123',
      tenantId: 'ten_1',
      projectId: 'prj_1',
      provider: 'github',
      runAttempt: 2,
      sha,
      workflowRef,
      ciActor: 'release-bot',
      policyVersion: 1,
      ticketVersion: 2,
    }, env.TICKET_SECRET, 900);
    vi.stubGlobal('fetch', makeGithubFetch(fixture.jwks));
    const response = await worker.fetch(new Request(
      'https://example.com/v1/approvals/apr_123/decision',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket,
          requestId: 'apr_123',
          actionId: 'approve',
          expectedRevision: 1,
          values: {},
        }),
      }
    ), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      requestId: 'apr_123',
      state: 'approved',
      provider: 'github',
    });
  });

  it('requires the decision requestId to match the ticket route', async () => {
    const fixture = await makeOidcAndAppKey();
    const env = makeEnv(fixture);
    const ticket = await issueTicket({
      repo: repository,
      runId: 12345,
      environment: 'production',
      requestId: 'apr_123',
      nonce: 'nonce-456',
      tenantId: 'ten_1',
      projectId: 'prj_1',
      provider: 'github',
      runAttempt: 2,
      sha,
      workflowRef,
      ciActor: 'release-bot',
      policyVersion: 1,
      ticketVersion: 2,
    }, env.TICKET_SECRET, 900);

    const response = await worker.fetch(new Request(
      'https://example.com/v1/approvals/apr_123/decision',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket,
          requestId: 'apr_other',
          actionId: 'approve',
          expectedRevision: 1,
          values: {},
        }),
      }
    ), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  });
});

describe('workflow ref allow-list', () => {
  const workflow = `${repository}/.github/workflows/release.yml`;
  const tagRef = `${workflow}@refs/tags/v1.0.0`;

  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  let branchHeads: Record<string, string | Response>;

  async function mintTicket(
    fixture: Awaited<ReturnType<typeof makeOidcAndAppKey>>,
    env: ReturnType<typeof makeEnv>,
    claims: Record<string, unknown>
  ) {
    vi.stubGlobal('fetch', makeGithubFetch(fixture.jwks, branchHeads));
    const response = await worker.fetch(new Request('https://example.com/v1/ci/tickets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await signOidc(fixture, claims)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ environment: 'production' }),
    }), env);
    return { response, body: await response.json() as Record<string, unknown> };
  }

  it('issues a ticket for a tag whose commit is the head of the allowed branch', async () => {
    const fixture = await makeOidcAndAppKey();
    const env = makeEnv(fixture);
    branchHeads = { main: sha };
    await createProject(env);

    const { response, body } = await mintTicket(fixture, env, {
      workflow_ref: tagRef,
      ref: 'refs/tags/v1.0.0',
    });

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ requestId: expect.stringMatching(/^apr_/), tenantId: 'ten_1' });
    expect(body.ticket).toMatch(/^ey/);
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input)))
      .toContainEqual(`https://api.github.com/repos/${repository}/branches/main`);
  });

  it('denies a tag whose commit is behind the allowed branch', async () => {
    const fixture = await makeOidcAndAppKey();
    const env = makeEnv(fixture);
    branchHeads = { main: 'c'.repeat(40) };
    await createProject(env);

    const { response, body } = await mintTicket(fixture, env, {
      workflow_ref: tagRef,
      ref: 'refs/tags/v1.0.0',
    });

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: 'scope_denied',
      reason: 'workflow_ref_not_allowed',
      detail: 'tag v1.0.0 is not at the head of main',
    });
  });

  it('denies a tag of another workflow without asking for a branch head', async () => {
    const fixture = await makeOidcAndAppKey();
    const env = makeEnv(fixture);
    branchHeads = { main: sha };
    await createProject(env);

    const { response, body } = await mintTicket(fixture, env, {
      workflow_ref: `${repository}/.github/workflows/other.yml@refs/tags/v1.0.0`,
      ref: 'refs/tags/v1.0.0',
    });

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'scope_denied', reason: 'workflow_ref_not_allowed' });
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/branches/'))).toBe(false);
  });

  it('denies a tag when the list holds no branch for that workflow', async () => {
    const fixture = await makeOidcAndAppKey();
    const env = makeEnv(fixture);
    branchHeads = { main: sha };
    await createProject(env, {
      allowedWorkflowRefs: [`${workflow}@refs/tags/v0.9.0`],
    });

    const { response, body } = await mintTicket(fixture, env, {
      workflow_ref: tagRef,
      ref: 'refs/tags/v1.0.0',
    });

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'scope_denied', reason: 'workflow_ref_not_allowed' });
  });

  it('accepts a tag that is listed as is, without a branch lookup', async () => {
    const fixture = await makeOidcAndAppKey();
    const env = makeEnv(fixture);
    branchHeads = {};
    await createProject(env, { allowedWorkflowRefs: [tagRef] });

    const { response, body } = await mintTicket(fixture, env, {
      workflow_ref: tagRef,
      ref: 'refs/tags/v1.0.0',
    });

    expect(response.status).toBe(200);
    expect(body.ticket).toMatch(/^ey/);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/branches/'))).toBe(false);
  });

  it('still denies a run from a branch that is not listed', async () => {
    const fixture = await makeOidcAndAppKey();
    const env = makeEnv(fixture);
    branchHeads = { main: sha };
    await createProject(env);

    const { response, body } = await mintTicket(fixture, env, {
      workflow_ref: `${workflow}@refs/heads/develop`,
      ref: 'refs/heads/develop',
    });

    expect(response.status).toBe(403);
    expect(body).toEqual({ error: 'scope_denied', reason: 'workflow_ref_not_allowed' });
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('/branches/'))).toBe(false);
  });

  it('reads every branch listed for the workflow', async () => {
    const fixture = await makeOidcAndAppKey();
    const env = makeEnv(fixture);
    branchHeads = { main: 'c'.repeat(40), 'release/1.x': sha };
    await createProject(env, { allowedWorkflowRefs: [workflowRef, `${workflow}@refs/heads/release/1.x`] });

    const { response } = await mintTicket(fixture, env, {
      workflow_ref: tagRef,
      ref: 'refs/tags/v1.0.0',
    });

    expect(response.status).toBe(200);
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input)))
      .toContainEqual(`https://api.github.com/repos/${repository}/branches/release%2F1.x`);
  });

  it('fails closed when a branch head cannot be read', async () => {
    const fixture = await makeOidcAndAppKey();
    const env = makeEnv(fixture);
    branchHeads = { main: new Response('boom', { status: 500 }) };
    await createProject(env);

    const { response, body } = await mintTicket(fixture, env, {
      workflow_ref: tagRef,
      ref: 'refs/tags/v1.0.0',
    });

    expect(response.status).toBe(502);
    expect(body).toEqual({ error: 'provider_unavailable' });
  });

  it('denies a tag when the allowed branch is gone', async () => {
    const fixture = await makeOidcAndAppKey();
    const env = makeEnv(fixture);
    branchHeads = {};
    await createProject(env);

    const { response, body } = await mintTicket(fixture, env, {
      workflow_ref: tagRef,
      ref: 'refs/tags/v1.0.0',
    });

    expect(response.status).toBe(403);
    expect(body).toMatchObject({ error: 'scope_denied', reason: 'workflow_ref_not_allowed' });
  });
});
