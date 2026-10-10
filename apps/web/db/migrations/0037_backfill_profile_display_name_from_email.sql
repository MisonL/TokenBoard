-- Backfill email-shaped `profiles.display_name` values to the email's local part.
--
-- Until the fix in `features/auth/middleware.ts`, `ensureProfile` fell back to the full
-- address when a GitHub account had no display name (`user.name || user.email`), so an
-- account with an empty `name` was stored with its email as the display name. That value is
-- served verbatim by the public profile JSON and the SVG card once the profile is public — a
-- leak the user never chose. The insert only runs on profile creation and its `ON CONFLICT`
-- clause updates timezone alone, so correcting the fallback leaves the already-written rows
-- untouched. This migration rewrites them.
--
-- The new fallback is `user.email.split('@')[0] || 'user'`, and the slug already derives from
-- the same local part, so the rewrite matches what a fresh profile would store. Only rows whose
-- display name is exactly the user's own email are touched: a display name that merely looks
-- like an address but is not the account's email is a deliberate choice and is left alone.
--
-- The suffix match guards the format (local part, `@`, a dotted domain) so a display name that
-- is not an email is never rewritten, and the equality against `users.email` is case-insensitive
-- because GitHub may report the address in a different case than it was stored.
UPDATE profiles
SET
  display_name = (
    SELECT substr(users.email, 1, instr(users.email, '@') - 1)
    FROM users
    WHERE users.id = profiles.user_id
  ),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (
  SELECT 1
  FROM users
  WHERE users.id = profiles.user_id
    AND lower(users.email) = lower(profiles.display_name)
    AND instr(users.email, '@') > 1
    AND instr(substr(users.email, instr(users.email, '@') + 1), '.') > 1
);
