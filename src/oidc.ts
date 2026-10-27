import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';
import type { Env } from './types';
import { isRepository, isWorkflowRef } from './tenancy';

const DEFAULT_ISSUER = 'https://token.actions.githubusercontent.com';
const DEFAULT_AUDIENCE = 'https://approve.xbrowser.dev';
const DEFAULT_JWKS_URL = 'https://token.actions.githubusercontent.com/.well-known/jwks';

export interface GithubOidcClaims {
  issuer: string;
  audience: string;
  subject?: string;
  repository: string;
  runId: number;
  runAttempt: number;
  sha: string;
  workflowRef?: string;
  ref?: string;
  actor?: string;
  eventName?: string;
}

export class OidcError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OidcError';
  }
}

function numericClaim(value: unknown, name: string): number {
  const result = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new OidcError('invalid_oidc', `${name} must be a positive integer`);
  }
  return result;
}

export async function verifyGithubOidc(
  token: string,
  env: Env,
  fetchImpl: typeof fetch = fetch
): Promise<GithubOidcClaims> {
  const issuer = env.OIDC_ISSUER || DEFAULT_ISSUER;
  const audience = env.OIDC_AUDIENCE || DEFAULT_AUDIENCE;
  const jwksUrl = env.GITHUB_OIDC_JWKS_URL || DEFAULT_JWKS_URL;

  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new OidcError('invalid_oidc', 'invalid compact JWS');
  }
  if (header.alg !== 'RS256') throw new OidcError('invalid_oidc', 'OIDC token must use RS256');

  let keys: JWK[];
  try {
    const response = await fetchImpl(jwksUrl, {
      headers: { 'User-Agent': 'drel-release-gate/1.0' },
    });
    if (!response.ok) throw new Error(`JWKS HTTP ${response.status}`);
    const body = await response.json() as { keys?: JWK[] };
    keys = Array.isArray(body.keys) ? body.keys : [];
  } catch {
    throw new OidcError('oidc_jwks_unavailable', 'GitHub OIDC keys are unavailable');
  }
  const jwk = header.kid
    ? keys.find(item => item.kid === header.kid)
    : keys.length === 1
      ? keys[0]
      : undefined;
  if (!jwk) throw new OidcError('invalid_oidc', 'OIDC signing key not found');

  let payload: Record<string, unknown>;
  try {
    const key = await importJWK(jwk, 'RS256');
    const verified = await jwtVerify(token, key, {
      algorithms: ['RS256'],
      issuer,
      audience,
      clockTolerance: 30,
      requiredClaims: ['exp', 'iat', 'repository', 'run_id', 'run_attempt', 'sha'],
    });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    throw new OidcError('invalid_oidc', 'GitHub OIDC token failed verification');
  }

  if (!isRepository(payload.repository)) throw new OidcError('invalid_oidc', 'invalid repository claim');
  if (typeof payload.sha !== 'string' || !/^[0-9a-f]{40,64}$/i.test(payload.sha)) {
    throw new OidcError('invalid_oidc', 'invalid sha claim');
  }
  const workflowRef = payload.workflow_ref;
  if (workflowRef !== undefined && !isWorkflowRef(workflowRef)) {
    throw new OidcError('invalid_oidc', 'invalid workflow_ref claim');
  }
  return {
    issuer,
    audience,
    subject: typeof payload.sub === 'string' ? payload.sub : undefined,
    repository: payload.repository,
    runId: numericClaim(payload.run_id, 'run_id'),
    runAttempt: numericClaim(payload.run_attempt, 'run_attempt'),
    sha: payload.sha,
    workflowRef,
    ref: typeof payload.ref === 'string' ? payload.ref : undefined,
    actor: typeof payload.actor === 'string' ? payload.actor : undefined,
    eventName: typeof payload.event_name === 'string' ? payload.event_name : undefined,
  };
}
