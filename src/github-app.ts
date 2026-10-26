import type { Env } from './types';
import { SignJWT, importPKCS8 } from 'jose';

const GITHUB_API = 'https://api.github.com';

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'drel-release-gate/1.0',
  };
}

// GitHub App JWT 有效期最多 10 分钟，这里用 5 分钟
async function generateAppJwt(env: Env): Promise<string> {
  const pem = env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');
  const key = await importPKCS8(pem, 'RS256');

  return new SignJWT({ iss: env.GITHUB_APP_ID })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 30)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(key);
}

async function getInstallationId(env: Env): Promise<number> {
  const jwt = await generateAppJwt(env);
  const res = await fetch(`${GITHUB_API}/repos/${env.REPO}/installation`, {
    headers: githubHeaders(jwt),
  });
  if (!res.ok) {
    throw new Error(`Failed to get installation: ${res.status} ${await res.text()}`);
  }
  const data = await res.json() as { id: number };
  return data.id;
}

// Installation Access Token 有效期 1 小时
async function createInstallationToken(env: Env): Promise<{ token: string; expires_at: string }> {
  const installationId = await getInstallationId(env);
  const jwt = await generateAppJwt(env);

  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: githubHeaders(jwt),
    body: JSON.stringify({
      repositories: [env.REPO.split('/')[1]],
      permissions: {
        actions: 'write',
        environments: 'write',
        contents: 'read',
        metadata: 'read',
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create installation token: ${res.status} ${await res.text()}`);
  }
  const data = await res.json() as { token: string; expires_at: string };
  return data;
}

export { githubHeaders, generateAppJwt, getInstallationId, createInstallationToken, GITHUB_API };
