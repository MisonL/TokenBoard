# T08 Final Manual Diff Security Review

Created: 2026-07-25

Last updated: 2026-10-13（精简版：2026-07-25 至 2026-07-31 的约 16 轮 freeze/stale/re-gate 增量快照已折叠为一份结论与缺陷清单；完整逐轮记录见 git 历史）

Baseline: `c43b67c2366e8e842ce21e40d89cdc2aba4e8aea`

Branch: `fix/post-merge-reliability-followups`

## Constraint

The user explicitly disabled the `codex-security` plugin. No plugin scan was run for this
candidate. This record describes a manual diff-scoped review and does not replace the independent
external reviews (T09) or private Cloudflare validation (T10).

## Reviewed Boundaries

- Web and D1: device pairing/reconnect conditional writes, tenant predicates, token rotation UI,
  schema indexes, migrations `0028` and `0029`, and critical-schema verification.
- Collector: CLI dispatch, strict date normalization, Codex scoped files and attribution caches,
  Antigravity history/cursor/GUI paths, hook cursor acknowledgement, and lock liveness.
- Local scripts: statusline passthrough, coordinator and notifier locks, hook installation and
  uninstallation, process liveness, and sync lock inheritance.
- Dependency overrides: only constrained transitive package versions; no lifecycle, registry, or
  credential behavior was added.

Untrusted boundaries: local Codex/Antigravity history files (malformed JSONL, SQLite metadata,
changed files, symlinks, oversized files/lines, hostile model/date values); local hook/statusline
stdin and generated handler environment values; device pairing, reconnect, upload-token rotation
and tenant-scoped D1 writes; Worker deployment configuration, migrations, package overrides, and
public response rendering.

## Result

No confirmed security finding was identified in the final diff. The frozen candidate reached
109 tracked path changes plus 49 directly supporting untracked files relative to the baseline.
Each freeze→stale cycle reran the complete gate (workspace tests, typecheck, skill scripts,
production build, high-severity audit, migration/schema application to SQLite `:memory:` with
`PRAGMA foreign_key_check`, `git diff --check`, and a no-content credential-marker scan — all
clear on every rerun).

## Confirmed Defects Found And Repaired During The Review

- **Codex profile-cursor data loss** (2026-07-27): a single profile moving between `CODEX_HOME`s
  with a colliding relative session path could replace an unacknowledged legacy snapshot and lose
  its usage. Fixed with an irreversible SHA-256 profile marker and an explicit migration path;
  regression reproduces the lost `15 + 25` token case.
- **Notifier drain-file loss** (2026-07-28): a failed read of the atomically renamed drain file
  deleted the file and lost deferred hook work. Fixed by preserving unreadable drain files and
  deleting only after a successful read.
- **Recovery-journal crash window** (2026-07-30): `drainSignalSources()` created and removed the
  recovery journal before `executeSync()`; a kill in between lost the queued source. Fixed with
  bounded per-source version-2 journals acknowledged only after sync success.
- **Antigravity first-bounded-scan partial persist** (2026-07-30): a bounded scan could persist a
  partial daily-model aggregate before all databases were read. Fixed with a `completeDirectoryScan`
  gate: no cursor write until a full-history baseline exists; `--since all` required before it.
- **Codex session-tail short read** (2026-09-05): `hashOpenFileTail` could accept an early EOF.
  Now reads until the complete bounded tail is filled and fails closed.
- Earlier T09-driven repairs: unambiguous `TOKENBOARD_CODEX_HOMES_JSON` for comma-containing
  homes, root-only symlink resolution with nested-symlink rejection, and a foreign-key-aware seed
  cleanup fixture under immediate and deferred enforcement.

Checked and not reproducible: Windows command injection via CLI timezones (`assertValidTimeZone`)
and command shims (shell metacharacters rejected before `.cmd`/`.bat` execution).

## Final Verification (2026-09-05 Revalidation)

- `pnpm test`: passed with usage-core `13/13`, Web `687/687`, and collector `935` passing with `3`
  existing platform scenarios skipped.
- `pnpm typecheck`, `pnpm build`, `node --test skills/tokenboard/scripts/*.test.mjs` (`528/528`),
  `pnpm audit --audit-level=high`, and `git diff --check HEAD` all passed.
- CodeRabbit `0.7.6` returned complete reviews with `findings: 0` for collector, Web, usage-core,
  skill and docs scopes; no CodeRabbit result substitutes for real client/host/Cloudflare checks.
- The Web test loader emits a non-fatal Node `module.register()` deprecation warning from the
  Vite/Tailwind toolchain; documented, not a gate failure.

## Boundary

This is local static and regression evidence only. It does not prove a deployed Worker, a D1
migration, authenticated-page rendering, or real collector ingestion; those remain the T07, T09,
and T10 gates (see the private Cloudflare deployment records in this directory).
