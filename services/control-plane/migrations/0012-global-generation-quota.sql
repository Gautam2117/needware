-- Independent of account/job cascades: deletion cannot erase provider spend.
CREATE TABLE IF NOT EXISTS needware_generation_global_day (
  day date NOT NULL,
  scope text NOT NULL CHECK(scope='global' OR scope ~ '^[0-9a-f-]{36}$'),
  ceiling integer NOT NULL CHECK(ceiling BETWEEN 1 AND 8000),
  reserved integer NOT NULL DEFAULT 0 CHECK(reserved>=0),
  spent integer NOT NULL DEFAULT 0 CHECK(spent>=0),
  PRIMARY KEY(day,scope),
  CHECK(reserved+spent<=ceiling)
);
CREATE TABLE IF NOT EXISTS needware_generation_global_reservation (
  job_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  provider jsonb NOT NULL,
  days date[] NOT NULL CHECK(cardinality(days)=2),
  token_ceiling integer NOT NULL CHECK(token_ceiling BETWEEN 1 AND 50000),
  neurons integer NOT NULL CHECK(neurons BETWEEN 1 AND 4000),
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled')),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '240 seconds',
  charged integer CHECK(charged BETWEEN 0 AND neurons),
  unknown_usage boolean,
  CHECK((state='reserved' AND charged IS NULL AND unknown_usage IS NULL) OR
        (state='settled' AND charged IS NOT NULL AND unknown_usage IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS needware_generation_global_active ON needware_generation_global_reservation(expires_at) WHERE state='reserved';
