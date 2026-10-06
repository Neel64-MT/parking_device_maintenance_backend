import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handleApiError, isUniqueViolation } from '../lib/api-error.js'
import { created, ok } from '../lib/respond.js'
import { query, withTransaction } from '../db/pool.js'
import {
  assertRoadAccessUnlessFieldWork,
  authorize,
  hasPermission,
  requireAuth,
  type AuthedRequest,
} from '../middleware/auth.js'
import { isTicketPrivilegedRole } from '../lib/ticket-access.js'
import { nextPublicId } from '../lib/ids.js'
import { deviceDisplayId, deviceLookupWhere } from '../lib/device-ref.js'
import { limitSchema, pageSchema, paginationMeta, sqlOffset } from '../lib/pagination.js'
import { insertEventParts, resolvePartsCost, visitEventCost } from '../lib/parts-cost.js'
import {
  appendTicketIssues,
  assertNoOpenIssueConflicts,
  countOpenTicketIssues,
  issuePairSchema,
  loadTicketIssues,
  mapIssueApi,
  normalizeIssueList,
  replaceTicketIssues,
  resolveIssuePairs,
  resolveIssueSelection,
  resolveOpenTicketIssues,
  type ResolvedIssue,
} from '../lib/ticket-issues.js'
import { createNewTicketNotifications } from '../lib/notifications.js'

const router = Router()
router.use(requireAuth)

/**
 * Open (`open`) = raised, no update yet; Under repair (`urp`) = at least one update
 * (Under repair, Waiting for spare, or a historical assignee); Closed (`cls`).
 */
function tabForStatus(status: string, assigneeId: string | null) {
  if (status === 'Closed') return 'cls'
  if ((status === 'Open' || status === 'New') && !assigneeId) return 'open'
  return 'urp'
}

/** Legacy rows may still say New; product status is Open only. */
function displayStatus(status: string) {
  return status === 'New' ? 'Open' : status
}

/**
 * List/tiles only: historical tickets assigned before assignment was removed and still stored
 * as Open/New count & display as Under repair (DB unchanged). New tickets never get an assignee.
 */
function listStatus(status: string, assigneeId: string | null) {
  const s = displayStatus(status)
  if (assigneeId && s === 'Open') return 'Under repair'
  return s
}

function statusTone(status: string) {
  if (status === 'Closed') return 'ok'
  if (status === 'Under repair' || status === 'Waiting for spare') return 'warn'
  return 'bad'
}

const ticketListJoins = `
       FROM tickets t
       JOIN devices d ON d.id = t.device_id
       JOIN roads r ON r.id = d.road_id
       LEFT JOIN users ru ON ru.id = t.raised_by_user_id
       LEFT JOIN issue_categories rc ON rc.id = t.reported_category_id
       LEFT JOIN issue_subcategories rs ON rs.id = t.reported_subcategory_id
       LEFT JOIN issue_categories fc ON fc.id = t.found_category_id
       LEFT JOIN issue_subcategories fs ON fs.id = t.found_subcategory_id`

/** Open and not yet worked on (a historical assignee counts as worked on — see listStatus). */
const NOT_ATTENDED_SQL = `t.status IN ('Open', 'New') AND t.assignee_id IS NULL`
const UNDER_REPAIR_TAB_SQL = `t.status <> 'Closed' AND NOT (${NOT_ATTENDED_SQL})`
const OVER_3_DAYS_SQL = `t.raised_at < NOW() - INTERVAL '3 days'`

router.get('/', authorize('All tickets', 'v'), async (req: AuthedRequest, res) => {
  try {
    const schema = z.object({
      tab: z.enum(['open', 'urp', 'cls']).optional(),
      q: z.string().optional(),
      road: z.string().optional(),
      status: z.string().optional(),
      category: z.string().optional(),
      age: z.enum(['over3']).optional(),
      /** One slot (Slot View): public_id, UUID or Slot Id, resolved server-side. */
      device: z.string().trim().min(1).optional(),
      page: pageSchema,
      limit: limitSchema,
    })
    const filters = schema.parse(req.query)
    const baseParams: unknown[] = []
    const baseWhere: string[] = []

    // Every ticket on every road is visible to anyone with All tickets `v`.
    if (filters.device) {
      baseParams.push(filters.device)
      baseWhere.push(deviceLookupWhere('d', baseParams.length))
    }
    if (filters.road && filters.road !== 'All roads') {
      baseParams.push(filters.road)
      baseWhere.push(`r.name = $${baseParams.length}`)
    }
    if (filters.category && filters.category !== 'All categories') {
      baseParams.push(filters.category)
      baseWhere.push(`COALESCE(fc.name, rc.name) = $${baseParams.length}`)
    }
    if (filters.q?.trim()) {
      baseParams.push(`%${filters.q.trim().toLowerCase()}%`)
      baseWhere.push(
        `(LOWER(t.public_id) LIKE $${baseParams.length} OR LOWER(d.public_id) LIKE $${baseParams.length} OR LOWER(d.slot_number) LIKE $${baseParams.length} OR CAST(d.slot_id AS TEXT) LIKE $${baseParams.length} OR LOWER(COALESCE(d.slot_identifier,'')) LIKE $${baseParams.length})`,
      )
    }

    const baseWhereSql = baseWhere.length ? `WHERE ${baseWhere.join(' AND ')}` : ''

    // Tiles / over3Counts: search filters only. tabCounts additionally respect `age`.
    const over3 = filters.age === 'over3'
    const ageAnd = over3 ? ` AND ${OVER_3_DAYS_SQL}` : ''
    const agg = await query(
      `SELECT
         COUNT(*) FILTER (WHERE ${NOT_ATTENDED_SQL})::int AS open_not_attended,
         COUNT(*) FILTER (
           WHERE t.status = 'Under repair'
              OR (t.assignee_id IS NOT NULL AND t.status IN ('Open', 'New'))
         )::int AS under_repair,
         COUNT(*) FILTER (WHERE t.status = 'Waiting for spare')::int AS waiting_spare,
         COUNT(*) FILTER (WHERE t.status <> 'Closed' AND ${OVER_3_DAYS_SQL})::int AS open_over_3,
         COUNT(*) FILTER (WHERE ${NOT_ATTENDED_SQL} AND ${OVER_3_DAYS_SQL})::int AS over3_open,
         COUNT(*) FILTER (WHERE ${UNDER_REPAIR_TAB_SQL} AND ${OVER_3_DAYS_SQL})::int AS over3_urp,
         COUNT(*) FILTER (WHERE ${NOT_ATTENDED_SQL}${ageAnd})::int AS tab_open,
         COUNT(*) FILTER (WHERE ${UNDER_REPAIR_TAB_SQL}${ageAnd})::int AS tab_urp,
         COUNT(*) FILTER (WHERE t.status = 'Closed')::int AS tab_cls
       ${ticketListJoins}
       ${baseWhereSql}`,
      baseParams,
    )
    const a = agg.rows[0]

    const pageWhere = [...baseWhere]
    const pageParams = [...baseParams]
    if (filters.tab === 'open') {
      pageWhere.push(NOT_ATTENDED_SQL)
    } else if (filters.tab === 'urp') {
      pageWhere.push(UNDER_REPAIR_TAB_SQL)
    } else if (filters.tab === 'cls') {
      pageWhere.push(`t.status = 'Closed'`)
    }
    if (over3 && filters.tab !== 'cls') {
      pageWhere.push(`t.status <> 'Closed' AND ${OVER_3_DAYS_SQL}`)
    }
    if (filters.status && filters.status !== 'All') {
      if (filters.status === 'Open + under repair') {
        pageWhere.push(`t.status <> 'Closed'`)
      } else if (filters.status === 'Open, not attended') {
        pageWhere.push(NOT_ATTENDED_SQL)
      } else if (filters.status === 'Under repair') {
        pageWhere.push(
          `(t.status = 'Under repair' OR (t.assignee_id IS NOT NULL AND t.status IN ('Open', 'New')))`,
        )
      } else if (filters.status === 'Open') {
        pageWhere.push(NOT_ATTENDED_SQL)
      } else if (filters.status === 'Waiting for spare') {
        pageWhere.push(`t.status = 'Waiting for spare'`)
      } else if (filters.status === 'Closed') {
        pageWhere.push(`t.status = 'Closed'`)
      } else {
        pageParams.push(filters.status)
        pageWhere.push(`t.status = $${pageParams.length}`)
      }
    }
    const pageWhereSql = pageWhere.length ? `WHERE ${pageWhere.join(' AND ')}` : ''

    const countResult = await query(
      `SELECT COUNT(*)::int AS n ${ticketListJoins} ${pageWhereSql}`,
      pageParams,
    )
    const total = countResult.rows[0]?.n ?? 0

    const limit = filters.limit
    const offset = sqlOffset(filters.page, limit)
    pageParams.push(limit, offset)
    // One Add Update POST creates one visit event. `reclassified` is legacy history and is
    // still counted so older tickets keep their previous "Updates logged" totals.
    const result = await query(
      `SELECT t.*, d.public_id AS device_public_id, d.slot_id, d.slot_number, r.name AS road_name,
              ru.full_name AS raised_by_name,
              rc.name AS reported_cat, rs.name AS reported_sub,
              fc.name AS found_cat, fs.name AS found_sub,
              (SELECT COUNT(*)::int FROM ticket_events e
                WHERE e.ticket_id = t.id
                  AND e.event_type IN ('visit_open', 'visit_resolved', 'waiting_spare', 'reclassified')
               ) AS updates
       ${ticketListJoins}
       ${pageWhereSql}
       ORDER BY t.raised_at DESC
       LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams,
    )

    const rows = result.rows.map((t) => {
      const daysOpen = Math.floor(
        ((t.closed_at ? new Date(t.closed_at).getTime() : Date.now()) -
          new Date(t.raised_at).getTime()) /
          86400000,
      )
      const tab = tabForStatus(t.status, t.assignee_id)
      const status = listStatus(t.status, t.assignee_id)
      const slotIdDisplay = deviceDisplayId({
        slot_id: t.slot_id,
        public_id: t.device_public_id,
      })
      return {
        id: t.public_id,
        uuid: t.id,
        deviceId: slotIdDisplay,
        slotId: t.slot_id != null && t.slot_id !== '' ? Number(t.slot_id) : null,
        tab,
        road: t.road_name,
        slot: `Slot ${t.slot_number}`,
        issueReported: t.reported_sub || t.description || '—',
        issueReportedDetail: t.reported_cat
          ? `${t.reported_cat} › ${t.reported_sub}`
          : null,
        issueFound: t.found_sub || null,
        issueFoundDetail: t.found_cat || null,
        raisedBy: t.raised_by_name || null,
        updates: t.updates,
        daysOpen,
        daysAfterClose: t.closed_at
          ? Math.floor((Date.now() - new Date(t.closed_at).getTime()) / 86400000)
          : null,
        daysBad: daysOpen > 3 && status !== 'Closed',
        status,
        statusTone: statusTone(status),
      }
    })

    return res.status(200).json({
      success: true,
      data: rows,
      tiles: [
        { value: String(a.open_not_attended), label: 'Open, not attended', tone: 'bad' },
        { value: String(a.under_repair), label: 'Under repair', tone: 'warn' },
        { value: String(a.waiting_spare), label: 'Waiting for spare', tone: 'warn' },
        { value: String(a.open_over_3), label: 'Open over 3 days', tone: 'bad' },
        { value: String(a.tab_cls), label: 'Closed', tone: 'ok' },
      ],
      tabCounts: {
        open: a.tab_open,
        urp: a.tab_urp,
        cls: a.tab_cls,
      },
      over3Counts: {
        open: a.over3_open,
        urp: a.over3_urp,
      },
      pagination: paginationMeta(filters.page, limit, total),
    })
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/export', authorize('All tickets', 'v'), async (req: AuthedRequest, res) => {
  try {
    const result = await query(
      `SELECT t.public_id, d.public_id AS device_public_id, d.slot_id, r.name AS road,
              t.status, t.assignee_id, t.raised_at
       FROM tickets t
       JOIN devices d ON d.id = t.device_id
       JOIN roads r ON r.id = d.road_id
       ORDER BY t.raised_at DESC`,
    )
    const header = 'Ticket,Slot Id,Road,Status,Raised\n'
    const lines = result.rows.map((r) => {
      const device = deviceDisplayId({
        slot_id: r.slot_id,
        public_id: r.device_public_id,
      })
      return `${r.public_id},${device},"${r.road}",${listStatus(r.status, r.assignee_id)},${r.raised_at}`
    })
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', 'attachment; filename="tickets.csv"')
    return res.send(header + lines.join('\n'))
  } catch (error) {
    return handleApiError(res, error)
  }
})

const raiseSchema = z
  .object({
    deviceId: z.string().min(1),
    issues: z.array(issuePairSchema).min(1).optional(),
    categoryId: z.string().uuid().optional(),
    subCategoryId: z.string().uuid().optional(),
    description: z.string().optional(),
    reporterType: z.string().default('Site attendant'),
    priority: z.string().optional(),
    photos: z.array(z.string()).default([]),
  })
  .superRefine((data, ctx) => {
    if (!normalizeIssueList(data).length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one issue is required (issues[] or categoryId + subCategoryId)',
        path: ['issues'],
      })
    }
  })

router.post('/', authorize('Raise ticket', 'c'), async (req: AuthedRequest, res) => {
  try {
    const body = raiseSchema.parse(req.body)
    const issueInputs = normalizeIssueList(body)
    const resolvedIssues = await resolveIssuePairs(issueInputs)
    const primary = resolvedIssues[0]

    const deviceId = body.deviceId.trim()
    const device = await query(
      `SELECT d.*, r.name AS road_name FROM devices d JOIN roads r ON r.id = d.road_id
       WHERE ${deviceLookupWhere('d', 1)}`,
      [deviceId],
    )
    if (!device.rowCount) throw new ApiError(404, 'Device not found', 'NOT_FOUND')
    assertRoadAccessUnlessFieldWork(req.user!, device.rows[0].road_id)
    // Duplicate = same device + same Open issue. Other open tickets on the device (different
    // issues) and Closed tickets never block a raise, and a Closed ticket is never reopened.
    const subIds = resolvedIssues.map((i) => i.subcategoryId)
    await assertNoOpenIssueConflicts({ query }, device.rows[0].id, subIds)
    const publicId = await nextPublicId('TK', 4)
    const status = 'Open'
    let ticketUuid: string
    let raisedEventId: string
    try {
      const createdTicket = await withTransaction(async (client) => {
        const ticket = await client.query(
          `INSERT INTO tickets (
            public_id, device_id, status, priority, reporter_type, description,
            reported_category_id, reported_subcategory_id,
            raised_by_user_id
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [
            publicId,
            device.rows[0].id,
            status,
            body.priority || null,
            body.reporterType,
            body.description || null,
            primary.categoryId,
            primary.subcategoryId,
            req.user!.id,
          ],
        )
        const id = ticket.rows[0].id as string
        await replaceTicketIssues(client, id, 'reported', resolvedIssues)
        const raisedEvent = await client.query(
          `INSERT INTO ticket_events (ticket_id, event_type, title, body, status_label, actor_user_id, category_id, subcategory_id, photos)
           VALUES ($1,'raised','Ticket raised',$2,$3,$4,$5,$6,$7)
           RETURNING id`,
          [
            id,
            body.description || 'Ticket raised',
            status,
            req.user!.id,
            primary.categoryId,
            primary.subcategoryId,
            JSON.stringify(body.photos),
          ],
        )
        return { id, eventId: raisedEvent.rows[0].id as string }
      })
      ticketUuid = createdTicket.id
      raisedEventId = createdTicket.eventId
    } catch (err) {
      // A concurrent raise of the same issue committed first: the partial unique index
      // rolled this transaction back, so answer exactly like the pre-check would.
      if (isUniqueViolation(err)) {
        await assertNoOpenIssueConflicts({ query }, device.rows[0].id, subIds)
      }
      throw err
    }

    // The ticket is fully created before notification persistence is attempted.
    // Notification failures are logged but must never turn a successful raise into an error.
    try {
      await createNewTicketNotifications(ticketUuid, raisedEventId)
    } catch (notificationError) {
      console.error(`[notifications] failed after ticket ${publicId} was raised:`, notificationError)
    }

    return created(
      res,
      {
        id: publicId,
        uuid: ticketUuid,
        eventId: raisedEventId,
        status,
        issuesReported: mapIssueApi(resolvedIssues),
      },
      'Ticket raised',
    )
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/:ticketId', authorize('All tickets', 'v'), async (req: AuthedRequest, res) => {
  try {
    const result = await query(
      `SELECT t.*, d.public_id AS device_public_id, d.slot_id, d.slot_number, d.road_id,
              r.name AS road_name, ru.full_name AS raised_by_name,
              rc.name AS reported_cat, rs.name AS reported_sub,
              fc.name AS found_cat, fs.name AS found_sub
       FROM tickets t
       JOIN devices d ON d.id = t.device_id
       JOIN roads r ON r.id = d.road_id
       LEFT JOIN users ru ON ru.id = t.raised_by_user_id
       LEFT JOIN issue_categories rc ON rc.id = t.reported_category_id
       LEFT JOIN issue_subcategories rs ON rs.id = t.reported_subcategory_id
       LEFT JOIN issue_categories fc ON fc.id = t.found_category_id
       LEFT JOIN issue_subcategories fs ON fs.id = t.found_subcategory_id
       WHERE t.public_id = $1 OR t.id::text = $1`,
      [req.params.ticketId],
    )
    if (!result.rowCount) throw new ApiError(404, 'Ticket not found', 'NOT_FOUND')
    const t = result.rows[0]

    const ticketIssueLists = await loadTicketIssues(t.id)

    const events = await query(
      `SELECT e.*, u.full_name AS actor_name, c.name AS cat_name, s.name AS sub_name
       FROM ticket_events e
       LEFT JOIN users u ON u.id = e.actor_user_id
       LEFT JOIN issue_categories c ON c.id = e.category_id
       LEFT JOIN issue_subcategories s ON s.id = e.subcategory_id
       WHERE e.ticket_id = $1
       ORDER BY e.created_at DESC`,
      [t.id],
    )

    const previous = await query(
      `SELECT public_id AS id, COALESCE(fs.name, rs.name) AS issue,
              GREATEST(0, EXTRACT(DAY FROM (COALESCE(closed_at, NOW()) - raised_at)))::int AS days
       FROM tickets t
       LEFT JOIN issue_subcategories fs ON fs.id = t.found_subcategory_id
       LEFT JOIN issue_subcategories rs ON rs.id = t.reported_subcategory_id
       WHERE t.device_id = $1 AND t.id <> $2
       ORDER BY t.raised_at DESC LIMIT 10`,
      [t.device_id, t.id],
    )

    const daysOpen = Math.floor(
      ((t.closed_at ? new Date(t.closed_at).getTime() : Date.now()) -
        new Date(t.raised_at).getTime()) /
        86400000,
    )

    // The update trail shows which reported issues each event resolved.
    const resolvedByEvent = new Map<string, ResolvedIssue[]>()
    for (const issue of ticketIssueLists.reported) {
      if (!issue.resolvedEventId) continue
      const list = resolvedByEvent.get(issue.resolvedEventId) || []
      list.push(issue)
      resolvedByEvent.set(issue.resolvedEventId, list)
    }

    return ok(res, {
      header: {
        id: t.public_id,
        deviceId: deviceDisplayId({
          slot_id: t.slot_id,
          public_id: t.device_public_id,
        }),
        slotId: t.slot_id != null && t.slot_id !== '' ? Number(t.slot_id) : null,
        road: t.road_name,
        slot: t.slot_number,
        status: displayStatus(t.status),
        statusTone: statusTone(displayStatus(t.status)),
        facts: [
          { label: 'Raised on', value: t.raised_at },
          { label: 'Raised by', value: t.raised_by_name },
          { label: 'Days open', value: `${daysOpen} days`, bad: daysOpen > 3 },
          { label: 'Cost so far', value: `₹ ${Number(t.total_cost).toLocaleString('en-IN')}` },
        ],
      },
      classification: {
        reported: { category: t.reported_cat, sub: t.reported_sub },
        found: { category: t.found_cat, sub: t.found_sub },
      },
      issuesReported: mapIssueApi(ticketIssueLists.reported),
      issuesFound: mapIssueApi(ticketIssueLists.found),
      workHistory: events.rows.map((e) => ({
        when: e.created_at,
        actor: e.actor_name,
        title: e.title,
        status: e.status_label,
        body: e.body,
        eventType: e.event_type,
        category: e.cat_name || null,
        subcategory: e.sub_name || null,
        workDone: e.work_done || null,
        note: e.not_fixed_reason || null,
        cost: e.cost,
        nextVisit: e.next_visit_at,
        parts: e.parts,
        photos: e.photos,
        meta: e.meta,
        resolvedIssues: mapIssueApi(resolvedByEvent.get(e.id) || []),
      })),
      devicePreviousTickets: previous.rows,
    })
  } catch (error) {
    return handleApiError(res, error)
  }
})

/**
 * Photos on an existing event may be attached by the user who created that event
 * (the raiser for `raised`), or by Admin / Project manager.
 */
function assertCanAttachEventPhotos(req: AuthedRequest, actorUserId: string | null) {
  if (isTicketPrivilegedRole(req.user!)) return
  if (actorUserId && actorUserId === req.user!.id) return
  throw new ApiError(403, 'Only the user who added this entry can attach photos to it', 'FORBIDDEN')
}

const RESOLVED_UPDATE_TYPE = 'Site visit — resolved'

/** Exact match only — "Site visit — not resolved" also contains the word "resolved". */
function isResolvedUpdate(updateType: string) {
  return updateType === RESOLVED_UPDATE_TYPE
}

function updateEventType(updateType: string) {
  if (isResolvedUpdate(updateType)) return 'visit_resolved'
  if (updateType === 'Waiting for spare') return 'waiting_spare'
  return 'visit_open'
}

const updateSchema = z.object({
  updateType: z.enum([
    'Site visit — not resolved',
    'Site visit — resolved',
    'Remote check',
    'Waiting for spare',
    'Waiting for traffic police / AMC',
  ]),
  issues: z.array(issuePairSchema).min(1).optional(),
  categoryId: z.string().uuid().optional(),
  subCategoryId: z.string().uuid().optional(),
  workDone: z.string().optional(),
  notFixedReason: z.string().optional(),
  nextVisitAt: z.string().optional(),
  /** Labour / non-part visit charges only — part prices come from Parts Master. */
  cost: z.coerce.number().nonnegative().default(0),
  parts: z.array(z.string().uuid()).default([]),
  photos: z.array(z.string()).default([]),
  /** Close the ticket with this update. Only an explicit `true` closes; omitted = keep open. */
  closeTicket: z.boolean().default(false),
  /** Sub issues (`issuesReported[].id`) this update resolves; each must be Open on this ticket. */
  resolveIssueIds: z
    .array(z.string().uuid())
    .default([])
    .transform((ids) => [...new Set(ids)]),
  /** Main issues (`issuesReported[].categoryId`): resolves every Open sub issue of that category. */
  resolveCategoryIds: z
    .array(z.string().uuid())
    .default([])
    .transform((ids) => [...new Set(ids)]),
  /** New issues appended to the ticket as Open reported issues. */
  addIssues: z.array(issuePairSchema).default([]),
})

router.post('/:ticketId/updates', authorize('Update ticket', 'e'), async (req: AuthedRequest, res) => {
  try {
    const body = updateSchema.parse(req.body)
    const ticketId = String(req.params.ticketId || '').trim()
    const ticket = await query(
      `SELECT t.*, d.road_id FROM tickets t JOIN devices d ON d.id = t.device_id
       WHERE t.public_id = $1 OR t.id::text = $1`,
      [ticketId],
    )
    if (!ticket.rowCount) {
      throw new ApiError(404, 'No tickets available', 'NO_TICKETS_AVAILABLE')
    }
    const t = ticket.rows[0]
    if (t.status === 'Closed') throw new ApiError(409, 'Ticket is closed', 'CLOSED')
    // Any user with Update ticket `e` may update any open ticket; there is no holder.
    if (body.closeTicket && !hasPermission(req.user!, 'Update ticket', 'x')) {
      throw new ApiError(403, 'Forbidden', 'FORBIDDEN')
    }

    const foundInputs = normalizeIssueList(body)
    const foundIssues = foundInputs.length ? await resolveIssuePairs(foundInputs) : null
    const primaryFound = foundIssues?.[0] ?? null
    const addInputs = normalizeIssueList({ issues: body.addIssues })
    const newIssues = addInputs.length ? await resolveIssuePairs(addInputs) : []

    const { partsCost, snapshots } = await resolvePartsCost(body.parts)
    const eventCost = visitEventCost(body.cost, partsCost)

    const isResolved = isResolvedUpdate(body.updateType)
    const eventType = updateEventType(body.updateType)
    // Close only on an explicit closeTicket. Otherwise a waiting-spare visit holds the
    // ticket and every other visit (including "resolved") returns it to Under repair.
    const newStatus = body.closeTicket
      ? 'Closed'
      : body.updateType === 'Waiting for spare'
        ? 'Waiting for spare'
        : 'Under repair'

    const runUpdate = () => withTransaction(async (client) => {
      // Row lock serialises concurrent updates on this ticket, so issue appends and
      // resolutions below always see the latest committed issue state.
      const locked = await client.query<{ status: string }>(
        `SELECT status FROM tickets WHERE id = $1 FOR UPDATE`,
        [t.id],
      )
      const current = locked.rows[0]
      if (!current || current.status === 'Closed') {
        throw new ApiError(409, 'Ticket is closed', 'CLOSED')
      }

      const added = await appendTicketIssues(client, t, newIssues)

      if (foundIssues && primaryFound) {
        // One update request must create exactly one timeline entry. The visit event inserted
        // below already stores the on-site issue, so no extra "reclassified" event is written.
        await client.query(
          `UPDATE tickets SET found_category_id = $2, found_subcategory_id = $3, updated_at = NOW() WHERE id = $1`,
          [t.id, primaryFound.categoryId, primaryFound.subcategoryId],
        )
        await replaceTicketIssues(client, t.id, 'found', foundIssues)
      }

      const inserted = await client.query(
        `INSERT INTO ticket_events (
           ticket_id, event_type, title, body, status_label, actor_user_id,
           category_id, subcategory_id, cost, next_visit_at, not_fixed_reason, work_done, photos, parts, meta
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id`,
        [
          t.id,
          eventType,
          body.updateType,
          body.workDone || body.updateType,
          body.closeTicket ? 'Closed' : 'Still open',
          req.user!.id,
          primaryFound?.categoryId || body.categoryId || null,
          primaryFound?.subcategoryId || body.subCategoryId || null,
          eventCost,
          body.nextVisitAt || null,
          body.notFixedReason || null,
          body.workDone || null,
          JSON.stringify(body.photos),
          JSON.stringify(snapshots),
          JSON.stringify(body.closeTicket ? { closedTicket: true } : {}),
        ],
      )
      const id = inserted.rows[0].id as string
      await insertEventParts(client, id, snapshots)

      const resolveCtx = { eventId: id, userId: req.user!.id }
      const resolved = await resolveIssueSelection(
        client,
        t.id,
        { issueIds: body.resolveIssueIds, categoryIds: body.resolveCategoryIds },
        resolveCtx,
      )
      if (body.closeTicket) {
        resolved.push(...(await resolveOpenTicketIssues(client, t.id, resolveCtx)))
      }

      await client.query(
        `UPDATE tickets SET
           status = $2,
           total_cost = total_cost + $3,
           closed_at = CASE WHEN $2 = 'Closed' THEN NOW() ELSE closed_at END,
           updated_at = NOW()
         WHERE id = $1`,
        [t.id, newStatus, eventCost],
      )

      return {
        eventId: id,
        addedIssues: added,
        resolvedIssues: resolved,
        openIssueCount: await countOpenTicketIssues(client, t.id),
      }
    })

    let saved: Awaited<ReturnType<typeof runUpdate>>
    try {
      saved = await runUpdate()
    } catch (err) {
      // A concurrent raise added the same Open issue first: the partial unique index
      // rolled this update back, so answer exactly like the pre-check would.
      if (isUniqueViolation(err) && newIssues.length) {
        await assertNoOpenIssueConflicts(
          { query },
          t.device_id,
          newIssues.map((i) => i.subcategoryId),
          t.id,
        )
      }
      throw err
    }
    const { eventId, addedIssues, resolvedIssues, openIssueCount } = saved

    return created(
      res,
      {
        id: t.public_id,
        eventId,
        status: newStatus,
        cost: eventCost,
        partsCost,
        labourCost: body.cost,
        parts: snapshots,
        resolvedReady: isResolved,
        closed: body.closeTicket,
        addedIssues: mapIssueApi(addedIssues),
        resolvedIssues: mapIssueApi(resolvedIssues),
        openIssueCount,
      },
      body.closeTicket ? 'Update saved and ticket closed' : 'Update saved',
    )
  } catch (error) {
    return handleApiError(res, error)
  }
})

const attachEventPhotosSchema = z.object({
  photos: z.array(z.string().min(1)).min(1),
})

/** Attach uploaded photo URLs after POST /tickets (raise) succeeds. */
router.patch(
  '/:ticketId/raised/:eventId/photos',
  authorize('Raise ticket', 'c'),
  async (req: AuthedRequest, res) => {
    try {
      const body = attachEventPhotosSchema.parse(req.body)
      const ticketId = String(req.params.ticketId || '').trim()
      const ticket = await query(
        `SELECT t.*, d.road_id FROM tickets t JOIN devices d ON d.id = t.device_id
         WHERE t.public_id = $1 OR t.id::text = $1`,
        [ticketId],
      )
      if (!ticket.rowCount) {
        throw new ApiError(404, 'No tickets available', 'NO_TICKETS_AVAILABLE')
      }
      const t = ticket.rows[0]
      if (t.status === 'Closed') throw new ApiError(409, 'Ticket is closed', 'CLOSED')

      const event = await query(
        `SELECT id, photos, event_type, actor_user_id FROM ticket_events WHERE id = $1 AND ticket_id = $2`,
        [req.params.eventId, t.id],
      )
      if (!event.rowCount) throw new ApiError(404, 'Raised event not found', 'NOT_FOUND')
      if (event.rows[0].event_type !== 'raised') {
        throw new ApiError(400, 'Event is not a raised event', 'VALIDATION_ERROR')
      }
      assertCanAttachEventPhotos(req, event.rows[0].actor_user_id)

      const existing = Array.isArray(event.rows[0].photos) ? event.rows[0].photos : []
      const photos = [...existing, ...body.photos]

      await query(`UPDATE ticket_events SET photos = $2::jsonb WHERE id = $1`, [
        req.params.eventId,
        JSON.stringify(photos),
      ])

      return ok(res, { eventId: req.params.eventId, photos }, 'Photos attached')
    } catch (error) {
      return handleApiError(res, error)
    }
  },
)

/** Attach uploaded photo URLs after POST /updates succeeds. */
router.patch(
  '/:ticketId/updates/:eventId/photos',
  authorize('Update ticket', 'e'),
  async (req: AuthedRequest, res) => {
    try {
      const body = attachEventPhotosSchema.parse(req.body)
      const ticketId = String(req.params.ticketId || '').trim()
      const ticket = await query(
        `SELECT t.*, d.road_id FROM tickets t JOIN devices d ON d.id = t.device_id
         WHERE t.public_id = $1 OR t.id::text = $1`,
        [ticketId],
      )
      if (!ticket.rowCount) {
        throw new ApiError(404, 'No tickets available', 'NO_TICKETS_AVAILABLE')
      }
      const t = ticket.rows[0]

      const event = await query(
        `SELECT id, photos, status_label, actor_user_id FROM ticket_events WHERE id = $1 AND ticket_id = $2`,
        [req.params.eventId, t.id],
      )
      if (!event.rowCount) throw new ApiError(404, 'Update not found', 'NOT_FOUND')
      assertCanAttachEventPhotos(req, event.rows[0].actor_user_id)
      // Photos upload after the update saves, so the author of a close-with-update
      // may still attach to that closing event once the ticket is Closed.
      const isOwnClosingEvent =
        event.rows[0].status_label === 'Closed' && event.rows[0].actor_user_id === req.user!.id
      if (t.status === 'Closed' && !isOwnClosingEvent) {
        throw new ApiError(409, 'Ticket is closed', 'CLOSED')
      }

      const existing = Array.isArray(event.rows[0].photos) ? event.rows[0].photos : []
      const photos = [...existing, ...body.photos]

      await query(`UPDATE ticket_events SET photos = $2::jsonb WHERE id = $1`, [
        req.params.eventId,
        JSON.stringify(photos),
      ])

      return ok(res, { eventId: req.params.eventId, photos }, 'Photos attached')
    } catch (error) {
      return handleApiError(res, error)
    }
  },
)

router.get('/:ticketId/close-preview', authorize('Update ticket', 'x'), async (req: AuthedRequest, res) => {
  try {
    const ticket = await query(
      `SELECT t.*, d.road_id FROM tickets t
       JOIN devices d ON d.id = t.device_id
       WHERE t.public_id = $1 OR t.id::text = $1`,
      [req.params.ticketId],
    )
    if (!ticket.rowCount) throw new ApiError(404, 'Ticket not found', 'NOT_FOUND')
    const events = await query(
      `SELECT created_at, work_done, title, cost FROM ticket_events
       WHERE ticket_id = $1 AND cost IS NOT NULL
       ORDER BY created_at`,
      [ticket.rows[0].id],
    )
    const rows = events.rows.map((e) => ({
      date: e.created_at,
      work: e.work_done || e.title,
      cost: Number(e.cost || 0),
    }))
    const total = rows.reduce((s, r) => s + r.cost, 0)
    return ok(res, { rows, total })
  } catch (error) {
    return handleApiError(res, error)
  }
})

const closeSchema = z
  .object({
    issues: z.array(issuePairSchema).min(1).optional(),
    categoryId: z.string().uuid().optional(),
    subCategoryId: z.string().uuid().optional(),
    workDone: z.string().min(1),
    parts: z.array(z.string().uuid()).default([]),
    photos: z.array(z.string()).default([]),
    /** Labour / non-part charges only — part prices come from Parts Master. */
    cost: z.coerce.number().nonnegative().default(0),
    deviceTested: z.string().min(1),
  })
  .superRefine((data, ctx) => {
    if (!normalizeIssueList(data).length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one issue is required (issues[] or categoryId + subCategoryId)',
        path: ['issues'],
      })
    }
  })

router.post('/:ticketId/close', authorize('Update ticket', 'x'), async (req: AuthedRequest, res) => {
  try {
    const body = closeSchema.parse(req.body)
    if (body.deviceTested.toLowerCase().includes('not tested')) {
      throw new ApiError(400, 'Device must be tested before closing', 'NOT_TESTED')
    }

    const closeIssues = await resolveIssuePairs(normalizeIssueList(body))
    const primaryClose = closeIssues[0]

    const ticket = await query(
      `SELECT t.*, d.road_id FROM tickets t JOIN devices d ON d.id = t.device_id
       WHERE t.public_id = $1 OR t.id::text = $1`,
      [req.params.ticketId],
    )
    if (!ticket.rowCount) throw new ApiError(404, 'Ticket not found', 'NOT_FOUND')
    const t = ticket.rows[0]
    if (t.status === 'Closed') throw new ApiError(409, 'Already closed', 'CLOSED')

    const { partsCost, snapshots } = await resolvePartsCost(body.parts)
    const eventCost = visitEventCost(body.cost, partsCost)

    await withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO ticket_events (
           ticket_id, event_type, title, body, status_label, actor_user_id,
           category_id, subcategory_id, cost, work_done, photos, parts, meta
         ) VALUES ($1,'closed','Ticket closed',$2,'Closed',$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [
          t.id,
          body.workDone,
          req.user!.id,
          primaryClose.categoryId,
          primaryClose.subcategoryId,
          eventCost,
          body.workDone,
          JSON.stringify(body.photos),
          JSON.stringify(snapshots),
          JSON.stringify({ deviceTested: body.deviceTested }),
        ],
      )
      const eventId = inserted.rows[0].id as string
      await insertEventParts(client, eventId, snapshots)
      await resolveOpenTicketIssues(client, t.id, { eventId, userId: req.user!.id })

      await client.query(
        `UPDATE tickets SET
           status = 'Closed',
           found_category_id = $2,
           found_subcategory_id = $3,
           closed_at = NOW(),
           total_cost = total_cost + $4,
           updated_at = NOW()
         WHERE id = $1`,
        [t.id, primaryClose.categoryId, primaryClose.subcategoryId, eventCost],
      )
      await replaceTicketIssues(client, t.id, 'found', closeIssues)
    })

    return ok(
      res,
      {
        id: t.public_id,
        status: 'Closed',
        cost: eventCost,
        partsCost,
        labourCost: body.cost,
        parts: snapshots,
        issuesFound: mapIssueApi(closeIssues),
      },
      'Ticket closed',
    )
  } catch (error) {
    return handleApiError(res, error)
  }
})

export default router
