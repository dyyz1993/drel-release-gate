import { describe, expect, it } from 'vitest';
import { issueTicket, verifyTicket } from '../src/ticket';

const secret = 'a'.repeat(32);
const claims = {
  repo: 'owner/repo',
  runId: 123,
  environment: 'production',
  requestId: 'review-123',
  nonce: 'unique',
};

describe('approval tickets', () => {
  it('binds the repository, run, environment and nonce', async () => {
    const token = await issueTicket(claims, secret, 60);
    expect(await verifyTicket(token, secret)).toEqual(claims);
    await expect(verifyTicket(token, 'b'.repeat(32))).rejects.toThrow();
  });

  it('binds the Drel requestId so one ticket cannot approve another request', async () => {
    const token = await issueTicket(claims, secret, 60);
    const verified = await verifyTicket(token, secret);
    expect(verified.requestId).toBe('review-123');
  });

  it('rejects invalid scope and excessive lifetime', async () => {
    await expect(issueTicket({ ...claims, repo: '../repo' }, secret, 60)).rejects.toThrow();
    await expect(issueTicket(claims, secret, 901)).rejects.toThrow();
  });

  it('binds tenant, project, SHA and workflow scope for multi-tenant tickets', async () => {
    const scoped = {
      ...claims,
      tenantId: 'ten_1',
      projectId: 'prj_1',
      provider: 'github' as const,
      runAttempt: 2,
      sha: 'c'.repeat(40),
      workflowRef: 'owner/repo/.github/workflows/release.yml@refs/heads/main',
      ciActor: 'release-bot',
      policyVersion: 3,
      ticketVersion: 2,
    };
    const token = await issueTicket(scoped, secret, 60);
    expect(await verifyTicket(token, secret)).toMatchObject(scoped);
    await expect(issueTicket({ ...scoped, tenantId: undefined }, secret, 60)).rejects.toThrow();
  });
});
