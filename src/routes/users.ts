import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handleApiError } from '../lib/api-error.js'
import { created, ok } from '../lib/respond.js'
import { query, withTransaction } from '../db/pool.js'
import { authorize, requireAuth, type AuthedRequest } from '../middleware/auth.js'
import {
  hashPassword,
  markPasswordChanged,
  normalizeEmail,
  normalizeMobile,
  omitPasswordHash,
  passwordSchema,
} from '../lib/auth.js'
import { resolveUserSignupNotifications } from '../lib/notifications.js'
import { appendUserVisibilitySql, assertNotLastActiveAdmin } from '../lib/user-access.js'

const router = Router()
router.use(requireAuth)

router.get('/', authorize('Users', 'v'), async (req: AuthedRequest, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase()
    const statusFilter = String(req.query.status || '').trim()
    const roleFilter = String(req.query.role || '').trim()
    const params: unknown[] = []
    // Own account is never listed, and a non-Admin viewer never sees Admin accounts.
    const clauses: string[] = [appendUserVisibilitySql(req.user!, params)]

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
    if (roleFilter) {
      params.push(roleFilter)
      clauses.push(`r.name = $${params.length}`)
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    // LEFT JOIN: an account whose role was deleted keeps `role_id IS NULL` (migration 021)
    // and must stay listed so an Admin can give it a new role before reactivating it.
    const result = await query(
      `SELECT u.id, u.full_name, u.email, u.mobile, u.status, u.last_active_at, u.role_id,
              r.name AS role,
              COALESCE(string_agg(DISTINCT rd.name, ', ' ORDER BY rd.name), 'All roads') AS roads,
              (
                SELECT COUNT(*)::int FROM tickets t
                WHERE t.assignee_id = u.id AND t.status NOT IN ('Closed')
              ) AS open_tickets
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       LEFT JOIN user_roads ur ON ur.user_id = u.id
       LEFT JOIN roads rd ON rd.id = ur.road_id
       ${where}
       GROUP BY u.id, u.full_name, u.email, u.mobile, u.status, u.last_active_at, u.role_id, r.name
       ORDER BY CASE u.status WHEN 'Pending' THEN 0 WHEN 'Active' THEN 1 ELSE 2 END, u.full_name`,
      params,
    )

    // Same visibility clause as the list so tile counts match what is visible.
    // Tiles stay unfiltered by `q` / `status`, so they get their own params.
    const tileParams: unknown[] = []
    const tiles = await query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE u.status = 'Pending')::int AS pending,
         COUNT(*) FILTER (WHERE r.name = 'Technician')::int AS technicians,
         COUNT(*) FILTER (WHERE r.name = 'Site attendant')::int AS attendants,
         COUNT(*) FILTER (WHERE r.name = 'Control room')::int AS control_room
       FROM users u LEFT JOIN roles r ON r.id = u.role_id
       WHERE ${appendUserVisibilitySql(req.user!, tileParams)}`,
      tileParams,
    )

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
        role: row.role ?? null,
        // True when the account's role was deleted; it must get a new role before it can be
        // activated again. Drives the "No role" marker in the Users table.
        roleMissing: !row.role_id,
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

    if (body.roleId) {
      const role = await query('SELECT id FROM roles WHERE id = $1', [body.roleId])
      if (!role.rowCount) throw new ApiError(400, 'Role not found', 'ROLE_NOT_FOUND')
    }

    // An account can lose its role when that role is deleted (migration 021 sets role_id to
    // NULL). It may stay Inactive, but it must not be reactivated without a role: an Active
    // user with no role cannot be authorised, because requireAuth resolves permissions
    // through the roles join. So "change the role" is a precondition of "make Active".
    const effectiveRoleId = body.roleId ?? existing.rows[0].role_id
    if (body.status === 'Active' && !effectiveRoleId) {
      throw new ApiError(
        409,
        'Select a role for this user before activating the account.',
        'ROLE_REQUIRED',
      )
    }

    if (body.status === 'Inactive') {
      await assertNotLastActiveAdmin(String(req.params.id))
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
      await markPasswordChanged(String(req.params.id))
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

    if (existing.rows[0].status === 'Pending' && body.status && body.status !== 'Pending') {
      try {
        await resolveUserSignupNotifications(String(req.params.id))
      } catch (notificationError) {
        console.error('[notifications] failed to resolve signup alerts:', notificationError)
      }
    }

    return ok(res, omitPasswordHash(result.rows[0]), 'User updated')
  } catch (error) {
    return handleApiError(res, error)
  }
})

/**
 * Hard-delete a user account. Requires Users `d` (Admin).
 *
 * The row is removed, not deactivated. `user_roads`, `password_reset_tokens`,
 * `notifications` and `push_subscriptions` cascade. The remaining references have no
 * ON DELETE clause, so they are cleared first: the tickets, events, assignments and sync
 * runs stay intact and only the person reference is emptied, which is why a deleted
 * user's name no longer appears on past tickets.
 *
 * A user can never delete their own account, and the last Active Admin is protected by
 * the same `assertNotLastActiveAdmin` used by the deactivate path.
 */
router.delete('/:id', authorize('Users', 'd'), async (req: AuthedRequest, res) => {
  try {
    const targetId = String(req.params.id)

    if (targetId === req.user!.id) {
      throw new ApiError(400, 'You cannot delete your own account.', 'SELF_DELETE_FORBIDDEN')
    }

    const existing = await query(`SELECT id, role_id FROM users WHERE id = $1`, [targetId])
    if (!existing.rowCount) throw new ApiError(404, 'User not found', 'NOT_FOUND')

    await assertNotLastActiveAdmin(targetId)

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE tickets SET raised_by_user_id = NULL WHERE raised_by_user_id = $1`,
        [targetId],
      )
      await client.query(`UPDATE tickets SET assignee_id = NULL WHERE assignee_id = $1`, [
        targetId,
      ])
      await client.query(`UPDATE ticket_events SET actor_user_id = NULL WHERE actor_user_id = $1`, [
        targetId,
      ])
      await client.query(
        `UPDATE ticket_assignments SET from_user_id = NULL WHERE from_user_id = $1`,
        [targetId],
      )
      await client.query(
        `UPDATE ticket_assignments SET to_user_id = NULL WHERE to_user_id = $1`,
        [targetId],
      )
      await client.query(
        `UPDATE device_sync_runs SET triggered_by_user_id = NULL WHERE triggered_by_user_id = $1`,
        [targetId],
      )
      await client.query(
        `DELETE FROM notifications WHERE related_entity_type = 'user' AND related_entity_id = $1`,
        [targetId],
      )
      await client.query(`DELETE FROM users WHERE id = $1`, [targetId])
    })

    return ok(res, { id: targetId }, 'User deleted')
  } catch (error) {
    return handleApiError(res, error)
  }
})

export default router
