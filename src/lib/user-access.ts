import { ApiError } from './api-error.js'
import { query } from '../db/pool.js'
import type { AuthUser } from '../middleware/auth.js'

/** Admin is identified by `roles.name`, same as the rest of the backend. */
export function isAdminRoleName(roleName: string) {
  return roleName === 'Admin'
}

/**
 * Append SQL so the Users list never exposes:
 *  - the authenticated user's own account (by user id, for every role)
 *  - Admin-role accounts to any non-Admin viewer
 *
 * Mutates `params` and returns a WHERE clause fragment. Callers AND it into
 * their own filters so search / status / pagination cannot bypass it.
 *
 * Callers must join roles with LEFT JOIN: an account whose role was deleted has
 * `role_id IS NULL`, and the Admin exclusion is written with COALESCE so such an
 * account is still listed (it is not an Admin) instead of silently disappearing.
 */
export function appendUserVisibilitySql(user: AuthUser, params: unknown[]): string {
  params.push(user.id)
  const clauses = [`u.id <> $${params.length}`]
  if (!isAdminRoleName(user.roleName)) {
    params.push('Admin')
    clauses.push(`COALESCE(r.name, '') <> $${params.length}`)
  }
  return `(${clauses.join(' AND ')})`
}

/** At least one Active Admin must always remain. Shared by PATCH status and DELETE. */
export async function assertNotLastActiveAdmin(targetUserId: string) {
  const target = await query<{ role_name: string }>(
    `SELECT r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
    [targetUserId],
  )
  if (!target.rowCount || target.rows[0].role_name !== 'Admin') return

  const otherAdmins = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.name = 'Admin' AND u.status = 'Active' AND u.id <> $1`,
    [targetUserId],
  )
  if (otherAdmins.rows[0].n < 1) {
    throw new ApiError(409, 'At least one admin must remain active', 'LAST_ADMIN')
  }
}
