import type { Env } from './types';
import { isAuthorized, unauthorizedResponse } from './auth';
import { createInstallationToken } from './github-app';
import { approveDeployment, getRunStatus } from './deployment';

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'drel-release-gate' }, { headers: CORS_HEADERS });
    }

    if (!isAuthorized(request, env)) {
      return Response.json({ error: 'unauthorized' }, { status: 401, headers: CORS_HEADERS });
    }

    if (url.pathname === '/token' && request.method === 'POST') {
      try {
        const result = await createInstallationToken(env);
        return Response.json(
          {
            token: result.token,
            expires_at: result.expires_at,
            scope: 'dyyz1993/xbrowser actions:write environments:write',
            ttl_seconds: 3600,
          },
          { headers: CORS_HEADERS }
        );
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 502, headers: CORS_HEADERS });
      }
    }

    const runMatch = url.pathname.match(/^\/run\/(\d+)$/);
    if (runMatch && request.method === 'GET') {
      try {
        const status = await getRunStatus(env, parseInt(runMatch[1], 10));
        return Response.json(status, { headers: CORS_HEADERS });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 502, headers: CORS_HEADERS });
      }
    }

    const reviewMatch = url.pathname.match(/^\/review\/(\d+)$/);
    if (reviewMatch && request.method === 'POST') {
      try {
        const body = await request.json() as { state?: string; comment?: string };
        const state = body.state === 'rejected' ? 'rejected' : 'approved';
        const result = await approveDeployment(env, parseInt(reviewMatch[1], 10), state, body.comment);
        return Response.json(result, { status: result.ok ? 200 : 400, headers: CORS_HEADERS });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 502, headers: CORS_HEADERS });
      }
    }

    return Response.json({ error: 'not_found' }, { status: 404, headers: CORS_HEADERS });
  },
};
