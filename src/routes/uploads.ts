import { Router } from 'express'
import { handleApiError } from '../lib/api-error.js'
import { created } from '../lib/respond.js'
import { ApiError } from '../lib/api-error.js'
import { requireAuth } from '../middleware/auth.js'
import { upload } from '../middleware/upload.js'

const router = Router()
router.use(requireAuth)

router.post('/', upload.single('file'), async (req, res) => {
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
