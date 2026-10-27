import { importSPKI, jwtVerify } from 'jose';
import type { EnvironmentPolicy } from './tenancy';
import type { TicketClaims } from './ticket';

export interface VerifiedActor {
  provider: 'github';
  subject: string;
  login: string;
  deviceKey?: string;
}

export interface ActorExpectation {
  issuer: string;
  audience: string;
  requestId: string;
  ticketHash: string;
  actionId: string;
}

export class ActorError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ActorError';
  }
}

export async function verifyActorAssertion(
  assertion: string,
  publicKey: string,
  expected: ActorExpectation
): Promise<VerifiedActor> {
  let key: CryptoKey;
  try {
    key = await importSPKI(publicKey, 'EdDSA');
  } catch {
    throw new ActorError('identity_not_linked', 'actor public key is invalid');
  }
  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(assertion, key, {
      algorithms: ['EdDSA'],
      issuer: expected.issuer,
      audience: expected.audience,
      clockTolerance: 15,
      requiredClaims: ['exp', 'iat', 'sub', 'jti'],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    throw new ActorError('invalid_actor_assertion', 'actor assertion failed verification');
  }

  if (
    typeof payload.login !== 'string'
    || !/^[A-Za-z0-9-]{1,39}$/.test(payload.login)
    || payload.requestId !== expected.requestId
    || payload.ticketHash !== expected.ticketHash
    || payload.actionId !== expected.actionId
  ) {
    throw new ActorError('invalid_actor_assertion', 'actor assertion scope mismatch');
  }
  return {
    provider: 'github',
    subject: String(payload.sub),
    login: payload.login,
    deviceKey: typeof payload.deviceKey === 'string' ? payload.deviceKey : undefined,
  };
}

export function evaluateApproverPolicy(
  policy: EnvironmentPolicy | undefined,
  actor: VerifiedActor | undefined,
  ticket: TicketClaims
): { allowed: boolean; code?: string } {
  if (!policy || !policy.actorPublicKey) return { allowed: false, code: 'identity_not_linked' };
  if (!actor) return { allowed: false, code: 'identity_not_linked' };
  if (policy.minApprovals !== 1) return { allowed: false, code: 'policy_violation' };

  const login = actor.login.toLowerCase();
  const allowedLogin = policy.allowedLogins.some(item => item.toLowerCase() === login);
  const allowedSubject = policy.allowedSubjects?.includes(actor.subject) ?? false;
  if (!allowedLogin && !allowedSubject) return { allowed: false, code: 'not_an_approver' };

  if (
    !policy.selfApprovalAllowed
    && ticket.ciActor
    && ticket.ciActor.toLowerCase() === login
  ) {
    return { allowed: false, code: 'policy_violation' };
  }
  return { allowed: true };
}
