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
