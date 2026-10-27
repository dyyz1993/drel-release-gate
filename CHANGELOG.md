# Changelog

## 1.1.0 - 2026-10-28

- Add a tenant/project control plane backed by a Durable Object.
- Add tenant-scoped tickets with repository, environment, run, attempt, SHA,
  workflow ref, request ID, policy version, and one-use nonce claims.
- Add GitHub Actions OIDC verification against GitHub JWKS.
- Add Ed25519 actor assertions and approver allowlist/self-approval checks.
- Add append-only audit events and fail-closed decision handling.
- Keep legacy `/ticket` and `/api/review` compatibility routes.

## 1.0.1 - 2026-10-28

- Enforce typecheck, tests, Worker dry-run, and secret scanning in CI.
- Gate tag releases on the reusable CI workflow.
- Deploy the Worker to Cloudflare from successful version tags.
- Add open-source governance and secret-handling documentation.
