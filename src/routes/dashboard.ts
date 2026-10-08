import { Router } from 'express'
import { z } from 'zod'
import { handleApiError } from '../lib/api-error.js'
import { ok } from '../lib/respond.js'
import { query } from '../db/pool.js'
import { authorize, requireAuth, type AuthedRequest } from '../middleware/auth.js'
import { deriveDeviceStatus, openTicketLateralSql } from '../lib/device-status.js'
import { deviceDisplayId } from '../lib/device-ref.js'

const router = Router()
router.use(requireAuth)

router.get('/', authorize('Dashboard', 'v'), async (req: AuthedRequest, res) => {
  try {
    const filters = z
      .object({
        road: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .parse(req.query)

    const params: unknown[] = []
    let roadFilter = ''
    if (filters.road && filters.road !== 'All roads') {
      params.push(filters.road)
      roadFilter = `AND r.name = $${params.length}`
    }

    // Every ticket on every road counts for every viewer (tickets have no holder).
    // One row per device: a device with several open tickets counts once, by its worst ticket.
    const devices = await query(
      `SELECT d.id, d.road_id, r.name AS road_name, r.stretch_from, r.stretch_to,
              ot.status AS open_status, ot.assignee_id, ot.severity
       FROM devices d
       JOIN roads r ON r.id = d.road_id
       ${openTicketLateralSql()}
       WHERE 1=1 ${roadFilter}`,
      params,
    )

    let working = 0
    let repair = 0
    let down = 0
    for (const d of devices.rows) {
      const status = deriveDeviceStatus({
        openTicketStatus: d.open_status,
        assigneeId: d.assignee_id,
        severity: d.severity,
      })
      if (status === 'Working') working++
      else if (status === 'Under repair') repair++
      else down++
    }
    const total = devices.rowCount || 0
    const pct = (n: number) => (total ? `${((n / total) * 100).toFixed(1)}%` : '0%')

    // Issue-level: each still-Open reported issue on an open ticket counts once, so a
    // partly resolved ticket only contributes the issues that keep the device down.
    const openIssueJoins = `
       FROM ticket_issues ti
       JOIN tickets t ON t.id = ti.ticket_id
       JOIN devices d ON d.id = t.device_id
       JOIN roads r ON r.id = d.road_id`
    const openIssueWhere = `
       WHERE ti.role = 'reported' AND ti.status = 'Open'
         AND t.status <> 'Closed' ${roadFilter}`
    const downReasons = await query(
      `SELECT s.name AS name, c.name AS category, COUNT(*)::int AS n
       ${openIssueJoins}
       JOIN issue_subcategories s ON s.id = ti.subcategory_id
       JOIN issue_categories c ON c.id = ti.category_id
       ${openIssueWhere}
       GROUP BY 1, 2
       ORDER BY n DESC
       LIMIT 10`,
      params,
    )
    const maxReason = downReasons.rows[0]?.n || 1
    const openIssueTotal = await query(
      `SELECT COUNT(*)::int AS n ${openIssueJoins} ${openIssueWhere}`,
      params,
    )

    const roadStatus = await query(
      `SELECT r.name, r.stretch_from, r.stretch_to,
              COUNT(d.id)::int AS total
       FROM roads r
       LEFT JOIN devices d ON d.road_id = r.id
       GROUP BY r.id
       ORDER BY r.code`,
    )

    const roadStats = []
    for (const road of roadStatus.rows) {
      const subset = devices.rows.filter((d) => d.road_name === road.name)
      let w = 0
      let rep = 0
      let dn = 0
      for (const d of subset) {
        const status = deriveDeviceStatus({
          openTicketStatus: d.open_status,
          assigneeId: d.assignee_id,
          severity: d.severity,
        })
        if (status === 'Working') w++
        else if (status === 'Under repair') rep++
        else dn++
      }
      roadStats.push({
        name: road.name,
        stretch: `${road.stretch_from} – ${road.stretch_to}`,
        total: road.total,
        working: w,
        repair: rep,
        down: dn,
      })
    }

    const openTickets = await query(
      `SELECT t.public_id AS id, d.public_id AS device_public_id, d.slot_id,
              r.name AS road, d.slot_number AS slot, COALESCE(rs.name, t.description) AS issue,
              rc.name AS "issueDetail", t.reporter_type AS "reportedBy",
              t.raised_at, t.status
       FROM tickets t
       JOIN devices d ON d.id = t.device_id
       JOIN roads r ON r.id = d.road_id
       LEFT JOIN issue_subcategories rs ON rs.id = COALESCE(t.found_subcategory_id, t.reported_subcategory_id)
       LEFT JOIN issue_categories rc ON rc.id = COALESCE(t.found_category_id, t.reported_category_id)
       WHERE t.status <> 'Closed' ${roadFilter}
       ORDER BY t.raised_at ASC
       LIMIT 8`,
      params,
    )

    const openOver3 = await query(
      `SELECT COUNT(*) FILTER (WHERE t.raised_at < NOW() - INTERVAL '3 days')::int AS n,
              COUNT(*)::int AS open_total
       FROM tickets t
       JOIN devices d ON d.id = t.device_id
       JOIN roads r ON r.id = d.road_id
       WHERE t.status <> 'Closed'
         ${roadFilter}`,
      params,
    )

    const stamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })

    return ok(res, {
      crumb: `Fleet status as on ${stamp}`,
      fleet: {
        total: total.toLocaleString('en-IN'),
        caption: `devices · ${pct(working)} currently operational`,
        stamp: 'Live device status',
        bar: [
          { className: 'seg-ok', width: pct(working) },
          { className: 'seg-warn', width: pct(repair) },
          { className: 'seg-bad', width: pct(down) },
        ],
        legend: [
          { value: String(working), label: 'Working', to: '/devices' },
          { value: String(repair), label: 'Under repair', to: '/tickets' },
          { value: String(down), label: 'Not working', to: '/tickets' },
          { value: String(openOver3.rows[0].n), label: 'Open more than 3 days', to: '/tickets' },
        ],
      },
      downReasons: downReasons.rows.map((r) => ({
        name: r.name,
        category: r.category,
        n: r.n,
        width: `${Math.round((r.n / maxReason) * 100)}%`,
        hot: r.n === maxReason,
      })),
      openIssues: openIssueTotal.rows[0]?.n ?? 0,
      openTicketsCount: openOver3.rows[0]?.open_total ?? 0,
      roadStatus: roadStats,
      openTickets: openTickets.rows.map((t) => {
        const daysOpen = Math.floor(
          (Date.now() - new Date(t.raised_at).getTime()) / 86400000,
        )
        return {
          id: t.id,
          deviceId: deviceDisplayId({
            slot_id: t.slot_id,
            public_id: t.device_public_id,
          }),
          slotId: t.slot_id != null && t.slot_id !== '' ? Number(t.slot_id) : null,
          road: t.road,
          slot: `Slot ${t.slot}`,
          issue: t.issue,
          issueDetail: t.issueDetail,
          reportedBy: t.reportedBy,
          raisedOn: t.raised_at,
          daysOpen,
          daysBad: daysOpen > 3,
          status: t.status,
          statusTone:
            t.status === 'Under repair' || t.status === 'Waiting for spare' ? 'warn' : 'bad',
        }
      }),
    })
  } catch (error) {
    return handleApiError(res, error)
  }
})

export default router
