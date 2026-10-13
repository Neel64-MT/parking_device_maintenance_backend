/**
 * EOD report smoke — GET /api/dashboard/eod-report counts tickets raised (by creator) and
 * tickets closed (by the closing event's actor) inside a half-open IST day.
 * Tickets are raised/closed through the real endpoints, then their timestamps are moved to
 * a random historic date so real data never mixes into the asserted counts.
 * Never prints tokens or passwords. Run: npm run test:smoke:eod-report
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
type EodTicket = { ticketId: string; slotId: number | null; slotLabel: string; userId: string | null; userName: string }
type EodUser = { userId: string | null; userName: string; slots: string[]; raised: number; closed: number }
type EodReport = {
  date: string
  timezone: string
  range: { from: string; to: string }
  summary: { ticketsRaised: number; ticketsClosed: number; usersRaised: number; usersClosed: number }
  raised: EodTicket[]
  closed: EodTicket[]
  users: EodUser[]
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

async function createUser(adminAuth: Auth, roleName: string, fullName?: string): Promise<Session> {
  const suffix = String(Date.now()).slice(-7) + Math.floor(Math.random() * 900 + 100)
  const mobile = `93${suffix}`.slice(0, 10)
  const res = await post('/api/users', adminAuth, {
    fullName: fullName || `Smoke EOD ${roleName} ${suffix}`,
    mobile,
    email: `smoke.eod.${suffix}@yopmail.com`,
    password: 'SmokePass1',
    roleId: await roleId(adminAuth, roleName),
    roadIds: [],
  })
  assert(res.status === 201 && res.body.data?.id, `create ${roleName} failed: ${brief(res)}`)
  createdUserIds.push(res.body.data.id as string)
  return login(mobile, 'SmokePass1')
}

/** YYYY-MM-DD shifted by whole days (calendar arithmetic in UTC, no timezone drift). */
function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const ist = (date: string, time: string) => `${date}T${time}+05:30`

async function setRaisedAt(ticketId: string, at: string) {
  await query(
    `UPDATE tickets SET raised_at = $2, created_at = $2 WHERE public_id = $1`,
    [ticketId, at],
  )
  await query(
    `UPDATE ticket_events e SET created_at = $2 FROM tickets t
     WHERE t.id = e.ticket_id AND t.public_id = $1 AND e.event_type = 'raised'`,
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
  assert(pairs.length >= 3, 'need at least 3 active issue sub-categories')
  const [issueA, issueB, issueC] = pairs

  const stamp = Date.now()
  let deviceSeq = 0
  const slotLabels: string[] = []
  async function newDevice() {
    deviceSeq += 1
    const slotNumber = `EOD-${stamp}-${deviceSeq}`
    const res = await post('/api/devices', admin.auth, { roadId, slotNumber, installedOn: '2026-09-01' })
    assert(res.status === 201, `device create failed: ${brief(res)}`)
    slotLabels.push(slotNumber)
    return { publicId: res.body.data.publicId as string, slotNumber }
  }

  async function raise(session: Session, issues = [issueA]) {
    const device = await newDevice()
    const res = await post('/api/tickets', session.auth, {
      deviceId: device.publicId,
      issues,
      reporterType: 'Control room',
    })
    assert(res.status === 201, `raise failed: ${brief(res)}`)
    touchedTickets.push(res.body.data.id as string)
    return { id: res.body.data.id as string, uuid: res.body.data.uuid as string, slot: device.slotNumber }
  }

  async function report(session: Session, date: string): Promise<EodReport> {
    const res = await call(`/api/dashboard/eod-report?date=${date}`, { headers: session.auth })
    assert(res.status === 200 && res.body.success === true, `report ${date} failed: ${brief(res)}`)
    return res.body.data as EodReport
  }

  // Random historic date (1971–2009) so no real or earlier-run activity falls inside it.
  let day = ''
  for (let attempt = 0; attempt < 5 && !day; attempt++) {
    const candidate = addDays('1971-01-01', Math.floor(Math.random() * 14000))
    const [prev, cur, next] = await Promise.all([
      report(admin, addDays(candidate, -1)),
      report(admin, candidate),
      report(admin, addDays(candidate, 1)),
    ])
    if ([prev, cur, next].every((r) => r.summary.ticketsRaised === 0 && r.summary.ticketsClosed === 0)) day = candidate
  }
  assert(day, 'could not find an empty historic date')
  const prevDay = addDays(day, -1)
  const nextDay = addDays(day, 1)

  // --- A: empty day is a valid zero report --------------------------------------
  const empty = await report(admin, day)
  assert(empty.date === day && empty.timezone === 'Asia/Kolkata', `A: wrong date/timezone: ${JSON.stringify(empty)}`)
  assert(
    empty.range.from === new Date(ist(day, '00:00:00')).toISOString() &&
      empty.range.to === new Date(ist(nextDay, '00:00:00')).toISOString(),
    `A: range must be the half-open IST day: ${JSON.stringify(empty.range)}`,
  )
  assert(
    empty.summary.ticketsRaised === 0 && empty.summary.ticketsClosed === 0 &&
      empty.summary.usersRaised === 0 && empty.summary.usersClosed === 0 &&
      empty.raised.length === 0 && empty.closed.length === 0 && empty.users.length === 0,
    'A: empty day must return zeros and empty lists',
  )
  console.log('OK A — empty day returns a zero report with the IST half-open range')

  // --- Fixtures -------------------------------------------------------------------
  const twinName = `Smoke EOD Twin ${stamp}`
  const twinA = await createUser(admin.auth, 'Control room', twinName)
  const twinB = await createUser(admin.auth, 'Control room', twinName)
  const tech = await createUser(admin.auth, 'Technician')
  const tech2 = await createUser(admin.auth, 'Technician')
  const attendant = await createUser(admin.auth, 'Site attendant')

  const t1 = await raise(twinA, [issueA, issueB, issueC]) // day 10:00, 3 issues, closed by tech via /close
  const t2 = await raise(twinA, [issueA, issueB]) // day 23:59:59 (inside), all issues resolved but not closed
  const t3 = await raise(twinB) // nextDay 00:00:00 (outside day, inside nextDay)
  const t4 = await raise(twinB) // day 12:00
  const t5 = await raise(twinA) // prevDay 12:00, closed on day 09:00 by tech2 via update closeTicket
  const t6 = await raise(twinB) // prevDay 23:59:59 (outside day)
  const t7 = await raise(admin) // closed on day 20:00 by direct SQL: no closing event

  const close1 = await post(`/api/tickets/${t1.id}/close`, tech.auth, {
    issues: [issueA],
    workDone: 'Smoke EOD close',
    deviceTested: 'Yes, tested with 5 open-close cycles',
  })
  assert(close1.status === 200, `close t1 failed: ${brief(close1)}`)

  const t2Detail = await call(`/api/tickets/${t2.id}`, { headers: tech.auth })
  const t2Issues = (t2Detail.body.data.issuesReported as Array<{ id: string }>).map((i) => i.id)
  const resolveAll = await post(`/api/tickets/${t2.id}/updates`, tech.auth, {
    updateType: 'Site visit — resolved',
    workDone: 'Smoke EOD resolve all',
    resolveIssueIds: t2Issues,
  })
  assert(resolveAll.status === 201 && resolveAll.body.data.openIssueCount === 0 && resolveAll.body.data.status !== 'Closed',
    `resolve-all on t2 failed: ${brief(resolveAll)}`)

  const close5 = await post(`/api/tickets/${t5.id}/updates`, tech2.auth, {
    updateType: 'Site visit — resolved',
    workDone: 'Smoke EOD close via update',
    closeTicket: true,
  })
  assert(close5.status === 201 && close5.body.data.status === 'Closed', `close t5 failed: ${brief(close5)}`)

  await query(
    `UPDATE tickets SET status = 'Closed', closed_at = $2, updated_at = NOW() WHERE public_id = $1`,
    [t7.id, ist(day, '20:00:00')],
  )
  await query(
    `UPDATE ticket_issues SET status = 'Resolved', resolved_at = $2 WHERE ticket_id = $1 AND status = 'Open'`,
    [t7.uuid, ist(day, '20:00:00')],
  )

  await setRaisedAt(t1.id, ist(day, '10:00:00'))
  await setRaisedAt(t2.id, ist(day, '23:59:59'))
  await setRaisedAt(t3.id, ist(nextDay, '00:00:00'))
  await setRaisedAt(t4.id, ist(day, '12:00:00'))
  await setRaisedAt(t5.id, ist(prevDay, '12:00:00'))
  await setRaisedAt(t6.id, ist(prevDay, '23:59:59'))
  await setRaisedAt(t7.id, ist(addDays(day, -3), '08:00:00'))
  await setClosedAt(t1.id, ist(day, '18:00:00'))
  await setClosedAt(t5.id, ist(day, '09:00:00'))

  // A second, older closing event on t1 (e.g. a racing close) must neither double-count
  // the ticket nor replace the latest closer.
  await query(
    `INSERT INTO ticket_events (ticket_id, event_type, title, status_label, actor_user_id, created_at)
     VALUES ($1, 'closed', 'Ticket closed', 'Closed', $2, $3)`,
    [t1.uuid, tech2.id, ist(day, '17:00:00')],
  )

  const r = await report(admin, day)
  const raisedIds = r.raised.map((x) => x.ticketId).sort()
  const closedIds = r.closed.map((x) => x.ticketId).sort()

  // --- B: tickets raised on the day, with exact boundaries -----------------------
  assert(raisedIds.join() === [t1.id, t2.id, t4.id].sort().join(), `B: raised must be t1, t2, t4, got ${raisedIds}`)
  assert(r.summary.ticketsRaised === 3, `B: ticketsRaised must be 3, got ${r.summary.ticketsRaised}`)
  console.log('OK B — raised counts include 23:59:59 IST and exclude 00:00 next day / previous day')

  // --- C: a 3-issue ticket counts once ------------------------------------------
  assert(r.raised.filter((x) => x.ticketId === t1.id).length === 1, 'C: t1 must appear once in raised')
  assert(r.closed.filter((x) => x.ticketId === t1.id).length === 1, 'C: t1 must appear once in closed')
  console.log('OK C — multiple issues and duplicate closing events do not inflate ticket counts')

  // --- D: tickets closed on the day; resolving every issue is not closing ---------
  assert(closedIds.join() === [t1.id, t5.id, t7.id].sort().join(), `D: closed must be t1, t5, t7, got ${closedIds}`)
  assert(r.summary.ticketsClosed === 3, `D: ticketsClosed must be 3, got ${r.summary.ticketsClosed}`)
  assert(!closedIds.includes(t2.id), 'D: t2 has every issue resolved but is not closed')
  console.log('OK D — closed counts cover both close paths; resolving all issues alone is not counted')

  // --- E: closer = actor of the latest closing event, never the raiser -----------
  const closer = (id: string) => r.closed.find((x) => x.ticketId === id)
  assert(closer(t1.id)?.userId === tech.id, `E: t1 closer must be tech (latest closing event), got ${JSON.stringify(closer(t1.id))}`)
  assert(closer(t5.id)?.userId === tech2.id, `E: t5 closer must be tech2 (update closeTicket), got ${JSON.stringify(closer(t5.id))}`)
  assert(closer(t7.id)?.userId === null && closer(t7.id)?.userName === 'Not recorded', 'E: closed without an event must be Not recorded')
  const raiser = (id: string) => r.raised.find((x) => x.ticketId === id)
  assert(raiser(t1.id)?.userId === twinA.id && raiser(t4.id)?.userId === twinB.id, 'E: raiser must be raised_by_user_id')
  assert(r.summary.usersRaised === 2 && r.summary.usersClosed === 2, `E: distinct users wrong: ${JSON.stringify(r.summary)}`)
  console.log('OK E — completion is attributed to the closing actor; unrecorded closers are not guessed')

  // --- F: same display name stays two rows; slots deduplicated -----------------
  const rowsFor = (id: string | null) => r.users.filter((u) => u.userId === id)
  const twinRows = r.users.filter((u) => u.userName === twinName)
  assert(twinRows.length === 2, `F: two users with the same name must be two rows, got ${twinRows.length}`)
  const aRow = rowsFor(twinA.id)[0]
  const bRow = rowsFor(twinB.id)[0]
  assert(aRow?.raised === 2 && aRow.closed === 0, `F: twinA must be 2 raised / 0 closed: ${JSON.stringify(aRow)}`)
  assert(aRow.slots.join() === [t1.slot, t2.slot].join(), `F: twinA slots must be t1+t2 in natural order: ${aRow.slots}`)
  assert(bRow?.raised === 1 && bRow.closed === 0 && bRow.slots.join() === t4.slot, `F: twinB wrong: ${JSON.stringify(bRow)}`)
  const techRow = rowsFor(tech.id)[0]
  assert(techRow?.raised === 0 && techRow.closed === 1 && techRow.slots.join() === t1.slot, `F: tech wrong: ${JSON.stringify(techRow)}`)
  const tech2Row = rowsFor(tech2.id)[0]
  assert(tech2Row?.raised === 0 && tech2Row.closed === 1 && tech2Row.slots.join() === t5.slot, `F: tech2 wrong: ${JSON.stringify(tech2Row)}`)
  const noneRow = rowsFor(null)[0]
  assert(noneRow?.userName === 'Not recorded' && noneRow.closed === 1, `F: Not recorded row wrong: ${JSON.stringify(noneRow)}`)
  assert(r.users.length === 5, `F: expected 5 user rows, got ${r.users.length}`)
  const sumRaised = r.users.reduce((n, u) => n + u.raised, 0)
  const sumClosed = r.users.reduce((n, u) => n + u.closed, 0)
  assert(sumRaised === r.summary.ticketsRaised && sumClosed === r.summary.ticketsClosed, 'F: user rows must add up to the summary')
  console.log('OK F — user rows key on user id, dedupe slots, and add up to the summary')

  // --- G: raised one day, closed another → each date's own section --------------
  const prev = await report(admin, prevDay)
  assert(prev.raised.map((x) => x.ticketId).sort().join() === [t5.id, t6.id].sort().join(), `G: prevDay raised must be t5, t6`)
  assert(prev.summary.ticketsClosed === 0, 'G: prevDay has no closes')
  const next = await report(admin, nextDay)
  assert(next.raised.map((x) => x.ticketId).join() === t3.id && next.summary.ticketsClosed === 0, 'G: nextDay must be t3 raised only')
  console.log('OK G — a ticket raised one day and closed the next appears in each day\'s own section')

  // --- H: validation ------------------------------------------------------------
  for (const bad of ['abc', '2026-02-30', '2026-1-5', '13-10-2026', '']) {
    const res = await call(`/api/dashboard/eod-report?date=${encodeURIComponent(bad)}`, { headers: admin.auth })
    assert(res.status === 400 && res.body.code === 'VALIDATION_ERROR', `H: date "${bad}" must be 400, got ${brief(res)}`)
  }
  const extra = await call(`/api/dashboard/eod-report?date=${day}&user=${twinA.id}`, { headers: admin.auth })
  assert(extra.status === 400, `H: unknown query params must be 400, got ${brief(extra)}`)
  const dflt = await call('/api/dashboard/eod-report', { headers: admin.auth })
  assert(dflt.status === 200 && dflt.body.data.date === todayIst(), `H: missing date must default to today IST: ${brief(dflt)}`)
  console.log('OK H — malformed dates and unknown params return 400; missing date defaults to today (IST)')

  // --- I: authorization ---------------------------------------------------------
  const anon = await call(`/api/dashboard/eod-report?date=${day}`)
  assert(anon.status === 401, `I: no token must be 401, got ${brief(anon)}`)
  for (const [label, session] of [['Site attendant', attendant], ['Technician', tech]] as const) {
    const res = await call(`/api/dashboard/eod-report?date=${day}`, { headers: session.auth })
    assert(res.status === 403, `I: ${label} without Dashboard v must be 403, got ${brief(res)}`)
  }
  const crView = await report(twinA, day)
  assert(crView.summary.ticketsRaised === r.summary.ticketsRaised, 'I: Control room (Dashboard v) sees the same report')
  console.log('OK I — no token 401; roles without Dashboard v 403; Dashboard viewers get the same data')

  console.log('\nEOD report verification passed')
}

async function cleanup() {
  if (touchedTickets.length) {
    // Close leftovers at their own (historic) raise time so today's real report is untouched.
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
