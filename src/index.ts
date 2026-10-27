import type { Env } from './types';
import { isAuthorized } from './auth';
import { approveDeployment, getRunStatus } from './deployment';
import { inspectGithubAppConfig } from './github-app';
import { handleAdmin, handleCiTicket, handleDecision } from './multitenant';
import { issueTicket, verifyTicket } from './ticket';
export { ApprovalTicket } from './approval-ticket';
export { TenantStore } from './tenant-store';

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
      return Response.json({
        ok: true,
        service: 'drel-release-gate',
        features: ['legacy-approval', 'multi-tenant', 'github-oidc'],
      }, { headers: CORS_HEADERS });
    }

    if (url.pathname === '/v1/ci/tickets' && request.method === 'POST') {
      return await handleCiTicket(request, env);
    }

    if (url.pathname.startsWith('/v1/admin/') && request.method === 'POST') {
      return await handleAdmin(request, env, url.pathname);
    }

    const decisionMatch = url.pathname.match(/^\/v1\/approvals\/([^/]+)\/decision$/);
    if (decisionMatch && request.method === 'POST') {
      try {
        return await handleDecision(request, env, decodeURIComponent(decisionMatch[1]));
      } catch {
        return Response.json(
          { error: 'internal_error' },
          { status: 500, headers: CORS_HEADERS }
        );
      }
    }

    if (url.pathname === '/api/review' && request.method === 'POST') {
      try {
        const body = await request.json() as {
          ticket?: string;
          requestId?: string;
          actionId?: string;
          expectedRevision?: number;
          values?: Record<string, string>;
        };
        if (
          !body.ticket
          || typeof body.requestId !== 'string'
          || typeof body.actionId !== 'string'
          || !Number.isSafeInteger(body.expectedRevision)
          || (body.expectedRevision ?? 0) < 1
          || typeof body.values !== 'object'
          || body.values === null
          || Array.isArray(body.values)
        ) {
          return Response.json({ error: 'invalid_request' }, { status: 400 });
        }
        const claims = await verifyTicket(body.ticket, env.TICKET_SECRET);
        if (
          claims.repo !== env.REPO
          || claims.environment !== env.ENVIRONMENT
          || claims.requestId !== body.requestId
        ) {
          return Response.json({ error: 'scope_denied' }, { status: 403 });
        }
        if (claims.ticketVersion === 2) {
          return Response.json({ error: 'use_multi_tenant_route' }, { status: 403 });
        }
        const state = body.actionId === 'approve'
          ? 'approved'
          : body.actionId === 'reject'
            ? 'rejected'
            : null;
        if (!state) return Response.json({ error: 'unknown_action' }, { status: 400 });
        const expectedRevision = body.expectedRevision as number;
        const stub = env.APPROVALS.get(env.APPROVALS.idFromName(claims.nonce));
        const claim = await stub.fetch('https://ticket.internal/claim', { method: 'POST' });
        if (!claim.ok) return Response.json({ error: 'ticket_already_used' }, { status: 409 });
        try {
          const result = await approveDeployment(
            env,
            claims.runId,
            state,
            body.values.comment || body.values.reason
          );
          if (!result.ok) {
            await stub.fetch('https://ticket.internal/release', { method: 'POST' });
            return Response.json(
              { error: 'github_rejected', detail: result.detail },
              { status: 502 }
            );
          }
          return Response.json({
            requestId: claims.requestId,
            state,
            revision: expectedRevision + 1,
            actionId: body.actionId,
          });
        } catch (error) {
          await stub.fetch('https://ticket.internal/release', { method: 'POST' });
          throw error;
        }
      } catch (error) {
        // Authentication and configuration failures are not "bad requests",
        // and a bad ticket must not look like a successful claim.
        const typed = error as { code?: string; name?: string };
        const ticketError = ['JOSEError', 'JWSInvalid', 'JWSSignatureVerificationFailed',
          'JWTExpired'].includes(typed.name || '')
          || String(error).includes('Invalid Compact JWS')
          || typed.code === 'ERR_JOSE_ALG_NOT_ALLOWED';
        return Response.json(
          { error: 'invalid_or_failed_ticket', message: String(error) },
          { status: ticketError ? 400 : 503 }
        );
      }
    }

    if (!isAuthorized(request, env)) {
      return Response.json({ error: 'unauthorized' }, { status: 401, headers: CORS_HEADERS });
    }

    if (url.pathname === '/github-app/health' && request.method === 'GET') {
      const config = await inspectGithubAppConfig(env);
      const ok = config.appId === 'valid' && config.privateKey === 'valid';
      return Response.json({ ok, ...config }, {
        status: ok ? 200 : 503,
        headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname === '/ticket' && request.method === 'POST') {
      try {
        const body = await request.json() as {
          repo?: string;
          environment?: string;
          runId?: number;
          requestId?: string;
        };
        if (
          body.repo !== env.REPO
          || body.environment !== env.ENVIRONMENT
          || !Number.isSafeInteger(body.runId)
          || (body.runId ?? 0) < 1
          || typeof body.requestId !== 'string'
          || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.requestId)
        ) {
          return Response.json({ error: 'scope_denied' }, { status: 400 });
        }
        const ticket = await issueTicket({
          repo: body.repo,
          runId: body.runId!,
          environment: body.environment,
          requestId: body.requestId,
          nonce: crypto.randomUUID(),
        }, env.TICKET_SECRET, 900);
        return Response.json({ ticket, expiresIn: 900 }, { headers: { 'Cache-Control': 'no-store' } });
      } catch {
        return Response.json({ error: 'ticket_issue_failed' }, { status: 400 });
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
        if (body.state !== 'approved' && body.state !== 'rejected') {
          return Response.json({ error: 'invalid_state' }, { status: 400, headers: CORS_HEADERS });
        }
        const state = body.state;
        const result = await approveDeployment(env, parseInt(reviewMatch[1], 10), state, body.comment);
        return Response.json(result, { status: result.ok ? 200 : 400, headers: CORS_HEADERS });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 502, headers: CORS_HEADERS });
      }
    }

    return Response.json({ error: 'not_found' }, { status: 404, headers: CORS_HEADERS });
  },
};
