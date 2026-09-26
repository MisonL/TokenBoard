import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { assertWithinOutputBudget, querySqliteText } from './sqlite-reader'

// `querySqliteText` exists so a caller whose SQL renders its result set as text (the
// Antigravity sources parse `idx|hex` lines) can still benefit from `node:sqlite`, which
// needs nothing installed. The contract is that both readers produce the *same bytes* — a
// cursor hashes that text, so a rendering difference would silently change row identity
// depending on which reader ran.
describe('querySqliteText', () => {
  test('renders rows exactly as the sqlite3 executable does', async () => {
    let sqlite: typeof import('node:sqlite')
    try {
      sqlite = await import('node:sqlite')
    } catch {
      return // Runtime without node:sqlite; the executable path is covered elsewhere.
    }

    const root = await mkdtemp(join(tmpdir(), 'tokenboard-sqlite-text-'))
    try {
      const dbPath = join(root, 'probe.db')
      const seed = new sqlite.DatabaseSync(dbPath)
      seed.exec('CREATE TABLE t (n INTEGER, b BLOB, s TEXT);')
      // Every shape the CLI renders differently: a blob through hex(), a null column, an
      // empty blob, a string containing the delimiter, and a multi-byte value.
      seed.exec("INSERT INTO t VALUES (1, x'0A0B0C', 'a|b'), (2, NULL, ''), (3, x'', '多字节'), (4, NULL, NULL);")
      seed.close()

      const queries = [
        'select n, hex(b) from t order by n',
        'select max(n) from t',
        'select n, s from t order by n',
        'select n from t where n > 999'
      ]
      for (const sql of queries) {
        const builtin = await querySqliteText(dbPath, sql, { label: 'Probe' })
        const external = await querySqliteText(dbPath, sql, { label: 'Probe', forceExternalSqlite: true })
        expect(builtin, `readers disagree for: ${sql}`).toBe(external)
      }

      // And the rendering itself, so a change to both readers at once cannot hide here.
      expect(await querySqliteText(dbPath, 'select n, hex(b) from t order by n', { label: 'Probe' })).toBe(
        '1|0A0B0C\n2|\n3|\n4|\n'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // `maxBuffer` caps the executable's stdout. Without the same ceiling in-process, the
  // reader that is supposed to be the *default* would succeed on a result set the forced
  // external reader fails on — so `TOKENBOARD_SQLITE_BIN`, documented as choosing how to
  // read rather than what can be read, would change the outcome.
  test('applies the executable output ceiling to the in-process reader too', async () => {
    // Driven through `querySqliteText` rather than the helper, so this fails if the reader
    // stops enforcing the budget — calling the helper directly would pass either way. The
    // data is built with a recursive CTE inside SQLite rather than in JS so the test's own
    // allocation stays small; the row count is kept to the minimum that crosses 64 MiB.
    let sqlite: typeof import('node:sqlite')
    try {
      sqlite = await import('node:sqlite')
    } catch {
      return
    }

    const root = await mkdtemp(join(tmpdir(), 'tokenboard-sqlite-budget-'))
    try {
      const dbPath = join(root, 'big.db')
      const seed = new sqlite.DatabaseSync(dbPath)
      seed.exec('CREATE TABLE t (s TEXT);')
      seed.exec(
        'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 20) INSERT INTO t SELECT hex(zeroblob(2 * 1024 * 1024)) FROM c;'
      )
      seed.close()

      await expect(querySqliteText(dbPath, 'select s from t', { label: 'Probe' })).rejects.toThrow(/exceeded \d+ bytes/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reports the executable as unavailable when it is missing', async () => {
    await expect(
      querySqliteText('/tmp/does-not-matter.db', 'select 1', {
        label: 'Probe',
        forceExternalSqlite: true,
        sqliteBin: 'tokenboard-sqlite3-does-not-exist'
      })
    ).rejects.toThrow('Probe SQLite reader unavailable')
  })

  test('prefers the injected reader so callers keep control of the query path', async () => {
    const result = await querySqliteText('/tmp/ignored.db', 'select 1', {
      label: 'Probe',
      runQuery: async () => 'injected\n'
    })
    expect(result).toBe('injected\n')
  })
})
