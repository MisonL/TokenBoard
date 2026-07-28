# Private Cloudflare Deployment Verification - 2026-07-16

## Scope

- Branch: `fix/post-pr19-followup`
- Commit under test: `2beffb5bed5986129562eef0afa6eb103c537155`
- Base: `upstream/master` at merge commit `51cb011`
- Target: the maintainer's private Cloudflare Worker and D1 database
- Pull request: not created during this verification

Private account identifiers, D1 identifiers, secrets, upload tokens, and the D1 Time Travel bookmark are intentionally omitted.

## Pre-deployment Gates

| Check | Result |
| --- | --- |
| `pnpm test` | Passed: usage-core 9, collector 364, web 567 tests |
| `node --test skills/tokenboard/scripts/*.test.mjs` | Passed: 310 tests |
| `pnpm typecheck` | Passed for all workspace packages |
| `pnpm build` | Passed; client and Worker bundles built |
| Production config validation | Passed for the private Wrangler config |
| `wrangler deploy --dry-run` | Passed with the expected D1, assets, variables, route, and cron bindings |
| `pnpm audit --audit-level=high` | Not completed: the npm legacy audit endpoint returned HTTP 410 |

## Deployment

- Applied D1 migrations:
  - `0026_upload_tokens_user_id.sql`
  - `0027_daily_report_model_sources.sql`
- Confirmed no pending D1 migrations after deployment.
- Confirmed `upload_tokens_user_id_idx` exists in the remote schema.
- `daily_report_history` contained no rows, so migration `0027` had no historical rows to update.
- Deployed Worker version: `38e72826-7f4c-4e7c-b129-f3c04fad57e1`.
- Confirmed the custom domain and `*/15 * * * *` cron trigger were attached.
- Recorded a private D1 Time Travel restore point before applying migrations.

## Runtime Verification

- Health endpoint returned HTTP 200 with the expected TokenBoard JSON contract.
- Home, leaderboard, sign-in, public JSON, and public SVG routes returned HTTP 200.
- New JavaScript and CSS assets returned HTTP 200 and matched the deployed HTML references.
- Unauthenticated `GET /api/v1/me` returned the structured unauthorized error.
- Unauthenticated `POST /api/v1/ingest/check` returned HTTP 401 with `UNAUTHORIZED` and did not expose credentials.
- Public JSON exposed only the documented usage/profile fields and did not contain email, internal user ID, upload token, or token hash fields.
- Desktop and 390 px mobile browser checks rendered the home, leaderboard, and sign-in views without page errors or horizontal overflow.
- Client navigation updated the leaderboard URL and document title for the monthly filter.

## End-to-end Ingest

Executed a real bounded `source all` sync against the private deployment with automatic checkout upgrade disabled:

```text
upserted: 28
skipped: 7
```

The command exited successfully. Remote D1 verification showed a new `daily_usage.synced_at` value after deployment for both `claude-code` and `codex`. The database retained all five supported source values.

The collector emitted three expected diagnostics where Codex subagent corrections exceeded the corresponding session row. These records were skipped by the correction guard and did not fail collection or upload.

## Conclusion

The private Cloudflare deployment, both pending D1 migrations, public and authenticated route boundaries, responsive pages, client navigation, and real collector ingest all passed. The branch is ready for final review before opening the upstream pull request. The npm audit endpoint failure remains an external tooling limitation rather than a passing security result.

## Production Guard Follow-up

After adding the critical schema gate and confirming the manual-only deployment policy, the guarded
deploy helper was run again against the same private Worker and D1 database.

- Commit under test: `3aff05780f0c35ba6a51b44ba3242a29a63a0dd6`.

- `pnpm test`: passed; workspace tests completed with 9 usage-core, 364 collector, and 570 web tests.
- `node --test skills/tokenboard/scripts/*.test.mjs`: passed; 310 tests.
- `pnpm typecheck`: passed for all workspace packages.
- `pnpm build`: passed; client and Worker bundles built.
- D1 Time Travel restore point recorded before the deploy.
- Remote migration step reported `No migrations to apply!`.
- `db/verify-critical-schema.sql`: passed with four queries and zero rows written.
- Worker version: `197153c1-bf32-47fa-beef-a1ec2bb24be2`.
- Post-deploy `/api/v1/health`: HTTP 200 with `{"ok":true,"name":"TokenBoard"}`.
- Post-deploy home page: HTTP 200 and `TokenBoard` document title.
- Unauthenticated `/dashboard/details` and `/settings/devices`: HTTP 302 to `/auth/sign-in`.
- Remote migration list: no migrations to apply.

## Current Follow-up Runtime Evidence - 2026-07-27

This section records a new private-environment runtime check for the current uncommitted
`fix/post-merge-reliability-followups` candidate. Private account, route, database, restore-point,
credential, device, and usage identifiers remain intentionally omitted.

- Private Wrangler config validation passed.
- The remote migration list reported no pending migrations.
- Remote `db/verify-critical-schema.sql` and `PRAGMA foreign_key_check` both completed successfully
  without a reported schema or foreign-key violation.
- The private Worker has an active deployment; health and home responses succeeded, and the JS/CSS
  resources referenced by the deployed home page responded successfully.
- Anonymous `/api/v1/me` and `/api/v1/ingest/check` returned the expected `UNAUTHORIZED` boundary.
  Anonymous `/dashboard/details` and `/settings/devices` redirected to sign-in.
- A saved, inactive legacy-compatible local profile was used only through a child-process environment
  with an isolated temporary collector state directory. A real `antigravity-cli --since all` upload
  exited successfully; the server skipped existing idempotent snapshots and advanced both the matched
  upload token's last-used time and device's last-synced time. The temporary state directory was
  removed after the command. No active profile, device-link state, or local credential was changed.

Authenticated dashboard/device rendering, the installation-command copy controls, and AJAX navigation
remain pending because the browser has no authenticated session for this private site. This section
does not claim those checks, a new deployment operation, or a current D1 Time Travel restore point
were completed.

## Current Follow-up Browser Evidence - 2026-07-28

The pending browser checks above were completed against the same private deployment after the
maintainer completed GitHub OAuth in an isolated, headed browser session. No browser state,
account data, device identifiers, credentials, command contents, or clipboard data was exported.

- The authenticated dashboard rendered with the signed-in navigation and no sign-in link.
- `/dashboard/details` rendered without an error state or loading residue at desktop and 390 px
  mobile widths; both checks found no horizontal overflow.
- `/settings/devices` rendered its overview and device list at desktop and 390 px mobile widths
  without an error state or horizontal overflow. A visible device-details action issued the
  authenticated fragment request, received HTTP 200, and populated the modal with a close control.
- `/settings/install` rendered six labelled copy controls while no one-time pairing prompt was
  generated. Copying the non-secret notifier-hook command produced the expected success state and
  accessible success toast; the clipboard was not read.
- Anonymous home and leaderboard pages rendered at desktop and 390 px mobile widths without
  horizontal overflow. Switching the leaderboard to monthly tokens used its fragment request and
  updated the URL and document title without a full-page navigation fallback.

The current candidate therefore has private D1/schema, anonymous boundary, authenticated page,
client navigation, copy-control, and real collector-ingest evidence. Commit, push, and pull-request
publication remain separate release-preparation work and are not claimed by this section.
