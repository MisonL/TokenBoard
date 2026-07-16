# Upstream Production Recovery - 2026-07-16

## Incident

After PR #19 was merged, authenticated requests to `/dashboard/details` and `/settings/devices`
returned HTTP 500. Public pages and `/api/v1/health` remained available. Existing collectors also
stopped recording successful uploads.

## Root Cause

The Worker code was updated without applying the matching D1 migrations.

- Both authenticated pages call `listUserDevices`, which queries `device_installations` and
  `upload_tokens.installation_id`.
- Upload token authentication also selects `upload_tokens.installation_id` before parsing the
  collector request body.
- Migration `0022_device_installations.sql` creates and backfills those objects. Migrations `0023`
  and `0024` complete the device identity contract.
- The last recorded GitHub deployment workflow failed because required production configuration was
  absent, and that automatic workflow was later intentionally removed in favor of manual deployment.

This is not an old collector payload incompatibility. Existing Claude Code and Codex snapshots remain
valid. The failure occurs in the server database query before the request payload is parsed.

## Immediate Recovery From Current Master

An upstream maintainer with Cloudflare access can restore service before merging PR #20:

1. Pull the latest upstream `master` into a clean checkout.
2. Authenticate Wrangler against the Cloudflare account that owns the production Worker and D1 database.
3. From `apps/web`, record a D1 Time Travel restore point:

   ```bash
   timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   pnpm exec wrangler d1 time-travel info DB \
     --timestamp "$timestamp" \
     --json \
     --config wrangler.jsonc
   ```

4. From the repository root, run the guarded deploy helper:

   ```bash
   TOKENBOARD_WRANGLER_CONFIG=wrangler.jsonc pnpm --filter @tokenboard/web run deploy
   ```

5. Confirm Wrangler reports no migration or deployment error.
6. Confirm there are no pending migrations:

   ```bash
   cd apps/web
   pnpm exec wrangler d1 migrations list DB --remote --config wrangler.jsonc
   ```

This path applies every pending migration before publishing the Worker. Do not run a standalone
`wrangler deploy` first.

## Recovery After Merging PR #20

PR #20 does not configure GitHub Actions or Cloudflare Workers Builds automatic deployment. An upstream
maintainer with Cloudflare access must run the guarded deploy helper locally.

Before deploying, confirm the production Worker already contains these Worker secrets:

- `BETTER_AUTH_SECRET`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `WEBHOOK_ENCRYPTION_KEY`

### Run The Guarded Deploy Helper

1. Create a private production Wrangler config from `wrangler.production.example.jsonc`.
2. Set `TOKENBOARD_WRANGLER_CONFIG` to that config and authenticate Wrangler with the production account.
3. Record a D1 Time Travel restore point.
4. Run the guarded deploy helper:

   ```bash
   TOKENBOARD_WRANGLER_CONFIG=wrangler.production.jsonc pnpm --filter @tokenboard/web run deploy
   ```

The helper:

1. installs dependencies;
2. runs workspace and skill-script tests;
3. runs type checking;
4. generates and validates the production Wrangler config;
5. records a D1 Time Travel restore point;
6. builds the Worker;
7. applies all pending D1 migrations;
8. verifies critical tables and columns using `db/verify-critical-schema.sql`;
9. deploys the Worker;
10. verifies `/api/v1/health` when the caller performs the post-deploy health check.

### Verify Service Recovery

After the guarded deploy helper succeeds:

1. Sign in and load `/dashboard/details`; it must return the rendered page instead of HTTP 500.
2. Load `/settings/devices`; existing devices, legacy installations, and tokens must render.
3. Run one existing collector without reinstalling or pairing it again.
4. Confirm the collector receives a successful ingest response.
5. Confirm the device `last_synced_at` and upload token `last_used_at` advance in D1.
6. Confirm public leaderboards only reflect users who opted in; an empty leaderboard alone does not
   prove ingestion failed.

Migration `0022` backfills each existing device with a legacy installation and assigns existing upload
tokens to it. Existing users do not need new upload tokens or client reinstallations after the migration.

## Rollback

If a migration or deployment produces a new failure:

1. stop additional deployments;
2. use the restore timestamp/bookmark recorded before deployment to restore D1 with Cloudflare Time Travel;
3. roll back the Worker to the previously recorded version;
4. verify health, authenticated pages, and one collector ingest before reopening traffic.
