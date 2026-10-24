import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { runSql } from '../../test/sqlite-d1'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')
const backfillMigrationFile = '0037_backfill_profile_display_name_from_email.sql'

// `ensureProfile` used to fall back to the full email address when a GitHub account had no
// display name, and that value is served verbatim by the public profile JSON and SVG card. The
// insert only runs on creation and its conflict clause updates timezone alone, so the already
// written rows keep the address until this migration rewrites them to the local part.
describe('backfill profile display name from email migration', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('rewrites only rows whose display name is the account email', () => {
    const path = createDb(tempDirs)
    seedProfiles(path)

    runSql(path, `.read ${quoteSqlitePath(join(migrationsDir, backfillMigrationFile))}`)

    // Only `alice` (exact address) and `carol` (case variant) match; every other row is a
    // deliberate display name or a non-email value and is left byte-for-byte alone.
    expect(displayNames(path)).toEqual([
      'alice',
      'Bob',
      'carol',
      '@example.com',
      'erin@example',
      'frank',
      'someone@example.com',
      'bob@example.com',
      'ivan'
    ])

    // The rewrite stamps a fresh updated_at, so it is distinguishable from a settings save.
    const stamps = runSql(path, `SELECT updated_at FROM profiles WHERE slug IN ('alice','carol','ivan') ORDER BY slug`)
      .trim()
      .split('\n')
    expect(new Set(stamps).size).toBe(1)
    expect(stamps[0]).not.toBe('2026-05-10T00:00:00.000Z')

    // Rerunning is idempotent: the display names no longer equal the emails, so nothing matches.
    runSql(path, `.read ${quoteSqlitePath(join(migrationsDir, backfillMigrationFile))}`)
    expect(displayNames(path)).toEqual([
      'alice',
      'Bob',
      'carol',
      '@example.com',
      'erin@example',
      'frank',
      'someone@example.com',
      'bob@example.com',
      'ivan'
    ])
  })
})

function createDb(tempDirs: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-display-name-backfill-'))
  tempDirs.push(dir)
  const path = join(dir, 'test.sqlite')
  const chain = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
  const boundary = chain.indexOf(backfillMigrationFile)
  if (boundary < 0) throw new Error(`Missing migration fixture boundary: ${backfillMigrationFile}`)
  runSql(
    path,
    chain
      .slice(0, boundary)
      .map((file) => `.read ${quoteSqlitePath(join(migrationsDir, file))}`)
      .join('\n')
  )
  return path
}

function seedProfiles(path: string) {
  runSql(
    path,
    `
    INSERT INTO users (id, email, name, email_verified, created_at, updated_at)
    VALUES
      ('u1','alice@example.com','',0,'2026-04-01','2026-04-01'),
      ('u2','bob@example.com','Bob',0,'2026-04-01','2026-04-01'),
      ('u3','carol@example.com','',0,'2026-04-01','2026-04-01'),
      ('u4','dave@example.com','',0,'2026-04-01','2026-04-01'),
      ('u5','erin@example.com','',0,'2026-04-01','2026-04-01'),
      ('u6','frank@example.com','',0,'2026-04-01','2026-04-01'),
      ('u7','grace@example.com','',0,'2026-04-01','2026-04-01'),
      ('u8','heidi@example.com','',0,'2026-04-01','2026-04-01'),
      ('u9','ivan@example.com','',0,'2026-04-01','2026-04-01');

    INSERT INTO profiles (
      user_id, slug, display_name, timezone, is_public, participates_in_leaderboards,
      timezone_source, created_at, updated_at
    ) VALUES
      -- The leak: display name is exactly the stored email.
      ('u1','alice','alice@example.com','UTC',1,1,'user','2026-05-10T00:00:00.000Z','2026-05-10T00:00:00.000Z'),
      -- A real display name is never touched, even when the account has an email.
      ('u2','bob','Bob','UTC',1,1,'user','2026-05-10T00:00:01.000Z','2026-05-10T00:00:01.000Z'),
      -- Uppercase address: the match is case-insensitive, the rewrite uses the stored spelling.
      ('u3','carol','CAROL@example.com','UTC',1,1,'user','2026-05-10T00:00:02.000Z','2026-05-10T00:00:02.000Z'),
      -- No local part: not an email, left alone.
      ('u4','dave','@example.com','UTC',1,1,'user','2026-05-10T00:00:03.000Z','2026-05-10T00:00:03.000Z'),
      -- No domain dot: not an email, left alone.
      ('u5','erin','erin@example','UTC',1,1,'user','2026-05-10T00:00:04.000Z','2026-05-10T00:00:04.000Z'),
      -- No @ at all: left alone.
      ('u6','frank','frank','UTC',1,1,'user','2026-05-10T00:00:05.000Z','2026-05-10T00:00:05.000Z'),
      -- An address that is not this account's email is a deliberate display name.
      ('u7','grace','someone@example.com','UTC',1,1,'user','2026-05-10T00:00:06.000Z','2026-05-10T00:00:06.000Z'),
      -- A different account's address is not this account's email.
      ('u8','heidi','bob@example.com','UTC',1,1,'user','2026-05-10T00:00:07.000Z','2026-05-10T00:00:07.000Z'),
      -- Private profile: still rewritten, since the value is wrong regardless of visibility.
      ('u9','ivan','ivan@example.com','UTC',0,0,'user','2026-05-10T00:00:08.000Z','2026-05-10T00:00:08.000Z');
  `
  )
}

function displayNames(path: string) {
  return runSql(path, `SELECT display_name FROM profiles ORDER BY slug`).trim().split('\n')
}

function quoteSqlitePath(path: string) {
  return `'${path.replaceAll("'", "''")}'`
}
