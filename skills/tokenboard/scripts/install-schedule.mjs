#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConfig } from './config.mjs'
import { buildLinuxSystemdUnits, buildWindowsTaskArgs, serviceName, timerName } from './schedule.mjs'

const scriptPath = fileURLToPath(new URL('./sync.mjs', import.meta.url))

if (platform() === 'win32') {
  const result = spawnSync(
    'schtasks.exe',
    buildWindowsTaskArgs({ nodePath: process.execPath, scriptPath }),
    { stdio: 'inherit' }
  )
  process.exit(result.status ?? 1)
}

if (platform() === 'linux') {
  const systemctl = spawnSync('systemctl', ['--user', '--version'], { stdio: 'ignore' })
  if (systemctl.status !== 0) {
    console.error('User systemd is not available. Install a daily cron entry manually:')
    console.error(`"${process.execPath}" "${scriptPath}" --mode sync --source all`)
    process.exit(1)
  }

  const config = readConfig()
  const unitDir = join(homedir(), '.config', 'systemd', 'user')
  mkdirSync(unitDir, { recursive: true })
  const units = buildLinuxSystemdUnits({
    nodePath: process.execPath,
    scriptPath,
    packageManager: config.packageManager || process.env.TOKENBOARD_PACKAGE_MANAGER || 'pnpm',
    pathEnv: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    homeDir: homedir()
  })
  writeFileSync(join(unitDir, serviceName), units.service)
  writeFileSync(join(unitDir, timerName), units.timer)

  for (const args of [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', '--now', timerName]
  ]) {
    const result = spawnSync('systemctl', args, { stdio: 'inherit' })
    if (result.status !== 0) process.exit(result.status ?? 1)
  }

  const linger = spawnSync('loginctl', ['enable-linger', process.env.USER || ''], { stdio: 'ignore' })
  if (linger.status !== 0 && !existsSync('/run/systemd/userdb')) {
    console.log('TokenBoard timer installed. Linger was not enabled; the timer runs while the user session is active.')
  } else {
    console.log('TokenBoard timer installed.')
  }
  process.exit(0)
}

console.log('Automatic schedule was not installed on this OS yet.')
console.log(`Run daily: "${process.execPath}" "${scriptPath}" --mode sync --source all`)
