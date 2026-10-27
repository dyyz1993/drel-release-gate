import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../src/index';
import { generateAppJwt, inspectGithubAppConfig, normalizePrivateKey } from '../src/github-app';

const env = {
  REPO: 'dyyz1993/xbrowser',
  ENVIRONMENT: 'production',
  GITHUB_APP_ID: 'placeholder',
  GITHUB_APP_PRIVATE_KEY: 'placeholder',
  UI_SHARED_SECRET: 'test-secret-value-long-enough',
  TICKET_SECRET: 'a'.repeat(32),
  APPROVALS: {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        return url.pathname === '/claim'
          ? Response.json({ claimed: true })
          : Response.json({ released: true });
      },
    }),
  },
} as any;

describe('worker routing', () => {
  it('should respond to health check', async () => {
    const req = new Request('https://example.com/health');
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.service).toBe('drel-release-gate');
  });

  it('reports placeholder GitHub App credentials without exposing them', async () => {
    const req = new Request('https://example.com/github-app/health', {
      headers: { Authorization: 'Bearer test-secret-value-long-enough' },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      ok: false,
      appId: 'placeholder',
      privateKey: 'placeholder',
      keyType: null,
    });
  });

  it('should return 401 without auth', async () => {
    const req = new Request('https://example.com/token', { method: 'POST' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it('rejects a third-party review without a ticket before touching GitHub', async () => {
    const req = new Request('https://example.com/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: 'review-1',
        actionId: 'approve',
        expectedRevision: 1,
        values: {},
      }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
  });

  it('returns 503 rather than a false ticket rejection when GitHub signing is unconfigured', async () => {
    const ticketResponse = await worker.fetch(new Request('https://example.com/ticket', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-secret-value-long-enough',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        repo: 'dyyz1993/xbrowser',
        environment: 'production',
        runId: 123,
        requestId: 'review-unconfigured',
      }),
    }), env);
    const ticket = (await ticketResponse.json() as any).ticket;
    const review = await worker.fetch(new Request('https://example.com/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticket,
        requestId: 'review-unconfigured',
        actionId: 'approve',
        expectedRevision: 1,
        values: {},
      }),
    }), env);
    expect(review.status).toBe(503);
  });

  it('should return 404 for unknown path', async () => {
    const req = new Request('https://example.com/whatever', {
      headers: { Authorization: 'Bearer test-secret-value-long-enough' },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(404);
  });
});

describe('GitHub App private-key handling', () => {
  it('reports placeholder secrets without returning their contents', async () => {
    const report = await inspectGithubAppConfig({
      GITHUB_APP_ID: 'placeholder',
      GITHUB_APP_PRIVATE_KEY: 'placeholder',
    } as any);
    expect(report).toEqual({
      appId: 'placeholder',
      privateKey: 'placeholder',
      keyType: null,
    });
  });

  it('reports a valid key without returning its contents', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const report = await inspectGithubAppConfig({
      GITHUB_APP_ID: '123456',
      GITHUB_APP_PRIVATE_KEY: pem,
    } as any);
    expect(report.appId).toBe('valid');
    expect(report.privateKey).toBe('valid');
    expect(report.keyType).toBe('pkcs8-rsa');
    expect(JSON.stringify(report)).not.toContain('BEGIN PRIVATE KEY');
  });

  it('accepts JSON-escaped PKCS#8 PEM from a Cloudflare secret', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const escaped = `"${pem.replace(/\n/g, '\\n')}"`;
    expect(normalizePrivateKey(escaped)).toBe(pem.trim());
  });

  it('converts the PKCS#1 PEM exported by some GitHub tools to PKCS#8', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const normalized = normalizePrivateKey(pem);
    expect(normalized).toContain('BEGIN PRIVATE KEY');
    expect(normalized).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('accepts a body-only PKCS#8 key from a trimmed secret field', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const normalized = normalizePrivateKey(body);
    expect(normalized).toContain('BEGIN PRIVATE KEY');
    expect(normalized.replace(/-----[^-]+-----|\s+/g, '')).toBe(body);
  });

  it('accepts a body-only PKCS#1 RSA key from a trimmed secret field', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const normalized = normalizePrivateKey(body);
    expect(normalized).toContain('BEGIN PRIVATE KEY');
    expect(normalized).not.toContain('BEGIN RSA PRIVATE KEY');
  });

  it('signs a GitHub App JWT after normalizing the stored key', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const token = await generateAppJwt({
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, '\\n'),
    } as any);
    expect(token.split('.')).toHaveLength(3);
    expect(JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))))
      .toMatchObject({ alg: 'RS256', typ: 'JWT' });
  });
});
