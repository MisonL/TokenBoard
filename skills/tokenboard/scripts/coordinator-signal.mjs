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
    runtime.writeFile(
      signalPath(runtime),
      payload,
      { flag: 'a' }
    )
    if (queueError) throw queueError
  }
}

export function truncateSignal(runtime) {
  runtime.writeFile(signalPath(runtime), '')
}

export function drainSignalSources(runtime) {
  const queuedSources = drainQueuedSignalSources(runtime)
  const legacySources = drainLegacySignalSources(runtime)
  return mergeSources(queuedSources, legacySources)
}

function drainLegacySignalSources(runtime) {
  if (typeof runtime.rename !== 'function') {
    const sources = readLegacySignalSources(runtime)
    truncateSignal(runtime)
    return sources
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

  return consumeDrainedSignalSources(drainPaths, runtime)
}

export function readSignalSources(runtime) {
  return mergeSources(readQueuedSignalSources(runtime), readLegacySignalSources(runtime))
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
  const name = `${runtime.now()}-${runtime.process.pid}-${Math.random().toString(36).slice(2)}`
  const tempPath = join(dir, `${name}.tmp`)
  const finalPath = join(dir, `${signalSourceName(source)}.json`)
  runtime.writeFile(tempPath, payload, { flag: 'wx' })
  try {
    runtime.rename(tempPath, finalPath)
    return true
  } catch (error) {
    removeTempSignal(runtime, tempPath)
    throw error
  }
}

function signalSourceName(source) {
  if (source === 'codex' || source === 'claude-code') return source
  throw new Error('Unsupported TokenBoard signal source')
}

function drainQueuedSignalSources(runtime) {
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
  return consumeDrainedSignalSources(drainPaths, runtime)
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
    return runtime.readdir(signalQueueDir(runtime))
      .filter(isQueuedSignalEntry)
      .sort()
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function isQueuedSignalEntry(name) {
  return name === 'codex.json' || name === 'claude-code.json' || isDrainedSignalEntry(name)
}

function isDrainedSignalEntry(name) {
  return /^(codex|claude-code)\.json\.[^.]+\.[^.]+(?:\.[^.]+)?\.drain$/.test(name)
}

function retainedLegacyDrainPaths(runtime) {
  if (typeof runtime.readdir !== 'function') return []
  try {
    return runtime.readdir(runtime.stateDir)
      .filter(isLegacyDrainedSignalEntry)
      .sort()
      .map((name) => join(runtime.stateDir, name))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function readRetainedLegacySignalSources(runtime) {
  return retainedLegacyDrainPaths(runtime)
    .flatMap((path) => readSourcesFromText(runtime.readFile(path)))
}

function isLegacyDrainedSignalEntry(name) {
  return /^notify\.signal\.[^.]+\.[^.]+(?:\.[^.]+)?\.drain$/.test(name)
}

function signalDrainPath(path, runtime) {
  return `${path}.${runtime.process.pid}.${runtime.now()}.${randomBytes(8).toString('hex')}.drain`
}

function consumeDrainedSignalSources(paths, runtime) {
  const drained = paths.map((path) => ({
    path,
    sources: readSourcesFromText(runtime.readFile(path))
  }))
  const sources = mergeSources(drained.flatMap(({ sources }) => sources), [])
  try {
    for (const { path } of drained) removeDrainedSignal(path, runtime)
  } catch (error) {
    restoreDrainedSignalSources(sources, runtime, error)
  }
  return sources
}

function removeDrainedSignal(path, runtime) {
  runtime.unlink(path)
}

function restoreDrainedSignalSources(sources, runtime, removalError) {
  try {
    for (const source of sources) appendSignal(runtime, { source })
  } catch (restoreError) {
    throw new AggregateError(
      [removalError, restoreError],
      `TokenBoard signal cleanup and recovery failed: ${errorMessage(removalError)}; ${errorMessage(restoreError)}`
    )
  }
  throw removalError
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
