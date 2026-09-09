import { Router } from 'express'
import { z } from 'zod'
import { query } from '../db/pool.js'
import { ApiError, handleApiError } from '../lib/api-error.js'
import { getDeviceSyncApiToken } from '../lib/device-sync-client.js'
import { scheduleDeviceSync } from '../lib/device-sync.js'
import { ok } from '../lib/respond.js'
import { authorize, requireAuth, type AuthedRequest } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

function mapRun(row: {
  id: string
  status: string
  started_at: Date | string
  finished_at: Date | string | null
  error_message: string | null
  stats: unknown
  triggered_by_user_id: string | null
}) {
  return {
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorMessage: row.error_message,
    stats: row.stats ?? {},
    triggeredByUserId: row.triggered_by_user_id,
  }
}

router.post('/', authorize('Device list', 'c'), async (req: AuthedRequest, res) => {
  try {
    if (!getDeviceSyncApiToken()) {
      throw new ApiError(
        503,
        'Device sync is not configured',
        'DEVICE_SYNC_NOT_CONFIGURED',
      )
    }

    const inProgress = await query(
      `SELECT id FROM device_sync_runs WHERE status = 'started' LIMIT 1`,
    )
    if (inProgress.rowCount) {
      throw new ApiError(
        409,
        'A device sync is already in progress',
        'SYNC_IN_PROGRESS',
        { runId: inProgress.rows[0].id },
      )
    }

    const inserted = await query<{
      id: string
      status: string
      started_at: Date
      finished_at: Date | null
      error_message: string | null
      stats: unknown
      triggered_by_user_id: string | null
    }>(
      `INSERT INTO device_sync_runs (status, triggered_by_user_id)
       VALUES ('started', $1)
       RETURNING *`,
      [req.user!.id],
    )
    const run = inserted.rows[0]
    scheduleDeviceSync(run.id)
    return ok(res, mapRun(run), 'Device sync started', 202)
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/latest', authorize('Device list', 'v'), async (_req, res) => {
  try {
    const result = await query(
      `SELECT * FROM device_sync_runs ORDER BY started_at DESC LIMIT 1`,
    )
    if (!result.rowCount) {
      throw new ApiError(404, 'No device sync runs found', 'NOT_FOUND')
    }
    return ok(res, mapRun(result.rows[0]))
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/:id', authorize('Device list', 'v'), async (req, res) => {
  try {
    const id = z.string().uuid().parse(req.params.id)
    const result = await query(`SELECT * FROM device_sync_runs WHERE id = $1`, [id])
    if (!result.rowCount) {
      throw new ApiError(404, 'Device sync run not found', 'NOT_FOUND')
    }
    return ok(res, mapRun(result.rows[0]))
  } catch (error) {
    return handleApiError(res, error)
  }
})

export default router
