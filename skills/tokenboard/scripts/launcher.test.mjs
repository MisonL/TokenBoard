import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { runLauncherCli } from './launcher-runtime.mjs'
import {
  ensureLauncher,
  launcherFileName,
  launcherScriptPath,
  migrateScriptArgs,
  launcherRelativeScript
} from './launcher.mjs'

// The launcher runs from <configDir>/bin and must recover a half-swapped skill
// directory without ever depending on that directory being readable. Fixtures
// use a real temp configDir (so the vendored lock file lands for real) and
// inject spawn, while pointing TOKENBOARD_SKILL_DIR at a path under it.

function statOrNull(p) {
  try {
    return statSync(p)
  } catch {
    return null
  }
}
function readDirSafe(p) {
  try {
    return readdirSync(p)
  } catch {
    return []
  }
}

function makeRuntime({ alive = true } = {}) {
  const spawns = []
  const renames = []
  const errors = []
  const runtime = {
    platform: process.platform,
    now: () => Date.now(),
    pid: 4242,
    isProcessAlive: () => alive,
    sleep: () => [],
    fs: {
      exists: (p) => existsSync(p),
      stat: (p) => statOrNull(p),
      readDir: (p) => readDirSafe(p),
      readFile: (p) => readFileSync(p, 'utf8'),
      writeFile: (p, data, options) => writeFileSync(p, data, options),
      mkdir: (p, options) => mkdirSync(p, options),
      rename: (from, to) => {
        renames.push([from, to])
        renameSync(from, to)
      },
      unlink: (p) => rmSync(p, { force: true }),
      rm: (p) => rmSync(p, { recursive: true, force: true })
    },
    spawn: (command, args, options) => {
      spawns.push({ command, args, options })
      return { status: 0, signal: null }
    },
    onError: (line) => errors.push(line)
  }
  return { runtime, spawns, renames, errors }
}

function newSetup(t) {
  const configDir = mkdtempSync(join(tmpdir(), 'launcher-'))
  t.after(() => rmSync(configDir, { recursive: true, force: true }))
  const skillDir = join(configDir, 'TokenBoard', 'skills', 'tokenboard')
  mkdirSync(join(configDir, 'TokenBoard', 'skills'), { recursive: true })
  return { configDir, skillDir }
}

function writeCompleteSkill(skillDir) {
  mkdirSync(join(skillDir, 'scripts'), { recursive: true })
  writeFileSync(join(skillDir, 'scripts', 'sync.mjs'), '// sync\n')
  writeFileSync(join(skillDir, '.tokenboard-skill-complete'), 'v1')
}

function makeCompleteBackup(skillDir, suffix, mtimeMs) {
  const dir = `${skillDir}.tokenboard-upgrade-backup-${suffix}`
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'scripts', 'sync.mjs'), '// old but complete\n')
  writeFileSync(join(dir, '.tokenboard-skill-complete'), 'backup')
  if (mtimeMs !== undefined) {
    // utimesSync takes seconds, not the milliseconds statSync reports.
    const seconds = mtimeMs / 1000
    utimesSync(dir, seconds, seconds)
  }
  return dir
}

const syncArgs = ['scripts/sync.mjs', '--mode', 'sync', '--scheduled']

test('a healthy skill directory spawns the requested script and inherits its exit code', (t) => {
  const { configDir, skillDir } = newSetup(t)
  writeCompleteSkill(skillDir)
  const { runtime, spawns, renames } = makeRuntime()
  const code = runLauncherCli({
    argv: syncArgs,
    env: { TOKENBOARD_STATE_DIR: configDir, TOKENBOARD_SKILL_DIR: skillDir },
    runtime
  })
  assert.equal(code, 0)
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].args[0], join(skillDir, 'scripts', 'sync.mjs'))
  assert.deepEqual(spawns[0].args.slice(1), ['--mode', 'sync', '--scheduled'])
  assert.equal(spawns[0].options.stdio, 'inherit')
  // The child scripts re-derive the config dir themselves; the launcher pins the
  // resolved value so a migrated entry cannot fork a second state directory.
  assert.equal(spawns[0].options.env.TOKENBOARD_STATE_DIR, configDir)
  assert.equal(spawns[0].options.env.TOKENBOARD_SKILL_DIR, skillDir)
  assert.deepEqual(renames, [], 'a healthy install is never touched')
})

test('the child exit code is returned untouched', (t) => {
  const { configDir, skillDir } = newSetup(t)
  writeCompleteSkill(skillDir)
  const { runtime } = makeRuntime()
  runtime.spawn = () => ({ status: 75, signal: null })
  const code = runLauncherCli({
    argv: ['scripts/notify.mjs', '--source', 'codex'],
    env: { TOKENBOARD_STATE_DIR: configDir, TOKENBOARD_SKILL_DIR: skillDir },
    runtime
  })
  assert.equal(code, 75)
})

// The field incident: the first rename landed (skillDir→backup) and the second
// never ran, so skillDir is gone while the newest backup holds a full tree.
test('a missing skill directory is recovered from the newest backup', (t) => {
  const { configDir, skillDir } = newSetup(t)
  const older = makeCompleteBackup(skillDir, '100', Date.now() - 60_000)
  const newest = makeCompleteBackup(skillDir, '200', Date.now())
  const { runtime, spawns, renames } = makeRuntime()
  const code = runLauncherCli({
    argv: syncArgs,
    env: { TOKENBOARD_STATE_DIR: configDir, TOKENBOARD_SKILL_DIR: skillDir },
    runtime
  })
  assert.equal(code, 0, 'recovery should end in a normal spawn')
  assert.ok(existsSync(join(skillDir, 'scripts', 'sync.mjs')))
  const promoted = renames.map(([from, to]) => `${basename(from)}->${basename(to)}`)
  assert.ok(
    promoted.some((e) => e.includes('backup-200') && e.endsWith('->tokenboard')),
    `expected newest backup promoted, got ${JSON.stringify(promoted)}`
  )
  assert.ok(existsSync(older), 'the older backup is left in place, not consumed')
  assert.ok(!existsSync(newest), 'the promoted backup was renamed, not copied')
  assert.equal(spawns.length, 1)
})

test('a leftover staging without the completion marker is never promoted', (t) => {
  const { configDir, skillDir } = newSetup(t)
  // skillDir absent (the failed swap), staging left behind half-copied.
  const staging = `${skillDir}.tokenboard-upgrade-staging-999`
  mkdirSync(join(staging, 'scripts'), { recursive: true }) // no completion marker
  const { runtime, spawns, renames } = makeRuntime()
  const code = runLauncherCli({
    argv: syncArgs,
    env: { TOKENBOARD_STATE_DIR: configDir, TOKENBOARD_SKILL_DIR: skillDir },
    runtime
  })
  assert.equal(code, 75, 'an unmarked staging is not trustworthy, so nothing is recoverable')
  assert.ok(existsSync(staging), 'an unmarked staging directory must be left alone')
  assert.equal(spawns.length, 0)
  assert.deepEqual(renames, [])
})

test('a completed staging is promoted when no backup exists', (t) => {
  const { configDir, skillDir } = newSetup(t)
  const staging = `${skillDir}.tokenboard-upgrade-staging-7`
  mkdirSync(join(staging, 'scripts'), { recursive: true })
  writeFileSync(join(staging, 'scripts', 'sync.mjs'), '// new\n')
  writeFileSync(join(staging, '.tokenboard-skill-complete'), 'ready')
  const { runtime, spawns } = makeRuntime()
  const code = runLauncherCli({
    argv: syncArgs,
    env: { TOKENBOARD_STATE_DIR: configDir, TOKENBOARD_SKILL_DIR: skillDir },
    runtime
  })
  assert.equal(code, 0)
  assert.ok(existsSync(join(skillDir, 'scripts', 'sync.mjs')))
  assert.ok(!existsSync(staging), 'the promoted staging is consumed by the rename')
  assert.equal(spawns.length, 1)
})

test('with neither backup nor staging the launcher reports a diagnosable error and exits transient', (t) => {
  const { configDir, skillDir } = newSetup(t)
  const { runtime, spawns, errors } = makeRuntime()
  const code = runLauncherCli({
    argv: syncArgs,
    env: { TOKENBOARD_STATE_DIR: configDir, TOKENBOARD_SKILL_DIR: skillDir },
    runtime
  })
  assert.equal(code, 75)
  assert.equal(spawns.length, 0)
  assert.ok(errors.some((l) => l.includes('no upgrade backup or staging')))
  assert.ok(errors.some((l) => l.includes(skillDir)))
})

test('a busy swap lock makes the launcher back off transiently without touching directories', (t) => {
  const { configDir, skillDir } = newSetup(t)
  const backup = makeCompleteBackup(skillDir, '1')
  // A live foreign holder owns the lock.
  writeFileSync(
    join(configDir, 'skill-swap.lock'),
    JSON.stringify({ pid: 999999, token: 'holder', startedAt: new Date().toISOString() })
  )
  const { runtime, spawns, renames } = makeRuntime({ alive: true })
  const code = runLauncherCli({
    argv: syncArgs,
    env: { TOKENBOARD_STATE_DIR: configDir, TOKENBOARD_SKILL_DIR: skillDir },
    runtime
  })
  assert.equal(code, 75)
  assert.ok(existsSync(backup), 'a contended swap must not be half-recovered')
  assert.ok(!existsSync(skillDir))
  assert.equal(spawns.length, 0)
  assert.deepEqual(renames, [])
})

test('recovery re-checks health inside the lock and skips work a competitor finished', (t) => {
  const { configDir, skillDir } = newSetup(t)
  makeCompleteBackup(skillDir, '1')
  const { runtime, spawns, renames } = makeRuntime()
  // When this process creates the lock file, a competitor has already restored
  // the skill directory — the in-lock re-check must notice and stand down.
  const realWriteFile = runtime.fs.writeFile
  runtime.fs.writeFile = (p, data, options) => {
    if (p.endsWith('skill-swap.lock')) writeCompleteSkill(skillDir)
    return realWriteFile(p, data, options)
  }
  const code = runLauncherCli({
    argv: syncArgs,
    env: { TOKENBOARD_STATE_DIR: configDir, TOKENBOARD_SKILL_DIR: skillDir },
    runtime
  })
  assert.equal(code, 0)
  assert.equal(spawns.length, 1)
  assert.deepEqual(renames, [], 'the in-lock re-check must prevent a second recovery rename')
})

test('the swap lock is held during recovery and released before the spawn', (t) => {
  const { configDir, skillDir } = newSetup(t)
  makeCompleteBackup(skillDir, '1')
  const { runtime } = makeRuntime()
  const lockPath = join(configDir, 'skill-swap.lock')
  const realSpawn = runtime.spawn
  let lockSeenDuringSpawn = null
  runtime.spawn = (command, args, options) => {
    lockSeenDuringSpawn = existsSync(lockPath)
    return realSpawn(command, args, options)
  }
  const code = runLauncherCli({
    argv: syncArgs,
    env: { TOKENBOARD_STATE_DIR: configDir, TOKENBOARD_SKILL_DIR: skillDir },
    runtime
  })
  assert.equal(code, 0)
  assert.equal(lockSeenDuringSpawn, false, 'the swap lock must be released before spawning the child')
  assert.ok(!existsSync(lockPath), 'no lock left behind after a successful run')
})

test('a legacy install without the completion marker counts as healthy', (t) => {
  const { configDir, skillDir } = newSetup(t)
  mkdirSync(join(skillDir, 'scripts'), { recursive: true })
  writeFileSync(join(skillDir, 'scripts', 'sync.mjs'), '// legacy install, no marker\n')
  const { runtime, spawns, renames } = makeRuntime()
  const code = runLauncherCli({
    argv: syncArgs,
    env: { TOKENBOARD_STATE_DIR: configDir, TOKENBOARD_SKILL_DIR: skillDir },
    runtime
  })
  assert.equal(code, 0)
  assert.equal(spawns.length, 1)
  assert.deepEqual(renames, [], 'a legacy-but-present install must not be recovered')
})

test('ensureLauncher writes the launcher and a byte-identical vendored lock module', (t) => {
  const { configDir } = newSetup(t)
  const sourceDir = import.meta.dirname
  const result = ensureLauncher({ configDir, sourceDir, platform: process.platform })
  const launcherPath = join(configDir, 'bin', launcherFileName)
  assert.ok(existsSync(launcherPath))
  assert.equal(result.launcherPath, launcherPath)
  const vendoredLock = join(configDir, 'bin', 'skill-swap-lock.mjs')
  assert.ok(existsSync(vendoredLock))
  assert.equal(
    readFileSync(vendoredLock, 'utf8'),
    readFileSync(join(sourceDir, 'skill-swap-lock.mjs'), 'utf8'),
    'the vendored copy must be byte-identical so launcher and skill never drift'
  )
  const again = ensureLauncher({ configDir, sourceDir, platform: process.platform })
  assert.equal(again.launcherPath, result.launcherPath)
})

test('the installed bin entry recovers a backup using only the vendored module', (t) => {
  // End-to-end through the real launcher file: proves the bin/ entry resolves its
  // vendored lock import inside<configDir>/bin while <skillDir> is absent.
  const { configDir, skillDir } = newSetup(t)
  const { launcherPath } = ensureLauncher({ configDir, sourceDir: import.meta.dirname, platform: process.platform })
  makeCompleteBackup(skillDir, '5')
  const result = spawnSync(process.execPath, [launcherPath, 'scripts/sync.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, TOKENBOARD_STATE_DIR: configDir, TOKENBOARD_SKILL_DIR: skillDir }
  })
  assert.ok(existsSync(join(skillDir, 'scripts')), 'the entry file must recover the backup before spawning')
  // The recovered sync.mjs is a comment-only fixture, so the pipeline is:
  // recover → release lock → spawn child → inherit its (zero) exit code.
  assert.equal(result.status, 0, `launcher entry failed: ${result.stderr}`)
  assert.ok(!existsSync(join(configDir, 'skill-swap.lock')), 'the entry must not leak the swap lock')
})

// --- migrateScriptArgs: command rewriting ----------------------------------

test("migrate rewrites this install's skill script, preserving position and quoting", () => {
  const skillDir = '/home/u/.tokenboard/TokenBoard/skills/tokenboard'
  const launcher = launcherScriptPath('/home/u/.tokenboard')
  // launchd / systemd / schtasks: [node, sync.mjs, --mode, sync, --scheduled]
  const plain = migrateScriptArgs({
    args: [process.execPath, `${skillDir}/scripts/sync.mjs`, '--scheduled'],
    skillDir,
    launcherPath: launcher
  })
  assert.equal(plain.changed, true)
  assert.deepEqual(plain.args, [process.execPath, launcher, '--scheduled'])
  // Windows .cmd form keeps its double-quoting.
  const quoted = migrateScriptArgs({
    args: ['"C:\\node.exe"', `"${skillDir}/scripts/sync.mjs"`, '--mode', 'sync'],
    skillDir,
    launcherPath: launcher
  })
  assert.equal(quoted.changed, true)
  assert.equal(quoted.args[1], `"${launcher}"`)
})

test("migrate leaves a user's unrelated hook command untouched", () => {
  const skillDir = '/home/u/.tokenboard/TokenBoard/skills/tokenboard'
  const launcher = launcherScriptPath('/home/u/.tokenboard')
  const custom = migrateScriptArgs({
    args: ['/usr/bin/env', 'node', '/home/u/my-hooks/notify.mjs', '--source', 'x'],
    skillDir,
    launcherPath: launcher
  })
  assert.equal(custom.changed, false)
  assert.deepEqual(custom.args, ['/usr/bin/env', 'node', '/home/u/my-hooks/notify.mjs', '--source', 'x'])
  // A sibling directory that merely shares a prefix is not this install.
  const sibling = migrateScriptArgs({ args: [`${skillDir}-old/scripts/sync.mjs`], skillDir, launcherPath: launcher })
  assert.equal(sibling.changed, false)
})

test('launcherRelativeScript produces the path the launcher expects', () => {
  const skillDir = '/home/u/.tokenboard/TokenBoard/skills/tokenboard'
  assert.equal(launcherRelativeScript(`${skillDir}/scripts/sync.mjs`, skillDir), 'scripts/sync.mjs')
  assert.equal(launcherRelativeScript(`"${skillDir}/scripts/notify.mjs"`, skillDir), 'scripts/notify.mjs')
})

// The exact upgrade window from the incident, on the real filesystem: the first
// rename landed (skillDir → backup) and the process died before the second, so
// skillDir is gone. A scheduled tick then runs the *installed* launcher entry
// and must recover, then actually execute the script it was asked to run.
test('an upgrade killed between its two renames is recovered by a scheduled tick', (t) => {
  const { configDir, skillDir } = newSetup(t)
  mkdirSync(join(skillDir, 'scripts'), { recursive: true })
  // A real, runnable sync stand-in so the assertion is about behavior, not a mock.
  writeFileSync(join(skillDir, 'scripts', 'sync.mjs'), 'process.stdout.write("SYNC_RAN")')
  writeFileSync(join(skillDir, '.tokenboard-skill-complete'), 'v1')
  const { launcherPath } = ensureLauncher({ configDir, sourceDir: import.meta.dirname, platform: process.platform })

  // First hop only: skillDir -> backup. The second hop never happens.
  const backup = `${skillDir}.tokenboard-upgrade-backup-${process.pid}`
  renameSync(skillDir, backup)
  assert.equal(existsSync(skillDir), false, 'the swap window: skillDir is gone')

  const result = spawnSync(process.execPath, [launcherPath, 'scripts/sync.mjs'], {
    encoding: 'utf8',
    env: { ...process.env, TOKENBOARD_STATE_DIR: configDir, TOKENBOARD_SKILL_DIR: skillDir }
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, 'SYNC_RAN', 'the launcher had to run the recovered script')
  assert.ok(existsSync(join(skillDir, 'scripts', 'sync.mjs')), 'skillDir restored from the backup')
  assert.equal(existsSync(backup), false, 'the backup was consumed by the rename')
  assert.equal(existsSync(join(configDir, 'skill-swap.lock')), false, 'no lock left behind')
})
