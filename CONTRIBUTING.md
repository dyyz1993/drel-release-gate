# Contributing

## Local checks

Use Node.js 22 and run the same checks as CI:

```bash
npm ci
npm run typecheck
npm test
npm run deploy:dry-run
```

`deploy:dry-run` builds the Worker locally and must not change Cloudflare
state. Keep `.dev.vars`, PEM files, and tokens out of commits.

## Pull requests

- Keep changes focused and include tests for behavior changes.
- Do not commit generated `dist/`, `.wrangler/`, `.learnings/`, or secret files.
- Wait for the `Verify` CI check to pass before merging to `master`.

## Releases

Releases are tag-driven and are intentionally separate from ordinary pushes:

1. Update `package.json` and `package-lock.json` to the same version.
2. Merge the change to `master` with green CI.
3. Create and push an annotated tag in the form `vX.Y.Z`.
4. The `Release` workflow reruns CI, checks that the tag matches
   `package.json`, deploys the Worker to Cloudflare, and creates a GitHub
   Release.

The repository must have these GitHub Actions secrets configured before a
release tag is pushed:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

The token should be scoped to the minimum Cloudflare account and Worker
resources needed for deployment. Never paste secret values into a commit,
issue, PR, or workflow log.
