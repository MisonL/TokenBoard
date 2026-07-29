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
import {
  buildCloneSteps,
  buildDefaultBranchPullSteps,
  buildFetchAndCheckoutRefSteps,
  corepackCommand,
  errorMessage,
  joinForPlatform,
  runStep,
  samePath
} from './upgrade-utils.mjs'

export const defaultRepoUrl = 'https://github.com/evepupil/TokenBoard.git'

export function buildUpgradePlan({
  collectorDir,
  skillDir,
  configDir,
  repoUrl,
  repoRef,
  collectorExists,
  collectorIsGitRepo = collectorExists,
  workDir,
  platform = process.platform
}) {
  if (configDir && samePath(skillDir, configDir)) {
    throw new Error(`Refusing to replace TokenBoard config directory as skill install: ${skillDir}`)
  }
  if (collectorExists && !collectorIsGitRepo && configDir && samePath(collectorDir, configDir)) {
    throw new Error(`Refusing to replace TokenBoard config directory as collector checkout: ${collectorDir}`)
  }

  const replacementDir = workDir ? joinForPlatform(workDir, 'TokenBoard') : null
  const steps = collectorExists && collectorIsGitRepo
    ? [
        { command: 'git', args: ['remote', 'set-url', 'origin', repoUrl], options: { cwd: collectorDir } },
        ...buildFetchAndCheckoutRefSteps({ dir: collectorDir, repoRef }),
        ...(repoRef ? [] : buildDefaultBranchPullSteps({ dir: collectorDir }))
      ]
    : collectorExists
      ? replacementDir
        ? [
            { command: 'remove', args: [workDir], options: { recursive: true, force: true } },
            ...buildCloneSteps({ repoUrl, repoRef, dir: replacementDir }),
            { command: 'remove', args: [collectorDir], options: { recursive: true, force: true } },
            { command: 'copy', args: [replacementDir, collectorDir], options: { recursive: true, force: true } },
            { command: 'remove', args: [workDir], options: { recursive: true, force: true } }
          ]
        : [
            { command: 'remove', args: [collectorDir], options: { recursive: true, force: true } },
            ...buildCloneSteps({ repoUrl, repoRef, dir: collectorDir })
          ]
      : [
          ...buildCloneSteps({ repoUrl, repoRef, dir: collectorDir })
        ]

  const collectorSkillDir = joinForPlatform(collectorDir, 'skills', 'tokenboard')
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
  nodePath = process.execPath,
  automatic = false,
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

  if (collectorExists && collectorIsGitRepo) {
    assertCleanGitWorktree({ collectorDir: collector, spawn })
    if (automatic) {
      assertAutomaticUpgradeBranch({
        collectorDir: collector,
        repoRef,
        spawn
      })
    }
  }

  try {
    for (const step of buildUpgradePlan({
      collectorDir: collector,
      skillDir,
      configDir: configDirectory,
      repoUrl,
      repoRef,
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
      archiveUrls: resolveArchiveUrls({ flags, env, config, repoUrl, repoRef }),
      collectorDir: collector,
      configDir: configDirectory,
      skillDir,
      workDir: join(configDirectory, 'upgrade-work'),
      platform,
      spawn,
      copy,
      mkdir,
      readDir,
      remove
    })
  }

  refreshInstalledNotifyHandler({
    collectorDir: collector,
    configDirectory,
    env,
    nodePath,
    spawn
  })

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

export function refreshInstalledNotifyHandler({
  collectorDir,
  configDirectory,
  env = process.env,
  nodePath = process.execPath,
  spawn = spawnSync
} = {}) {
  const scriptPath = joinForPlatform(
    joinForPlatform(collectorDir, 'skills', 'tokenboard'),
    'scripts',
    'refresh-notify-handler.mjs'
  )
  const result = spawn(nodePath, [scriptPath], {
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    env: {
      ...env,
      TOKENBOARD_CONFIG_DIR: configDirectory
    }
  })
  if (result.error) {
    throw new Error(`TokenBoard notify handler refresh failed: ${errorMessage(result.error)}`)
  }
  if (result.status !== 0) {
    throw new Error(`TokenBoard notify handler refresh failed with exit code ${result.status ?? 1}`)
  }
  return { scriptPath }
}

export function assertCleanGitWorktree({ collectorDir, spawn = spawnSync }) {
  const result = spawn('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: collectorDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: false
  })
  if (result.status !== 0) {
    throw new Error('Unable to inspect the TokenBoard collector worktree before upgrade')
  }
  if (String(result.stdout ?? '').trim()) {
    throw new Error('Refusing to upgrade a collector checkout with uncommitted changes')
  }
}

export function assertAutomaticUpgradeBranch({ collectorDir, repoRef, spawn = spawnSync }) {
  const currentBranch = readGitBranch({ collectorDir, spawn })
  if (!currentBranch) {
    throw new Error(
      'Refusing automatic TokenBoard upgrade from a detached HEAD. ' +
      'Run upgrade.mjs manually after switching the checkout to the intended branch.'
    )
  }

  const targetBranch = resolveAutomaticUpgradeBranch({ collectorDir, repoRef, spawn })
  if (!targetBranch) {
    throw new Error(
      `Refusing automatic TokenBoard upgrade from branch ${currentBranch}: the configured ref is not a branch. ` +
      'Run upgrade.mjs manually after switching the checkout to the intended ref.'
    )
  }
  if (currentBranch !== targetBranch) {
    throw new Error(
      `Refusing automatic TokenBoard upgrade from branch ${currentBranch} to ${targetBranch}. ` +
      'Run upgrade.mjs manually after switching the checkout to the intended branch.'
    )
  }
}

function resolveAutomaticUpgradeBranch({ collectorDir, repoRef, spawn }) {
  const explicitRef = trimmedString(repoRef)
  if (explicitRef) {
    if (explicitRef.startsWith('refs/heads/')) {
      return explicitRef.slice('refs/heads/'.length)
    }
    return explicitRef.startsWith('refs/') ? '' : explicitRef
  }

  const result = spawn('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: collectorDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: false
  })
  if (result.status !== 0) return ''
  const remoteHead = String(result.stdout ?? '').trim()
  return remoteHead.startsWith('origin/') ? remoteHead.slice('origin/'.length) : ''
}

function readGitBranch({ collectorDir, spawn }) {
  const result = spawn('git', ['branch', '--show-current'], {
    cwd: collectorDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: false
  })
  if (result.status !== 0) {
    throw new Error('Unable to inspect the TokenBoard collector branch before automatic upgrade')
  }
  return String(result.stdout ?? '').trim()
}

export function resolveArchiveUrls({ flags = {}, env = process.env, config = {}, repoUrl = defaultRepoUrl, repoRef = null } = {}) {
  const explicit = trimmedString(flags['archive-url'] || env.TOKENBOARD_ARCHIVE_URL)
  if (explicit) {
    return [explicit]
  }

  const configuredRepoUrl = trimmedString(config.repoUrl)
  if (configuredRepoUrl.endsWith('.zip')) {
    return [configuredRepoUrl]
  }

  const github = parseGitHubRepoUrl(repoUrl)
  if (github) {
    return buildArchiveRefPaths(repoRef)
      .map((refPath) => `https://github.com/${github[1]}/${github[2]}/archive/${refPath}.zip`)
  }

  throw new Error(`Archive fallback requires a GitHub repo URL or explicit archive URL: ${repoUrl}`)
}

export function resolveArchiveUrl({ flags = {}, env = process.env, config = {}, repoUrl = defaultRepoUrl, repoRef = null } = {}) {
  return resolveArchiveUrls({ flags, env, config, repoUrl, repoRef })[0]
}

export function resolveRepoRef({ flags = {}, env = process.env, config = {} } = {}) {
  const explicit = flags['repo-ref'] || env.TOKENBOARD_REPO_REF
  if (explicit) return explicit
  return typeof config.repoRef === 'string' && config.repoRef.trim() ? config.repoRef : null
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
  const url = trimmedString(value)
  return !!url && !url.endsWith('.zip') && (
    url.endsWith('.git') ||
    url.startsWith('git@') ||
    url.startsWith('ssh://') ||
    /^https?:\/\//.test(url)
  )
}

function parseGitHubRepoUrl(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(trimmed) ||
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(trimmed) ||
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(trimmed)
}

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function buildArchiveRefPaths(repoRef) {
  const ref = typeof repoRef === 'string' && repoRef.trim() ? repoRef.trim() : 'master'
  if (ref.startsWith('refs/heads/')) {
    return [`refs/heads/${encodeURIComponent(ref.slice('refs/heads/'.length))}`]
  }
  if (ref.startsWith('refs/tags/')) {
    return [`refs/tags/${encodeURIComponent(ref.slice('refs/tags/'.length))}`]
  }
  return [
    `refs/heads/${encodeURIComponent(ref)}`,
    encodeURIComponent(ref)
  ]
}

function runCli() {
  try {
    runUpgrade({ flags: parseArgs(process.argv.slice(2)) })
  } catch (error) {
    console.error(errorMessage(error))
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli()
}
