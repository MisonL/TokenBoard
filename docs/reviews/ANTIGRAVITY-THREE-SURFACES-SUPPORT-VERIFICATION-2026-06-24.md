# Antigravity Support Verification - 2026-06-24

## Scope

TokenBoard supports metadata-only token extraction for these Google
Antigravity sources:

- `antigravity-cli`: Antigravity CLI / `agy`.
- `antigravity`: standalone Antigravity desktop app.
- `antigravity-ide`: VS Code based Antigravity IDE.

The Worker ingest schema is unchanged. All three sources normalize to the
shared `UsageSnapshot` contract.

## Collection Contract

- Antigravity CLI reads `~/.gemini/antigravity-cli/conversations/*.db`
  `gen_metadata.data`; it may also read the optional sanitized status line
  JSONL produced by `statusLine.command`.
- Standalone Antigravity reads `~/.gemini/antigravity/conversations` SQLite
  metadata and uses bounded language-server metadata projection for `.pb`-only
  histories.
- Antigravity IDE uses the same SQLite and bounded projection strategy under
  `~/.gemini/antigravity-ide/conversations`.
- The Antigravity CLI status line hook is explicit opt-in. It is not installed
  by default `--source all` hook setup.
- Hook mode does not scan Antigravity history; scheduled and manual syncs do.

## Privacy And Cost

Collectors may persist or upload only source, date, timezone, model, token
counts, `costUsd: 0`, session count, and local dedupe hashes.

Collectors must not persist or upload prompt text, completion text,
`promptSections`, `conversationHistory`, local paths, emails, tool arguments,
raw conversation IDs, raw response IDs, full SQLite blobs, or full
language-server responses.

When `responseModel` is available, it is preferred over placeholder model IDs.
Placeholder IDs remain possible when Antigravity did not persist a resolved
model.

Antigravity local history does not expose USD cost. All three sources emit
`costUsd: 0`; Web, public card, reports, webhook output, and leaderboards must
label Antigravity cost as unavailable instead of treating `$0.00` as complete.

## Verification Summary

Real local preview with a temporary TokenBoard state directory produced:

- `antigravity-cli`: 13 snapshots.
- `antigravity`: 30 snapshots.
- `antigravity-ide`: 25 snapshots.
- isolated `--source all`: 68 Antigravity snapshots split as 13 / 30 / 25.

Automated verification commands:

```bash
pnpm --filter @tokenboard/collector test -- src/providers/antigravity-cli.test.ts src/providers/antigravity-gui.test.ts src/providers/antigravity-gui-client.test.ts src/providers/antigravity-history-db.test.ts src/providers/antigravity-history-protobuf.test.ts src/cli-antigravity.test.ts
pnpm --filter @tokenboard/collector typecheck
pnpm --filter @tokenboard/collector test
pnpm typecheck
pnpm test
node --test skills/tokenboard/scripts/*.test.mjs
pnpm build
git diff --check
```

Latest observed results:

- `usage-core`: 6 tests passed.
- `collector`: 218 tests passed.
- `web`: 431 tests passed.
- Skill scripts: 166 tests passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed with the existing Node `DEP0205 module.register()`
  warning.
- `git diff --check`: passed.

## Review Notes

Reviewed and fixed edge cases around DB/statusline dedupe, statusline-only CLI
sync, optional unavailable products in `--source all`, real DB parse failures,
bounded GUI/IDE language-server scanning, cursor acknowledgement, public JSON
cost availability, and Antigravity cost-unavailable labels.

Do not add time-based cursor pruning without a separate compaction design that
can still reconstruct full source/date/model snapshots for overwrite ingest.
- Cost remains unavailable for all Antigravity sources.
