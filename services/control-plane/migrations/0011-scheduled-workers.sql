BEGIN;
ALTER TABLE needware_worker_health ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'continuous';
ALTER TABLE needware_worker_health ADD COLUMN IF NOT EXISTS period_seconds integer;
ALTER TABLE needware_worker_health DROP CONSTRAINT IF EXISTS needware_worker_health_state_check;
ALTER TABLE needware_worker_health ADD CONSTRAINT needware_worker_health_state_check CHECK(state IN ('running','degraded','stopped','idle'));
ALTER TABLE needware_worker_health DROP CONSTRAINT IF EXISTS needware_worker_health_schedule_check;
ALTER TABLE needware_worker_health ADD CONSTRAINT needware_worker_health_schedule_check CHECK(
  (mode='continuous' AND period_seconds IS NULL AND state<>'idle') OR
  (mode='scheduled' AND period_seconds IS NOT NULL AND period_seconds BETWEEN 60 AND 3600)
);
CREATE INDEX IF NOT EXISTS needware_worker_schedule_time ON needware_worker_health(worker,mode,updated_at DESC,instance DESC);
COMMIT;
