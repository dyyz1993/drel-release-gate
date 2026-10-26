export interface Env {
  // 公开变量
  REPO: string;
  ENVIRONMENT: string;

  // Secrets
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  UI_SHARED_SECRET: string;
}
