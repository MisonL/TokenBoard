-- Remove development-only public data and the fixed pairing credential from deployed databases.
DELETE FROM pairing_codes
WHERE id = 'pair_dev_seed'
  OR code_hash = '2fb2770cbfd167e945dd3495b21f241f03bb5ed864e153b0ef841eb1a19282bc';

-- Do not rely on a connection-level foreign key setting for this production cleanup.
DELETE FROM webhook_delivery_logs
WHERE user_id = 'seed-user'
  AND EXISTS (
    SELECT 1 FROM users
    WHERE id = 'seed-user'
      AND email IS NULL
      AND name = 'Seed User'
      AND NOT EXISTS (
        SELECT 1
        FROM accounts
        WHERE user_id = 'seed-user'
      )
  );

DELETE FROM webhook_subscriptions
WHERE user_id = 'seed-user'
  AND EXISTS (
    SELECT 1 FROM users
    WHERE id = 'seed-user'
      AND email IS NULL
      AND name = 'Seed User'
      AND NOT EXISTS (
        SELECT 1
        FROM accounts
        WHERE user_id = 'seed-user'
      )
  );

DELETE FROM daily_report_history
WHERE user_id = 'seed-user'
  AND EXISTS (
    SELECT 1 FROM users
    WHERE id = 'seed-user'
      AND email IS NULL
      AND name = 'Seed User'
      AND NOT EXISTS (
        SELECT 1
        FROM accounts
        WHERE user_id = 'seed-user'
      )
  );

DELETE FROM audit_logs
WHERE user_id = 'seed-user'
  AND EXISTS (
    SELECT 1 FROM users
    WHERE id = 'seed-user'
      AND email IS NULL
      AND name = 'Seed User'
      AND NOT EXISTS (
        SELECT 1
        FROM accounts
        WHERE user_id = 'seed-user'
      )
  );

DELETE FROM device_installations
WHERE user_id = 'seed-user'
  AND EXISTS (
    SELECT 1 FROM users
    WHERE id = 'seed-user'
      AND email IS NULL
      AND name = 'Seed User'
      AND NOT EXISTS (
        SELECT 1
        FROM accounts
        WHERE user_id = 'seed-user'
      )
  );

DELETE FROM upload_tokens
WHERE user_id = 'seed-user'
  AND EXISTS (
    SELECT 1 FROM users
    WHERE id = 'seed-user'
      AND email IS NULL
      AND name = 'Seed User'
      AND NOT EXISTS (
        SELECT 1
        FROM accounts
        WHERE user_id = 'seed-user'
      )
  );

DELETE FROM devices
WHERE user_id = 'seed-user'
  AND EXISTS (
    SELECT 1 FROM users
    WHERE id = 'seed-user'
      AND email IS NULL
      AND name = 'Seed User'
      AND NOT EXISTS (
        SELECT 1
        FROM accounts
        WHERE user_id = 'seed-user'
      )
  );

DELETE FROM pairing_codes
WHERE user_id = 'seed-user'
  AND EXISTS (
    SELECT 1 FROM users
    WHERE id = 'seed-user'
      AND email IS NULL
      AND name = 'Seed User'
      AND NOT EXISTS (
        SELECT 1
        FROM accounts
        WHERE user_id = 'seed-user'
      )
  );

DELETE FROM sessions
WHERE user_id = 'seed-user'
  AND EXISTS (
    SELECT 1 FROM users
    WHERE id = 'seed-user'
      AND email IS NULL
      AND name = 'Seed User'
      AND NOT EXISTS (
        SELECT 1
        FROM accounts
        WHERE user_id = 'seed-user'
      )
  );

DELETE FROM accounts
WHERE user_id = 'seed-user'
  AND EXISTS (
    SELECT 1 FROM users
    WHERE id = 'seed-user'
      AND email IS NULL
      AND name = 'Seed User'
      AND NOT EXISTS (
        SELECT 1
        FROM accounts
        WHERE user_id = 'seed-user'
      )
  );

DELETE FROM daily_usage_summary
WHERE user_id = 'seed-user'
  AND EXISTS (
    SELECT 1 FROM users
    WHERE id = 'seed-user'
      AND email IS NULL
      AND name = 'Seed User'
      AND NOT EXISTS (
        SELECT 1
        FROM accounts
        WHERE user_id = 'seed-user'
      )
  );

DELETE FROM user_usage_totals
WHERE user_id = 'seed-user'
  AND EXISTS (
    SELECT 1 FROM users
    WHERE id = 'seed-user'
      AND email IS NULL
      AND name = 'Seed User'
      AND NOT EXISTS (
        SELECT 1
        FROM accounts
        WHERE user_id = 'seed-user'
      )
  );

DELETE FROM daily_usage
WHERE user_id = 'seed-user'
  AND EXISTS (
    SELECT 1 FROM users
    WHERE id = 'seed-user'
      AND email IS NULL
      AND name = 'Seed User'
      AND NOT EXISTS (
        SELECT 1
        FROM accounts
        WHERE user_id = 'seed-user'
      )
  );

DELETE FROM profiles
WHERE user_id = 'seed-user'
  AND EXISTS (
    SELECT 1 FROM users
    WHERE id = 'seed-user'
      AND email IS NULL
      AND name = 'Seed User'
      AND NOT EXISTS (
        SELECT 1
        FROM accounts
        WHERE user_id = 'seed-user'
      )
  );

DELETE FROM users
WHERE id = 'seed-user'
  AND email IS NULL
  AND name = 'Seed User'
  AND NOT EXISTS (
    SELECT 1
    FROM accounts
    WHERE user_id = 'seed-user'
  );
