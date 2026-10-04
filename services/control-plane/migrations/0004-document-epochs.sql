-- Staged encrypted objects are charged before activation. Current generation
-- remains in the original relay tables; archived generations are immutable.
CREATE TABLE IF NOT EXISTS needware_document_epoch (
  document_id uuid NOT NULL REFERENCES needware_document(id) ON DELETE CASCADE,
  generation bigint NOT NULL CHECK (generation BETWEEN 1 AND 4294967295),
  status text NOT NULL CHECK (status IN ('staging','active','archived')),
  binding jsonb NOT NULL,
  previous_binding jsonb,
  descriptor jsonb NOT NULL,
  root_epoch bigint NOT NULL CHECK (root_epoch BETWEEN 1 AND 4294967295),
  authority bytea NOT NULL CHECK (octet_length(authority)=32),
  transition jsonb,
  checkpoint_manifest jsonb,
  source_cursor bigint NOT NULL CHECK (source_cursor BETWEEN 0 AND 100000),
  owner_account uuid NOT NULL,
  owner_device uuid NOT NULL,
  members jsonb NOT NULL,
  storage_bytes bigint NOT NULL CHECK (storage_bytes BETWEEN 0 AND 134217728),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(document_id,generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS needware_epoch_staging ON needware_document_epoch(document_id) WHERE status='staging';
CREATE UNIQUE INDEX IF NOT EXISTS needware_epoch_active ON needware_document_epoch(document_id) WHERE status='active';
CREATE TABLE IF NOT EXISTS needware_document_epoch_chunk (
  document_id uuid NOT NULL,
  generation bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('package','checkpoint')),
  chunk_index integer NOT NULL CHECK (chunk_index BETWEEN 0 AND 32),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 1048576),
  PRIMARY KEY(document_id,generation,kind,chunk_index),
  FOREIGN KEY(document_id,generation) REFERENCES needware_document_epoch(document_id,generation) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS needware_document_epoch_frame (
  document_id uuid NOT NULL,
  generation bigint NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  sequence bigint NOT NULL CHECK (sequence BETWEEN 1 AND 100000),
  frame text NOT NULL CHECK (octet_length(frame) BETWEEN 1 AND 2097152),
  PRIMARY KEY(document_id,generation,digest),
  UNIQUE(document_id,generation,sequence),
  FOREIGN KEY(document_id,generation) REFERENCES needware_document_epoch(document_id,generation) ON DELETE CASCADE
);
