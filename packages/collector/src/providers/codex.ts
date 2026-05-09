import type { UsageSnapshot } from '@tokenboard/usage-core'
import { runJsonCommand, type CommandRunner } from '../command'
import { normalizeCcusageDailyJson } from '../normalize-ccusage'
import { createCodexSessionScope } from './codex-session-scope'

export type CollectCodexUsageOptions = {
  timezone?: string
  collectedAt?: string
  codexHome?: string
  runner?: CommandRunner
}

export async function collectCodexUsage(
  options: CollectCodexUsageOptions = {}
): Promise<UsageSnapshot[]> {
  const runner = options.runner ?? runJsonCommand
  const since = process.env.TOKENBOARD_SINCE
  const until = process.env.TOKENBOARD_UNTIL
  const scope = await createCodexSessionScope({ codexHome: options.codexHome, since, until })

  try {
    const env = scope ? { ...process.env, CODEX_HOME: scope.codexHome } : process.env
    const rangeArgs = buildRangeArgs({ since, until })
    const [json, sessions] = await Promise.all([
      runner('npx', ['@ccusage/codex@latest', 'daily', '--json', ...rangeArgs], { env }),
      runner('npx', ['@ccusage/codex@latest', 'session', '--json', ...rangeArgs], { env })
    ])

    return normalizeCcusageDailyJson(json, {
      source: 'codex',
      timezone: options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      collectedAt: options.collectedAt,
      sessions
    })
  } finally {
    await scope?.cleanup()
  }
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
