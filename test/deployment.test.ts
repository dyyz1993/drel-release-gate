import { describe, it, expect, vi, beforeEach } from 'vitest';
import { approveDeployment } from '../src/deployment';
import * as githubApp from '../src/github-app';

describe('approveDeployment', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should approve with environment id', async () => {
    vi.spyOn(githubApp, 'createInstallationToken').mockResolvedValue({
      token: 'fake-token',
      expires_at: '2030-01-01',
    });

    const env = { REPO: 'dyyz1993/xbrowser', ENVIRONMENT: 'production' } as any;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 25155589059 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 7341245189 }]), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await approveDeployment(env, 40365039033, 'approved', 'test');
    expect(result.ok).toBe(true);
    expect((result.detail as any[])[0].id).toBe(7341245189);
  });

  it('should reject with error when environment lookup fails', async () => {
    vi.spyOn(githubApp, 'createInstallationToken').mockResolvedValue({
      token: 'fake-token',
      expires_at: '2030-01-01',
    });

    const env = { REPO: 'dyyz1993/xbrowser', ENVIRONMENT: 'production' } as any;
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('not found', { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(approveDeployment(env, 123, 'approved', 'x')).rejects.toThrow('Failed to get environment');
  });
});
