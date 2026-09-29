-- Phase 41: multiple issues per ticket (reported / found)
CREATE TABLE IF NOT EXISTS ticket_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('reported', 'found')),
  category_id UUID NOT NULL REFERENCES issue_categories(id),
  subcategory_id UUID NOT NULL REFERENCES issue_subcategories(id),
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ticket_id, role, subcategory_id)
);

CREATE INDEX IF NOT EXISTS idx_ticket_issues_ticket ON ticket_issues (ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_issues_sub ON ticket_issues (subcategory_id);

-- Backfill from scalar columns (primary / legacy)
INSERT INTO ticket_issues (ticket_id, role, category_id, subcategory_id, sort_order)
SELECT t.id, 'reported', t.reported_category_id, t.reported_subcategory_id, 0
FROM tickets t
WHERE t.reported_category_id IS NOT NULL
  AND t.reported_subcategory_id IS NOT NULL
ON CONFLICT (ticket_id, role, subcategory_id) DO NOTHING;

INSERT INTO ticket_issues (ticket_id, role, category_id, subcategory_id, sort_order)
SELECT t.id, 'found', t.found_category_id, t.found_subcategory_id, 0
FROM tickets t
WHERE t.found_category_id IS NOT NULL
  AND t.found_subcategory_id IS NOT NULL
ON CONFLICT (ticket_id, role, subcategory_id) DO NOTHING;
