import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import worker from '../src/index';
import { TenantStore } from '../src/tenant-store';
import { hashTicket, issueTicket } from '../src/ticket';

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

async function makeOidcAndAppKey() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicJwk = publicKey.export({ format: 'jwk' });
  const jwt = await new SignJWT({
    repository,
    run_id: '12345',
    run_attempt: '2',
    sha,
    workflow_ref: workflowRef,
    ref: 'refs/heads/main',
    actor: 'release-bot',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'oidc-key' })
    .setIssuer(oidcIssuer)
    .setAudience(oidcAudience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(await importPKCS8(privatePem, 'RS256'));
  const appKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const actorKey = generateKeyPairSync('ed25519');
  return {
    jwt,
    oidcPrivateKey: privatePem,
    jwks: { keys: [{ ...publicJwk, kid: 'oidc-key', alg: 'RS256', use: 'sig' }] },
    appPrivateKey: appKey.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    actorPublicKey: actorKey.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    actorPrivateKey: actorKey.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  };
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
    ACTOR_ISSUER: 'drel',
    ACTOR_AUDIENCE: 'drel-approval',
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

function projectBody(actorPublicKey: string) {
  return {
    tenantId: 'ten_1',
    projectId: 'prj_1',
    repository,
    installationId: 9001,
    allowedWorkflowRefs: [workflowRef],
    environments: [{
      name: 'production',
      actorPublicKey,
      allowedLogins: ['octocat'],
      minApprovals: 1,
      selfApprovalAllowed: false,
    }],
  };
}

function makeGithubFetch(jwks: unknown) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/jwks') return Response.json(jwks);
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
      body: JSON.stringify(projectBody(fixture.actorPublicKey)),
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
      body: JSON.stringify(projectBody(fixture.actorPublicKey)),
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

  it('accepts a scoped ticket only with an allowed actor assertion', async () => {
    const fixture = await makeOidcAndAppKey();
    const env = makeEnv(fixture);
    const admin = await worker.fetch(new Request('https://example.com/v1/admin/projects', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ADMIN_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(projectBody(fixture.actorPublicKey)),
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
    const assertion = await new SignJWT({
      login: 'octocat',
      requestId: 'apr_123',
      ticketHash: await hashTicket(ticket),
      actionId: 'approve',
      deviceKey: 'device-1',
    })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject('github:123')
      .setIssuer('drel')
      .setAudience('drel-approval')
      .setJti('assertion-nonce')
      .setIssuedAt()
      .setExpirationTime('2m')
      .sign(await importPKCS8(fixture.actorPrivateKey, 'EdDSA'));

    vi.stubGlobal('fetch', makeGithubFetch(fixture.jwks));
    const response = await worker.fetch(new Request(
      'https://example.com/v1/approvals/apr_123/decision',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket,
          actionId: 'approve',
          expectedRevision: 1,
          values: {},
          actorAssertion: assertion,
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
});
