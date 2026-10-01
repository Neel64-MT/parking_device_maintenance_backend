/**
 * Slot View smoke (Phase 53) — only slots with tickets are listed, ticket count is per
 * ticket (never per issue), Slot Label order, search + pagination, the detail returns only
 * Open reported Sub Issues (one per Sub Issue), every ticket (Closed too) is reachable via
 * GET /api/tickets?device=, and the `Slot View` v screen (Admin / Project manager by default,
 * granted or revoked per role in Roles & permissions) gates the Slot View endpoints.
 * Never prints tokens or passwords.
 * Run: npm run test:smoke:slot-view
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
type ApiIssue = { id?: string; status?: string; categoryId: string; subCategoryId: string }
type SlotRow = { id: string; uuid: string; slotId: number | null; slotLabel: string; road: string; ticketCount: number }
type SlotIssue = {
  id: string
  categoryId: string
  subCategoryId: string
  status: string
  tickets: Array<{ id: string; uuid: string }>
}

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
const createdRoleIds: string[] = []
const touchedTickets: string[] = []

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

async function main() {
  const admin = await login('9000000001', 'Password123')

  const roads = await call('/api/roads', { headers: admin.auth })
  const road = roads.body.data[0] as { id: string; name: string }
  const cats = await call('/api/lookups/issue-categories', { headers: admin.auth })
  const catList = cats.body.data as Array<{ id: string; subs: Array<{ id: string }> }>
  const twoSubCat = catList.find((c) => c.subs.length >= 2)
  assert(twoSubCat, 'need a main issue with at least 2 sub issues')
  const subA1: Pair = { categoryId: twoSubCat!.id, subCategoryId: twoSubCat!.subs[0].id }
  const subA2: Pair = { categoryId: twoSubCat!.id, subCategoryId: twoSubCat!.subs[1].id }
  const others: Pair[] = catList
    .flatMap((c) => c.subs.map((s) => ({ categoryId: c.id, subCategoryId: s.id })))
    .filter((p) => p.subCategoryId !== subA1.subCategoryId && p.subCategoryId !== subA2.subCategoryId)
  assert(others.length >= 3, 'need at least 3 more active sub issues')
  const [p3, p4, p5] = others

  const prefix = `SV${String(Date.now()).slice(-8)}`
  async function newDevice(label: string) {
    const res = await post('/api/devices', admin.auth, {
      roadId: road.id,
      slotNumber: `${prefix}-${label}`,
      installedOn: '2026-09-01',
    })
    assert(res.status === 201, `device create failed: ${brief(res)}`)
    return { publicId: res.body.data.publicId as string, uuid: res.body.data.uuid as string }
  }

  async function raise(deviceId: string, issues: Pair[]) {
    const res = await post('/api/tickets', admin.auth, { deviceId, issues, reporterType: 'Control room' })
    assert(res.status === 201, `raise failed: ${brief(res)}`)
    touchedTickets.push(res.body.data.id as string)
    return { id: res.body.data.id as string, uuid: res.body.data.uuid as string }
  }

  const update = (ticketId: string, payload: Record<string, unknown>) =>
    post(`/api/tickets/${ticketId}/updates`, admin.auth, {
      updateType: 'Site visit — not resolved',
      workDone: 'Smoke slot view update',
      ...payload,
    })

  async function reported(ticketId: string): Promise<ApiIssue[]> {
    const res = await call(`/api/tickets/${ticketId}`, { headers: admin.auth })
    assert(res.status === 200, `detail failed: ${brief(res)}`)
    return res.body.data.issuesReported as ApiIssue[]
  }

  // Fixtures: labels are created out of order and are not zero-padded, so plain text
  // order (-10 before -2) would fail the natural Slot Label order check.
  const devA = await newDevice('10')
  const devB = await newDevice('2')
  const devC = await newDevice('1')

  const tk1 = await raise(devA.publicId, [subA1, subA2, p3])
  const tk2 = await raise(devA.publicId, [p4])
  const tk3 = await raise(devA.publicId, [p5])
  const tkB = await raise(devB.publicId, [p3])

  const tk1Issues = await reported(tk1.id)
  const subA1Id = tk1Issues.find((i) => i.subCategoryId === subA1.subCategoryId)?.id
  const resolveA1 = await update(tk1.id, { resolveIssueIds: [subA1Id] })
  assert(resolveA1.status === 201, `resolve failed: ${brief(resolveA1)}`)
  const closeTk3 = await update(tk3.id, { closeTicket: true, workDone: 'Done' })
  assert(closeTk3.status === 201 && closeTk3.body.data.status === 'Closed', `close failed: ${brief(closeTk3)}`)

  // --- 1: only ticketed slots, Slot Label order, ticket count per ticket --------
  const list = await call(`/api/slot-view?q=${encodeURIComponent(prefix)}&limit=10`, { headers: admin.auth })
  assert(list.status === 200 && list.body.success, `1: list failed: ${brief(list)}`)
  const rows = list.body.data as SlotRow[]
  assert(!rows.some((r) => r.uuid === devC.uuid), '1: a slot without tickets must not be listed')
  assert(rows.length === 2 && list.body.pagination?.total === 2, `1: expected 2 ticketed slots: ${brief(list)}`)
  assert(
    rows[0].uuid === devB.uuid && rows[1].uuid === devA.uuid,
    `1: natural Slot Label order expected (${prefix}-2 before ${prefix}-10): ${brief(list)}`,
  )
  const rowA = rows[1]
  assert(rowA.slotLabel === `${prefix}-10` && rowA.id === devA.publicId && rowA.road === road.name, '1: slot fields')
  assert(rowA.ticketCount === 3, `1: 3 tickets (one with 3 issues, one Closed) must count 3, got ${rowA.ticketCount}`)
  assert(rows[0].ticketCount === 1, '1: slot B has 1 ticket')
  console.log('OK 1 — only ticketed slots, Slot Label order, ticket count per ticket (Closed included)')

  // --- 2: pagination + search ---------------------------------------------------
  const page2 = await call(`/api/slot-view?q=${encodeURIComponent(prefix)}&limit=10&page=2`, { headers: admin.auth })
  assert(page2.status === 200 && page2.body.data.length === 0 && page2.body.pagination.total === 2, '2: page 2 empty')
  const badLimit = await call(`/api/slot-view?limit=7`, { headers: admin.auth })
  assert(badLimit.status === 400 && badLimit.body.code === 'VALIDATION_ERROR', '2: limit must be 10/25/50/100')
  const byLabel = await call(`/api/slot-view?q=${encodeURIComponent(`${prefix}-2`)}`, { headers: admin.auth })
  assert(byLabel.body.data.length === 1 && byLabel.body.data[0].uuid === devB.uuid, '2: search by Slot Label')
  console.log('OK 2 — SQL pagination, limit validation and search')

  // --- 3: detail = only Open Sub Issues, one per Sub Issue -----------------------
  const detail = await call(`/api/slot-view/${encodeURIComponent(devA.publicId)}`, { headers: admin.auth })
  assert(detail.status === 200, `3: detail failed: ${brief(detail)}`)
  const d = detail.body.data as { slot: SlotRow; ticketCount: number; unresolvedIssues: SlotIssue[] }
  assert(d.slot.uuid === devA.uuid && d.slot.slotLabel === `${prefix}-10`, '3: slot header')
  assert(d.ticketCount === 3, '3: detail ticket count')
  const subs = d.unresolvedIssues.map((i) => i.subCategoryId)
  assert(
    subs.length === 3 &&
      subs.includes(subA2.subCategoryId) &&
      subs.includes(p3.subCategoryId) &&
      subs.includes(p4.subCategoryId),
    `3: expected Open subA2, p3, p4: ${brief(detail)}`,
  )
  assert(!subs.includes(subA1.subCategoryId), '3: a Resolved Sub Issue must not appear')
  assert(!subs.includes(p5.subCategoryId), '3: issues of a Closed ticket must not appear')
  assert(d.unresolvedIssues.every((i) => i.status === 'Open'), '3: every entry is Open')
  const a2 = d.unresolvedIssues.find((i) => i.subCategoryId === subA2.subCategoryId)!
  assert(a2.categoryId === subA1.categoryId, '3: main issue stays while one of its sub issues is Open')
  assert(a2.tickets.length === 1 && a2.tickets[0].id === tk1.id, '3: issue links to its ticket')
  console.log('OK 3 — unresolved = Open reported Sub Issues only; resolved / closed excluded')

  // --- 4: same Sub Issue across tickets is listed once --------------------------
  const tk4 = await raise(devA.publicId, [subA1])
  const dup = await post('/api/tickets', admin.auth, {
    deviceId: devA.publicId,
    issues: [subA2],
    reporterType: 'Control room',
  })
  assert(dup.status === 409, '4: the same Open issue cannot open a second ticket on the slot')
  const detail4 = await call(`/api/slot-view/${devA.uuid}`, { headers: admin.auth })
  const issues4 = detail4.body.data.unresolvedIssues as SlotIssue[]
  const subs4 = issues4.map((i) => i.subCategoryId)
  assert(new Set(subs4).size === subs4.length, '4: Sub Issues must be unique')
  const a1 = issues4.find((i) => i.subCategoryId === subA1.subCategoryId)
  assert(a1 && a1.tickets.length === 1 && a1.tickets[0].id === tk4.id, '4: re-raised issue points at the new ticket')
  assert(detail4.body.data.ticketCount === 4, '4: lookup by UUID + count grows by one ticket')
  console.log('OK 4 — one entry per Sub Issue; lookup by UUID works')

  // --- 5: all tickets of the slot via the ticket list ---------------------------
  const tickets = await call(`/api/tickets?device=${encodeURIComponent(devA.publicId)}&limit=100`, {
    headers: admin.auth,
  })
  assert(tickets.status === 200, `5: ticket list failed: ${brief(tickets)}`)
  const ids = (tickets.body.data as Array<{ id: string; status: string }>).map((t) => t.id)
  assert(
    ids.length === 4 && [tk1.id, tk2.id, tk3.id, tk4.id].every((id) => ids.includes(id)),
    `5: every ticket of the slot must be listed: ${brief(tickets)}`,
  )
  assert(!ids.includes(tkB.id), '5: tickets of another slot must not be listed')
  assert(
    (tickets.body.data as Array<{ id: string; status: string }>).find((t) => t.id === tk3.id)?.status === 'Closed',
    '5: Closed ticket stays visible',
  )
  assert(tickets.body.pagination.total === 4, '5: pagination total')
  const noDevice = await call(`/api/tickets?device=NO-SUCH-${Date.now()}`, { headers: admin.auth })
  assert(noDevice.status === 200 && noDevice.body.data.length === 0, '5: unknown device lists nothing')
  console.log('OK 5 — GET /api/tickets?device= lists every ticket of the slot, Closed included')

  // --- 6: errors + authorization ------------------------------------------------
  const missing = await call(`/api/slot-view/NO-SUCH-${Date.now()}`, { headers: admin.auth })
  assert(missing.status === 404 && missing.body.code === 'NOT_FOUND', `6: unknown slot must be 404: ${brief(missing)}`)
  const noSlotTickets = await call(`/api/slot-view/${devC.publicId}`, { headers: admin.auth })
  assert(
    noSlotTickets.status === 200 &&
      noSlotTickets.body.data.ticketCount === 0 &&
      noSlotTickets.body.data.unresolvedIssues.length === 0,
    '6: existing slot without tickets returns empty sections',
  )
  assert((await call('/api/slot-view')).status === 401, '6: list needs a token')
  assert((await call(`/api/slot-view/${devA.publicId}`)).status === 401, '6: detail needs a token')

  const suffix = String(Date.now()).slice(-7) + Math.floor(Math.random() * 900 + 100)
  const role = await post('/api/roles', admin.auth, { name: `Smoke Slot View ${suffix}`, scope: 'all_roads' })
  assert(role.status === 201 && role.body.data?.id, `6: role create failed: ${brief(role)}`)
  createdRoleIds.push(role.body.data.id as string)
  const roleId = role.body.data.id as string
  const setPerms = async (permissions: Record<string, string>) => {
    const res = await call(`/api/roles/${roleId}/permissions`, {
      method: 'PATCH',
      headers: admin.auth,
      body: JSON.stringify({ permissions }),
    })
    assert(res.status === 200, `6: permission save failed: ${brief(res)}`)
  }

  const rolesList = await call('/api/roles', { headers: admin.auth })
  assert(rolesList.status === 200, `6: roles list failed: ${brief(rolesList)}`)
  const roleRows = rolesList.body.data as Array<{ id: string; name: string; permissions: Record<string, string> }>
  for (const name of ['Admin', 'Project manager']) {
    const r = roleRows.find((x) => x.name === name)
    assert(r?.permissions['Slot View']?.[0] === 'v', `6: ${name} must have Slot View v by default`)
  }
  for (const name of ['Control room', 'Technician', 'Engineer', 'Electrician', 'Site attendant', 'AMC officer']) {
    const r = roleRows.find((x) => x.name === name)
    if (r) assert(r.permissions['Slot View'] === '......', `6: ${name} must not have Slot View by default`)
  }
  const fresh = roleRows.find((x) => x.id === roleId)
  assert(fresh?.permissions['Slot View'] === '......', '6: a new role starts without Slot View')

  await setPerms({ Dashboard: 'v.....', 'All tickets': 'v.....' })
  const mobile = `94${suffix}`.slice(0, 10)
  const user = await post('/api/users', admin.auth, {
    fullName: `Smoke Slot View ${suffix}`,
    mobile,
    email: `smoke.slotview.${suffix}@yopmail.com`,
    password: 'SmokePass1',
    roleId: role.body.data.id,
    roadIds: [],
  })
  assert(user.status === 201 && user.body.data?.id, `6: user create failed: ${brief(user)}`)
  createdUserIds.push(user.body.data.id as string)
  const restricted = await login(mobile, 'SmokePass1')
  const slotPaths = ['/api/slot-view', `/api/slot-view/${devA.publicId}`]
  const ticketPath = `/api/tickets?device=${devA.publicId}`
  const expectStatus = async (path: string, status: number, why: string) => {
    const res = await call(path, { headers: restricted.auth })
    assert(res.status === status, `6: ${path} must be ${status} ${why}: ${brief(res)}`)
    if (status === 403) assert(res.body.code === 'FORBIDDEN', `6: ${path} 403 code`)
  }

  for (const path of slotPaths) await expectStatus(path, 403, 'with All tickets v but no Slot View')
  await expectStatus(ticketPath, 200, 'with All tickets v')

  await setPerms({ 'Slot View': 'v.....' })
  for (const path of slotPaths) await expectStatus(path, 200, 'once Slot View v is granted')

  await setPerms({ 'Slot View': 'v.....', 'All tickets': '......' })
  for (const path of slotPaths) await expectStatus(path, 200, 'with Slot View v only')
  await expectStatus(ticketPath, 403, 'without All tickets v')

  await setPerms({ 'Slot View': '......' })
  for (const path of slotPaths) await expectStatus(path, 403, 'after Slot View is revoked')
  console.log(
    'OK 6 — 404 unknown slot, 401 without token; Slot View defaults Admin/PM only, gate follows the Roles matrix',
  )

  console.log('\nSlot View verification passed')
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
  if (createdUserIds.length) {
    await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [createdUserIds]).catch(() => {})
  }
  if (createdRoleIds.length) {
    await query(`DELETE FROM role_permissions WHERE role_id = ANY($1::uuid[])`, [createdRoleIds]).catch(() => {})
    await query(`DELETE FROM roles WHERE id = ANY($1::uuid[])`, [createdRoleIds]).catch(() => {})
  }
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
