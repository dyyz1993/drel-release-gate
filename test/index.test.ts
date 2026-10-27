import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import worker from '../src/index';
import { generateAppJwt, normalizePrivateKey } from '../src/github-app';

const env = {
  REPO: 'dyyz1993/xbrowser',
  ENVIRONMENT: 'production',
  GITHUB_APP_ID: '123',
  GITHUB_APP_PRIVATE_KEY: 'placeholder',
  UI_SHARED_SECRET: 'test-secret-value-long-enough',
} as any;

describe('worker routing', () => {
  it('should respond to health check', async () => {
    const req = new Request('https://example.com/health');
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.service).toBe('drel-release-gate');
  });

  it('should return 401 without auth', async () => {
    const req = new Request('https://example.com/token', { method: 'POST' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
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
