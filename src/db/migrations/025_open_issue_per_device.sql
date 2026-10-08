-- Phase 50: duplicate tickets are decided per issue, not per device.
-- A device may hold several open tickets as long as no sub-category is Open twice on it.
-- A partial unique index cannot span tickets + ticket_issues, so the ticket's device
-- (which never changes) is copied onto each issue row.
ALTER TABLE ticket_issues
  ADD COLUMN IF NOT EXISTS device_id UUID REFERENCES devices(id) ON DELETE CASCADE;

UPDATE ticket_issues ti
SET device_id = t.device_id
FROM tickets t
WHERE t.id = ti.ticket_id
  AND ti.device_id IS NULL;

-- Invariant (Phase 49): a Closed ticket has no Open issues, so it never blocks a new raise.
UPDATE ticket_issues ti
SET status = 'Resolved',
    resolved_at = COALESCE(t.closed_at, t.updated_at, NOW())
FROM tickets t
WHERE t.id = ti.ticket_id
  AND t.status = 'Closed'
  AND ti.role = 'reported'
  AND ti.status = 'Open';

DROP INDEX IF EXISTS idx_tickets_one_open_per_device;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_issues_one_open_issue_per_device
  ON ticket_issues (device_id, subcategory_id)
  WHERE role = 'reported' AND status = 'Open';
