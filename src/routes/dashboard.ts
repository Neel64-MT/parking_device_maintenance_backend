import { Router } from 'express'
import { z } from 'zod'
import { handleApiError } from '../lib/api-error.js'
import { ok } from '../lib/respond.js'
import { query } from '../db/pool.js'
import { authorize, requireAuth, type AuthedRequest } from '../middleware/auth.js'
import { deriveDeviceStatus } from '../lib/device-status.js'
import { appendTicketVisibilitySql } from '../lib/ticket-access.js'

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

    const visibility = appendTicketVisibilitySql(req.user!, params)
    const visFilter = visibility ? `AND ${visibility}` : ''

    const devices = await query(
      `SELECT d.id, d.road_id, r.name AS road_name, r.stretch_from, r.stretch_to,
              ot.status AS open_status, ot.assignee_id,
              COALESCE(fs.severity, rs.severity) AS severity
       FROM devices d
       JOIN roads r ON r.id = d.road_id
       LEFT JOIN LATERAL (
         SELECT * FROM tickets t WHERE t.device_id = d.id AND t.status <> 'Closed'
         ${visFilter}
         ORDER BY t.raised_at DESC LIMIT 1
       ) ot ON TRUE
       LEFT JOIN issue_subcategories fs ON fs.id = ot.found_subcategory_id
       LEFT JOIN issue_subcategories rs ON rs.id = ot.reported_subcategory_id
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

    const downReasons = await query(
      `SELECT COALESCE(fs.name, rs.name) AS name,
              COALESCE(fc.name, rc.name) AS category,
              COUNT(*)::int AS n
       FROM tickets t
       JOIN devices d ON d.id = t.device_id
       JOIN roads r ON r.id = d.road_id
       LEFT JOIN issue_subcategories fs ON fs.id = t.found_subcategory_id
       LEFT JOIN issue_categories fc ON fc.id = t.found_category_id
       LEFT JOIN issue_subcategories rs ON rs.id = t.reported_subcategory_id
       LEFT JOIN issue_categories rc ON rc.id = t.reported_category_id
       WHERE t.status <> 'Closed' ${roadFilter} ${visFilter}
       GROUP BY 1, 2
       ORDER BY n DESC
       LIMIT 10`,
      params,
    )
    const maxReason = downReasons.rows[0]?.n || 1

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
      `SELECT t.public_id AS id, d.public_id AS "deviceId", r.name AS road,
              d.slot_number AS slot, COALESCE(rs.name, t.description) AS issue,
              rc.name AS "issueDetail", t.reporter_type AS "reportedBy",
              t.raised_at, t.status, au.full_name
       FROM tickets t
       JOIN devices d ON d.id = t.device_id
       JOIN roads r ON r.id = d.road_id
       LEFT JOIN users au ON au.id = t.assignee_id
       LEFT JOIN issue_subcategories rs ON rs.id = COALESCE(t.found_subcategory_id, t.reported_subcategory_id)
       LEFT JOIN issue_categories rc ON rc.id = COALESCE(t.found_category_id, t.reported_category_id)
       WHERE t.status <> 'Closed' ${roadFilter} ${visFilter}
       ORDER BY t.raised_at ASC
       LIMIT 8`,
      params,
    )

    const openOver3 = await query(
      `SELECT COUNT(*)::int AS n FROM tickets t
       JOIN devices d ON d.id = t.device_id
       JOIN roads r ON r.id = d.road_id
       WHERE t.status <> 'Closed' AND t.raised_at < NOW() - INTERVAL '3 days'
         ${roadFilter} ${visFilter}`,
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
      roadStatus: roadStats,
      openTickets: openTickets.rows.map((t) => {
        const daysOpen = Math.floor(
          (Date.now() - new Date(t.raised_at).getTime()) / 86400000,
        )
        return {
          id: t.id,
          deviceId: t.deviceId,
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
