import { SignJWT, jwtVerify } from 'jose';

export interface TicketClaims {
  repo: string;
  runId: number;
  environment: string;
  requestId: string;
  nonce: string;
  tenantId?: string;
  projectId?: string;
  provider?: 'github';
  runAttempt?: number;
  sha?: string;
  workflowRef?: string;
  ref?: string;
  ciActor?: string;
  policyVersion?: number;
  ticketVersion?: number;
}

function key(secret: string): Uint8Array {
  if (new TextEncoder().encode(secret).length < 32) throw new Error('ticket key too short');
  return new TextEncoder().encode(secret);
}

export async function issueTicket(claims: TicketClaims, secret: string, ttlSeconds: number): Promise<string> {
  if (!Number.isSafeInteger(claims.runId) || claims.runId < 1 || !/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(claims.repo)
    || !claims.environment || !claims.requestId || !claims.nonce
    || !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) {
    throw new Error('invalid ticket claims');
  }
  const scoped = claims.tenantId !== undefined
    || claims.projectId !== undefined
    || claims.runAttempt !== undefined
    || claims.sha !== undefined
    || claims.workflowRef !== undefined;
  if (scoped && (
    !claims.tenantId
    || !claims.projectId
    || !Number.isSafeInteger(claims.runAttempt)
    || !claims.sha
    || !claims.workflowRef
  )) {
    throw new Error('incomplete multi-tenant ticket claims');
  }
  return new SignJWT({
    repo: claims.repo,
    runId: claims.runId,
    environment: claims.environment,
    requestId: claims.requestId,
    ...(scoped ? {
      v: claims.ticketVersion ?? 2,
      tenantId: claims.tenantId,
      projectId: claims.projectId,
      provider: claims.provider ?? 'github',
      runAttempt: claims.runAttempt,
      sha: claims.sha,
      workflowRef: claims.workflowRef,
      ref: claims.ref,
      ciActor: claims.ciActor,
      policyVersion: claims.policyVersion,
    } : {}),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('drel-release-gate')
    .setAudience('deployment-review')
    .setJti(claims.nonce)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key(secret));
}

export async function verifyTicket(token: string, secret: string): Promise<TicketClaims> {
  const { payload } = await jwtVerify(token, key(secret), {
    algorithms: ['HS256'], issuer: 'drel-release-gate', audience: 'deployment-review',
    requiredClaims: ['exp', 'iat', 'jti'],
  });
  if (typeof payload.repo !== 'string' || !/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(payload.repo)
    || typeof payload.runId !== 'number' || !Number.isSafeInteger(payload.runId) || payload.runId < 1
    || typeof payload.environment !== 'string' || !payload.environment
    || typeof payload.requestId !== 'string' || !payload.requestId || !payload.jti) {
    throw new Error('invalid ticket claims');
  }
  const scoped = payload.v === 2;
  if (scoped && (
    typeof payload.tenantId !== 'string'
    || typeof payload.projectId !== 'string'
    || typeof payload.runAttempt !== 'number'
    || !Number.isSafeInteger(payload.runAttempt)
    || typeof payload.sha !== 'string'
    || !/^[0-9a-f]{40,64}$/i.test(payload.sha)
    || typeof payload.workflowRef !== 'string'
    || !payload.workflowRef
  )) {
    throw new Error('invalid multi-tenant ticket claims');
  }
  const normalized: TicketClaims = {
    repo: payload.repo,
    runId: payload.runId,
    environment: payload.environment,
    requestId: payload.requestId,
    nonce: payload.jti,
  };
  if (scoped) {
    normalized.tenantId = payload.tenantId as string;
    normalized.projectId = payload.projectId as string;
    normalized.provider = payload.provider === 'github' ? 'github' : undefined;
    normalized.runAttempt = payload.runAttempt as number;
    normalized.sha = payload.sha as string;
    normalized.workflowRef = payload.workflowRef as string;
    normalized.ref = typeof payload.ref === 'string' ? payload.ref : undefined;
    normalized.ciActor = typeof payload.ciActor === 'string' ? payload.ciActor : undefined;
    normalized.policyVersion = typeof payload.policyVersion === 'number' ? payload.policyVersion : undefined;
    normalized.ticketVersion = 2;
  }
  return normalized;
}

export async function hashTicket(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
