import { SignJWT, jwtVerify } from 'jose';

export interface TicketClaims {
  repo: string;
  runId: number;
  environment: string;
  requestId: string;
  nonce: string;
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
  return new SignJWT({
    repo: claims.repo,
    runId: claims.runId,
    environment: claims.environment,
    requestId: claims.requestId,
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
  return {
    repo: payload.repo,
    runId: payload.runId,
    environment: payload.environment,
    requestId: payload.requestId,
    nonce: payload.jti,
  };
}
