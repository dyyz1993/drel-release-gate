import type { Env } from './types';
import { githubHeaders, GITHUB_API } from './github-app';

export interface ReleaseStatus {
  run_id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_branch: string;
  head_sha: string;
  created_at: string;
  updated_at: string;
}

async function getFreshToken(env: Env): Promise<string> {
  const { createInstallationToken } = await import('./github-app');
  const result = await createInstallationToken(env);
  return result.token;
}

export async function getRunStatus(env: Env, runId: number): Promise<ReleaseStatus> {
  const token = await getFreshToken(env);
  const res = await fetch(`${GITHUB_API}/repos/${env.REPO}/actions/runs/${runId}`, {
    headers: githubHeaders(token),
  });
  if (!res.ok) throw new Error(`Failed to get run: ${res.status} ${await res.text()}`);
  return await res.json() as ReleaseStatus;
}

export async function approveDeployment(
  env: Env,
  runId: number,
  state: 'approved' | 'rejected',
  comment?: string
): Promise<{ ok: boolean; detail: unknown }> {
  const token = await getFreshToken(env);

  const runRes = await fetch(
    `${GITHUB_API}/repos/${env.REPO}/actions/runs/${runId}`,
    { headers: githubHeaders(token) }
  );
  if (!runRes.ok) throw new Error(`Failed to get run: ${runRes.status} ${await runRes.text()}`);
  const run = await runRes.json() as { status: string; conclusion: string | null };
  if (run.status !== 'waiting') {
    throw new Error(`Run ${runId} is ${run.status}, not waiting for deployment approval`);
  }

  const envRes = await fetch(
    `${GITHUB_API}/repos/${env.REPO}/environments/${env.ENVIRONMENT}`,
    { headers: githubHeaders(token) }
  );
  if (!envRes.ok) throw new Error(`Failed to get environment: ${envRes.status} ${await envRes.text()}`);
  const envData = await envRes.json() as { id: number };

  const pendingRes = await fetch(
    `${GITHUB_API}/repos/${env.REPO}/actions/runs/${runId}/pending_deployments`,
    { headers: githubHeaders(token) }
  );
  if (!pendingRes.ok) throw new Error(`Failed to get pending deployments: ${pendingRes.status} ${await pendingRes.text()}`);
  const pending = await pendingRes.json() as Array<{ environment?: { id?: number }; id?: number }>;
  const pendingForEnvironment = pending.find(item =>
    item.environment?.id === envData.id || item.id === envData.id
  );
  if (!pendingForEnvironment) {
    throw new Error(`Run ${runId} has no pending deployment for ${env.ENVIRONMENT}`);
  }

  let res = await fetch(
    `${GITHUB_API}/repos/${env.REPO}/actions/runs/${runId}/pending_deployments`,
    {
      method: 'POST',
      headers: githubHeaders(token),
      body: JSON.stringify({
        environment_ids: [envData.id],
        state,
        comment: comment || `Deployment ${state} via drel-release-gate`,
      }),
    }
  );
  let detail = res.ok ? await res.json() : { error: await res.text(), status: res.status };

  // GitHub App installation tokens cannot act as a required human reviewer.
  // The owner-scoped token is an explicit opt-in fallback for a personal
  // release gate; it is never used when the App call succeeds.
  if (!res.ok && res.status === 422 && env.OWNER_GITHUB_TOKEN) {
    res = await fetch(
      `${GITHUB_API}/repos/${env.REPO}/actions/runs/${runId}/pending_deployments`,
      {
        method: 'POST',
        headers: githubHeaders(env.OWNER_GITHUB_TOKEN),
        body: JSON.stringify({
          environment_ids: [envData.id],
          state,
          comment: comment || `Deployment ${state} via drel-release-gate`,
        }),
      }
    );
    detail = res.ok ? await res.json() : { error: await res.text(), status: res.status };
  }
  return { ok: res.ok, detail };
}
