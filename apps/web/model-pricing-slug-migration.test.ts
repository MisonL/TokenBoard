import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'

const migrationsDir = resolve(import.meta.dirname, 'db/migrations')
const targetMigration = '0032_reserved_model_pricing_slug.sql'

describe('reserved model pricing slug migration', () => {
  test('does not change profiles when the reserved slug is unused', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-slug-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      applyMigrationsBeforeTarget(dbPath)
      const before = profileSlugs(dbPath)
      runSqlite(dbPath, readFileSync(join(migrationsDir, targetMigration), 'utf8'))
      expect(profileSlugs(dbPath)).toBe(before)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('renames a legacy profile to the stable default slug and is idempotent', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-slug-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      applyMigrationsBeforeTarget(dbPath)
      insertProfile(dbPath, 'legacy-user', 'model-pricing', 'Legacy Pricing')
      const migration = readFileSync(join(migrationsDir, targetMigration), 'utf8')

      runSqlite(dbPath, migration)
      expect(profileSlug(dbPath, 'legacy-user')).toBe('model-pricing-legacy')
      expect(profileUpdatedAt(dbPath, 'legacy-user')).not.toBe('2026-09-16T00:00:00.000Z')
      runSqlite(dbPath, migration)
      expect(profileSlug(dbPath, 'legacy-user')).toBe('model-pricing-legacy')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('repairs a case-variant legacy reserved slug', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-slug-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      applyMigrationsBeforeTarget(dbPath)
      insertProfile(dbPath, 'legacy-user', 'Model-Pricing', 'Legacy Pricing')
      runSqlite(dbPath, readFileSync(join(migrationsDir, targetMigration), 'utf8'))

      expect(profileSlug(dbPath, 'legacy-user')).toBe('model-pricing-legacy')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('renames multiple legacy variants without colliding on a shared user-id prefix', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-slug-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      applyMigrationsBeforeTarget(dbPath)
      insertProfile(dbPath, 'legacy-user-1', 'model-pricing', 'Legacy Pricing 1')
      insertProfile(dbPath, 'legacy-user-2', 'Model-Pricing', 'Legacy Pricing 2')
      runSqlite(dbPath, readFileSync(join(migrationsDir, targetMigration), 'utf8'))

      expect(profileSlug(dbPath, 'legacy-user-1')).toBe('model-pricing-legacy')
      expect(profileSlug(dbPath, 'legacy-user-2')).toBe('model-pricing-legacy-6c656760002')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('skips occupied deterministic candidates without colliding with another legacy row', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-slug-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      applyMigrationsBeforeTarget(dbPath)
      insertProfile(dbPath, 'legacy-user-1', 'model-pricing', 'Legacy Pricing 1')
      insertProfile(dbPath, 'legacy-user-2', 'Model-Pricing', 'Legacy Pricing 2')
      insertProfile(dbPath, 'existing-user', 'model-pricing-legacy-6c656760002', 'Existing Legacy')
      runSqlite(dbPath, readFileSync(join(migrationsDir, targetMigration), 'utf8'))

      expect(profileSlug(dbPath, 'legacy-user-1')).toBe('model-pricing-legacy')
      expect(profileSlug(dbPath, 'legacy-user-2')).toBe('model-pricing-legacy-6c656760004')
      expect(profileSlug(dbPath, 'existing-user')).toBe('model-pricing-legacy-6c656760002')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('uses a deterministic bounded suffix when the default target is occupied', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-slug-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      applyMigrationsBeforeTarget(dbPath)
      insertProfile(dbPath, 'legacy-user', 'model-pricing', 'Legacy Pricing')
      insertProfile(dbPath, 'existing-user', 'model-pricing-legacy', 'Existing Legacy')
      const migration = readFileSync(join(migrationsDir, targetMigration), 'utf8')

      runSqlite(dbPath, migration)

      const migratedSlug = profileSlug(dbPath, 'legacy-user')
      expect(migratedSlug).toBe('model-pricing-legacy-6c65676' + '0001')
      expect(migratedSlug).toHaveLength(32)
      expect(migratedSlug).toMatch(/^[a-z0-9-]+$/)
      expect(profileSlug(dbPath, 'existing-user')).toBe('model-pricing-legacy')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('continues with a marked fallback when the bounded and user-id candidates are occupied', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tokenboard-model-pricing-slug-'))
    const dbPath = join(tempDir, 'tokenboard.db')

    try {
      applyMigrationsBeforeTarget(dbPath)
      insertExhaustedCandidateSet(dbPath)
      runSqlite(dbPath, readFileSync(join(migrationsDir, targetMigration), 'utf8'))

      expect(profileSlug(dbPath, 'legacy-user')).toBe('model-pricing-legacy-x00000001')
      expect(profileSlug(dbPath, 'existing-user')).toBe('model-pricing-legacy')
      expect(profileSlug(dbPath, 'occupied-fallback')).toBe('model-pricing-legacy-x6c0001')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }, 30_000)

  test('checks candidate ownership globally rather than by the migrated user', () => {
    const migration = readFileSync(join(migrationsDir, targetMigration), 'utf8')

    expect(migration).toContain('WHERE existing.slug = candidates.candidate_slug')
    expect(migration).not.toContain('existing.user_id <> profiles.user_id')
  })

  test('bounds hexadecimal fallback candidates to the profile slug limit', () => {
    const migration = readFileSync(join(migrationsDir, targetMigration), 'utf8')

    expect(migration).toContain('sequence_number <= 9999')
    expect(migration).toContain("substr(printf('%08x', sequence_number), -8)")
    expect(migration).toContain("substr(printf('%08x', sequence_number + (attempt + 1) * profile_count), -8)")
  })
})

function applyMigrationsBeforeTarget(dbPath: string) {
  for (const migration of readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql') && name < targetMigration)
    .sort()) {
    runSqlite(dbPath, readFileSync(join(migrationsDir, migration), 'utf8'))
  }
}

function insertProfile(dbPath: string, userId: string, slug: string, displayName: string) {
  runSqlite(
    dbPath,
    `
      INSERT INTO users (id, name, created_at, updated_at)
      VALUES ('${userId}', '${displayName}', '2026-09-16T00:00:00.000Z', '2026-09-16T00:00:00.000Z');
      INSERT INTO profiles (
        user_id, slug, display_name, timezone, is_public, participates_in_leaderboards, created_at, updated_at
      ) VALUES (
        '${userId}', '${slug}', '${displayName}', 'UTC', 1, 0, '2026-09-16T00:00:00.000Z', '2026-09-16T00:00:00.000Z'
      );
    `
  )
}

function insertExhaustedCandidateSet(dbPath: string) {
  const database = new DatabaseSync(dbPath)
  try {
    database.exec('PRAGMA foreign_keys = ON; BEGIN;')
    const insertUser = database.prepare(
      `INSERT INTO users (id, name, created_at, updated_at)
       VALUES (?, ?, '2026-09-16T00:00:00.000Z', '2026-09-16T00:00:00.000Z')`
    )
    const insertProfile = database.prepare(
      `INSERT INTO profiles (
         user_id, slug, display_name, timezone, is_public, participates_in_leaderboards, created_at, updated_at
       ) VALUES (?, ?, ?, 'UTC', 1, 0, '2026-09-16T00:00:00.000Z', '2026-09-16T00:00:00.000Z')`
    )

    insertUser.run('legacy-user', 'Legacy Pricing')
    insertProfile.run('legacy-user', 'model-pricing', 'Legacy Pricing')
    insertUser.run('existing-user', 'Existing Legacy')
    insertProfile.run('existing-user', 'model-pricing-legacy', 'Existing Legacy')
    insertUser.run('occupied-fallback', 'Occupied Fallback')
    insertProfile.run('occupied-fallback', 'model-pricing-legacy-x6c0001', 'Occupied Fallback')

    for (let suffix = 1; suffix <= 9999; suffix += 1) {
      const userId = `occupied-user-${suffix}`
      insertUser.run(userId, `Occupied ${suffix}`)
      insertProfile.run(userId, `model-pricing-legacy-6c65676${String(suffix).padStart(4, '0')}`, `Occupied ${suffix}`)
    }
    database.exec('COMMIT;')
  } finally {
    database.close()
  }
}

function profileSlug(dbPath: string, userId: string) {
  return runSqlite(dbPath, `SELECT slug FROM profiles WHERE user_id = '${userId}';`).stdout.trim()
}

function profileSlugs(dbPath: string) {
  return runSqlite(dbPath, 'SELECT user_id, slug FROM profiles ORDER BY user_id;').stdout.trim()
}

function profileUpdatedAt(dbPath: string, userId: string) {
  return runSqlite(dbPath, `SELECT updated_at FROM profiles WHERE user_id = '${userId}';`).stdout.trim()
}

function runSqlite(dbPath: string, sql: string) {
  const database = new DatabaseSync(dbPath)
  try {
    const trimmedSql = sql.trim().replace(/;\s*$/, '')
    if (/^SELECT\b/i.test(trimmedSql)) {
      const rows = database.prepare(trimmedSql).all() as Array<
        Record<string, string | number | null | bigint | Uint8Array>
      >
      return {
        stdout: rows
          .map((row) =>
            Object.values(row)
              .map((value) => formatSqliteOutput(value))
              .join('|')
          )
          .join('\n'),
        stderr: '',
        status: 0
      }
    }
    database.exec(`PRAGMA foreign_keys = ON;\n${sql}`)
    return { stdout: '', stderr: '', status: 0 }
  } finally {
    database.close()
  }
}

function formatSqliteOutput(value: string | number | null | bigint | Uint8Array) {
  if (value === null) return ''
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex')
  return String(value)
}
