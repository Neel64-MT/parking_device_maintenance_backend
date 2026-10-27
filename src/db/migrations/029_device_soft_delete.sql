-- Device soft delete: preserve ticket/history relationships (tickets.device_id is RESTRICT)
-- while letting a device drop out of list/scan/history reads.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Active devices are the common read path; index the live subset.
CREATE INDEX IF NOT EXISTS idx_devices_active ON devices (id) WHERE deleted_at IS NULL;
