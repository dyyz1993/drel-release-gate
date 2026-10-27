import type { AuditEvent, ProjectRecord, ResolvedProject, TenantRecord } from './tenancy';

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export class TenantStore {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/tenant' && request.method === 'POST') {
      const tenant = await request.json() as TenantRecord;
      if (!tenant.tenantId || !tenant.name) return json({ error: 'invalid_tenant' }, 400);
      await this.state.storage.put(`tenant:${tenant.tenantId}`, tenant);
      return json({ tenantId: tenant.tenantId });
    }

    if (url.pathname === '/project' && request.method === 'POST') {
      const input = await request.json() as ProjectRecord;
      if (!input.tenantId || !input.projectId || !input.repository || !input.environments) {
        return json({ error: 'invalid_project' }, 400);
      }
      const key = `project:${input.tenantId}:${input.projectId}`;
      const existing = await this.state.storage.get<ProjectRecord>(key);
      for (const environment of Object.keys(input.environments)) {
        const indexKey = `repo:${input.repository.toLowerCase()}:${environment}`;
        const index = await this.state.storage.get<{ tenantId: string; projectId: string }>(indexKey);
        if (index && (index.tenantId !== input.tenantId || index.projectId !== input.projectId)) {
          return json({ error: 'project_scope_conflict' }, 409);
        }
      }
      const project: ProjectRecord = {
        ...input,
        policyVersion: existing ? existing.policyVersion + 1 : input.policyVersion,
        createdAt: existing?.createdAt ?? input.createdAt,
        updatedAt: new Date().toISOString(),
      };
      await this.state.storage.transaction(async txn => {
        await txn.put(key, project);
        for (const environment of Object.keys(project.environments)) {
          await txn.put(
            `repo:${project.repository.toLowerCase()}:${environment}`,
            { tenantId: project.tenantId, projectId: project.projectId }
          );
        }
      });
      return json({ tenantId: project.tenantId, projectId: project.projectId, policyVersion: project.policyVersion });
    }

    if (url.pathname === '/project' && request.method === 'GET') {
      const repository = url.searchParams.get('repository');
      const environment = url.searchParams.get('environment');
      if (!repository || !environment) return json({ error: 'invalid_lookup' }, 400);
      const index = await this.state.storage.get<{ tenantId: string; projectId: string }>(
        `repo:${repository.toLowerCase()}:${environment}`
      );
      if (!index) return json({ error: 'project_not_found' }, 404);
      const project = await this.state.storage.get<ProjectRecord>(
        `project:${index.tenantId}:${index.projectId}`
      );
      if (!project) return json({ error: 'project_not_found' }, 404);
      const policy = project.environments[environment];
      if (!policy) return json({ error: 'environment_not_found' }, 404);
      return json({ ...project, environment, policy } satisfies ResolvedProject);
    }

    if (url.pathname === '/audit' && request.method === 'POST') {
      const input = await request.json() as AuditEvent;
      const eventId = `evt_${crypto.randomUUID()}`;
      const event: AuditEvent = {
        ...input,
        eventId,
        createdAt: input.createdAt ?? new Date().toISOString(),
      };
      await this.state.storage.put(
        `audit:${input.tenantId}:${Date.now()}:${eventId}`,
        event
      );
      return json({ eventId });
    }

    return json({ error: 'not_found' }, 404);
  }
}
