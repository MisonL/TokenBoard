import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  lastSeenCliDbRowIndexByCascadeHash,
  markCliDbRowsProcessed
} from './antigravity-cli-db-cursor'
import { resolveAntigravityCollectionRange } from './antigravity-since'
import type { CursorState } from './session-cursor-store'

describe('Antigravity CLI database cursor scopes', () => {
  test('preserves all reusable row cursors when a bounded scope moves forward', () => {
    const earlierScope = resolveAntigravityCollectionRange({ since: '20260601', timezone: 'UTC' }).historyScope
    const currentScope = resolveAntigravityCollectionRange({ since: '20260624', timezone: 'UTC' }).historyScope
    const cursor: CursorState = {
      version: 1,
      source: 'antigravity-cli',
      files: {}
    }

    markCliDbRowsProcessed({
      cursor,
      historyScope: earlierScope,
      lastReadRowIndexByCascade: new Map([
        ['cascade-a', 4],
        ['cascade-b', 7]
      ])
    })
    markCliDbRowsProcessed({
      cursor,
      historyScope: currentScope,
      lastReadRowIndexByCascade: new Map([['cascade-a', 5]])
    })

    expect(lastSeenCliDbRowIndexByCascadeHash({
      cursor,
      historyScope: currentScope
    })).toEqual(new Map([
      [sha256('cascade-a'), 5],
      [sha256('cascade-b'), 7]
    ]))
  })

  test('keeps bounded row cursors separate from the all-scope cursor', () => {
    const boundedScope = resolveAntigravityCollectionRange({ since: '20260624', timezone: 'UTC' }).historyScope
    const cursor: CursorState = {
      version: 1,
      source: 'antigravity-cli',
      files: {}
    }

    markCliDbRowsProcessed({
      cursor,
      historyScope: 'all',
      lastReadRowIndexByCascade: new Map([['cascade-a', 4]])
    })
    markCliDbRowsProcessed({
      cursor,
      historyScope: boundedScope,
      lastReadRowIndexByCascade: new Map([['cascade-a', 7]])
    })

    expect(Object.keys(cursor.files).some((key) => key.includes('since:'))).toBe(true)
    expect(lastSeenCliDbRowIndexByCascadeHash({
      cursor,
      historyScope: boundedScope
    })).toEqual(new Map([[sha256('cascade-a'), 7]]))
  })

  test('prunes row cursors for cascades absent from a successfully enumerated directory', () => {
    const boundedScope = resolveAntigravityCollectionRange({ since: '20260624', timezone: 'UTC' }).historyScope
    const cursor: CursorState = {
      version: 1,
      source: 'antigravity-cli',
      files: {}
    }

    markCliDbRowsProcessed({
      cursor,
      historyScope: 'all',
      lastReadRowIndexByCascade: new Map([
        ['cascade-a', 4],
        ['cascade-b', 7]
      ])
    })
    markCliDbRowsProcessed({
      cursor,
      historyScope: boundedScope,
      lastReadRowIndexByCascade: new Map([
        ['cascade-a', 5],
        ['cascade-b', 8]
      ])
    })

    markCliDbRowsProcessed({
      cursor,
      historyScope: boundedScope,
      knownCascadeIds: new Set(['cascade-a']),
      lastReadRowIndexByCascade: new Map([['cascade-a', 6]])
    })

    expect(lastSeenCliDbRowIndexByCascadeHash({
      cursor,
      historyScope: boundedScope
    })).toEqual(new Map([[sha256('cascade-a'), 6]]))
    expect(Object.keys(cursor.files).some((key) => key.includes(sha256('cascade-b')))).toBe(false)
  })

  test('retains row cursors when the reader has no complete directory listing', () => {
    const cursor: CursorState = {
      version: 1,
      source: 'antigravity-cli',
      files: {}
    }

    markCliDbRowsProcessed({
      cursor,
      historyScope: 'all',
      lastReadRowIndexByCascade: new Map([
        ['cascade-a', 4],
        ['cascade-b', 7]
      ])
    })
    markCliDbRowsProcessed({
      cursor,
      historyScope: 'all',
      lastReadRowIndexByCascade: new Map([['cascade-a', 5]])
    })

    expect(lastSeenCliDbRowIndexByCascadeHash({ cursor })).toEqual(new Map([
      [sha256('cascade-a'), 5],
      [sha256('cascade-b'), 7]
    ]))
  })
})

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
