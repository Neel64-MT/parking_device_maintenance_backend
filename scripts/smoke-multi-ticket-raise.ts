/**
 * Issue-level duplicate tickets smoke (Phase 50) — one device may hold several open
 * tickets for different issues; the same Open issue never opens a second ticket; a
 * Closed ticket never blocks or gets reopened; device / dashboard / road counts treat
 * a device with several open tickets as one device.
 * Requires migrations applied (025_open_issue_per_device). Never prints tokens or passwords.
 * Run: npm run test:smoke:multi-ticket
 */
import 'dotenv/config'

import { createApp } from '../src/app.js'
import { closeDb, query } from '../src/db/pool.js'

const app = createApp()
const server = app.listen(0)
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`

type Auth = Record<string, string>
type Session = { auth: Auth; id: string }
type Pair = { categoryId: string; subCategoryId: string; severity: string }
type ApiIssue = { id?: string; status?: string; categoryId: string; subCategoryId: string }
type ScanTicket = { id: string; status: string; issues: Array<{ id: string; subCategoryId: string }> }

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

function post(path: string, auth: Auth, payload: unknown) {
  return call(path, { method: 'POST', headers: auth, body: JSON.stringify(payload) })
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

function brief(res: { status: number; body: unknown }) {
  return `${res.status} ${JSON.stringify(res.body).slice(0, 240)}`
}

const createdUserIds: string[] = []
const touchedTickets: string[] = []

async function deleteSmokeUsers(ids: string[]) {
  const list = ids.filter(Boolean)
  if (!list.length) return
  await query(`UPDATE tickets SET raised_by_user_id = NULL WHERE raised_by_user_id = ANY($1::uuid[])`, [list])
  await query(`UPDATE tickets SET assignee_id = NULL WHERE assignee_id = ANY($1::uuid[])`, [list])
  await query(`UPDATE ticket_events SET actor_user_id = NULL WHERE actor_user_id = ANY($1::uuid[])`, [list])
  await query(`UPDATE ticket_assignments SET from_user_id = NULL WHERE from_user_id = ANY($1::uuid[])`, [list])
  await query(`UPDATE ticket_assignments SET to_user_id = NULL WHERE to_user_id = ANY($1::uuid[])`, [list])
  await query(
    `UPDATE device_sync_runs SET triggered_by_user_id = NULL WHERE triggered_by_user_id = ANY($1::uuid[])`,
    [list],
  )
  await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [list])
}

async function login(identifier: string, password: string): Promise<Session> {
  const res = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier, password }),
  })
  assert(res.status === 200 && res.body.data?.token, `login failed for ${identifier}`)
  const auth = { Authorization: `Bearer ${res.body.data.token as string}` }
  const me = await call('/api/auth/me', { headers: auth })
  assert(me.status === 200 && me.body.data?.id, `me failed for ${identifier}`)
  return { auth, id: me.body.data.id as string }
}

async function createUser(adminAuth: Auth, roleName: string): Promise<Session> {
  const roles = await call('/api/roles', { headers: adminAuth })
  const roleId = (roles.body.data as Array<{ id: string; name: string }>).find((r) => r.name === roleName)?.id
  assert(roleId, `${roleName} role not found — run npm run db:migrate`)
  const suffix = String(Date.now()).slice(-7) + Math.floor(Math.random() * 900 + 100)
  const mobile = `95${suffix}`.slice(0, 10)
  const res = await post('/api/users', adminAuth, {
    fullName: `Smoke Multi ${roleName} ${suffix}`,
    mobile,
    email: `smoke.multi.${suffix}@yopmail.com`,
    password: 'SmokePass1',
    roleId,
    roadIds: [],
  })
  assert(res.status === 201 && res.body.data?.id, `create ${roleName} failed: ${brief(res)}`)
  createdUserIds.push(res.body.data.id as string)
  return login(mobile, 'SmokePass1')
}

async function main() {
  const admin = await login('9000000001', 'Password123')

  const roads = await call('/api/roads', { headers: admin.auth })
  const road = roads.body.data[0] as { id: string; name: string }
  const cats = await call('/api/lookups/issue-categories', { headers: admin.auth })
  const allPairs: Pair[] = (
    cats.body.data as Array<{ id: string; subs: Array<{ id: string; severity: string }> }>
  ).flatMap((c) => c.subs.map((s) => ({ categoryId: c.id, subCategoryId: s.id, severity: s.severity })))
  // Non-Minor issues first so a new Open ticket marks the device Not working.
  const pairs = [...allPairs.filter((p) => p.severity !== 'Minor'), ...allPairs.filter((p) => p.severity === 'Minor')]
  assert(pairs.length >= 4, 'need at least 4 active issue sub-categories')
  const [motor, sensor, power, display] = pairs
  const pick = (p: Pair) => ({ categoryId: p.categoryId, subCategoryId: p.subCategoryId })

  let deviceSeq = 0
  async function newDevice() {
    deviceSeq += 1
    const res = await post('/api/devices', admin.auth, {
      roadId: road.id,
      slotNumber: `MULTI-${Date.now()}-${deviceSeq}`,
      installedOn: '2026-09-01',
    })
    assert(res.status === 201, `device create failed: ${brief(res)}`)
    return res.body.data.publicId as string
  }

  const raiseRaw = (session: Session, deviceId: string, issues: Pair[], extra: Record<string, unknown> = {}) =>
    post('/api/tickets', session.auth, {
      deviceId,
      issues: issues.map(pick),
      reporterType: 'Control room',
      ...extra,
    })

  async function raise(session: Session, deviceId: string, issues: Pair[], extra: Record<string, unknown> = {}) {
    const res = await raiseRaw(session, deviceId, issues, extra)
    assert(res.status === 201, `raise failed: ${brief(res)}`)
    touchedTickets.push(res.body.data.id as string)
    return { id: res.body.data.id as string, uuid: res.body.data.uuid as string }
  }

  const update = (session: Session, ticketId: string, payload: Record<string, unknown> = {}) =>
    post(`/api/tickets/${ticketId}/updates`, session.auth, {
      updateType: 'Site visit — not resolved',
      workDone: 'Smoke multi-ticket update',
      ...payload,
    })

  async function reported(session: Session, ticketId: string): Promise<ApiIssue[]> {
    const res = await call(`/api/tickets/${ticketId}`, { headers: session.auth })
    assert(res.status === 200, `detail failed: ${brief(res)}`)
    return res.body.data.issuesReported as ApiIssue[]
  }
  const idFor = (issues: ApiIssue[], pair: Pair) =>
    issues.find((i) => i.subCategoryId === pair.subCategoryId)?.id as string

  async function deviceTicketCount(deviceId: string) {
    const r = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM tickets t JOIN devices d ON d.id = t.device_id WHERE d.public_id = $1`,
      [deviceId],
    )
    return r.rows[0].n
  }
  async function raisedNotifications(ticketUuid: string) {
    const r = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE related_entity_id = $1 AND type = 'ticket.raised'`,
      [ticketUuid],
    )
    return r.rows[0].n
  }
  async function deviceRaisedNotifications(deviceId: string) {
    const r = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM notifications n
       JOIN tickets t ON t.id::text = n.related_entity_id::text
       JOIN devices d ON d.id = t.device_id
       WHERE d.public_id = $1 AND n.type = 'ticket.raised'`,
      [deviceId],
    )
    return r.rows[0].n
  }
  async function eventCount(ticketUuid: string) {
    const r = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ticket_events WHERE ticket_id = $1`, [ticketUuid])
    return r.rows[0].n
  }

  const tech = await createUser(admin.auth, 'Technician')
  const tech2 = await createUser(admin.auth, 'Technician')

  // --- 1: different issue on an open device → new ticket ----------------------
  const devD = await newDevice()
  const tk1 = await raise(admin, devD, [motor])
  const tk1Events = await eventCount(tk1.uuid)
  const tk1Issues = await reported(admin, tk1.id)
  const tk2 = await raise(admin, devD, [sensor])
  assert(tk2.id !== tk1.id, '1: different issue must open a new ticket')
  assert((await eventCount(tk1.uuid)) === tk1Events, '1: TK1 must get no new event')
  const tk1After = await reported(admin, tk1.id)
  assert(
    JSON.stringify(tk1After.map((i) => [i.subCategoryId, i.status])) ===
      JSON.stringify(tk1Issues.map((i) => [i.subCategoryId, i.status])),
    '1: TK1 issues must be unchanged',
  )
  console.log('OK 1 — a different issue on a device with an open ticket creates a new ticket')

  // --- 2: same Open issue → 409 with the existing ticket ----------------------
  const ticketsBefore2 = await deviceTicketCount(devD)
  const notesBefore2 = await deviceRaisedNotifications(devD)
  const dup = await raiseRaw(admin, devD, [motor])
  assert(dup.status === 409 && dup.body.code === 'OPEN_TICKET_EXISTS', `2: must be 409, got ${brief(dup)}`)
  assert(dup.body.details?.openTicketId === tk1.id && dup.body.details?.ticketId === tk1.id, '2: must point at TK1')
  assert(
    (dup.body.details?.issues as ApiIssue[]).some((i) => i.subCategoryId === motor.subCategoryId),
    '2: details.issues must list the duplicate issue',
  )
  assert((await deviceTicketCount(devD)) === ticketsBefore2, '2: no ticket may be created')
  assert((await deviceRaisedNotifications(devD)) === notesBefore2, '2: no notification may be created')
  console.log('OK 2 — the same Open issue is rejected with 409 OPEN_TICKET_EXISTS → TK1')

  // --- 3: mixed selection is rejected whole -----------------------------------
  const mixed = await raiseRaw(admin, devD, [motor, power])
  assert(mixed.status === 409 && mixed.body.code === 'OPEN_TICKET_EXISTS', `3: mixed must be 409, got ${brief(mixed)}`)
  assert((await deviceTicketCount(devD)) === ticketsBefore2, '3: nothing may be created on a mixed raise')
  console.log('OK 3 — a mixed raise (one new, one duplicate) creates nothing')

  // --- 4: several users resolve different issues of the same ticket -----------
  const devE = await newDevice()
  const tk3 = await raise(admin, devE, [motor, sensor, power])
  const tk3Issues = await reported(tech, tk3.id)
  const r4a = await update(tech, tk3.id, { resolveIssueIds: [idFor(tk3Issues, motor), idFor(tk3Issues, sensor)] })
  assert(r4a.status === 201 && r4a.body.data.openIssueCount === 1, `4: holder resolve failed: ${brief(r4a)}`)
  const scan4 = await call(`/api/devices/scan?q=${encodeURIComponent(devE)}`, { headers: tech.auth })
  const scan4Tickets = scan4.body.data?.openTickets as ScanTicket[]
  assert(
    scan4Tickets?.length === 1 &&
      scan4Tickets[0].id === tk3.id &&
      scan4Tickets[0].issues.length === 1 &&
      scan4Tickets[0].issues[0].subCategoryId === power.subCategoryId,
    `4: scan must show TK3 with only the remaining issue: ${brief(scan4)}`,
  )
  const ticketsBefore4 = await deviceTicketCount(devE)
  const r4b = await update(tech2, tk3.id, { resolveIssueIds: [idFor(tk3Issues, power)] })
  assert(r4b.status === 201 && r4b.body.data.openIssueCount === 0, `4: User B (another technician) resolve failed: ${brief(r4b)}`)
  assert((await deviceTicketCount(devE)) === ticketsBefore4, '4: an update must never create a ticket')
  console.log('OK 4 — User A and User B resolve different issues on the same ticket; no new ticket')

  // --- 5: closed ticket never blocks or reopens --------------------------------
  const tk3Detail = await call(`/api/tickets/${tk3.id}`, { headers: admin.auth })
  assert(tk3Detail.body.data?.header?.status !== 'Closed', '5: all issues resolved must not auto-close')
  const close5 = await update(tech, tk3.id, { closeTicket: true, workDone: 'Done' })
  assert(close5.status === 201 && close5.body.data.status === 'Closed', `5: close failed: ${brief(close5)}`)
  const snap = async () =>
    (
      await query<{ status: string; closed_at: string; events: number; issues: string }>(
        `SELECT t.status, t.closed_at::text,
                (SELECT COUNT(*)::int FROM ticket_events e WHERE e.ticket_id = t.id) AS events,
                (SELECT string_agg(ti.subcategory_id::text || ':' || ti.status, ',' ORDER BY ti.sort_order)
                   FROM ticket_issues ti WHERE ti.ticket_id = t.id) AS issues
         FROM tickets t WHERE t.id = $1`,
        [tk3.uuid],
      )
    ).rows[0]
  const closedBefore = await snap()
  const tk4 = await raise(admin, devE, [motor])
  assert(tk4.id !== tk3.id, '5: a raise after close must create a new ticket')
  const closedAfter = await snap()
  assert(JSON.stringify(closedAfter) === JSON.stringify(closedBefore), '5: the closed ticket must be untouched')
  console.log('OK 5 — raising the same issue after close creates a new ticket; the closed one is untouched')

  // --- 6: issue resolved on a still-open ticket → new ticket -------------------
  const devF = await newDevice()
  const tk5 = await raise(admin, devF, [motor, sensor])
  const tk5Issues = await reported(tech, tk5.id)
  const r6 = await update(tech, tk5.id, { resolveIssueIds: [idFor(tk5Issues, motor)] })
  assert(r6.status === 201, `6: resolve failed: ${brief(r6)}`)
  const tk6 = await raise(admin, devF, [motor])
  assert(tk6.id !== tk5.id, '6: a resolved issue on an open ticket must not block a new raise')
  console.log('OK 6 — an issue resolved on a still-open ticket can be raised again as a new ticket')

  // --- 7: concurrency ----------------------------------------------------------
  const devG = await newDevice()
  const race = await Promise.all([raiseRaw(admin, devG, [display]), raiseRaw(admin, devG, [display])])
  const raceWins = race.filter((r) => r.status === 201)
  const raceLoss = race.filter((r) => r.status !== 201)
  raceWins.forEach((r) => touchedTickets.push(r.body.data.id as string))
  assert(raceWins.length === 1, `7: exactly one same-issue raise may win: ${brief(race[0])} / ${brief(race[1])}`)
  assert(
    raceLoss[0].status === 409 &&
      raceLoss[0].body.code === 'OPEN_TICKET_EXISTS' &&
      raceLoss[0].body.details?.openTicketId === raceWins[0].body.data.id,
    `7: loser must be 409 pointing at the winner: ${brief(raceLoss[0])}`,
  )
  assert((await deviceTicketCount(devG)) === 1, '7: exactly one ticket may exist')
  const devH = await newDevice()
  const pair = await Promise.all([raiseRaw(admin, devH, [motor]), raiseRaw(admin, devH, [sensor])])
  pair.forEach((r) => r.status === 201 && touchedTickets.push(r.body.data.id as string))
  assert(pair.every((r) => r.status === 201), `7: different-issue raises must both win: ${brief(pair[0])} / ${brief(pair[1])}`)
  console.log('OK 7 — concurrent same-issue raises: one wins; different issues: both win')

  // --- 8: scan lists every open ticket with only its Open issues ---------------
  const scan8 = await call(`/api/devices/scan?q=${encodeURIComponent(devF)}`, { headers: admin.auth })
  const scan8Tickets = scan8.body.data?.openTickets as ScanTicket[]
  assert(scan8.status === 200 && scan8.body.data?.openTicketId, `8: scan must keep openTicketId: ${brief(scan8)}`)
  assert(scan8Tickets?.length === 2, `8: scan must list both open tickets: ${brief(scan8)}`)
  const s8tk5 = scan8Tickets.find((t) => t.id === tk5.id)
  const s8tk6 = scan8Tickets.find((t) => t.id === tk6.id)
  assert(
    s8tk5?.issues.length === 1 && s8tk5.issues[0].subCategoryId === sensor.subCategoryId,
    '8: TK5 must show only its Open issue',
  )
  assert(s8tk6?.issues.length === 1 && s8tk6.issues[0].subCategoryId === motor.subCategoryId, '8: TK6 must show Motor')
  console.log('OK 8 — scan openTickets lists each open ticket with only its Open issues')

  // --- 9: device / dashboard / road counts -------------------------------------
  const dash = async () => {
    const res = await call(`/api/dashboard?road=${encodeURIComponent(road.name)}`, { headers: admin.auth })
    assert(res.status === 200, `9: dashboard failed: ${brief(res)}`)
    return res.body.data as {
      fleet: { total: string; legend: Array<{ value: string; label: string }> }
      openIssues: number
      openTicketsCount: number
    }
  }
  const legend = (d: Awaited<ReturnType<typeof dash>>, label: string) =>
    Number(d.fleet.legend.find((l) => l.label === label)?.value || 0)
  const roadDown = async () => {
    const res = await call('/api/roads', { headers: admin.auth })
    return Number((res.body.data as Array<{ id: string; down: number }>).find((r) => r.id === road.id)?.down || 0)
  }
  const devI = await newDevice()
  const dashBefore = await dash()
  const downBefore = await roadDown()
  await raise(admin, devI, [motor])
  await raise(admin, devI, [sensor])
  const dashAfter = await dash()
  const downAfter = await roadDown()
  const totalAfter = Number(dashAfter.fleet.total.replace(/,/g, ''))
  assert(
    legend(dashAfter, 'Working') + legend(dashAfter, 'Under repair') + legend(dashAfter, 'Not working') === totalAfter,
    '9: every device must be counted exactly once in the fleet',
  )
  assert(
    Number(dashAfter.fleet.total.replace(/,/g, '')) === Number(dashBefore.fleet.total.replace(/,/g, '')),
    '9: open tickets must not change the device total',
  )
  assert(dashAfter.openTicketsCount === dashBefore.openTicketsCount + 2, '9: openTicketsCount must rise by 2')
  assert(dashAfter.openIssues === dashBefore.openIssues + 2, '9: openIssues must include both issues')
  assert(downAfter === downBefore + 1, `9: road down must count the device once (${downBefore} → ${downAfter})`)
  const list = await call(`/api/devices?q=${encodeURIComponent(devI)}`, { headers: admin.auth })
  const row = (list.body.data as Array<{ publicId: string; status: string; openTicketCount: number }>).find(
    (r) => r.publicId === devI,
  )
  const expected = motor.severity === 'Minor' ? 'Under repair' : 'Not working'
  assert(row?.status === expected, `9: device list must show the worst status ${expected}, got ${row?.status}`)
  assert(row?.openTicketCount === 2, '9: device list must report both open tickets')
  console.log('OK 9 — a device with two open tickets counts once; status is the worst ticket')

  // --- 10: notifications -------------------------------------------------------
  const devJ = await newDevice()
  const tk7 = await raise(admin, devJ, [motor])
  const tk8 = await raise(admin, devJ, [sensor])
  assert((await raisedNotifications(tk8.uuid)) > 0, '10: a new ticket beside an open one must notify')
  const tk7Notes = await raisedNotifications(tk7.uuid)
  const devJNotes = await deviceRaisedNotifications(devJ)
  const u10 = await update(tech, tk7.id, { workDone: 'No new ticket from an update' })
  assert(u10.status === 201, `10: update failed: ${brief(u10)}`)
  const d10 = await raiseRaw(admin, devJ, [motor])
  assert(d10.status === 409, '10: duplicate raise must be 409')
  assert((await raisedNotifications(tk7.uuid)) === tk7Notes, '10: an update must not send a new-ticket notification')
  assert((await deviceRaisedNotifications(devJ)) === devJNotes, '10: a 409 raise must not notify')
  console.log('OK 10 — new tickets notify; updates and rejected raises do not')

  // --- 11: validation ----------------------------------------------------------
  const unknownDevice = await raiseRaw(admin, `NO-SUCH-${Date.now()}`, [motor])
  assert(unknownDevice.status === 404, `11: unknown device must be 404, got ${brief(unknownDevice)}`)
  const badIssue = await post('/api/tickets', admin.auth, {
    deviceId: devJ,
    issues: [{ categoryId: motor.categoryId, subCategoryId: '00000000-0000-4000-8000-000000000000' }],
    reporterType: 'Control room',
  })
  assert(badIssue.status === 400 && badIssue.body.code === 'INVALID_ISSUES', `11: invalid issue must be 400, got ${brief(badIssue)}`)
  const inactive = await query<{ id: string; category_id: string }>(
    `SELECT id, category_id FROM issue_subcategories WHERE active = FALSE LIMIT 1`,
  )
  if (inactive.rowCount) {
    const inactiveRes = await post('/api/tickets', admin.auth, {
      deviceId: devJ,
      issues: [{ categoryId: inactive.rows[0].category_id, subCategoryId: inactive.rows[0].id }],
      reporterType: 'Control room',
    })
    assert(
      inactiveRes.status === 400 && inactiveRes.body.code === 'INVALID_ISSUES',
      `11: inactive issue must be 400, got ${brief(inactiveRes)}`,
    )
  }
  console.log('OK 11 — unknown device 404; invalid / inactive issue 400 INVALID_ISSUES')

  // --- 12: migration -----------------------------------------------------------
  const idx = await query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE indexname IN ('idx_tickets_one_open_per_device', 'idx_ticket_issues_one_open_issue_per_device')`,
  )
  const names = idx.rows.map((r) => r.indexname)
  assert(!names.includes('idx_tickets_one_open_per_device'), '12: the one-open-ticket-per-device index must be gone')
  assert(names.includes('idx_ticket_issues_one_open_issue_per_device'), '12: the open-issue-per-device index must exist')
  const missingDevice = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ticket_issues WHERE device_id IS NULL`)
  assert(missingDevice.rows[0].n === 0, '12: every ticket_issues row must carry device_id')
  console.log('OK 12 — migration 025 swapped the device index for the open-issue index')

  console.log('\nMulti-ticket raise verification passed')
}

async function cleanup() {
  if (touchedTickets.length) {
    await query(
      `UPDATE tickets SET status = 'Closed', closed_at = NOW(), updated_at = NOW()
       WHERE public_id = ANY($1::text[]) AND status <> 'Closed'`,
      [touchedTickets],
    ).catch(() => {})
    await query(
      `UPDATE ticket_issues ti SET status = 'Resolved', resolved_at = NOW()
       FROM tickets t
       WHERE t.id = ti.ticket_id AND t.public_id = ANY($1::text[]) AND ti.status = 'Open'`,
      [touchedTickets],
    ).catch(() => {})
  }
  await deleteSmokeUsers(createdUserIds).catch(() => {})
}

main()
  .then(async () => {
    await cleanup()
    server.close()
    await closeDb()
    process.exit(0)
  })
  .catch(async (err) => {
    console.error(err)
    await cleanup()
    server.close()
    await closeDb()
    process.exit(1)
  })
