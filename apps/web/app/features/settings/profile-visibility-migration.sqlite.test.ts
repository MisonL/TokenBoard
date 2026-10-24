import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { runSql } from '../../test/sqlite-d1'

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations')
const revertMigrationFile = '0035_revert_default_public_profiles.sql'

// 0005/0006 made never-touched profiles public by default; 0035 restores the opt-in
// contract for rows that still carry no trace of a settings save. These fixtures cover
// every signature the migration matches on and the rows it must leave alone, including
// the documented gap: a sole flipped row is indistinguishable from a saved choice.
describe('revert default public profiles migration', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('reverts never-opted-in rows and keeps recorded choices', () => {
    const path = createDb(tempDirs)
    seedProfiles(path)

    runSql(path, `.read ${quoteSqlitePath(join(migrationsDir, revertMigrationFile))}`)

    expect(states(path)).toEqual([
      'browser-bumped:0:0',
      'flip-a:0:0',
      'flip-b:0:0',
      'never-touched:0:0',
      'never-touched-default:0:0',
      'private:0:0',
      'public-only:1:0',
      'saved-public:1:1',
      'sole-flip:1:1'
    ])

    const keptTimestamps = runSql(
      path,
      `SELECT slug || ':' || updated_at FROM profiles
       WHERE slug IN ('private','public-only','saved-public','sole-flip') ORDER BY slug`
    )
      .trim()
      .split('\n')
    expect(keptTimestamps).toEqual([
      'private:2026-05-10T00:00:03.000Z',
      'public-only:2026-05-10T00:00:04.000Z',
      'saved-public:2026-05-01T10:00:00.000Z',
      'sole-flip:2026-04-29T08:00:00.456Z'
    ])

    // Every reverted row carries the one timestamp the migration wrote, distinct from
    // the shared 0006 flip stamp it replaced.
    const revertedStamps = runSql(
      path,
      `SELECT DISTINCT updated_at FROM profiles
       WHERE slug IN ('never-touched','never-touched-default','browser-bumped','flip-a','flip-b')`
    )
      .trim()
      .split('\n')
    expect(revertedStamps).toHaveLength(1)
    expect(revertedStamps[0]).not.toBe('2026-04-29T08:00:00.123Z')

    runSql(path, `.read ${quoteSqlitePath(join(migrationsDir, revertMigrationFile))}`)
    expect(states(path)).toEqual([
      'browser-bumped:0:0',
      'flip-a:0:0',
      'flip-b:0:0',
      'never-touched:0:0',
      'never-touched-default:0:0',
      'private:0:0',
      'public-only:1:0',
      'saved-public:1:1',
      'sole-flip:1:1'
    ])
  })
})

function createDb(tempDirs: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'tokenboard-profile-visibility-'))
  tempDirs.push(dir)
  const path = join(dir, 'test.sqlite')
  const chain = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
  const boundary = chain.indexOf(revertMigrationFile)
  if (boundary < 0) throw new Error(`Missing migration fixture boundary: ${revertMigrationFile}`)
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
      ('u1','u1@example.com','U1',0,'2026-04-01','2026-04-01'),
      ('u2','u2@example.com','U2',0,'2026-04-01','2026-04-01'),
      ('u3','u3@example.com','U3',0,'2026-04-01','2026-04-01'),
      ('u4','u4@example.com','U4',0,'2026-04-01','2026-04-01'),
      ('u5','u5@example.com','U5',0,'2026-04-01','2026-04-01'),
      ('u6','u6@example.com','U6',0,'2026-04-01','2026-04-01'),
      ('u7','u7@example.com','U7',0,'2026-04-01','2026-04-01'),
      ('u8','u8@example.com','U8',0,'2026-04-01','2026-04-01'),
      ('u9','u9@example.com','U9',0,'2026-04-01','2026-04-01');

    INSERT INTO profiles (
      user_id, slug, display_name, timezone, is_public, participates_in_leaderboards,
      timezone_source, created_at, updated_at
    )
    VALUES
      ('u1','never-touched','Never Touched','UTC',1,1,'user','2026-05-10T00:00:00.000Z','2026-05-10T00:00:00.000Z'),
      ('u2','never-touched-default','Never Touched Default','UTC',1,1,'default','2026-05-10T00:00:01.000Z','2026-05-10T00:00:01.000Z'),
      ('u3','browser-bumped','Browser Bumped','UTC',1,1,'browser','2026-05-10T00:00:02.000Z','2026-06-01T09:30:00.000Z'),
      ('u4','flip-a','Flip A','UTC',1,1,'user','2026-04-20T08:00:00.000Z','2026-04-29T08:00:00.123Z'),
      ('u5','flip-b','Flip B','UTC',1,1,'user','2026-04-20T09:00:00.000Z','2026-04-29T08:00:00.123Z'),
      ('u6','saved-public','Saved Public','UTC',1,1,'user','2026-04-20T10:00:00.000Z','2026-05-01T10:00:00.000Z'),
      ('u7','sole-flip','Sole Flip','UTC',1,1,'user','2026-04-20T11:00:00.000Z','2026-04-29T08:00:00.456Z'),
      ('u8','private','Private','UTC',0,0,'user','2026-05-10T00:00:03.000Z','2026-05-10T00:00:03.000Z'),
      ('u9','public-only','Public Only','UTC',1,0,'user','2026-05-10T00:00:04.000Z','2026-05-10T00:00:04.000Z');
  `
  )
}

function states(path: string) {
  return runSql(
    path,
    `SELECT slug || ':' || is_public || ':' || participates_in_leaderboards AS state
     FROM profiles ORDER BY slug`
  )
    .trim()
    .split('\n')
}

function quoteSqlitePath(path: string) {
  return `'${path.replaceAll("'", "''")}'`
}
