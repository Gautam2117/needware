ALTER TABLE needware_cashfree_order ADD COLUMN IF NOT EXISTS plan_id text NOT NULL DEFAULT 'needware_pro_30_days';
ALTER TABLE needware_cashfree_order ADD COLUMN IF NOT EXISTS duration_days integer NOT NULL DEFAULT 30;
ALTER TABLE needware_cashfree_order DROP CONSTRAINT IF EXISTS needware_cashfree_order_amount_check;
DO $$ DECLARE constraint_name text; BEGIN
 FOR constraint_name IN SELECT conname FROM pg_constraint WHERE conrelid='needware_cashfree_order'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%720%' LOOP
  EXECUTE format('ALTER TABLE needware_cashfree_order DROP CONSTRAINT %I',constraint_name);
 END LOOP;
END $$;
ALTER TABLE needware_cashfree_order DROP CONSTRAINT IF EXISTS needware_cashfree_order_pass_catalog;
ALTER TABLE needware_cashfree_order ADD CONSTRAINT needware_cashfree_order_pass_catalog CHECK(
 (plan_id='needware_pro_30_days' AND amount=49900 AND duration_days=30) OR
 (plan_id='needware_pro_365_days' AND amount=499000 AND duration_days=365));
ALTER TABLE needware_cashfree_order DROP CONSTRAINT IF EXISTS needware_cashfree_order_pass_duration;
ALTER TABLE needware_cashfree_order ADD CONSTRAINT needware_cashfree_order_pass_duration CHECK(paid_until IS NULL OR paid_until=paid_start+duration_days*interval '24 hours');
