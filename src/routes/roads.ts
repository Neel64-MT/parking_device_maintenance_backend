import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handleApiError } from '../lib/api-error.js'
import { created, ok } from '../lib/respond.js'
import { query } from '../db/pool.js'
import { authorize, requireAuth } from '../middleware/auth.js'
import { nextPublicId } from '../lib/ids.js'

const router = Router()
router.use(requireAuth)

const listSchema = z.object({
  q: z.string().optional(),
  zone: z.string().optional(),
  status: z.string().optional(),
})

const createSchema = z.object({
  name: z.string().min(2),
  stretchFrom: z.string().min(1),
  stretchTo: z.string().min(1),
  zone: z.string().optional(),
  ward: z.string().optional(),
  lengthText: z.string().optional(),
  side: z.string().optional(),
  surveyedSlots: z.coerce.number().int().nonnegative().optional(),
  devicesSanctioned: z.coerce.number().int().nonnegative().optional(),
  vehicleType: z.string().optional(),
  parkingRate: z.string().optional(),
  slotPrefix: z.string().optional(),
  operatingHours: z.string().optional(),
  status: z.enum(['Operational', 'On hold', 'Under installation', 'Closed']).default('Operational'),
  goLiveDate: z.string().optional(),
  supervisorName: z.string().optional(),
  supervisorMobile: z.string().optional(),
  remarks: z.string().optional(),
})

async function roadRows(filters: z.infer<typeof listSchema>) {
  const params: unknown[] = []
  const where: string[] = []
  if (filters.q?.trim()) {
    params.push(`%${filters.q.trim().toLowerCase()}%`)
    where.push(`(LOWER(r.code) LIKE $${params.length} OR LOWER(r.name) LIKE $${params.length} OR LOWER(COALESCE(r.stretch_from,'')) LIKE $${params.length} OR LOWER(COALESCE(r.zone,'')) LIKE $${params.length})`)
  }
  if (filters.zone && filters.zone !== 'All zones') {
    params.push(filters.zone)
    where.push(`r.zone = $${params.length}`)
  }
  if (filters.status && filters.status !== 'All') {
    params.push(filters.status)
    where.push(`r.status = $${params.length}`)
  }
  const sql = `
    SELECT r.*,
      (SELECT COUNT(*)::int FROM devices d WHERE d.road_id = r.id) AS devices,
      (SELECT COUNT(*)::int FROM tickets t
         JOIN devices d ON d.id = t.device_id
         WHERE d.road_id = r.id AND t.status NOT IN ('Closed')) AS down
    FROM roads r
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY r.code`
  return query(sql, params)
}

router.get('/', authorize('Road master', 'v'), async (req, res) => {
  try {
    const filters = listSchema.parse(req.query)
    const result = await roadRows(filters)
    return ok(
      res,
      result.rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        rate: r.parking_rate ? `Rate ₹${r.parking_rate} · 4-wheeler` : null,
        stretch: `${r.stretch_from} to ${r.stretch_to}`,
        length: r.length_text,
        zone: r.zone,
        ward: r.ward,
        slots: r.surveyed_slots,
        devices: r.devices,
        down: r.down,
        status: r.status,
        statusTone: r.status === 'Operational' ? 'ok' : r.status === 'On hold' ? 'warn' : 'grey',
      })),
    )
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/export', authorize('Road master', 'v'), async (req, res) => {
  try {
    const filters = listSchema.parse(req.query)
    const result = await roadRows(filters)
    const header = 'Code,Name,Stretch,Zone,Ward,Slots,Devices,Down,Status\n'
    const lines = result.rows.map(
      (r) =>
        `${r.code},"${r.name}","${r.stretch_from} to ${r.stretch_to}",${r.zone || ''},${r.ward || ''},${r.surveyed_slots},${r.devices},${r.down},${r.status}`,
    )
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="roads.csv"')
    return res.send(header + lines.join('\n'))
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/next-code', authorize('Road master', 'c'), async (_req, res) => {
  try {
    const max = await query<{ max: string | null }>(
      `SELECT MAX(code) AS max FROM roads`,
    )
    const current = max.rows[0].max
    let next = 'RD-01'
    if (current) {
      const n = Number(String(current).split('-')[1] || 0) + 1
      next = `RD-${String(n).padStart(2, '0')}`
    }
    return ok(res, { code: next })
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/:id/slots', authorize('Raise ticket', 'v'), async (req, res) => {
  try {
    const result = await query(
      `SELECT slot_number AS slot, public_id AS "deviceId"
       FROM devices WHERE road_id = $1 ORDER BY slot_number`,
      [req.params.id],
    )
    return ok(res, result.rows)
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/:id', authorize('Road master', 'v'), async (req, res) => {
  try {
    const result = await query('SELECT * FROM roads WHERE id = $1 OR code = $1', [req.params.id])
    if (!result.rowCount) throw new ApiError(404, 'Road not found', 'NOT_FOUND')
    return ok(res, result.rows[0])
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.post('/', authorize('Road master', 'c'), async (req, res) => {
  try {
    const body = createSchema.parse(req.body)
    const code = await nextPublicId('RD', 2)
    const result = await query(
      `INSERT INTO roads (
        code, name, stretch_from, stretch_to, zone, ward, length_text, side,
        surveyed_slots, devices_sanctioned, vehicle_type, parking_rate, slot_prefix,
        operating_hours, status, go_live_date, supervisor_name, supervisor_mobile, remarks
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING *`,
      [
        code,
        body.name,
        body.stretchFrom,
        body.stretchTo,
        body.zone || null,
        body.ward || null,
        body.lengthText || null,
        body.side || null,
        body.surveyedSlots ?? 0,
        body.devicesSanctioned ?? 0,
        body.vehicleType || null,
        body.parkingRate || null,
        body.slotPrefix || null,
        body.operatingHours || null,
        body.status,
        body.goLiveDate || null,
        body.supervisorName || null,
        body.supervisorMobile || null,
        body.remarks || null,
      ],
    )
    return created(res, result.rows[0], 'Road created')
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.patch('/:id', authorize('Road master', 'e'), async (req, res) => {
  try {
    const body = createSchema.partial().parse(req.body)
    const existing = await query('SELECT id FROM roads WHERE id = $1 OR code = $1', [req.params.id])
    if (!existing.rowCount) throw new ApiError(404, 'Road not found', 'NOT_FOUND')
    const id = existing.rows[0].id
    const result = await query(
      `UPDATE roads SET
        name = COALESCE($2, name),
        stretch_from = COALESCE($3, stretch_from),
        stretch_to = COALESCE($4, stretch_to),
        zone = COALESCE($5, zone),
        ward = COALESCE($6, ward),
        length_text = COALESCE($7, length_text),
        side = COALESCE($8, side),
        surveyed_slots = COALESCE($9, surveyed_slots),
        devices_sanctioned = COALESCE($10, devices_sanctioned),
        vehicle_type = COALESCE($11, vehicle_type),
        parking_rate = COALESCE($12, parking_rate),
        slot_prefix = COALESCE($13, slot_prefix),
        operating_hours = COALESCE($14, operating_hours),
        status = COALESCE($15, status),
        go_live_date = COALESCE($16, go_live_date),
        supervisor_name = COALESCE($17, supervisor_name),
        supervisor_mobile = COALESCE($18, supervisor_mobile),
        remarks = COALESCE($19, remarks),
        updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        id,
        body.name ?? null,
        body.stretchFrom ?? null,
        body.stretchTo ?? null,
        body.zone ?? null,
        body.ward ?? null,
        body.lengthText ?? null,
        body.side ?? null,
        body.surveyedSlots ?? null,
        body.devicesSanctioned ?? null,
        body.vehicleType ?? null,
        body.parkingRate ?? null,
        body.slotPrefix ?? null,
        body.operatingHours ?? null,
        body.status ?? null,
        body.goLiveDate ?? null,
        body.supervisorName ?? null,
        body.supervisorMobile ?? null,
        body.remarks ?? null,
      ],
    )
    return ok(res, result.rows[0], 'Road updated')
  } catch (error) {
    return handleApiError(res, error)
  }
})

export default router
