SELECT
  upload_tokens.installation_id,
  upload_tokens.supersedes_token_id
FROM upload_tokens
LIMIT 0;

SELECT
  install_claim_hash
FROM device_installations
LIMIT 0;

SELECT
  pairing_type,
  target_device_id,
  metadata
FROM pairing_codes
LIMIT 0;

SELECT id
FROM audit_logs
LIMIT 0;
