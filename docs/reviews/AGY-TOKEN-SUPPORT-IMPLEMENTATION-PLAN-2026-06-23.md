# AGY Token Support Implementation Plan - 2026-06-23

## Branch Scope

- Branch: `research/agy-token-support-plan`.
- This branch intentionally carries the existing `AGENTS.md` repository guideline update. Do not drop it when this plan branch is continued or committed.
- This document is an implementation plan only. It does not change collector, Web, API, or local hook behavior yet.

## Control Contract

- Primary setpoint: add reliable token-count support for `agy` / Antigravity CLI without uploading conversation content, local paths, email, or unstable history blobs.
- Acceptance: implementation must produce standard `UsageSnapshot` rows for a new source only after real status line payload semantics are verified.
- Guardrails: no raw prompt/completion upload, no raw `cwd`, `workspace`, `email`, `plan_tier`, no silent fallback to guessed logs or binary history parsing, no direct network call from the status line command.
- Sampling plan: capture sanitized status line events from at least two fresh agy conversations and one existing resumed conversation before enabling upload aggregation.
- Delay budget: status line handler must return quickly and never block on TokenBoard network, package install, or backend upload.
- Recovery target: uninstall must restore the previous `statusLine` command or remove TokenBoard's command cleanly.
- Rollback trigger: stop implementation if status line counters cannot be proven to represent billable or usage-equivalent token increments.
- Boundary: allowed follow-up files are `packages/usage-core`, `packages/collector`, `skills/tokenboard/scripts`, source formatting in `apps/web/app/features`, tests, and docs. D1 schema is expected to remain unchanged because `source` is stored as text.
- Main risks: status line counters may be context-window state rather than cumulative usage, custom status line chaining may degrade the agy TUI, and `costUsd=0` can make cost views misleading unless labeled.

## Evidence Base

### Repository Facts

- `packages/usage-core/src/schema.ts` currently accepts only `claude-code` and `codex`.
- `packages/collector/src/cli.ts` hard-codes `CliSource = 'claude-code' | 'codex' | 'all'`, imports only `collectClaudeCodeUsage` and `collectCodexUsage`, and expands `all` to the two existing sources.
- `packages/collector/src/providers/claude-code.ts` and `packages/collector/src/providers/codex.ts` both support normal ccusage collection and hook-triggered incremental collection.
- `skills/tokenboard/scripts/hooks.mjs` installs a generated `notify.cjs` handler, then wires Codex and Claude Code hooks. The generated handler only queues a local signal and launches `notify.mjs`; it does not upload directly from the host tool hook.
- `skills/tokenboard/scripts/notify.mjs` accepts only `codex` and `claude-code`.
- Web and notification source names are repeated in multiple formatters, including usage details and daily report notification formatting.
- D1 migrations store `daily_usage.source` and `daily_usage_summary.source` as `TEXT NOT NULL`, so adding a source should not require a database migration.

### Official Antigravity Facts

- Official status line docs define `~/.gemini/antigravity-cli/settings.json` `statusLine` configuration with `"type": "command"` and `"command": "..."`.
- The status line command receives a detailed JSON payload on stdin whenever agent state changes, then stdout is rendered in the prompt status line.
- Official fields include `cwd`, `conversation_id`, `model`, `product`, `workspace`, `version`, `plan_tier`, `email`, `context_window`, `agent_state`, `vcs`, `sandbox`, and related UI state.
- `context_window` contains `total_input_tokens`, `total_output_tokens`, `context_window_size`, `used_percentage`, `remaining_percentage`, and `current_usage` with input, output, cache creation, and cache read token fields.
- Official credits docs describe `/credits` and status line credit indicators as quota or credit UI, not stable token export.
- Official CLI reference describes `/usage` as the offline developer help manual, not a stable usage export.
- Official migration docs say Antigravity CLI preserves Gemini CLI developer experience constructs and imports Gemini CLI plugins, skills, commands, and MCP settings, but this is not a token history contract.
- Official changelog says 1.0.4 added SQLite conversation support, and 1.0.8 added quota usage and execution mode in the status line. The public GitHub repository currently exposes README, CHANGELOG, examples, and assets, not a stable conversation parser implementation.

Reference URLs:

- https://antigravity.google/docs/cli-statusline
- https://antigravity.google/docs/cli-credits
- https://antigravity.google/docs/cli-reference
- https://antigravity.google/docs/gcli-migration
- https://github.com/google-antigravity/antigravity-cli

### Local Host Facts

- Local `agy` path: `/Users/mison/.local/bin/agy`.
- Local `agy --version`: `1.0.10`.
- Current `~/.gemini/antigravity-cli/settings.json` only has `colorScheme`, `enableTelemetry`, and `trustedWorkspaces`; no TokenBoard status line hook is installed.
- Current `~/.gemini/antigravity-cli/import_manifest.json` shows imports from `gemini-cli` for `exa-mcp-server`, `chrome-devtools-mcp`, and `gemini-plan-commands`.
- Current `~/.gemini/antigravity-cli/conversations` has 102 `.db`, 156 `.pb`, and 2 `.tmp` files.
- Latest inspected SQLite schema has `trajectory_meta`, `steps`, `gen_metadata`, `executor_metadata`, `parent_references`, `trajectory_metadata_blob`, and `battle_mode_infos`; usage-relevant payloads are blob fields, not structured token columns.
- Legacy `~/.gemini/antigravity/conversations` and `~/.gemini/antigravity-backup/conversations` each have 60 `.pb` files. These directories should be treated as separate legacy product state, not as direct agy CLI usage input.

## Architecture Decision

First version should be forward-only and status-line based.

Do not parse `.db`, `.pb`, logs, `/credits`, or `/usage` for uploadable token statistics. Those paths either lack a stable public schema, are UI commands, or can contain conversation data and local paths.

Use source value `antigravity-cli` and display name `Antigravity CLI (agy)`. This matches the repository's existing kebab-case source style (`claude-code`, `codex`) and avoids using the short executable alias as the durable API value.

## Implementation Phases

### Phase 0: Status Line Semantics Probe

Goal: prove whether official status line token fields can drive TokenBoard snapshots.

Tasks:

- Add a temporary or development-only sanitized capture script that reads status line stdin and writes minimal JSONL under the TokenBoard state directory.
- Run fresh agy sessions with two simple prompts, one longer prompt, and one `/resume` flow.
- Compare repeated status line events for the same conversation and model.
- Decide which counter is valid:
  - If `context_window.total_*` is monotonic cumulative usage for a conversation, use cursor deltas.
  - If `current_usage` represents the latest generation and repeated status updates duplicate it, use a fingerprint dedupe rule.
  - If fields are only current context-window occupancy, do not upload token snapshots and stop at local capture until a better official API exists.

Gate:

- No production upload implementation until this probe has written a short evidence note with sample event shapes and the chosen aggregation rule.

### Phase 1: Shared Source Contract

Files:

- `packages/usage-core/src/schema.ts`
- `packages/usage-core/src/schema.test.ts`
- `apps/web/app/features/usage/schema.ts`
- ingest, usage, notification tests that assert allowed source values

Tasks:

- Add `antigravity-cli` to the shared usage source enum.
- Update duplicated Web source schemas or import the shared enum where practical.
- Add tests that valid snapshots with `antigravity-cli` pass and unknown sources still fail.
- Confirm D1 migration is not needed because source columns are text.

Gate:

- `pnpm --filter @tokenboard/usage-core test`
- related Web schema and ingest tests

### Phase 2: Antigravity Status Line Installer

Files:

- `skills/tokenboard/scripts/hooks-utils.mjs`
- `skills/tokenboard/scripts/hooks.mjs`
- new `skills/tokenboard/scripts/antigravity-hook.mjs`
- new generated or source `skills/tokenboard/scripts/antigravity-statusline.mjs`
- `skills/tokenboard/scripts/status.mjs`
- `skills/tokenboard/scripts/hooks.test.mjs`
- `skills/tokenboard/scripts/status.test.mjs`

Tasks:

- Resolve Antigravity settings path as `~/.gemini/antigravity-cli/settings.json`, with an environment override for tests.
- Support explicit `--source antigravity-cli` install and uninstall.
- Do not silently install Antigravity status line capture as part of default `--source all` until product UX approves changing a visible TUI setting.
- If settings are missing, report `Antigravity CLI settings.json not found` as a skip for install/status.
- If existing `statusLine.command` exists, back it up to TokenBoard state and chain it without recursion.
- If no existing command exists, install only with explicit user opt-in and document that TokenBoard will create a custom status line command.
- The status line handler must:
  - read stdin with a strict max byte limit;
  - parse JSON with explicit errors;
  - write only sanitized event fields;
  - append locally with private file mode;
  - never call TokenBoard HTTP APIs;
  - never include `cwd`, `workspace`, `email`, `plan_tier`, prompt text, completion text, tool arguments, or file paths;
  - return a bounded stdout string or forward the previous command output;
  - record handler errors to a local TokenBoard log without exposing PII.

Gate:

- `node --test skills/tokenboard/scripts/hooks.test.mjs skills/tokenboard/scripts/status.test.mjs`
- manual install/uninstall dry run against fixture settings JSON

### Phase 3: Collector Provider

Files:

- new `packages/collector/src/providers/antigravity-cli.ts`
- new provider tests
- `packages/collector/src/cli.ts`
- `packages/collector/src/index.ts`
- collector CLI tests

Tasks:

- Add `collectAntigravityCliUsage`.
- Read sanitized status line JSONL from the TokenBoard state directory.
- Maintain a provider-specific cursor, for example `antigravity-cli-cursor.json`.
- Store cursor keys using a hash of source, product, conversation ID, and model. Do not persist raw conversation IDs unless a later review explicitly accepts that risk.
- Reject malformed events, non-finite tokens, negative tokens, oversized strings, and token values above a conservative upper bound.
- Convert valid deltas or deduped generation events into `UsageSnapshot`.
- Set `costUsd` to `0` for first version and label cost as unavailable in product surfaces. Do not estimate from `/credits`.
- Count sessions as unique conversation hash plus model plus usage date.
- Add `antigravity-cli` to collector CLI source parsing. In non-hook `all` mode, treat missing Antigravity capture as an optional source error like the existing optional-source behavior. In hook mode, fail fast on malformed Antigravity events.
- Do not use ccusage for Antigravity unless ccusage later provides an official supported `agy` source.

Gate:

- provider unit tests for sanitizer, malformed JSON, duplicate events, counter reset, date attribution, cursor persistence, and no-PII output
- `pnpm --filter @tokenboard/collector test`
- `pnpm --filter @tokenboard/collector typecheck`

### Phase 4: Web, Reports, and Product Labels

Files:

- `apps/web/app/features/usage/components/usage-details-format.ts`
- `apps/web/app/features/notifications/adapters.ts`
- `apps/web/app/features/notifications/report-page.tsx`
- `apps/web/app/features/notifications/report-history-card.tsx`
- source filter controls and related tests

Tasks:

- Display `antigravity-cli` as `Antigravity CLI (agy)`.
- Ensure source filters and CSV export accept the new source.
- Add a visible source-specific note where cost totals can be misleading because Antigravity cost is unavailable.
- Ensure daily reports and webhook cards format the source name instead of falling back to raw text or `全部来源`.

Gate:

- related usage and notification tests
- `pnpm --filter @tokenboard/web typecheck`

### Phase 5: End-to-End Local Validation

Tasks:

- Install Antigravity status line hook explicitly on the local host.
- Start a fresh agy conversation and trigger at least two completions.
- Run `node skills/tokenboard/scripts/status.mjs` and confirm Antigravity hook status is visible.
- Run collector preview for only `antigravity-cli` and inspect sanitized snapshots.
- Run sync to a test or development TokenBoard endpoint if available.
- Uninstall the hook and confirm original `statusLine` state is restored.

Gate:

- local files contain no raw paths or email in the sanitized event log
- upload payload contains only standard `UsageSnapshot` fields
- `pnpm test`
- `pnpm typecheck`

## Historical Import Policy

Default: no historical import.

Reasons:

- `.db` and `.pb` files are not a public stable usage API.
- SQLite token-related data is not available in structured columns.
- Blob payloads can contain transcript or tool data.
- Legacy Antigravity and backup directories are separate product state and can duplicate each other.
- Gemini CLI inheritance proves config/plugin migration, not usage-history continuity.

Possible future extension:

- If Antigravity publishes a stable export command or documented CSV/JSON usage export, add a separate opt-in importer with source metadata and tests.
- Until then, TokenBoard should explain that Antigravity CLI tracking begins after TokenBoard status line capture is installed.

## Test Matrix

- Sanitizer strips PII fields and rejects oversized or malformed payloads.
- Status line handler appends only sanitized JSONL and does not perform network I/O.
- Existing custom status line command is backed up, restored, and not recursively invoked.
- Collector dedupes repeated events from the same conversation and model.
- Counter reset or rewind does not silently produce negative deltas.
- Cross-midnight events are attributed with the configured TokenBoard timezone.
- `source=all` behavior is explicit and tested for missing Antigravity capture.
- Web source labels render correctly in dashboard details, CSV, daily report page, and webhook adapters.
- Cost fields for Antigravity are not represented as real cost.

## Residual Gate Boundary

This plan does not prove that Antigravity status line token fields are billable usage. The required next gate is a local status line semantics probe. If the probe shows that token fields are only context-window occupancy, the implementation must stop before upload support and wait for a documented Antigravity usage export.
