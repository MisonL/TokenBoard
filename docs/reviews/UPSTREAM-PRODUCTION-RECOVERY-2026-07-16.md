# Upstream Production Recovery - 2026-07-16

（2026-10-13 精简版：事故处置与恢复手册保留原文；其后追加的 5 份候选质量门禁快照（2026-07-19/23/25/27×2）已折叠为一节，完整记录见 git 历史。）

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

## Recovery After Merging PR #20

PR #20 does not configure GitHub Actions or Cloudflare Workers Builds automatic deployment. A
maintainer with Cloudflare access must run the guarded deploy helper locally.

Before deploying, confirm the production Worker already contains these Worker secrets:
`BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `WEBHOOK_ENCRYPTION_KEY`.

1. Create a private production Wrangler config from `wrangler.production.example.jsonc`.
2. Set `TOKENBOARD_WRANGLER_CONFIG` to that config and authenticate Wrangler with the production account.
3. Install dependencies, then run workspace tests, skill-script tests, and type checking.
4. Record a D1 Time Travel restore point:

   ```bash
   timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   pnpm exec wrangler d1 time-travel info DB \
     --timestamp "$timestamp" \
     --json \
     --config wrangler.jsonc
   ```

5. Run the guarded deploy helper:

   ```bash
   TOKENBOARD_WRANGLER_CONFIG=wrangler.production.jsonc pnpm --filter @tokenboard/web run deploy
   ```

The helper validates the production config, builds the Worker, applies all pending D1 migrations,
verifies critical tables and columns via `db/verify-critical-schema.sql`, then deploys. Do not run a
standalone `wrangler deploy` first. Tests, type checking, the Time Travel restore point, and the
post-deploy health check remain explicit operator steps outside the helper.

## Verify Service Recovery

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

## Historical Quality-Gate Snapshots (Condensed)

Five local gate snapshots for the follow-up branch (2026-07-19, 07-23, 07-25, 07-27 ×2, against
baseline `c43b67c`) were recorded here in full. Each passed `pnpm test`, `pnpm typecheck`, skill
script tests, `pnpm build`, `pnpm audit --audit-level=high`, and `git diff --check`; test counts
grew from 988 (usage-core 9, collector 407, Web 572) to 1,165 (collector 578) across the snapshots
as Codex profile-cursor and file-identity fixes landed. Each snapshot was explicitly local-only
evidence and not deployment proof; the operative deployment verification lives in
`PRIVATE-CLOUDFLARE-DEPLOYMENT-VERIFICATION-2026-07-16.md`.

One complexity note retained from those snapshots: `apps/web/app/routes/settings/devices.tsx`
(~1,510 lines) was explicitly exempted from splitting within the reliability follow-up; a later UI
task should split it by the existing `DevicesPage`, details, credentials, and
installation/audit sections while preserving its route-level tests.
