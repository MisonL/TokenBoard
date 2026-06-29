#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectorDir as defaultCollectorDir,
  configDir as defaultConfigDir,
  mergeConfig,
  parseArgs,
  readConfig,
  readPackageManager
} from './config.mjs'
import { runArchiveFallback } from './upgrade-archive.mjs'
import { corepackCommand, errorMessage, joinForPlatform, runStep, samePath } from './upgrade-utils.mjs'

export const defaultRepoUrl = 'https://github.com/evepupil/TokenBoard.git'

export function buildUpgradePlan({
  collectorDir,
  skillDir,
  configDir,
  repoUrl,
  repoRef,
  packageManager,
  collectorExists,
  collectorIsGitRepo = collectorExists,
  workDir,
  platform = process.platform
}) {
  if (configDir && samePath(skillDir, configDir)) {
    throw new Error(`Refusing to replace TokenBoard config directory as skill install: ${skillDir}`)
  }

  const replacementDir = workDir ? joinForPlatform(workDir, 'TokenBoard') : null
  const steps = collectorExists && collectorIsGitRepo
    ? [
        { command: 'git', args: ['remote', 'set-url', 'origin', repoUrl], options: { cwd: collectorDir } },
        ...(repoRef ? [{ command: 'git', args: ['fetch', 'origin', repoRef], options: { cwd: collectorDir } }] : []),
        ...(repoRef ? [{ command: 'git', args: ['checkout', '-B', repoRef, `origin/${repoRef}`], options: { cwd: collectorDir } }] : []),
        { command: 'git', args: ['pull', '--ff-only'], options: { cwd: collectorDir } }
      ]
    : collectorExists
      ? replacementDir
        ? [
            { command: 'remove', args: [workDir], options: { recursive: true, force: true } },
            { command: 'git', args: buildCloneArgs({ repoUrl, repoRef, dir: replacementDir }), options: {} },
            { command: 'remove', args: [collectorDir], options: { recursive: true, force: true } },
            { command: 'copy', args: [replacementDir, collectorDir], options: { recursive: true, force: true } },
            { command: 'remove', args: [workDir], options: { recursive: true, force: true } }
          ]
        : [
            { command: 'remove', args: [collectorDir], options: { recursive: true, force: true } },
            { command: 'git', args: buildCloneArgs({ repoUrl, repoRef, dir: collectorDir }), options: {} }
          ]
      : [
          { command: 'git', args: buildCloneArgs({ repoUrl, repoRef, dir: collectorDir }), options: {} }
        ]

  const collectorSkillDir = joinForPlatform(collectorDir, 'skills', 'tokenboard', platform)
  if (!samePath(collectorSkillDir, skillDir)) {
    steps.push({
      command: 'copy',
      args: [collectorSkillDir, skillDir],
      options: { recursive: true, force: true }
    })
  }

  steps.push({
    command: corepackCommand(platform),
    args: ['pnpm', 'install', '--frozen-lockfile'],
    options: { cwd: collectorDir }
  })

  return steps
}

export function runUpgrade({
  flags = {},
  env = process.env,
  platform = process.platform,
  spawn = spawnSync,
  exists = existsSync,
  copy = cpSync,
  mkdir = mkdirSync,
  readDir = readdirSync,
  remove = rmSync,
  readConfigFile = readConfig,
  mergeConfigFile = mergeConfig,
  configDirectory = defaultConfigDir(),
  log = console.log
} = {}) {
  const config = readConfigFile()
  const repoUrl = resolveRepoUrl({ flags, env, config })
  const repoRef = resolveRepoRef({ flags, env, config })
  const packageManager = readPackageManager(flags, config)
  const collector = config.collectorDir || defaultCollectorDir()
  const skillDir = flags['skill-dir'] || env.TOKENBOARD_SKILL_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const collectorExists = exists(collector)
  const collectorIsGitRepo = exists(join(collector, '.git'))

  try {
    for (const step of buildUpgradePlan({
      collectorDir: collector,
      skillDir,
      configDir: configDirectory,
      repoUrl,
      repoRef,
      packageManager,
      collectorExists,
      collectorIsGitRepo,
      workDir: join(configDirectory, 'upgrade-work'),
      platform
    })) {
      runStep(step, { spawn, copy, remove, platform })
    }
  } catch (error) {
    if (collectorExists && collectorIsGitRepo) {
      throw error
    }
    log(`TokenBoard git upgrade failed, trying archive fallback: ${errorMessage(error)}`)
    runArchiveFallback({
      archiveUrl: resolveArchiveUrl({ flags, env, config, repoUrl, repoRef }),
      collectorDir: collector,
      skillDir,
      packageManager,
      workDir: join(configDirectory, 'upgrade-work'),
      platform,
      spawn,
      copy,
      mkdir,
      readDir,
      remove
    })
  }

  mergeConfigFile({
    collectorDir: collector,
    repoUrl,
    repoRef,
    packageManager,
    skillDir,
    upgradedAt: new Date().toISOString()
  })
  log(`TokenBoard upgraded from ${repoUrl}${repoRef ? `#${repoRef}` : ''}`)
  return { collectorDir: collector, skillDir, repoUrl, repoRef, packageManager }
}

export function resolveArchiveUrl({ flags = {}, env = process.env, config = {}, repoUrl = defaultRepoUrl, repoRef = null } = {}) {
  const explicit = flags['archive-url'] || env.TOKENBOARD_ARCHIVE_URL
  if (explicit) {
    return explicit
  }

  if (typeof config.repoUrl === 'string' && config.repoUrl.endsWith('.zip')) {
    return config.repoUrl
  }

  const github = /^https:\/\/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/.exec(repoUrl)
  if (github) {
    return `https://github.com/${github[1]}/${github[2]}/archive/refs/heads/${encodeURIComponent(repoRef || 'master')}.zip`
  }

  return 'https://github.com/evepupil/TokenBoard/archive/refs/heads/master.zip'
}

export function resolveRepoRef({ flags = {}, env = process.env, config = {} } = {}) {
  const explicit = flags['repo-ref'] || env.TOKENBOARD_REPO_REF
  if (explicit) return explicit
  return typeof config.repoRef === 'string' && config.repoRef.trim() ? config.repoRef : null
}

function buildCloneArgs({ repoUrl, repoRef, dir }) {
  return repoRef
    ? ['clone', '--depth', '1', '--branch', repoRef, repoUrl, dir]
    : ['clone', '--depth', '1', repoUrl, dir]
}

export function resolveRepoUrl({ flags = {}, env = process.env, config = {} } = {}) {
  const explicit = flags['repo-url'] || env.TOKENBOARD_REPO_URL
  if (explicit) {
    return explicit
  }

  if (isGitRepoUrl(config.repoUrl)) {
    return config.repoUrl
  }

  return defaultRepoUrl
}

function isGitRepoUrl(value) {
  return typeof value === 'string' && (
    value.endsWith('.git') ||
    value.startsWith('git@') ||
    value.startsWith('ssh://')
  )
}

function runCli() {
  try {
    runUpgrade({ flags: parseArgs(process.argv.slice(2)) })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli()
}
