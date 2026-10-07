ALTER TABLE needware_billing_account ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'stripe' CHECK(provider IN('stripe','cashfree'));
ALTER TABLE needware_billing_account DROP CONSTRAINT IF EXISTS needware_billing_account_customer_id_check;
ALTER TABLE needware_billing_account DROP CONSTRAINT IF EXISTS needware_billing_account_merchant_id_check;
ALTER TABLE needware_billing_account DROP CONSTRAINT IF EXISTS needware_billing_account_subscription_id_check;
ALTER TABLE needware_billing_account DROP CONSTRAINT IF EXISTS needware_billing_account_provider_identity;
ALTER TABLE needware_billing_account ADD CONSTRAINT needware_billing_account_provider_identity CHECK(
 (provider='stripe' AND customer_id ~ '^cus_[A-Za-z0-9]+$' AND merchant_id ~ '^acct_[A-Za-z0-9]+$' AND (subscription_id IS NULL OR subscription_id ~ '^sub_[A-Za-z0-9]+$')) OR
 (provider='cashfree' AND customer_id ~ '^cf_cus_[0-9a-f]{32}$' AND merchant_id ~ '^cf_[0-9a-f]{32}$' AND (subscription_id IS NULL OR subscription_id ~ '^needware_[0-9a-f]{48}$')));
CREATE TABLE IF NOT EXISTS needware_cashfree_checkout(
 id uuid PRIMARY KEY,account_id uuid NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
 merchant_id text NOT NULL CHECK(merchant_id ~ '^cf_[0-9a-f]{32}$'),livemode boolean NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
 subscription_id text NOT NULL UNIQUE CHECK(subscription_id ~ '^needware_[0-9a-f]{48}$'),
 session_id text CHECK(length(session_id) BETWEEN 16 AND 4096),
 first_charge timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS needware_cashfree_event(
 id text PRIMARY KEY CHECK(id ~ '^[0-9a-f]{64}$'),identity_digest text NOT NULL CHECK(identity_digest ~ '^[0-9a-f]{64}$'),
 merchant_id text NOT NULL CHECK(merchant_id ~ '^cf_[0-9a-f]{32}$'),livemode boolean NOT NULL,
 type text NOT NULL CHECK(length(type)<=80),
 subscription_id text CHECK(subscription_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 cf_subscription_id text CHECK(cf_subscription_id ~ '^[0-9]{1,40}$'),
 cf_payment_id text CHECK(cf_payment_id ~ '^[0-9]{1,40}$'),
 refund_id text CHECK(refund_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 pg_order_id text CHECK(pg_order_id ~ '^[A-Za-z0-9_-]{1,128}$'),pg_payment_id text CHECK(pg_payment_id ~ '^[0-9]{1,40}$'),
 received_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 20),next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_id uuid,lease_until timestamptz,failure text CHECK(length(failure)<=80)
);
CREATE INDEX IF NOT EXISTS needware_cashfree_event_ready ON needware_cashfree_event(next_attempt_at,lease_until) WHERE processed_at IS NULL;
CREATE TABLE IF NOT EXISTS needware_cashfree_payment(
 merchant_id text NOT NULL CHECK(merchant_id ~ '^cf_[0-9a-f]{32}$'),livemode boolean NOT NULL,
 cf_payment_id text NOT NULL CHECK(cf_payment_id ~ '^[0-9]{1,40}$'),
 cf_txn_id text CHECK(cf_txn_id ~ '^[0-9]{1,40}$'),
 account_id uuid NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
 subscription_id text NOT NULL CHECK(subscription_id ~ '^needware_[0-9a-f]{48}$'),
 cf_subscription_id text NOT NULL CHECK(cf_subscription_id ~ '^[0-9]{1,40}$'),
 PRIMARY KEY(merchant_id,livemode,cf_payment_id),UNIQUE(merchant_id,livemode,cf_txn_id)
);
CREATE TABLE IF NOT EXISTS needware_cashfree_cleanup(
 merchant_id text NOT NULL CHECK(merchant_id ~ '^cf_[0-9a-f]{32}$'),livemode boolean NOT NULL,
 subscription_id text NOT NULL CHECK(subscription_id ~ '^needware_[0-9a-f]{48}$'),account_id uuid NOT NULL,
 cancel_id uuid NOT NULL DEFAULT gen_random_uuid(),created_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 20),next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_id uuid,lease_until timestamptz,failure text CHECK(length(failure)<=80),
 PRIMARY KEY(merchant_id,livemode,subscription_id)
);
CREATE OR REPLACE FUNCTION needware_enqueue_billing_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.provider='stripe' THEN
  INSERT INTO needware_billing_cleanup(customer_id,merchant_id,livemode) VALUES(OLD.customer_id,OLD.merchant_id,OLD.livemode) ON CONFLICT DO NOTHING;
 ELSIF OLD.subscription_id IS NOT NULL THEN
  INSERT INTO needware_cashfree_cleanup(merchant_id,livemode,subscription_id,account_id) VALUES(OLD.merchant_id,OLD.livemode,OLD.subscription_id,OLD.account_id) ON CONFLICT DO NOTHING;
 END IF;
 RETURN OLD;
END $$;
