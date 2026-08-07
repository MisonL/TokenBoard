import { resolve, win32 as windowsPath } from 'node:path'
export { errorMessage } from './error-message.mjs'

export function runStep(step, runtime) {
  if (step.command === 'remove') {
    runtime.remove(step.args[0], step.options)
    return
  }

  if (step.command === 'copy') {
    runtime.copy(step.args[0], step.args[1], step.options)
    return
  }

  if (step.command === 'git-ensure-default-branch') {
    ensureDefaultBranch(step, runtime)
    return
  }

  if (step.command === 'git-fetch-branch-or-ref') {
    fetchBranchOrRef(step, runtime)
    return
  }

  const result = runtime.spawn(step.command, step.args, {
    stdio: 'inherit',
    shell: runtime.platform === 'win32' && step.command.endsWith('.cmd'),
    ...step.options
  })
  if (result.status !== 0) {
    throw new Error(`${step.command} failed with exit code ${result.status ?? 1}`)
  }
}

export function escapePowerShellSingleQuoted(value) {
  return String(value).replaceAll("'", "''")
}

export function samePath(leftPath, rightPath, platform = process.platform) {
  const pathApi = platform === 'win32' ? windowsPath : { resolve }
  const normalize = (value) => {
    const resolved = pathApi.resolve(String(value))
    return platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(leftPath) === normalize(rightPath)
}

export function corepackCommand(platform) {
  return platform === 'win32' ? 'corepack.cmd' : 'corepack'
}

export function buildCloneSteps({ repoUrl, repoRef, dir }) {
  if (!repoRef) {
    return [{ command: 'git', args: ['clone', '--depth', '1', repoUrl, dir], options: {} }]
  }

  return [
    { command: 'git', args: ['clone', '--depth', '1', '--no-checkout', repoUrl, dir], options: {} },
    ...buildFetchAndCheckoutRefSteps({ dir, repoRef })
  ]
}

export function buildFetchAndCheckoutRefSteps({ dir, repoRef }) {
  if (!repoRef) return []

  const normalizedRef = normalizeRepoRef(repoRef)
  if (normalizedRef.kind === 'branch') {
    return [
      { command: 'git', args: ['fetch', '--depth', '1', 'origin', `refs/heads/${normalizedRef.name}`], options: { cwd: dir } },
      { command: 'git', args: ['checkout', '-B', normalizedRef.name, 'FETCH_HEAD'], options: { cwd: dir } },
      { command: 'git', args: ['config', `branch.${normalizedRef.name}.remote`, 'origin'], options: { cwd: dir } },
      { command: 'git', args: ['config', `branch.${normalizedRef.name}.merge`, `refs/heads/${normalizedRef.name}`], options: { cwd: dir } }
    ]
  }

  if (normalizedRef.kind === 'branch-or-ref') {
    return [
      { command: 'git-fetch-branch-or-ref', args: [normalizedRef.name], options: { cwd: dir } }
    ]
  }

  return [
    { command: 'git', args: ['fetch', '--depth', '1', 'origin', normalizedRef.name], options: { cwd: dir } },
    { command: 'git', args: ['checkout', 'FETCH_HEAD'], options: { cwd: dir } }
  ]
}

export function buildDefaultBranchPullSteps({ dir }) {
  return [
    { command: 'git-ensure-default-branch', args: [], options: { cwd: dir } },
    { command: 'git', args: ['pull', '--ff-only'], options: { cwd: dir } }
  ]
}

function ensureDefaultBranch(step, runtime) {
  const defaultBranch = resolveOriginDefaultBranch(runtime, step.options)
  fetchOriginDefaultBranch(runtime, defaultBranch, step.options)
  runGit(runtime, ['remote', 'set-head', 'origin', '--auto'], step.options)

  const remoteBranch = runGitCapture(runtime, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], step.options).trim()
  if (!remoteBranch.startsWith('origin/')) {
    throw new Error(`Unable to resolve origin default branch: ${remoteBranch || '(empty)'}`)
  }

  const branchName = remoteBranch.slice('origin/'.length)
  const currentBranch = runGitCapture(runtime, ['branch', '--show-current'], step.options).trim()
  if (currentBranch !== branchName) {
    checkoutDefaultBranch(runtime, branchName, remoteBranch, step.options)
  }
  configureBranchTracking(runtime, branchName, step.options)
}

function resolveOriginDefaultBranch(runtime, options) {
  const output = runGitCapture(runtime, ['ls-remote', '--symref', 'origin', 'HEAD'], options)
  const headLine = output
    .split(/\r?\n/)
    .find((line) => line.startsWith('ref: refs/heads/') && line.endsWith('\tHEAD'))
  if (!headLine) {
    throw new Error('Unable to resolve origin default branch from remote HEAD')
  }

  return headLine.slice('ref: refs/heads/'.length, -'\tHEAD'.length)
}

function fetchOriginDefaultBranch(runtime, branchName, options) {
  runGit(runtime, ['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], options)
  runGit(runtime, ['fetch', 'origin', `+refs/heads/${branchName}:refs/remotes/origin/${branchName}`], options)
}

function checkoutDefaultBranch(runtime, branchName, remoteBranch, options) {
  const localBranch = runtime.spawn('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
    stdio: 'ignore',
    shell: false,
    ...options
  })
  if (localBranch.status === 0) {
    runGit(runtime, ['checkout', branchName], options)
    return
  }

  runGit(runtime, ['checkout', '-B', branchName, remoteBranch], options)
}

function fetchBranchOrRef(step, runtime) {
  const ref = String(step.args[0] ?? '')
  const branchFetch = runtime.spawn('git', ['fetch', '--depth', '1', 'origin', `refs/heads/${ref}`], {
    stdio: 'ignore',
    shell: false,
    ...step.options
  })
  if (branchFetch.status === 0) {
    runGit(runtime, ['checkout', '-B', ref, 'FETCH_HEAD'], step.options)
    configureBranchTracking(runtime, ref, step.options)
    return
  }

  runGit(runtime, ['fetch', '--depth', '1', 'origin', ref], step.options)
  runGit(runtime, ['checkout', 'FETCH_HEAD'], step.options)
}

function configureBranchTracking(runtime, branchName, options) {
  runGit(runtime, ['config', `branch.${branchName}.remote`, 'origin'], options)
  runGit(runtime, ['config', `branch.${branchName}.merge`, `refs/heads/${branchName}`], options)
}

function runGit(runtime, args, options) {
  const result = runtime.spawn('git', args, {
    stdio: 'inherit',
    shell: false,
    ...options
  })
  if (result.status !== 0) {
    throw new Error(`git failed with exit code ${result.status ?? 1}`)
  }
}

function runGitCapture(runtime, args, options) {
  const result = runtime.spawn('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: false,
    ...options
  })
  if (result.status !== 0) {
    throw new Error(`git failed with exit code ${result.status ?? 1}`)
  }
  return String(result.stdout ?? '')
}

function normalizeRepoRef(repoRef) {
  const ref = String(repoRef)
  if (ref.startsWith('refs/heads/')) return { kind: 'branch', name: ref.slice('refs/heads/'.length) }
  if (ref.startsWith('refs/')) return { kind: 'ref', name: ref }
  return { kind: 'branch-or-ref', name: ref }
}

export function joinForPlatform(base, first, second) {
  const separator = String(base).includes('\\') ? '\\' : '/'
  return [String(base).replace(/[\\/]$/, ''), first, second]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join(separator)
}
