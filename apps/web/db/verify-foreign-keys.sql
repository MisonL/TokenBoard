-- Asserts that no row in the deployed database violates a declared foreign key.
--
-- AGENTS.md requires the model-pricing deploy to apply 0030..0034 and then run the production
-- route check, the critical-schema check and a foreign-key check. D1 turns declared foreign keys
-- on by default (observed via wrangler on the deployed database: `PRAGMA foreign_keys` returns 1;
-- D1 documents PRAGMA state as per-transaction rather than a persistent database property), so
-- this is a belt-and-braces assertion rather than the only guard — it catches rows that predate a
-- constraint, or that were written on a path where enforcement was off. Either way the deploy
-- stops instead of shipping a database that disagrees with its own schema.
--
-- `PRAGMA foreign_key_check` returns one row per violation and no rows when the database is
-- clean. `abs(-9223372036854775808)` raises "integer overflow" only when the WHERE clause lets a
-- row through, which a bare `PRAGMA foreign_key_check;` could not do (a non-empty result would
-- still exit zero).
SELECT abs(-9223372036854775808)
WHERE EXISTS (
  SELECT 1 FROM pragma_foreign_key_check()
);
