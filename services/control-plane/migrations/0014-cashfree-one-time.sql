ALTER TABLE needware_billing_account DROP CONSTRAINT IF EXISTS needware_billing_account_provider_check;
ALTER TABLE needware_billing_account ADD CONSTRAINT needware_billing_account_provider_check CHECK(provider IN('stripe','cashfree','cashfree_once'));
ALTER TABLE needware_billing_account DROP CONSTRAINT IF EXISTS needware_billing_account_provider_identity;
ALTER TABLE needware_billing_account ADD CONSTRAINT needware_billing_account_provider_identity CHECK(
 (provider='stripe' AND customer_id ~ '^cus_[A-Za-z0-9]+$' AND merchant_id ~ '^acct_[A-Za-z0-9]+$' AND (subscription_id IS NULL OR subscription_id ~ '^sub_[A-Za-z0-9]+$')) OR
 (provider='cashfree' AND customer_id ~ '^cf_cus_[0-9a-f]{32}$' AND merchant_id ~ '^cf_[0-9a-f]{32}$' AND (subscription_id IS NULL OR subscription_id ~ '^needware_[0-9a-f]{48}$')) OR
 (provider='cashfree_once' AND customer_id ~ '^cf_cus_[0-9a-f]{32}$' AND merchant_id ~ '^cf_[0-9a-f]{32}$' AND subscription_id IS NULL));
CREATE TABLE IF NOT EXISTS needware_cashfree_order(
 id uuid PRIMARY KEY,account_id uuid REFERENCES auth_user(id) ON DELETE SET NULL,
 merchant_id text NOT NULL CHECK(merchant_id ~ '^cf_[0-9a-f]{32}$'),livemode boolean NOT NULL,
 order_id text NOT NULL UNIQUE CHECK(order_id ~ '^nw_[0-9a-f]{32}$'),
 request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
 session_id text CHECK(length(session_id) BETWEEN 16 AND 4096),
 amount integer NOT NULL CHECK(amount=49900),expires_at timestamptz NOT NULL,
 payment_id text UNIQUE CHECK(payment_id ~ '^[0-9]{1,40}$'),paid_start timestamptz,paid_until timestamptz,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','paid','expired','revoked')),
 verified_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((paid_start IS NULL)=(paid_until IS NULL)),CHECK(paid_until IS NULL OR paid_until=paid_start+interval '720 hours')
);
CREATE INDEX IF NOT EXISTS needware_cashfree_order_owner ON needware_cashfree_order(account_id,created_at);
CREATE TABLE IF NOT EXISTS needware_cashfree_order_event(
 id text PRIMARY KEY CHECK(id ~ '^[0-9a-f]{64}$'),identity_digest text NOT NULL CHECK(identity_digest ~ '^[0-9a-f]{64}$'),
 merchant_id text NOT NULL CHECK(merchant_id ~ '^cf_[0-9a-f]{32}$'),livemode boolean NOT NULL,
 order_id text NOT NULL CHECK(order_id ~ '^[A-Za-z0-9_-]{3,45}$'),
 received_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 20),next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_id uuid,lease_until timestamptz,failure text CHECK(length(failure)<=80)
);
CREATE INDEX IF NOT EXISTS needware_cashfree_order_event_ready ON needware_cashfree_order_event(next_attempt_at,lease_until) WHERE processed_at IS NULL;
