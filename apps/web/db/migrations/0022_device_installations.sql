CREATE TABLE device_installations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  hostname TEXT,
  client_version TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE INDEX device_installations_user_id_idx
  ON device_installations(user_id);

CREATE INDEX device_installations_device_id_idx
  ON device_installations(device_id);

INSERT INTO device_installations (
  id,
  user_id,
  device_id,
  platform,
  hostname,
  client_version,
  first_seen_at,
  last_seen_at,
  created_at,
  updated_at
)
SELECT
  'inst_legacy_' || id,
  user_id,
  id,
  platform,
  name,
  'legacy',
  created_at,
  last_synced_at,
  created_at,
  updated_at
FROM devices;

ALTER TABLE upload_tokens ADD COLUMN installation_id TEXT;
ALTER TABLE upload_tokens ADD COLUMN supersedes_token_id TEXT;

UPDATE upload_tokens
SET installation_id = 'inst_legacy_' || device_id
WHERE device_id IS NOT NULL
  AND installation_id IS NULL;

CREATE INDEX upload_tokens_installation_id_idx
  ON upload_tokens(installation_id);

ALTER TABLE pairing_codes ADD COLUMN pairing_type TEXT NOT NULL DEFAULT 'new_device';
ALTER TABLE pairing_codes ADD COLUMN target_device_id TEXT;
ALTER TABLE pairing_codes ADD COLUMN metadata TEXT;

CREATE INDEX pairing_codes_target_device_idx
  ON pairing_codes(user_id, target_device_id);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX audit_logs_user_created_idx
  ON audit_logs(user_id, created_at);
