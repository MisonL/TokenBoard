import { existsSync } from 'node:fs'
import type { UsageSource } from '@tokenboard/usage-core'
import { ccusageToolCommandNames } from '@tokenboard/usage-core'
import { runJsonCommand, type CommandRunner } from '../command'
import { normalizeCcusageDailyJson } from '../normalize-ccusage'
import { ccusagePackageSpecifier, resolvePackageRunner, type PackageRunner } from '../package-runner'
import { assertValidDateFilterRange } from '../iso-calendar-date'
import type { CollectUsageOptions } from './claude-code'

const DEFAULT_CCUSAGE_TIMEOUT_MS = 900_000
const DEFAULT_PACKAGE_COMMAND_RETRIES = 2

/**
 * Shared collector for the ccusage tool family. Every tool in this family exposes the
 * same `<tool> daily --json` and `<tool> session --json` subcommands with the same
 * report shape, so one parameterised implementation replaces twelve bespoke parsers.
 * Session rows without a usable date (Amp does not carry one) are dropped by the
 * session attribution and leave `sessionCount` at zero; tokens and cost always come
 * from the daily report.
 */
export async function collectCcusageToolUsage(
  source: Exclude<UsageSource, 'claude-code' | 'codex'>,
  options: CollectCcusageToolOptions = {}
) {
  const commandName = ccusageToolCommandNames[source as keyof typeof ccusageToolCommandNames]
  if (!commandName) {
    throw new Error(`${source} is not a ccusage tool source`)
  }
  const runner = options.runner ?? runJsonCommand
  const packageRunner =
    options.packageRunner ??
    resolvePackageRunner(
      options.env?.TOKENBOARD_PACKAGE_MANAGER,
      process.platform,
      existsSync,
      options.env ?? process.env
    )
  const rangeArgs = buildRangeArgs(options)
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const commandOptions = {
    env: options.env ?? process.env,
    timeoutMs: readCcusageTimeoutMs(options.env ?? process.env),
    retries: readPackageCommandRetries(options.env ?? process.env),
    ...(options.stderr ? { onRetry: options.stderr } : {})
  }
  const daily = await runner(
    packageRunner.command,
    packageRunner.runPackageArgs(ccusagePackageSpecifier, 'ccusage', [
      commandName,
      'daily',
      '--json',
      ...rangeArgs,
      '--timezone',
      timezone
    ]),
    commandOptions
  )
  // ccusage exits 0 with an empty report for a tool that is not installed, so most
  // machines would pay a second spawn per run for nothing. Session counts only
  // matter when there is usage to attribute, so an empty daily report ends here.
  if (!hasDailyRows(daily)) {
    return []
  }
  const sessions = await runner(
    packageRunner.command,
    packageRunner.runPackageArgs(ccusagePackageSpecifier, 'ccusage', [
      commandName,
      'session',
      '--json',
      ...rangeArgs,
      '--timezone',
      timezone
    ]),
    commandOptions
  )

  return normalizeCcusageDailyJson(daily, {
    source,
    timezone,
    collectedAt: options.collectedAt,
    sessions
  })
}

export type CollectCcusageToolOptions = Omit<CollectUsageOptions, 'runner'> & {
  runner?: CommandRunner
  packageRunner?: PackageRunner
}

function buildRangeArgs(options: { since?: string; until?: string }) {
  const range = assertValidDateFilterRange({
    ...options,
    sinceField: 'ccusage tool since date',
    untilField: 'ccusage tool until date'
  })
  const args: string[] = []
  if (range.since) args.push('--since', range.since)
  if (range.until) args.push('--until', range.until)
  return args
}

function readCcusageTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  const value = Number.parseInt(env.TOKENBOARD_CCUSAGE_TIMEOUT_MS || '', 10)
  if (Number.isFinite(value) && value > 0) {
    return value
  }
  return DEFAULT_CCUSAGE_TIMEOUT_MS
}

function readPackageCommandRetries(env: NodeJS.ProcessEnv = process.env) {
  const value = Number.parseInt(env.TOKENBOARD_PACKAGE_COMMAND_RETRIES || '', 10)
  if (Number.isFinite(value) && value >= 0) {
    return value
  }
  return DEFAULT_PACKAGE_COMMAND_RETRIES
}

function hasDailyRows(daily: unknown) {
  if (!daily || typeof daily !== 'object') return false
  const rows = (daily as { daily?: unknown }).daily
  return Array.isArray(rows) && rows.length > 0
}
