import { Router } from 'express'
import { z } from 'zod'
import { handleApiError } from '../lib/api-error.js'
import { ok } from '../lib/respond.js'
import { query } from '../db/pool.js'
import { authorize, hasPermission, requireAuth, type AuthedRequest } from '../middleware/auth.js'
import { appendTicketVisibilitySql } from '../lib/ticket-access.js'
import {
  buildWorkReportPeople,
  daysInPeriodInclusive,
  resolveWorkReportRange,
  workReportSub,
  type WorkReportEventRow,
  type WorkReportView,
} from '../lib/work-report.js'

const router = Router()
router.use(requireAuth)

const filtersSchema = z.object({
  view: z.enum(['day', 'week', 'month', 'range']).default('day'),
  from: z.string().optional(),
  to: z.string().optional(),
  person: z.string().optional(),
  road: z.string().optional(),
})

type WorkFilters = z.infer<typeof filtersSchema>

function buildWorkWhere(filters: WorkFilters, user: AuthedRequest['user']) {
  const { from, to } = resolveWorkReportRange(filters.view as WorkReportView, filters.from, filters.to)
  const params: unknown[] = [from.toISOString(), to.toISOString()]
  const where: string[] = [
    `e.created_at >= $1`,
    `e.created_at < ($2::timestamptz + INTERVAL '1 day')`,
    `r.name IN ('Technician', 'Engineer')`,
  ]
  if (filters.person && filters.person !== 'Everyone') {
    params.push(filters.person)
    where.push(`u.full_name = $${params.length}`)
  }
  if (filters.road && filters.road !== 'All roads') {
    params.push(filters.road)
    where.push(`rd.name = $${params.length}`)
  }
  const visibility = appendTicketVisibilitySql(user!, params)
  if (visibility) where.push(visibility)
  return { from, to, params, where }
}

const eventSelect = `
  SELECT e.*, u.id AS user_id, u.full_name, r.name AS role_name,
         t.public_id AS ticket_public_id, t.status AS ticket_status,
         d.public_id AS device_public_id, d.slot_id, d.slot_number, rd.name AS road_name,
         COALESCE(fs.name, rs.name) AS issue_name
  FROM ticket_events e
  JOIN users u ON u.id = e.actor_user_id
  JOIN roles r ON r.id = u.role_id
  JOIN tickets t ON t.id = e.ticket_id
  JOIN devices d ON d.id = t.device_id
  JOIN roads rd ON rd.id = d.road_id
  LEFT JOIN issue_subcategories fs ON fs.id = t.found_subcategory_id
  LEFT JOIN issue_subcategories rs ON rs.id = t.reported_subcategory_id
`

router.get('/work', authorize('Work report', 'v'), async (req: AuthedRequest, res) => {
  try {
    const filters = filtersSchema.parse(req.query)
    const { from, to, params, where } = buildWorkWhere(filters, req.user)

    const events = await query(
      `${eventSelect}
       WHERE ${where.join(' AND ')}
       ORDER BY u.full_name, e.created_at`,
      params,
    )

    const showCost = hasPermission(req.user!, 'Work report', 'v')
    const people = buildWorkReportPeople(
      events.rows as WorkReportEventRow[],
      filters.view,
      showCost,
    )

    return ok(res, {
      view: filters.view,
      sub: workReportSub(filters.view, from, to),
      daysLabel: 'Days worked',
      daysInPeriod: daysInPeriodInclusive(from, to),
      note: `${people.length} field staff in period`,
      people,
    })
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/work/export', authorize('Work report', 'v'), async (req: AuthedRequest, res) => {
  try {
    const filters = filtersSchema.parse(req.query)
    const { params, where } = buildWorkWhere(filters, req.user)

    const result = await query(
      `SELECT u.full_name, t.public_id, e.event_type, e.cost, e.created_at, rd.name AS road_name
       FROM ticket_events e
       JOIN users u ON u.id = e.actor_user_id
       JOIN roles r ON r.id = u.role_id
       JOIN tickets t ON t.id = e.ticket_id
       JOIN devices d ON d.id = t.device_id
       JOIN roads rd ON rd.id = d.road_id
       WHERE ${where.join(' AND ')}
       ORDER BY e.created_at DESC
       LIMIT 5000`,
      params,
    )
    const header = 'Person,Ticket,Event,Cost,Road,When\n'
    const lines = result.rows.map(
      (r) =>
        `"${r.full_name}",${r.public_id},${r.event_type},${r.cost},"${r.road_name}",${r.created_at}`,
    )
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="work-report.csv"')
    return res.send(header + lines.join('\n'))
  } catch (error) {
    return handleApiError(res, error)
  }
})

export default router
