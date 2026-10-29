-- Ticket soft delete (mirrors device soft delete, migration 029): preserve ticket history
-- (ticket_events / ticket_issues / assignments / parts) while letting a ticket drop out of
-- every list / count / Slot View / dashboard / report read.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Live tickets are the common read path; index the active subset.
CREATE INDEX IF NOT EXISTS idx_tickets_active ON tickets (id) WHERE deleted_at IS NULL;

-- The "one open issue per device" unique index (migration 025) is on ticket_issues and cannot
-- see tickets.deleted_at. A soft-deleted ticket whose issue rows stay Open would keep blocking a
-- re-raise of the same issue at the DB level, so the deleted flag is mirrored onto ticket_issues
-- and the index is recreated to exclude deleted rows.
ALTER TABLE ticket_issues ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

DROP INDEX IF EXISTS idx_ticket_issues_one_open_issue_per_device;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_issues_one_open_issue_per_device
  ON ticket_issues (device_id, subcategory_id)
  WHERE role = 'reported' AND status = 'Open' AND deleted_at IS NULL;
