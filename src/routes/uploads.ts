import { Router, type NextFunction, type Response } from 'express'
import { handleApiError } from '../lib/api-error.js'
import { created } from '../lib/respond.js'
import { ApiError } from '../lib/api-error.js'
import {
  hasPermission,
  requireAuth,
  type AuthedRequest,
} from '../middleware/auth.js'
import { upload } from '../middleware/upload.js'

const router = Router()
router.use(requireAuth)

/**
 * Ticket photo uploads only — Raise create, Add Update edit, or Close.
 * Matches FE callers: TicketRaise, TicketAddUpdateForm, TicketClose.
 */
function authorizeTicketUpload(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const user = req.user
    if (!user) throw new ApiError(401, 'Unauthorized', 'UNAUTHORIZED')
    if (
      hasPermission(user, 'Raise ticket', 'c') ||
      hasPermission(user, 'Update ticket', 'e') ||
      hasPermission(user, 'Update ticket', 'x')
    ) {
      return next()
    }
    throw new ApiError(403, 'Forbidden', 'FORBIDDEN')
  } catch (error) {
    return handleApiError(res, error)
  }
}

router.post('/', authorizeTicketUpload, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) throw new ApiError(400, 'file is required', 'VALIDATION_ERROR')
    return created(res, {
      id: req.file.filename,
      url: `/uploads/${req.file.filename}`,
      originalName: req.file.originalname,
      size: req.file.size,
    }, 'Uploaded')
  } catch (error) {
    return handleApiError(res, error)
  }
})

export default router
