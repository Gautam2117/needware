ALTER TABLE needware_registry_entry ADD COLUMN IF NOT EXISTS moderated boolean NOT NULL DEFAULT false;
ALTER TABLE needware_registry_entry ADD COLUMN IF NOT EXISTS moderation_reason text CHECK(moderation_reason IN ('harmful','privacy','spam','copyright'));
CREATE TABLE IF NOT EXISTS needware_abuse_report (
  id uuid PRIMARY KEY,
  reporter_id uuid NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL REFERENCES needware_registry_entry(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK(reason IN ('harmful','privacy','spam','copyright')),
  state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','reviewed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  UNIQUE(reporter_id,entry_id)
);
CREATE INDEX IF NOT EXISTS needware_report_open ON needware_abuse_report(created_at,id) WHERE state='open';
CREATE TABLE IF NOT EXISTS needware_operator_audit (
  id uuid PRIMARY KEY,
  operator_id uuid NOT NULL,
  object_id uuid NOT NULL,
  action text NOT NULL CHECK(action IN ('hide','restore','review_report','inspect','hold_account','release_account','retry_worker')),
  reason text NOT NULL CHECK(reason IN ('harmful','privacy','spam','copyright','transient_failure')),
  reference_digest text CHECK(reference_digest ~ '^[0-9a-f]{64}$'),
  before_version bigint,
  after_version bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS needware_operator_audit_time ON needware_operator_audit(created_at);
CREATE TABLE IF NOT EXISTS needware_worker_health (
  worker text NOT NULL CHECK(worker IN ('email','generation','billing')),
  instance uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('running','degraded','stopped')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(worker,instance)
);
CREATE TABLE IF NOT EXISTS needware_account_hold (
  account_id uuid PRIMARY KEY REFERENCES auth_user(id) ON DELETE CASCADE,
  active boolean NOT NULL,
  reason text NOT NULL CHECK(reason IN ('harmful','privacy','spam','copyright')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
