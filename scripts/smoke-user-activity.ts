/**
 * User activity smoke — GET /api/dashboard/user-activity counts, per user, tickets raised
 * (creator), tickets updated (distinct tickets with an Add Update by the user) and tickets
 * closed (closing event's actor) over inclusive IST days. Also checks the ticket list
 * `closedAt` field used by the All tickets Closed tab.
 * Tickets are raised/updated/closed through the real endpoints, then moved to a random
 * historic date so real data never mixes into the asserted counts.
 * Never prints tokens or passwords. Run: npm run test:smoke:user-activity
 */
import 'dotenv/config'

import { createApp } from '../src/app.js'
import { closeDb, query } from '../src/db/pool.js'
import { todayIst } from '../src/lib/eod-report.js'

const app = createApp()
const server = app.listen(0)
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`

type Auth = Record<string, string>
type Session = { auth: Auth; id: string }
type ActivityUser = { userId: string | null; userName: string; role: string | null; raised: number; updated: number; closed: number }
type Activity = {
  from: string
  to: string
  range: { from: string; to: string }
  summary: { ticketsRaised: number; ticketsUpdated: number; ticketsClosed: number; activeUsers: number }
  users: ActivityUser[]
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
const touchedTickets: string[] = []

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
    fullName: `Smoke Activity ${roleName} ${suffix}`,
    mobile,
    email: `smoke.activity.${suffix}@yopmail.com`,
    password: 'SmokePass1',
    roleId: await roleId(adminAuth, roleName),
    roadIds: [],
  })
  assert(res.status === 201 && res.body.data?.id, `create ${roleName} failed: ${brief(res)}`)
  createdUserIds.push(res.body.data.id as string)
  return login(mobile, 'SmokePass1')
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const ist = (date: string, time: string) => `${date}T${time}+05:30`

/** Moves a ticket's raise and every one of its events to `at`. */
async function moveTicket(ticketId: string, at: string) {
  await query(`UPDATE tickets SET raised_at = $2, created_at = $2 WHERE public_id = $1`, [ticketId, at])
  await query(
    `UPDATE ticket_events e SET created_at = $2 FROM tickets t WHERE t.id = e.ticket_id AND t.public_id = $1`,
    [ticketId, at],
  )
}

async function setClosedAt(ticketId: string, at: string) {
  await query(`UPDATE tickets SET closed_at = $2 WHERE public_id = $1`, [ticketId, at])
  await query(
    `UPDATE ticket_events e SET created_at = $2 FROM tickets t
     WHERE t.id = e.ticket_id AND t.public_id = $1 AND e.status_label = 'Closed'`,
    [ticketId, at],
  )
}

async function main() {
  const admin = await login('9000000001', 'Password123')

  const roads = await call('/api/roads', { headers: admin.auth })
  const roadId = roads.body.data[0].id as string
  const cats = await call('/api/lookups/issue-categories', { headers: admin.auth })
  const pairs = (cats.body.data as Array<{ id: string; subs: Array<{ id: string }> }>)
    .flatMap((c) => c.subs.map((s) => ({ categoryId: c.id, subCategoryId: s.id })))
  assert(pairs.length >= 2, 'need at least 2 active issue sub-categories')
  const [issueA, issueB] = pairs

  const stamp = Date.now()
  let deviceSeq = 0
  async function raise(session: Session) {
    deviceSeq += 1
    const res0 = await post('/api/devices', admin.auth, { roadId, slotNumber: `ACT-${stamp}-${deviceSeq}`, installedOn: '2026-09-01' })
    assert(res0.status === 201, `device create failed: ${brief(res0)}`)
    const device = res0.body.data.publicId as string
    const res = await post('/api/tickets', session.auth, { deviceId: device, issues: [issueA, issueB], reporterType: 'Control room' })
    assert(res.status === 201, `raise failed: ${brief(res)}`)
    touchedTickets.push(res.body.data.id as string)
    return { id: res.body.data.id as string, device }
  }
  const update = async (session: Session, ticketId: string, extra: Record<string, unknown> = {}) => {
    const res = await post(`/api/tickets/${ticketId}/updates`, session.auth, {
      updateType: 'Site visit — not resolved',
      workDone: 'Smoke activity update',
      notFixedReason: 'Smoke',
      ...extra,
    })
    assert(res.status === 201, `update on ${ticketId} failed: ${brief(res)}`)
  }

  async function activity(session: Session, from: string, to: string): Promise<Activity> {
    const res = await call(`/api/dashboard/user-activity?from=${from}&to=${to}`, { headers: session.auth })
    assert(res.status === 200 && res.body.success === true, `activity ${from}..${to} failed: ${brief(res)}`)
    return res.body.data as Activity
  }

  let day = ''
  for (let attempt = 0; attempt < 5 && !day; attempt++) {
    const candidate = addDays('1971-01-01', Math.floor(Math.random() * 14000))
    const a = await activity(admin, addDays(candidate, -1), addDays(candidate, 1))
    if (!a.users.length && a.summary.ticketsRaised === 0 && a.summary.ticketsUpdated === 0 && a.summary.ticketsClosed === 0) {
      day = candidate
    }
  }
  assert(day, 'could not find an empty historic date')
  const prevDay = addDays(day, -1)
  const nextDay = addDays(day, 1)

  // --- A: empty range -------------------------------------------------------------
  const empty = await activity(admin, day, day)
  assert(
    empty.range.from === new Date(ist(day, '00:00:00')).toISOString() &&
      empty.range.to === new Date(ist(nextDay, '00:00:00')).toISOString(),
    `A: range must be the half-open IST day: ${JSON.stringify(empty.range)}`,
  )
  assert(!empty.users.length && empty.summary.activeUsers === 0, 'A: empty day must return no users and zero totals')
  console.log('OK A — empty range returns zero totals and no rows')

  // --- Fixtures -------------------------------------------------------------------
  const cr = await createUser(admin.auth, 'Control room')
  const tech = await createUser(admin.auth, 'Technician')
  const tech2 = await createUser(admin.auth, 'Technician')
  const attendant = await createUser(admin.auth, 'Site attendant')

  const t1 = await raise(cr) // day: tech updates twice, tech2 once, tech closes via /close
  const t2 = await raise(cr) // day: tech2 closes via update closeTicket
  const t3 = await raise(admin) // nextDay: outside a single-day range
  const t4 = await raise(cr) // prevDay: raised and updated by tech the day before

  await update(tech, t1.id)
  await update(tech, t1.id)
  await update(tech2, t1.id)
  const close1 = await post(`/api/tickets/${t1.id}/close`, tech.auth, {
    issues: [issueA],
    workDone: 'Smoke activity close',
    deviceTested: 'Yes, tested with 5 open-close cycles',
  })
  assert(close1.status === 200, `close t1 failed: ${brief(close1)}`)
  await update(tech2, t2.id, { updateType: 'Site visit — resolved', notFixedReason: undefined, closeTicket: true })
  await update(tech, t4.id)

  await moveTicket(t1.id, ist(day, '10:00:00'))
  await setClosedAt(t1.id, ist(day, '18:00:00'))
  await moveTicket(t2.id, ist(day, '23:59:59'))
  await setClosedAt(t2.id, ist(day, '23:59:59'))
  await moveTicket(t3.id, ist(nextDay, '00:00:00'))
  await moveTicket(t4.id, ist(prevDay, '12:00:00'))

  // --- B: single-day counts ------------------------------------------------------
  const a = await activity(admin, day, day)
  const row = (s: Session) => a.users.find((u) => u.userId === s.id)
  const sig = (u?: ActivityUser) => (u ? `${u.raised}/${u.updated}/${u.closed}` : 'missing')
  assert(sig(row(cr)) === '2/0/0', `B: Control room must be 2 raised, got ${sig(row(cr))}`)
  assert(sig(row(tech)) === '0/1/1', `B: tech must be 1 updated (two updates, one ticket) and 1 closed, got ${sig(row(tech))}`)
  assert(sig(row(tech2)) === '0/2/1', `B: tech2 must be 2 updated and 1 closed (close via update), got ${sig(row(tech2))}`)
  assert(!a.users.some((u) => u.userId === admin.id), 'B: admin raised only on nextDay, must not appear')
  assert(
    a.summary.ticketsRaised === 2 && a.summary.ticketsUpdated === 2 && a.summary.ticketsClosed === 2 && a.summary.activeUsers === 3,
    `B: totals must be 2/2/2 with 3 users (updated counts distinct tickets): ${JSON.stringify(a.summary)}`,
  )
  assert(row(tech)?.role === 'Technician', `B: role must be returned: ${JSON.stringify(row(tech))}`)
  console.log('OK B — raised by creator, updated as distinct tickets, closed by the closing actor; /close is not an update')

  // --- C: multi-day range --------------------------------------------------------
  const wide = await activity(admin, prevDay, nextDay)
  const wrow = (s: Session) => wide.users.find((u) => u.userId === s.id)
  assert(sig(wrow(cr)) === '3/0/0' && sig(wrow(admin)) === '1/0/0' && sig(wrow(tech)) === '0/2/1',
    `C: wide range rows wrong: cr ${sig(wrow(cr))}, admin ${sig(wrow(admin))}, tech ${sig(wrow(tech))}`)
  assert(wide.summary.ticketsRaised === 4 && wide.summary.ticketsUpdated === 3,
    `C: wide totals wrong: ${JSON.stringify(wide.summary)}`)
  console.log('OK C — multi-day range is inclusive of both end dates')

  // --- D: ticket list closedAt (All tickets Closed tab) ----------------------------
  const list1 = await call(`/api/tickets?device=${t1.device}`, { headers: admin.auth })
  const r1 = (list1.body.data as Array<{ id: string; closedAt: string | null }>).find((x) => x.id === t1.id)
  assert(r1 && new Date(r1.closedAt as string).toISOString() === new Date(ist(day, '18:00:00')).toISOString(),
    `D: closed ticket must expose closedAt: ${brief(list1)}`)
  const list4 = await call(`/api/tickets?device=${t4.device}`, { headers: admin.auth })
  const r4 = (list4.body.data as Array<{ id: string; closedAt: string | null }>).find((x) => x.id === t4.id)
  assert(r4 && r4.closedAt === null, `D: open ticket closedAt must be null: ${brief(list4)}`)
  console.log('OK D — ticket list returns closedAt for closed tickets only')

  // --- E: validation --------------------------------------------------------------
  for (const qs of [
    'from=abc&to=2026-01-01',
    'from=2026-02-30&to=2026-03-01',
    `from=${nextDay}&to=${day}`,
    'from=2024-01-01&to=2025-12-31',
    `from=${day}&to=${day}&user=${tech.id}`,
    `date=${day}&to=${day}`,
  ]) {
    const res = await call(`/api/dashboard/user-activity?${qs}`, { headers: admin.auth })
    assert(res.status === 400 && res.body.code === 'VALIDATION_ERROR', `E: "${qs}" must be 400, got ${brief(res)}`)
  }
  const dflt = await call('/api/dashboard/user-activity', { headers: admin.auth })
  assert(dflt.status === 200 && dflt.body.data.from === todayIst() && dflt.body.data.to === todayIst(),
    `E: no dates must default to today IST: ${brief(dflt)}`)
  const onlyFrom = await call(`/api/dashboard/user-activity?from=${day}`, { headers: admin.auth })
  assert(onlyFrom.status === 200 && onlyFrom.body.data.to === day, `E: only from must mean that one day: ${brief(onlyFrom)}`)
  console.log('OK E — bad dates, reversed or >366-day ranges and unknown params return 400; defaults to today (IST)')

  // --- F: authorization -----------------------------------------------------------
  const anon = await call(`/api/dashboard/user-activity?from=${day}&to=${day}`)
  assert(anon.status === 401, `F: no token must be 401, got ${brief(anon)}`)
  for (const [label, session] of [['Site attendant', attendant], ['Technician', tech]] as const) {
    const res = await call(`/api/dashboard/user-activity?from=${day}&to=${day}`, { headers: session.auth })
    assert(res.status === 403, `F: ${label} without Dashboard v must be 403, got ${brief(res)}`)
  }
  console.log('OK F — no token 401; roles without Dashboard v 403')

  console.log('\nUser activity verification passed')
}

async function cleanup() {
  if (touchedTickets.length) {
    await query(
      `UPDATE tickets SET status = 'Closed', closed_at = raised_at, updated_at = NOW()
       WHERE public_id = ANY($1::text[]) AND status <> 'Closed'`,
      [touchedTickets],
    ).catch(() => {})
    await query(
      `UPDATE ticket_issues ti SET status = 'Resolved', resolved_at = t.closed_at
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
