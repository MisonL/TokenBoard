import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runJsonCommand, type CommandRunner } from '../command'
import { normalizeCcusageDailyJson } from '../normalize-ccusage'
import { resolvePackageRunner } from '../package-runner'

export type CollectUsageOptions = {
  timezone?: string
  collectedAt?: string
  runner?: CommandRunner
}

export async function collectClaudeCodeUsage(
  options: CollectUsageOptions = {}
): Promise<UsageSnapshot[]> {
  const runner = options.runner ?? runJsonCommand
  const packageRunner = resolvePackageRunner()
  const rangeArgs = buildRangeArgs({
    since: process.env.TOKENBOARD_SINCE || process.env.TOKENBOARD_DEFAULT_SINCE || '',
    until: process.env.TOKENBOARD_UNTIL || ''
  })
  const json = await runner(
    packageRunner.command,
    packageRunner.runPackageArgs('ccusage@latest', 'ccusage', ['daily', '--json', '--breakdown', ...rangeArgs])
  )
  const sessions = await runner(
    packageRunner.command,
    packageRunner.runPackageArgs('ccusage@latest', 'ccusage', ['session', '--json', ...rangeArgs])
  )

  return normalizeCcusageDailyJson(json, {
    source: 'claude-code',
    timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    collectedAt: options.collectedAt,
    sessions
  })
}

function buildRangeArgs(options: { since?: string; until?: string }) {
  const args: string[] = []
  if (options.since && options.since !== 'all') {
    args.push('--since', options.since)
  }
  if (options.until) {
    args.push('--until', options.until)
  }
  return args
}
