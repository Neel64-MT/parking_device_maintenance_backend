import { ApiError } from './api-error.js'
import type { AuthUser } from '../middleware/auth.js'
import { assertRoadAccess } from '../middleware/auth.js'

/** Admin and Project manager keep city-wide ticket visibility. */
export function isTicketPrivilegedRole(user: AuthUser) {
  return user.roleName === 'Admin' || user.roleName === 'Project manager'
}

/**
 * Append SQL so non-privileged users only see tickets they raised or are assigned to.
 * Mutates `params` and returns a WHERE clause fragment, or null if no filter needed.
 */
export function appendTicketVisibilitySql(user: AuthUser, params: unknown[]): string | null {
  if (isTicketPrivilegedRole(user)) return null
  params.push(user.id)
  return `(t.assignee_id = $${params.length} OR t.raised_by_user_id = $${params.length})`
}

/**
 * Enforce ticket visibility on detail/mutation paths.
 * Also applies existing road scope for assigned_roads roles.
 */
export function assertTicketAccess(
  user: AuthUser,
  ticket: {
    road_id: string
    assignee_id: string | null
    raised_by_user_id: string | null
  },
) {
  assertRoadAccess(user, ticket.road_id)
  if (isTicketPrivilegedRole(user)) return
  if (ticket.assignee_id === user.id || ticket.raised_by_user_id === user.id) return
  throw new ApiError(403, 'Forbidden', 'FORBIDDEN')
}
