import type { AuthUser } from '../middleware/auth.js'
import { isFieldRoleName } from './permissions.js'

/**
 * Tickets have no holder: every ticket on every road is visible to anyone with All tickets `v`,
 * and any open ticket can be updated by anyone with Update ticket `e` (closed with `x`).
 * Route-level `authorize(screen, flag)` is the whole ticket access check.
 */

/** Admin and Project manager: may attach photos to any ticket entry, not only their own. */
export function isTicketPrivilegedRole(user: AuthUser) {
  return user.roleName === 'Admin' || user.roleName === 'Project manager'
}

/** Field staff (Technician / Engineer / Electrician). */
export function isFieldRole(user: AuthUser) {
  return isFieldRoleName(user.roleName)
}
