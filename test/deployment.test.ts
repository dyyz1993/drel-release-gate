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
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'waiting', conclusion: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 25155589059 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: 7341245189,
        environment: { id: 25155589059 },
      }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 7341245189 }]), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await approveDeployment(env, 40365039033, 'approved', 'test');
    expect(result.ok).toBe(true);
    expect((result.detail as any[])[0].id).toBe(7341245189);
  });

  it('treats an empty successful approval response as success', async () => {
    vi.spyOn(githubApp, 'createInstallationToken').mockResolvedValue({
      token: 'fake-token',
      expires_at: '2030-01-01',
    });

    const env = { REPO: 'dyyz1993/xbrowser', ENVIRONMENT: 'production' } as any;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'waiting', conclusion: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 25155589059 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: 7341245189,
        environment: { id: 25155589059 },
      }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await approveDeployment(env, 40365039033, 'approved', 'empty response');
    expect(result.ok).toBe(true);
    expect(result.detail).toBeNull();
  });

  it('should reject with error when environment lookup fails', async () => {
    vi.spyOn(githubApp, 'createInstallationToken').mockResolvedValue({
      token: 'fake-token',
      expires_at: '2030-01-01',
    });

    const env = { REPO: 'dyyz1993/xbrowser', ENVIRONMENT: 'production' } as any;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'waiting', conclusion: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response('not found', { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(approveDeployment(env, 123, 'approved', 'x')).rejects.toThrow('Failed to get environment');
  });

  it('falls back to the owner token only when GitHub rejects the App token', async () => {
    vi.spyOn(githubApp, 'createInstallationToken').mockResolvedValue({
      token: 'app-token',
      expires_at: '2030-01-01',
    });

    const env = {
      REPO: 'dyyz1993/xbrowser',
      ENVIRONMENT: 'production',
      OWNER_GITHUB_TOKEN: 'owner-token',
    } as any;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'waiting', conclusion: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 25155589059 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        id: 7341245189,
        environment: { id: 25155589059 },
      }]), { status: 200 }))
      .mockResolvedValueOnce(new Response('App token cannot approve', { status: 422 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 7341245189 }]), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await approveDeployment(env, 40365039033, 'approved', 'owner fallback');
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect((fetchMock.mock.calls[4][1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer owner-token',
    });
  });
});
