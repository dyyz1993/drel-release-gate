import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import { OidcError, verifyGithubOidc } from '../src/oidc';

const issuer = 'https://token.actions.githubusercontent.com';
const audience = 'https://approve.example.com';

async function makeOidcFixture(overrides: Record<string, unknown> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const jwk = publicKey.export({ format: 'jwk' });
  const jwt = await new SignJWT({
    repository: 'owner/repo',
    run_id: '12345',
    run_attempt: '2',
    sha: 'a'.repeat(40),
    workflow_ref: 'owner/repo/.github/workflows/release.yml@refs/heads/main',
    ref: 'refs/heads/main',
    actor: 'release-bot',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(await importPKCS8(privatePem, 'RS256'));
  return {
    jwt,
    jwks: { keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] },
  };
}

function fetchJwks(jwks: unknown): typeof fetch {
  return (async () => Response.json(jwks)) as typeof fetch;
}

describe('GitHub OIDC verification', () => {
  it('normalizes repository and numeric run claims', async () => {
    const fixture = await makeOidcFixture();
    const claims = await verifyGithubOidc(fixture.jwt, {
      OIDC_ISSUER: issuer,
      OIDC_AUDIENCE: audience,
      GITHUB_OIDC_JWKS_URL: 'https://example.com/jwks',
    } as any, fetchJwks(fixture.jwks));
    expect(claims).toMatchObject({
      repository: 'owner/repo',
      runId: 12345,
      runAttempt: 2,
      sha: 'a'.repeat(40),
      actor: 'release-bot',
    });
  });

  it('rejects a token with the wrong audience', async () => {
    const fixture = await makeOidcFixture();
    await expect(verifyGithubOidc(fixture.jwt, {
      OIDC_ISSUER: issuer,
      OIDC_AUDIENCE: 'https://other.example.com',
      GITHUB_OIDC_JWKS_URL: 'https://example.com/jwks',
    } as any, fetchJwks(fixture.jwks))).rejects.toMatchObject<OidcError>({
      code: 'invalid_oidc',
    });
  });

  it('rejects an invalid repository claim', async () => {
    const fixture = await makeOidcFixture({ repository: '../repo' });
    await expect(verifyGithubOidc(fixture.jwt, {
      OIDC_ISSUER: issuer,
      OIDC_AUDIENCE: audience,
      GITHUB_OIDC_JWKS_URL: 'https://example.com/jwks',
    } as any, fetchJwks(fixture.jwks))).rejects.toMatchObject<OidcError>({
      code: 'invalid_oidc',
    });
  });
});
