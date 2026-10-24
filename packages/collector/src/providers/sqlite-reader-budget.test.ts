import { describe, expect, test, vi } from 'vitest'

// Captures the `maxBuffer` handed to the `sqlite3` executable on each read, so both external
// paths can be checked without a real database. The JSON and text readers share one output
// ceiling; a caller that raises `maxOutputBytes` (the Antigravity sources do) must see it reach
// the executable on *both*, or the two readers disagree about what can be read.
const { recordedMaxBuffers } = vi.hoisted(() => ({ recordedMaxBuffers: [] as number[] }))

vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    _args: string[],
    options: { maxBuffer?: number },
    callback: (error: Error | null, result: { stdout: string; stderr: string }) => void
  ) => {
    recordedMaxBuffers.push(options.maxBuffer ?? -1)
    // A syntactically valid empty result for both `-json` and text modes.
    callback(null, { stdout: '[]', stderr: '' })
  }
}))

import { querySqliteJsonRows, querySqliteText } from './sqlite-reader'

describe('external sqlite output ceiling', () => {
  test('applies the caller ceiling to the JSON reader', async () => {
    recordedMaxBuffers.length = 0

    await querySqliteJsonRows('/tmp/any.db', 'select 1', {
      label: 'Probe',
      forceExternalSqlite: true,
      maxOutputBytes: 5 * 1024 * 1024
    })

    expect(recordedMaxBuffers).toEqual([5 * 1024 * 1024])
  })

  test('applies the caller ceiling to the text reader', async () => {
    recordedMaxBuffers.length = 0

    await querySqliteText('/tmp/any.db', 'select 1', {
      label: 'Probe',
      forceExternalSqlite: true,
      maxOutputBytes: 7 * 1024 * 1024
    })

    expect(recordedMaxBuffers).toEqual([7 * 1024 * 1024])
  })

  test('falls back to the shared default when the caller sets no ceiling', async () => {
    recordedMaxBuffers.length = 0

    await querySqliteJsonRows('/tmp/any.db', 'select 1', { label: 'Probe', forceExternalSqlite: true })

    expect(recordedMaxBuffers).toEqual([64 * 1024 * 1024])
  })
})
