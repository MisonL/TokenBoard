#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (isMain()) {
  const { command, args } = buildInvocation({
    packageManager: process.env.TOKENBOARD_PACKAGE_MANAGER || 'pnpm',
    platform: process.platform,
    passthroughArgs: process.argv.slice(2)
  })
  const spawnInvocation = buildSpawnInvocation({ command, args, platform: process.platform })

  const result = spawnSync(
    spawnInvocation.command,
    spawnInvocation.args,
    {
      cwd: packageDir,
      stdio: 'inherit',
      shell: spawnInvocation.shell
    }
  )

  if (result.error) {
    console.error(formatSpawnFailure(command, result.error))
  }

  process.exit(result.status ?? 1)
}

export function buildInvocation({
  packageManager = 'pnpm',
  platform = process.platform,
  passthroughArgs = []
} = {}) {
  const command = platform === 'win32' ? windowsCommand(packageManager) : packageManager
  const args =
    packageManager === 'npm'
      ? ['exec', '--', 'tsx', 'src/cli.ts', ...passthroughArgs]
      : packageManager === 'bun'
        ? ['x', 'tsx', 'src/cli.ts', ...passthroughArgs]
        : ['exec', 'tsx', 'src/cli.ts', ...passthroughArgs]

  return { command, args }
}

export function shouldUseShell(command, platform = process.platform) {
  return platform === 'win32' && command.toLowerCase().endsWith('.cmd')
}

export function buildSpawnInvocation({ command, args, platform = process.platform } = {}) {
  if (!shouldUseShell(command, platform)) {
    return { command, args, shell: false }
  }

  assertWindowsShellSafeInvocation(command, args, true)
  return {
    command: buildWindowsCommandLine(command, args),
    args: [],
    shell: true
  }
}

export function buildWindowsCommandLine(command, args) {
  assertWindowsShellSafeInvocation(command, args, true)
  return [command, ...args].map(quoteWindowsCommandArgument).join(' ')
}

export function assertWindowsShellSafeInvocation(command, args, shell) {
  if (!shell) return
  if (windowsShellMetacharacters.test(command)) {
    throw new Error('Refusing to pass shell metacharacters in a Windows command shim path')
  }
  const unsafeIndex = args.findIndex((arg) => windowsShellMetacharacters.test(arg))
  if (unsafeIndex >= 0) {
    throw new Error(`Refusing to pass shell metacharacters in Windows command argument ${unsafeIndex}`)
  }
}

export function formatSpawnFailure(command, error) {
  const commandLabel = safeCommandLabel(command)
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_]+$/.test(error.code)
    ? error.code
    : 'unknown'
  return `Failed to run TokenBoard collector command (${commandLabel}; error ${code})`
}

// Parentheses are valid in normal Windows paths. Keep rejecting operators,
// expansion markers, quotes, and line breaks that change cmd.exe parsing.
const windowsShellMetacharacters = /[&|<>^%!"\r\n]/

function quoteWindowsCommandArgument(value) {
  // Quotes and shell metacharacters are rejected before this function runs.
  // Double trailing backslashes so the closing quote remains a delimiter under
  // Windows argv parsing instead of being escaped by the final backslash.
  const text = String(value)
  const trailingBackslashes = text.match(/\\+$/)?.[0].length ?? 0
  return `"${text}${'\\'.repeat(trailingBackslashes)}"`
}

function safeCommandLabel(command) {
  const text = String(command)
  const basename = text.slice(Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1)
  return basename.replace(/[^A-Za-z0-9._-]/g, '_') || 'package-manager'
}

function windowsCommand(packageManager) {
  return packageManager === 'bun' ? 'bun.exe' : `${packageManager}.cmd`
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}
