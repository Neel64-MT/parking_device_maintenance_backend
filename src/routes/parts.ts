import { Router, type NextFunction, type Response } from 'express'
import { z } from 'zod'
import { ApiError, handleApiError } from '../lib/api-error.js'
import { created, ok } from '../lib/respond.js'
import { query } from '../db/pool.js'
import {
  authorize,
  hasPermission,
  requireAuth,
  type AuthedRequest,
} from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

/** Issue master create, or Technician (field staff adding missing spares). */
function authorizePartCreate(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const user = req.user
    if (!user) throw new ApiError(401, 'Unauthorized', 'UNAUTHORIZED')
    if (hasPermission(user, 'Issue master', 'c') || user.roleName === 'Technician') {
      return next()
    }
    throw new ApiError(403, 'Forbidden', 'FORBIDDEN')
  } catch (error) {
    return handleApiError(res, error)
  }
}

/** Issue master edit, or Technician (field staff correcting name/amount). */
function authorizePartUpdate(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const user = req.user
    if (!user) throw new ApiError(401, 'Unauthorized', 'UNAUTHORIZED')
    if (hasPermission(user, 'Issue master', 'e') || user.roleName === 'Technician') {
      return next()
    }
    throw new ApiError(403, 'Forbidden', 'FORBIDDEN')
  } catch (error) {
    return handleApiError(res, error)
  }
}

router.get('/', authorize('Update ticket', 'v'), async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, name, amount::float8 AS amount FROM parts WHERE active = TRUE ORDER BY name`,
    )
    return ok(res, result.rows)
  } catch (error) {
    return handleApiError(res, error)
  }
})

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  amount: z.coerce.number().nonnegative(),
})

router.post('/', authorizePartCreate, async (req, res) => {
  try {
    const body = createSchema.parse(req.body)
    const result = await query(
      `INSERT INTO parts (name, amount) VALUES ($1, $2)
       RETURNING id, name, amount::float8 AS amount, active`,
      [body.name, body.amount],
    )
    return created(res, result.rows[0], 'Part created')
  } catch (error) {
    return handleApiError(res, error)
  }
})

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    amount: z.coerce.number().nonnegative().optional(),
    active: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'No fields to update' })

router.patch('/:id', authorizePartUpdate, async (req, res) => {
  try {
    const body = patchSchema.parse(req.body)
    const result = await query(
      `UPDATE parts SET
         name = COALESCE($2, name),
         amount = COALESCE($3, amount),
         active = COALESCE($4, active),
         updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, amount::float8 AS amount, active`,
      [req.params.id, body.name ?? null, body.amount ?? null, body.active ?? null],
    )
    if (!result.rowCount) throw new ApiError(404, 'Part not found', 'NOT_FOUND')
    return ok(res, result.rows[0], 'Part updated')
  } catch (error) {
    return handleApiError(res, error)
  }
})

export default router
