import type { Env } from './types';
import { SignJWT, importPKCS8 } from 'jose';

const GITHUB_API = 'https://api.github.com';
const PKCS8_HEADER = '-----BEGIN ' + 'PRIVATE KEY-----';
const PKCS8_FOOTER = '-----END ' + 'PRIVATE KEY-----';

function wrapPkcs8(body: string): string {
  return `${PKCS8_HEADER}\n${body}\n${PKCS8_FOOTER}`;
}

function pemBytes(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  if (!base64) throw new Error('GitHub App private key is empty or malformed');
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) {
    bytes.unshift(value % 256);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag: number, value: Uint8Array): Uint8Array {
  return Uint8Array.of(tag, ...derLength(value.length), ...value);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function isRsaPkcs1(derBytes: Uint8Array): boolean {
  if (derBytes.length < 2 || derBytes[0] !== 0x30) return false;
  const length = derBytes[1];
  if (length < 0x80) {
    return derBytes[2] === 0x02 && derBytes[3] === 0x01;
  }
  const offset = 2 + (length & 0x7f);
  return derBytes[offset] === 0x02 && derBytes[offset + 1] === 0x01;
}

function pkcs1ToPkcs8(derBytes: Uint8Array): Uint8Array {
  const rsaAlgorithm = Uint8Array.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  ]);
  return der(0x30, concat(Uint8Array.of(0x02, 0x01, 0x00), rsaAlgorithm, der(0x04, derBytes)));
}

function normalizePrivateKey(value: string): string {
  let pem = value.trim();
  if (pem.startsWith('"')) {
    try {
      const parsed = JSON.parse(pem);
      if (typeof parsed === 'string') pem = parsed;
    } catch {
      pem = pem.replace(/^"(.*)"$/s, '$1');
    }
  }
  // Dashboard/wrangler paths have produced both `\n` and `\\n`; base64 PEM
  // never contains backslashes, so collapsing repeated escapes is safe.
  pem = pem.replace(/\\+n/g, '\n').trim();

  if (!pem.includes('-----BEGIN ')) {
    // Some secret UIs strip PEM armor or store the decoded DER as base64.
    const decoded = atob(pem.replace(/\s+/g, ''));
    if (decoded.includes('-----BEGIN ')) {
      pem = decoded;
    } else if (decoded.charCodeAt(0) === 0x30) {
      const body = btoa(decoded).match(/.{1,64}/g)?.join('\n') ?? '';
      pem = wrapPkcs8(body);
    } else {
      const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
      const converted = isRsaPkcs1(bytes) ? pkcs1ToPkcs8(bytes) : bytes;
      const body = btoa(String.fromCharCode(...converted)).match(/.{1,64}/g)?.join('\n') ?? '';
      pem = wrapPkcs8(body);
    }
  }

  if (pem.includes('BEGIN PRIVATE KEY')) return pem;
  if (!pem.includes('BEGIN RSA PRIVATE KEY')) {
    throw new Error('GitHub App private key must contain PEM private-key material');
  }
  const derBytes = pemBytes(pem);
  if (!isRsaPkcs1(derBytes)) throw new Error('GitHub App private key is malformed');
  const body = btoa(String.fromCharCode(...pkcs1ToPkcs8(derBytes)))
    .match(/.{1,64}/g)?.join('\n') ?? '';
  return wrapPkcs8(body);
}

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
  const pem = normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY);
  const key = await importPKCS8(pem, 'RS256');

  return new SignJWT({ iss: env.GITHUB_APP_ID })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 30)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(key);
}

async function inspectGithubAppConfig(env: Env): Promise<{
  appId: 'missing' | 'placeholder' | 'valid';
  privateKey: 'missing' | 'placeholder' | 'invalid' | 'valid';
  keyType: 'pkcs8-rsa' | null;
}> {
  const rawAppId = String(env.GITHUB_APP_ID ?? '').trim();
  const appId = rawAppId === ''
    ? 'missing'
    : /^\d+$/.test(rawAppId)
      ? 'valid'
      : 'placeholder';

  const rawKey = String(env.GITHUB_APP_PRIVATE_KEY ?? '').trim();
  let privateKey: 'missing' | 'placeholder' | 'invalid' | 'valid' = 'missing';
  if (rawKey !== '') {
    if (rawKey.toLowerCase().includes('placeholder')) {
      privateKey = 'placeholder';
    } else {
      try {
        await importPKCS8(normalizePrivateKey(rawKey), 'RS256');
        privateKey = 'valid';
        return { appId, privateKey, keyType: 'pkcs8-rsa' };
      } catch {
        privateKey = 'invalid';
      }
    }
  }
  return { appId, privateKey, keyType: null };
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
        deployments: 'write',
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

export {
  githubHeaders,
  generateAppJwt,
  getInstallationId,
  createInstallationToken,
  inspectGithubAppConfig,
  normalizePrivateKey,
  GITHUB_API,
};
