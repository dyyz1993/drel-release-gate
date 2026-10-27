import { describe, expect, it } from 'vitest';
import { TenantStore } from '../src/tenant-store';
import type { ProjectRecord } from '../src/tenancy';

function makeState() {
  const values = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
    transaction: async (callback: (txn: {
      get: (key: string) => Promise<unknown>;
      put: (key: string, value: unknown) => Promise<void>;
    }) => Promise<void>) => {
      await callback({
        get: async (key: string) => values.get(key),
        put: async (key: string, value: unknown) => {
          values.set(key, value);
        },
      });
    },
  };
  return { state: { storage } as any, values };
}

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    tenantId: 'ten_1',
    projectId: 'prj_1',
    provider: 'github',
    repository: 'owner/repo',
    environments: {
      production: {
        actorPublicKey: '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
        allowedLogins: ['octocat'],
        allowedSubjects: [],
        minApprovals: 1,
        selfApprovalAllowed: false,
      },
    },
    policyVersion: 1,
    status: 'active',
    createdAt: '2026-10-27T00:00:00Z',
    updatedAt: '2026-10-27T00:00:00Z',
    ...overrides,
  };
}

describe('TenantStore', () => {
  it('resolves a repository/environment to one tenant-scoped project', async () => {
    const { state } = makeState();
    const store = new TenantStore(state);
    const write = await store.fetch(new Request('https://tenant.internal/project', {
      method: 'POST',
      body: JSON.stringify(project()),
    }));
    expect(write.status).toBe(200);

    const read = await store.fetch(new Request(
      'https://tenant.internal/project?repository=owner/repo&environment=production'
    ));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      tenantId: 'ten_1',
      projectId: 'prj_1',
      environment: 'production',
      policy: { allowedLogins: ['octocat'] },
    });
  });

  it('returns 404 for a cross-environment lookup', async () => {
    const { state } = makeState();
    const store = new TenantStore(state);
    await store.fetch(new Request('https://tenant.internal/project', {
      method: 'POST',
      body: JSON.stringify(project()),
    }));
    const read = await store.fetch(new Request(
      'https://tenant.internal/project?repository=owner/repo&environment=staging'
    ));
    expect(read.status).toBe(404);
  });

  it('appends redacted audit events and returns an event id', async () => {
    const { state, values } = makeState();
    const store = new TenantStore(state);
    const response = await store.fetch(new Request('https://tenant.internal/audit', {
      method: 'POST',
      body: JSON.stringify({
        tenantId: 'ten_1',
        eventType: 'approval.decided',
        actorType: 'human',
        result: 'approved',
      }),
    }));
    const body = await response.json() as { eventId: string };
    expect(body.eventId).toMatch(/^evt_/);
    expect([...values.keys()].some(key => key.startsWith('audit:ten_1:'))).toBe(true);
  });
});
