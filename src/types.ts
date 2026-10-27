export interface Env {
  // 公开变量
  REPO: string;
  ENVIRONMENT: string;
  OIDC_AUDIENCE?: string;
  OIDC_ISSUER?: string;
  GITHUB_OIDC_JWKS_URL?: string;
  ACTOR_ISSUER?: string;
  ACTOR_AUDIENCE?: string;

  // Secrets
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  OWNER_GITHUB_TOKEN?: string;
  UI_SHARED_SECRET: string;
  TICKET_SECRET: string;
  ADMIN_SECRET?: string;
  APPROVALS: DurableObjectNamespace;
  TENANTS: DurableObjectNamespace;
}
