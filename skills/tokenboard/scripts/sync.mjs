#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  readConfig,
  parseArgs,
  collectorDir,
  packageManagerCommand,
  packageManagerRunArgs,
  readPackageManager
} from './config.mjs'
import { normalizePathEnv } from './schedule.mjs'
import { readSince } from './sync-options.mjs'

const flags = parseArgs(process.argv.slice(2))
const config = readConfig()
const mode = flags.mode || 'sync'
const source = flags.source || config.source || 'all'
const repoDir = config.collectorDir || collectorDir()
const packageManager = readPackageManager(flags, config)
const since = readSince({ flags, config })

if (!existsSync(repoDir)) {
  console.error(`TokenBoard collector is not installed: ${repoDir}`)
  console.error('Run setup.mjs again or run install-collector.mjs.')
  process.exit(1)
}

const env = {
  ...process.env,
  PATH: normalizePathEnv({
    pathEnv: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    homeDir: homedir(),
    nodePath: process.execPath
  }),
  TOKENBOARD_ENDPOINT: config.endpoint,
  TOKENBOARD_UPLOAD_TOKEN: config.uploadToken,
  TOKENBOARD_TIMEZONE: config.timezone,
  TOKENBOARD_SOURCE: source,
  TOKENBOARD_PACKAGE_MANAGER: packageManager,
  TOKENBOARD_DEFAULT_SINCE: since
}

const result = spawnSync(
  packageManagerCommand(packageManager),
  packageManagerRunArgs(packageManager, mode, ['--source', source]),
  {
    cwd: join(repoDir, 'packages', 'collector'),
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32'
  }
)

if (result.error) {
  console.error(`Failed to run ${packageManagerCommand(packageManager)}: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
