---
name: tokenboard
description: Install and manage TokenBoard AI token usage collection for Claude Code and Codex. Use when the user asks to install TokenBoard, connect TokenBoard, bind a TokenBoard pairing code, sync AI token usage, preview usage, check TokenBoard status, or set up daily token statistics.
---

# TokenBoard

Use the bundled scripts to install TokenBoard collection on the user's machine. Never print upload tokens. Never upload prompts, completions, file contents, or raw conversation logs.

## Install

When the user provides a pairing code, run:

```bash
node scripts/setup.mjs --pairing-code <pairing-code>
```

Optional flags:

```bash
--base-url https://tokenboard.chaosyn.com
--timezone Asia/Shanghai
--device-name "Codex Desktop"
--skip-collector
--skip-schedule
--skip-initial-sync
--package-manager pnpm|bun|npm
--schedule-times 09:00,12:00,18:00,23:00
```

After setup, report whether config was written, schedule was installed, and initial sync succeeded. Do not show `uploadToken`.

The setup script clones or updates `https://github.com/evepupil/TokenBoard.git` into `~/.tokenboard/TokenBoard`, runs `pnpm install` by default, writes local config, installs the daily schedule unless skipped, and runs an initial sync using the configured package manager unless skipped. The default schedule is `09:00,12:00,18:00,23:00`; use `--schedule-times` only after confirming a custom 24-hour `HH:MM` comma-separated list with the user. Use `--repo-url`, `TOKENBOARD_REPO_URL`, `--package-manager bun`, `--package-manager npm`, or `TOKENBOARD_PACKAGE_MANAGER=pnpm|bun|npm` only when the local environment requires a non-default collector source or package manager.

If the user pasted a TokenBoard install prompt from the website, follow the prompt and run the included setup command. Treat pairing codes as short-lived secrets and do not repeat them unless needed to execute setup.

## Sync

Preview without upload:

```bash
node scripts/sync.mjs --mode preview --source all
```

Upload:

```bash
node scripts/sync.mjs --mode sync --source all
```

Optional package manager selection:

```bash
node scripts/sync.mjs --mode sync --source all --package-manager bun
TOKENBOARD_PACKAGE_MANAGER=npm node scripts/sync.mjs --mode preview --source all
```

## Status

Check local config and schedule hint:

```bash
node scripts/status.mjs
```

## Uninstall

Remove the local daily schedule without deleting config, upload token, logs, or the collector checkout:

```bash
node scripts/uninstall.mjs
```

Explicit cleanup options:

```bash
node scripts/uninstall.mjs --remove-collector
node scripts/uninstall.mjs --remove-config
node scripts/uninstall.mjs --remove-config-dir
node scripts/uninstall.mjs --all
```

## Troubleshooting

- If Node is missing, ask the user to install Node.js 20 or newer.
- If the collector cannot reach `https://tokenboard.chaosyn.com`, ask the user to configure proxy environment variables or verify the TokenBoard custom domain.
- If pairing fails, ask the user to generate a new pairing code from TokenBoard.
