import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import {
  ActorError,
  evaluateApproverPolicy,
  verifyActorAssertion,
} from '../src/actor';
import type { TicketClaims } from '../src/ticket';

async function makeActorFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const assertion = await new SignJWT({
    login: 'octocat',
    requestId: 'apr_123',
    ticketHash: 'ticket-hash',
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
    .sign(await importPKCS8(privatePem, 'EdDSA'));
  return { assertion, publicPem };
}

describe('approver actor assertions', () => {
  it('verifies a scoped Ed25519 assertion', async () => {
    const fixture = await makeActorFixture();
    const actor = await verifyActorAssertion(fixture.assertion, fixture.publicPem, {
      issuer: 'drel',
      audience: 'drel-approval',
      requestId: 'apr_123',
      ticketHash: 'ticket-hash',
      actionId: 'approve',
    });
    expect(actor).toEqual({
      provider: 'github',
      subject: 'github:123',
      login: 'octocat',
      deviceKey: 'device-1',
    });
  });

  it('rejects an assertion bound to another action', async () => {
    const fixture = await makeActorFixture();
    await expect(verifyActorAssertion(fixture.assertion, fixture.publicPem, {
      issuer: 'drel',
      audience: 'drel-approval',
      requestId: 'apr_123',
      ticketHash: 'ticket-hash',
      actionId: 'reject',
    })).rejects.toBeInstanceOf(ActorError);
  });

  it('enforces the approver allowlist and self-approval policy', () => {
    const policy = {
      actorPublicKey: 'key',
      allowedLogins: ['octocat'],
      minApprovals: 1,
      selfApprovalAllowed: false,
      providerApprovalMode: 'user' as const,
    };
    const ticket = { ciActor: 'octocat' } as TicketClaims;
    expect(evaluateApproverPolicy(policy, {
      provider: 'github', subject: 'github:1', login: 'octocat',
    }, ticket).code).toBe('policy_violation');
    expect(evaluateApproverPolicy(policy, {
      provider: 'github', subject: 'github:1', login: 'someone-else',
    }, ticket).code).toBe('not_an_approver');
    expect(evaluateApproverPolicy(policy, {
      provider: 'github', subject: 'github:1', login: 'octocat',
    }, { ciActor: 'release-bot' } as TicketClaims)).toEqual({ allowed: true });
  });
});
