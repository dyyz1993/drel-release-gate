# drel-release-gate

Cloudflare Worker that lets Drel approve or reject GitHub Actions
protected-environment deployments without logging into GitHub.

Built on top of the GitHub **App** model: the Worker holds the App private key
and mints a short-lived installation token only when the ticket is redeemed.
The normal path has no long-lived PAT to leak.

The repository keeps the original single-tenant compatibility routes and now
has a multi-tenant v1 control plane. The v1 path uses GitHub OIDC for CI
identity, tenant/project-scoped tickets, Ed25519 approver assertions, and
append-only Durable Object audit events. The legacy `/ticket` and `/api/review`
routes remain available while existing callers move to v1.

## Architecture

```
+-------------------+         +------------------+        +----------------+
| Release workflow  | Bearer  |  Cloudflare      |  JWT   |  GitHub API    |
| + Drel UI         +-------->+  Worker          +------->+                |
|                   | UI secret| (this project)   | App key|                |
+-------------------+         +------------------+        +----------------+
        |                              |                           |
        |  POST /ticket                |  run-scoped approval JWT  |
        |------------------------------+-------------------------->|
        |  -> { ticket, expiresIn }    |                           |
        |                              |                           |
        |  POST /api/review            |                           |
        |  body: { ticket, requestId,  |  installation token (1h)  |
        |          actionId, ... }     |  POST pending_deployments |
        |------------------------------+-------------------------->|
        |  -> { requestId, state, ... }|                           |
```

## GitHub App Setup (once)

1. Go to https://github.com/settings/apps/new
2. Fill in:
   - **GitHub App name**: `drel-release-gate`
   - **Homepage URL**: `https://approve.xbrowser.dev` (or wherever you deploy)
   - **Webhook**: uncheck **Active** (not needed)
3. Under **Permissions**, set:
   - **Actions**: Read and write
   - **Deployments**: Read and write
   - **Metadata**: Read-only
4. Under **Where can this app be installed?**: Any account (or restrict it to
   the organizations you operate).
5. Click **Create GitHub App**
6. Note the **App ID** from the General page.
7. Scroll to **Private key** and click **Generate a private key**. Download the `.pem` file.
8. Go to **Install App** and install it on the `dyyz1993` account. Select **Only select repositories** → `xbrowser`.

## Secrets

```bash
wrangler secret put GITHUB_APP_ID
# paste App ID

wrangler secret put GITHUB_APP_PRIVATE_KEY
# paste PEM contents (with \n escapes) — see below

wrangler secret put UI_SHARED_SECRET
# generate with: openssl rand -hex 32

wrangler secret put TICKET_SECRET
# generate with: openssl rand -hex 32

wrangler secret put ADMIN_SECRET
# generate a separate value with: openssl rand -hex 32
```

For a compatibility-only single-tenant deployment, `OWNER_GITHUB_TOKEN` may be
set as an optional Worker secret. It is used only when GitHub rejects the App
installation token with `422`; prefer a human OAuth/identity flow for any
multi-tenant deployment. Do not make a long-lived owner token the normal path.

To prepare the private key for `wrangler secret put`, convert newlines to `\n`:

```bash
# macOS / Linux
awk 'NF { sub(/\r/, ""); printf "%s\\n", $0 }' drel-release-gate.*.private-key.pem
```

Copy the single-line output, then run `wrangler secret put GITHUB_APP_PRIVATE_KEY` and paste.

## Routes

| Method | Path            | Description                                                     |
|--------|-----------------|-----------------------------------------------------------------|
| GET    | `/health`       | Public ping, no auth                                            |
| POST   | `/ticket`       | Mint a 15-minute, run-scoped approval ticket. Requires UI secret. |
| POST   | `/api/review`   | Submit the Drel approval body with that ticket.                 |
| GET    | `/run/:id`      | Status of an Actions run. Requires UI secret.                   |
| POST   | `/review/:id`   | Approve or reject. Body: `{ state, comment? }`. Requires UI.    |
| POST   | `/v1/ci/tickets` | Mint a project/environment ticket using a GitHub Actions OIDC token. |
| POST   | `/v1/approvals/:requestId/decision` | Submit a scoped decision with a signed actor assertion. |
| POST   | `/v1/admin/tenants` | Create a tenant record. Requires `ADMIN_SECRET`. |
| POST   | `/v1/admin/projects` | Create or update a project policy and approver ACL. |

### Who calls /ticket?

The xbrowser release workflow waits until the run is blocked on the
`production` environment, calls `/ticket`, then pushes one Drel approval whose
`approval.submit` points at `/api/review`. The ticket binds repository, run,
environment, requestId, expiry, and a one-use nonce.

- Only the release workflow holds `UI_SHARED_SECRET`; the Drel app receives
  the opaque, expiring ticket in the message and never sees the shared secret.
- The Drel app does not call GitHub or mint installation tokens.

### How approval exchange works

1. The release workflow posts repo/run/environment/requestId to `/ticket`.
2. The Worker signs an HS256 ticket valid for 15 minutes.
3. Drel renders native actions and POSTs the ticket body to
   `approval.submit.url` (`/api/review`).
4. The Worker verifies ticket scope, atomically claims the nonce in a Durable
   Object, checks the run is `waiting` with a pending `production` deployment,
   then calls GitHub.
5. A failed GitHub call releases the claim so an approved retry can proceed.

Drel never receives a GitHub token. The legacy authenticated
`/review/:runId` route remains for manual operator use during rollout, but the
product flow uses only `approval.submit` plus `/api/review`.

### Multi-tenant v1

The v1 flow separates the CI request from the human approver:

1. `POST /v1/ci/tickets` accepts a GitHub Actions OIDC bearer token. The
   Worker verifies issuer, audience, repository, run, attempt, SHA, and
   workflow ref, then cross-checks the run and pending deployment through the
   GitHub App installation token.
2. `POST /v1/approvals/:requestId/decision` accepts a scoped ticket and an
   Ed25519 actor assertion. The assertion is bound to the request, ticket
   hash, and action. The project policy then checks the approver login or
   subject allowlist and self-approval rule.

The ticket binds `tenantId`, `projectId`, provider, repository, environment,
run, run attempt, SHA, workflow ref, request ID, policy version, and a one-use
nonce. A ticket for one repository/environment/run cannot be used for another.

The v1 GitHub App path does not use `OWNER_GITHUB_TOKEN`. If a GitHub
environment requires a human provider reviewer, a future user-OAuth provider
adapter must supply that user authorization; an App installation token is
never presented as a human approval.

Create a tenant and project policy with the admin routes:

```bash
ADMIN_SECRET=... # do not commit this value
curl -fsS -X POST https://approve.xbrowser.dev/v1/admin/tenants \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"ten_xbrowser","name":"xbrowser"}'

curl -fsS -X POST https://approve.xbrowser.dev/v1/admin/projects \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{
    "tenantId":"ten_xbrowser",
    "projectId":"prj_xbrowser",
    "repository":"dyyz1993/xbrowser",
    "installationId":123456,
    "allowedWorkflowRefs":["dyyz1993/xbrowser/.github/workflows/release.yml@refs/heads/master"],
    "environments":[{
      "name":"production",
      "actorPublicKey":"-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
      "allowedLogins":["your-github-login"],
      "minApprovals":1,
      "selfApprovalAllowed":false
    }]
  }'
```

The CI job must grant `id-token: write` and post:

```bash
curl -fsS -X POST https://approve.xbrowser.dev/v1/ci/tickets \
  -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"environment":"production"}'
```

The returned ticket and `submitUrl` go into the Drel approval message. The
actor assertion is signed by the Ed25519 private key whose public key is
configured in the project environment policy. The assertion must include
`requestId`, `ticketHash`, `actionId`, `login`, `sub`, issuer, audience, and
an unexpired `jti`.

## Deployment

```bash
npm ci
npm run typecheck
npm test
npm run deploy:dry-run
npm run deploy          # uses wrangler.toml
npm run tail            # watch live logs
```

To bind a custom domain, edit `wrangler.toml`:

```toml
route = { pattern = "approve.xbrowser.dev", custom_domain = true }
```

Then re-run `npm run deploy`.

Production releases must not be deployed from an unverified local tree. Push a
version tag after the CI gate is green; the Release workflow reruns the same
checks, verifies the tag against `package.json`, and deploys with Wrangler:

```bash
git tag -a v1.1.1 -m "drel-release-gate v1.1.1"
git push origin master
git push origin v1.1.1
```

The repository must have `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` configured as GitHub Actions secrets. The release job
has `needs: verify`, so a red CI run cannot deploy the Worker.

## Local Dev

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars with real values
npm run dev
```

## Security Notes

- **Never commit** `.dev.vars` or any PEM file. Both are gitignored.
- The `GITHUB_APP_PRIVATE_KEY` is the most sensitive secret; it can mint tokens for the xbrowser repo. Store it only in Cloudflare Secrets.
- `UI_SHARED_SECRET` is what your UI uses to talk to this Worker. Treat it like a password.
- `ADMIN_SECRET` is separate from the CI and Drel secrets. It protects tenant
  and project policy onboarding; rotate it independently.
- Fine-grained permissions are requested per installation/repository at mint
  time; even if a token leaks, it expires in 1 hour and is scoped to the
  selected repository.
- A ticket identifies a CI request, not a human approver. Do not treat a
  copied ticket as user authentication in a multi-tenant deployment.
- Optional hardening: add an IP allowlist, or require the UI to sign requests
  with HMAC.

## Testing

```bash
npm ci
npm run typecheck
npm test
npm run deploy:dry-run
```

## Smoke Test After Deploy

```bash
BASE=https://approve.xbrowser.dev
SECRET=your-ui-shared-secret

# 1. health
curl $BASE/health

# 2. mint a run-scoped ticket for a pending run
curl -X POST $BASE/ticket \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"repo":"dyyz1993/xbrowser","environment":"production","runId":123,"requestId":"review-123"}'

# 3. check a run status
curl $BASE/run/40365039033 \
  -H "Authorization: Bearer $SECRET"

# 4. submit exactly as Drel does
curl -X POST $BASE/api/review \
  -H "Content-Type: application/json" \
  -d '{"ticket":"<ticket>","requestId":"review-123","actionId":"approve","expectedRevision":1,"values":{}}'
```
