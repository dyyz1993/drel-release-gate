import { describe, it, expect, vi } from 'vitest';
import worker from '../src/index';

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
