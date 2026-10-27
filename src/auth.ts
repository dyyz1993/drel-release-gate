import type { Env } from './types';

export function isAuthorized(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7);
  return token === env.UI_SHARED_SECRET && token.length > 20;
}

export function isAdminAuthorized(request: Request, env: Env): boolean {
  const configured = env.ADMIN_SECRET;
  if (!configured || configured.length < 20) return false;
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  return auth.slice(7) === configured;
}

export function unauthorizedResponse(): Response {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}
