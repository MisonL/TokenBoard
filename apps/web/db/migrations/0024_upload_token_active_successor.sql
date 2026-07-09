UPDATE upload_tokens
SET revoked_at = COALESCE(
  revoked_at,
  created_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
WHERE supersedes_token_id IS NOT NULL
  AND revoked_at IS NULL
  AND id NOT IN (
    SELECT active_successor.id
    FROM upload_tokens AS active_successor
    WHERE active_successor.supersedes_token_id IS NOT NULL
      AND active_successor.revoked_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM upload_tokens AS newer_successor
        WHERE newer_successor.supersedes_token_id = active_successor.supersedes_token_id
          AND newer_successor.revoked_at IS NULL
          AND (
            newer_successor.created_at > active_successor.created_at
            OR (
              newer_successor.created_at = active_successor.created_at
              AND newer_successor.id > active_successor.id
            )
          )
      )
  );

CREATE UNIQUE INDEX IF NOT EXISTS upload_tokens_active_successor_idx
  ON upload_tokens(supersedes_token_id)
  WHERE supersedes_token_id IS NOT NULL
    AND revoked_at IS NULL;
