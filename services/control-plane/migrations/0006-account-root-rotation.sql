-- Public proofs and opaque device approvals only. Root secrets and recovery
-- codes stay inside the encrypted browser intent, never in these rows.
ALTER TABLE needware_vault_challenge DROP CONSTRAINT IF EXISTS needware_vault_challenge_operation_check;
ALTER TABLE needware_vault_challenge ADD CONSTRAINT needware_vault_challenge_operation_check
  CHECK (operation IN ('create_vault','register_device','relay_document','rotate_root'));
ALTER TABLE needware_vault_device ADD COLUMN IF NOT EXISTS root_approval jsonb;
ALTER TABLE needware_vault_device ADD COLUMN IF NOT EXISTS root_rotation_proof jsonb;
CREATE TABLE IF NOT EXISTS needware_root_rotation (
  account_id uuid NOT NULL REFERENCES needware_account_vault(account_id) ON DELETE CASCADE,
  id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('staging','active')),
  actor_device uuid NOT NULL,
  proof jsonb NOT NULL,
  recovery jsonb NOT NULL,
  devices jsonb NOT NULL,
  sources jsonb NOT NULL,
  metadata_bytes integer NOT NULL CHECK (metadata_bytes BETWEEN 1 AND 3145728),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS needware_root_rotation_staging
  ON needware_root_rotation(account_id) WHERE status='staging';
ALTER TABLE needware_document_epoch ADD COLUMN IF NOT EXISTS root_rotation_id uuid;
ALTER TABLE needware_document_epoch ADD COLUMN IF NOT EXISTS root_rotation_proof jsonb;
CREATE TABLE IF NOT EXISTS needware_document_rekey (
  document_id uuid NOT NULL REFERENCES needware_document(id) ON DELETE CASCADE,
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 4294967295),
  account_id uuid NOT NULL REFERENCES needware_account_vault(account_id) ON DELETE CASCADE,
  rotation_id uuid NOT NULL,
  PRIMARY KEY(document_id,account_id),
  FOREIGN KEY(account_id,rotation_id) REFERENCES needware_root_rotation(account_id,id)
);
-- A device cascade must not erase the authorship needed to authenticate the
-- current generation before its foreign owner completes the fresh-key cut.
CREATE TABLE IF NOT EXISTS needware_document_retained_author (
  document_id uuid NOT NULL REFERENCES needware_document(id) ON DELETE CASCADE,
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 4294967295),
  account_id uuid NOT NULL,
  device_id uuid NOT NULL,
  certificate jsonb NOT NULL,
  membership jsonb NOT NULL,
  key_envelope jsonb NOT NULL,
  metadata_bytes integer NOT NULL CHECK (metadata_bytes BETWEEN 1 AND 32768),
  PRIMARY KEY(document_id,generation,account_id,device_id)
);
CREATE TABLE IF NOT EXISTS needware_document_history_key (
  document_id uuid NOT NULL,
  generation bigint NOT NULL,
  held jsonb NOT NULL,
  metadata_bytes integer NOT NULL CHECK (metadata_bytes BETWEEN 1 AND 32768),
  PRIMARY KEY(document_id,generation),
  FOREIGN KEY(document_id,generation) REFERENCES needware_document_epoch(document_id,generation) ON DELETE CASCADE
);
