import { query } from '../db/pool.js'

export const EOD_TIMEZONE = 'Asia/Kolkata'
const IST_OFFSET = '+05:30'
const DAY_MS = 86400000

export const UNKNOWN_RAISER = 'Unknown user'
export const UNRECORDED_CLOSER = 'Not recorded'

export type EodTicketRow = {
  ticketId: string
  slotId: number | null
  slotLabel: string
  road: string
  userId: string | null
  userName: string
  at: string
}

export type EodUserRow = {
  userId: string | null
  userName: string
  slots: string[]
  raised: number
  closed: number
}

export type EodReport = {
  /** First day of the period; kept for single-day callers. */
  date: string
  from: string
  to: string
  timezone: string
  generatedAt: string
  range: { from: string; to: string }
  summary: {
    ticketsRaised: number
    ticketsClosed: number
    usersRaised: number
    usersClosed: number
  }
  raised: EodTicketRow[]
  closed: EodTicketRow[]
  users: EodUserRow[]
}

/** Today's calendar date (YYYY-MM-DD) in IST, independent of the server timezone. */
export function todayIst(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: EOD_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** True for a real calendar date in strict YYYY-MM-DD form (rejects 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

/** Half-open IST day window: [date 00:00 IST, next day 00:00 IST). IST has no DST. */
export function istDayRange(date: string): { from: Date; to: Date } {
  const from = new Date(`${date}T00:00:00${IST_OFFSET}`)
  return { from, to: new Date(from.getTime() + DAY_MS) }
}

type TicketActivityDbRow = {
  ticket_id: string
  slot_id: string | number | null
  slot_label: string | null
  road: string
  user_id: string | null
  user_name: string | null
  at: string | Date
}

function toTicketRow(r: TicketActivityDbRow, fallbackName: string): EodTicketRow {
  return {
    ticketId: r.ticket_id,
    slotId: r.slot_id != null && r.slot_id !== '' ? Number(r.slot_id) : null,
    slotLabel: r.slot_label || '',
    road: r.road,
    userId: r.user_id,
    userName: r.user_id ? r.user_name || fallbackName : fallbackName,
    at: new Date(r.at).toISOString(),
  }
}

const compareText = (a: string, b: string) =>
  a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' })

function byUserThenTime(a: EodTicketRow, b: EodTicketRow) {
  return compareText(a.userName, b.userName) || a.at.localeCompare(b.at)
}

/**
 * One row per user id (not display name), so two people with the same name stay separate.
 * Slots are the unique Slot Labels across the user's raised and closed tickets.
 */
export function buildUserSummary(raised: EodTicketRow[], closed: EodTicketRow[]): EodUserRow[] {
  const byUser = new Map<string, EodUserRow & { slotSet: Set<string> }>()
  const entry = (row: EodTicketRow) => {
    const key = row.userId ?? `none:${row.userName}`
    let e = byUser.get(key)
    if (!e) {
      e = { userId: row.userId, userName: row.userName, slots: [], raised: 0, closed: 0, slotSet: new Set() }
      byUser.set(key, e)
    }
    if (row.slotLabel) e.slotSet.add(row.slotLabel)
    return e
  }
  for (const row of raised) entry(row).raised++
  for (const row of closed) entry(row).closed++

  return [...byUser.values()]
    .map(({ slotSet, ...rest }) => ({ ...rest, slots: [...slotSet].sort(compareText) }))
    .sort((a, b) => compareText(a.userName, b.userName) || String(a.userId).localeCompare(String(b.userId)))
}

const distinctUsers = (rows: EodTicketRow[]) =>
  new Set(rows.filter((r) => r.userId).map((r) => r.userId)).size

/** Report over IST days [fromDate, toDate], both inclusive, as one half-open window. */
export async function loadEodReport(fromDate: string, toDate: string = fromDate): Promise<EodReport> {
  const from = istDayRange(fromDate).from
  const to = istDayRange(toDate).to
  const params = [from.toISOString(), to.toISOString()]

  // One row per ticket: no joins to issues/events, so a ticket can never count twice.
  const raised = await query<TicketActivityDbRow>(
    `SELECT t.public_id AS ticket_id, d.slot_id, d.slot_number AS slot_label, r.name AS road,
            t.raised_by_user_id AS user_id, u.full_name AS user_name, t.raised_at AS at
     FROM tickets t
     JOIN devices d ON d.id = t.device_id
     JOIN roads r ON r.id = d.road_id
     LEFT JOIN users u ON u.id = t.raised_by_user_id
     WHERE t.deleted_at IS NULL AND t.raised_at >= $1 AND t.raised_at < $2`,
    params,
  )

  // Closer = actor of the latest closing event (status_label 'Closed' covers both
  // POST /close and an update with closeTicket). LIMIT 1 keeps it one row per ticket.
  const closed = await query<TicketActivityDbRow>(
    `SELECT t.public_id AS ticket_id, d.slot_id, d.slot_number AS slot_label, r.name AS road,
            ce.actor_user_id AS user_id, u.full_name AS user_name, t.closed_at AS at
     FROM tickets t
     JOIN devices d ON d.id = t.device_id
     JOIN roads r ON r.id = d.road_id
     LEFT JOIN LATERAL (
       SELECT e.actor_user_id
       FROM ticket_events e
       WHERE e.ticket_id = t.id AND e.status_label = 'Closed'
       ORDER BY e.created_at DESC
       LIMIT 1
     ) ce ON TRUE
     LEFT JOIN users u ON u.id = ce.actor_user_id
     WHERE t.deleted_at IS NULL AND t.status = 'Closed' AND t.closed_at >= $1 AND t.closed_at < $2`,
    params,
  )

  const raisedRows = raised.rows.map((r) => toTicketRow(r, UNKNOWN_RAISER)).sort(byUserThenTime)
  const closedRows = closed.rows.map((r) => toTicketRow(r, UNRECORDED_CLOSER)).sort(byUserThenTime)

  return {
    date: fromDate,
    from: fromDate,
    to: toDate,
    timezone: EOD_TIMEZONE,
    generatedAt: new Date().toISOString(),
    range: { from: from.toISOString(), to: to.toISOString() },
    summary: {
      ticketsRaised: raisedRows.length,
      ticketsClosed: closedRows.length,
      usersRaised: distinctUsers(raisedRows),
      usersClosed: distinctUsers(closedRows),
    },
    raised: raisedRows,
    closed: closedRows,
    users: buildUserSummary(raisedRows, closedRows),
  }
}
