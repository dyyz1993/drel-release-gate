# drel-release-gate

Cloudflare Worker that lets a custom UI approve or reject GitHub Actions protected-environment deployments without ever logging into GitHub.

Built on top of the GitHub **App** model: the Worker holds the App private key and mints a short-lived (1 hour) installation token per request, so there is no long-lived PAT to leak.

## Architecture

```
+-------------------+         +------------------+        +----------------+
|                   |  Bearer |                  |  JWT   |                |
|    Drel UI        +-------->+  Cloudflare      +------->+  GitHub API    |
| (your frontend)   |  UI     |  Worker          |  App   |                |
|                   | secret  | (this project)   | key    |                |
+-------------------+         +------------------+        +----------------+
        |                              |                           |
        |  POST /token                 |  generate app JWT         |
        |------------------------------+-------------------------->|
        |  -> { token, expires_at }    |                           |
        |                              |  installation token (1h)  |
        |                              |<--------------------------+
        |                              |                           |
        |  POST /review/:runId         |                           |
        |  body: { state: approved }   |  POST pending_deployments |
        |------------------------------+-------------------------->|
        |  -> { ok, detail }           |                           |
```

## GitHub App Setup (once)

1. Go to https://github.com/settings/apps/new
2. Fill in:
   - **GitHub App name**: `drel-release-gate`
   - **Homepage URL**: `https://release-gate.xbrowser.dev` (or wherever you deploy)
   - **Webhook**: uncheck **Active** (not needed)
3. Under **Permissions**, set:
   - **Actions**: Read and write
   - **Environments**: Read and write
   - **Contents**: Read-only
   - **Metadata**: Read-only
4. Under **Where can this app be installed?**: Only on this account
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
```

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
| POST   | `/token`        | Mint a fresh 1-hour installation token. Requires UI secret.     |
| GET    | `/run/:id`      | Status of an Actions run. Requires UI secret.                   |
| POST   | `/review/:id`   | Approve or reject. Body: `{ state, comment? }`. Requires UI.    |

### Who calls /token?

Your Drel UI backend (or the UI itself, if you're comfortable putting the UI secret in a logged-in browser session). The UI secret acts as your app-level authentication; the Worker then exchanges it for a fresh installation token on demand.

- If Drel UI calls the Worker directly, the UI just needs to hold `UI_SHARED_SECRET` (long random string).
- If you have a Drel backend, that backend holds `UI_SHARED_SECRET` and proxies requests, which is the recommended pattern for production.

### How token exchange works

1. UI sends `POST /token` with `Authorization: Bearer <UI_SHARED_SECRET>`.
2. Worker loads `GITHUB_APP_PRIVATE_KEY` from Secrets.
3. Worker signs a short-lived (5 min) App JWT with RS256.
4. Worker calls `GET /repos/dyyz1993/xbrowser/installation` with that JWT to get the installation ID.
5. Worker calls `POST /app/installations/:id/access_tokens` with the JWT, requesting only `actions:write`, `environments:write`, `contents:read`, `metadata:read`, scoped to the `xbrowser` repo.
6. Worker returns the resulting installation access token to the UI along with `expires_at` (≈1 hour later).

The UI can either use that token directly to call GitHub, or — more commonly — just call `/review/:runId` and let the Worker do the GitHub call. In the second pattern the UI never touches a GitHub token.

## Deployment

```bash
npm install
npm run deploy          # uses wrangler.toml
npm run tail            # watch live logs
```

To bind a custom domain, edit `wrangler.toml`:

```toml
route = { pattern = "release-gate.xbrowser.dev", custom_domain = true }
```

Then re-run `npm run deploy`.

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
- Fine-grained permissions are requested per-token at mint time; even if a token leaks, it expires in 1 hour and only has access to `xbrowser`.
- Optional hardening: add an IP allowlist, or require the UI to sign requests with HMAC.

## Testing

```bash
npm test
```

## Smoke Test After Deploy

```bash
BASE=https://release-gate.xbrowser.dev
SECRET=your-ui-shared-secret

# 1. health
curl $BASE/health

# 2. mint token
curl -X POST $BASE/token \
  -H "Authorization: Bearer $SECRET"

# 3. check a run status
curl $BASE/run/40365039033 \
  -H "Authorization: Bearer $SECRET"

# 4. approve
curl -X POST $BASE/review/40365039033 \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -d '{"state":"approved","comment":"Drel UI approved"}'
```
