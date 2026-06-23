# AGY Token Support Verification - 2026-06-23

## Scope

- Branch: `research/agy-token-support-plan`.
- Feature: Antigravity CLI token support with source value `antigravity-cli`.
- Status line entrypoint: `~/.gemini/antigravity-cli/settings.json` `statusLine.command`.
- D1 schema: unchanged. Existing source columns are `TEXT`.

## Implementation Checks

- `packages/usage-core` accepts `antigravity-cli` and still rejects unknown source aliases such as `agy`.
- `packages/collector` reads sanitized `antigravity-cli-statusline.jsonl`, validates schema version and token bounds, dedupes repeated status line rows, tracks pending upload cursor state, and emits `costUsd: 0`.
- `skills/tokenboard/scripts/antigravity-statusline.mjs` reads bounded stdin, hashes conversation IDs, writes only sanitized JSONL, records malformed payloads to an error log, and never calls sync or upload.
- `skills/tokenboard/scripts/antigravity-hook.mjs` installs only when explicitly requested with `--source antigravity-cli`, stores a restorable original `statusLine` backup, and does not create `notify.cjs`.
- Web usage, daily reports, report history, notifications, and cost leaderboards label `Antigravity CLI (agy)` and mark Antigravity cost as unavailable.

## Local Antigravity Probe Gate

Evidence file: `docs/reviews/AGY-STATUSLINE-PROBE-2026-06-23.md`.

Gate result:

- Proceeded with `context_window.current_usage` as the first-version token signal.
- Did not use `context_window.total_*` as usage delta.
- Did not parse `.db`, `.pb`, `/credits`, `/usage`, or logs.

## End-to-End Local Validation

Command shape:

```bash
TOKENBOARD_CONFIG_DIR=<temp-state> node skills/tokenboard/scripts/install-hook.mjs --source antigravity-cli
node skills/tokenboard/scripts/status.mjs
agy -p "<short probe prompt>"
TOKENBOARD_STATE_DIR=<temp-state> TOKENBOARD_ANTIGRAVITY_STATUSLINE_LOG=<temp-state>/antigravity-cli-statusline.jsonl TOKENBOARD_SKIP_UPGRADE=1 node skills/tokenboard/scripts/sync.mjs --mode preview --source antigravity-cli --skip-upgrade
TOKENBOARD_CONFIG_DIR=<temp-state> node skills/tokenboard/scripts/uninstall-hook.mjs --source antigravity-cli
node skills/tokenboard/scripts/status.mjs
```

Observed result:

- Temporary state directory: `/tmp/tokenboard-agy-e2e.AOGr0l`.
- Settings restoration check: `yes`; `~/.gemini/antigravity-cli/settings.json` SHA-256 returned to its pre-install value.
- Installed status: `hooks.antigravityCli = installed`.
- Uninstalled status: `hooks.antigravityCli = not-installed`.
- Status line event lines: `2`.
- Collector preview source: `antigravity-cli`.
- First collector preview snapshots: `1`.
- Second collector preview snapshots without upload acknowledgement: `1`, re-emitted from pending cursor as expected.
- Status line conversation hash format check: 2 rows matched 64-character lowercase hex.
- Sanitized event scan for prompt text, `/Users/`, email-like text, raw `conversation_id`, `cwd`, `workspace`, `email`, `plan_tier`, and `transcript_path`: no matches.
- Preview snapshot had `costUsd: 0`, `sessionCount: 1`, source `antigravity-cli`, model `Gemini 3.5 Flash (Medium)`.

## Automated Verification

All commands exited with status `0`.

```bash
node --test skills/tokenboard/scripts/antigravity-statusline.test.mjs skills/tokenboard/scripts/antigravity-hook.test.mjs skills/tokenboard/scripts/hooks.test.mjs skills/tokenboard/scripts/status.test.mjs
pnpm --filter @tokenboard/usage-core test
pnpm --filter @tokenboard/collector typecheck
pnpm --filter @tokenboard/collector test
pnpm --filter @tokenboard/web test -- app/features/notifications/adapters.test.ts app/features/usage/components/dashboard-preview.test.tsx app/features/usage/components/usage-details-filters.test.tsx app/features/usage/service.test.ts app/features/device/components/install-command.test.tsx app/features/leaderboards/components/leaderboard-panel.test.tsx
pnpm --filter @tokenboard/web typecheck
pnpm typecheck
pnpm test
node --test skills/tokenboard/scripts/*.test.mjs
git diff --check
```

Summary:

- `packages/usage-core`: 2 test files, 6 tests passed.
- `packages/collector`: 22 test files, 160 tests passed.
- `apps/web`: 60 test files, 421 tests passed.
- Skill scripts: 163 Node tests passed.
