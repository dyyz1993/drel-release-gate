# Deployment Walkthrough

Step-by-step commands from zero to running Worker.

## 1. Install

```bash
npm ci
```

## 2. Cloudflare login

```bash
npx wrangler login
```

Follow the browser flow.

## 3. Create GitHub App

Follow `README.md` § GitHub App Setup. At the end you should have:

- App ID (a number like `1234567`)
- A downloaded `.pem` private key file

## 4. Upload Secrets

```bash
# App ID
npx wrangler secret put GITHUB_APP_ID
# paste the App ID, press Enter

# Private key: convert PEM to single line
KEY=$(awk 'NF { sub(/\r/, ""); printf "%s\\n", $0 }' /path/to/drel-release-gate.*.private-key.pem)
echo "$KEY" | npx wrangler secret put GITHUB_APP_PRIVATE_KEY

# UI secret
openssl rand -hex 32
# copy the output
npx wrangler secret put UI_SHARED_SECRET
# paste the generated hex

# Approval ticket signing secret (at least 32 bytes)
openssl rand -hex 32
npx wrangler secret put TICKET_SECRET

# Multi-tenant control-plane secret (separate from CI and Drel secrets)
openssl rand -hex 32
npx wrangler secret put ADMIN_SECRET
```

## 5. Deploy

```bash
npm run deploy
```

Wrangler prints the deployed URL. For a custom domain:

1. Add `route = { pattern = "approve.xbrowser.dev", custom_domain = true }` to `wrangler.toml`.
2. `npm run deploy`.

## 6. Smoke Test

See `README.md` § Smoke Test After Deploy.

## 7. Hook into Drel UI

The release workflow should call:

- `POST /ticket` with `{repo,environment,runId,requestId}`
- then embed `{url: <base>/api/review, ticket}` in the Drel approval

Send `Authorization: Bearer <UI_SHARED_SECRET>` when minting the ticket.

## 8. Rotate Secrets

- Private key: generate new in GitHub App settings, then re-run `wrangler secret put GITHUB_APP_PRIVATE_KEY`.
- UI secret: `openssl rand -hex 32` then `wrangler secret put UI_SHARED_SECRET`; update UI config.

## 9. Release Through CI

Do not deploy a release tag by hand. Configure these GitHub Actions secrets
first:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Then update the package version and push an annotated `vX.Y.Z` tag. The
Release workflow reruns CI and deploys only when the CI job is green. See
`CONTRIBUTING.md` for the complete process.

## 10. Multi-tenant onboarding

After `ADMIN_SECRET` is configured, use `POST /v1/admin/tenants` and
`POST /v1/admin/projects` from `README.md` to register a repository,
environment policy, approver allowlist, and actor public key. New CI callers
should use `POST /v1/ci/tickets` with a GitHub OIDC token instead of the
legacy shared-secret `/ticket` route.

## 11. Teardown

If you want to remove everything:

```bash
npx wrangler delete
```

Then delete the GitHub App from https://github.com/settings/apps.
