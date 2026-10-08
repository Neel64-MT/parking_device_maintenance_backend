/**
 * Phase 51 issue-group smoke — resolve by Main Issue (category) or Sub Issue, append new
 * issues through Add Update, backend validation, multi-user, QR, Admin / Control room / PM,
 * dashboard counts and no auto-close. Spec §19 cases 1–7 and 13–21 (UI cases 8–12 are a
 * browser walkthrough). Never prints tokens or passwords.
 * Run: npm run test:smoke:issue-groups
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
  const mobile = `95${suffix}`.slice(0, 10)
  const res = await post('/api/users', adminAuth, {
    fullName: `Smoke Group ${roleName} ${suffix}`,
    mobile,
    email: `smoke.group.${suffix}@yopmail.com`,
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
  const categories = (cats.body.data as Array<{ id: string; subs: Array<{ id: string }> }>)
    .filter((c) => c.subs.length)
    .sort((a, b) => b.subs.length - a.subs.length)
  assert(categories.length >= 3, 'need at least 3 issue categories with active sub-categories')
  assert(categories[0].subs.length >= 3, 'need one category with at least 3 active sub-categories')
  const toPair = (c: { id: string }, s: { id: string }): Pair => ({ categoryId: c.id, subCategoryId: s.id })
  // Main issue X with three subs, plus single-sub main issues Y and Z.
  const catX = categories[0]
  const [x1, x2, x3] = catX.subs.slice(0, 3).map((s) => toPair(catX, s))
  const y1 = toPair(categories[1], categories[1].subs[0])
  const z1 = toPair(categories[2], categories[2].subs[0])

  let deviceSeq = 0
  async function newDevice() {
    deviceSeq += 1
    const res = await post('/api/devices', admin.auth, {
      roadId,
      slotNumber: `GROUP-${Date.now()}-${deviceSeq}`,
      installedOn: '2026-09-01',
    })
    assert(res.status === 201, `device create failed: ${brief(res)}`)
    return res.body.data.publicId as string
  }

  async function raise(session: Session, issues: Pair[] = [x1, x2, x3, y1], deviceId?: string) {
    const device = deviceId || (await newDevice())
    const res = await post('/api/tickets', session.auth, {
      deviceId: device,
      issues,
      reporterType: 'Control room',
    })
    assert(res.status === 201, `raise failed: ${brief(res)}`)
    touchedTickets.push(res.body.data.id as string)
    return { id: res.body.data.id as string, uuid: res.body.data.uuid as string, deviceId: device }
  }

  const update = (session: Session, ticketId: string, payload: Record<string, unknown> = {}) =>
    post(`/api/tickets/${ticketId}/updates`, session.auth, {
      updateType: 'Site visit — not resolved',
      workDone: 'Smoke group update',
      ...payload,
    })

  async function reported(session: Session, ticketId: string): Promise<ApiIssue[]> {
    const res = await call(`/api/tickets/${ticketId}`, { headers: session.auth })
    assert(res.status === 200, `detail failed: ${brief(res)}`)
    return res.body.data.issuesReported as ApiIssue[]
  }
  const idFor = (issues: ApiIssue[], pair: Pair) =>
    issues.find((i) => i.subCategoryId === pair.subCategoryId)?.id as string
  const statusOf = (issues: ApiIssue[], pair: Pair) =>
    issues.find((i) => i.subCategoryId === pair.subCategoryId)?.status
  const eventCount = async (uuid: string) =>
    (await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ticket_events WHERE ticket_id = $1`, [uuid])).rows[0].n

  const tech = await createUser(admin.auth, 'Technician')
  const tech2 = await createUser(admin.auth, 'Technician')
  const pm = await createUser(admin.auth, 'Project manager')
  const control = await createUser(admin.auth, 'Control room')

  // --- 1: one Main Issue with several Sub Issues, plus a second Main Issue ---------
  const t1 = await raise(admin)
  const i1 = await reported(tech, t1.id)
  assert(i1.length === 4 && i1.every((i) => i.status === 'Open'), `1: all 4 issues must start Open: ${JSON.stringify(i1)}`)
  assert(i1.filter((i) => i.categoryId === catX.id).length === 3, '1: main issue X must carry 3 sub issues')
  console.log('OK 1 — ticket with one Main Issue + 3 Sub Issues (and a second Main Issue) starts all Open')

  // --- 2: selecting the Main Issue resolves all of its Open Sub Issues ------------
  const r2 = await update(tech, t1.id, { resolveCategoryIds: [catX.id] })
  assert(r2.status === 201, `2: resolve by main issue failed: ${brief(r2)}`)
  assert(r2.body.data.resolvedIssues?.length === 3, `2: response must list 3 resolved subs: ${brief(r2)}`)
  assert(r2.body.data.openIssueCount === 1, '2: only main issue Y may remain Open')
  const a2 = await reported(tech, t1.id)
  assert([x1, x2, x3].every((p) => statusOf(a2, p) === 'Resolved'), '2: every sub of X must be Resolved')
  assert(statusOf(a2, y1) === 'Open', '2: the other main issue must stay Open')
  console.log('OK 2 — selecting a Main Issue resolves all of its Sub Issues; other main issues stay Open')

  // --- 3 + 4: selecting one Sub Issue resolves only that sub ----------------------
  const t3 = await raise(admin)
  const i3 = await reported(tech, t3.id)
  const r3 = await update(tech, t3.id, { resolveIssueIds: [idFor(i3, x1)] })
  assert(r3.status === 201 && r3.body.data.resolvedIssues?.length === 1, `3: sub resolve failed: ${brief(r3)}`)
  const a3 = await reported(tech, t3.id)
  assert(statusOf(a3, x1) === 'Resolved', '3: the selected sub must be Resolved')
  assert(statusOf(a3, x2) === 'Open' && statusOf(a3, x3) === 'Open', '4: sibling subs must stay Open')
  console.log('OK 3 — selecting one Sub Issue resolves only that sub')
  console.log('OK 4 — sibling Sub Issues remain Open')

  // --- 5 + 16: already-resolved issues cannot be resolved again -------------------
  const r5 = await update(tech, t3.id, { resolveIssueIds: [idFor(i3, x1)] })
  assert(r5.status === 409 && r5.body.code === 'ISSUE_ALREADY_RESOLVED', `5: must be 409, got ${brief(r5)}`)
  const r5main = await update(tech, t1.id, { resolveCategoryIds: [catX.id] })
  assert(
    r5main.status === 409 && r5main.body.code === 'ISSUE_ALREADY_RESOLVED',
    `5: a main issue with no Open subs must be 409, got ${brief(r5main)}`,
  )
  // A partly resolved main issue resolves only its remaining Open subs.
  const r5partial = await update(tech, t3.id, { resolveCategoryIds: [catX.id] })
  assert(
    r5partial.status === 201 && r5partial.body.data.resolvedIssues?.length === 2,
    `5: main issue must resolve only its 2 remaining Open subs: ${brief(r5partial)}`,
  )
  console.log('OK 5 / 16 — resolved issues are rejected (409); a partly resolved main issue resolves only Open subs')

  // --- 6 + 7: User A resolves some, User B sees only the rest (scan + detail) -----
  const t6 = await raise(admin)
  const i6 = await reported(tech, t6.id)
  const r6 = await update(tech, t6.id, { resolveIssueIds: [idFor(i6, x2)] })
  assert(r6.status === 201, `6: user A resolve failed: ${brief(r6)}`)
  const scan7 = await call(`/api/devices/scan?q=${encodeURIComponent(t6.deviceId)}`, { headers: tech2.auth })
  const s7 = (scan7.body.data?.openTickets as Array<{ id: string; issues: Pair[] }>)?.find((t) => t.id === t6.id)
  assert(s7?.issues.length === 3, `7: scan must show only the 3 remaining Open issues: ${brief(scan7)}`)
  assert(!s7.issues.some((i) => i.subCategoryId === x2.subCategoryId), '7: the resolved sub must not be offered')
  const r7 = await update(tech2, t6.id, { resolveCategoryIds: [catX.id] })
  assert(r7.status === 201 && r7.body.data.resolvedIssues?.length === 2, `7: user B main resolve failed: ${brief(r7)}`)
  const resolvers = await query<{ sub: string; by: string }>(
    `SELECT subcategory_id::text AS sub, resolved_by_user_id::text AS by
     FROM ticket_issues WHERE ticket_id = $1 AND role = 'reported' AND status = 'Resolved'`,
    [t6.uuid],
  )
  const byOf = (p: Pair) => resolvers.rows.find((r) => r.sub === p.subCategoryId)?.by
  assert(byOf(x2) === tech.id && byOf(x1) === tech2.id && byOf(x3) === tech2.id, '6: each sub must record who resolved it')
  console.log('OK 6 — User A resolves a sub; resolver is recorded per issue')
  console.log('OK 7 — User B scanning the same ticket sees only the remaining Open issues')

  // --- 13: Add another issue → persisted, Open, resolvable later -------------------
  const t13 = await raise(admin, [x1, x2])
  const before13 = await eventCount(t13.uuid)
  const r13 = await update(tech, t13.id, { addIssues: [z1] })
  assert(r13.status === 201, `13: add issue failed: ${brief(r13)}`)
  assert(
    r13.body.data.addedIssues?.length === 1 &&
      r13.body.data.addedIssues[0].subCategoryId === z1.subCategoryId &&
      r13.body.data.addedIssues[0].status === 'Open',
    `13: response must list the new Open issue: ${brief(r13)}`,
  )
  assert(r13.body.data.openIssueCount === 3, '13: open count must include the new issue')
  assert((await eventCount(t13.uuid)) === before13 + 1, '13: appending issues writes the single update event only')
  const a13 = await reported(tech2, t13.id)
  assert(statusOf(a13, z1) === 'Open', '13: the new issue must be persisted as Open')
  const order = await query<{ sub: string; sort_order: number }>(
    `SELECT subcategory_id::text AS sub, sort_order FROM ticket_issues
     WHERE ticket_id = $1 AND role = 'reported' ORDER BY sort_order`,
    [t13.uuid],
  )
  assert(order.rows[order.rows.length - 1].sub === z1.subCategoryId, '13: the new issue must be listed after the raised ones')
  const r13b = await update(tech2, t13.id, { resolveIssueIds: [idFor(a13, z1)] })
  assert(r13b.status === 201 && r13b.body.data.openIssueCount === 2, `13: the new issue must be resolvable: ${brief(r13b)}`)
  // Add + resolve existing in one request.
  const r13c = await update(tech, t13.id, { addIssues: [y1], resolveCategoryIds: [catX.id] })
  assert(
    r13c.status === 201 && r13c.body.data.addedIssues?.length === 1 && r13c.body.data.resolvedIssues?.length === 2,
    `13: add + resolve in one update failed: ${brief(r13c)}`,
  )
  assert(r13c.body.data.openIssueCount === 1, '13: only the newly added issue may remain Open')
  console.log('OK 13 — a new issue is persisted Open after the raised ones and is resolvable later')

  // --- 13b: duplicate appends are rejected without side effects --------------------
  const before13d = await eventCount(t13.uuid)
  const dupSame = await update(tech, t13.id, { addIssues: [x1] })
  assert(
    dupSame.status === 409 && dupSame.body.code === 'ISSUE_ALREADY_ON_TICKET',
    `13: a sub already on this ticket (even Resolved) must be 409 ISSUE_ALREADY_ON_TICKET, got ${brief(dupSame)}`,
  )
  const tOther = await raise(admin, [x3], t13.deviceId)
  const dupOther = await update(tech, t13.id, { addIssues: [x3] })
  assert(
    dupOther.status === 409 &&
      dupOther.body.code === 'OPEN_TICKET_EXISTS' &&
      dupOther.body.details?.openTicketId === tOther.id,
    `13: a sub Open on another ticket of the device must be 409 OPEN_TICKET_EXISTS, got ${brief(dupOther)}`,
  )
  assert((await eventCount(t13.uuid)) === before13d, '13: rejected appends must not write an event')
  console.log('OK 13b — duplicate issues (same ticket / other open ticket) are rejected with 409 and no event')

  // --- 14: Main/Sub relationship enforced by the backend --------------------------
  const t14 = await raise(admin, [x1, x2])
  const badPair = await update(tech, t14.id, { addIssues: [{ categoryId: y1.categoryId, subCategoryId: x3.subCategoryId }] })
  assert(badPair.status === 400 && badPair.body.code === 'INVALID_ISSUES', `14: mismatched pair must be 400, got ${brief(badPair)}`)
  const badMain = await update(tech, t14.id, { resolveCategoryIds: [y1.categoryId] })
  assert(badMain.status === 400 && badMain.body.code === 'INVALID_ISSUES', `14: a main issue not on the ticket must be 400, got ${brief(badMain)}`)
  const unknownMain = await update(tech, t14.id, { resolveCategoryIds: ['00000000-0000-4000-8000-000000000000'] })
  assert(unknownMain.status === 400 && unknownMain.body.code === 'INVALID_ISSUES', `14: unknown main issue must be 400, got ${brief(unknownMain)}`)
  const mixed = await update(tech, t14.id, { resolveCategoryIds: [catX.id], resolveIssueIds: ['00000000-0000-4000-8000-000000000000'] })
  assert(mixed.status === 400, `14: one bad id must reject the whole request, got ${brief(mixed)}`)
  assert((await reported(tech, t14.id)).every((i) => i.status === 'Open'), '14: rejected requests must resolve nothing')
  console.log('OK 14 — Main Issue / Sub Issue relationship is enforced (400 INVALID_ISSUES, nothing resolved)')

  // --- 15: issues of another ticket cannot be resolved ---------------------------
  const foreignSub = await update(tech, t14.id, { resolveIssueIds: [idFor(i6, y1)] })
  assert(foreignSub.status === 400 && foreignSub.body.code === 'INVALID_ISSUES', `15: foreign sub must be 400, got ${brief(foreignSub)}`)
  assert(statusOf(await reported(tech, t6.id), y1) === 'Open', '15: the other ticket must be untouched')
  console.log('OK 15 — an issue belonging to another ticket is rejected')

  // --- 17: QR → Update uses the same behaviour -----------------------------------
  const t17 = await raise(admin)
  const scan17 = await call(`/api/devices/scan?q=${encodeURIComponent(t17.deviceId)}`, { headers: tech.auth })
  assert(scan17.status === 200 && scan17.body.data?.openTicketId === t17.id, `17: scan must find the ticket: ${brief(scan17)}`)
  const r17 = await update(tech, scan17.body.data.openTicketId as string, { resolveCategoryIds: [catX.id] })
  assert(r17.status === 201 && r17.body.data.openIssueCount === 1, `17: QR main-issue resolve failed: ${brief(r17)}`)
  console.log('OK 17 — QR scan → update resolves by main issue through the same endpoint')

  // --- 18 / 20: Admin and Project manager ----------------------------------------
  const t18 = await raise(admin)
  const r18 = await update(admin, t18.id, { resolveCategoryIds: [y1.categoryId] })
  assert(r18.status === 201 && r18.body.data.openIssueCount === 3, `18: Admin main resolve failed: ${brief(r18)}`)
  const i18 = await reported(pm, t18.id)
  const r20 = await update(pm, t18.id, { resolveIssueIds: [idFor(i18, x1)], addIssues: [z1] })
  assert(
    r20.status === 201 && r20.body.data.openIssueCount === 3 && r20.body.data.addedIssues?.length === 1,
    `20: PM resolve + add failed: ${brief(r20)}`,
  )
  console.log('OK 18 — Admin resolves by main issue')
  console.log('OK 20 — Project manager resolves a sub and adds an issue')

  // --- 19: Control room once Update ticket `e` is granted ------------------------
  const t19 = await raise(control)
  const denied19 = await update(control, t19.id, { resolveCategoryIds: [catX.id] })
  assert(denied19.status === 403, `19: Control room without Update ticket e must be 403, got ${brief(denied19)}`)
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
  assert(grant.status === 200, `19: grant failed: ${brief(grant)}`)
  try {
    const ok19 = await update(control, t19.id, { resolveCategoryIds: [catX.id] })
    assert(ok19.status === 201 && ok19.body.data.openIssueCount === 1, `19: Control room resolve failed: ${brief(ok19)}`)
  } finally {
    await restoreControlRoomPerm()
    restoreControlRoomPerm = null
  }
  console.log('OK 19 — Control room resolves by main issue once Update ticket e is granted')

  // --- 21: dashboard counts + no auto-close --------------------------------------
  const dash = async () => {
    const res = await call('/api/dashboard', { headers: admin.auth })
    assert(res.status === 200, `21: dashboard failed: ${brief(res)}`)
    return res.body.data as { openIssues: number; openTicketsCount: number }
  }
  const t21 = await raise(admin)
  const d0 = await dash()
  const r21a = await update(tech, t21.id, { resolveCategoryIds: [catX.id] })
  assert(r21a.status === 201, `21: resolve failed: ${brief(r21a)}`)
  const d1 = await dash()
  assert(d1.openIssues === d0.openIssues - 3, `21: openIssues must drop by 3 (${d0.openIssues} → ${d1.openIssues})`)
  assert(d1.openTicketsCount === d0.openTicketsCount, '21: a partly resolved ticket stays an open ticket')
  const r21b = await update(tech, t21.id, { addIssues: [z1] })
  assert(r21b.status === 201, `21: add failed: ${brief(r21b)}`)
  const d2 = await dash()
  assert(d2.openIssues === d1.openIssues + 1, `21: openIssues must rise by 1 after an add (${d1.openIssues} → ${d2.openIssues})`)
  const i21 = await reported(tech, t21.id)
  const r21c = await update(tech2, t21.id, {
    resolveIssueIds: i21.filter((i) => i.status === 'Open').map((i) => i.id),
    updateType: 'Site visit — resolved',
  })
  assert(r21c.status === 201 && r21c.body.data.openIssueCount === 0, `21: final resolve failed: ${brief(r21c)}`)
  assert(r21c.body.data.closed === false && r21c.body.data.status !== 'Closed', '21: resolving every issue must not auto-close')
  const d3 = await dash()
  assert(d3.openTicketsCount === d0.openTicketsCount, '21: the ticket stays open until explicitly closed')
  const close21 = await update(tech, t21.id, { closeTicket: true, workDone: 'All issues fixed' })
  assert(close21.status === 201 && close21.body.data.status === 'Closed', `21: explicit close failed: ${brief(close21)}`)
  const d4 = await dash()
  assert(d4.openTicketsCount === d0.openTicketsCount - 1, '21: closing drops the open ticket count by one')
  console.log('OK 21 — dashboard open issues / open tickets follow resolution; no auto-close')

  // --- concurrency: two users resolve the same main issue at once ----------------
  const tC = await raise(admin)
  const [c1, c2] = await Promise.all([
    update(tech, tC.id, { resolveCategoryIds: [catX.id] }),
    update(tech2, tC.id, { resolveCategoryIds: [catX.id] }),
  ])
  const wins = [c1, c2].filter((r) => r.status === 201)
  const losses = [c1, c2].filter((r) => r.status !== 201)
  assert(wins.length === 1, `concurrency: exactly one may win, got ${brief(c1)} / ${brief(c2)}`)
  assert(losses[0].status === 409 && losses[0].body.code === 'ISSUE_ALREADY_RESOLVED', `concurrency: loser must be 409, got ${brief(losses[0])}`)
  console.log('OK concurrency — two users resolving the same main issue: one wins, one gets 409')

  console.log('\nIssue group verification passed')
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
