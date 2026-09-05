import { Router } from 'express'
import { z } from 'zod'
import { handleApiError } from '../lib/api-error.js'
import { ok } from '../lib/respond.js'
import { query } from '../db/pool.js'
import { authorize, hasPermission, requireAuth, type AuthedRequest } from '../middleware/auth.js'
import { appendTicketVisibilitySql } from '../lib/ticket-access.js'

const router = Router()
router.use(requireAuth)

router.get('/work', authorize('Work report', 'v'), async (req: AuthedRequest, res) => {
  try {
    const filters = z
      .object({
        view: z.enum(['day', 'week', 'month', 'range']).default('day'),
        from: z.string().optional(),
        to: z.string().optional(),
        person: z.string().optional(),
        road: z.string().optional(),
      })
      .parse(req.query)

    const to = filters.to ? new Date(filters.to) : new Date()
    const from = filters.from
      ? new Date(filters.from)
      : filters.view === 'month'
        ? new Date(to.getFullYear(), to.getMonth(), 1)
        : filters.view === 'week'
          ? new Date(to.getTime() - 6 * 86400000)
          : new Date(to.toISOString().slice(0, 10))

    const params: unknown[] = [from.toISOString(), to.toISOString()]
    const where: string[] = [`e.created_at >= $1`, `e.created_at < ($2::timestamptz + INTERVAL '1 day')`]
    if (filters.person && filters.person !== 'Everyone') {
      params.push(filters.person)
      where.push(`u.full_name = $${params.length}`)
    }
    if (filters.road && filters.road !== 'All roads') {
      params.push(filters.road)
      where.push(`r.name = $${params.length}`)
    }

    const visibility = appendTicketVisibilitySql(req.user!, params)
    if (visibility) where.push(visibility)

    const events = await query(
      `SELECT e.*, u.id AS user_id, u.full_name, r.name AS role_name,
              t.public_id AS ticket_public_id, t.status AS ticket_status,
              d.public_id AS device_public_id, d.slot_number, rd.name AS road_name,
              COALESCE(fs.name, rs.name) AS issue_name
       FROM ticket_events e
       JOIN users u ON u.id = e.actor_user_id
       JOIN roles r ON r.id = u.role_id
       JOIN tickets t ON t.id = e.ticket_id
       JOIN devices d ON d.id = t.device_id
       JOIN roads rd ON rd.id = d.road_id
       LEFT JOIN issue_subcategories fs ON fs.id = t.found_subcategory_id
       LEFT JOIN issue_subcategories rs ON rs.id = t.reported_subcategory_id
       WHERE ${where.join(' AND ')}
         AND r.name = 'Technician'
       ORDER BY u.full_name, e.created_at`,
      params,
    )

    const showCost = hasPermission(req.user!, 'Work report', 'v')
    const byUser = new Map<
      string,
      {
        name: string
        role: string
        roads: Set<string>
        visits: number
        worked: Set<string>
        closed: Set<string>
        open: Set<string>
        cost: number
        tickets: Array<string[]>
      }
    >()

    for (const e of events.rows) {
      const key = e.user_id as string
      if (!byUser.has(key)) {
        byUser.set(key, {
          name: e.full_name,
          role: e.role_name,
          roads: new Set(),
          visits: 0,
          worked: new Set(),
          closed: new Set(),
          open: new Set(),
          cost: 0,
          tickets: [],
        })
      }
      const u = byUser.get(key)!
      u.roads.add(e.road_name)
      u.visits += 1
      u.worked.add(e.ticket_public_id)
      u.cost += Number(e.cost || 0)
      if (e.event_type === 'closed' || e.ticket_status === 'Closed') u.closed.add(e.ticket_public_id)
      else u.open.add(e.ticket_public_id)
      u.tickets.push([
        e.ticket_public_id,
        e.device_public_id,
        `${e.road_name} · ${e.slot_number}`,
        e.issue_name || '—',
        e.work_done || e.title || e.body || '',
        e.event_type === 'closed' ? 'Closed' : 'In progress',
      ])
    }

    const people = [...byUser.values()].map((p) => {
      const worked = p.worked.size || 1
      const closed = p.closed.size
      return {
        name: p.name,
        role: p.role,
        roads: [...p.roads].join(', ') || '—',
        days: 1,
        visits: p.visits,
        worked: p.worked.size,
        closed,
        open: Math.max(0, p.open.size - closed),
        cost: showCost ? `₹ ${p.cost.toLocaleString('en-IN')}` : undefined,
        load: Math.min(100, Math.round((p.visits / 10) * 100)),
        tickets: p.tickets,
      }
    })

    const daysInPeriod =
      filters.view === 'month' ? 31 : filters.view === 'week' || filters.view === 'range' ? 7 : 1

    return ok(res, {
      view: filters.view,
      sub: `${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}`,
      daysLabel: 'Days worked',
      daysInPeriod,
      note: `${people.length} technicians in period`,
      people,
    })
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/work/export', authorize('Work report', 'v'), async (req: AuthedRequest, res) => {
  try {
    const params: unknown[] = []
    const visibility = appendTicketVisibilitySql(req.user!, params)
    const visFilter = visibility ? `WHERE ${visibility}` : ''

    const result = await query(
      `SELECT u.full_name, t.public_id, e.event_type, e.cost, e.created_at
       FROM ticket_events e
       JOIN users u ON u.id = e.actor_user_id
       JOIN tickets t ON t.id = e.ticket_id
       ${visFilter}
       ORDER BY e.created_at DESC
       LIMIT 5000`,
      params,
    )
    const header = 'Person,Ticket,Event,Cost,When\n'
    const lines = result.rows.map(
      (r) => `"${r.full_name}",${r.public_id},${r.event_type},${r.cost},${r.created_at}`,
    )
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="work-report.csv"')
    return res.send(header + lines.join('\n'))
  } catch (error) {
    return handleApiError(res, error)
  }
})

export default router
