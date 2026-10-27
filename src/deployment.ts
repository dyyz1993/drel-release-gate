import type { Env } from './types';
import { githubHeaders, GITHUB_API } from './github-app';

export interface ReleaseStatus {
  run_id: number;
  run_attempt?: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  head_branch: string;
  head_sha: string;
  created_at: string;
  updated_at: string;
}

export interface DeploymentTarget {
  repo: string;
  environment: string;
  installationId?: number;
  allowOwnerFallback?: boolean;
}

async function getFreshToken(env: Env, target?: DeploymentTarget): Promise<string> {
  const { createInstallationToken, createInstallationTokenForRepo } = await import('./github-app');
  const result = target
    ? await createInstallationTokenForRepo(env, target.repo, target.installationId)
    : await createInstallationToken(env);
  return result.token;
}

export async function getRunStatus(
  env: Env,
  runId: number,
  target?: DeploymentTarget
): Promise<ReleaseStatus> {
  const repo = target?.repo ?? env.REPO;
  const token = await getFreshToken(env, target);
  const res = await fetch(`${GITHUB_API}/repos/${repo}/actions/runs/${runId}`, {
    headers: githubHeaders(token),
  });
  if (!res.ok) throw new Error(`Failed to get run: ${res.status} ${await res.text()}`);
  return await res.json() as ReleaseStatus;
}

export async function getPendingDeployment(
  env: Env,
  runId: number,
  target?: DeploymentTarget,
  existingToken?: string
): Promise<{ environmentId: number; pending: Array<{ id?: number }> }> {
  const repo = target?.repo ?? env.REPO;
  const environment = target?.environment ?? env.ENVIRONMENT;
  const token = existingToken ?? await getFreshToken(env, target);
  const envRes = await fetch(
    `${GITHUB_API}/repos/${repo}/environments/${environment}`,
    { headers: githubHeaders(token) }
  );
  if (!envRes.ok) throw new Error(`Failed to get environment: ${envRes.status} ${await envRes.text()}`);
  const envData = await envRes.json() as { id: number };

  const pendingRes = await fetch(
    `${GITHUB_API}/repos/${repo}/actions/runs/${runId}/pending_deployments`,
    { headers: githubHeaders(token) }
  );
  if (!pendingRes.ok) throw new Error(`Failed to get pending deployments: ${pendingRes.status} ${await pendingRes.text()}`);
  const pending = await pendingRes.json() as Array<{ environment?: { id?: number }; id?: number }>;
  const matching = pending.filter(item =>
    item.environment?.id === envData.id || item.id === envData.id
  );
  if (matching.length === 0) {
    throw new Error(`Run ${runId} has no pending deployment for ${environment}`);
  }
  return { environmentId: envData.id, pending: matching };
}

export async function approveDeployment(
  env: Env,
  runId: number,
  state: 'approved' | 'rejected',
  comment?: string,
  target?: DeploymentTarget
): Promise<{ ok: boolean; detail: unknown; usedOwnerFallback: boolean }> {
  const repo = target?.repo ?? env.REPO;
  const environment = target?.environment ?? env.ENVIRONMENT;
  const token = await getFreshToken(env, target);

  const runRes = await fetch(
    `${GITHUB_API}/repos/${repo}/actions/runs/${runId}`,
    { headers: githubHeaders(token) }
  );
  if (!runRes.ok) throw new Error(`Failed to get run: ${runRes.status} ${await runRes.text()}`);
  const run = await runRes.json() as { status: string; conclusion: string | null };
  if (run.status !== 'waiting') {
    throw new Error(`Run ${runId} is ${run.status}, not waiting for deployment approval`);
  }

  const { environmentId: envId } = await getPendingDeployment(env, runId, {
    repo,
    environment,
    installationId: target?.installationId,
  }, token);

  let res = await fetch(
    `${GITHUB_API}/repos/${repo}/actions/runs/${runId}/pending_deployments`,
    {
      method: 'POST',
      headers: githubHeaders(token),
      body: JSON.stringify({
        environment_ids: [envId],
        state,
        comment: comment || `Deployment ${state} via drel-release-gate`,
      }),
    }
  );
  let detail = res.ok ? await res.json() : { error: await res.text(), status: res.status };

  // GitHub App installation tokens cannot act as a required human reviewer.
  // The owner-scoped token is an explicit opt-in fallback for a personal
  // release gate; it is never used when the App call succeeds.
  let usedOwnerFallback = false;
  if (
    !res.ok
    && res.status === 422
    && env.OWNER_GITHUB_TOKEN
    && target?.allowOwnerFallback !== false
  ) {
    usedOwnerFallback = true;
    res = await fetch(
      `${GITHUB_API}/repos/${repo}/actions/runs/${runId}/pending_deployments`,
      {
        method: 'POST',
        headers: githubHeaders(env.OWNER_GITHUB_TOKEN),
        body: JSON.stringify({
          environment_ids: [envId],
          state,
          comment: comment || `Deployment ${state} via drel-release-gate`,
        }),
      }
    );
    detail = res.ok ? await res.json() : { error: await res.text(), status: res.status };
  }
  return { ok: res.ok, detail, usedOwnerFallback };
}
