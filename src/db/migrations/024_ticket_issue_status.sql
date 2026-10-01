-- Phase 48: per-issue Open/Resolved state on reported ticket issues.
-- Status is only meaningful on role = 'reported' rows; found rows keep the default and are ignored.
ALTER TABLE ticket_issues
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'Open'
    CHECK (status IN ('Open', 'Resolved')),
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_event_id UUID REFERENCES ticket_events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ticket_issues_resolved_event ON ticket_issues (resolved_event_id);

-- Legacy single-issue tickets created after 017 ran (e.g. seed data) still need a resolvable row.
INSERT INTO ticket_issues (ticket_id, role, category_id, subcategory_id, sort_order)
SELECT t.id, 'reported', t.reported_category_id, t.reported_subcategory_id, 0
FROM tickets t
WHERE t.reported_category_id IS NOT NULL
  AND t.reported_subcategory_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM ticket_issues ti WHERE ti.ticket_id = t.id AND ti.role = 'reported'
  )
ON CONFLICT (ticket_id, role, subcategory_id) DO NOTHING;

-- A Closed ticket never shows open issues.
UPDATE ticket_issues ti
SET status = 'Resolved',
    resolved_at = COALESCE(t.closed_at, t.updated_at, NOW())
FROM tickets t
WHERE t.id = ti.ticket_id
  AND t.status = 'Closed'
  AND ti.role = 'reported'
  AND ti.status = 'Open';
