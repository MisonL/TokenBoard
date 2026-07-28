-- code_hash is already protected by the pairing_codes UNIQUE constraint.
DROP INDEX IF EXISTS pairing_codes_code_hash_idx;
