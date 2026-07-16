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

## Guarded Recovery After Merging PR #20

PR #20 adds a manual-only workflow named `Manual Production Migration and Deploy`. It preserves the
manual deployment policy and never runs on a push or pull request.

### 1. Configure The Production Environment

Create or select the GitHub Environment named `production`.

Configure these secrets:

| Secret | Required value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Token with D1 edit and Worker deployment access |
| `CLOUDFLARE_ACCOUNT_ID` | Account that owns both production resources |
| `D1_DATABASE_ID` | Production D1 database UUID |

Configure these variables:

| Variable | Required value |
| --- | --- |
| `TOKENBOARD_WORKER_ROUTE` | Production custom-domain host without protocol or path |
| `BETTER_AUTH_URL` | Canonical production HTTPS origin |

The workflow defaults `TOKENBOARD_COLLECTOR_REPO_URL` to the upstream GitHub repository and
`TOKENBOARD_COLLECTOR_REF` to `master`. The retention and batch variables use the defaults documented
in `README.md` when omitted.

The production Worker must already contain these Worker secrets:

- `BETTER_AUTH_SECRET`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `WEBHOOK_ENCRYPTION_KEY`

### 2. Run The Manual Workflow

1. Open the repository **Actions** page.
2. Select **Manual Production Migration and Deploy**.
3. Select the merged `master` branch.
4. Choose **Run workflow**.
5. Enter `MIGRATE_AND_DEPLOY` exactly.

The workflow stops before checkout when confirmation or required configuration is missing. A valid run:

1. installs dependencies;
2. runs workspace and skill-script tests;
3. runs type checking;
4. generates and validates the production Wrangler config;
5. records a D1 Time Travel restore point;
6. builds the Worker;
7. applies all pending D1 migrations;
8. verifies critical tables and columns using `db/verify-critical-schema.sql`;
9. deploys the Worker;
10. verifies `/api/v1/health`.

### 3. Verify Service Recovery

After the workflow succeeds:

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
2. use the restore timestamp/bookmark from the workflow log to restore D1 with Cloudflare Time Travel;
3. roll back the Worker to the previously recorded version;
4. verify health, authenticated pages, and one collector ingest before reopening traffic.
