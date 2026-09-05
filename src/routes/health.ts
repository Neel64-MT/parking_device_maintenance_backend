import { Router } from 'express'
import { ok } from '../lib/respond.js'

const router = Router()

router.get('/', (_req, res) => {
  return ok(res, { ok: true, service: 'parking-device-maintenance-api' })
})

export default router
