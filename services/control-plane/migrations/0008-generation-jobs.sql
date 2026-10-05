CREATE TABLE IF NOT EXISTS needware_entitlement (
  account_id uuid PRIMARY KEY REFERENCES auth_user(id) ON DELETE CASCADE,
  plan text NOT NULL CHECK(plan IN ('free','pro')),
  paid_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS needware_generation_usage (
  account_id uuid NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  period date NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 10000),
  reserved_microusd bigint NOT NULL DEFAULT 0 CHECK(reserved_microusd BETWEEN 0 AND 1000000000000),
  spent_microusd bigint NOT NULL DEFAULT 0 CHECK(spent_microusd BETWEEN 0 AND 1000000000000),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK(input_tokens>=0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK(output_tokens>=0),
  unknown_requests integer NOT NULL DEFAULT 0 CHECK(unknown_requests>=0),
  PRIMARY KEY(account_id,period)
);
CREATE TABLE IF NOT EXISTS needware_generation_job (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  prompt text CHECK(octet_length(prompt) BETWEEN 1 AND 32768),
  recipient jsonb NOT NULL,
  provider jsonb NOT NULL,
  period date NOT NULL,
  reservation bigint NOT NULL CHECK(reservation BETWEEN 0 AND 1000000000),
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','cancel_requested','succeeded','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  lease_id uuid,
  lease_until timestamptz,
  dispatched_at timestamptz,
  stage jsonb,
  usage jsonb,
  failure text,
  result_metadata jsonb,
  result_ciphertext bytea CHECK(octet_length(result_ciphertext) BETWEEN 17 AND 4194320),
  package_digest text CHECK(package_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK((state='succeeded')=(result_ciphertext IS NOT NULL)),
  CHECK((result_ciphertext IS NULL)=(result_metadata IS NULL)),
  CHECK((result_ciphertext IS NULL)=(package_digest IS NULL)),
  FOREIGN KEY(owner_id,period) REFERENCES needware_generation_usage(account_id,period) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS needware_generation_queue ON needware_generation_job(created_at,id) WHERE state IN ('queued','running','cancel_requested');
CREATE INDEX IF NOT EXISTS needware_generation_owner ON needware_generation_job(owner_id,created_at DESC);
