export interface Env {
  // 公开变量
  REPO: string;
  ENVIRONMENT: string;

  // Secrets
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  OWNER_GITHUB_TOKEN?: string;
  UI_SHARED_SECRET: string;
  TICKET_SECRET: string;
  APPROVALS: DurableObjectNamespace;
}
