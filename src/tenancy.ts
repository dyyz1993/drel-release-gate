import type { Env } from './types';

export const TENANT_REGISTRY_NAME = 'global';
export const PROVIDER_GITHUB = 'github';

export interface TenantRecord {
  tenantId: string;
  name: string;
  status: 'active' | 'suspended';
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentPolicy {
  actorPublicKey: string;
  allowedLogins: string[];
  allowedSubjects?: string[];
  minApprovals: number;
  selfApprovalAllowed: boolean;
}

export interface ProjectRecord {
  tenantId: string;
  projectId: string;
  provider: 'github';
  repository: string;
  installationId?: number;
  allowedWorkflowRefs?: string[];
  environments: Record<string, EnvironmentPolicy>;
  policyVersion: number;
  status: 'active' | 'suspended';
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedProject extends ProjectRecord {
  environment: string;
  policy: EnvironmentPolicy;
}

export interface AuditEvent {
  eventId?: string;
  tenantId: string;
  projectId?: string;
  requestId?: string;
  eventType: string;
  actorType: 'ci' | 'human' | 'system';
  actorId?: string;
  identityProvider?: string;
  ticketJtiHash?: string;
  provider?: string;
  target?: string;
  runId?: number;
  environment?: string;
  sha?: string;
  policyVersion?: number;
  result?: string;
  details?: Record<string, unknown>;
  createdAt?: string;
}

const REPOSITORY_RE = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;
const WORKFLOW_REF_RE = /^[\w.-]+\/[\w.-]+\/\.github\/workflows\/[\w.-]+@[\w./:-]+$/;

export function isRepository(value: unknown): value is string {
  return typeof value === 'string' && REPOSITORY_RE.test(value);
}

export function isWorkflowRef(value: unknown): value is string {
  return typeof value === 'string' && WORKFLOW_REF_RE.test(value) && value.length <= 512;
}

export function isValidName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
}

export function normalizeEnvironmentPolicy(input: {
  actorPublicKey?: unknown;
  allowedLogins?: unknown;
  allowedSubjects?: unknown;
  minApprovals?: unknown;
  selfApprovalAllowed?: unknown;
}): EnvironmentPolicy {
  if (typeof input.actorPublicKey !== 'string' || input.actorPublicKey.trim().length < 32) {
    throw new Error('actorPublicKey is required');
  }
  if (!Array.isArray(input.allowedLogins) || input.allowedLogins.some(item => typeof item !== 'string')) {
    throw new Error('allowedLogins must be a string array');
  }
  const allowedLogins = [...new Set(input.allowedLogins
    .map(login => login.trim().toLowerCase())
    .filter(Boolean))];
  if (allowedLogins.length === 0 && (!Array.isArray(input.allowedSubjects) || input.allowedSubjects.length === 0)) {
    throw new Error('at least one approver is required');
  }
  const allowedSubjects = Array.isArray(input.allowedSubjects)
    ? [...new Set(input.allowedSubjects.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))]
    : [];
  const minApprovals = input.minApprovals === undefined ? 1 : Number(input.minApprovals);
  if (!Number.isSafeInteger(minApprovals) || minApprovals < 1) {
    throw new Error('minApprovals must be a positive integer');
  }
  if (minApprovals !== 1) {
    throw new Error('minApprovals > 1 is not enabled in this phase');
  }
  return {
    actorPublicKey: input.actorPublicKey.trim(),
    allowedLogins,
    allowedSubjects,
    minApprovals,
    selfApprovalAllowed: input.selfApprovalAllowed === true,
  };
}

export function normalizeProjectInput(input: {
  tenantId?: unknown;
  projectId?: unknown;
  repository?: unknown;
  installationId?: unknown;
  allowedWorkflowRefs?: unknown;
  environments?: unknown;
}): ProjectRecord {
  if (!isValidName(input.tenantId)) throw new Error('invalid tenantId');
  if (!isValidName(input.projectId)) throw new Error('invalid projectId');
  if (!isRepository(input.repository)) throw new Error('invalid repository');
  if (input.installationId !== undefined
    && (!Number.isSafeInteger(input.installationId) || Number(input.installationId) < 1)) {
    throw new Error('invalid installationId');
  }
  if (!Array.isArray(input.environments) || input.environments.length === 0) {
    throw new Error('environments are required');
  }
  const environments: Record<string, EnvironmentPolicy> = {};
  for (const raw of input.environments) {
    if (typeof raw !== 'object' || raw === null) throw new Error('invalid environment');
    const item = raw as Record<string, unknown>;
    if (typeof item.name !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(item.name)) {
      throw new Error('invalid environment name');
    }
    if (environments[item.name]) throw new Error(`duplicate environment: ${item.name}`);
    environments[item.name] = normalizeEnvironmentPolicy(item);
  }
  let allowedWorkflowRefs: string[] | undefined;
  if (input.allowedWorkflowRefs !== undefined) {
    if (
      !Array.isArray(input.allowedWorkflowRefs)
      || input.allowedWorkflowRefs.length === 0
      || input.allowedWorkflowRefs.some(item => !isWorkflowRef(item))
    ) {
      throw new Error('allowedWorkflowRefs must be a non-empty workflow-ref array');
    }
    allowedWorkflowRefs = [...new Set(input.allowedWorkflowRefs as string[])];
  }
  const now = new Date().toISOString();
  return {
    tenantId: input.tenantId,
    projectId: input.projectId,
    provider: 'github',
    repository: input.repository,
    installationId: input.installationId === undefined ? undefined : Number(input.installationId),
    allowedWorkflowRefs,
    environments,
    policyVersion: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

function registry(env: Env): DurableObjectStub {
  if (!env.TENANTS) throw new Error('TENANTS binding is not configured');
  return env.TENANTS.get(env.TENANTS.idFromName(TENANT_REGISTRY_NAME));
}

export async function resolveProject(
  env: Env,
  repository: string,
  environment: string
): Promise<ResolvedProject | null> {
  const url = new URL('https://tenant.internal/project');
  url.searchParams.set('repository', repository);
  url.searchParams.set('environment', environment);
  const response = await registry(env).fetch(url.toString());
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`tenant lookup failed: ${response.status}`);
  return await response.json() as ResolvedProject;
}

export async function recordAudit(env: Env, event: AuditEvent): Promise<string> {
  const response = await registry(env).fetch('https://tenant.internal/audit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!response.ok) throw new Error(`audit write failed: ${response.status}`);
  const body = await response.json() as { eventId?: string };
  if (!body.eventId) throw new Error('audit write returned no event id');
  return body.eventId;
}
