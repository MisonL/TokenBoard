// A small, self-contained lock for the skill directory swap.
//
// Why not `coordinator-lock.mjs`: that protocol carries the coordinator's
// token/lock-token/process-start-identity semantics and is ~700 lines with
// quarantine and cleanup guards. This lock has one job — serialize the two
// writers that can rename a skill directory (an upgrade and a launcher's
// recovery). It is intentionally dependency-free: the launcher copies this
// file verbatim into `<configDir>/bin/` at install time, and must keep working
// while `<skillDir>` itself is missing or half-swapped.
//
// File shape (`skill-swap.lock`): `{ pid, token, startedAt }`. A record is
// stale when its holder is gone or its lease expired (a killed holder must not
// block recovery forever). Release only drops the record the caller owns.

import { randomBytes } from 'node:crypto'

export const skillSwapLockLeaseMs = 10 * 60 * 1000
const maxAttempts = 8

export function skillSwapLockPath(stateDir) {
  return joinSafe(stateDir, 'skill-swap.lock')
}

function joinSafe(dir, name) {
  // Kept local rather than importing node:path so a vendored copy has no
  // relative imports at all; both separator styles appear in real state dirs.
  return String(dir).replace(/[\\/]$/, '') + (/^[A-Za-z]:/.test(String(dir)) ? '\\' : '/') + name
}

function readRecord(lockPath, runtime) {
  let raw
  try {
    raw = String(runtime.readFile(lockPath, 'utf8'))
  } catch {
    // No readable record: acquisition will surface a real permission problem
    // when it tries to create the file.
    return { missing: true }
  }
  try {
    const record = JSON.parse(raw)
    if (!record || typeof record !== 'object') return { corrupt: true }
    if (typeof record.token !== 'string' || typeof record.pid !== 'number') return { corrupt: true }
    return { ...record, raw }
  } catch {
    // A file we cannot parse cannot name its holder. Leaving it in place would
    // block every future acquisition, so it is treated as stale (the record is
    // small enough that a live holder's write is effectively atomic).
    return { corrupt: true }
  }
}

function isStale(record, runtime) {
  if (!record) return true
  if (runtime.isProcessAlive && !runtime.isProcessAlive(record.pid)) return true
  const started = Date.parse(record.startedAt)
  if (!Number.isFinite(started)) return true
  return runtime.now() - started > skillSwapLockLeaseMs
}

function clearStale(lockPath, runtime, record) {
  if (!isStale(record, runtime)) return false
  try {
    runtime.unlink(lockPath)
    return true
  } catch {
    return false
  }
}

function sleep(runtime, ms) {
  if (typeof runtime.sleep === 'function') runtime.sleep(ms)
}

// Returns `{ token, pid, startedAt }` on success, or null when somebody else
// holds the lock for the whole budget. A negative/zero budget makes exactly
// one attempt (useful for the launcher's non-blocking recovery probe).
export function acquireSkillSwapLock(lockPath, runtime, options = {}) {
  const budgetMs = options.budgetMs ?? runtime.budgetMs ?? 1500
  const started = runtime.now()
  let backoff = 50
  // Bound by attempts as well as by the clock: a test double (or a host whose
  // clock is frozen between calls) must not turn a contended lock into a spin.
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const existing = readRecord(lockPath, runtime)
    if (existing.missing || existing.corrupt || clearStale(lockPath, runtime, existing)) {
      if (existing.corrupt) {
        try {
          runtime.unlink(lockPath)
        } catch {
          // The write below reports EEXIST and the loop retries.
        }
      }
      const owner = {
        pid: runtime.pid,
        startedAt: new Date(runtime.now()).toISOString(),
        token: randomBytes(16).toString('hex')
      }
      try {
        runtime.writeFile(lockPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 })
        return owner
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
    }
    if (runtime.now() - started >= budgetMs) return null
    sleep(runtime, backoff)
    backoff = Math.min(backoff * 2, 400)
  }
  return null
}

export function releaseSkillSwapLock(lockPath, runtime, owner) {
  if (!owner?.token) return false
  const current = readRecord(lockPath, runtime)
  if (!current || current.token !== owner.token) return false
  try {
    runtime.unlink(lockPath)
    return true
  } catch {
    return false
  }
}
