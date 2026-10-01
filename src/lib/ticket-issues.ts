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
  /** Set only for rows loaded from `ticket_issues` (not for freshly validated input pairs). */
  id?: string
  status?: IssueStatus
  resolvedAt?: string | Date | null
  resolvedBy?: string | null
  resolvedEventId?: string | null
}

export type IssueStatus = 'Open' | 'Resolved'

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
      `INSERT INTO ticket_issues (ticket_id, device_id, role, category_id, subcategory_id, sort_order)
       SELECT t.id, t.device_id, $2, $3, $4, $5 FROM tickets t WHERE t.id = $1`,
      [ticketId, role, issue.categoryId, issue.subcategoryId, i],
    )
  }
}

function issueConflictDetails(conflicts: OpenIssueConflict[]) {
  return conflicts.map((c) => ({
    ticketId: c.ticketId,
    id: c.issueId,
    categoryId: c.categoryId,
    subCategoryId: c.subCategoryId,
    category: c.category,
    sub: c.sub,
  }))
}

/**
 * 409 OPEN_TICKET_EXISTS when any of `subIds` is already Open on a non-Closed ticket of the
 * device (other than `exceptTicketId`). Keeps the raise redirect contract
 * (`details.openTicketId`) and lists every duplicate in `details.issues`.
 */
export async function assertNoOpenIssueConflicts(
  db: DbClient,
  deviceId: string,
  subIds: string[],
  exceptTicketId?: string,
) {
  const conflicts = (await findOpenIssueConflicts(db, deviceId, subIds)).filter(
    (c) => c.ticketUuid !== exceptTicketId,
  )
  if (!conflicts.length) return
  const ticketIds = [...new Set(conflicts.map((c) => c.ticketId))]
  const names = conflicts.map((c) => c.sub).join(', ')
  throw new ApiError(
    409,
    `${conflicts.length === 1 ? 'This issue is' : 'These issues are'} already open on ${ticketIds.join(', ')}: ${names}`,
    'OPEN_TICKET_EXISTS',
    {
      ticketId: conflicts[0].ticketId,
      openTicketId: conflicts[0].ticketId,
      issues: issueConflictDetails(conflicts),
    },
  )
}

/**
 * Append new reported issues (status Open) to an existing ticket inside the caller's
 * transaction. Callers must hold the ticket row lock.
 * - a sub-category already on this ticket (Open or Resolved) → 409 ISSUE_ALREADY_ON_TICKET
 * - a sub-category Open on another open ticket of the device → 409 OPEN_TICKET_EXISTS
 */
export async function appendTicketIssues(
  client: DbClient,
  ticket: { id: string; device_id: string },
  issues: ResolvedIssue[],
): Promise<ResolvedIssue[]> {
  if (!issues.length) return []
  const subIds = issues.map((i) => i.subcategoryId)

  const existing = await client.query<{
    id: string
    category_id: string
    subcategory_id: string
    status: IssueStatus
  }>(
    `SELECT id, category_id, subcategory_id, status FROM ticket_issues
     WHERE ticket_id = $1 AND role = 'reported' AND subcategory_id = ANY($2::uuid[])`,
    [ticket.id, subIds],
  )
  if (existing.rows.length) {
    const subs = new Set(existing.rows.map((r) => r.subcategory_id))
    throw new ApiError(409, 'One or more issues are already on this ticket', 'ISSUE_ALREADY_ON_TICKET', {
      issues: issues
        .filter((i) => subs.has(i.subcategoryId))
        .map((i) => {
          const row = existing.rows.find((r) => r.subcategory_id === i.subcategoryId)!
          return {
            id: row.id,
            categoryId: i.categoryId,
            subCategoryId: i.subcategoryId,
            category: i.category,
            sub: i.sub,
            status: row.status,
          }
        }),
    })
  }

  await assertNoOpenIssueConflicts(client, ticket.device_id, subIds, ticket.id)

  const max = await client.query<{ n: number }>(
    `SELECT COALESCE(MAX(sort_order), -1)::int AS n FROM ticket_issues
     WHERE ticket_id = $1 AND role = 'reported'`,
    [ticket.id],
  )
  let sortOrder = (max.rows[0]?.n ?? -1) + 1
  const ids: string[] = []
  for (const issue of issues) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO ticket_issues (ticket_id, device_id, role, category_id, subcategory_id, sort_order)
       VALUES ($1, $2, 'reported', $3, $4, $5)
       RETURNING id`,
      [ticket.id, ticket.device_id, issue.categoryId, issue.subcategoryId, sortOrder++],
    )
    ids.push(inserted.rows[0].id)
  }
  return loadReportedIssuesByIds(client, ids)
}

export type OpenIssueConflict = {
  ticketId: string
  ticketUuid: string
  issueId: string
  categoryId: string
  subCategoryId: string
  category: string
  sub: string
}

/**
 * Open reported issues on the device's non-Closed tickets that match `subIds`.
 * This is the duplicate-ticket rule (Phase 50): same device + same Open issue.
 * `idx_ticket_issues_one_open_issue_per_device` is the database backstop for races.
 */
export async function findOpenIssueConflicts(
  db: DbClient,
  deviceId: string,
  subIds: string[],
): Promise<OpenIssueConflict[]> {
  if (!subIds.length) return []
  const result = await db.query<{
    public_id: string
    ticket_id: string
    id: string
    category_id: string
    subcategory_id: string
    cat_name: string
    sub_name: string
  }>(
    `SELECT t.public_id, t.id AS ticket_id, ti.id, ti.category_id, ti.subcategory_id,
            c.name AS cat_name, s.name AS sub_name
     FROM ticket_issues ti
     JOIN tickets t ON t.id = ti.ticket_id
     JOIN issue_categories c ON c.id = ti.category_id
     JOIN issue_subcategories s ON s.id = ti.subcategory_id
     WHERE t.device_id = $1 AND t.status <> 'Closed'
       AND ti.role = 'reported' AND ti.status = 'Open'
       AND ti.subcategory_id = ANY($2::uuid[])
     ORDER BY t.raised_at, ti.sort_order`,
    [deviceId, subIds],
  )
  return result.rows.map((r) => ({
    ticketId: r.public_id,
    ticketUuid: r.ticket_id,
    issueId: r.id,
    categoryId: r.category_id,
    subCategoryId: r.subcategory_id,
    category: r.cat_name,
    sub: r.sub_name,
  }))
}

export type OpenDeviceTicket = {
  id: string
  uuid: string
  status: string
  assigneeId: string | null
  raisedAt: string | Date
  issues: {
    id: string
    categoryId: string
    subCategoryId: string
    category: string
    sub: string
    severity: string
  }[]
}

/** Every non-Closed ticket on a device (oldest first) with only its Open reported issues. */
export async function loadOpenDeviceTickets(
  deviceId: string,
  db: DbClient = { query },
): Promise<OpenDeviceTicket[]> {
  const result = await db.query<{
    ticket_id: string
    public_id: string
    status: string
    assignee_id: string | null
    raised_at: string | Date
    issue_id: string | null
    category_id: string | null
    subcategory_id: string | null
    cat_name: string | null
    sub_name: string | null
    severity: string | null
  }>(
    `SELECT t.id AS ticket_id, t.public_id, t.status, t.assignee_id, t.raised_at,
            ti.id AS issue_id, ti.category_id, ti.subcategory_id,
            c.name AS cat_name, s.name AS sub_name, s.severity
     FROM tickets t
     LEFT JOIN ticket_issues ti
       ON ti.ticket_id = t.id AND ti.role = 'reported' AND ti.status = 'Open'
     LEFT JOIN issue_categories c ON c.id = ti.category_id
     LEFT JOIN issue_subcategories s ON s.id = ti.subcategory_id
     WHERE t.device_id = $1 AND t.status <> 'Closed'
     ORDER BY t.raised_at, ti.sort_order`,
    [deviceId],
  )
  const byTicket = new Map<string, OpenDeviceTicket>()
  for (const r of result.rows) {
    let ticket = byTicket.get(r.ticket_id)
    if (!ticket) {
      ticket = {
        id: r.public_id,
        uuid: r.ticket_id,
        status: r.status === 'New' ? 'Open' : r.status,
        assigneeId: r.assignee_id,
        raisedAt: r.raised_at,
        issues: [],
      }
      byTicket.set(r.ticket_id, ticket)
    }
    if (r.issue_id && r.category_id && r.subcategory_id) {
      ticket.issues.push({
        id: r.issue_id,
        categoryId: r.category_id,
        subCategoryId: r.subcategory_id,
        category: r.cat_name || '',
        sub: r.sub_name || '',
        severity: r.severity || '',
      })
    }
  }
  return [...byTicket.values()]
}

export async function loadTicketIssues(
  ticketId: string,
  db: DbClient = { query },
): Promise<{ reported: ResolvedIssue[]; found: ResolvedIssue[] }> {
  const result = await db.query<IssueRow & { role: string }>(
    `SELECT ti.role, ${ISSUE_ROW_COLUMNS}
     FROM ticket_issues ti
     JOIN issue_categories c ON c.id = ti.category_id
     JOIN issue_subcategories s ON s.id = ti.subcategory_id
     LEFT JOIN users ru ON ru.id = ti.resolved_by_user_id
     WHERE ti.ticket_id = $1
     ORDER BY ti.role, ti.sort_order, ti.created_at`,
    [ticketId],
  )

  const reported: ResolvedIssue[] = []
  const found: ResolvedIssue[] = []
  for (const row of result.rows) {
    if (row.role === 'reported') reported.push(issueFromRow(row))
    else if (row.role === 'found') found.push(issueFromRow(row, false))
  }
  return { reported, found }
}

type IssueRow = {
  id: string
  category_id: string
  subcategory_id: string
  cat_name: string
  sub_name: string
  severity: string
  status: IssueStatus
  resolved_at: string | Date | null
  resolved_event_id: string | null
  resolved_by_name: string | null
}

const ISSUE_ROW_COLUMNS = `ti.id, ti.category_id, ti.subcategory_id,
            c.name AS cat_name, s.name AS sub_name, s.severity,
            ti.status, ti.resolved_at, ti.resolved_event_id, ru.full_name AS resolved_by_name`

/** `withStatus` is false for found rows — only reported issues carry Open/Resolved. */
function issueFromRow(row: IssueRow, withStatus = true): ResolvedIssue {
  const base: ResolvedIssue = {
    categoryId: row.category_id,
    subcategoryId: row.subcategory_id,
    category: row.cat_name,
    sub: row.sub_name,
    severity: row.severity,
  }
  if (!withStatus) return base
  return {
    ...base,
    id: row.id,
    status: row.status,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by_name,
    resolvedEventId: row.resolved_event_id,
  }
}

async function loadReportedIssuesByIds(client: DbClient, ids: string[]) {
  const result = await client.query<IssueRow>(
    `SELECT ${ISSUE_ROW_COLUMNS}
     FROM ticket_issues ti
     JOIN issue_categories c ON c.id = ti.category_id
     JOIN issue_subcategories s ON s.id = ti.subcategory_id
     LEFT JOIN users ru ON ru.id = ti.resolved_by_user_id
     WHERE ti.id = ANY($1::uuid[])
     ORDER BY ti.sort_order, ti.created_at`,
    [ids],
  )
  return result.rows.map((row) => issueFromRow(row))
}

type ResolveContext = { eventId: string; userId: string }

/**
 * Resolve a selection of reported issues on one ticket inside the caller's transaction.
 * `issueIds` are sub issues (`ticket_issues.id`); `categoryIds` are main issues, which resolve
 * every Open sub issue of that category on this ticket and leave other categories untouched.
 * Callers must already hold the ticket row lock, so the Open check below sees committed
 * state and two concurrent updates cannot both resolve the same issue.
 */
export async function resolveIssueSelection(
  client: DbClient,
  ticketId: string,
  selection: { issueIds?: string[]; categoryIds?: string[] },
  ctx: ResolveContext,
): Promise<ResolvedIssue[]> {
  const issueIds = [...new Set(selection.issueIds || [])]
  const categoryIds = [...new Set(selection.categoryIds || [])]
  if (!issueIds.length && !categoryIds.length) return []

  const current = await client.query<{ id: string; status: IssueStatus; category_id: string }>(
    `SELECT id, status, category_id FROM ticket_issues
     WHERE ticket_id = $1 AND role = 'reported'
       AND (id = ANY($2::uuid[]) OR category_id = ANY($3::uuid[]))
     FOR UPDATE`,
    [ticketId, issueIds, categoryIds],
  )
  const byId = new Map(current.rows.map((r) => [r.id, r]))
  if (issueIds.some((id) => !byId.has(id))) {
    throw new ApiError(400, 'One or more issues do not belong to this ticket', 'INVALID_ISSUES')
  }
  if (issueIds.some((id) => byId.get(id)!.status !== 'Open')) {
    throw new ApiError(409, 'One or more issues are already resolved', 'ISSUE_ALREADY_RESOLVED')
  }

  const ids = new Set(issueIds)
  for (const categoryId of categoryIds) {
    const rows = current.rows.filter((r) => r.category_id === categoryId)
    if (!rows.length) {
      throw new ApiError(400, 'One or more issues do not belong to this ticket', 'INVALID_ISSUES')
    }
    const open = rows.filter((r) => r.status === 'Open')
    if (!open.length) {
      throw new ApiError(409, 'One or more issues are already resolved', 'ISSUE_ALREADY_RESOLVED')
    }
    for (const r of open) ids.add(r.id)
  }
  return markIssuesResolved(client, ticketId, [...ids], ctx)
}

async function markIssuesResolved(
  client: DbClient,
  ticketId: string,
  ids: string[],
  ctx: ResolveContext,
): Promise<ResolvedIssue[]> {
  const updated = await client.query<{ id: string }>(
    `UPDATE ticket_issues
     SET status = 'Resolved', resolved_at = NOW(), resolved_by_user_id = $3, resolved_event_id = $4
     WHERE id = ANY($1::uuid[]) AND ticket_id = $2 AND role = 'reported' AND status = 'Open'
     RETURNING id`,
    [ids, ticketId, ctx.userId, ctx.eventId],
  )
  if (updated.rows.length !== ids.length) {
    throw new ApiError(409, 'One or more issues are already resolved', 'ISSUE_ALREADY_RESOLVED')
  }
  return loadReportedIssuesByIds(client, ids)
}

/** Closing a ticket resolves every reported issue that is still Open, tagged with the closing event. */
export async function resolveOpenTicketIssues(
  client: DbClient,
  ticketId: string,
  ctx: ResolveContext,
): Promise<ResolvedIssue[]> {
  const updated = await client.query<{ id: string }>(
    `UPDATE ticket_issues
     SET status = 'Resolved', resolved_at = NOW(), resolved_by_user_id = $2, resolved_event_id = $3
     WHERE ticket_id = $1 AND role = 'reported' AND status = 'Open'
     RETURNING id`,
    [ticketId, ctx.userId, ctx.eventId],
  )
  if (!updated.rows.length) return []
  return loadReportedIssuesByIds(
    client,
    updated.rows.map((r) => r.id),
  )
}

export async function countOpenTicketIssues(client: DbClient, ticketId: string) {
  const result = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ticket_issues
     WHERE ticket_id = $1 AND role = 'reported' AND status = 'Open'`,
    [ticketId],
  )
  return result.rows[0]?.n ?? 0
}

export function mapIssueApi(issues: ResolvedIssue[]) {
  return issues.map((i) => ({
    categoryId: i.categoryId,
    subCategoryId: i.subcategoryId,
    category: i.category,
    sub: i.sub,
    severity: i.severity,
    ...(i.id
      ? {
          id: i.id,
          status: i.status,
          resolvedAt: i.resolvedAt ?? null,
          resolvedBy: i.resolvedBy ?? null,
        }
      : {}),
  }))
}
