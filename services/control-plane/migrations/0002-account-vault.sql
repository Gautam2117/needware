CREATE TABLE IF NOT EXISTS needware_account_vault (
  account_id uuid PRIMARY KEY REFERENCES auth_user(id) ON DELETE CASCADE,
  context jsonb NOT NULL,
  authority bytea NOT NULL CHECK (octet_length(authority) = 32),
  root_epoch bigint NOT NULL CHECK (root_epoch BETWEEN 1 AND 4294967295),
  recovery jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS needware_vault_device (
  account_id uuid NOT NULL REFERENCES needware_account_vault(account_id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  certificate jsonb NOT NULL,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, device_id)
);
CREATE TABLE IF NOT EXISTS needware_vault_challenge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES auth_session(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('create_vault', 'register_device')),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '2 minutes'
);
CREATE INDEX IF NOT EXISTS needware_vault_challenge_expiry ON needware_vault_challenge(expires_at);
CREATE TABLE IF NOT EXISTS needware_account_limit (
  account_id uuid PRIMARY KEY REFERENCES auth_user(id) ON DELETE CASCADE,
  count integer NOT NULL CHECK (count BETWEEN 1 AND 60),
  reset_at timestamptz NOT NULL
);
