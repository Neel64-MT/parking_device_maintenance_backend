/** Derive operational device status from open tickets + severity. */
export type DerivedStatus = 'Working' | 'Under repair' | 'Not working'

export function deriveDeviceStatus(args: {
  openTicketStatus: string | null
  assigneeId: string | null
  severity: string | null
}): DerivedStatus {
  if (!args.openTicketStatus || args.openTicketStatus === 'Closed') return 'Working'
  if (args.openTicketStatus === 'Waiting for spare' || args.openTicketStatus === 'Under repair') {
    return 'Under repair'
  }
  // Historical tickets assigned before assignment was removed may still be stored as Open.
  if (args.assigneeId) return 'Under repair'
  if (args.severity === 'Minor') return 'Working'
  return 'Not working'
}

export function statusTone(status: DerivedStatus) {
  if (status === 'Working') return 'ok'
  if (status === 'Under repair') return 'warn'
  return 'bad'
}

/** Same order as `deriveDeviceStatus`: 2 = Not working, 1 = Under repair, 0 = Working. */
const OPEN_TICKET_RANK_SQL = `CASE
        WHEN t.status IN ('Waiting for spare', 'Under repair') OR t.assignee_id IS NOT NULL THEN 1
        WHEN COALESCE(fs.severity, rs.severity) = 'Minor' THEN 0
        ELSE 2
      END`

/**
 * One row per device (`d`) for its **worst** open ticket — a device may hold several open
 * tickets for different issues (Phase 50), and it is only as healthy as the worst of them.
 * Exposes `status`, `assignee_id`, `raised_at`, `public_id`, `severity`, `issue_name`,
 * `open_ticket_count` and `first_open_at` (earliest open raise, for days-down).
 * `assignee_id` only matters for historical tickets assigned before assignment was removed.
 */
export function openTicketLateralSql(alias = 'ot') {
  return `LEFT JOIN LATERAL (
      SELECT t.id, t.public_id, t.status, t.assignee_id, t.raised_at,
             COALESCE(fs.severity, rs.severity) AS severity,
             COALESCE(fs.name, rs.name) AS issue_name,
             (COUNT(*) OVER ())::int AS open_ticket_count,
             MIN(t.raised_at) OVER () AS first_open_at
      FROM tickets t
      LEFT JOIN issue_subcategories fs ON fs.id = t.found_subcategory_id
      LEFT JOIN issue_subcategories rs ON rs.id = t.reported_subcategory_id
      WHERE t.device_id = d.id AND t.status <> 'Closed'
      ORDER BY ${OPEN_TICKET_RANK_SQL} DESC, t.raised_at DESC
      LIMIT 1
    ) ${alias} ON TRUE`
}
