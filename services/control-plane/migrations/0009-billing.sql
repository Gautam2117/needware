CREATE TABLE IF NOT EXISTS needware_billing_account (
  account_id uuid PRIMARY KEY REFERENCES auth_user(id) ON DELETE CASCADE,
  customer_id text NOT NULL UNIQUE CHECK(customer_id ~ '^cus_[A-Za-z0-9]+$'),
  merchant_id text NOT NULL CHECK(merchant_id ~ '^acct_[A-Za-z0-9]+$'),
  livemode boolean NOT NULL,
  subscription_id text CHECK(subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  status text NOT NULL DEFAULT 'free' CHECK(length(status)<=80),
  paid_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS needware_billing_checkout (
  account_id uuid NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  session_id text UNIQUE CHECK(session_id ~ '^cs_[A-Za-z0-9_]+$'),
  url text CHECK(length(url)<=4096),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,id),
  CHECK((session_id IS NULL)=(url IS NULL))
);
CREATE TABLE IF NOT EXISTS needware_billing_event (
  id text PRIMARY KEY CHECK(id ~ '^evt_[A-Za-z0-9]+$'),
  type text NOT NULL CHECK(length(type)<=80),
  object_id text NOT NULL CHECK(length(object_id)<=100),
  customer_id text CHECK(customer_id ~ '^cus_[A-Za-z0-9]+$'),
  identity_digest text NOT NULL CHECK(identity_digest ~ '^[0-9a-f]{64}$'),
  livemode boolean NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  merchant_id text NOT NULL CHECK(merchant_id ~ '^acct_[A-Za-z0-9]+$'),
  processed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  failure text CHECK(length(failure)<=80)
);
CREATE INDEX IF NOT EXISTS needware_billing_event_ready ON needware_billing_event(next_attempt_at,lease_until) WHERE processed_at IS NULL;
CREATE TABLE IF NOT EXISTS needware_billing_cleanup (
  customer_id text PRIMARY KEY CHECK(customer_id ~ '^cus_[A-Za-z0-9]+$'),
  merchant_id text NOT NULL CHECK(merchant_id ~ '^acct_[A-Za-z0-9]+$'),
  livemode boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 20),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  failure text CHECK(length(failure)<=80)
);
CREATE OR REPLACE FUNCTION needware_enqueue_billing_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO needware_billing_cleanup(customer_id,merchant_id,livemode) VALUES(OLD.customer_id,OLD.merchant_id,OLD.livemode) ON CONFLICT DO NOTHING;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS needware_billing_deletion ON needware_billing_account;
CREATE TRIGGER needware_billing_deletion BEFORE DELETE ON needware_billing_account FOR EACH ROW EXECUTE FUNCTION needware_enqueue_billing_deletion();
