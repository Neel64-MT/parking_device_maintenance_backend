-- One non-Closed ticket per device (Slot Id uniqueness follows via devices.slot_id).
-- Close older duplicates first so the unique index can be created safely.

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY raised_at DESC) AS rn
  FROM tickets
  WHERE status <> 'Closed'
)
UPDATE tickets t
SET
  status = 'Closed',
  closed_at = COALESCE(t.closed_at, NOW()),
  updated_at = NOW()
FROM ranked r
WHERE t.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_one_open_per_device
  ON tickets (device_id)
  WHERE status <> 'Closed';
