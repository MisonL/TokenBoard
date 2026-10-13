# Private Cloudflare Deployment Verification - 2026-07-16

（2026-10-13 精简版：初次部署、guarded helper 复跑、2026-07-27/28/29 四轮跟进验证折叠为一份结论；逐轮明细见 git 历史。）

## Scope

- 初次验证分支：`fix/post-pr19-followup`，commit `2beffb5b…`；基线 `upstream/master` `51cb011`
- Target: the maintainer's private Cloudflare Worker and D1 database；pull request 未随本次验证创建
- Private account identifiers, D1 identifiers, secrets, upload tokens, and the D1 Time Travel bookmark are intentionally omitted.

## Deployment Record

- Applied D1 migrations `0026_upload_tokens_user_id.sql` and `0027_daily_report_model_sources.sql` (initial), later `0022`–`0029` (isolated preview); no pending migrations after each deployment.
- Initial Worker version `38e72826-…`; guarded-helper redeploy `197153c1-…` after the critical-schema gate and manual-only deployment policy landed.
- A D1 Time Travel restore point was recorded before each migration batch.
- Initial gate: `pnpm test` (usage-core 9, collector 364, web 567), skill scripts 310, typecheck, build, config validation, `wrangler deploy --dry-run` all passed; `pnpm audit --audit-level=high` did not complete (npm legacy audit endpoint HTTP 410) and is not counted as a passing security result.

## Runtime Verification (Consolidated)

- Health endpoint HTTP 200 with the expected JSON contract; home, leaderboard, sign-in, public JSON/SVG routes and new JS/CSS assets HTTP 200.
- Anonymous boundaries: `/api/v1/me` and `/api/v1/ingest/check` return structured `UNAUTHORIZED` without exposing credentials; `/dashboard/details` and `/settings/devices` redirect to `/auth/sign-in`.
- Real bounded `source all` ingest against the private deployment succeeded (`upserted: 28, skipped: 7`); `daily_usage.synced_at` advanced for both `claude-code` and `codex`; three expected Codex subagent-correction diagnostics were skipped by the correction guard.
- Authenticated browser checks (2026-07-28, isolated headed session after GitHub OAuth): dashboard, `/dashboard/details`, `/settings/devices` (including device-details fragment modal), and `/settings/install` copy controls rendered at desktop and 390 px mobile widths without error states or horizontal overflow; leaderboard monthly filter used its fragment navigation; copying the non-secret notifier-hook command produced the expected success toast without clipboard reads.
- Public sign-in route rendered responsively; the GitHub button redirects to GitHub's provider-hosted OAuth page, which is outside the Worker's styling surface.
- Isolated private preview (2026-07-29, commit `3230289`, separate `workers.dev` Worker + D1): migrations `0022`–`0029` applied, `WEBHOOK_ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` confirmed as Worker secrets, real ingest with a temporary identity/token verified D1 usage/summary/token/device updates, and all temporary records including rate-limit rows were removed afterward. The preview deliberately received no GitHub OAuth client secrets, so no OAuth callback check was claimed.

## Conclusion

The private Cloudflare deployment, D1 migrations, public and authenticated route boundaries, responsive pages, client navigation, and real collector ingest all passed across the recorded rounds. Commit, push, and pull-request publication remained separate release-preparation work and were not claimed by these records.
