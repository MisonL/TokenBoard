import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createSqliteD1, runSql } from './sqlite-d1'

describe('sqlite D1 test adapter', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('binds ISO date strings as strings instead of sqlite expressions', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-sqlite-d1-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'adapter.db')
    runSql(dbPath, 'CREATE TABLE events (usage_date TEXT NOT NULL);')

    const db = createSqliteD1(dbPath)
    await db.prepare('INSERT INTO events (usage_date) VALUES (?)').bind('2026-06-02').run()

    const row = await db.prepare('SELECT usage_date as value FROM events').bind().first<{ value: string }>()

    expect(row?.value).toBe('2026-06-02')
  })

  test('accepts a trailing semicolon in first queries', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-sqlite-d1-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'adapter.db')
    runSql(dbPath, "CREATE TABLE events (usage_date TEXT NOT NULL); INSERT INTO events VALUES ('2026-06-02');")

    const db = createSqliteD1(dbPath)
    const row = await db.prepare('SELECT usage_date AS value FROM events;').bind().first<{ value: string }>()

    expect(row?.value).toBe('2026-06-02')
  })

  test('binds JSON strings with quotes as string values', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-sqlite-d1-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'adapter.db')
    runSql(dbPath, 'CREATE TABLE payloads (value TEXT NOT NULL);')

    const value = JSON.stringify([{ label: "Alice's report", total: 1200 }])
    const db = createSqliteD1(dbPath)
    await db.prepare('INSERT INTO payloads (value) VALUES (?)').bind(value).run()

    const row = await db.prepare('SELECT value FROM payloads').bind().first<{ value: string }>()

    expect(row?.value).toBe(value)
  })

  test('parses result sets with brackets inside string values', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-sqlite-d1-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'adapter.db')
    runSql(dbPath, 'CREATE TABLE payloads (value TEXT NOT NULL);')

    const db = createSqliteD1(dbPath)
    await db.prepare('INSERT INTO payloads (value) VALUES (?), (?)').bind('alpha [beta] gamma', 'tail').run()

    const rows = await db.prepare('SELECT value FROM payloads ORDER BY value').bind().all<{ value: string }>()

    expect(rows.results.map((row) => row.value)).toEqual(['alpha [beta] gamma', 'tail'])
  })

  test('reports changes when run executes a returning statement', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-sqlite-d1-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'adapter.db')
    runSql(dbPath, 'CREATE TABLE events (id TEXT NOT NULL);')

    const db = createSqliteD1(dbPath)
    const result = await db.prepare('INSERT INTO events (id) VALUES (?) RETURNING id').bind('evt_1').run()

    expect(result.meta.changes).toBe(1)
    expect(result.results).toEqual([{ id: 'evt_1' }])
  })

  test('returns rows when run executes a select statement', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-sqlite-d1-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'adapter.db')
    runSql(dbPath, "CREATE TABLE events (id TEXT NOT NULL); INSERT INTO events VALUES ('evt_1');")

    const db = createSqliteD1(dbPath)
    const result = await db.prepare('SELECT id FROM events').bind().run()

    expect(result.meta.changes).toBe(0)
    expect(result.results).toEqual([{ id: 'evt_1' }])
  })

  test('ignores question marks inside SQL literals and comments', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-sqlite-d1-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'adapter.db')

    const result = runSql(
      dbPath,
      [
        '.parameter init',
        ".parameter set ?1 'bound value'",
        "SELECT '?' AS literal, ? AS bound, '-- ?' AS line_literal /* ? block literal */;"
      ].join('\n')
    )

    expect(result.trim()).toBe('?|bound value|-- ?')
  })

  test('supports SQLite numbered and anonymous parameter slots', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-sqlite-d1-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'adapter.db')

    const result = runSql(
      dbPath,
      [
        '.parameter init',
        '.parameter set ?3 third',
        '.parameter set ?4 fourth',
        'SELECT ?3 AS explicit, ? AS anonymous;'
      ].join('\n')
    )

    expect(result.trim()).toBe('third|fourth')
  })

  test('clears SQLite parameter bindings when the parameter table is deleted', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-sqlite-d1-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'adapter.db')

    const result = runSql(
      dbPath,
      [
        '.parameter init',
        ".parameter set ?1 'stale value'",
        'SELECT ?1 AS value;',
        'DELETE FROM temp.sqlite_parameters;',
        'SELECT ?1 AS value;'
      ].join('\n')
    )

    expect(result).toBe('stale value\n\n')
  })

  test('preserves tabs and RFC 4180 CSV output modes', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-sqlite-d1-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'adapter.db')

    const result = runSql(
      dbPath,
      [
        'CREATE TABLE values_table (first TEXT, second TEXT);',
        `INSERT INTO values_table VALUES ('left', 'right'), ('comma,quote"line', 'tail');`,
        '.mode tabs',
        'SELECT first, second FROM values_table ORDER BY rowid;',
        '.mode csv',
        'SELECT first, second FROM values_table ORDER BY rowid;'
      ].join('\n')
    )

    expect(result).toBe('left\tright\ncomma,quote"line\ttail\nleft,right\n"comma,quote""line",tail\n')
  })

  test('keeps trigger statements intact when the body contains a CASE expression', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-sqlite-d1-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'adapter.db')

    const result = runSql(
      dbPath,
      `
        CREATE TABLE source (id INTEGER PRIMARY KEY, label TEXT);
        CREATE TABLE audit (source_id INTEGER PRIMARY KEY, label TEXT);
        CREATE TRIGGER source_audit AFTER INSERT ON source
        BEGIN
          INSERT INTO audit (source_id, label)
          SELECT NEW.id, CASE WHEN NEW.id = 1 THEN 'first' ELSE 'other' END;
        END;
        INSERT INTO source (id, label) VALUES (1, 'ignored');
        SELECT label FROM audit WHERE source_id = 1;
      `
    )

    expect(result.trim()).toBe('first')
  })

  test('preserves boolean bindings and rejects undefined bindings explicitly', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-sqlite-d1-'))
    tempDirs.push(tempDir)
    const dbPath = join(tempDir, 'adapter.db')
    runSql(dbPath, 'CREATE TABLE flags (enabled INTEGER NOT NULL);')

    const db = createSqliteD1(dbPath)
    await db.prepare('INSERT INTO flags (enabled) VALUES (?)').bind(true).run()
    const row = await db.prepare('SELECT enabled AS value FROM flags').bind().first<{ value: number }>()

    expect(row?.value).toBe(1)
    await expect(db.prepare('INSERT INTO flags (enabled) VALUES (?)').bind(undefined).run()).rejects.toThrow(
      'Unsupported sqlite test binding type: undefined'
    )
  })
})
