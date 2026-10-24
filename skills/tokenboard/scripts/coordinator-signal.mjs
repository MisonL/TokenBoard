import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { errorMessage } from './error-message.mjs'

export function appendSignal(runtime, trigger) {
  const payload = `${JSON.stringify({ source: trigger.source, requestedAt: new Date(runtime.now()).toISOString() })}\n`
  let queued = false
  let queueError
  try {
    queued = writeQueuedSignal(runtime, payload, trigger.source)
  } catch (error) {
    queueError = error
  }
  if (!queued || queueError) {
    runtime.writeFile(signalPath(runtime), payload, { flag: 'a' })
    if (queueError) throw queueError
  }
}

export function truncateSignal(runtime) {
  runtime.writeFile(signalPath(runtime), '')
}

export function acknowledgeSignalSource(runtime, source) {
  const sourceName = signalSourceName(source)
  const recovered = normalizeSignalRecoveryEntries(readSignalRecoveryEntries(runtime), runtime)
  const unexpected = recovered.find(({ sources }) => sources.includes(sourceName) && sources.length !== 1)
  if (unexpected) {
    throw new Error('TokenBoard signal recovery journal must be normalized before acknowledgement')
  }
  for (const { path, sources } of recovered) {
    if (sources.length !== 1 || sources[0] !== sourceName) continue
    try {
      removeDrainedSignal(path, runtime)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
}

export function drainSignalSources(runtime) {
  // Validate retained recovery state before rotating new signals into uniquely
  // named drain files. A malformed journal must fail closed without creating
  // an unbounded set of files on every retry.
  const recovered = normalizeSignalRecoveryEntries(readSignalRecoveryEntries(runtime), runtime)
  const queuedDrainPaths = drainQueuedSignalPaths(runtime)
  const legacyDrainPaths = drainLegacySignalPaths(runtime)
  return consumeDrainedSignalSources([...queuedDrainPaths, ...legacyDrainPaths], recovered, runtime)
}

function drainLegacySignalPaths(runtime) {
  if (typeof runtime.rename !== 'function') {
    return [...retainedLegacyDrainPaths(runtime), ...drainLegacySignalWithoutRename(runtime)]
  }

  const drainPaths = retainedLegacyDrainPaths(runtime)
  const path = signalPath(runtime)
  const drainPath = signalDrainPath(path, runtime)
  try {
    runtime.rename(path, drainPath)
    drainPaths.push(drainPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  return drainPaths
}

export function readSignalSources(runtime) {
  return mergeSources(
    readSignalRecoveryEntries(runtime).flatMap(({ sources }) => sources),
    mergeSources(readQueuedSignalSources(runtime), readLegacySignalSources(runtime))
  )
}

function readLegacySignalSources(runtime) {
  const sources = readRetainedLegacySignalSources(runtime)
  try {
    return mergeSources(sources, readSourcesFromText(runtime.readFile(signalPath(runtime))))
  } catch (error) {
    if (error.code === 'ENOENT') return sources
    throw error
  }
}

function removeTempSignal(runtime, tempPath) {
  try {
    runtime.unlink?.(tempPath)
  } catch {}
}

function writeQueuedSignal(runtime, payload, source) {
  if (typeof runtime.rename !== 'function') return false
  const dir = signalQueueDir(runtime)
  if (typeof runtime.mkdir !== 'function') {
    throw new Error('coordinator signal queue requires mkdir when rename is available')
  }
  runtime.mkdir(dir, { recursive: true })
  // A previous write killed between `writeFile` and `rename` leaves a temp file that
  // nothing else removes, so the queue would grow one stray entry per interruption.
  removeOrphanTempSignals(runtime, dir)
  const name = `${runtime.now()}-${runtime.process.pid}-${Math.random().toString(36).slice(2)}`
  const tempPath = join(dir, `${name}.tmp`)
  const finalPath = join(dir, `${signalSourceName(source)}.json`)
  // `writeFile` is inside the guard as well: it can fail after creating the file
  // (a short write, a full disk), which would strand the temp file just the same.
  try {
    runtime.writeFile(tempPath, payload, { flag: 'wx' })
    runtime.rename(tempPath, finalPath)
    return true
  } catch (error) {
    removeTempSignal(runtime, tempPath)
    throw error
  }
}

// Temp files are named `${now}-${pid}-${random}.tmp`, so the owning process is
// recoverable from the name. Only a file whose process is gone is an orphan: two
// hooks can overlap, and deleting a live invocation's temp file makes its rename
// fail with ENOENT and silently drops that signal. Liveness uses the injected
// runtime first so tests stay hermetic, and a probe that throws counts as alive —
// never delete on an inconclusive answer.
function removeOrphanTempSignals(runtime, dir) {
  if (typeof runtime.readdir !== 'function') return
  let names
  try {
    names = runtime.readdir(dir)
  } catch {
    // A queue that cannot be listed is still writable; leave the cleanup to a later run.
    return
  }
  for (const name of names) {
    if (typeof name !== 'string' || !name.endsWith('.tmp')) continue
    const ownerPid = tempFileOwnerPid(name)
    // An unparseable name is not evidence of a dead writer. Deferring to the same
    // conservative rule the liveness probe follows keeps the invariant this scan exists
    // to protect — never delete a file a live invocation still needs — and a name this
    // code cannot read is exactly the case where that judgement is unavailable.
    if (ownerPid === null || isOwnerAlive(runtime, ownerPid, tempFileWriteTime(name))) continue
    removeTempSignal(runtime, join(dir, name))
  }
}

// Two writers share this directory with different names: coordinator-signal.mjs writes
// `${now}-${pid}-${random}.tmp`, while the notify hook writes `.${now}-${pid}-${random}.tmp`
// — same fields, leading dot. The dot is what `fs` convention calls a hidden file, but it
// is part of the name here, so the pattern has to accept it or the hook's in-flight temp
// files are read as ownerless and deleted by the orphan scan while their writer is still
// running. That is the exact race this scan exists to avoid.
// The name is `${now}-${pid}-${random}.tmp` (the notify hook prefixes a dot), so the
// leading field is the writer's clock reading. An unparseable or absent value yields NaN,
// which the reuse check treats as "cannot tell" and therefore keeps the file.
function tempFileWriteTime(name) {
  const match = /^\.?(\d+)-/.exec(name)
  if (!match) return Number.NaN
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value > 0 ? value : Number.NaN
}

function tempFileOwnerPid(name) {
  const match = /^\.?(\d+)-(\d+)-/.exec(name)
  if (!match) return null
  const pid = Number(match[2])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

// A pid alone does not identify a process: the kernel reuses them. A temp file left by a
// writer that was killed can therefore look owned by whatever later took its pid, and the
// orphan it represents is never collected — one stray entry per interruption, forever.
//
// The name carries the write timestamp, so the reuse is detectable: if the pid is alive
// but that process started *after* the file was written, the writer cannot have been it.
// The start-time probe is expensive on macOS (it shells out, ~150ms against ~0.03ms for
// signal 0), so it only runs once a live pid has already been found — the rare branch.
function isOwnerAlive(runtime, pid, writtenAt) {
  const probe = runtime.isProcessAlive
  if (typeof probe === 'function') {
    try {
      if (probe(pid) === false) return false
    } catch {
      return true
    }
    return !startedAfterWrite(runtime, pid, writtenAt)
  }

  const kill = runtime.process?.kill
  if (typeof kill !== 'function') return true
  try {
    kill(pid, 0)
  } catch (error) {
    // Only ESRCH proves the process is gone. EPERM means it exists under another
    // user; anything else (EINVAL, no code) is inconclusive, and an inconclusive
    // answer must not authorise deleting a temp file a live writer still needs.
    return error?.code !== 'ESRCH'
  }
  return !startedAfterWrite(runtime, pid, writtenAt)
}

// True only when the process now holding `pid` demonstrably began after the file was
// written, which is proof of reuse. Every other outcome — no probe, an unknown identity,
// an unparseable timestamp, a clock that does not line up — leaves the pid looking alive,
// because an inconclusive answer must never authorise deleting a live writer's file.
function startedAfterWrite(runtime, pid, writtenAt) {
  if (!Number.isFinite(writtenAt)) return false
  const readIdentity = runtime.readProcessStartIdentity
  if (typeof readIdentity !== 'function') return false
  let identity
  try {
    identity = readIdentity(pid)
  } catch {
    return false
  }
  const startedAt = processStartTimeMs(identity)
  if (startedAt === null) return false
  // A second of slack absorbs the coarseness of the name's millisecond stamp without
  // being wide enough to mask a real reuse, which is at minimum a process lifetime away.
  return writtenAt + 1000 < startedAt
}

// Identity values are `<platform>:<...>`. Only darwin's form carries an absolute instant
// (`darwin:<epoch-seconds>:<microseconds>`). Linux reports `linux:<bootId>:<startTicks>`,
// where the ticks are counted from boot and cannot be placed on the wall clock without
// also reading boot time — so it yields null here, and the caller keeps its conservative
// "alive" answer. The effect is that pid-reuse detection does not engage on Linux: a stray
// temp file from a reused pid is kept rather than removed. That is the safe direction (a
// live writer's file is never deleted), and it only costs a stale queue entry.
function processStartTimeMs(identity) {
  const normalized =
    typeof identity === 'string' ? identity : identity && identity.status === 'known' ? identity.value : null
  if (typeof normalized !== 'string') return null
  const parts = normalized.split(':')
  if (parts[0] === 'darwin' && parts.length >= 3) {
    const seconds = Number(parts[1])
    const microseconds = Number(parts[2])
    if (!Number.isFinite(seconds) || !Number.isFinite(microseconds)) return null
    return seconds * 1000 + microseconds / 1000
  }
  return null
}

function signalSourceName(source) {
  if (source === 'codex' || source === 'claude-code') return source
  throw new Error('Unsupported TokenBoard signal source')
}

function drainQueuedSignalPaths(runtime) {
  if (typeof runtime.readdir !== 'function' || typeof runtime.rename !== 'function') return []
  const drainPaths = []
  for (const name of readQueueEntries(runtime)) {
    const path = join(signalQueueDir(runtime), name)
    if (isDrainedSignalEntry(name)) {
      drainPaths.push(path)
      continue
    }
    const drainPath = signalDrainPath(path, runtime)
    try {
      runtime.rename(path, drainPath)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    drainPaths.push(drainPath)
  }
  return drainPaths
}

function readQueuedSignalSources(runtime) {
  if (typeof runtime.readdir !== 'function') return []
  const sources = []
  for (const name of readQueueEntries(runtime)) {
    try {
      sources.push(...readSourcesFromText(runtime.readFile(join(signalQueueDir(runtime), name))))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return mergeSources(sources, [])
}

function readQueueEntries(runtime) {
  try {
    return runtime.readdir(signalQueueDir(runtime)).filter(isQueuedSignalEntry).sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function isQueuedSignalEntry(name) {
  return isActiveQueuedSignalEntry(name) || isDrainedSignalEntry(name)
}

function isActiveQueuedSignalEntry(name) {
  return name === 'codex.json' || name === 'claude-code.json' || isLegacyQueuedSignalEntry(name)
}

function isLegacyQueuedSignalEntry(name) {
  return /^\d+-\d+-[a-z0-9]+\.json$/.test(name)
}

function isDrainedSignalEntry(name) {
  return /^(?:codex|claude-code|\d+-\d+-[a-z0-9]+)\.json\.[^.]+\.[^.]+(?:\.[^.]+)?\.drain$/.test(name)
}

function retainedLegacyDrainPaths(runtime) {
  if (typeof runtime.readdir !== 'function') return []
  try {
    return runtime
      .readdir(runtime.stateDir)
      .filter(isLegacyDrainedSignalEntry)
      .sort()
      .map((name) => join(runtime.stateDir, name))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function retainedSignalRecoveryPaths(runtime) {
  if (typeof runtime.readdir !== 'function') return []
  try {
    return runtime
      .readdir(runtime.stateDir)
      .filter(isSignalRecoveryEntry)
      .sort()
      .map((name) => join(runtime.stateDir, name))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function readSignalRecoveryEntries(runtime) {
  const entries = []
  for (const path of retainedSignalRecoveryPaths(runtime)) {
    try {
      entries.push({
        path,
        sources: readSignalRecoverySourcesFromText(runtime.readFile(path))
      })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return entries
}

function readRetainedLegacySignalSources(runtime) {
  return retainedLegacyDrainPaths(runtime).flatMap((path) => readSourcesFromText(runtime.readFile(path)))
}

function isLegacyDrainedSignalEntry(name) {
  return /^notify\.signal\.[^.]+\.[^.]+(?:\.[^.]+)?\.drain$/.test(name)
}

function isSignalRecoveryEntry(name) {
  return (
    name === 'notify.signal.recovery.codex.json' ||
    name === 'notify.signal.recovery.claude-code.json' ||
    /^notify\.signal\.recovery\.[^.]+\.[^.]+\.[a-f0-9]+\.json$/.test(name)
  )
}

function signalDrainPath(path, runtime) {
  return `${path}.${runtime.process.pid}.${runtime.now()}.${randomBytes(8).toString('hex')}.drain`
}

function drainLegacySignalWithoutRename(runtime) {
  const path = signalPath(runtime)
  try {
    const sources = readSourcesFromText(runtime.readFile(path))
    return [{ path, sources, remove: () => truncateSignal(runtime) }]
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function consumeDrainedSignalSources(entries, recovered, runtime) {
  const drained = entries.flatMap((entry) => {
    if (typeof entry !== 'string') return [entry]
    try {
      return [
        {
          path: entry,
          sources: readSourcesFromText(runtime.readFile(entry)),
          remove: () => removeDrainedSignal(entry, runtime)
        }
      ]
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
  })
  if (drained.length === 0 && recovered.length === 0) return []
  const sources = mergeSources(
    recovered.flatMap(({ sources }) => sources),
    drained.flatMap(({ sources }) => sources)
  )
  try {
    ensureSignalRecoveryJournals(recovered, sources, runtime)
    for (const { remove } of drained) remove()
  } catch (error) {
    throw new Error(`TokenBoard signal cleanup failed; recovery journal retained: ${errorMessage(error)}`, {
      cause: error
    })
  }
  return sources
}

function normalizeSignalRecoveryEntries(entries, runtime) {
  const multiSourceEntries = entries.filter(({ sources }) => sources.length > 1)
  if (multiSourceEntries.length === 0) return entries
  const individualEntries = entries.filter(({ sources }) => sources.length === 1)
  const sources = mergeSources(
    multiSourceEntries.flatMap(({ sources }) => sources),
    []
  )
  try {
    ensureSignalRecoveryJournals(individualEntries, sources, runtime)
    for (const { path } of multiSourceEntries) removeDrainedSignal(path, runtime)
  } catch (error) {
    throw new Error(`TokenBoard signal recovery journal migration failed: ${errorMessage(error)}`, { cause: error })
  }
  return [
    ...individualEntries,
    ...sources
      .filter((source) => !individualEntries.some(({ sources }) => sources[0] === source))
      .map((source) => ({ path: signalRecoveryPath(source, runtime), sources: [source] }))
  ]
}

function ensureSignalRecoveryJournals(recovered, sources, runtime) {
  for (const source of sources) {
    if (
      recovered.some(({ sources: recoveredSources }) => {
        return recoveredSources.length === 1 && recoveredSources[0] === source
      })
    )
      continue
    writeSignalRecoveryJournal(source, runtime)
  }
}

function removeDrainedSignal(path, runtime) {
  runtime.unlink(path)
}

function writeSignalRecoveryJournal(source, runtime) {
  const path = signalRecoveryPath(source, runtime)
  const payload = `${JSON.stringify({ version: 2, source })}\n`
  // Written through a temp file and linked into place, like every other state file here.
  // A plain `writeFile` to the final path leaves a zero-byte or half-written journal if the
  // process dies between create and write, and `readSignalRecoverySourcesFromText` throws
  // on anything unparseable — while `drainSignalSources` and `readSignalSources` both call
  // it first, so every subsequent hook sync would fail before doing anything. Nothing in
  // this file deletes a damaged journal, so that state was permanent until someone removed
  // the file by hand.
  //
  // `link` rather than `rename`: rename silently replaces the destination, which would drop
  // the exclusivity this function exists to enforce, while link fails with EEXIST when the
  // journal is already there. That keeps the original contract — an identical single-source
  // journal is left alone, anything else is a conflict.
  //
  // `link` is absent when a caller injects its own file operations (see `coordinator.mjs`,
  // which drops the native primitives in that case, matching `notify.mjs` and
  // `coordinator-lock.mjs`). There is no way to write through a temp file without it, so
  // that path keeps the previous direct `wx` write — still exclusive, just not crash-atomic.
  const atomic = typeof runtime.link === 'function'
  const tempPath = atomic
    ? `${path}.tmp-${runtime.process?.pid ?? process.pid}-${randomBytes(6).toString('hex')}`
    : path
  try {
    runtime.writeFile(tempPath, payload, { flag: 'wx', mode: 0o600 })
    if (atomic) {
      runtime.link(tempPath, path)
      // `link` leaves the source in place (it is a second name for the same file), so the
      // temp has to go or it would linger and be counted as another journal.
      runtime.unlink(tempPath)
    }
  } catch (error) {
    if (atomic) {
      try {
        runtime.unlink(tempPath)
      } catch (cleanupError) {
        if (cleanupError?.code !== 'ENOENT') {
          throw new AggregateError([error, cleanupError], 'TokenBoard signal recovery journal cleanup failed')
        }
      }
    }
    if (error.code !== 'EEXIST') throw error
    const sources = readSignalRecoverySourcesFromText(runtime.readFile(path))
    if (sources.length === 1 && sources[0] === source) return
    throw new Error('Unexpected TokenBoard signal recovery journal already exists', { cause: error })
  }
}

function signalRecoveryPath(source, runtime) {
  return join(runtime.stateDir, `notify.signal.recovery.${signalSourceName(source)}.json`)
}

function readSignalRecoverySourcesFromText(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid TokenBoard signal recovery journal: ${errorMessage(error)}`, { cause: error })
  }
  if (parsed?.version === 2 && (parsed.source === 'codex' || parsed.source === 'claude-code')) {
    return [parsed.source]
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.sources)) {
    throw new Error('Invalid TokenBoard signal recovery journal')
  }
  const sources = parsed.sources.filter((source) => source === 'codex' || source === 'claude-code')
  if (sources.length !== parsed.sources.length || sources.length === 0) {
    throw new Error('Invalid TokenBoard signal recovery journal')
  }
  return mergeSources(sources, [])
}

function readSourcesFromText(text) {
  const sources = []
  const seen = new Set()
  for (const line of text.split(/\r?\n/)) {
    const source = parseSignalSource(line)
    if (!source || seen.has(source)) continue
    sources.push(source)
    seen.add(source)
  }
  return sources
}

function parseSignalSource(line) {
  const value = line.trim()
  if (!value) return null
  if (value === 'codex' || value === 'claude-code') return value
  try {
    const parsed = JSON.parse(value)
    return parsed?.source === 'codex' || parsed?.source === 'claude-code' ? parsed.source : null
  } catch {
    return null
  }
}

function mergeSources(left, right) {
  const merged = []
  const seen = new Set()
  for (const source of [...left, ...right]) {
    if (!source || seen.has(source)) continue
    merged.push(source)
    seen.add(source)
  }
  return merged
}

function signalPath(runtime) {
  return join(runtime.stateDir, 'notify.signal')
}

function signalQueueDir(runtime) {
  return join(runtime.stateDir, 'notify.signal.d')
}
