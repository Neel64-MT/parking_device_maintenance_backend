-- Device Sync: external location identity, slot fields, sync run status

ALTER TABLE roads ADD COLUMN IF NOT EXISTS external_location_id INTEGER UNIQUE;

ALTER TABLE devices ADD COLUMN IF NOT EXISTS slot_id BIGINT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS slot_identifier TEXT;

CREATE TABLE IF NOT EXISTS device_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  triggered_by_user_id UUID REFERENCES users(id),
  error_message TEXT,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_device_sync_runs_started ON device_sync_runs (started_at DESC);
