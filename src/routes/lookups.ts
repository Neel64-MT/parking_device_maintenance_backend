import { Router } from 'express'
import { handleApiError } from '../lib/api-error.js'
import { ok } from '../lib/respond.js'
import { query } from '../db/pool.js'
import { authorize, requireAuth } from '../middleware/auth.js'

const router = Router()

router.use(requireAuth)

/** Thin projection of `roads` for dropdowns — same table Device Sync writes. */
router.get('/roads', authorize('Device list', 'v'), async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, code, name, status FROM roads ORDER BY name`,
    )
    return ok(res, result.rows)
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/technicians', authorize('All tickets', 'v'), async (_req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.full_name AS name, r.name AS role,
              COALESCE(string_agg(rd.name, ', ' ORDER BY rd.name), 'All roads') AS roads
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN user_roads ur ON ur.user_id = u.id
       LEFT JOIN roads rd ON rd.id = ur.road_id
       WHERE u.status = 'Active'
         AND r.name IN ('Technician', 'Control room', 'Project manager')
       GROUP BY u.id, u.full_name, r.name
       ORDER BY u.full_name`,
    )
    return ok(
      res,
      result.rows.map((row) => ({
        id: row.id,
        label: `${row.name} — ${String(row.role).toLowerCase()}${row.roads && row.roads !== 'All roads' ? `, ${row.roads}` : ''}`,
        name: row.name,
        role: row.role,
        roads: row.roads,
      })),
    )
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/parts', authorize('Update ticket', 'v'), async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, name, amount::float8 AS amount FROM parts WHERE active = TRUE ORDER BY name`,
    )
    return ok(res, result.rows)
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/issue-categories', authorize('Raise ticket', 'v'), async (_req, res) => {
  try {
    const cats = await query(
      `SELECT id, name FROM issue_categories WHERE active = TRUE ORDER BY sort_order, name`,
    )
    const subs = await query(
      `SELECT id, category_id, name, severity FROM issue_subcategories WHERE active = TRUE ORDER BY name`,
    )
    return ok(
      res,
      cats.rows.map((c) => ({
        id: c.id,
        name: c.name,
        subs: subs.rows
          .filter((s) => s.category_id === c.id)
          .map((s) => ({ id: s.id, name: s.name, severity: s.severity })),
      })),
    )
  } catch (error) {
    return handleApiError(res, error)
  }
})

export default router
