import { Router } from 'express'
import { z } from 'zod'
import QRCode from 'qrcode'
import { ApiError, handleApiError } from '../lib/api-error.js'
import { created, ok } from '../lib/respond.js'
import { query } from '../db/pool.js'
import {
  assertRoadAccess,
  authorize,
  requireAuth,
  type AuthUser,
  type AuthedRequest,
} from '../middleware/auth.js'
import { nextPublicId, qrFromDeviceId } from '../lib/ids.js'
import { deriveDeviceStatus, statusTone } from '../lib/device-status.js'
import { appendTicketVisibilitySql } from '../lib/ticket-access.js'

const router = Router()
router.use(requireAuth)

const listSchema = z.object({
  q: z.string().optional(),
  road: z.string().optional(),
  status: z.string().optional(),
  repeats: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
})

async function deviceListQuery(
  filters: z.infer<typeof listSchema>,
  user: AuthUser,
  roadIds?: string[],
) {
  const params: unknown[] = []
  const where: string[] = []

  if (roadIds && roadIds.length) {
    params.push(roadIds)
    where.push(`d.road_id = ANY($${params.length})`)
  }
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim().toLowerCase()}%`)
    where.push(
      `(LOWER(d.public_id) LIKE $${params.length} OR LOWER(d.qr_code) LIKE $${params.length} OR LOWER(d.slot_number) LIKE $${params.length})`,
    )
  }
  if (filters.road && filters.road !== 'All roads') {
    params.push(filters.road)
    where.push(`r.name = $${params.length}`)
  }

  const visibility = appendTicketVisibilitySql(user, params)
  const visFilter = visibility ? `AND ${visibility}` : ''

  const sql = `
    SELECT d.*, r.name AS road_name,
      ot.public_id AS open_ticket_id,
      ot.status AS open_ticket_status,
      ot.assignee_id AS open_assignee_id,
      ot.raised_at AS open_raised_at,
      COALESCE(fs.name, rs.name) AS issue_name,
      COALESCE(fs.severity, rs.severity) AS severity,
      (
        SELECT COUNT(*)::int FROM tickets t
        WHERE t.device_id = d.id AND t.raised_at >= NOW() - INTERVAL '6 months'
        ${visFilter}
      ) AS tickets_6m
    FROM devices d
    JOIN roads r ON r.id = d.road_id
    LEFT JOIN LATERAL (
      SELECT t.* FROM tickets t
      WHERE t.device_id = d.id AND t.status NOT IN ('Closed')
      ${visFilter}
      ORDER BY t.raised_at DESC LIMIT 1
    ) ot ON TRUE
    LEFT JOIN issue_subcategories fs ON fs.id = ot.found_subcategory_id
    LEFT JOIN issue_subcategories rs ON rs.id = ot.reported_subcategory_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY d.public_id`

  return query(sql, params)
}

router.get('/', authorize('Device list', 'v'), async (req: AuthedRequest, res) => {
  try {
    const filters = listSchema.parse(req.query)
    const scoped =
      req.user!.scope === 'assigned_roads' ? req.user!.roadIds : undefined
    const result = await deviceListQuery(filters, req.user!, scoped)

    let rows = result.rows.map((row) => {
      const status = deriveDeviceStatus({
        openTicketStatus: row.open_ticket_status,
        assigneeId: row.open_assignee_id,
        severity: row.severity,
      })
      const daysOpen = row.open_raised_at
        ? Math.floor((Date.now() - new Date(row.open_raised_at).getTime()) / 86400000)
        : null
      return {
        id: row.public_id,
        uuid: row.id,
        qr: row.qr_code,
        road: row.road_name,
        slot: `Slot ${row.slot_number}`,
        installed: row.installed_on,
        status,
        statusTone: statusTone(status),
        issue: row.issue_name || null,
        ticketId: row.open_ticket_id || null,
        ticketNote: daysOpen != null ? `${daysOpen} days open` : null,
        tickets6m: row.tickets_6m,
        ticketsBad: row.tickets_6m >= 3,
        _status: status,
      }
    })

    if (filters.status && filters.status !== 'All') {
      rows = rows.filter((r) => r.status === filters.status)
    }
    if (filters.repeats === '3 or more in 6 months') {
      rows = rows.filter((r) => r.tickets6m >= 3)
    } else if (filters.repeats === '5 or more in 6 months') {
      rows = rows.filter((r) => r.tickets6m >= 5)
    }

    const total = rows.length
    const start = (filters.page - 1) * filters.limit
    const pageRows = rows.slice(start, start + filters.limit)

    const working = rows.filter((r) => r.status === 'Working').length
    const repair = rows.filter((r) => r.status === 'Under repair').length
    const down = rows.filter((r) => r.status === 'Not working').length

    return res.status(200).json({
      success: true,
      data: pageRows.map(({ _status, ...rest }) => rest),
      tiles: [
        { value: String(total), label: 'Total devices' },
        { value: String(working), label: 'Working', tone: 'ok' },
        { value: String(repair), label: 'Under repair', tone: 'warn' },
        { value: String(down), label: 'Not working', tone: 'bad' },
      ],
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        totalPages: Math.ceil(total / filters.limit) || 1,
      },
    })
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/export', authorize('Device list', 'v'), async (req: AuthedRequest, res) => {
  try {
    const filters = listSchema.parse(req.query)
    const scoped =
      req.user!.scope === 'assigned_roads' ? req.user!.roadIds : undefined
    const result = await deviceListQuery(filters, req.user!, scoped)
    const header = 'Device ID,QR,Road,Slot,Status,Tickets6m\n'
    const lines = result.rows.map((r) => {
      const status = deriveDeviceStatus({
        openTicketStatus: r.open_ticket_status,
        assigneeId: r.open_assignee_id,
        severity: r.severity,
      })
      return `${r.public_id},${r.qr_code},"${r.road_name}",${r.slot_number},${status},${r.tickets_6m}`
    })
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="devices.csv"')
    return res.send(header + lines.join('\n'))
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/next-ids', authorize('Add device', 'c'), async (_req, res) => {
  try {
    const max = await query<{ n: number }>(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(public_id FROM 4) AS INTEGER)), 0) AS n FROM devices`,
    )
    const next = max.rows[0].n + 1
    const deviceId = `PD-${String(next).padStart(4, '0')}`
    return ok(res, { deviceId, qr: qrFromDeviceId(deviceId) })
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/scan', authorize('Scan QR', 'v'), async (req: AuthedRequest, res) => {
  try {
    const q = String(req.query.q || '').trim().toUpperCase()
    if (!q) throw new ApiError(400, 'Query is required', 'VALIDATION_ERROR')

    const params: unknown[] = [q]
    const visibility = appendTicketVisibilitySql(req.user!, params)
    const visFilter = visibility ? `AND ${visibility}` : ''

    const result = await query(
      `SELECT d.*, r.name AS road_name,
         ot.public_id AS open_ticket_id, ot.status AS open_ticket_status,
         ot.assignee_id, COALESCE(fs.name, rs.name) AS issue_name,
         COALESCE(fs.severity, rs.severity) AS severity,
         (SELECT COUNT(*)::int FROM tickets t
          WHERE t.device_id = d.id AND t.raised_at >= NOW() - INTERVAL '6 months'
          ${visFilter}) AS tickets_6m
       FROM devices d
       JOIN roads r ON r.id = d.road_id
       LEFT JOIN LATERAL (
         SELECT * FROM tickets t WHERE t.device_id = d.id AND t.status <> 'Closed'
         ${visFilter}
         ORDER BY t.raised_at DESC LIMIT 1
       ) ot ON TRUE
       LEFT JOIN issue_subcategories fs ON fs.id = ot.found_subcategory_id
       LEFT JOIN issue_subcategories rs ON rs.id = ot.reported_subcategory_id
       WHERE UPPER(d.public_id) = $1 OR UPPER(d.qr_code) = $1 OR UPPER(d.slot_number) = $1
       LIMIT 1`,
      params,
    )
    if (!result.rowCount) throw new ApiError(404, 'No device matches that code', 'NOT_FOUND')
    const row = result.rows[0]
    assertRoadAccess(req.user!, row.road_id)
    const status = deriveDeviceStatus({
      openTicketStatus: row.open_ticket_status,
      assigneeId: row.assignee_id,
      severity: row.severity,
    })
    return ok(res, {
      id: row.public_id,
      location: `${row.road_name} · Slot ${row.slot_number}`,
      status,
      statusTone: statusTone(status),
      facts: [
        { label: 'Installed', value: row.installed_on },
        {
          label: 'Open ticket',
          value: row.open_ticket_id
            ? `${row.open_ticket_id} — ${row.issue_name || 'Open'}`
            : 'None',
        },
        { label: 'Tickets in 6 months', value: String(row.tickets_6m) },
        { label: 'Road / slot', value: `${row.road_name} · ${row.slot_number}` },
      ],
      openTicketId: row.open_ticket_id || null,
      deviceUuid: row.id,
      roadId: row.road_id,
    })
  } catch (error) {
    return handleApiError(res, error)
  }
})

const createSchema = z.object({
  roadId: z.string().uuid(),
  slotNumber: z.string().min(1),
  sideOfRoad: z.string().optional(),
  landmark: z.string().optional(),
  latitude: z.string().optional(),
  longitude: z.string().optional(),
  model: z.string().optional(),
  installedOn: z.string().min(1),
  commissionedOn: z.string().optional(),
  installStatus: z.enum(['Working', 'Under installation', 'Not working']).default('Working'),
  photoUrl: z.string().optional(),
  remarks: z.string().optional(),
})

router.post('/', authorize('Add device', 'c'), async (req: AuthedRequest, res) => {
  try {
    const body = createSchema.parse(req.body)
    assertRoadAccess(req.user!, body.roadId)
    const publicId = await nextPublicId('PD', 4)
    const qr = qrFromDeviceId(publicId)
    const result = await query(
      `INSERT INTO devices (
        public_id, qr_code, road_id, slot_number, side_of_road, landmark,
        latitude, longitude, model, installed_on, commissioned_on, install_status, photo_url, remarks
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        publicId,
        qr,
        body.roadId,
        body.slotNumber,
        body.sideOfRoad || null,
        body.landmark || null,
        body.latitude || null,
        body.longitude || null,
        body.model || 'Flap barrier — 4 wheeler',
        body.installedOn,
        body.commissionedOn || null,
        body.installStatus,
        body.photoUrl || null,
        body.remarks || null,
      ],
    )
    return created(res, result.rows[0], 'Device created')
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/:deviceId/qr', authorize('Device history', 'v'), async (req, res) => {
  try {
    const result = await query(
      `SELECT public_id, qr_code FROM devices WHERE public_id = $1 OR id::text = $1`,
      [req.params.deviceId],
    )
    if (!result.rowCount) throw new ApiError(404, 'Device not found', 'NOT_FOUND')
    const png = await QRCode.toBuffer(result.rows[0].qr_code, { type: 'png', width: 400 })
    res.setHeader('Content-Type', 'image/png')
    return res.send(png)
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/:deviceId', authorize('Device history', 'v'), async (req: AuthedRequest, res) => {
  try {
    const device = await query(
      `SELECT d.*, r.name AS road_name FROM devices d
       JOIN roads r ON r.id = d.road_id
       WHERE d.public_id = $1 OR d.id::text = $1`,
      [req.params.deviceId],
    )
    if (!device.rowCount) throw new ApiError(404, 'Device not found', 'NOT_FOUND')
    const d = device.rows[0]
    assertRoadAccess(req.user!, d.road_id)

    const ticketParams: unknown[] = [d.id]
    const visibility = appendTicketVisibilitySql(req.user!, ticketParams)
    const visFilter = visibility ? `AND ${visibility}` : ''

    const open = await query(
      `SELECT t.*, COALESCE(fs.severity, rs.severity) AS severity
       FROM tickets t
       LEFT JOIN issue_subcategories fs ON fs.id = t.found_subcategory_id
       LEFT JOIN issue_subcategories rs ON rs.id = t.reported_subcategory_id
       WHERE t.device_id = $1 AND t.status <> 'Closed'
       ${visFilter}
       ORDER BY t.raised_at DESC LIMIT 1`,
      ticketParams,
    )
    const status = deriveDeviceStatus({
      openTicketStatus: open.rows[0]?.status || null,
      assigneeId: open.rows[0]?.assignee_id || null,
      severity: open.rows[0]?.severity || null,
    })

    const tickets = await query(
      `SELECT t.*, rc.name AS reported_cat, rs.name AS reported_sub,
              fc.name AS found_cat, fs.name AS found_sub
       FROM tickets t
       LEFT JOIN issue_categories rc ON rc.id = t.reported_category_id
       LEFT JOIN issue_subcategories rs ON rs.id = t.reported_subcategory_id
       LEFT JOIN issue_categories fc ON fc.id = t.found_category_id
       LEFT JOIN issue_subcategories fs ON fs.id = t.found_subcategory_id
       WHERE t.device_id = $1
       ${visFilter}
       ORDER BY t.raised_at DESC`,
      ticketParams,
    )

    const parts = await query(
      `SELECT e.created_at, e.parts, e.ticket_id, t.public_id,
              COALESCE(fs.name, rs.name) AS why
       FROM ticket_events e
       JOIN tickets t ON t.id = e.ticket_id
       LEFT JOIN issue_subcategories fs ON fs.id = t.found_subcategory_id
       LEFT JOIN issue_subcategories rs ON rs.id = t.reported_subcategory_id
       WHERE t.device_id = $1 AND jsonb_array_length(e.parts) > 0
       ${visFilter}
       ORDER BY e.created_at DESC`,
      ticketParams,
    )

    const partHistory: Array<{ date: string; part: string; why: string; ticketId: string }> = []
    const partCounts: Record<string, { times: number; last: string | null }> = {}
    for (const row of parts.rows) {
      const list = Array.isArray(row.parts) ? row.parts : []
      for (const part of list) {
        partHistory.push({
          date: row.created_at,
          part: String(part),
          why: row.why || '',
          ticketId: row.public_id,
        })
        const cur = partCounts[String(part)] || { times: 0, last: null }
        cur.times += 1
        cur.last = cur.last || row.created_at
        partCounts[String(part)] = cur
      }
    }

    const totalCost = tickets.rows.reduce((s, t) => s + Number(t.total_cost || 0), 0)
    const closedDays = tickets.rows
      .filter((t) => t.closed_at)
      .reduce((s, t) => {
        const days = Math.max(
          0,
          (new Date(t.closed_at).getTime() - new Date(t.raised_at).getTime()) / 86400000,
        )
        return s + days
      }, 0)
    const openDays = open.rows[0]
      ? Math.max(0, (Date.now() - new Date(open.rows[0].raised_at).getTime()) / 86400000)
      : 0
    const totalDown = closedDays + openDays
    const installed = d.installed_on ? new Date(d.installed_on) : new Date()
    const lifeDays = Math.max(1, (Date.now() - installed.getTime()) / 86400000)
    const availability = Math.max(0, 100 - (totalDown / lifeDays) * 100)

    const failRanks = await query(
      `SELECT COALESCE(fc.name, rc.name) AS name, COUNT(*)::int AS n
       FROM tickets t
       LEFT JOIN issue_categories fc ON fc.id = t.found_category_id
       LEFT JOIN issue_categories rc ON rc.id = t.reported_category_id
       WHERE t.device_id = $1
       ${visFilter}
       GROUP BY COALESCE(fc.name, rc.name)
       ORDER BY n DESC`,
      ticketParams,
    )
    const maxN = failRanks.rows[0]?.n || 1

    return ok(res, {
      header: {
        id: d.public_id,
        road: d.road_name,
        slot: d.slot_number,
        qr: d.qr_code,
        status,
        statusTone: statusTone(status),
        facts: [
          { label: 'Road', value: d.road_name },
          { label: 'Slot number', value: d.slot_number },
          { label: 'Side of road', value: d.side_of_road || '—' },
          { label: 'Installed', value: d.installed_on },
          { label: 'Model', value: d.model },
        ],
      },
      lifeTiles: [
        { value: String(tickets.rowCount), label: 'Tickets since install' },
        { value: `${totalDown.toFixed(1)} days`, label: 'Total days down', tone: 'bad' },
        { value: `${availability.toFixed(1)}%`, label: 'Availability' },
        {
          value: String(Object.values(partCounts).reduce((s, p) => s + p.times, 0)),
          label: 'Parts replaced',
        },
        { value: `₹ ${totalCost.toLocaleString('en-IN')}`, label: 'Spent on this device' },
      ],
      tickets: tickets.rows.map((t) => ({
        id: t.public_id,
        raisedDate: t.raised_at,
        reported: t.reported_sub,
        reportedCat: t.reported_cat,
        found: t.found_sub,
        foundCat: t.found_cat,
        cost: t.total_cost,
        status: t.status,
        daysOpen: Math.floor(
          ((t.closed_at ? new Date(t.closed_at).getTime() : Date.now()) -
            new Date(t.raised_at).getTime()) /
            86400000,
        ),
      })),
      partHistory,
      partSummary: Object.entries(partCounts).map(([part, v]) => ({
        part,
        times: v.times,
        timesBad: v.times >= 2,
        last: v.last,
      })),
      failRanks: failRanks.rows.map((r) => ({
        name: r.name,
        n: r.n,
        width: `${Math.round((r.n / maxN) * 100)}%`,
        hot: r.n === maxN,
      })),
    })
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.patch('/:deviceId', authorize('Device list', 'e'), async (req: AuthedRequest, res) => {
  try {
    const body = createSchema.partial().parse(req.body)
    const existing = await query(
      `SELECT * FROM devices WHERE public_id = $1 OR id::text = $1`,
      [req.params.deviceId],
    )
    if (!existing.rowCount) throw new ApiError(404, 'Device not found', 'NOT_FOUND')
    assertRoadAccess(req.user!, existing.rows[0].road_id)
    const id = existing.rows[0].id
    const result = await query(
      `UPDATE devices SET
         road_id = COALESCE($2, road_id),
         slot_number = COALESCE($3, slot_number),
         side_of_road = COALESCE($4, side_of_road),
         landmark = COALESCE($5, landmark),
         latitude = COALESCE($6, latitude),
         longitude = COALESCE($7, longitude),
         model = COALESCE($8, model),
         installed_on = COALESCE($9, installed_on),
         commissioned_on = COALESCE($10, commissioned_on),
         install_status = COALESCE($11, install_status),
         photo_url = COALESCE($12, photo_url),
         remarks = COALESCE($13, remarks),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        id,
        body.roadId ?? null,
        body.slotNumber ?? null,
        body.sideOfRoad ?? null,
        body.landmark ?? null,
        body.latitude ?? null,
        body.longitude ?? null,
        body.model ?? null,
        body.installedOn ?? null,
        body.commissionedOn ?? null,
        body.installStatus ?? null,
        body.photoUrl ?? null,
        body.remarks ?? null,
      ],
    )
    return ok(res, result.rows[0], 'Device updated')
  } catch (error) {
    return handleApiError(res, error)
  }
})

export default router
