import { query } from '../db/pool.js'
import { EOD_TIMEZONE, UNRECORDED_CLOSER, istDayRange } from './eod-report.js'

/** Add Update event types (same set as the ticket list "Updates" column). */
export const UPDATE_EVENT_TYPES = ['visit_open', 'visit_resolved', 'waiting_spare', 'reclassified']

export type UserActivityRow = {
  userId: string | null
  userName: string
  role: string | null
  raised: number
  updated: number
  closed: number
}

export type UserActivity = {
  from: string
  to: string
  timezone: string
  generatedAt: string
  range: { from: string; to: string }
  summary: { ticketsRaised: number; ticketsUpdated: number; ticketsClosed: number; activeUsers: number }
  users: UserActivityRow[]
}

type ActivityDbRow = {
  user_id: string | null
  user_name: string | null
  role: string | null
  raised: number
  updated: number
  closed: number
}

/**
 * Per-user ticket activity over IST days [from, to] (both inclusive), as one half-open window.
 * - raised: tickets the user raised (`tickets.raised_by_user_id`, `raised_at` in window)
 * - updated: distinct tickets the user logged an Add Update on (event in window)
 * - closed: tickets closed in window whose latest closing event was recorded by the user
 * A missing user id (legacy rows) is reported as one "Not recorded" row.
 */
export async function loadUserActivity(from: string, to: string): Promise<UserActivity> {
  const start = istDayRange(from).from
  const end = istDayRange(to).to
  const params = [start.toISOString(), end.toISOString(), UPDATE_EVENT_TYPES]

  const result = await query<ActivityDbRow>(
    `WITH raised AS (
       SELECT t.raised_by_user_id AS user_id, COUNT(*)::int AS n
       FROM tickets t
       WHERE t.deleted_at IS NULL AND t.raised_at >= $1 AND t.raised_at < $2
       GROUP BY 1
     ),
     updated AS (
       SELECT e.actor_user_id AS user_id, COUNT(DISTINCT e.ticket_id)::int AS n
       FROM ticket_events e
       JOIN tickets t ON t.id = e.ticket_id
       WHERE t.deleted_at IS NULL
         AND e.event_type = ANY($3::text[]) AND e.created_at >= $1 AND e.created_at < $2
       GROUP BY 1
     ),
     closed AS (
       SELECT ce.actor_user_id AS user_id, COUNT(*)::int AS n
       FROM tickets t
       LEFT JOIN LATERAL (
         SELECT e.actor_user_id
         FROM ticket_events e
         WHERE e.ticket_id = t.id AND e.status_label = 'Closed'
         ORDER BY e.created_at DESC
         LIMIT 1
       ) ce ON TRUE
       WHERE t.deleted_at IS NULL AND t.status = 'Closed' AND t.closed_at >= $1 AND t.closed_at < $2
       GROUP BY 1
     ),
     people AS (
       SELECT user_id FROM raised UNION SELECT user_id FROM updated UNION SELECT user_id FROM closed
     )
     SELECT p.user_id, u.full_name AS user_name, ro.name AS role,
            COALESCE(r.n, 0) AS raised, COALESCE(up.n, 0) AS updated, COALESCE(c.n, 0) AS closed
     FROM people p
     LEFT JOIN raised r ON r.user_id IS NOT DISTINCT FROM p.user_id
     LEFT JOIN updated up ON up.user_id IS NOT DISTINCT FROM p.user_id
     LEFT JOIN closed c ON c.user_id IS NOT DISTINCT FROM p.user_id
     LEFT JOIN users u ON u.id = p.user_id
     LEFT JOIN roles ro ON ro.id = u.role_id`,
    params,
  )

  // Totals are distinct tickets: one ticket updated by two users counts once here.
  const totals = await query<{ raised: number; updated: number; closed: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM tickets WHERE deleted_at IS NULL AND raised_at >= $1 AND raised_at < $2) AS raised,
       (SELECT COUNT(DISTINCT e.ticket_id)::int FROM ticket_events e
         JOIN tickets t ON t.id = e.ticket_id
         WHERE t.deleted_at IS NULL
           AND e.event_type = ANY($3::text[]) AND e.created_at >= $1 AND e.created_at < $2) AS updated,
       (SELECT COUNT(*)::int FROM tickets
         WHERE deleted_at IS NULL AND status = 'Closed' AND closed_at >= $1 AND closed_at < $2) AS closed`,
    params,
  )

  const users = result.rows
    .map((r) => ({
      userId: r.user_id,
      userName: r.user_id ? r.user_name || 'Unknown user' : UNRECORDED_CLOSER,
      role: r.user_id ? r.role : null,
      raised: Number(r.raised),
      updated: Number(r.updated),
      closed: Number(r.closed),
    }))
    .sort(
      (a, b) =>
        b.raised + b.updated + b.closed - (a.raised + a.updated + a.closed) ||
        a.userName.localeCompare(b.userName, 'en', { sensitivity: 'base' }) ||
        String(a.userId).localeCompare(String(b.userId)),
    )

  const t = totals.rows[0]
  return {
    from,
    to,
    timezone: EOD_TIMEZONE,
    generatedAt: new Date().toISOString(),
    range: { from: start.toISOString(), to: end.toISOString() },
    summary: {
      ticketsRaised: Number(t?.raised ?? 0),
      ticketsUpdated: Number(t?.updated ?? 0),
      ticketsClosed: Number(t?.closed ?? 0),
      activeUsers: users.filter((u) => u.userId).length,
    },
    users,
  }
}
