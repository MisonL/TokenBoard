-- Undo the never-opted-in public flips from 0005/0006.
--
-- This migration is one-way on purpose: it overwrites `updated_at`, which is the only thing
-- that could distinguish a row it flipped from a row the user set private afterwards, and
-- "rolling back" would re-publish users who never chose to be public. Do not add a reverse
-- migration for it.
--
-- Two historical defaults made profiles public without the user ever saving settings:
-- 0006 set is_public = participates_in_leaderboards = 1 on every row that still had
-- updated_at = created_at, and until the private default returned, ensureProfile inserted
-- new rows with 1/1. The current contract is that public display is opt-in, so rows that
-- never recorded a choice go back to private. Rows the user saved are untouched.
--
-- A row counts as never-opted-in only when it is still 1/1 and one of these signatures
-- holds:
--   * updated_at = created_at: untouched since profile creation. A settings save always
--     writes a fresh updated_at, and profile creation cannot be the same millisecond as
--     a later settings save.
--   * timezone_source <> 'user': only profile creation writes 'default' / 'browser' and
--     every settings save writes 'user', so this catches rows whose only later touch was
--     the browser-timezone backfill.
--   * updated_at is shared with another 1/1 row: 0006 stamped every row it flipped with a
--     single strftime value, so flipped rows carry one identical millisecond timestamp
--     that per-user saves do not reproduce.
-- A row whose 0006 flip is its only update but which is the sole such row in the database
-- cannot be told apart from a saved choice and deliberately stays public.
UPDATE profiles
SET
  is_public = 0,
  participates_in_leaderboards = 0,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE is_public = 1
  AND participates_in_leaderboards = 1
  AND (
    updated_at = created_at
    OR timezone_source <> 'user'
    OR updated_at IN (
      SELECT updated_at
      FROM profiles
      WHERE is_public = 1
        AND participates_in_leaderboards = 1
        AND updated_at <> created_at
      GROUP BY updated_at
      HAVING COUNT(*) > 1
    )
  );
