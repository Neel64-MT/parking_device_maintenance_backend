-- Parts master amount + link table for ticket update/close parts changed
ALTER TABLE parts ADD COLUMN IF NOT EXISTS amount NUMERIC(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS ticket_event_parts (
  event_id UUID NOT NULL REFERENCES ticket_events(id) ON DELETE CASCADE,
  part_id UUID NOT NULL REFERENCES parts(id),
  amount NUMERIC(12, 2) NOT NULL,
  PRIMARY KEY (event_id, part_id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_event_parts_part ON ticket_event_parts (part_id);

-- Backfill seeded catalog prices when still at default 0 (idempotent for custom prices)
UPDATE parts SET amount = v.amount, updated_at = NOW()
FROM (VALUES
  ('Flap plate', 6400),
  ('Hinge assembly', 2800),
  ('Motor', 9200),
  ('Gearbox', 7500),
  ('Limit switch', 850),
  ('Controller board', 5300),
  ('SMPS / power supply', 2300),
  ('Sensor', 1200),
  ('QR plate', 400),
  ('Wiring harness', 950),
  ('MCB', 600),
  ('Spring / damper', 1100)
) AS v(name, amount)
WHERE parts.name = v.name AND parts.amount = 0;
