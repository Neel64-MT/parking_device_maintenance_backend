import { z } from 'zod'
import { ApiError } from './api-error.js'
import type { DbClient } from '../db/pool.js'
import { query } from '../db/pool.js'

export const issuePairSchema = z.object({
  categoryId: z.string().uuid(),
  subCategoryId: z.string().uuid(),
})

export type IssuePairInput = z.infer<typeof issuePairSchema>

export type ResolvedIssue = {
  categoryId: string
  subcategoryId: string
  category: string
  sub: string
  severity: string
}

/** Normalize raise/update body: prefer `issues[]`; fall back to legacy single pair. */
export function normalizeIssueList(body: {
  issues?: IssuePairInput[]
  categoryId?: string
  subCategoryId?: string
}): IssuePairInput[] {
  if (body.issues && body.issues.length > 0) {
    const seen = new Set<string>()
    const out: IssuePairInput[] = []
    for (const item of body.issues) {
      if (seen.has(item.subCategoryId)) continue
      seen.add(item.subCategoryId)
      out.push(item)
    }
    return out
  }
  if (body.categoryId && body.subCategoryId) {
    return [{ categoryId: body.categoryId, subCategoryId: body.subCategoryId }]
  }
  return []
}

/**
 * Validate each pair: subcategory exists, belongs to category, both active.
 * Returns resolved rows in input order (after dedupe).
 */
export async function resolveIssuePairs(
  pairs: IssuePairInput[],
  db: DbClient = { query },
): Promise<ResolvedIssue[]> {
  if (!pairs.length) {
    throw new ApiError(400, 'At least one issue is required', 'VALIDATION_ERROR')
  }

  const subIds = pairs.map((p) => p.subCategoryId)
  const result = await db.query<{
    id: string
    category_id: string
    name: string
    severity: string
    active: boolean
    cat_name: string
    cat_active: boolean
  }>(
    `SELECT s.id, s.category_id, s.name, s.severity, s.active,
            c.name AS cat_name, c.active AS cat_active
     FROM issue_subcategories s
     JOIN issue_categories c ON c.id = s.category_id
     WHERE s.id = ANY($1::uuid[])`,
    [subIds],
  )

  if (result.rows.length !== new Set(subIds).size) {
    throw new ApiError(400, 'One or more issues are invalid', 'INVALID_ISSUES')
  }

  const byId = new Map(result.rows.map((r) => [r.id, r]))
  const resolved: ResolvedIssue[] = []

  for (const pair of pairs) {
    const row = byId.get(pair.subCategoryId)
    if (!row) {
      throw new ApiError(400, 'One or more issues are invalid', 'INVALID_ISSUES')
    }
    if (row.category_id !== pair.categoryId) {
      throw new ApiError(
        400,
        'Sub-category does not belong to the selected category',
        'INVALID_ISSUES',
      )
    }
    if (!row.active || !row.cat_active) {
      throw new ApiError(400, `Issue is inactive: ${row.cat_name} › ${row.name}`, 'INVALID_ISSUES')
    }
    resolved.push({
      categoryId: row.category_id,
      subcategoryId: row.id,
      category: row.cat_name,
      sub: row.name,
      severity: row.severity,
    })
  }

  return resolved
}

export async function replaceTicketIssues(
  client: DbClient,
  ticketId: string,
  role: 'reported' | 'found',
  issues: ResolvedIssue[],
) {
  await client.query(`DELETE FROM ticket_issues WHERE ticket_id = $1 AND role = $2`, [
    ticketId,
    role,
  ])
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i]
    await client.query(
      `INSERT INTO ticket_issues (ticket_id, role, category_id, subcategory_id, sort_order)
       VALUES ($1,$2,$3,$4,$5)`,
      [ticketId, role, issue.categoryId, issue.subcategoryId, i],
    )
  }
}

export async function loadTicketIssues(
  ticketId: string,
  db: DbClient = { query },
): Promise<{ reported: ResolvedIssue[]; found: ResolvedIssue[] }> {
  const result = await db.query<{
    role: string
    category_id: string
    subcategory_id: string
    cat_name: string
    sub_name: string
    severity: string
  }>(
    `SELECT ti.role, ti.category_id, ti.subcategory_id,
            c.name AS cat_name, s.name AS sub_name, s.severity
     FROM ticket_issues ti
     JOIN issue_categories c ON c.id = ti.category_id
     JOIN issue_subcategories s ON s.id = ti.subcategory_id
     WHERE ti.ticket_id = $1
     ORDER BY ti.role, ti.sort_order, ti.created_at`,
    [ticketId],
  )

  const reported: ResolvedIssue[] = []
  const found: ResolvedIssue[] = []
  for (const row of result.rows) {
    const item: ResolvedIssue = {
      categoryId: row.category_id,
      subcategoryId: row.subcategory_id,
      category: row.cat_name,
      sub: row.sub_name,
      severity: row.severity,
    }
    if (row.role === 'reported') reported.push(item)
    else if (row.role === 'found') found.push(item)
  }
  return { reported, found }
}

export function mapIssueApi(issues: ResolvedIssue[]) {
  return issues.map((i) => ({
    categoryId: i.categoryId,
    subCategoryId: i.subcategoryId,
    category: i.category,
    sub: i.sub,
    severity: i.severity,
  }))
}
