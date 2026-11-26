import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { acquireSkillSwapLock, releaseSkillSwapLock, skillSwapLockPath } from './skill-swap-lock.mjs'

function runtimeFor(dir, overrides = {}) {
  const lockPath = skillSwapLockPath(dir)
  return {
    lockPath,
    runtime: {
      pid: 4242,
      now: () => Date.parse('2026-11-26T10:00:00.000Z'),
      writeFile: (path, data, options) => writeFileSync(path, data, options),
      readFile: (path, options) => readFileSync(path, options),
      rename: (from, to) => writeFileSync(to, readFileSync(from)),
      unlink: (path) => rmSync(path, { force: true }),
      sleep: () => [],
      isProcessAlive: () => true,
      budgetMs: 50,
      ...overrides
    }
  }
}

test('acquire writes a lock only one holder can own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swap-lock-'))
  try {
    const first = runtimeFor(dir)
    const owner = acquireSkillSwapLock(first.lockPath, first.runtime)
    assert.ok(owner)
    assert.equal(typeof owner.token, 'string')

    // A second holder must not take the file while the first is alive.
    const second = runtimeFor(dir, { pid: 5252 })
    assert.equal(acquireSkillSwapLock(second.lockPath, second.runtime), null)

    assert.equal(releaseSkillSwapLock(first.lockPath, first.runtime, owner), true)
    const third = runtimeFor(dir, { pid: 6363 })
    assert.ok(acquireSkillSwapLock(third.lockPath, third.runtime))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("release refuses to drop another holder's lock", () => {
  const dir = mkdtempSync(join(tmpdir(), 'swap-lock-'))
  try {
    const first = runtimeFor(dir)
    const owner = acquireSkillSwapLock(first.lockPath, first.runtime)
    const other = runtimeFor(dir, { pid: 7777 })
    const otherOwner = { token: 'not-the-real-token', pid: 7777 }
    assert.equal(releaseSkillSwapLock(first.lockPath, first.runtime, otherOwner), false)
    // The real holder can still release it afterwards.
    assert.equal(releaseSkillSwapLock(first.lockPath, first.runtime, owner), true)
    assert.ok(acquireSkillSwapLock(other.lockPath, other.runtime))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A holder killed mid-recovery leaves the lock behind; the next run must not
// deadlock on it forever.
test('a lock whose holder is dead is treated as stale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swap-lock-stale-'))
  try {
    const stale = runtimeFor(dir, { pid: 9999 })
    const owner = acquireSkillSwapLock(stale.lockPath, stale.runtime)
    assert.ok(owner)

    const next = runtimeFor(dir, { pid: 8888, isProcessAlive: () => false })
    assert.ok(acquireSkillSwapLock(next.lockPath, next.runtime), 'a dead holder must not block recovery')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a lock past its lease is stale even when the pid looks alive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swap-lock-lease-'))
  try {
    const first = runtimeFor(dir)
    const owner = acquireSkillSwapLock(first.lockPath, first.runtime)
    assert.ok(owner)

    const hoursLater = runtimeFor(dir, {
      pid: 4242,
      now: () => Date.parse('2026-11-26T13:00:00.000Z')
    })
    assert.ok(acquireSkillSwapLock(hoursLater.lockPath, hoursLater.runtime))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unreadable or foreign lock file does not crash acquisition', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swap-lock-junk-'))
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'skill-swap.lock'), 'not json at all')
    const runtime = runtimeFor(dir)
    assert.ok(acquireSkillSwapLock(runtime.lockPath, runtime.runtime))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
