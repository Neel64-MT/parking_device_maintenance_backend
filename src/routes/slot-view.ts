import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handleApiError } from '../lib/api-error.js'
import { ok, paginated } from '../lib/respond.js'
import { query } from '../db/pool.js'
import { authorize, requireAuth, type AuthedRequest } from '../middleware/auth.js'
import { deviceDisplayId, deviceLookupWhere, slotLabelOrderBy } from '../lib/device-ref.js'
import { loadOpenDeviceTickets } from '../lib/ticket-issues.js'
import { limitSchema, pageSchema, paginationMeta, sqlOffset } from '../lib/pagination.js'

/**
 * Slot View (Phase 53): slot-centric read of ticket data across every road, gated on
 * its own `Slot View` v screen (Admin and Project manager by default, grantable per role
 * in Roles & permissions). Ticket rows for a slot come from `GET /api/tickets?device=`
 * so the list shape and pagination stay in one place; that call keeps its `All tickets` v gate.
 */
const router = Router()
router.use(requireAuth)

type SlotRow = {
  id: string
  public_id: string
  slot_id: string | number | null
  slot_number: string
  road_name: string
}

function mapSlot(row: SlotRow) {
  return {
    id: deviceDisplayId(row),
    uuid: row.id,
    slotId: row.slot_id != null && row.slot_id !== '' ? Number(row.slot_id) : null,
    slotLabel: row.slot_number || null,
    road: row.road_name,
  }
}

const listSchema = z.object({
  q: z.string().optional(),
  page: pageSchema,
  limit: limitSchema,
})

/**
 * Slots with at least one ticket (any status). Tickets are the base table, so a
 * slot without tickets never appears, and the count is per ticket — a ticket with
 * several issues counts once.
 */
router.get('/', authorize('Slot View', 'v'), async (req: AuthedRequest, res) => {
  try {
    const filters = listSchema.parse(req.query)
    const params: unknown[] = []
    const where: string[] = []
    if (filters.q?.trim()) {
      params.push(`%${filters.q.trim().toLowerCase()}%`)
      const p = `$${params.length}`
      where.push(
        `(LOWER(d.slot_number) LIKE ${p} OR CAST(d.slot_id AS TEXT) LIKE ${p} OR LOWER(d.public_id) LIKE ${p} OR LOWER(r.name) LIKE ${p})`,
      )
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const fromSql = `FROM tickets t
       JOIN devices d ON d.id = t.device_id
       JOIN roads r ON r.id = d.road_id
       ${whereSql}`

    const countResult = await query<{ n: number }>(
      `SELECT COUNT(DISTINCT t.device_id)::int AS n ${fromSql}`,
      params,
    )
    const total = countResult.rows[0]?.n ?? 0

    const pageParams = [...params, filters.limit, sqlOffset(filters.page, filters.limit)]
    const result = await query<SlotRow & { ticket_count: number }>(
      `SELECT d.id, d.public_id, d.slot_id, d.slot_number, r.name AS road_name,
              COUNT(t.id)::int AS ticket_count
       ${fromSql}
       GROUP BY d.id, r.name
       ${slotLabelOrderBy('d', { natural: true })}
       LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams,
    )

    const rows = result.rows.map((row) => ({ ...mapSlot(row), ticketCount: row.ticket_count }))
    return paginated(res, rows, paginationMeta(filters.page, filters.limit, total))
  } catch (error) {
    return handleApiError(res, error)
  }
})

/**
 * One slot: header, ticket count, and its unresolved issues — reported Sub Issues whose
 * persisted status is Open, one entry per Sub Issue with the tickets that hold it.
 */
router.get('/:slotId', authorize('Slot View', 'v'), async (req: AuthedRequest, res) => {
  try {
    const slotId = z.string().min(1).parse(req.params.slotId)
    const found = await query<SlotRow & { ticket_count: number }>(
      `SELECT d.id, d.public_id, d.slot_id, d.slot_number, r.name AS road_name,
              (SELECT COUNT(*)::int FROM tickets t WHERE t.device_id = d.id) AS ticket_count
       FROM devices d
       JOIN roads r ON r.id = d.road_id
       WHERE ${deviceLookupWhere('d', 1)}
       LIMIT 1`,
      [slotId],
    )
    const row = found.rows[0]
    if (!row) throw new ApiError(404, 'Slot not found', 'NOT_FOUND')

    const openTickets = await loadOpenDeviceTickets(row.id)
    const bySub = new Map<
      string,
      {
        id: string
        categoryId: string
        subCategoryId: string
        category: string
        sub: string
        severity: string
        status: 'Open'
        tickets: { id: string; uuid: string }[]
      }
    >()
    for (const ticket of openTickets) {
      for (const issue of ticket.issues) {
        let entry = bySub.get(issue.subCategoryId)
        if (!entry) {
          entry = {
            id: issue.id,
            categoryId: issue.categoryId,
            subCategoryId: issue.subCategoryId,
            category: issue.category,
            sub: issue.sub,
            severity: issue.severity,
            status: 'Open',
            tickets: [],
          }
          bySub.set(issue.subCategoryId, entry)
        }
        if (!entry.tickets.some((t) => t.uuid === ticket.uuid)) {
          entry.tickets.push({ id: ticket.id, uuid: ticket.uuid })
        }
      }
    }

    return ok(res, {
      slot: mapSlot(row),
      ticketCount: row.ticket_count,
      unresolvedIssues: [...bySub.values()],
    })
  } catch (error) {
    return handleApiError(res, error)
  }
})

export default router
