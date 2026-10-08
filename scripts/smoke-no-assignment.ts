/**
 * Phase 51 no-assignment smoke — tickets have no holder. Raise never assigns, any user with
 * Update ticket `e` updates any open ticket, nothing auto-assigns or notifies, historical
 * assignee data stays readable, and the permission matrix still blocks other roles.
 * Spec §23.12 cases 1–11 (cases 12–13 are a browser walkthrough). Never prints tokens or passwords.
 * Phase 52: Open / Under repair / Closed tab split and the `age=over3` filter.
 * Run: npm run test:smoke:no-assignment
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
type Pair = { categoryId: string; subCategoryId: string }
type ApiIssue = Pair & { id: string; status: string }

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

async function createUser(adminAuth: Auth, roleName: string): Promise<Session> {
  const roles = await call('/api/roles', { headers: adminAuth })
  const roleId = (roles.body.data as Array<{ id: string; name: string }>).find((r) => r.name === roleName)?.id
  assert(roleId, `${roleName} role not found — run npm run db:migrate`)
  const suffix = String(Date.now()).slice(-7) + Math.floor(Math.random() * 900 + 100)
  const mobile = `96${suffix}`.slice(0, 10)
  const res = await post('/api/users', adminAuth, {
    fullName: `Smoke NoAssign ${roleName} ${suffix}`,
    mobile,
    email: `smoke.noassign.${suffix}@yopmail.com`,
    password: 'SmokePass1',
    roleId,
    roadIds: [],
  })
  assert(res.status === 201 && res.body.data?.id, `create ${roleName} failed: ${brief(res)}`)
  createdUserIds.push(res.body.data.id as string)
  return login(mobile, 'SmokePass1')
}

async function ticketRow(publicId: string) {
  const r = await query<{ id: string; status: string; assignee_id: string | null }>(
    `SELECT id, status, assignee_id FROM tickets WHERE public_id = $1`,
    [publicId],
  )
  return r.rows[0]
}

async function assignmentRows(ticketUuid: string) {
  const r = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ticket_assignments WHERE ticket_id = $1`, [ticketUuid])
  return r.rows[0].n
}

async function assignmentNotifications(ticketUuid: string) {
  const r = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM notifications
     WHERE related_entity_id = $1 AND type IN ('ticket.assigned', 'ticket.reassigned')`,
    [ticketUuid],
  )
  return r.rows[0].n
}

async function main() {
  const admin = await login('9000000001', 'Password123')

  const roads = await call('/api/roads', { headers: admin.auth })
  const roadId = roads.body.data[0].id as string
  const cats = await call('/api/lookups/issue-categories', { headers: admin.auth })
  const pairs: Pair[] = (cats.body.data as Array<{ id: string; subs: Array<{ id: string }> }>).flatMap((c) =>
    c.subs.map((s) => ({ categoryId: c.id, subCategoryId: s.id })),
  )
  assert(pairs.length >= 3, 'need at least 3 active issue sub-categories')
  const [issueA, issueB, issueC] = pairs

  let deviceSeq = 0
  async function newDevice() {
    deviceSeq += 1
    const res = await post('/api/devices', admin.auth, {
      roadId,
      slotNumber: `NOASG-${Date.now()}-${deviceSeq}`,
      installedOn: '2026-09-01',
    })
    assert(res.status === 201, `device create failed: ${brief(res)}`)
    return res.body.data.publicId as string
  }

  async function raise(session: Session, issues: Pair[] = [issueA, issueB, issueC], extra: Record<string, unknown> = {}) {
    const deviceId = await newDevice()
    const res = await post('/api/tickets', session.auth, { deviceId, issues, reporterType: 'Control room', ...extra })
    assert(res.status === 201, `raise failed: ${brief(res)}`)
    touchedTickets.push(res.body.data.id as string)
    return { id: res.body.data.id as string, uuid: res.body.data.uuid as string, deviceId }
  }

  const update = (session: Session, ticketId: string, payload: Record<string, unknown> = {}) =>
    post(`/api/tickets/${ticketId}/updates`, session.auth, {
      updateType: 'Site visit — not resolved',
      workDone: 'Smoke no-assignment update',
      ...payload,
    })

  async function reported(session: Session, ticketId: string): Promise<ApiIssue[]> {
    const res = await call(`/api/tickets/${ticketId}`, { headers: session.auth })
    assert(res.status === 200, `detail failed: ${brief(res)}`)
    return res.body.data.issuesReported as ApiIssue[]
  }
  const idFor = (issues: ApiIssue[], pair: Pair) =>
    issues.find((i) => i.subCategoryId === pair.subCategoryId)?.id as string

  const userA = await createUser(admin.auth, 'Technician')
  const userB = await createUser(admin.auth, 'Engineer')
  const userC = await createUser(admin.auth, 'Electrician')
  const attendant = await createUser(admin.auth, 'Site attendant')

  // --- 1: a new ticket is created without assignment ------------------------------
  const t1 = await raise(userA)
  const row1 = await ticketRow(t1.id)
  assert(row1.status === 'Open' && row1.assignee_id == null, `1: raise must be Open + unassigned: ${JSON.stringify(row1)}`)
  const tStray = await raise(admin, [issueA], { assigneeId: userA.id })
  const rowStray = await ticketRow(tStray.id)
  assert(rowStray.status === 'Open' && rowStray.assignee_id == null, '1: a stray assigneeId on raise must be ignored')
  assert((await assignmentRows(rowStray.id)) === 0, '1: raise must not write ticket_assignments')
  assert((await assignmentNotifications(rowStray.id)) === 0, '1: raise must not send an assignment notification')
  console.log('OK 1 — new tickets are created Open with no assignee (a stray assigneeId is ignored)')

  // --- Every Ticket, Every Road: list / detail / tabs carry no assignment ---------
  const listFor = async (session: Session, q: string, tab = 'open') => {
    const res = await call(`/api/tickets?tab=${tab}&q=${encodeURIComponent(q)}`, { headers: session.auth })
    assert(res.status === 200, `list failed: ${brief(res)}`)
    return res.body
  }
  for (const viewer of [userB, attendant]) {
    const body = await listFor(viewer, t1.id)
    const listed = (body.data as Array<Record<string, unknown>>).find((r) => r.id === t1.id)
    assert(listed, 'list: anyone with All tickets v must see every ticket')
    assert(!('assignedTo' in listed) && !('actionLabel' in listed), 'list: rows must carry no assignment fields')
    assert(
      body.tabCounts &&
        'open' in body.tabCounts &&
        'urp' in body.tabCounts &&
        'cls' in body.tabCounts &&
        !('asg' in body.tabCounts),
      `list: tabCounts must be { open, urp, cls }: ${JSON.stringify(body.tabCounts)}`,
    )
    assert(
      body.over3Counts && 'open' in body.over3Counts && 'urp' in body.over3Counts,
      `list: over3Counts must be { open, urp }: ${JSON.stringify(body.over3Counts)}`,
    )
  }
  const oldTab = await call(`/api/tickets?tab=asg`, { headers: admin.auth })
  assert(oldTab.status === 400, `list: the removed Assigned tab must be rejected, got ${brief(oldTab)}`)
  const detail1 = await call(`/api/tickets/${t1.id}`, { headers: attendant.auth })
  assert(detail1.status === 200, `detail: anyone with All tickets v opens any ticket, got ${brief(detail1)}`)
  assert(
    !('assigneeId' in detail1.body.data) && !('assignmentTrail' in detail1.body.data),
    'detail: response must carry no assignee / assignment trail',
  )
  assert(
    !(detail1.body.data.header.facts as Array<{ label: string }>).some((f) => f.label === 'Assigned to'),
    'detail: header must not show an Assigned to fact',
  )
  console.log('OK list / detail — every user with All tickets v sees every ticket; no assignment fields or tab')

  // --- Phase 52: Open = no update yet, Under repair = at least one update ---------
  const inTab = async (ticketId: string, tab: string) => {
    const body = await listFor(admin, ticketId, tab)
    return (body.data as Array<{ id: string; tab: string }>).find((r) => r.id === ticketId)
  }
  const t52 = await raise(admin, [issueA])
  const fresh52 = await inTab(t52.id, 'open')
  assert(fresh52?.tab === 'open', '52: a newly raised ticket must be in the Open tab')
  assert(!(await inTab(t52.id, 'urp')), '52: a newly raised ticket must not be in Under repair')
  assert((await update(userA, t52.id)).status === 201, '52: first update failed')
  const urp52 = await inTab(t52.id, 'urp')
  assert(urp52?.tab === 'urp', '52: after one update the ticket must move to Under repair')
  assert(!(await inTab(t52.id, 'open')), '52: after one update the ticket must leave the Open tab')
  const w52 = await update(userB, t52.id, { updateType: 'Waiting for spare', workDone: 'Spare ordered' })
  assert(w52.status === 201, `52: waiting-for-spare update failed: ${brief(w52)}`)
  const wList = await listFor(admin, t52.id, 'urp')
  const wRow = (wList.data as Array<{ id: string; status: string }>).find((r) => r.id === t52.id)
  assert(wRow?.status === 'Waiting for spare', `52: Waiting for spare stays in Under repair, got ${JSON.stringify(wRow)}`)
  const urOnly = await call(`/api/tickets?tab=urp&status=${encodeURIComponent('Under repair')}&q=${t52.id}`, {
    headers: admin.auth,
  })
  assert(
    !(urOnly.body.data as Array<{ id: string }>).some((r) => r.id === t52.id),
    '52: the Under repair status filter must exclude Waiting for spare',
  )

  const old52 = await raise(admin, [issueB])
  await query(`UPDATE tickets SET raised_at = NOW() - INTERVAL '5 days' WHERE public_id = $1`, [old52.id])
  const oldRes = await call(`/api/tickets?tab=open&age=over3&q=${old52.id}`, { headers: admin.auth })
  assert(
    (oldRes.body.data as Array<{ id: string }>).some((r) => r.id === old52.id),
    '52: age=over3 must list a ticket raised 5 days ago',
  )
  assert(oldRes.body.over3Counts.open >= 1, `52: over3Counts.open must count it: ${JSON.stringify(oldRes.body.over3Counts)}`)
  assert(oldRes.body.tabCounts.open >= 1, '52: tabCounts.open must respect age=over3')
  const freshOver3 = await call(`/api/tickets?tab=urp&age=over3&q=${t52.id}`, { headers: admin.auth })
  assert(
    !(freshOver3.body.data as Array<{ id: string }>).some((r) => r.id === t52.id),
    '52: age=over3 must exclude a ticket raised today',
  )
  const badAge = await call(`/api/tickets?tab=open&age=week`, { headers: admin.auth })
  assert(badAge.status === 400, `52: an unknown age value must be rejected, got ${brief(badAge)}`)
  console.log('OK 52 — Open has no updates, Under repair has updates (incl. Waiting for spare); age=over3 filters')

  // --- 2 / 3 / 4 + 7 + 10: users A, B, C update the same ticket in turn -----------
  for (const [label, user] of [
    ['A', userA],
    ['B', userB],
    ['C', userC],
  ] as const) {
    const res = await update(user, t1.id, { workDone: `Visit by user ${label}` })
    assert(res.status === 201, `${label}: update must succeed without being assigned, got ${brief(res)}`)
    assert(!('assigneeId' in res.body.data) && !('autoAssigned' in res.body.data), `${label}: response must not report assignment`)
    const actor = await query<{ actor_user_id: string }>(`SELECT actor_user_id FROM ticket_events WHERE id = $1`, [
      res.body.data.eventId,
    ])
    assert(actor.rows[0]?.actor_user_id === user.id, `${label}: the update must be recorded against its author`)
    assert((await ticketRow(t1.id)).assignee_id == null, `${label}: the ticket must stay unassigned`)
  }
  assert((await assignmentRows(row1.id)) === 0, '7: updates must not write ticket_assignments')
  console.log('OK 2 / 3 / 4 — users A, B and C update the same ticket in turn')
  console.log('OK 7 / 10 — no auto-assignment; nobody is blocked for not being the assignee')

  // --- 5 / 6: resolving issues does not assign the resolver -----------------------
  const t5 = await raise(admin)
  const i5 = await reported(userA, t5.id)
  const r5 = await update(userA, t5.id, { resolveIssueIds: [idFor(i5, issueA)] })
  assert(r5.status === 201, `5: user A resolve failed: ${brief(r5)}`)
  assert((await ticketRow(t5.id)).assignee_id == null, '5: user A resolving must not assign the ticket to A')
  const r6 = await update(userB, t5.id, { resolveIssueIds: [idFor(i5, issueB)] })
  assert(r6.status === 201 && r6.body.data.openIssueCount === 1, `6: user B resolve failed: ${brief(r6)}`)
  const row5 = await ticketRow(t5.id)
  assert(row5.assignee_id == null, '6: user B resolving must not assign / reassign the ticket')
  const resolvers = await query<{ sub: string; by: string }>(
    `SELECT subcategory_id::text AS sub, resolved_by_user_id::text AS by
     FROM ticket_issues WHERE ticket_id = $1 AND status = 'Resolved'`,
    [row5.id],
  )
  assert(
    resolvers.rows.find((r) => r.sub === issueA.subCategoryId)?.by === userA.id &&
      resolvers.rows.find((r) => r.sub === issueB.subCategoryId)?.by === userB.id,
    '5 / 6: each resolution must record its own author',
  )
  console.log('OK 5 / 6 — resolving issues never assigns the resolver; each resolution keeps its author')

  // --- concurrent updates by two users both succeed (no claim race) ---------------
  const tc = await raise(admin, [issueA])
  const [c1, c2] = await Promise.all([update(userA, tc.id), update(userB, tc.id)])
  assert(c1.status === 201 && c2.status === 201, `concurrency: both updates must succeed, got ${brief(c1)} / ${brief(c2)}`)
  console.log('OK concurrency — two users updating the same ticket at once both succeed')

  // --- 8: no assignment notification for normal updates ---------------------------
  for (const t of [t1, t5, tc]) {
    assert((await assignmentNotifications((await ticketRow(t.id)).id)) === 0, `8: ${t.id} must have no assignment notification`)
  }
  console.log('OK 8 — no assignment notification is generated by raises or updates')

  // --- 9: historical assignment data still loads and does not block anyone ---------
  const th = await raise(admin, [issueA, issueB])
  const rowH = await ticketRow(th.id)
  await query(`UPDATE tickets SET assignee_id = $2, status = 'Open' WHERE id = $1`, [rowH.id, userA.id])
  await query(
    `INSERT INTO ticket_assignments (ticket_id, from_user_id, to_user_id, reason) VALUES ($1, NULL, $2, 'Assigned')`,
    [rowH.id, userA.id],
  )
  await query(
    `INSERT INTO ticket_events (ticket_id, event_type, title, body, status_label, actor_user_id)
     VALUES ($1, 'assigned', 'Assigned', 'Ticket assigned (historical)', 'Still open', $2)`,
    [rowH.id, admin.id],
  )
  const dH = await call(`/api/tickets/${th.id}`, { headers: userB.auth })
  assert(dH.status === 200, `9: a historically assigned ticket must load, got ${brief(dH)}`)
  assert(
    (dH.body.data.workHistory as Array<{ eventType: string }>).some((e) => e.eventType === 'assigned'),
    '9: the historical assignment event stays in the work history',
  )
  const listedH = ((await listFor(admin, th.id, 'urp')).data as Array<{ id: string; status: string }>).find(
    (r) => r.id === th.id,
  )
  assert(listedH?.status === 'Under repair', `9: legacy Open + assignee still displays Under repair, got ${listedH?.status}`)
  const uH = await update(userB, th.id, { resolveIssueIds: [idFor(await reported(userB, th.id), issueA)] })
  assert(uH.status === 201, `9 / 10: a non-assignee must update a historically assigned ticket, got ${brief(uH)}`)
  assert((await ticketRow(th.id)).assignee_id === userA.id, '9: historical assignee data must be left untouched')
  const closeH = await update(userC, th.id, { closeTicket: true, workDone: 'Closed by a non-assignee' })
  assert(closeH.status === 201 && closeH.body.data.status === 'Closed', `9: a non-assignee with x must close it, got ${brief(closeH)}`)
  assert((await assignmentRows(rowH.id)) === 1, '9: historical ticket_assignments rows are kept, none added')
  console.log('OK 9 — historical assignee data loads, displays and does not block other users')

  // --- 11: unauthorized users are still blocked by the permission matrix -----------
  const t11 = await raise(admin, [issueC])
  const u11 = await update(attendant, t11.id)
  assert(u11.status === 403, `11: a role without Update ticket e must be 403, got ${brief(u11)}`)
  const close11 = await post(`/api/tickets/${t11.id}/close`, attendant.auth, {
    workDone: 'Not allowed',
    deviceTested: 'Yes, tested with 5 open-close cycles',
  })
  assert(close11.status === 403, `11: a role without Update ticket x must not close, got ${brief(close11)}`)
  const a11 = await update(userA, t11.id, { workDone: 'Own entry' })
  assert(a11.status === 201, `11: update failed: ${brief(a11)}`)
  const photoPath = `/api/tickets/${t11.id}/updates/${a11.body.data.eventId}/photos`
  const patch = (session: Session) =>
    call(photoPath, { method: 'PATCH', headers: session.auth, body: JSON.stringify({ photos: ['/uploads/smoke-noassign.jpg'] }) })
  const foreignPhoto = await patch(userB)
  assert(foreignPhoto.status === 403, `11: only the entry author may attach photos to it, got ${brief(foreignPhoto)}`)
  assert((await patch(userA)).status === 200, '11: the entry author attaches photos')
  assert((await patch(admin)).status === 200, '11: Admin may attach photos to any entry')
  const assignRoute = await post(`/api/tickets/${t11.id}/assign`, admin.auth, { assigneeId: userA.id })
  assert(assignRoute.status === 404, `11: the assign endpoint must be gone, got ${brief(assignRoute)}`)
  console.log('OK 11 — permission matrix still blocks other roles; photo attach is author-only; POST /assign is 404')

  console.log('\nNo-assignment verification passed')
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
