import assert from 'node:assert/strict'
import test from 'node:test'
import { buildUpgradePlan, resolveArchiveUrl, resolveArchiveUrls, resolveRepoUrl, runUpgrade } from './upgrade.mjs'
import { errorMessage, runStep } from './upgrade-utils.mjs'

test('normalizes empty error diagnostics', () => {
  assert.equal(errorMessage(new Error('')), 'Error')
  assert.equal(errorMessage(new Error('   ')), 'Error')
  assert.equal(errorMessage(''), 'Unknown error')
})

test('updates collector and installed skill from the collector checkout', () => {
  assert.deepEqual(
    buildUpgradePlan({
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      skillDir: '/home/user/.codex/skills/tokenboard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'pnpm',
      collectorExists: true,
      collectorIsGitRepo: true,
      skillExists: true,
      platform: 'linux'
    }),
    [
      {
        command: 'git',
        args: ['remote', 'set-url', 'origin', 'https://github.com/example/TokenBoard.git'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'git-ensure-default-branch',
        args: [],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'git',
        args: ['pull', '--ff-only'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'copy',
        args: ['/home/user/.tokenboard/TokenBoard/skills/tokenboard', '/home/user/.codex/skills/tokenboard'],
        options: { recursive: true, force: true }
      },
      {
        command: 'corepack',
        args: ['pnpm', 'install', '--frozen-lockfile'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      }
    ]
  )
})

test('does not copy the installed skill onto itself', () => {
  assert.deepEqual(
    buildUpgradePlan({
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      skillDir: '/home/user/.tokenboard/TokenBoard/skills/tokenboard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'pnpm',
      collectorExists: true,
      collectorIsGitRepo: true,
      platform: 'linux'
    }),
    [
      {
        command: 'git',
        args: ['remote', 'set-url', 'origin', 'https://github.com/example/TokenBoard.git'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'git-ensure-default-branch',
        args: [],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'git',
        args: ['pull', '--ff-only'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'corepack',
        args: ['pnpm', 'install', '--frozen-lockfile'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      }
    ]
  )
})

test('refreshes installed notifier handlers from the upgraded collector checkout', () => {
  const calls = []
  const collectorDir = '/home/user/.tokenboard/TokenBoard'
  const configDirectory = '/home/user/.tokenboard'

  runUpgrade({
    flags: {
      'repo-ref': 'feature/reliability',
      'skill-dir': `${collectorDir}/skills/tokenboard`
    },
    env: { TOKENBOARD_CONFIG_DIR: configDirectory },
    readConfigFile: () => ({
      collectorDir,
      repoUrl: 'https://github.com/example/TokenBoard.git',
      repoRef: 'feature/reliability',
      packageManager: 'pnpm'
    }),
    mergeConfigFile: () => {},
    configDirectory,
    exists: (path) => path === collectorDir || path === `${collectorDir}/.git`,
    spawn: (command, args, options) => {
      calls.push({ command, args, options })
      if (command === 'git' && args[0] === 'status') return { status: 0, stdout: '' }
      return { status: 0, stdout: '' }
    },
    log: () => {}
  })

  const refreshIndex = calls.findIndex((call) =>
    call.command === process.execPath &&
    call.args[0] === `${collectorDir}/skills/tokenboard/scripts/refresh-notify-handler.mjs`
  )
  const installIndex = calls.findIndex((call) =>
    call.command === 'corepack' && call.args[0] === 'pnpm'
  )

  assert.ok(refreshIndex > installIndex)
  assert.deepEqual(calls[refreshIndex].args, [
    `${collectorDir}/skills/tokenboard/scripts/refresh-notify-handler.mjs`
  ])
  assert.equal(calls[refreshIndex].options.env.TOKENBOARD_CONFIG_DIR, configDirectory)
})

test('fails visibly when the upgraded notifier handler refresh fails', () => {
  const collectorDir = '/home/user/.tokenboard/TokenBoard'

  assert.throws(
    () => runUpgrade({
      flags: {
        'repo-ref': 'feature/reliability',
        'skill-dir': `${collectorDir}/skills/tokenboard`
      },
      env: { TOKENBOARD_CONFIG_DIR: '/home/user/.tokenboard' },
      readConfigFile: () => ({
        collectorDir,
        repoUrl: 'https://github.com/example/TokenBoard.git',
        repoRef: 'feature/reliability',
        packageManager: 'pnpm'
      }),
      mergeConfigFile: () => {},
      configDirectory: '/home/user/.tokenboard',
      exists: (path) => path === collectorDir || path === `${collectorDir}/.git`,
      spawn: (command, args) => {
        if (command === 'git' && args[0] === 'status') return { status: 0, stdout: '' }
        if (command === process.execPath && args[0].endsWith('/refresh-notify-handler.mjs')) {
          return { status: 17 }
        }
        return { status: 0, stdout: '' }
      },
      log: () => {}
    }),
    /TokenBoard notify handler refresh failed with exit code 17/
  )
})

test('pins an existing collector checkout to a configured ref during upgrade', () => {
  assert.deepEqual(
    buildUpgradePlan({
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      skillDir: '/home/user/.tokenboard/TokenBoard/skills/tokenboard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      repoRef: 'research/agy-token-support-plan',
      packageManager: 'pnpm',
      collectorExists: true,
      collectorIsGitRepo: true,
      platform: 'linux'
    }),
    [
      {
        command: 'git',
        args: ['remote', 'set-url', 'origin', 'https://github.com/example/TokenBoard.git'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'git-fetch-branch-or-ref',
        args: ['research/agy-token-support-plan'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'corepack',
        args: ['pnpm', 'install', '--frozen-lockfile'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      }
    ]
  )
})

test('pins an existing collector checkout to a configured full ref detached during upgrade', () => {
  assert.deepEqual(
    buildUpgradePlan({
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      skillDir: '/home/user/.tokenboard/TokenBoard/skills/tokenboard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      repoRef: 'refs/tags/v1.2.3',
      packageManager: 'pnpm',
      collectorExists: true,
      collectorIsGitRepo: true,
      platform: 'linux'
    }),
    [
      {
        command: 'git',
        args: ['remote', 'set-url', 'origin', 'https://github.com/example/TokenBoard.git'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'git',
        args: ['fetch', '--depth', '1', 'origin', 'refs/tags/v1.2.3'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'git',
        args: ['checkout', 'FETCH_HEAD'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'corepack',
        args: ['pnpm', 'install', '--frozen-lockfile'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      }
    ]
  )
})

test('treats all-hex collector refs as branch candidates during upgrade', () => {
  assert.deepEqual(
    buildUpgradePlan({
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      skillDir: '/home/user/.tokenboard/TokenBoard/skills/tokenboard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      repoRef: 'deadbeef',
      packageManager: 'pnpm',
      collectorExists: true,
      collectorIsGitRepo: true,
      platform: 'linux'
    }),
    [
      {
        command: 'git',
        args: ['remote', 'set-url', 'origin', 'https://github.com/example/TokenBoard.git'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'git-fetch-branch-or-ref',
        args: ['deadbeef'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'corepack',
        args: ['pnpm', 'install', '--frozen-lockfile'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      }
    ]
  )
})

test('clones collector before installing skill when collector is missing', () => {
  assert.deepEqual(
    buildUpgradePlan({
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      skillDir: '/home/user/.codex/skills/tokenboard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'npm',
      collectorExists: false,
      collectorIsGitRepo: false,
      skillExists: false,
      platform: 'win32'
    }),
    [
      {
        command: 'git',
        args: ['clone', '--depth', '1', 'https://github.com/example/TokenBoard.git', '/home/user/.tokenboard/TokenBoard'],
        options: {}
      },
      {
        command: 'copy',
        args: ['/home/user/.tokenboard/TokenBoard/skills/tokenboard', '/home/user/.codex/skills/tokenboard'],
        options: { recursive: true, force: true }
      },
      {
        command: 'corepack.cmd',
        args: ['pnpm', 'install', '--frozen-lockfile'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      }
    ]
  )
})

test('clones a configured collector ref before installing skill when collector is missing', () => {
  assert.deepEqual(
    buildUpgradePlan({
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      skillDir: '/home/user/.codex/skills/tokenboard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      repoRef: 'research/agy-token-support-plan',
      packageManager: 'npm',
      collectorExists: false,
      collectorIsGitRepo: false,
      skillExists: false,
      platform: 'win32'
    }),
    [
      {
        command: 'git',
        args: ['clone', '--depth', '1', '--no-checkout', 'https://github.com/example/TokenBoard.git', '/home/user/.tokenboard/TokenBoard'],
        options: {}
      },
      {
        command: 'git-fetch-branch-or-ref',
        args: ['research/agy-token-support-plan'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      },
      {
        command: 'copy',
        args: ['/home/user/.tokenboard/TokenBoard/skills/tokenboard', '/home/user/.codex/skills/tokenboard'],
        options: { recursive: true, force: true }
      },
      {
        command: 'corepack.cmd',
        args: ['pnpm', 'install', '--frozen-lockfile'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      }
    ]
  )
})

test('does not archive-replace an existing git checkout after git upgrade fails', () => {
  const calls = []
  assert.throws(
    () => runUpgrade({
      flags: {},
      env: {
        TOKENBOARD_CONFIG_DIR: '/home/user/.tokenboard',
        TOKENBOARD_COLLECTOR_DIR: '/home/user/.tokenboard/TokenBoard'
      },
      readConfigFile: () => ({
        collectorDir: '/home/user/.tokenboard/TokenBoard',
        repoUrl: 'https://github.com/example/TokenBoard.git',
        packageManager: 'pnpm'
      }),
      mergeConfigFile: (...args) => calls.push({ command: 'mergeConfig', args }),
      configDirectory: '/home/user/.tokenboard',
      exists: (path) =>
        path === '/home/user/.tokenboard/TokenBoard' ||
        path === '/home/user/.tokenboard/TokenBoard/.git',
      spawn: (command, args) => {
        calls.push({ command, args })
        if (command === 'git' && args[0] === 'ls-remote') {
          return { status: 0, stdout: 'ref: refs/heads/master\tHEAD\nabc123\tHEAD\n' }
        }
        if (command === 'git' && args[0] === 'symbolic-ref') {
          return { status: 0, stdout: 'origin/master\n' }
        }
        if (command === 'git' && args[0] === 'branch') {
          return { status: 0, stdout: 'master\n' }
        }
        return { status: command === 'git' && args[0] === 'pull' ? 1 : 0 }
      },
      copy: (...args) => calls.push({ command: 'copy', args }),
      mkdir: (...args) => calls.push({ command: 'mkdir', args }),
      readDir: () => [],
      remove: (...args) => calls.push({ command: 'remove', args }),
      log: () => {}
    }),
    /git failed with exit code 1/
  )

  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['status', '--porcelain', '--untracked-files=all'],
      ['remote', 'set-url', 'origin', 'https://github.com/example/TokenBoard.git'],
      ['ls-remote', '--symref', 'origin', 'HEAD'],
      ['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      ['fetch', 'origin', '+refs/heads/master:refs/remotes/origin/master'],
      ['remote', 'set-head', 'origin', '--auto'],
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      ['branch', '--show-current'],
      ['config', 'branch.master.remote', 'origin'],
      ['config', 'branch.master.merge', 'refs/heads/master'],
      ['pull', '--ff-only']
    ]
  )
})

test('refuses to upgrade a dirty collector checkout before changing repository state', () => {
  const calls = []

  assert.throws(
    () => runUpgrade({
      flags: {},
      env: {},
      readConfigFile: () => ({
        collectorDir: '/home/user/.tokenboard/TokenBoard',
        repoUrl: 'https://github.com/example/TokenBoard.git',
        packageManager: 'pnpm'
      }),
      mergeConfigFile: (...args) => calls.push({ command: 'mergeConfig', args }),
      configDirectory: '/home/user/.tokenboard',
      exists: (path) => path === '/home/user/.tokenboard/TokenBoard' || path === '/home/user/.tokenboard/TokenBoard/.git',
      spawn: (command, args) => {
        calls.push({ command, args })
        if (command === 'git' && args[0] === 'status') {
          return { status: 0, stdout: ' M packages/collector/src/cli.ts\n' }
        }
        return { status: 0 }
      },
      log: () => {}
    }),
    /Refusing to upgrade a collector checkout with uncommitted changes/
  )

  assert.deepEqual(calls.map((call) => call.args), [
    ['status', '--porcelain', '--untracked-files=all']
  ])
})

test('refuses to upgrade when the collector worktree cannot be inspected', () => {
  const calls = []

  assert.throws(
    () => runUpgrade({
      flags: {},
      env: {},
      readConfigFile: () => ({
        collectorDir: '/home/user/.tokenboard/TokenBoard',
        repoUrl: 'https://github.com/example/TokenBoard.git',
        packageManager: 'pnpm'
      }),
      mergeConfigFile: (...args) => calls.push({ command: 'mergeConfig', args }),
      configDirectory: '/home/user/.tokenboard',
      exists: (path) => path === '/home/user/.tokenboard/TokenBoard' || path === '/home/user/.tokenboard/TokenBoard/.git',
      spawn: (command, args) => {
        calls.push({ command, args })
        return { status: 1 }
      },
      log: () => {}
    }),
    /Unable to inspect the TokenBoard collector worktree before upgrade/
  )

  assert.deepEqual(calls.map((call) => call.args), [
    ['status', '--porcelain', '--untracked-files=all']
  ])
})

test('default branch guard checks out origin default branch from detached head', () => {
  const calls = []
  runStep({
    command: 'git-ensure-default-branch',
    args: [],
    options: { cwd: '/home/user/.tokenboard/TokenBoard' }
  }, {
    platform: 'linux',
    spawn: (command, args, options) => {
      calls.push({ command, args, options })
      if (args[0] === 'ls-remote') return { status: 0, stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n' }
      if (args[0] === 'branch') return { status: 0, stdout: '' }
      if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'origin/main\n' }
      if (args[0] === 'show-ref') return { status: 1 }
      return { status: 0 }
    }
  })

  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['ls-remote', '--symref', 'origin', 'HEAD'],
      ['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      ['remote', 'set-head', 'origin', '--auto'],
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      ['branch', '--show-current'],
      ['show-ref', '--verify', '--quiet', 'refs/heads/main'],
      ['checkout', '-B', 'main', 'origin/main'],
      ['config', 'branch.main.remote', 'origin'],
      ['config', 'branch.main.merge', 'refs/heads/main']
    ]
  )
})

test('default branch guard switches off a pinned branch when repoRef is unset', () => {
  const calls = []
  runStep({
    command: 'git-ensure-default-branch',
    args: [],
    options: { cwd: '/home/user/.tokenboard/TokenBoard' }
  }, {
    platform: 'linux',
    spawn: (command, args, options) => {
      calls.push({ command, args, options })
      if (args[0] === 'ls-remote') return { status: 0, stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n' }
      if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'origin/main\n' }
      if (args[0] === 'branch') return { status: 0, stdout: 'feature/ref\n' }
      if (args[0] === 'show-ref') return { status: 0 }
      return { status: 0 }
    }
  })

  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['ls-remote', '--symref', 'origin', 'HEAD'],
      ['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      ['remote', 'set-head', 'origin', '--auto'],
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      ['branch', '--show-current'],
      ['show-ref', '--verify', '--quiet', 'refs/heads/main'],
      ['checkout', 'main'],
      ['config', 'branch.main.remote', 'origin'],
      ['config', 'branch.main.merge', 'refs/heads/main']
    ]
  )
})

test('default branch guard does not use stale single-branch fetch refspec before recovery', () => {
  const calls = []
  runStep({
    command: 'git-ensure-default-branch',
    args: [],
    options: { cwd: '/home/user/.tokenboard/TokenBoard' }
  }, {
    platform: 'linux',
    spawn: (command, args, options) => {
      calls.push({ command, args, options })
      if (args[0] === 'fetch' && args.length === 2) {
        return { status: 1 }
      }
      if (args[0] === 'ls-remote') return { status: 0, stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n' }
      if (args[0] === 'symbolic-ref') return { status: 0, stdout: 'origin/main\n' }
      if (args[0] === 'branch') return { status: 0, stdout: 'feature/deleted\n' }
      if (args[0] === 'show-ref') return { status: 1 }
      return { status: 0 }
    }
  })

  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['ls-remote', '--symref', 'origin', 'HEAD'],
      ['config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
      ['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
      ['remote', 'set-head', 'origin', '--auto'],
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      ['branch', '--show-current'],
      ['show-ref', '--verify', '--quiet', 'refs/heads/main'],
      ['checkout', '-B', 'main', 'origin/main'],
      ['config', 'branch.main.remote', 'origin'],
      ['config', 'branch.main.merge', 'refs/heads/main']
    ]
  )
})

test('short repo ref uses a tracking branch when the branch exists', () => {
  const calls = []
  runStep({
    command: 'git-fetch-branch-or-ref',
    args: ['research/agy-token-support-plan'],
    options: { cwd: '/home/user/.tokenboard/TokenBoard' }
  }, {
    platform: 'linux',
    spawn: (command, args, options) => {
      calls.push({ command, args, options })
      return { status: 0 }
    }
  })

  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['fetch', '--depth', '1', 'origin', 'refs/heads/research/agy-token-support-plan'],
      ['checkout', '-B', 'research/agy-token-support-plan', 'FETCH_HEAD'],
      ['config', 'branch.research/agy-token-support-plan.remote', 'origin'],
      ['config', 'branch.research/agy-token-support-plan.merge', 'refs/heads/research/agy-token-support-plan']
    ]
  )
})

test('all-hex repo ref uses a tracking branch when the branch exists', () => {
  const calls = []
  runStep({
    command: 'git-fetch-branch-or-ref',
    args: ['deadbeef'],
    options: { cwd: '/home/user/.tokenboard/TokenBoard' }
  }, {
    platform: 'linux',
    spawn: (command, args, options) => {
      calls.push({ command, args, options })
      return { status: 0 }
    }
  })

  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['fetch', '--depth', '1', 'origin', 'refs/heads/deadbeef'],
      ['checkout', '-B', 'deadbeef', 'FETCH_HEAD'],
      ['config', 'branch.deadbeef.remote', 'origin'],
      ['config', 'branch.deadbeef.merge', 'refs/heads/deadbeef']
    ]
  )
})

test('short repo ref falls back to detached checkout when only a tag exists', () => {
  const calls = []
  runStep({
    command: 'git-fetch-branch-or-ref',
    args: ['v1.2.3'],
    options: { cwd: '/home/user/.tokenboard/TokenBoard' }
  }, {
    platform: 'linux',
    spawn: (command, args, options) => {
      calls.push({ command, args, options })
      if (args[0] === 'fetch' && args[4] === 'refs/heads/v1.2.3') return { status: 1 }
      return { status: 0 }
    }
  })

  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ['fetch', '--depth', '1', 'origin', 'refs/heads/v1.2.3'],
      ['fetch', '--depth', '1', 'origin', 'v1.2.3'],
      ['checkout', 'FETCH_HEAD']
    ]
  )
})

test('prepares a replacement checkout before touching an existing non-git collector', () => {
  assert.deepEqual(
    buildUpgradePlan({
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      skillDir: '/home/user/.codex/skills/tokenboard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'pnpm',
      collectorExists: true,
      collectorIsGitRepo: false,
      workDir: '/home/user/.tokenboard/upgrade-work',
      platform: 'linux'
    }),
    [
      {
        command: 'remove',
        args: ['/home/user/.tokenboard/upgrade-work'],
        options: { recursive: true, force: true }
      },
      {
        command: 'git',
        args: ['clone', '--depth', '1', 'https://github.com/example/TokenBoard.git', '/home/user/.tokenboard/upgrade-work/TokenBoard'],
        options: {}
      },
      {
        command: 'remove',
        args: ['/home/user/.tokenboard/TokenBoard'],
        options: { recursive: true, force: true }
      },
      {
        command: 'copy',
        args: ['/home/user/.tokenboard/upgrade-work/TokenBoard', '/home/user/.tokenboard/TokenBoard'],
        options: { recursive: true, force: true }
      },
      {
        command: 'remove',
        args: ['/home/user/.tokenboard/upgrade-work'],
        options: { recursive: true, force: true }
      },
      {
        command: 'copy',
        args: ['/home/user/.tokenboard/TokenBoard/skills/tokenboard', '/home/user/.codex/skills/tokenboard'],
        options: { recursive: true, force: true }
      },
      {
        command: 'corepack',
        args: ['pnpm', 'install', '--frozen-lockfile'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      }
    ]
  )
})

test('prepares a replacement checkout at the configured ref before touching an existing non-git collector', () => {
  assert.deepEqual(
    buildUpgradePlan({
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      skillDir: '/home/user/.codex/skills/tokenboard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      repoRef: 'research/agy-token-support-plan',
      packageManager: 'pnpm',
      collectorExists: true,
      collectorIsGitRepo: false,
      workDir: '/home/user/.tokenboard/upgrade-work',
      platform: 'linux'
    }),
    [
      {
        command: 'remove',
        args: ['/home/user/.tokenboard/upgrade-work'],
        options: { recursive: true, force: true }
      },
      {
        command: 'git',
        args: ['clone', '--depth', '1', '--no-checkout', 'https://github.com/example/TokenBoard.git', '/home/user/.tokenboard/upgrade-work/TokenBoard'],
        options: {}
      },
      {
        command: 'git-fetch-branch-or-ref',
        args: ['research/agy-token-support-plan'],
        options: { cwd: '/home/user/.tokenboard/upgrade-work/TokenBoard' }
      },
      {
        command: 'remove',
        args: ['/home/user/.tokenboard/TokenBoard'],
        options: { recursive: true, force: true }
      },
      {
        command: 'copy',
        args: ['/home/user/.tokenboard/upgrade-work/TokenBoard', '/home/user/.tokenboard/TokenBoard'],
        options: { recursive: true, force: true }
      },
      {
        command: 'remove',
        args: ['/home/user/.tokenboard/upgrade-work'],
        options: { recursive: true, force: true }
      },
      {
        command: 'copy',
        args: ['/home/user/.tokenboard/TokenBoard/skills/tokenboard', '/home/user/.codex/skills/tokenboard'],
        options: { recursive: true, force: true }
      },
      {
        command: 'corepack',
        args: ['pnpm', 'install', '--frozen-lockfile'],
        options: { cwd: '/home/user/.tokenboard/TokenBoard' }
      }
    ]
  )
})

test('refuses to copy into the TokenBoard config directory', () => {
  assert.throws(
    () => buildUpgradePlan({
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      skillDir: '/home/user/.tokenboard',
      configDir: '/home/user/.tokenboard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'pnpm',
      collectorExists: true,
      collectorIsGitRepo: true
    }),
    /Refusing to replace TokenBoard config directory/
  )
})

test('refuses to replace the config directory as a non-git collector during upgrade', () => {
  assert.throws(
    () => buildUpgradePlan({
      collectorDir: '/home/user/.tokenboard',
      skillDir: '/home/user/.codex/skills/tokenboard',
      configDir: '/home/user/.tokenboard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'pnpm',
      collectorExists: true,
      collectorIsGitRepo: false,
      workDir: '/home/user/.tokenboard/upgrade-work'
    }),
    /Refusing to replace TokenBoard config directory as collector checkout/
  )
})

test('archive fallback also refuses to install the skill into the config directory', () => {
  const calls = []
  assert.throws(
    () => runUpgrade({
      flags: { 'skill-dir': '/home/user/.tokenboard' },
      env: {
        TOKENBOARD_CONFIG_DIR: '/home/user/.tokenboard',
        TOKENBOARD_COLLECTOR_DIR: '/home/user/.tokenboard/TokenBoard'
      },
      readConfigFile: () => ({
        collectorDir: '/home/user/.tokenboard/TokenBoard',
        repoUrl: 'https://github.com/example/TokenBoard.git',
        packageManager: 'pnpm'
      }),
      mergeConfigFile: (...args) => calls.push({ command: 'mergeConfig', args }),
      configDirectory: '/home/user/.tokenboard',
      exists: () => false,
      spawn: (command, args) => {
        calls.push({ command, args })
        if (command === 'git') return { status: 1 }
        return { status: 0 }
      },
      copy: (...args) => calls.push({ command: 'copy', args }),
      mkdir: (...args) => calls.push({ command: 'mkdir', args }),
      readDir: () => [{ name: 'TokenBoard-main', isDirectory: () => true }],
      remove: (...args) => calls.push({ command: 'remove', args }),
      log: () => {}
    }),
    /Refusing to replace TokenBoard config directory/
  )
  assert.equal(calls.some((call) => call.command === 'copy'), false)
  assert.equal(calls.some((call) => call.command === 'mergeConfig'), false)
})

test('archive fallback also refuses to replace the config directory as collector checkout', () => {
  const calls = []
  assert.throws(
    () => runUpgrade({
      env: {
        TOKENBOARD_CONFIG_DIR: '/home/user/.tokenboard',
        TOKENBOARD_COLLECTOR_DIR: '/home/user/.tokenboard'
      },
      readConfigFile: () => ({
        collectorDir: '/home/user/.tokenboard',
        repoUrl: 'https://github.com/example/TokenBoard.git',
        packageManager: 'pnpm'
      }),
      mergeConfigFile: (...args) => calls.push({ command: 'mergeConfig', args }),
      configDirectory: '/home/user/.tokenboard',
      exists: (path) => path === '/home/user/.tokenboard',
      spawn: (command, args) => {
        calls.push({ command, args })
        if (command === 'git') return { status: 1 }
        return { status: 0 }
      },
      copy: (...args) => calls.push({ command: 'copy', args }),
      mkdir: (...args) => calls.push({ command: 'mkdir', args }),
      readDir: () => [{ name: 'TokenBoard-main', isDirectory: () => true }],
      remove: (...args) => calls.push({ command: 'remove', args }),
      log: () => {}
    }),
    /Refusing to replace TokenBoard config directory as collector checkout/
  )
  assert.equal(
    calls.some((call) =>
      call.command === 'remove' &&
      call.args[0] === '/home/user/.tokenboard'
    ),
    false
  )
  assert.equal(calls.some((call) => call.command === 'mergeConfig'), false)
})

test('uses configured git repo URLs but ignores legacy zip download URLs', () => {
  assert.equal(
    resolveRepoUrl({
      flags: {},
      env: {},
      config: { repoUrl: 'https://github.com/example/TokenBoard.git' }
    }),
    'https://github.com/example/TokenBoard.git'
  )

  assert.equal(
    resolveRepoUrl({
      flags: {},
      env: {},
      config: { repoUrl: 'https://github.com/example/TokenBoard/archive/refs/heads/master.zip' }
    }),
    'https://github.com/evepupil/TokenBoard.git'
  )

  assert.equal(
    resolveRepoUrl({
      flags: { 'repo-url': 'https://github.com/example/fork.git' },
      env: { TOKENBOARD_REPO_URL: 'https://github.com/example/env.git' },
      config: { repoUrl: 'https://github.com/example/config.git' }
    }),
    'https://github.com/example/fork.git'
  )

  assert.equal(
    resolveRepoUrl({
      flags: {},
      env: {},
      config: { repoUrl: 'https://gitlab.example.com/example/TokenBoard' }
    }),
    'https://gitlab.example.com/example/TokenBoard'
  )
})

test('resolves archive fallback URLs from explicit, legacy, and github repo values', () => {
  assert.equal(
    resolveArchiveUrl({
      flags: { 'archive-url': '  https://example.test/tokenboard.zip  ' },
      env: {},
      config: {},
      repoUrl: 'https://github.com/example/TokenBoard.git'
    }),
    'https://example.test/tokenboard.zip'
  )

  assert.equal(
    resolveArchiveUrl({
      flags: {},
      env: {},
      config: { repoUrl: '  https://github.com/example/TokenBoard/archive/refs/heads/master.zip  ' },
      repoUrl: 'https://github.com/example/TokenBoard.git'
    }),
    'https://github.com/example/TokenBoard/archive/refs/heads/master.zip'
  )

  assert.equal(
    resolveArchiveUrl({
      flags: {},
      env: {},
      config: {},
      repoUrl: 'https://github.com/example/TokenBoard.git'
    }),
    'https://github.com/example/TokenBoard/archive/refs/heads/master.zip'
  )

  assert.equal(
    resolveArchiveUrl({
      flags: {},
      env: {},
      config: {},
      repoUrl: 'https://github.com/example/TokenBoard.git',
      repoRef: 'research/agy-token-support-plan'
    }),
    'https://github.com/example/TokenBoard/archive/refs/heads/research%2Fagy-token-support-plan.zip'
  )

  assert.equal(
    resolveArchiveUrl({
      flags: {},
      env: {},
      config: {},
      repoUrl: 'https://github.com/example/TokenBoard.git',
      repoRef: 'refs/tags/v1.2.3'
    }),
    'https://github.com/example/TokenBoard/archive/refs/tags/v1.2.3.zip'
  )

  assert.equal(
    resolveArchiveUrl({
      flags: {},
      env: {},
      config: {},
      repoUrl: 'https://github.com/example/token.board/'
    }),
    'https://github.com/example/token.board/archive/refs/heads/master.zip'
  )

  assert.equal(
    resolveArchiveUrl({
      flags: {},
      env: {},
      config: {},
      repoUrl: 'git@github.com:example/TokenBoard.git',
      repoRef: 'v1.2.3'
    }),
    'https://github.com/example/TokenBoard/archive/refs/heads/v1.2.3.zip'
  )

  assert.equal(
    resolveArchiveUrl({
      flags: {},
      env: {},
      config: {},
      repoUrl: 'ssh://git@github.com/example/TokenBoard.git',
      repoRef: 'refs/tags/v1.2.3'
    }),
    'https://github.com/example/TokenBoard/archive/refs/tags/v1.2.3.zip'
  )
})

test('archive fallback rejects non-GitHub git repos without an explicit archive URL', () => {
  assert.throws(
    () => resolveArchiveUrl({
      flags: {},
      env: {},
      config: {},
      repoUrl: 'git@gitlab.example.com:example/TokenBoard.git'
    }),
    /Archive fallback requires a GitHub repo URL or explicit archive URL/
  )
})

test('resolves short repo refs to branch and raw archive fallback candidates', () => {
  assert.deepEqual(
    resolveArchiveUrls({
      flags: {},
      env: {},
      config: {},
      repoUrl: 'https://github.com/example/TokenBoard.git',
      repoRef: 'v1.2.3'
    }),
    [
      'https://github.com/example/TokenBoard/archive/refs/heads/v1.2.3.zip',
      'https://github.com/example/TokenBoard/archive/v1.2.3.zip'
    ]
  )

  assert.deepEqual(
    resolveArchiveUrls({
      flags: {},
      env: {},
      config: {},
      repoUrl: 'https://github.com/example/TokenBoard.git',
      repoRef: '0123456789abcdef0123456789abcdef01234567'
    }),
    [
      'https://github.com/example/TokenBoard/archive/refs/heads/0123456789abcdef0123456789abcdef01234567.zip',
      'https://github.com/example/TokenBoard/archive/0123456789abcdef0123456789abcdef01234567.zip'
    ]
  )
})

test('resolves qualified archive refs without raw fallback candidates', () => {
  assert.deepEqual(
    resolveArchiveUrls({
      flags: {},
      env: {},
      config: {},
      repoUrl: 'https://github.com/example/TokenBoard.git',
      repoRef: 'refs/heads/feature/archive-fallback'
    }),
    [
      'https://github.com/example/TokenBoard/archive/refs/heads/feature%2Farchive-fallback.zip'
    ]
  )

  assert.deepEqual(
    resolveArchiveUrls({
      flags: {},
      env: {},
      config: {},
      repoUrl: 'https://github.com/example/TokenBoard.git',
      repoRef: 'refs/tags/v1.2.3'
    }),
    [
      'https://github.com/example/TokenBoard/archive/refs/tags/v1.2.3.zip'
    ]
  )

  assert.deepEqual(
    resolveArchiveUrls({
      flags: { 'archive-url': 'https://example.test/tokenboard.zip' },
      env: {},
      config: {},
      repoUrl: 'https://github.com/example/TokenBoard.git',
      repoRef: 'v1.2.3'
    }),
    ['https://example.test/tokenboard.zip']
  )
})

test('archive fallback retries a short tag ref after branch archive download fails', () => {
  const calls = []
  runUpgrade({
    flags: { 'repo-ref': 'v1.2.3' },
    env: {
      TOKENBOARD_CONFIG_DIR: '/home/user/.tokenboard',
      TOKENBOARD_COLLECTOR_DIR: '/home/user/.tokenboard/TokenBoard'
    },
    readConfigFile: () => ({
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'pnpm'
    }),
    mergeConfigFile: (...args) => calls.push({ command: 'mergeConfig', args }),
    configDirectory: '/home/user/.tokenboard',
    exists: () => false,
    spawn: (command, args) => {
      calls.push({ command, args })
      if (command === 'git') return { status: 1 }
      if (command === 'curl' && args[1].endsWith('/archive/refs/heads/v1.2.3.zip')) return { status: 22 }
      return { status: 0 }
    },
    copy: (...args) => calls.push({ command: 'copy', args }),
    mkdir: (...args) => calls.push({ command: 'mkdir', args }),
    readDir: () => [{ name: 'TokenBoard-v1.2.3', isDirectory: () => true }],
    remove: (...args) => calls.push({ command: 'remove', args }),
    log: () => {}
  })

  assert.deepEqual(
    calls
      .filter((call) => call.command === 'curl')
      .map((call) => call.args.slice(0, 2)),
    [
      ['-fL', 'https://github.com/example/TokenBoard/archive/refs/heads/v1.2.3.zip'],
      ['-fL', 'https://github.com/example/TokenBoard/archive/v1.2.3.zip']
    ]
  )
  assert(calls.some((call) => call.command === 'mergeConfig'))
})

test('archive fallback skips copying the installed skill onto itself', () => {
  const calls = []
  runUpgrade({
    flags: { 'skill-dir': '/home/user/.tokenboard/TokenBoard/skills/tokenboard' },
    env: {
      TOKENBOARD_CONFIG_DIR: '/home/user/.tokenboard',
      TOKENBOARD_COLLECTOR_DIR: '/home/user/.tokenboard/TokenBoard'
    },
    readConfigFile: () => ({
      collectorDir: '/home/user/.tokenboard/TokenBoard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'pnpm'
    }),
    mergeConfigFile: (...args) => calls.push({ command: 'mergeConfig', args }),
    configDirectory: '/home/user/.tokenboard',
    exists: () => false,
    spawn: (command, args) => {
      calls.push({ command, args })
      if (command === 'git') return { status: 1 }
      return { status: 0 }
    },
    copy: (...args) => calls.push({ command: 'copy', args }),
    mkdir: (...args) => calls.push({ command: 'mkdir', args }),
    readDir: () => [{ name: 'TokenBoard-main', isDirectory: () => true }],
    remove: (...args) => calls.push({ command: 'remove', args }),
    log: () => {}
  })

  assert.equal(
    calls.some((call) =>
      call.command === 'copy' &&
      call.args[0] === '/home/user/.tokenboard/TokenBoard/skills/tokenboard' &&
      call.args[1] === '/home/user/.tokenboard/TokenBoard/skills/tokenboard'
    ),
    false
  )
  assert(calls.some((call) => call.command === 'mergeConfig'))
})

test('windows archive fallback retries a short tag ref after branch archive download fails', () => {
  const calls = []
  runUpgrade({
    flags: { 'repo-ref': 'v1.2.3' },
    env: {
      TOKENBOARD_CONFIG_DIR: 'C:\\Users\\QDM\\.tokenboard',
      TOKENBOARD_COLLECTOR_DIR: 'C:\\Users\\QDM\\.tokenboard\\TokenBoard'
    },
    readConfigFile: () => ({
      collectorDir: 'C:\\Users\\QDM\\.tokenboard\\TokenBoard',
      repoUrl: 'https://github.com/example/TokenBoard.git',
      packageManager: 'pnpm'
    }),
    mergeConfigFile: (...args) => calls.push({ command: 'mergeConfig', args }),
    configDirectory: 'C:\\Users\\QDM\\.tokenboard',
    exists: () => false,
    platform: 'win32',
    spawn: (command, args) => {
      calls.push({ command, args })
      const script = args[4] ?? ''
      if (command === 'git') return { status: 1 }
      if (
        command === 'powershell.exe' &&
        script.includes('Invoke-WebRequest') &&
        script.includes('/archive/refs/heads/v1.2.3.zip')
      ) {
        return { status: 1 }
      }
      return { status: 0 }
    },
    copy: (...args) => calls.push({ command: 'copy', args }),
    mkdir: (...args) => calls.push({ command: 'mkdir', args }),
    readDir: () => [{ name: 'TokenBoard-v1.2.3', isDirectory: () => true }],
    remove: (...args) => calls.push({ command: 'remove', args }),
    log: () => {}
  })

  assert.deepEqual(
    calls
      .filter((call) => call.command === 'powershell.exe' && String(call.args[4]).includes('Invoke-WebRequest'))
      .map((call) => String(call.args[4]).match(/https:\/\/[^']+/)?.[0]),
    [
      'https://github.com/example/TokenBoard/archive/refs/heads/v1.2.3.zip',
      'https://github.com/example/TokenBoard/archive/v1.2.3.zip'
    ]
  )
  assert(calls.some((call) => call.command === 'mergeConfig'))
})
