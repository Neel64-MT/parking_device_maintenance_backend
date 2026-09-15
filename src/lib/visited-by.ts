import { ApiError } from './api-error.js'
import { query } from '../db/pool.js'

/** Active Technician or Engineer may be recorded as Visited By on an update. */
export async function assertValidVisitedBy(userId: string) {
  const result = await query(
    `SELECT u.id
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1
       AND u.status = 'Active'
       AND r.name IN ('Technician', 'Engineer')`,
    [userId],
  )
  if (!result.rowCount) {
    throw new ApiError(400, 'Visited By is invalid', 'VALIDATION_ERROR', [
      { field: 'visitedBy', message: 'Visited By is invalid' },
    ])
  }
}
