import { Router } from 'express'
import { handleApiError } from '../lib/api-error.js'
import { ok } from '../lib/respond.js'
import { query } from '../db/pool.js'
import { authorize, requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

router.get('/', authorize('Update ticket', 'v'), async (_req, res) => {
  try {
    const result = await query(`SELECT id, name FROM parts WHERE active = TRUE ORDER BY name`)
    return ok(res, result.rows)
  } catch (error) {
    return handleApiError(res, error)
  }
})

export default router
