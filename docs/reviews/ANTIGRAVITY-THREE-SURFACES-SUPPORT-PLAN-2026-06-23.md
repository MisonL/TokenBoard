# Antigravity Three-Surface Support Plan - 2026-06-23

## Scope

This note covers the three Google Antigravity user-facing products relevant to
TokenBoard usage tracking:

- Antigravity CLI, executable `agy`.
- Antigravity IDE, the VS Code based desktop IDE.
- Antigravity 2.0, the standalone desktop Electron application.

The Google Antigravity Python SDK is related but out of this three-surface scope.
It has an explicit `agent.conversation.total_usage` API and should be handled as
a separate future source if TokenBoard later targets SDK-built agents.

## Control Contract

- Primary setpoint: support Google Antigravity usage in TokenBoard without
  reading or uploading raw conversation content, local paths, emails, tool
  arguments, or unstable private history blobs.
- Acceptance: each supported surface must provide a stable, repeatable token
  signal with model, timestamp, and per-generation or cumulative session usage
  semantics that TokenBoard can dedupe.
- Guardrails: do not parse `.pb`, SQLite blob payloads, logs, browser storage,
  or private language server APIs as production upload sources when they expose
  raw conversation content.
- Boundary: CLI upload support is implemented. GUI/IDE code may expose
  diagnostic probes, but production upload remains blocked until the privacy
  gate passes.
- Recovery target: any future installer must be explicitly opt-in and must
  restore the user's previous product settings on uninstall.
- Rollback trigger: if a surface only exposes private blobs or raw conversation
  content, stop before implementing uploads for that surface.

## Product Facts

### Antigravity CLI

- Official CLI repository: `https://github.com/google-antigravity/antigravity-cli`.
- The official README describes the CLI as a terminal interface that shares the
  core agent engine with Antigravity 2.0, shares settings, and can export
  terminal sessions to the GUI.
- The official status line example reads JSON from stdin and uses
  `context_window.used_percentage`.
- Local `agy --version`: `1.0.10`.
- Existing TokenBoard branch already supports this surface via
  `~/.gemini/antigravity-cli/settings.json` `statusLine.command`.
- Local CLI data root: `~/.gemini/antigravity-cli`.
- Local CLI conversation files observed: 267 IDs, including 109 `.db`, 156 `.pb`,
  and 2 `.tmp` files.

### Antigravity IDE

- Local guide describes Antigravity IDE as a standalone AI-first IDE built on
  VS Code, with passive autocomplete, inline command, and sidebar chat / agent
  modes.
- Running process uses `subclient_type ide`.
- Running process uses `app_data_dir antigravity-ide`.
- Local IDE data root: `~/.gemini/antigravity-ide`.
- Local IDE conversation files observed: 62 `.pb` files.
- No `statusLine` or `current_usage` setting was found in IDE settings or the
  user data JSON files inspected by key name.
- No stable public token export path was found from visible settings, logs, or
  public docs during this pass.
- A local language server probe using
  `GetCascadeTrajectoryGeneratorMetadata` returned token counters, but also
  returned `chatModel.promptSections[].content`; this fails TokenBoard's
  privacy gate for automatic upload.

### Antigravity 2.0 Standalone App

- Local guide describes Antigravity 2.0 as a standalone Electron app that
  launches and monitors agents independently of an IDE.
- Running process uses `subclient_type hub`.
- Running process uses `app_data_dir antigravity`.
- Local standalone data root: `~/.gemini/antigravity`.
- Local standalone conversation files observed: 61 IDs, including 60 `.pb` files
  and 1 `.db` file.
- The standalone and IDE roots share 60 conversation IDs locally, so they appear
  to mirror or share much of the same GUI conversation state.
- No overlap was observed between CLI conversation IDs and the combined GUI IDs.
- A local language server probe using
  `GetCascadeTrajectoryGeneratorMetadata` returned `chatModel.usage.inputTokens`,
  `outputTokens`, `cacheReadTokens`, `model`, and `chatStartMetadata.createdAt`.
  The same response also included `chatModel.promptSections[].content`, so the
  endpoint is not safe as a TokenBoard upload source.

## Storage Findings

- CLI and standalone SQLite conversation files share the same schema:
  `trajectory_meta`, `steps`, `gen_metadata`, `executor_metadata`,
  `parent_references`, `trajectory_metadata_blob`, and `battle_mode_infos`.
- These SQLite tables store payloads as blobs and do not expose token columns.
- The GUI conversation format is primarily `.pb`; decoding it would require
  private schema assumptions and may expose raw conversation content.
- The language server binaries contain generic Google `UsageMetadata` symbols,
  such as prompt, candidates, cache, thoughts, and total token counters. This is
  evidence that token accounting exists internally, but it is not a public local
  export contract.
- Request body experiments with `includePromptSections: false`,
  `excludeContent: true`, and a usage-only `fieldMask` did not remove
  `promptSections[].content` from the local language server response.

## Decision

Production-grade support for all three products cannot mean "parse every local
history file." The safe interpretation is:

- Support Antigravity CLI token uploads now through the documented and verified
  status line event path.
- Represent Antigravity IDE and Antigravity 2.0 in TokenBoard status/detection
  UX as installed but not auto-trackable until a stable token-only signal is
  found.
- Keep GUI source values `antigravity-ide` and `antigravity` available for
  schema/display and explicit diagnostics, but do not include them in
  `--source all` until the privacy gate passes.
- The current diagnostic provider must fail when the language server response
  contains raw content fields such as `promptSections[].content`.

## Implementation Plan

### Phase 0: Three-Surface Detection

Status: implemented in `skills/tokenboard/scripts/hooks.mjs` and covered by
`skills/tokenboard/scripts/hooks.test.mjs`.

Add safe local detection only:

- CLI installed/configured: check `agy`, `~/.gemini/antigravity-cli/settings.json`,
  and TokenBoard status line hook state.
- IDE installed: check the IDE app or `~/.gemini/antigravity-ide`.
- Standalone installed: check the standalone app or `~/.gemini/antigravity`.

Expose this in `status.mjs` so users can see:

- `antigravityCli`: installed / not-installed / capture-enabled.
- `antigravityIde`: installed / no-token-export.
- `antigravity`: installed / no-token-export.

This phase does not upload GUI usage.

### Phase 1: Keep CLI as the Only Uploading Antigravity Source

Keep `antigravity-cli` as the only Antigravity source enabled by
`--source all` until a GUI export contract exists. Keep the current constraints:

- explicit opt-in install;
- sanitized JSONL only;
- no `.db`, `.pb`, logs, `/usage`, or `/quota` uploads;
- `costUsd: 0` with cost unavailable labels.

### Phase 2: GUI Token Signal Probe

Status: local probe completed against the standalone app data root. It found
token counters but failed the privacy gate because the same response includes
prompt section content.

Run or repeat non-uploading probes for the two GUI products:

- Start one new IDE chat and one new standalone chat.
- Observe only documented settings, public extension APIs, or product-provided
  export commands.
- Record whether any stable event includes model and token counters.
- Do not decode `.pb`, blob fields, or raw conversation logs.
- Do not call `GetCascadeTrajectory` or `GetCascadeTrajectorySteps` for upload
  logic; both can return raw conversation content.

If no stable token-only signal exists, leave GUI products as explicit
diagnostic-only sources.

### Phase 3: Future GUI Upload Provider

Only if Phase 2 finds a stable token-only signal:

- keep `antigravity-ide` and/or `antigravity` as separate provider modules
  instead of overloading `antigravity-cli`;
- enable them in `--source all`;
- dedupe by product, hashed conversation ID or event ID, model, and usage tuple;
- add UI labels and cost unavailable notes;
- verify with fresh, resumed, and multi-project GUI sessions.

## Gates Before Shipping GUI Upload Support

- A public or clearly stable token-only event source exists.
- A probe proves the event excludes prompt, completion, path, email, tool
  arguments, and raw conversation IDs.
- Fresh and resumed GUI sessions produce non-duplicated usage snapshots.
- Uninstall or disable restores all user-visible settings.
- `pnpm test`, `pnpm typecheck`, and relevant skill script tests pass.

## Current Recommendation

Ship the current CLI support as the first Antigravity integration. Keep
three-surface detection and GUI source labels, but do not claim automatic token
tracking for Antigravity IDE or Antigravity 2.0 until Google exposes a stable
token-only usage export or a local API can be proven to omit raw content.
