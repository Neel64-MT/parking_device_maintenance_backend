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
 * Raiser and assignee always have access (even outside assigned roads).
 * Admin / Project manager keep city-wide access.
 */
export function assertTicketAccess(
  user: AuthUser,
  ticket: {
    road_id: string
    assignee_id: string | null
    raised_by_user_id: string | null
  },
) {
  if (isTicketPrivilegedRole(user)) return
  if (ticket.assignee_id === user.id || ticket.raised_by_user_id === user.id) return
  assertRoadAccess(user, ticket.road_id)
  throw new ApiError(403, 'Forbidden', 'FORBIDDEN')
}

/**
 * Roles that may hold a ticket ("Hand to" dropdown + assignee filter).
 * Field roles only: Project manager routes and closes work without attending it,
 * and Control room raises and routes rather than holding the ticket. This is
 * deliberately narrower than `canAssignTickets` below, which answers a different
 * question — who may *perform* an assign. Keep this the single source:
 * `GET /api/lookups/technicians` and `assertEligibleAssignee` both use it, so the
 * dropdown and the API cannot disagree.
 */
export const ASSIGNABLE_ROLES = ['Technician', 'Engineer']

/** Assign / reassign: Control room, Admin, or Project manager only. Technicians cannot. */
export function canAssignTickets(user: AuthUser) {
  return (
    user.roleName === 'Admin' ||
    user.roleName === 'Project manager' ||
    user.roleName === 'Control room'
  )
}

export function assertCanAssignTickets(user: AuthUser) {
  if (!canAssignTickets(user)) {
    throw new ApiError(
      403,
      'Only Control room, Admin, or Project manager can assign tickets',
      'FORBIDDEN',
    )
  }
}
