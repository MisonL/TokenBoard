import assert from 'node:assert/strict'
import test from 'node:test'
import { acknowledgeSignalSource, appendSignal, drainSignalSources, readSignalSources } from './coordinator-signal.mjs'
import { fakeProcess, memoryPathIncludes, memoryRuntime } from './coordinator-test-helpers.mjs'

function signal(source) {
  return `${JSON.stringify({ source })}\n`
}

function recoveryPaths(files) {
  return [...files.keys()].filter((path) => memoryPathIncludes(path, '/notify.signal.recovery.'))
}

function runtime(files, overrides = {}) {
  return {
    ...memoryRuntime(files),
    stateDir: '/state',
    now: () => Date.parse('2026-07-29T00:00:00.000Z'),
    process: fakeProcess(901),
    ...overrides
  }
}

// The journal used to be written straight to its final path. A write interrupted between
// create and completion (SIGKILL, power loss, a full disk) left a zero-byte or half-written
// file there, and every reader of that path throws on unparseable content — so every later
// hook sync failed before doing anything, with nothing in the code able to clear it. The
// write now goes through a temp file and a link, so an interrupted write can only strand a
// temp file, never a damaged journal at the path the readers use.
test('an interrupted recovery journal write cannot leave a damaged journal behind', () => {
  const fs = runtime({
    '/state/notify.signal.d/codex.json': signal('codex'),
    '/state/notify.signal': signal('claude-code')
  })
  const writeFile = fs.writeFile
  let interrupted = false
  fs.writeFile = (path, value, options) => {
    // Simulate a short write: the bytes land, then the call fails.
    if (memoryPathIncludes(path, '/notify.signal.recovery.') && !interrupted) {
      interrupted = true
      fs.files.set(path, String(value).slice(0, 5))
      const error = new Error('ENOSPC')
      error.code = 'ENOSPC'
      throw error
    }
    return writeFile(path, value, options)
  }

  assert.throws(() => drainSignalSources(fs), /ENOSPC/)
  assert.equal(interrupted, true, 'the interrupted write must actually have been reached')

  // Whatever is left must not be a journal at a path the readers consult.
  const journals = recoveryPaths(fs.files)
  for (const path of journals) {
    assert.doesNotThrow(
      () => JSON.parse(fs.files.get(path)),
      `recovery journal at ${path} is unparseable, which would block every later sync`
    )
  }
})

test('signal drain leaves every source in place when the recovery journal cannot be written', () => {
  const fs = runtime({
    '/state/notify.signal.d/codex.json': signal('codex'),
    '/state/notify.signal': signal('claude-code')
  })
  const writeFile = fs.writeFile
  fs.writeFile = (path, value, options) => {
    if (memoryPathIncludes(path, '/notify.signal.recovery.')) {
      const error = new Error('EACCES')
      error.code = 'EACCES'
      throw error
    }
    return writeFile(path, value, options)
  }

  assert.throws(() => drainSignalSources(fs), /EACCES/)
  assert.equal([...fs.files.keys()].filter((path) => path.endsWith('.drain')).length, 2)
  assert.equal(recoveryPaths(fs.files).length, 0)
  assert.deepEqual(readSignalSources(fs), ['codex', 'claude-code'])
})

test('signal drain validates a malformed recovery journal before rotating new signals', () => {
  const fs = runtime({
    '/state/notify.signal.recovery.900.1.deadbeef.json': '{not-json}\n',
    '/state/notify.signal.d/codex.json': signal('codex'),
    '/state/notify.signal': signal('claude-code')
  })

  assert.throws(() => drainSignalSources(fs), /Invalid TokenBoard signal recovery journal/)
  assert.equal(fs.files.has('/state/notify.signal.d/codex.json'), true)
  assert.equal(fs.files.has('/state/notify.signal'), true)
  assert.equal(
    [...fs.files.keys()].some((path) => path.endsWith('.drain')),
    false
  )
  assert.equal(recoveryPaths(fs.files).length, 1)
})

test('signal drain keeps a cross-format recovery journal when cleanup fails after an earlier drain was removed', () => {
  const fs = runtime({
    '/state/notify.signal.d/codex.json': signal('codex'),
    '/state/notify.signal': signal('claude-code')
  })
  const unlink = fs.unlink
  let deletedDrain = false
  fs.unlink = (path) => {
    if (path.endsWith('.drain') && !deletedDrain) {
      deletedDrain = true
      return unlink(path)
    }
    if (path.endsWith('.drain')) {
      const error = new Error('EPERM')
      error.code = 'EPERM'
      throw error
    }
    return unlink(path)
  }

  assert.throws(() => drainSignalSources(fs), /recovery journal retained: EPERM/)
  assert.equal([...fs.files.keys()].filter((path) => path.endsWith('.drain')).length, 1)
  const journals = recoveryPaths(fs.files)
  assert.equal(journals.length, 2)
  assert.deepEqual(journals.map((path) => JSON.parse(fs.files.get(path)).source).sort(), ['claude-code', 'codex'])
  assert.deepEqual(readSignalSources(fs), ['claude-code', 'codex'])
})

test('signal drain reuses its recovery journal while cleanup keeps failing', () => {
  const fs = runtime({
    '/state/notify.signal.d/codex.json': signal('codex'),
    '/state/notify.signal': signal('claude-code')
  })
  const unlink = fs.unlink
  fs.unlink = (path) => {
    if (path.endsWith('.drain')) {
      const error = new Error('EPERM')
      error.code = 'EPERM'
      throw error
    }
    return unlink(path)
  }

  assert.throws(() => drainSignalSources(fs), /recovery journal retained: EPERM/)
  const firstJournals = recoveryPaths(fs.files)
  assert.equal(firstJournals.length, 2)

  assert.throws(() => drainSignalSources(fs), /recovery journal retained: EPERM/)
  const secondJournals = recoveryPaths(fs.files)
  assert.deepEqual(secondJournals, firstJournals)
  assert.deepEqual(secondJournals.map((path) => JSON.parse(fs.files.get(path)).source).sort(), ['claude-code', 'codex'])
})

test('signal drain preserves a legacy source journal while adding a newly drained source', () => {
  const fs = runtime({
    '/state/notify.signal.recovery.900.1.deadbeef.json': `${JSON.stringify({
      version: 1,
      sources: ['codex']
    })}\n`,
    '/state/notify.signal.d/claude-code.json': signal('claude-code')
  })

  assert.deepEqual(drainSignalSources(fs), ['codex', 'claude-code'])
  const journals = recoveryPaths(fs.files)
  assert.equal(journals.length, 2)
  assert.deepEqual(
    journals
      .map((path) => {
        const parsed = JSON.parse(fs.files.get(path))
        return parsed.version === 1 ? parsed.sources[0] : parsed.source
      })
      .sort(),
    ['claude-code', 'codex']
  )
})

test('signal reader fails visibly and preserves a malformed recovery journal', () => {
  const fs = runtime({
    '/state/notify.signal.recovery.900.1.deadbeef.json': '{not-json}\n'
  })

  assert.throws(() => readSignalSources(fs), /Invalid TokenBoard signal recovery journal/)
  assert.equal(recoveryPaths(fs.files).length, 1)
})

test('a later drain migrates a multi-source journal and preserves it until each source acknowledges', () => {
  const fs = runtime({
    '/state/notify.signal.recovery.900.1.deadbeef.json': `${JSON.stringify({
      version: 1,
      sources: ['claude-code', 'codex']
    })}\n`,
    '/state/notify.signal.d/codex.json.900.1.deadbeef.drain': signal('codex')
  })

  assert.deepEqual(drainSignalSources(fs), ['claude-code', 'codex'])
  assert.equal(
    [...fs.files.keys()].some((path) => path.endsWith('.drain')),
    false
  )
  assert.equal(recoveryPaths(fs.files).length, 2)
  assert.deepEqual(readSignalSources(fs), ['claude-code', 'codex'])

  acknowledgeSignalSource(fs, 'codex')
  assert.deepEqual(readSignalSources(fs), ['claude-code'])
  assert.equal(recoveryPaths(fs.files).length, 1)

  acknowledgeSignalSource(fs, 'claude-code')
  assert.equal(recoveryPaths(fs.files).length, 0)
  assert.deepEqual(readSignalSources(fs), [])
})

test('signal drain without rename consumes retained legacy drains through the recovery journal', () => {
  const fs = runtime({
    '/state/notify.signal.900.1.deadbeef.drain': signal('codex')
  })
  delete fs.rename

  assert.deepEqual(drainSignalSources(fs), ['codex'])
  assert.equal(
    [...fs.files.keys()].some((path) => path.endsWith('.drain')),
    false
  )
  assert.equal(recoveryPaths(fs.files).length, 1)

  acknowledgeSignalSource(fs, 'codex')
  assert.equal(recoveryPaths(fs.files).length, 0)
})

test('acknowledging a completed source does not erase a signal queued during its sync', () => {
  const fs = runtime({
    '/state/notify.signal.d/codex.json': signal('codex')
  })

  assert.deepEqual(drainSignalSources(fs), ['codex'])
  appendSignal(fs, { source: 'codex' })
  acknowledgeSignalSource(fs, 'codex')

  assert.equal(recoveryPaths(fs.files).length, 0)
  assert.equal(fs.files.has('/state/notify.signal.d/codex.json'), true)
  assert.deepEqual(readSignalSources(fs), ['codex'])
})

test('drains legacy per-event queue files and retained drains through the recovery journal', () => {
  const fs = runtime({
    '/state/notify.signal.d/1785302092394-95086-5lxdll72uc.json': signal('codex'),
    '/state/notify.signal.d/1785302092395-95087-r5z2h9.json.900.1.deadbeef.drain': signal('claude-code')
  })

  assert.deepEqual(drainSignalSources(fs), ['codex', 'claude-code'])
  assert.equal(fs.files.has('/state/notify.signal.d/1785302092394-95086-5lxdll72uc.json'), false)
  assert.equal(fs.files.has('/state/notify.signal.d/1785302092395-95087-r5z2h9.json.900.1.deadbeef.drain'), false)
  assert.deepEqual(readSignalSources(fs), ['claude-code', 'codex'])

  acknowledgeSignalSource(fs, 'codex')
  acknowledgeSignalSource(fs, 'claude-code')
  assert.deepEqual(readSignalSources(fs), [])
})

test('signal drain tolerates a drained file removed by another worker', () => {
  let reads = 0
  const fs = runtime(
    {
      '/state/notify.signal.900.1.deadbeef.drain': signal('codex')
    },
    {
      readFile(path) {
        reads += 1
        if (path.endsWith('.drain')) {
          const error = new Error('drained signal already consumed')
          error.code = 'ENOENT'
          throw error
        }
        return fs.files.get(path)
      }
    }
  )

  assert.deepEqual(drainSignalSources(fs), [])
  assert.equal(reads, 1)
})

test('clears a temp file stranded by an interrupted earlier write', () => {
  // The name has to match what writeQueuedSignal actually produces — `${now}-${pid}-${rand}.tmp`
  // with no leading dot — or the scan is being tested against a shape it never sees.
  const fs = runtime(
    { '/state/notify.signal.d/1790054369308-85297-kuufxwmgi5f.tmp': '' },
    { isProcessAlive: (pid) => pid !== 85297 }
  )

  appendSignal(fs, { source: 'codex' })

  const strays = [...fs.files.keys()].filter((path) => path.endsWith('.tmp'))
  assert.deepEqual(strays, [])
  assert.ok(fs.files.has('/state/notify.signal.d/codex.json'))
})

// The notify hook writes its temp file with a leading dot, unlike coordinator-signal's own
// writer. Both land in this directory. If the scan cannot read the hook's name it sees no
// owner, and an ownerless file used to be deleted outright — killing a signal whose writer
// was still between writeFile and rename.
test('does not delete the notify hook temp file naming scheme', () => {
  const hookTemp = '/state/notify.signal.d/.1785302092394-901-livehook.tmp'
  const fs = runtime({ [hookTemp]: '' })

  appendSignal(fs, { source: 'codex' })

  assert.ok(fs.files.has(hookTemp), "the hook's in-flight temp file must survive the orphan scan")
})

test('still collects a dead hook temp file', () => {
  const deadHookTemp = '/state/notify.signal.d/.1785302092394-424242-deadhook.tmp'
  const fs = runtime({ [deadHookTemp]: '' }, { isProcessAlive: (pid) => pid !== 424242 })

  appendSignal(fs, { source: 'codex' })

  assert.equal(fs.files.has(deadHookTemp), false, "a dead hook writer's temp file is an orphan")
})

// A pid is not a stable identity — the kernel reuses it. A file left by a killed writer
// can look owned by whatever later took its pid, and then never gets collected: one stray
// entry per interruption, without bound. The name records when it was written, so a
// process that started *after* that moment cannot have been the writer.
test('collects a temp file whose pid was reused by a later process', () => {
  const writtenAt = Date.parse('2026-07-29T00:00:00.000Z')
  const reused = `/state/notify.signal.d/${writtenAt}-5150-reused.tmp`
  const fs = runtime(
    { [reused]: '' },
    {
      // Alive — but it is a different process that inherited the pid an hour later.
      isProcessAlive: () => true,
      readProcessStartIdentity: () => `darwin:${Math.floor(writtenAt / 1000) + 3600}:0`
    }
  )

  appendSignal(fs, { source: 'codex' })

  assert.equal(fs.files.has(reused), false, 'a reused pid must not keep an orphan alive forever')
})

// The mirror: a process that started before the file was written really could be its
// writer, so the file stays.
test('keeps a temp file whose live owner started before the write', () => {
  const writtenAt = Date.parse('2026-07-29T00:00:00.000Z')
  const live = `/state/notify.signal.d/${writtenAt}-5151-live.tmp`
  const fs = runtime(
    { [live]: '' },
    {
      isProcessAlive: () => true,
      readProcessStartIdentity: () => `darwin:${Math.floor(writtenAt / 1000) - 60}:0`
    }
  )

  appendSignal(fs, { source: 'codex' })

  assert.ok(fs.files.has(live), 'a genuine in-flight writer must keep its temp file')
})

// An identity the code cannot turn into an instant is not evidence of reuse. The file has
// to survive, because the alternative is deleting a live writer's only copy.
test('keeps a temp file when the owner start time cannot be determined', () => {
  const writtenAt = Date.parse('2026-07-29T00:00:00.000Z')
  const unknown = `/state/notify.signal.d/${writtenAt}-5152-unknown.tmp`
  const fs = runtime(
    { [unknown]: '' },
    {
      isProcessAlive: () => true,
      readProcessStartIdentity: () => ({ status: 'unknown' })
    }
  )

  appendSignal(fs, { source: 'codex' })

  assert.ok(fs.files.has(unknown), 'an inconclusive identity must not authorise deletion')
})

// A probe that throws is the same as an inconclusive one.
test('keeps a temp file when the owner identity probe throws', () => {
  const writtenAt = Date.parse('2026-07-29T00:00:00.000Z')
  const throwing = `/state/notify.signal.d/${writtenAt}-5153-throwing.tmp`
  const fs = runtime(
    { [throwing]: '' },
    {
      isProcessAlive: () => true,
      readProcessStartIdentity: () => {
        throw new Error('EPERM')
      }
    }
  )

  appendSignal(fs, { source: 'codex' })

  assert.ok(fs.files.has(throwing), 'a throwing probe must not authorise deletion')
})

// A name the scan cannot parse yields no owner, and no owner is not proof of death.
// Treating it as an orphan deletes a file this code cannot show is safe to remove.
test('keeps a temp file whose name yields no owner pid', () => {
  const unparseable = '/state/notify.signal.d/tmp-without-a-pid.tmp'
  const fs = runtime({ [unparseable]: '' })

  appendSignal(fs, { source: 'codex' })

  assert.ok(fs.files.has(unparseable), 'an unparseable owner must not authorise deletion')
})

test('removes the temp file when the write itself fails after creating it', () => {
  const fs = runtime({})
  const writeFile = fs.writeFile
  fs.writeFile = (path, value, options) => {
    if (memoryPathIncludes(path, '.tmp')) {
      // Simulate a short write: the file exists, then the call fails.
      writeFile(path, '', options)
      const error = new Error('ENOSPC')
      error.code = 'ENOSPC'
      throw error
    }
    return writeFile(path, value, options)
  }

  assert.throws(() => appendSignal(fs, { source: 'codex' }), /ENOSPC/)
  assert.deepEqual(
    [...fs.files.keys()].filter((path) => path.endsWith('.tmp')),
    []
  )
})

// Two hooks can start within the same millisecond, so one invocation's orphan scan
// runs while another has written its temp file but not yet renamed it. Deleting
// that file makes the other rename fail and silently drops its signal.
test('does not delete a temp file another invocation is still writing', () => {
  const competing = '/state/notify.signal.d/1-901-competing.tmp'
  const fs = runtime({ [competing]: signal('claude-code') })

  appendSignal(fs, { source: 'codex' })

  // The competing invocation is still in flight, so its temp file has to survive:
  // it is the only thing its rename can move into place.
  assert.ok(fs.files.has(competing), 'the competing invocation must not lose its temp file')
})

// Liveness has to stay conservative: an inconclusive answer must never be read as
// "dead", because that deletes a temp file a live invocation still needs. Only the
// kernel's explicit "no such process" (ESRCH) proves the owner is gone.
test('treats an inconclusive liveness probe as alive', () => {
  const inconclusive = '/state/notify.signal.d/1-777-einval.tmp'
  const fs = runtime({ [inconclusive]: '' })
  // A probe that cannot answer (EINVAL, or a throw) must not authorise deletion.
  fs.process = {
    pid: 901,
    kill: () => {
      const e = new Error('EINVAL')
      e.code = 'EINVAL'
      throw e
    }
  }

  appendSignal(fs, { source: 'codex' })

  assert.ok(fs.files.has(inconclusive), 'an inconclusive probe must not delete the temp file')
})

// The scan exists for temp files left by a process that died mid-write. Those have
// to keep being collected, or the queue grows a stray entry per interruption.
test('still clears a temp file whose owning process is gone', () => {
  const dead = '/state/notify.signal.d/1-424242-dead.tmp'
  const fs = runtime({ [dead]: '' }, { isProcessAlive: (pid) => pid !== 424242 })

  appendSignal(fs, { source: 'codex' })

  assert.equal(fs.files.has(dead), false, "a dead owner's temp file is an orphan")
})

test('leaves the queue usable when it cannot be listed for orphan cleanup', () => {
  const fs = runtime({})
  fs.readdir = () => {
    const error = new Error('EACCES')
    error.code = 'EACCES'
    throw error
  }

  appendSignal(fs, { source: 'codex' })

  assert.ok(fs.files.has('/state/notify.signal.d/codex.json'))
})
