CREATE TABLE IF NOT EXISTS needware_registry_entry (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  application_id uuid NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('private','unlisted','public')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  summary text NOT NULL CHECK (length(summary) <= 1000),
  current_digest text NOT NULL CHECK (current_digest ~ '^[0-9a-f]{64}$'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  metadata_bytes integer NOT NULL DEFAULT 0 CHECK (metadata_bytes BETWEEN 0 AND 8192),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS needware_registry_public ON needware_registry_entry(updated_at DESC,id) WHERE visibility='public';
CREATE INDEX IF NOT EXISTS needware_registry_owner ON needware_registry_entry(owner_id);
CREATE TABLE IF NOT EXISTS needware_registry_revision (
  entry_id uuid NOT NULL REFERENCES needware_registry_entry(id) ON DELETE CASCADE,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  revision uuid NOT NULL,
  package bytea CHECK (octet_length(package) BETWEEN 40 AND 4194304),
  package_info jsonb,
  document_id uuid REFERENCES needware_document(id) ON DELETE CASCADE,
  source_entry uuid REFERENCES needware_registry_entry(id) ON DELETE SET NULL,
  source_digest text CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  storage_bytes integer NOT NULL DEFAULT 0 CHECK (storage_bytes BETWEEN 0 AND 8388608),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(entry_id,digest),
  CHECK ((package IS NULL AND package_info IS NULL AND document_id IS NOT NULL) OR (package IS NOT NULL AND package_info IS NOT NULL AND document_id IS NULL)),
  CHECK ((source_entry IS NULL) OR source_digest IS NOT NULL)
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='needware_registry_current_revision') THEN
    ALTER TABLE needware_registry_entry ADD CONSTRAINT needware_registry_current_revision
      FOREIGN KEY(id,current_digest) REFERENCES needware_registry_revision(entry_id,digest)
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS needware_public_limit (
  key text PRIMARY KEY CHECK (key ~ '^[0-9a-f]{64}$'),
  count integer NOT NULL CHECK (count BETWEEN 1 AND 120),
  bytes bigint NOT NULL CHECK (bytes BETWEEN 0 AND 33554432),
  reset_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS needware_public_limit_expiry ON needware_public_limit(reset_at);
ALTER TABLE needware_registry_entry ADD COLUMN IF NOT EXISTS metadata_bytes integer NOT NULL DEFAULT 0 CHECK (metadata_bytes BETWEEN 0 AND 8192);
ALTER TABLE needware_registry_revision ADD COLUMN IF NOT EXISTS storage_bytes integer NOT NULL DEFAULT 0 CHECK (storage_bytes BETWEEN 0 AND 8388608);
UPDATE needware_registry_entry SET metadata_bytes=octet_length(title)+octet_length(summary)+128 WHERE metadata_bytes=0;
UPDATE needware_registry_revision SET storage_bytes=COALESCE(octet_length(package),0)+COALESCE(octet_length(package_info::text),0)+256 WHERE storage_bytes=0;
