import { ApiError } from './api-error.js'
import { query } from '../db/pool.js'
import { FIELD_ROLES } from './permissions.js'

/** Active field staff (FIELD_ROLES) may be recorded as Visited By on an update. */
export async function assertValidVisitedBy(userId: string) {
  const result = await query(
    `SELECT u.id
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1
       AND u.status = 'Active'
       AND r.name = ANY($2::text[])`,
    [userId, [...FIELD_ROLES]],
  )
  if (!result.rowCount) {
    throw new ApiError(400, 'Visited By is invalid', 'VALIDATION_ERROR', [
      { field: 'visitedBy', message: 'Visited By is invalid' },
    ])
  }
}
