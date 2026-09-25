import { ApiError } from './api-error.js'

/**
 * Privilege order highest → lowest (Phase 36).
 * Same rank may create/assign; lower index = higher privilege.
 * Names must match `roles.name` exactly.
 */
export const ROLE_HIERARCHY = [
  'Admin',
  'Project manager',
  'Control room',
  'Engineer',
  'Technician',
  'Site attendant',
  'AMC officer',
] as const

export type HierarchyRoleName = (typeof ROLE_HIERARCHY)[number]

/** 0 = highest privilege. Returns -1 if name is not in the hierarchy. */
export function roleRank(roleName: string): number {
  return (ROLE_HIERARCHY as readonly string[]).indexOf(roleName)
}

/**
 * Actor may assign target when target is same rank or below (higher index).
 * Unknown roles (custom names not in hierarchy) are rejected.
 */
export function assertCanAssignRole(actorRoleName: string, targetRoleName: string): void {
  const actorRank = roleRank(actorRoleName)
  const targetRank = roleRank(targetRoleName)

  if (actorRank < 0 || targetRank < 0) {
    throw new ApiError(
      403,
      'You cannot create a user with a role higher than your own.',
      'FORBIDDEN',
    )
  }

  // targetRank < actorRank means target is higher privilege
  if (targetRank < actorRank) {
    throw new ApiError(
      403,
      'You cannot create a user with a role higher than your own.',
      'FORBIDDEN',
    )
  }
}

/**
 * Actor may edit a role's permission matrix when the target is same rank or below.
 * Custom (unknown) role names: Admin only — they are not assignable via hierarchy,
 * but Admin still needs to manage their matrix after create.
 */
export function assertCanManageRolePermissions(
  actorRoleName: string,
  targetRoleName: string,
): void {
  const actorRank = roleRank(actorRoleName)
  const targetRank = roleRank(targetRoleName)

  if (actorRank < 0) {
    throw new ApiError(
      403,
      'You cannot change permissions for a role higher than your own.',
      'FORBIDDEN',
    )
  }

  if (targetRank < 0) {
    if (actorRank !== 0) {
      throw new ApiError(
        403,
        'You cannot change permissions for a role higher than your own.',
        'FORBIDDEN',
      )
    }
    return
  }

  if (targetRank < actorRank) {
    throw new ApiError(
      403,
      'You cannot change permissions for a role higher than your own.',
      'FORBIDDEN',
    )
  }
}
