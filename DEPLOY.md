# Deployment Walkthrough

Step-by-step commands from zero to running Worker.

## 1. Install

```bash
cd /Users/xuyingzhou/Project/study-node-ts/drel-release-gate
npm install
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
```

## 5. Deploy

```bash
npm run deploy
```

Wrangler prints the deployed URL. For a custom domain:

1. Add `route = { pattern = "release-gate.xbrowser.dev", custom_domain = true }` to `wrangler.toml`.
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

## 9. Teardown

If you want to remove everything:

```bash
npx wrangler delete
```

Then delete the GitHub App from https://github.com/settings/apps.
