CREATE TABLE IF NOT EXISTS needware_email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  recipient text NOT NULL CHECK (length(recipient) <= 320),
  kind text NOT NULL CHECK (kind IN ('verify', 'reset', 'delete')),
  link text NOT NULL CHECK (length(link) <= 8192),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  lease_id uuid,
  lease_until timestamptz,
  last_error text
);
ALTER TABLE needware_email_outbox ALTER COLUMN id SET DEFAULT gen_random_uuid();
CREATE INDEX IF NOT EXISTS needware_email_outbox_ready ON needware_email_outbox(next_attempt_at, lease_until);
