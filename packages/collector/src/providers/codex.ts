import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runJsonCommand, type CommandRunner } from '../command'
import { normalizeCcusageDailyJson } from '../normalize-ccusage'
import { resolvePackageRunner } from '../package-runner'

export type CollectCodexUsageOptions = {
  timezone?: string
  collectedAt?: string
  runner?: CommandRunner
  stderr?: (line: string) => void
}

const DEFAULT_SESSION_TIMEOUT_MS = 60_000

export async function collectCodexUsage(
  options: CollectCodexUsageOptions = {}
): Promise<UsageSnapshot[]> {
  const runner = options.runner ?? runJsonCommand
  const packageRunner = resolvePackageRunner()
  const sinceArgs = buildSinceArgs()
  const json = await runner(
    packageRunner.command,
    packageRunner.runPackageArgs('@ccusage/codex@latest', 'ccusage-codex', ['daily', '--json', ...sinceArgs])
  )
  const sessions = await collectSessionCounts({
    runner,
    command: packageRunner.command,
    args: packageRunner.runPackageArgs('@ccusage/codex@latest', 'ccusage-codex', ['session', '--json', ...sinceArgs]),
    stderr: options.stderr
  })

  return normalizeCcusageDailyJson(json, {
    source: 'codex',
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    collectedAt: options.collectedAt,
    sessions
  })
}

async function collectSessionCounts({
  runner,
  command,
  args,
  stderr = console.error
}: {
  runner: CommandRunner
  command: string
  args: string[]
  stderr?: (line: string) => void
}) {
  try {
    return await runner(
      command,
      args,
      { timeoutMs: readSessionTimeoutMs() }
    )
  } catch (error) {
    stderr(`Skipping codex session counts: ${errorMessage(error)}`)
    return { data: [] }
  }
}

function readSessionTimeoutMs() {
  const value = Number.parseInt(process.env.TOKENBOARD_CODEX_SESSION_TIMEOUT_MS || '', 10)
  if (Number.isFinite(value) && value > 0) {
    return value
  }
  return DEFAULT_SESSION_TIMEOUT_MS
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function buildSinceArgs() {
  const since = process.env.TOKENBOARD_SINCE || process.env.TOKENBOARD_DEFAULT_SINCE || ''
  if (!since || since === 'all') {
    return []
  }

  return ['--since', since]
}
