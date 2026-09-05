import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handleApiError } from '../lib/api-error.js'
import { created, ok } from '../lib/respond.js'
import { query, withTransaction } from '../db/pool.js'
import {
  assertRoadAccess,
  authorize,
  requireAuth,
  type AuthedRequest,
} from '../middleware/auth.js'
import { appendTicketVisibilitySql, assertTicketAccess } from '../lib/ticket-access.js'
import { nextPublicId } from '../lib/ids.js'

const router = Router()
router.use(requireAuth)

function tabForStatus(status: string, assigneeId: string | null) {
  if (status === 'Closed') return 'cls'
  if (!assigneeId || status === 'New') return 'new'
  return 'asg'
}

function statusTone(status: string) {
  if (status === 'Closed') return 'ok'
  if (status === 'Under repair' || status === 'Waiting for spare') return 'warn'
  return 'bad'
}

router.get('/', authorize('All tickets', 'v'), async (req: AuthedRequest, res) => {
  try {
    const schema = z.object({
      tab: z.enum(['new', 'asg', 'cls']).optional(),
      q: z.string().optional(),
      road: z.string().optional(),
      status: z.string().optional(),
      category: z.string().optional(),
      assignee: z.string().optional(),
      page: z.coerce.number().default(1),
      limit: z.coerce.number().default(50),
    })
    const filters = schema.parse(req.query)
    const params: unknown[] = []
    const where: string[] = []

    if (req.user!.scope === 'assigned_roads') {
      params.push(req.user!.roadIds)
      where.push(`d.road_id = ANY($${params.length})`)
    }
    const visibility = appendTicketVisibilitySql(req.user!, params)
    if (visibility) where.push(visibility)
    if (filters.road && filters.road !== 'All roads') {
      params.push(filters.road)
      where.push(`r.name = $${params.length}`)
    }
    if (filters.category && filters.category !== 'All categories') {
      params.push(filters.category)
      where.push(`COALESCE(fc.name, rc.name) = $${params.length}`)
    }
    if (filters.assignee && filters.assignee !== 'Anyone') {
      if (filters.assignee === 'Not assigned') {
        where.push(`t.assignee_id IS NULL`)
      } else {
        params.push(filters.assignee)
        where.push(`au.full_name = $${params.length}`)
      }
    }
    if (filters.q?.trim()) {
      params.push(`%${filters.q.trim().toLowerCase()}%`)
      where.push(
        `(LOWER(t.public_id) LIKE $${params.length} OR LOWER(d.public_id) LIKE $${params.length} OR LOWER(d.slot_number) LIKE $${params.length})`,
      )
    }

    const result = await query(
      `SELECT t.*, d.public_id AS device_public_id, d.slot_number, r.name AS road_name,
              au.full_name AS assignee_name,
              rc.name AS reported_cat, rs.name AS reported_sub,
              fc.name AS found_cat, fs.name AS found_sub,
              (SELECT COUNT(*)::int FROM ticket_events e WHERE e.ticket_id = t.id) AS updates
       FROM tickets t
       JOIN devices d ON d.id = t.device_id
       JOIN roads r ON r.id = d.road_id
       LEFT JOIN users au ON au.id = t.assignee_id
       LEFT JOIN issue_categories rc ON rc.id = t.reported_category_id
       LEFT JOIN issue_subcategories rs ON rs.id = t.reported_subcategory_id
       LEFT JOIN issue_categories fc ON fc.id = t.found_category_id
       LEFT JOIN issue_subcategories fs ON fs.id = t.found_subcategory_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY t.raised_at DESC`,
      params,
    )

    let rows = result.rows.map((t) => {
      const daysOpen = Math.floor(
        ((t.closed_at ? new Date(t.closed_at).getTime() : Date.now()) -
          new Date(t.raised_at).getTime()) /
          86400000,
      )
      const tab = tabForStatus(t.status, t.assignee_id)
      return {
        id: t.public_id,
        uuid: t.id,
        deviceId: t.device_public_id,
        tab,
        road: t.road_name,
        slot: `Slot ${t.slot_number}`,
        issueReported: t.reported_sub || t.description || '—',
        issueReportedDetail: t.reported_cat
          ? `${t.reported_cat} › ${t.reported_sub}`
          : null,
        issueFound: t.found_sub || null,
        issueFoundDetail: t.found_cat || null,
        assignedTo: t.assignee_name || null,
        updates: t.updates,
        daysOpen,
        daysBad: daysOpen > 3 && t.status !== 'Closed',
        status: t.status,
        statusTone: statusTone(t.status),
        actionLabel: !t.assignee_id && t.status !== 'Closed' ? 'Assign' : 'Open',
        actionPrimary: !t.assignee_id && t.status !== 'Closed',
      }
    })

    if (filters.tab) rows = rows.filter((r) => r.tab === filters.tab)
    if (filters.status && filters.status !== 'All') {
      if (filters.status === 'Open + under repair') {
        rows = rows.filter((r) => r.status !== 'Closed')
      } else if (filters.status === 'Open, not attended') {
        rows = rows.filter((r) => r.tab === 'new')
      } else {
        rows = rows.filter((r) => r.status === filters.status)
      }
    }

    const tiles = {
      openNotAttended: result.rows.filter((t) => tabForStatus(t.status, t.assignee_id) === 'new')
        .length,
      underRepair: result.rows.filter((t) => t.status === 'Under repair').length,
      waitingSpare: result.rows.filter((t) => t.status === 'Waiting for spare').length,
      openOver3: result.rows.filter((t) => {
        if (t.status === 'Closed') return false
        const days = Math.floor((Date.now() - new Date(t.raised_at).getTime()) / 86400000)
        return days > 3
      }).length,
    }

    const start = (filters.page - 1) * filters.limit
    return res.status(200).json({
      success: true,
      data: rows.slice(start, start + filters.limit),
      tiles: [
        { value: String(tiles.openNotAttended), label: 'Open, not attended', tone: 'bad' },
        { value: String(tiles.underRepair), label: 'Under repair', tone: 'warn' },
        { value: String(tiles.waitingSpare), label: 'Waiting for spare', tone: 'warn' },
        { value: String(tiles.openOver3), label: 'Open over 3 days', tone: 'bad' },
      ],
      tabCounts: {
        new: result.rows.filter((t) => tabForStatus(t.status, t.assignee_id) === 'new').length,
        asg: result.rows.filter((t) => tabForStatus(t.status, t.assignee_id) === 'asg').length,
        cls: result.rows.filter((t) => t.status === 'Closed').length,
      },
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total: rows.length,
        totalPages: Math.ceil(rows.length / filters.limit) || 1,
      },
    })
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/export', authorize('All tickets', 'v'), async (req: AuthedRequest, res) => {
  try {
    const params: unknown[] = []
    const where: string[] = []
    if (req.user!.scope === 'assigned_roads') {
      params.push(req.user!.roadIds)
      where.push(`d.road_id = ANY($${params.length})`)
    }
    const visibility = appendTicketVisibilitySql(req.user!, params)
    if (visibility) where.push(visibility)

    const result = await query(
      `SELECT t.public_id, d.public_id AS device, r.name AS road, t.status, t.raised_at
       FROM tickets t
       JOIN devices d ON d.id = t.device_id
       JOIN roads r ON r.id = d.road_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY t.raised_at DESC`,
      params,
    )
    const header = 'Ticket,Device,Road,Status,Raised\n'
    const lines = result.rows.map(
      (r) => `${r.public_id},${r.device},"${r.road}",${r.status},${r.raised_at}`,
    )
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="tickets.csv"')
    return res.send(header + lines.join('\n'))
  } catch (error) {
    return handleApiError(res, error)
  }
})

const raiseSchema = z.object({
  deviceId: z.string().min(1),
  categoryId: z.string().uuid(),
  subCategoryId: z.string().uuid(),
  description: z.string().optional(),
  reporterType: z.string().default('Site attendant'),
  assigneeId: z.string().uuid().nullable().optional(),
  priority: z.string().optional(),
  photos: z.array(z.string()).default([]),
})

router.post('/', authorize('Raise ticket', 'c'), async (req: AuthedRequest, res) => {
  try {
    const body = raiseSchema.parse(req.body)
    const device = await query(
      `SELECT d.*, r.name AS road_name FROM devices d JOIN roads r ON r.id = d.road_id
       WHERE d.public_id = $1 OR d.id::text = $1`,
      [body.deviceId],
    )
    if (!device.rowCount) throw new ApiError(404, 'Device not found', 'NOT_FOUND')
    assertRoadAccess(req.user!, device.rows[0].road_id)

    const open = await query(
      `SELECT public_id, id, status FROM tickets
       WHERE device_id = $1 AND status <> 'Closed'
       ORDER BY raised_at DESC LIMIT 1`,
      [device.rows[0].id],
    )
    if (open.rowCount) {
      throw new ApiError(409, 'This device already has an open ticket', 'OPEN_TICKET_EXISTS', {
        ticketId: open.rows[0].public_id,
      })
    }

    const recent = await query(
      `SELECT public_id, id, closed_at FROM tickets
       WHERE device_id = $1 AND status = 'Closed' AND closed_at >= NOW() - INTERVAL '7 days'
       ORDER BY closed_at DESC LIMIT 1`,
      [device.rows[0].id],
    )
    if (recent.rowCount) {
      throw new ApiError(
        409,
        'A ticket closed within 7 days should be reopened instead of creating a new one',
        'REOPEN_SAME_TICKET',
        { ticketId: recent.rows[0].public_id },
      )
    }

    const publicId = await nextPublicId('TK', 4)
    const status = body.assigneeId ? 'Under repair' : 'New'
    const ticket = await query(
      `INSERT INTO tickets (
        public_id, device_id, status, priority, reporter_type, description,
        reported_category_id, reported_subcategory_id,
        raised_by_user_id, assignee_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        publicId,
        device.rows[0].id,
        status,
        body.priority || null,
        body.reporterType,
        body.description || null,
        body.categoryId,
        body.subCategoryId,
        req.user!.id,
        body.assigneeId || null,
      ],
    )

    await query(
      `INSERT INTO ticket_events (ticket_id, event_type, title, body, status_label, actor_user_id, category_id, subcategory_id, photos)
       VALUES ($1,'raised','Ticket raised',$2,$3,$4,$5,$6,$7)`,
      [
        ticket.rows[0].id,
        body.description || 'Ticket raised',
        status,
        req.user!.id,
        body.categoryId,
        body.subCategoryId,
        JSON.stringify(body.photos),
      ],
    )

    if (body.assigneeId) {
      await query(
        `INSERT INTO ticket_assignments (ticket_id, from_user_id, to_user_id, reason)
         VALUES ($1,$2,$3,'Assigned at raise')`,
        [ticket.rows[0].id, req.user!.id, body.assigneeId],
      )
    }

    return created(res, { id: publicId, uuid: ticket.rows[0].id, status }, 'Ticket raised')
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/:ticketId', authorize('All tickets', 'v'), async (req: AuthedRequest, res) => {
  try {
    const result = await query(
      `SELECT t.*, d.public_id AS device_public_id, d.slot_number, d.road_id,
              r.name AS road_name, ru.full_name AS raised_by_name, au.full_name AS assignee_name,
              rc.name AS reported_cat, rs.name AS reported_sub,
              fc.name AS found_cat, fs.name AS found_sub
       FROM tickets t
       JOIN devices d ON d.id = t.device_id
       JOIN roads r ON r.id = d.road_id
       LEFT JOIN users ru ON ru.id = t.raised_by_user_id
       LEFT JOIN users au ON au.id = t.assignee_id
       LEFT JOIN issue_categories rc ON rc.id = t.reported_category_id
       LEFT JOIN issue_subcategories rs ON rs.id = t.reported_subcategory_id
       LEFT JOIN issue_categories fc ON fc.id = t.found_category_id
       LEFT JOIN issue_subcategories fs ON fs.id = t.found_subcategory_id
       WHERE t.public_id = $1 OR t.id::text = $1`,
      [req.params.ticketId],
    )
    if (!result.rowCount) throw new ApiError(404, 'Ticket not found', 'NOT_FOUND')
    const t = result.rows[0]
    assertTicketAccess(req.user!, t)

    const events = await query(
      `SELECT e.*, u.full_name AS actor_name, c.name AS cat_name, s.name AS sub_name
       FROM ticket_events e
       LEFT JOIN users u ON u.id = e.actor_user_id
       LEFT JOIN issue_categories c ON c.id = e.category_id
       LEFT JOIN issue_subcategories s ON s.id = e.subcategory_id
       WHERE e.ticket_id = $1
       ORDER BY e.created_at DESC`,
      [t.id],
    )

    const assignments = await query(
      `SELECT a.*, fu.full_name AS from_name, tu.full_name AS to_name
       FROM ticket_assignments a
       LEFT JOIN users fu ON fu.id = a.from_user_id
       LEFT JOIN users tu ON tu.id = a.to_user_id
       WHERE a.ticket_id = $1
       ORDER BY a.created_at DESC`,
      [t.id],
    )

    const previous = await query(
      `SELECT public_id AS id, COALESCE(fs.name, rs.name) AS issue,
              GREATEST(0, EXTRACT(DAY FROM (COALESCE(closed_at, NOW()) - raised_at)))::int AS days
       FROM tickets t
       LEFT JOIN issue_subcategories fs ON fs.id = t.found_subcategory_id
       LEFT JOIN issue_subcategories rs ON rs.id = t.reported_subcategory_id
       WHERE t.device_id = $1 AND t.id <> $2
       ORDER BY t.raised_at DESC LIMIT 10`,
      [t.device_id, t.id],
    )

    const daysOpen = Math.floor(
      ((t.closed_at ? new Date(t.closed_at).getTime() : Date.now()) -
        new Date(t.raised_at).getTime()) /
        86400000,
    )

    return ok(res, {
      header: {
        id: t.public_id,
        deviceId: t.device_public_id,
        road: t.road_name,
        slot: t.slot_number,
        status: t.status,
        statusTone: statusTone(t.status),
        facts: [
          { label: 'Raised on', value: t.raised_at },
          { label: 'Raised by', value: t.raised_by_name },
          { label: 'Assigned to', value: t.assignee_name || 'Not assigned' },
          { label: 'Days open', value: `${daysOpen} days`, bad: daysOpen > 3 },
          { label: 'Cost so far', value: `₹ ${Number(t.total_cost).toLocaleString('en-IN')}` },
        ],
      },
      classification: {
        reported: { category: t.reported_cat, sub: t.reported_sub },
        found: { category: t.found_cat, sub: t.found_sub },
      },
      workHistory: events.rows.map((e) => ({
        when: e.created_at,
        actor: e.actor_name,
        title: e.title,
        status: e.status_label,
        body: e.body,
        cost: e.cost,
        nextVisit: e.next_visit_at,
        parts: e.parts,
        photos: e.photos,
        meta: e.meta,
      })),
      assignmentTrail: assignments.rows.map((a) => ({
        when: a.created_at,
        title: a.from_name ? `${a.from_name} → ${a.to_name || '—'}` : `Raised / ${a.to_name || 'unassigned'}`,
        body: a.reason,
      })),
      devicePreviousTickets: previous.rows,
      assigneeId: t.assignee_id,
    })
  } catch (error) {
    return handleApiError(res, error)
  }
})

function assertHolder(req: AuthedRequest, assigneeId: string | null) {
  if (!assigneeId) return
  if (req.user!.roleName === 'Admin' || req.user!.roleName === 'Project manager') return
  if (req.user!.id !== assigneeId) {
    throw new ApiError(403, 'Only the ticket holder can perform this action', 'NOT_HOLDER')
  }
}

router.post('/:ticketId/assign', authorize('All tickets', 'a'), async (req: AuthedRequest, res) => {
  try {
    const body = z
      .object({ assigneeId: z.string().uuid(), reason: z.string().optional() })
      .parse(req.body)
    const ticket = await query(
      `SELECT t.*, d.road_id FROM tickets t JOIN devices d ON d.id = t.device_id
       WHERE t.public_id = $1 OR t.id::text = $1`,
      [req.params.ticketId],
    )
    if (!ticket.rowCount) throw new ApiError(404, 'Ticket not found', 'NOT_FOUND')
    const t = ticket.rows[0]
    if (t.status === 'Closed') throw new ApiError(409, 'Ticket is closed', 'CLOSED')
    /* Assign: road scope only — Control room must assign tickets they did not raise. */
    assertRoadAccess(req.user!, t.road_id)

    await query(`UPDATE tickets SET assignee_id = $2, status = 'Under repair', updated_at = NOW() WHERE id = $1`, [
      t.id,
      body.assigneeId,
    ])
    await query(
      `INSERT INTO ticket_assignments (ticket_id, from_user_id, to_user_id, reason)
       VALUES ($1,$2,$3,$4)`,
      [t.id, t.assignee_id, body.assigneeId, body.reason || 'Reassigned'],
    )
    await query(
      `INSERT INTO ticket_events (ticket_id, event_type, title, body, status_label, actor_user_id)
       VALUES ($1,'assigned','Assigned','Ticket reassigned','Still open',$2)`,
      [t.id, req.user!.id],
    )
    return ok(res, { id: t.public_id }, 'Ticket assigned')
  } catch (error) {
    return handleApiError(res, error)
  }
})

const updateSchema = z.object({
  updateType: z.enum([
    'Site visit — not resolved',
    'Site visit — resolved',
    'Remote check',
    'Waiting for spare',
    'Waiting for traffic police / AMC',
  ]),
  categoryId: z.string().uuid().optional(),
  subCategoryId: z.string().uuid().optional(),
  workDone: z.string().optional(),
  notFixedReason: z.string().optional(),
  nextVisitAt: z.string().optional(),
  cost: z.coerce.number().nonnegative().default(0),
  parts: z.array(z.string()).default([]),
  photos: z.array(z.string()).default([]),
  handoverToUserId: z.string().uuid().nullable().optional(),
})

router.post('/:ticketId/updates', authorize('Update ticket', 'e'), async (req: AuthedRequest, res) => {
  try {
    const body = updateSchema.parse(req.body)
    const ticket = await query(
      `SELECT t.*, d.road_id FROM tickets t JOIN devices d ON d.id = t.device_id
       WHERE t.public_id = $1 OR t.id::text = $1`,
      [req.params.ticketId],
    )
    if (!ticket.rowCount) throw new ApiError(404, 'Ticket not found', 'NOT_FOUND')
    const t = ticket.rows[0]
    if (t.status === 'Closed') throw new ApiError(409, 'Ticket is closed', 'CLOSED')
    assertTicketAccess(req.user!, t)
    assertHolder(req, t.assignee_id)

    let newStatus = t.status
    if (body.updateType === 'Waiting for spare') newStatus = 'Waiting for spare'
    else if (body.updateType.includes('resolved')) newStatus = 'Under repair'
    else if (!t.assignee_id) newStatus = 'Under repair'
    else newStatus = 'Under repair'

    if (body.categoryId && body.subCategoryId) {
      const changed =
        body.subCategoryId !== (t.found_subcategory_id || t.reported_subcategory_id)
      await query(
        `UPDATE tickets SET found_category_id = $2, found_subcategory_id = $3, updated_at = NOW() WHERE id = $1`,
        [t.id, body.categoryId, body.subCategoryId],
      )
      if (changed) {
        await query(
          `INSERT INTO ticket_events (ticket_id, event_type, title, body, status_label, actor_user_id, category_id, subcategory_id)
           VALUES ($1,'reclassified','Issue reclassified','Category updated on site','Still open',$2,$3,$4)`,
          [t.id, req.user!.id, body.categoryId, body.subCategoryId],
        )
      }
    }

    await query(
      `INSERT INTO ticket_events (
         ticket_id, event_type, title, body, status_label, actor_user_id,
         category_id, subcategory_id, cost, next_visit_at, not_fixed_reason, work_done, photos, parts
       ) VALUES ($1,$2,$3,$4,'Still open',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        t.id,
        body.updateType.includes('resolved')
          ? 'visit_resolved'
          : body.updateType === 'Waiting for spare'
            ? 'waiting_spare'
            : 'visit_open',
        body.updateType,
        body.workDone || body.updateType,
        req.user!.id,
        body.categoryId || null,
        body.subCategoryId || null,
        body.cost,
        body.nextVisitAt || null,
        body.notFixedReason || null,
        body.workDone || null,
        JSON.stringify(body.photos),
        JSON.stringify(body.parts),
      ],
    )

    await query(
      `UPDATE tickets SET status = $2, total_cost = total_cost + $3, updated_at = NOW() WHERE id = $1`,
      [t.id, newStatus, body.cost],
    )

    if (body.handoverToUserId) {
      await query(`UPDATE tickets SET assignee_id = $2 WHERE id = $1`, [
        t.id,
        body.handoverToUserId,
      ])
      await query(
        `INSERT INTO ticket_assignments (ticket_id, from_user_id, to_user_id, reason)
         VALUES ($1,$2,$3,'Handover on update')`,
        [t.id, req.user!.id, body.handoverToUserId],
      )
    } else if (!t.assignee_id) {
      await query(`UPDATE tickets SET assignee_id = $2 WHERE id = $1`, [t.id, req.user!.id])
    }

    return ok(res, { id: t.public_id, status: newStatus, resolvedReady: body.updateType.includes('resolved') }, 'Update saved')
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/:ticketId/close-preview', authorize('Update ticket', 'x'), async (req: AuthedRequest, res) => {
  try {
    const ticket = await query(
      `SELECT t.*, d.road_id FROM tickets t
       JOIN devices d ON d.id = t.device_id
       WHERE t.public_id = $1 OR t.id::text = $1`,
      [req.params.ticketId],
    )
    if (!ticket.rowCount) throw new ApiError(404, 'Ticket not found', 'NOT_FOUND')
    assertTicketAccess(req.user!, ticket.rows[0])
    const events = await query(
      `SELECT created_at, work_done, title, cost FROM ticket_events
       WHERE ticket_id = $1 AND cost IS NOT NULL
       ORDER BY created_at`,
      [ticket.rows[0].id],
    )
    const rows = events.rows.map((e) => ({
      date: e.created_at,
      work: e.work_done || e.title,
      cost: Number(e.cost || 0),
    }))
    const total = rows.reduce((s, r) => s + r.cost, 0)
    return ok(res, { rows, total })
  } catch (error) {
    return handleApiError(res, error)
  }
})

const closeSchema = z.object({
  categoryId: z.string().uuid(),
  subCategoryId: z.string().uuid(),
  workDone: z.string().min(1),
  parts: z.array(z.string()).default([]),
  photos: z.array(z.string()).default([]),
  cost: z.coerce.number().nonnegative().default(0),
  deviceTested: z.string().min(1),
})

router.post('/:ticketId/close', authorize('Update ticket', 'x'), async (req: AuthedRequest, res) => {
  try {
    const body = closeSchema.parse(req.body)
    if (body.deviceTested.toLowerCase().includes('not tested')) {
      throw new ApiError(400, 'Device must be tested before closing', 'NOT_TESTED')
    }

    const ticket = await query(
      `SELECT t.*, d.road_id FROM tickets t JOIN devices d ON d.id = t.device_id
       WHERE t.public_id = $1 OR t.id::text = $1`,
      [req.params.ticketId],
    )
    if (!ticket.rowCount) throw new ApiError(404, 'Ticket not found', 'NOT_FOUND')
    const t = ticket.rows[0]
    if (t.status === 'Closed') throw new ApiError(409, 'Already closed', 'CLOSED')
    assertTicketAccess(req.user!, t)
    assertHolder(req, t.assignee_id)

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE tickets SET
           status = 'Closed',
           found_category_id = $2,
           found_subcategory_id = $3,
           closed_at = NOW(),
           total_cost = total_cost + $4,
           updated_at = NOW()
         WHERE id = $1`,
        [t.id, body.categoryId, body.subCategoryId, body.cost],
      )
      await client.query(
        `INSERT INTO ticket_events (
           ticket_id, event_type, title, body, status_label, actor_user_id,
           category_id, subcategory_id, cost, work_done, photos, parts, meta
         ) VALUES ($1,'closed','Ticket closed',$2,'Closed',$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          t.id,
          body.workDone,
          req.user!.id,
          body.categoryId,
          body.subCategoryId,
          body.cost,
          body.workDone,
          JSON.stringify(body.photos),
          JSON.stringify(body.parts),
          JSON.stringify({ deviceTested: body.deviceTested }),
        ],
      )
    })

    return ok(res, { id: t.public_id, status: 'Closed' }, 'Ticket closed')
  } catch (error) {
    return handleApiError(res, error)
  }
})

export default router
