-- Upgrade only the reviewed operation allowlist; existing challenge rows are retained.
ALTER TABLE needware_vault_challenge DROP CONSTRAINT IF EXISTS needware_vault_challenge_operation_check;
ALTER TABLE needware_vault_challenge ADD CONSTRAINT needware_vault_challenge_operation_check
  CHECK (operation IN ('create_vault','register_device','relay_document'));
CREATE TABLE IF NOT EXISTS needware_document (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES needware_account_vault(account_id) ON DELETE CASCADE,
  binding jsonb NOT NULL,
  authority bytea NOT NULL CHECK (octet_length(authority)=32),
  root_epoch bigint NOT NULL CHECK (root_epoch BETWEEN 1 AND 4294967295),
  descriptor jsonb NOT NULL,
  package_digest text NOT NULL CHECK (package_digest ~ '^[0-9a-f]{64}$'),
  package_bytes integer NOT NULL CHECK (package_bytes BETWEEN 40 AND 33554472),
  ready boolean NOT NULL DEFAULT false,
  storage_bytes bigint NOT NULL CHECK (storage_bytes BETWEEN 1 AND 134217728),
  next_sequence bigint NOT NULL DEFAULT 0 CHECK (next_sequence BETWEEN 0 AND 100000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS needware_document_owner ON needware_document(owner_id);
CREATE TABLE IF NOT EXISTS needware_document_member (
  document_id uuid NOT NULL REFERENCES needware_document(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES needware_account_vault(account_id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  membership jsonb NOT NULL,
  key_envelope jsonb NOT NULL,
  metadata_bytes integer NOT NULL DEFAULT 0 CHECK (metadata_bytes BETWEEN 0 AND 32768),
  revoked boolean NOT NULL DEFAULT false,
  PRIMARY KEY (document_id,account_id,device_id),
  FOREIGN KEY (account_id,device_id) REFERENCES needware_vault_device(account_id,device_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS needware_document_member_account ON needware_document_member(account_id);
ALTER TABLE needware_document_member ADD COLUMN IF NOT EXISTS metadata_bytes integer NOT NULL DEFAULT 0 CHECK (metadata_bytes BETWEEN 0 AND 32768);
CREATE OR REPLACE FUNCTION needware_refund_member_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner uuid;
BEGIN
  -- During a document cascade its row has already gone; the document deletion
  -- refunds the complete ledger once. Independent device/account cascades only
  -- refund this member's exact originally charged canonical metadata size.
  UPDATE needware_document SET storage_bytes=storage_bytes-OLD.metadata_bytes
    WHERE id=OLD.document_id RETURNING owner_id INTO owner;
  IF FOUND THEN
    UPDATE needware_relay_usage SET bytes=bytes-OLD.metadata_bytes WHERE account_id=owner;
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS needware_member_metadata_refund ON needware_document_member;
CREATE TRIGGER needware_member_metadata_refund AFTER DELETE ON needware_document_member
  FOR EACH ROW EXECUTE FUNCTION needware_refund_member_metadata();
CREATE TABLE IF NOT EXISTS needware_document_chunk (
  document_id uuid NOT NULL REFERENCES needware_document(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index BETWEEN 0 AND 32),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 1048576),
  PRIMARY KEY(document_id,chunk_index)
);
CREATE TABLE IF NOT EXISTS needware_document_frame (
  document_id uuid NOT NULL REFERENCES needware_document(id) ON DELETE CASCADE,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 100000),
  frame text NOT NULL CHECK (octet_length(frame) BETWEEN 1 AND 2097152),
  PRIMARY KEY(document_id,digest),
  UNIQUE(document_id,sequence)
);
CREATE TABLE IF NOT EXISTS needware_relay_usage (
  account_id uuid PRIMARY KEY REFERENCES needware_account_vault(account_id) ON DELETE CASCADE,
  bytes bigint NOT NULL DEFAULT 0 CHECK (bytes BETWEEN 0 AND 134217728),
  documents integer NOT NULL DEFAULT 0 CHECK (documents BETWEEN 0 AND 256)
);
