/**
 * Per-issue Open/Resolved smoke — resolve reported issues through Add Update
 * (field / Admin / Control room / PM / QR), backend validation, close resolving the
 * rest, dashboard counts and concurrent resolution.
 * Requires migrations applied (024_ticket_issue_status). Never prints tokens or passwords.
 * Run: npm run test:smoke:issue-resolution
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
type ApiIssue = { id?: string; status?: string; categoryId: string; subCategoryId: string }

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
let restoreControlRoomPerm: (() => Promise<void>) | null = null

async function deleteSmokeUsers(ids: string[]) {
  const list = ids.filter(Boolean)
  if (!list.length) return
  await query(`UPDATE tickets SET raised_by_user_id = NULL WHERE raised_by_user_id = ANY($1::uuid[])`, [list])
  await query(`UPDATE ticket_events SET actor_user_id = NULL WHERE actor_user_id = ANY($1::uuid[])`, [list])
  await query(`UPDATE ticket_issues SET resolved_by_user_id = NULL WHERE resolved_by_user_id = ANY($1::uuid[])`, [list])
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

async function roleId(adminAuth: Auth, roleName: string) {
  const roles = await call('/api/roles', { headers: adminAuth })
  const id = (roles.body.data as Array<{ id: string; name: string }>).find((r) => r.name === roleName)?.id
  assert(id, `${roleName} role not found — run npm run db:migrate`)
  return id as string
}

async function createUser(adminAuth: Auth, roleName: string): Promise<Session> {
  const suffix = String(Date.now()).slice(-7) + Math.floor(Math.random() * 900 + 100)
  const mobile = `94${suffix}`.slice(0, 10)
  const res = await post('/api/users', adminAuth, {
    fullName: `Smoke Issue ${roleName} ${suffix}`,
    mobile,
    email: `smoke.issue.${suffix}@yopmail.com`,
    password: 'SmokePass1',
    roleId: await roleId(adminAuth, roleName),
    roadIds: [],
  })
  assert(res.status === 201 && res.body.data?.id, `create ${roleName} failed: ${brief(res)}`)
  createdUserIds.push(res.body.data.id as string)
  return login(mobile, 'SmokePass1')
}

async function main() {
  const admin = await login('9000000001', 'Password123')

  const roads = await call('/api/roads', { headers: admin.auth })
  const roadId = roads.body.data[0].id as string
  const cats = await call('/api/lookups/issue-categories', { headers: admin.auth })
  const pairs = (cats.body.data as Array<{ id: string; subs: Array<{ id: string }> }>)
    .flatMap((c) => c.subs.map((s) => ({ categoryId: c.id, subCategoryId: s.id })))
  assert(pairs.length >= 3, 'need at least 3 active issue sub-categories')
  const [issueA, issueB, issueC] = pairs

  let deviceSeq = 0
  async function newDevice() {
    deviceSeq += 1
    const res = await post('/api/devices', admin.auth, {
      roadId,
      slotNumber: `ISSUE-${Date.now()}-${deviceSeq}`,
      installedOn: '2026-09-01',
    })
    assert(res.status === 201, `device create failed: ${brief(res)}`)
    return res.body.data.publicId as string
  }

  async function raise(session: Session, issues = [issueA, issueB, issueC], extra: Record<string, unknown> = {}) {
    const deviceId = await newDevice()
    const res = await post('/api/tickets', session.auth, {
      deviceId,
      issues,
      reporterType: 'Control room',
      ...extra,
    })
    assert(res.status === 201, `raise failed: ${brief(res)}`)
    touchedTickets.push(res.body.data.id as string)
    return { id: res.body.data.id as string, uuid: res.body.data.uuid as string, deviceId }
  }

  const update = (session: Session, ticketId: string, payload: Record<string, unknown> = {}) =>
    post(`/api/tickets/${ticketId}/updates`, session.auth, {
      updateType: 'Site visit — not resolved',
      workDone: 'Smoke issue update',
      ...payload,
    })

  async function reported(session: Session, ticketId: string): Promise<ApiIssue[]> {
    const res = await call(`/api/tickets/${ticketId}`, { headers: session.auth })
    assert(res.status === 200, `detail failed: ${brief(res)}`)
    return res.body.data.issuesReported as ApiIssue[]
  }
  const idFor = (issues: ApiIssue[], pair: { subCategoryId: string }) =>
    issues.find((i) => i.subCategoryId === pair.subCategoryId)?.id as string
  const openSubs = (issues: ApiIssue[]) =>
    issues.filter((i) => i.status === 'Open').map((i) => i.subCategoryId).sort()

  const tech = await createUser(admin.auth, 'Technician')
  const tech2 = await createUser(admin.auth, 'Technician')
  const pm = await createUser(admin.auth, 'Project manager')
  const control = await createUser(admin.auth, 'Control room')
  const attendant = await createUser(admin.auth, 'Site attendant')

  // --- A: 3-issue ticket starts with every issue Open -------------------------
  const t1 = await raise(admin)
  const a = await reported(tech, t1.id)
  assert(a.length === 3 && a.every((i) => i.id && i.status === 'Open'), `A: all 3 issues must be Open: ${JSON.stringify(a)}`)
  const [idA, idB, idC] = [idFor(a, issueA), idFor(a, issueB), idFor(a, issueC)]
  console.log('OK A — ticket with 3 issues has all 3 Open')

  // --- B: resolve A only -------------------------------------------------------
  const b = await update(tech, t1.id, { resolveIssueIds: [idA], workDone: 'Replaced motor' })
  assert(b.status === 201, `B: resolve A failed: ${brief(b)}`)
  assert(b.body.data.resolvedIssues?.length === 1 && b.body.data.resolvedIssues[0].id === idA, 'B: response must list A')
  assert(b.body.data.openIssueCount === 2, 'B: two issues must remain Open')
  const afterB = await reported(tech, t1.id)
  assert(afterB.find((i) => i.id === idA)?.status === 'Resolved', 'B: A must be Resolved')
  assert(openSubs(afterB).join() === [issueB.subCategoryId, issueC.subCategoryId].sort().join(), 'B: B and C stay Open')
  console.log('OK B — resolving A leaves B and C Open')

  // --- C: the next Add Update only offers B and C (trail shows A on the event) ---
  const detailC = await call(`/api/tickets/${t1.id}`, { headers: tech.auth })
  const openC = (detailC.body.data.issuesReported as ApiIssue[]).filter((i) => i.status === 'Open').map((i) => i.id)
  assert(openC.length === 2 && !openC.includes(idA), 'C: only B and C may be resolvable')
  const trailEvent = (detailC.body.data.workHistory as Array<{ resolvedIssues: ApiIssue[]; workDone: string | null }>)
    .find((e) => e.workDone === 'Replaced motor')
  assert(trailEvent?.resolvedIssues?.length === 1 && trailEvent.resolvedIssues[0].id === idA, 'C: trail must show A on its update')
  console.log('OK C — only Open issues remain resolvable; the update trail records A')

  // --- D: resolving A again is rejected ---------------------------------------
  const d = await update(tech, t1.id, { resolveIssueIds: [idA] })
  assert(d.status === 409 && d.body.code === 'ISSUE_ALREADY_RESOLVED', `D: must be 409, got ${brief(d)}`)
  console.log('OK D — backend rejects an already-resolved issue')

  // --- E: resolve B ------------------------------------------------------------
  const e = await update(tech, t1.id, { resolveIssueIds: [idB] })
  assert(e.status === 201 && e.body.data.openIssueCount === 1, `E: resolve B failed: ${brief(e)}`)
  assert(openSubs(await reported(tech, t1.id)).join() === issueC.subCategoryId, 'E: only C stays Open')
  console.log('OK E — resolving B leaves C Open')

  // --- F: resolving the last issue keeps the existing lifecycle (no auto-close) ---
  const f = await update(tech, t1.id, { resolveIssueIds: [idC], updateType: 'Site visit — resolved' })
  assert(f.status === 201 && f.body.data.openIssueCount === 0, `F: resolve C failed: ${brief(f)}`)
  assert(f.body.data.status === 'Under repair' && f.body.data.closed === false, 'F: ticket must stay open until explicitly closed')
  const fClose = await update(tech, t1.id, { closeTicket: true, workDone: 'All done' })
  assert(fClose.status === 201 && fClose.body.data.status === 'Closed', `F: explicit close failed: ${brief(fClose)}`)
  assert(fClose.body.data.resolvedIssues?.length === 0, 'F: nothing left to resolve on close')

  const t1b = await raise(admin, [issueA, issueB])
  const t1bIssues = await reported(tech, t1b.id)
  const closeRest = await update(tech, t1b.id, { resolveIssueIds: [idFor(t1bIssues, issueA)], closeTicket: true })
  assert(closeRest.status === 201 && closeRest.body.data.resolvedIssues?.length === 2, `F: close must resolve the rest: ${brief(closeRest)}`)
  const restRows = await query<{ status: string; resolved_event_id: string }>(
    `SELECT status, resolved_event_id FROM ticket_issues WHERE ticket_id = $1 AND role = 'reported'`,
    [t1b.uuid],
  )
  assert(
    restRows.rows.every((r) => r.status === 'Resolved' && r.resolved_event_id === closeRest.body.data.eventId),
    'F: close-with-update must tag every issue with the closing event',
  )

  const t1c = await raise(admin, [issueA, issueB])
  const closePage = await post(`/api/tickets/${t1c.id}/close`, tech.auth, {
    issues: [issueA],
    workDone: 'Closed from the Close page',
    deviceTested: 'Yes, tested with 5 open-close cycles',
  })
  assert(closePage.status === 200, `F: close page failed: ${brief(closePage)}`)
  assert(openSubs(await reported(admin, t1c.id)).length === 0, 'F: Close page must resolve every open issue')
  console.log('OK F — last issue resolved keeps ticket open; closing resolves any remaining issues')

  // --- G: QR scan → detail → update only exposes Open issues ------------------
  const tG = await raise(admin)
  const gIssues = await reported(tech, tG.id)
  await update(tech, tG.id, { resolveIssueIds: [idFor(gIssues, issueA)] })
  const scan = await call(`/api/devices/scan?q=${encodeURIComponent(tG.deviceId)}`, { headers: tech.auth })
  assert(scan.status === 200 && scan.body.data?.openTicketId === tG.id, `G: scan must find the open ticket: ${brief(scan)}`)
  const gOpen = (await reported(tech, scan.body.data.openTicketId)).filter((i) => i.status === 'Open')
  assert(gOpen.length === 2 && !gOpen.some((i) => i.subCategoryId === issueA.subCategoryId), 'G: QR path shows only Open issues')
  const g = await update(tech, tG.id, { resolveIssueIds: [gOpen[0].id] })
  assert(g.status === 201 && g.body.data.openIssueCount === 1, `G: QR update resolve failed: ${brief(g)}`)
  console.log('OK G — QR scan path shows and resolves only Open issues')

  // --- H: Admin update resolves an issue ---------------------------------------
  const tH = await raise(admin)
  const hIssues = await reported(admin, tH.id)
  const h = await update(admin, tH.id, { resolveIssueIds: [idFor(hIssues, issueB)] })
  assert(h.status === 201 && h.body.data.resolvedIssues?.[0]?.subCategoryId === issueB.subCategoryId, `H: admin resolve failed: ${brief(h)}`)
  const h2 = await update(admin, tH.id, { resolveIssueIds: [idFor(hIssues, issueC)] })
  assert(h2.status === 201 && h2.body.data.openIssueCount === 1, `H: second admin resolve failed: ${brief(h2)}`)
  console.log('OK H — Admin update resolves issues')

  // --- I: Control room uses the existing permission matrix -------------------
  const tI = await raise(control)
  const iIssues = await reported(control, tI.id)
  const iDenied = await update(control, tI.id, { resolveIssueIds: [idFor(iIssues, issueA)] })
  assert(iDenied.status === 403, `I: Control room without Update ticket e must be 403, got ${brief(iDenied)}`)
  const crRoleId = await roleId(admin.auth, 'Control room')
  const saved = await query<{ can_view: boolean; can_create: boolean; can_edit: boolean; can_assign: boolean; can_close: boolean; can_delete: boolean }>(
    `SELECT can_view, can_create, can_edit, can_assign, can_close, can_delete
     FROM role_permissions WHERE role_id = $1 AND screen = 'Update ticket'`,
    [crRoleId],
  )
  const original = saved.rows[0]
  restoreControlRoomPerm = async () => {
    if (!original) {
      await query(`DELETE FROM role_permissions WHERE role_id = $1 AND screen = 'Update ticket'`, [crRoleId])
      return
    }
    await query(
      `UPDATE role_permissions SET can_view = $2, can_create = $3, can_edit = $4, can_assign = $5, can_close = $6, can_delete = $7
       WHERE role_id = $1 AND screen = 'Update ticket'`,
      [crRoleId, original.can_view, original.can_create, original.can_edit, original.can_assign, original.can_close, original.can_delete],
    )
  }
  const grant = await call(`/api/roles/${crRoleId}/permissions`, {
    method: 'PATCH',
    headers: admin.auth,
    body: JSON.stringify({ permissions: { 'Update ticket': 'vce...' } }),
  })
  assert(grant.status === 200, `I: grant failed: ${brief(grant)}`)
  try {
    const iOk = await update(control, tI.id, { resolveIssueIds: [idFor(iIssues, issueA)] })
    assert(iOk.status === 201 && iOk.body.data.openIssueCount === 2, `I: Control room resolve failed: ${brief(iOk)}`)
  } finally {
    await restoreControlRoomPerm()
    restoreControlRoomPerm = null
  }
  console.log('OK I — Control room resolves through the same path once Update ticket e is granted')

  // --- J: Project manager ------------------------------------------------------
  const tJ = await raise(admin)
  const jIssues = await reported(pm, tJ.id)
  const j = await update(pm, tJ.id, {
    resolveIssueIds: [idFor(jIssues, issueA), idFor(jIssues, issueC)],
  })
  assert(j.status === 201 && j.body.data.resolvedIssues?.length === 2 && j.body.data.openIssueCount === 1, `J: PM resolve failed: ${brief(j)}`)
  console.log('OK J — Project manager resolves multiple issues in one update')

  // --- K: single-issue ticket + legacy backfill --------------------------------
  const tK = await raise(admin, [issueA])
  const kIssues = await reported(tech, tK.id)
  assert(kIssues.length === 1 && kIssues[0].status === 'Open', 'K: single issue must be Open')
  const kPlain = await update(tech, tK.id)
  assert(kPlain.status === 201 && kPlain.body.data.openIssueCount === 1, 'K: update without resolve keeps the issue Open')
  const k = await update(tech, tK.id, { resolveIssueIds: [kIssues[0].id] })
  assert(k.status === 201 && k.body.data.openIssueCount === 0, `K: single issue resolve failed: ${brief(k)}`)
  const legacyGap = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM tickets t
     WHERE t.reported_subcategory_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM ticket_issues ti WHERE ti.ticket_id = t.id AND ti.role = 'reported')`,
  )
  assert(legacyGap.rows[0].n === 0, 'K: every legacy ticket must have a resolvable reported issue row')
  const closedOpen = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ticket_issues ti JOIN tickets t ON t.id = ti.ticket_id
     WHERE t.status = 'Closed' AND ti.role = 'reported' AND ti.status = 'Open'`,
  )
  assert(closedOpen.rows[0].n === 0, 'K: Closed tickets must not have Open issues')
  console.log('OK K — single-issue and legacy tickets resolve through the same flow')

  // --- L: tickets have no holder; only Update ticket `e` gates resolving ---------
  const tL = await raise(admin)
  const lIssues = await reported(admin, tL.id)
  const lDenied = await update(attendant, tL.id, { resolveIssueIds: [idFor(lIssues, issueA)] })
  assert(lDenied.status === 403, `L: role without Update ticket e must be 403, got ${brief(lDenied)}`)
  assert(openSubs(await reported(admin, tL.id)).length === 3, 'L: rejected request must not resolve anything')
  const l = await update(tech2, tL.id, { resolveIssueIds: [idFor(lIssues, issueC)] })
  assert(l.status === 201 && l.body.data.openIssueCount === 2, `L: any field user may resolve, got ${brief(l)}`)
  console.log('OK L — any user with Update ticket e resolves; a role without it gets 403')

  // --- M: issue from another ticket / unknown id -------------------------------
  const m = await update(tech, tL.id, { resolveIssueIds: [idFor(gIssues, issueB)] })
  assert(m.status === 400 && m.body.code === 'INVALID_ISSUES', `M: foreign issue must be 400, got ${brief(m)}`)
  const mUnknown = await update(tech, tL.id, { resolveIssueIds: ['00000000-0000-4000-8000-000000000000'] })
  assert(mUnknown.status === 400 && mUnknown.body.code === 'INVALID_ISSUES', `M: unknown issue must be 400, got ${brief(mUnknown)}`)
  assert(openSubs(await reported(tech, tG.id)).length === 1, 'M: the other ticket\'s issue must be untouched')
  console.log('OK M — backend rejects issues that do not belong to the ticket')

  // --- N: dashboard counts follow issue resolution ----------------------------
  const dash = async () => {
    const res = await call('/api/dashboard', { headers: admin.auth })
    assert(res.status === 200, `N: dashboard failed: ${brief(res)}`)
    return res.body.data as { openIssues: number; openTicketsCount: number }
  }
  const before = await dash()
  const n = await update(tech, tL.id, { resolveIssueIds: [idFor(lIssues, issueA)] })
  assert(n.status === 201, `N: resolve failed: ${brief(n)}`)
  const after = await dash()
  assert(after.openIssues === before.openIssues - 1, `N: openIssues must drop by 1 (${before.openIssues} → ${after.openIssues})`)
  assert(after.openTicketsCount === before.openTicketsCount, 'N: a partly resolved ticket is still an open ticket')
  console.log('OK N — dashboard open-issue count drops by one; open ticket count unchanged')

  // --- O: concurrent resolution of the same issue ------------------------------
  const tO = await raise(admin)
  const oIssues = await reported(tech, tO.id)
  const target = idFor(oIssues, issueB)
  const eventsBefore = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ticket_events WHERE ticket_id = $1`, [tO.uuid])
  const [o1, o2] = await Promise.all([
    update(tech, tO.id, { resolveIssueIds: [target] }),
    update(admin, tO.id, { resolveIssueIds: [target] }),
  ])
  const wins = [o1, o2].filter((r) => r.status === 201)
  const losses = [o1, o2].filter((r) => r.status !== 201)
  assert(wins.length === 1, `O: exactly one concurrent resolve may win, got ${brief(o1)} / ${brief(o2)}`)
  assert(losses[0].status === 409 && losses[0].body.code === 'ISSUE_ALREADY_RESOLVED', `O: loser must be 409, got ${brief(losses[0])}`)
  const eventsAfter = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ticket_events WHERE ticket_id = $1`, [tO.uuid])
  assert(eventsAfter.rows[0].n === eventsBefore.rows[0].n + 1, 'O: the rejected update must not write an event')
  console.log('OK O — concurrent resolution of the same issue: one wins, one is rejected')

  console.log('\nIssue resolution verification passed')
}

async function cleanup() {
  if (restoreControlRoomPerm) await restoreControlRoomPerm().catch(() => {})
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
