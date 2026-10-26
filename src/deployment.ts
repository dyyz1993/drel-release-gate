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

  const envRes = await fetch(
    `${GITHUB_API}/repos/${env.REPO}/environments/${env.ENVIRONMENT}`,
    { headers: githubHeaders(token) }
  );
  if (!envRes.ok) throw new Error(`Failed to get environment: ${envRes.status} ${await envRes.text()}`);
  const envData = await envRes.json() as { id: number };

  const res = await fetch(
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
  const detail = res.ok ? await res.json() : { error: await res.text(), status: res.status };
  return { ok: res.ok, detail };
}
