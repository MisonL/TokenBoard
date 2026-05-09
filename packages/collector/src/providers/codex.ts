import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runJsonCommand, type CommandRunner } from '../command'
import { normalizeCcusageDailyJson } from '../normalize-ccusage'
import { resolvePackageRunner } from '../package-runner'

export type CollectCodexUsageOptions = {
  timezone?: string
  collectedAt?: string
  runner?: CommandRunner
}

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
  const sessions = await runner(
    packageRunner.command,
    packageRunner.runPackageArgs('@ccusage/codex@latest', 'ccusage-codex', ['session', '--json', ...sinceArgs])
  )

  return normalizeCcusageDailyJson(json, {
    source: 'codex',
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    collectedAt: options.collectedAt,
    sessions
  })
}

function buildSinceArgs() {
  const since = process.env.TOKENBOARD_SINCE || process.env.TOKENBOARD_DEFAULT_SINCE || ''
  if (!since || since === 'all') {
    return []
  }

  return ['--since', since]
}
