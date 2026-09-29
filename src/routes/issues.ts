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

const categoryNameSchema = z.string().trim().min(2).max(120)
const subcategoryNameSchema = z.string().trim().min(2).max(120)

/** Issue master edit, or Technician / Engineer (field staff correcting wording/severity). */
function authorizeIssueSubUpdate(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const user = req.user
    if (!user) throw new ApiError(401, 'Unauthorized', 'UNAUTHORIZED')
    if (
      hasPermission(user, 'Issue master', 'e') ||
      user.roleName === 'Technician' ||
      user.roleName === 'Engineer'
    ) {
      return next()
    }
    throw new ApiError(403, 'Forbidden', 'FORBIDDEN')
  } catch (error) {
    return handleApiError(res, error)
  }
}

router.get('/', authorize('Issue master', 'v'), async (_req, res) => {
  try {
    const cats = await query(
      `SELECT id, name, active, sort_order FROM issue_categories ORDER BY sort_order, name`,
    )
    const subs = await query(
      `SELECT s.*, (
         SELECT COUNT(*)::int FROM tickets t
         WHERE t.found_subcategory_id = s.id
            OR (t.found_subcategory_id IS NULL AND t.reported_subcategory_id = s.id)
           AND t.raised_at >= NOW() - INTERVAL '90 days'
       ) AS usage_90d
       FROM issue_subcategories s
       ORDER BY s.name`,
    )
    return ok(res, {
      categories: cats.rows.map((c) => ({
        id: c.id,
        name: c.name,
        active: c.active,
        subs: subs.rows
          .filter((s) => s.category_id === c.id)
          .map((s) => ({
            id: s.id,
            name: s.name,
            severity: s.severity,
            active: s.active,
            usage90d: s.usage_90d,
          })),
      })),
      subCount: subs.rowCount,
    })
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.post('/categories', authorize('Issue master', 'c'), async (req, res) => {
  try {
    const body = z.object({ name: categoryNameSchema }).parse(req.body)
    const max = await query<{ m: number }>(
      `SELECT COALESCE(MAX(sort_order),0) AS m FROM issue_categories`,
    )
    const result = await query(
      `INSERT INTO issue_categories (name, sort_order) VALUES ($1,$2) RETURNING *`,
      [body.name, max.rows[0].m + 1],
    )
    return created(res, result.rows[0], 'Category created')
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.patch('/categories/:id', authorize('Issue master', 'e'), async (req, res) => {
  try {
    const body = z
      .object({
        name: categoryNameSchema.optional(),
        active: z.boolean().optional(),
      })
      .refine((d) => Object.keys(d).length > 0, { message: 'No fields to update' })
      .parse(req.body)
    const result = await query(
      `UPDATE issue_categories SET
         name = COALESCE($2, name),
         active = COALESCE($3, active),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, body.name ?? null, body.active ?? null],
    )
    if (!result.rowCount) throw new ApiError(404, 'Category not found', 'NOT_FOUND')
    return ok(res, result.rows[0], 'Category updated')
  } catch (error) {
    return handleApiError(res, error)
  }
})

/**
 * Hard-delete unused category (Issue master d). Cascades unused subs via FK.
 * If tickets/events reference the category or any of its subs → 409 IN_USE.
 */
router.delete('/categories/:id', authorize('Issue master', 'd'), async (req, res) => {
  try {
    const existing = await query(`SELECT id FROM issue_categories WHERE id = $1`, [req.params.id])
    if (!existing.rowCount) throw new ApiError(404, 'Category not found', 'NOT_FOUND')

    const usage = await query<{ n: number }>(
      `SELECT (
         (SELECT COUNT(*)::int FROM tickets
          WHERE reported_category_id = $1 OR found_category_id = $1)
         +
         (SELECT COUNT(*)::int FROM tickets t
          JOIN issue_subcategories s ON s.id IN (t.reported_subcategory_id, t.found_subcategory_id)
          WHERE s.category_id = $1)
         +
         (SELECT COUNT(*)::int FROM ticket_events
          WHERE category_id = $1)
         +
         (SELECT COUNT(*)::int FROM ticket_events e
          JOIN issue_subcategories s ON s.id = e.subcategory_id
          WHERE s.category_id = $1)
         +
         (SELECT COUNT(*)::int FROM ticket_issues WHERE category_id = $1)
       )::int AS n`,
      [req.params.id],
    )
    if (usage.rows[0].n > 0) {
      throw new ApiError(
        409,
        'Category has been used on tickets — deactivate instead',
        'IN_USE',
      )
    }

    const result = await query(`DELETE FROM issue_categories WHERE id = $1 RETURNING id`, [
      req.params.id,
    ])
    if (!result.rowCount) throw new ApiError(404, 'Category not found', 'NOT_FOUND')
    return ok(res, null, 'Category deleted')
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.post('/subcategories', authorize('Issue master', 'c'), async (req, res) => {
  try {
    const body = z
      .object({
        categoryId: z.string().uuid(),
        name: subcategoryNameSchema,
        severity: z.enum(['Critical', 'Major', 'Minor']),
      })
      .parse(req.body)

    const parent = await query<{ id: string; active: boolean }>(
      `SELECT id, active FROM issue_categories WHERE id = $1`,
      [body.categoryId],
    )
    if (!parent.rowCount) throw new ApiError(404, 'Category not found', 'NOT_FOUND')
    if (!parent.rows[0].active) {
      throw new ApiError(400, 'Category is inactive', 'CATEGORY_INACTIVE')
    }

    const result = await query(
      `INSERT INTO issue_subcategories (category_id, name, severity)
       VALUES ($1,$2,$3) RETURNING *`,
      [body.categoryId, body.name, body.severity],
    )
    return created(res, result.rows[0], 'Sub-category created')
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.patch('/subcategories/:id', authorizeIssueSubUpdate, async (req, res) => {
  try {
    const body = z
      .object({
        name: subcategoryNameSchema.optional(),
        severity: z.enum(['Critical', 'Major', 'Minor']).optional(),
        active: z.boolean().optional(),
      })
      .refine((d) => Object.keys(d).length > 0, { message: 'No fields to update' })
      .parse(req.body)
    const result = await query(
      `UPDATE issue_subcategories SET
         name = COALESCE($2, name),
         severity = COALESCE($3, severity),
         active = COALESCE($4, active),
         updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [req.params.id, body.name ?? null, body.severity ?? null, body.active ?? null],
    )
    if (!result.rowCount) throw new ApiError(404, 'Sub-category not found', 'NOT_FOUND')
    return ok(res, result.rows[0], 'Sub-category updated')
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.post('/subcategories/:id/deactivate', authorize('Issue master', 'd'), async (req, res) => {
  try {
    const result = await query(
      `UPDATE issue_subcategories SET active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id],
    )
    if (!result.rowCount) throw new ApiError(404, 'Sub-category not found', 'NOT_FOUND')
    return ok(res, result.rows[0], 'Sub-category deactivated')
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.delete('/subcategories/:id', authorize('Issue master', 'd'), async (req, res) => {
  try {
    const usage = await query(
      `SELECT (
         (SELECT COUNT(*)::int FROM tickets
          WHERE reported_subcategory_id = $1 OR found_subcategory_id = $1)
         +
         (SELECT COUNT(*)::int FROM ticket_issues WHERE subcategory_id = $1)
       )::int AS n`,
      [req.params.id],
    )
    if (usage.rows[0].n > 0) {
      throw new ApiError(
        409,
        'Sub-category has been used on tickets — deactivate instead',
        'IN_USE',
      )
    }
    const result = await query(`DELETE FROM issue_subcategories WHERE id = $1 RETURNING id`, [
      req.params.id,
    ])
    if (!result.rowCount) throw new ApiError(404, 'Sub-category not found', 'NOT_FOUND')
    return ok(res, null, 'Sub-category deleted')
  } catch (error) {
    return handleApiError(res, error)
  }
})

export default router
