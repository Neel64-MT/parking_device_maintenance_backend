import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handleApiError } from '../lib/api-error.js'
import { created, ok } from '../lib/respond.js'
import { query } from '../db/pool.js'
import { authorize, requireAuth, type AuthedRequest } from '../middleware/auth.js'
import {
  hashPassword,
  markPasswordChanged,
  normalizeEmail,
  normalizeMobile,
  omitPasswordHash,
  passwordSchema,
} from '../lib/auth.js'

const router = Router()
router.use(requireAuth)

router.get('/', authorize('Users', 'v'), async (req: AuthedRequest, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase()
    const statusFilter = String(req.query.status || '').trim()
    const params: unknown[] = []
    const clauses: string[] = []

    if (q) {
      params.push(`%${q}%`)
      clauses.push(
        `(LOWER(u.full_name) LIKE $${params.length} OR u.mobile LIKE $${params.length} OR LOWER(COALESCE(u.email, '')) LIKE $${params.length} OR LOWER(r.name) LIKE $${params.length})`,
      )
    }
    if (statusFilter === 'Active' || statusFilter === 'Inactive' || statusFilter === 'Pending') {
      params.push(statusFilter)
      clauses.push(`u.status = $${params.length}`)
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const result = await query(
      `SELECT u.id, u.full_name, u.email, u.mobile, u.status, u.last_active_at, u.role_id,
              r.name AS role,
              COALESCE(string_agg(DISTINCT rd.name, ', ' ORDER BY rd.name), 'All roads') AS roads,
              (
                SELECT COUNT(*)::int FROM tickets t
                WHERE t.assignee_id = u.id AND t.status NOT IN ('Closed')
              ) AS open_tickets
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN user_roads ur ON ur.user_id = u.id
       LEFT JOIN roads rd ON rd.id = ur.road_id
       ${where}
       GROUP BY u.id, u.full_name, u.email, u.mobile, u.status, u.last_active_at, u.role_id, r.name
       ORDER BY CASE u.status WHEN 'Pending' THEN 0 WHEN 'Active' THEN 1 ELSE 2 END, u.full_name`,
      params,
    )

    const tiles = await query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE u.status = 'Pending')::int AS pending,
        COUNT(*) FILTER (WHERE r.name = 'Technician')::int AS technicians,
        COUNT(*) FILTER (WHERE r.name = 'Site attendant')::int AS attendants,
        COUNT(*) FILTER (WHERE r.name = 'Control room')::int AS control_room
      FROM users u JOIN roles r ON r.id = u.role_id
    `)

    return ok(res, {
      tiles: [
        { value: String(tiles.rows[0].total), label: 'Total users' },
        { value: String(tiles.rows[0].pending), label: 'Pending approval' },
        { value: String(tiles.rows[0].technicians), label: 'Technicians' },
        { value: String(tiles.rows[0].attendants), label: 'Site attendants' },
        { value: String(tiles.rows[0].control_room), label: 'Control room' },
      ],
      users: result.rows.map((row) => ({
        id: row.id,
        name: row.full_name,
        you: row.id === req.user!.id,
        email: row.email,
        mobile: row.mobile,
        role: row.role,
        roleId: row.role_id,
        roads: row.roads,
        openTickets: row.open_tickets || null,
        openBad: Number(row.open_tickets) >= 5,
        lastActive: row.last_active_at,
        status: row.status,
        statusTone:
          row.status === 'Active' ? 'ok' : row.status === 'Pending' ? 'warn' : 'grey',
      })),
    })
  } catch (error) {
    return handleApiError(res, error)
  }
})

const userBody = z.object({
  fullName: z.string().min(2),
  mobile: z.string().min(10),
  email: z.union([z.string().email(), z.literal('')]).optional(),
  password: passwordSchema,
  roleId: z.string().uuid(),
  roadIds: z.array(z.string().uuid()).default([]),
  status: z.enum(['Active', 'Inactive', 'Pending']).optional(),
})

function emailOrNull(email?: string) {
  if (!email) return null
  return normalizeEmail(email)
}

router.post('/', authorize('Users', 'c'), async (req, res) => {
  try {
    const body = userBody.parse(req.body)
    const mobile = normalizeMobile(body.mobile)
    const email = emailOrNull(body.email)
    const passwordHash = await hashPassword(body.password)
    const result = await query(
      `INSERT INTO users (full_name, mobile, email, password_hash, role_id, status)
       VALUES ($1,$2,$3,$4,$5,'Active') RETURNING *`,
      [body.fullName, mobile, email, passwordHash, body.roleId],
    )
    const user = result.rows[0]
    for (const roadId of body.roadIds) {
      await query(`INSERT INTO user_roads (user_id, road_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [
        user.id,
        roadId,
      ])
    }
    return created(res, omitPasswordHash(user), 'User created')
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.patch('/:id', authorize('Users', 'e'), async (req, res) => {
  try {
    const body = userBody.partial().parse(req.body)
    const existing = await query('SELECT * FROM users WHERE id = $1', [req.params.id])
    if (!existing.rowCount) throw new ApiError(404, 'User not found', 'NOT_FOUND')

    if (body.status === 'Inactive') {
      const adminCheck = await query(
        `SELECT COUNT(*)::int AS n FROM users u
         JOIN roles r ON r.id = u.role_id
         WHERE r.name = 'Admin' AND u.status = 'Active' AND u.id <> $1`,
        [req.params.id],
      )
      const isAdmin = await query(
        `SELECT r.name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
        [req.params.id],
      )
      if (isAdmin.rows[0]?.name === 'Admin' && adminCheck.rows[0].n < 1) {
        throw new ApiError(409, 'At least one admin must remain active', 'LAST_ADMIN')
      }
    }

    const passwordHash = body.password ? await hashPassword(body.password) : null
    const result = await query(
      `UPDATE users SET
         full_name = COALESCE($2, full_name),
         mobile = COALESCE($3, mobile),
         email = CASE WHEN $8::boolean THEN $4 ELSE email END,
         password_hash = COALESCE($5, password_hash),
         role_id = COALESCE($6, role_id),
         status = COALESCE($7, status),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [
        req.params.id,
        body.fullName ?? null,
        body.mobile ? normalizeMobile(body.mobile) : null,
        body.email !== undefined ? emailOrNull(body.email) : null,
        passwordHash,
        body.roleId ?? null,
        body.status ?? null,
        body.email !== undefined,
      ],
    )

    if (body.password) {
      await markPasswordChanged(req.params.id)
    }

    if (body.roadIds) {
      await query('DELETE FROM user_roads WHERE user_id = $1', [req.params.id])
      for (const roadId of body.roadIds) {
        await query(`INSERT INTO user_roads (user_id, road_id) VALUES ($1,$2)`, [
          req.params.id,
          roadId,
        ])
      }
    }

    return ok(res, omitPasswordHash(result.rows[0]), 'User updated')
  } catch (error) {
    return handleApiError(res, error)
  }
})

export default router
