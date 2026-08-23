import { join } from 'node:path'
import {
  corepackCommand,
  escapePowerShellSingleQuoted,
  joinForPlatform,
  runStep,
  samePath
} from './upgrade-utils.mjs'

export function runArchiveFallback({
  archiveUrl,
  archiveUrls,
  collectorDir,
  configDir,
  skillDir,
  workDir,
  platform,
  spawn,
  copy,
  mkdir,
  readDir,
  remove
}) {
  if (configDir && samePath(skillDir, configDir, platform)) {
    throw new Error(`Refusing to replace TokenBoard config directory as skill install: ${skillDir}`)
  }
  if (configDir && samePath(collectorDir, configDir, platform)) {
    throw new Error(`Refusing to replace TokenBoard config directory as collector checkout: ${collectorDir}`)
  }

  const urls = normalizeArchiveUrls({ archiveUrl, archiveUrls })
  const zipPath = join(workDir, 'tokenboard.zip')
  const extractDir = join(workDir, 'extract')
  remove(workDir, { recursive: true, force: true })
  mkdir(workDir, { recursive: true })
  downloadArchive({ archiveUrls: urls, zipPath, platform, spawn })
  extractArchive({ zipPath, extractDir, platform, spawn, mkdir })
  const extractedRoot = findExtractedRoot({ extractDir, readDir })
  remove(collectorDir, { recursive: true, force: true })
  copy(extractedRoot, collectorDir, { recursive: true, force: true })
  const collectorSkillDir = joinForPlatform(collectorDir, 'skills', 'tokenboard')
  if (!samePath(collectorSkillDir, skillDir, platform)) {
    copy(collectorSkillDir, skillDir, { recursive: true, force: true })
  }
  runStep({
    command: corepackCommand(platform),
    args: ['pnpm', 'install', '--frozen-lockfile'],
    options: { cwd: collectorDir }
  }, { spawn, copy, remove, platform })
  remove(workDir, { recursive: true, force: true })
}

function normalizeArchiveUrls({ archiveUrl, archiveUrls }) {
  const urls = Array.isArray(archiveUrls) && archiveUrls.length > 0 ? archiveUrls : [archiveUrl]
  return urls
    .filter((url) => typeof url === 'string' && url.trim())
    .map((url) => url.trim())
}

function downloadArchive({ archiveUrls, zipPath, platform, spawn }) {
  const command = platform === 'win32' ? 'powershell.exe' : 'curl'
  let lastError
  for (const archiveUrl of archiveUrls) {
    const args = platform === 'win32'
      ? [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri '${escapePowerShellSingleQuoted(archiveUrl)}' -OutFile '${escapePowerShellSingleQuoted(zipPath)}'`
        ]
      : ['-fL', archiveUrl, '-o', zipPath]
    try {
      runExternal(command, args, { spawn, platform })
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('No TokenBoard archive URL candidates were provided')
}

function extractArchive({ zipPath, extractDir, platform, spawn, mkdir }) {
  mkdir(extractDir, { recursive: true })
  const command = platform === 'win32' ? 'powershell.exe' : 'unzip'
  const args = platform === 'win32'
    ? [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath '${escapePowerShellSingleQuoted(zipPath)}' -DestinationPath '${escapePowerShellSingleQuoted(extractDir)}' -Force`
      ]
    : ['-q', zipPath, '-d', extractDir]
  runExternal(command, args, { spawn, platform })
}

function runExternal(command, args, { spawn, platform }) {
  const result = spawn(command, args, {
    stdio: 'inherit',
    shell: platform === 'win32' && command.endsWith('.cmd')
  })
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status ?? 1}`)
  }
}

function findExtractedRoot({ extractDir, readDir }) {
  const entries = readDir(extractDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
  if (entries.length !== 1) {
    throw new Error(`Expected one extracted TokenBoard directory in ${extractDir}`)
  }
  return join(extractDir, entries[0].name)
}
