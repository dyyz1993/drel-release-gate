import { isAdminAuthorized } from './auth';
import {
  approveDeployment,
  getPendingDeployment,
  getRunStatus,
  type DeploymentTarget,
} from './deployment';
import { hashTicket, issueTicket, verifyTicket } from './ticket';
import {
  isValidName,
  normalizeProjectInput,
  recordAudit,
  resolveProject,
} from './tenancy';
import { OidcError, verifyGithubOidc } from './oidc';
import type { Env } from './types';

const JSON_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: JSON_HEADERS });
}

function error(code: string, status: number, details?: Record<string, unknown>): Response {
  return json({ error: code, ...(details ?? {}) }, status);
}

function requestIdFromBody(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error('invalid requestId');
  }
  return value;
}

function targetFor(
  repository: string,
  environment: string,
  installationId?: number,
  allowOwnerFallback = false
): DeploymentTarget {
  return {
    repo: repository,
    environment,
    installationId,
    allowOwnerFallback,
  };
}

export async function handleCiTicket(request: Request, env: Env): Promise<Response> {
  const authorization = request.headers.get('Authorization') || '';
  if (!authorization.startsWith('Bearer ')) {
    return error('unauthenticated', 401);
  }

  let oidc;
  try {
    oidc = await verifyGithubOidc(authorization.slice(7), env);
  } catch (err) {
    if (err instanceof OidcError) {
      return error(err.code, err.code === 'oidc_jwks_unavailable' ? 503 : 401);
    }
    return error('invalid_oidc', 401);
  }

  let body: { environment?: unknown; requestId?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return error('invalid_request', 400);
  }
  if (typeof body.environment !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(body.environment)) {
    return error('invalid_request', 400);
  }

  let project;
  try {
    project = await resolveProject(env, oidc.repository, body.environment);
  } catch {
    return error('tenant_store_unavailable', 503);
  }
  if (!project) return error('project_not_found', 404);
  if (project.status !== 'active') return error('project_suspended', 403);
  if (
    project.allowedWorkflowRefs?.length
    && (!oidc.workflowRef || !project.allowedWorkflowRefs.includes(oidc.workflowRef))
  ) {
    return error('scope_denied', 403, { reason: 'workflow_ref_not_allowed' });
  }
  if (!oidc.workflowRef) {
    return error('scope_denied', 403, { reason: 'workflow_ref_missing' });
  }

  const target = targetFor(project.repository, body.environment, project.installationId);
  let run;
  try {
    run = await getRunStatus(env, oidc.runId, target);
  } catch {
    return error('provider_unavailable', 502);
  }
  if (run.status !== 'waiting') {
    return error('run_not_waiting', 409, { status: run.status });
  }
  if (!run.head_sha || run.head_sha !== oidc.sha) {
    return error('scope_denied', 403, { reason: 'sha_mismatch' });
  }
  if (run.run_attempt !== oidc.runAttempt) {
    return error('scope_denied', 403, { reason: 'run_attempt_mismatch' });
  }

  try {
    await getPendingDeployment(env, oidc.runId, target);
  } catch {
    return error('no_pending_deployment', 409);
  }

  let requestId: string;
  try {
    requestId = body.requestId === undefined
      ? `apr_${crypto.randomUUID()}`
      : requestIdFromBody(body.requestId);
  } catch {
    return error('invalid_request', 400);
  }

  let ticket: string;
  try {
    ticket = await issueTicket({
      repo: project.repository,
      runId: oidc.runId,
      environment: body.environment,
      requestId,
      nonce: crypto.randomUUID(),
      tenantId: project.tenantId,
      projectId: project.projectId,
      provider: 'github',
      runAttempt: oidc.runAttempt,
      sha: oidc.sha,
      workflowRef: oidc.workflowRef,
      ref: oidc.ref,
      ciActor: oidc.actor,
      policyVersion: project.policyVersion,
      ticketVersion: 2,
    }, env.TICKET_SECRET, 900);
  } catch {
    return error('ticket_issue_failed', 503);
  }

  try {
    await recordAudit(env, {
      tenantId: project.tenantId,
      projectId: project.projectId,
      requestId,
      eventType: 'ticket.issued',
      actorType: 'ci',
      actorId: oidc.actor,
      identityProvider: 'github-oidc',
      ticketJtiHash: await hashTicket(ticket),
      provider: 'github',
      target: project.repository,
      runId: oidc.runId,
      environment: body.environment,
      sha: oidc.sha,
      policyVersion: project.policyVersion,
      result: 'issued',
    });
  } catch {
    return error('audit_failed', 503);
  }

  return json({
    ticket,
    requestId,
    expiresIn: 900,
    tenantId: project.tenantId,
    projectId: project.projectId,
    policyVersion: project.policyVersion,
    submitUrl: new URL(`/v1/approvals/${encodeURIComponent(requestId)}/decision`, request.url).toString(),
  });
}

export async function handleDecision(
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> {
  let body: {
    ticket?: unknown;
    requestId?: unknown;
    actionId?: unknown;
    expectedRevision?: unknown;
    values?: unknown;
  };
  try {
    body = await request.json() as typeof body;
  } catch {
    return error('invalid_request', 400);
  }
  if (
    typeof body.ticket !== 'string'
    || typeof body.requestId !== 'string'
    || body.requestId !== requestId
    || typeof body.actionId !== 'string'
    || !Number.isSafeInteger(body.expectedRevision)
    || (body.expectedRevision as number) < 1
    || typeof body.values !== 'object'
    || body.values === null
    || Array.isArray(body.values)
  ) {
    return error('invalid_request', 400);
  }
  const state = body.actionId === 'approve'
    ? 'approved'
    : body.actionId === 'reject'
      ? 'rejected'
      : null;
  if (!state) return error('unknown_action', 400);

  let claims;
  try {
    claims = await verifyTicket(body.ticket, env.TICKET_SECRET);
  } catch {
    return error('ticket_expired', 400);
  }
  if (
    claims.ticketVersion !== 2
    || !claims.tenantId
    || !claims.projectId
    || claims.provider !== 'github'
    || claims.requestId !== requestId
  ) {
    return error('scope_denied', 403);
  }
  let project;
  try {
    project = await resolveProject(env, claims.repo, claims.environment);
  } catch {
    return error('tenant_store_unavailable', 503);
  }
  if (
    !project
    || project.tenantId !== claims.tenantId
    || project.projectId !== claims.projectId
    || project.policyVersion !== claims.policyVersion
    || project.status !== 'active'
  ) {
    return error('scope_denied', 403);
  }

  const ticketHash = await hashTicket(body.ticket);

  const stub = env.APPROVALS.get(env.APPROVALS.idFromName(claims.nonce));
  const claim = await stub.fetch('https://ticket.internal/claim', { method: 'POST' });
  if (!claim.ok) return error('ticket_already_used', 409);

  let result: Awaited<ReturnType<typeof approveDeployment>>;
  try {
    await recordAudit(env, {
      tenantId: project.tenantId,
      projectId: project.projectId,
      requestId,
      eventType: 'approval.decision.received',
      actorType: 'bearer',
      actorId: 'one-time-ticket',
      identityProvider: 'ticket',
      ticketJtiHash: ticketHash,
      provider: 'github',
      target: project.repository,
      runId: claims.runId,
      environment: claims.environment,
      sha: claims.sha,
      policyVersion: project.policyVersion,
      result: body.actionId,
    });
    result = await approveDeployment(
      env,
      claims.runId,
      state,
      typeof (body.values as Record<string, unknown>).comment === 'string'
        ? String((body.values as Record<string, unknown>).comment)
        : undefined,
      targetFor(
        project.repository,
        project.environment,
        project.installationId,
        project.policy.providerApprovalMode === 'service_account'
      )
    );
  } catch {
    await stub.fetch('https://ticket.internal/release', { method: 'POST' });
    return error('provider_unavailable', 502);
  }
  if (!result.ok) {
    await stub.fetch('https://ticket.internal/release', { method: 'POST' });
    return error('provider_rejected', 502);
  }

  // Once the provider may have accepted the decision, do not release the
  // ticket if audit persistence fails. A retry must not create a second
  // provider decision; the claimed ticket is the safe terminal guard.
  let auditEventId: string;
  try {
    auditEventId = await recordAudit(env, {
      tenantId: project.tenantId,
      projectId: project.projectId,
      requestId,
      eventType: 'approval.decided',
      actorType: 'bearer',
      actorId: 'one-time-ticket',
      identityProvider: 'ticket',
      ticketJtiHash: ticketHash,
      provider: 'github',
      target: project.repository,
      runId: claims.runId,
      environment: claims.environment,
      sha: claims.sha,
      policyVersion: project.policyVersion,
      result: state,
      details: {
        providerActor: result.usedOwnerFallback ? 'service_account' : 'user',
      },
    });
  } catch {
    return error('audit_failed', 503);
  }
  return json({
    requestId,
    state,
    revision: (body.expectedRevision as number) + 1,
    actionId: body.actionId,
    provider: 'github',
    decidedAt: new Date().toISOString(),
    auditEventId,
  });
}

export async function handleAdmin(request: Request, env: Env, pathname: string): Promise<Response> {
  if (!env.ADMIN_SECRET || env.ADMIN_SECRET.length < 20) {
    return error('admin_not_configured', 503);
  }
  if (!isAdminAuthorized(request, env)) return error('unauthenticated', 401);

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return error('invalid_request', 400);
  }

  if (pathname === '/v1/admin/tenants') {
    if (!isValidName(body.tenantId) || typeof body.name !== 'string' || !body.name.trim()) {
      return error('invalid_request', 400);
    }
    const now = new Date().toISOString();
    const response = await env.TENANTS.get(env.TENANTS.idFromName('global')).fetch(
      'https://tenant.internal/tenant',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: body.tenantId,
          name: body.name.trim(),
          status: 'active',
          createdAt: now,
          updatedAt: now,
        }),
      }
    );
    return json(await response.json(), response.status);
  }

  if (pathname === '/v1/admin/projects') {
    let project;
    try {
      project = normalizeProjectInput(body);
    } catch (err) {
      return error('invalid_request', 400, { message: String(err) });
    }
    const response = await env.TENANTS.get(env.TENANTS.idFromName('global')).fetch(
      'https://tenant.internal/project',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(project),
      }
    );
    return json(await response.json(), response.status);
  }

  return error('not_found', 404);
}
