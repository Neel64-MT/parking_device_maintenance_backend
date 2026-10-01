/**
 * Ticket raise / Add Update flow smoke — field roles raise, any user with Update ticket `e`
 * updates (tickets have no holder), close-with-update, concurrency, QR.
 * Assignment-removal cases live in smoke-no-assignment.ts.
 * Requires migrations applied (Electrician role). Never prints tokens or passwords.
 * Run: npm run test:smoke:ticket-flow
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

async function createFieldUser(adminAuth: Auth, roleName: string): Promise<Session> {
  const roles = await call('/api/roles', { headers: adminAuth })
  const roleId = (roles.body.data as Array<{ id: string; name: string }>).find(
    (r) => r.name === roleName,
  )?.id
  assert(roleId, `${roleName} role not found — run npm run db:migrate`)
  const suffix = String(Date.now()).slice(-7) + Math.floor(Math.random() * 900 + 100)
  const mobile = `93${suffix}`.slice(0, 10)
  const res = await post('/api/users', adminAuth, {
    fullName: `Smoke ${roleName} ${suffix}`,
    mobile,
    email: `smoke.flow.${suffix}@yopmail.com`,
    password: 'SmokePass1',
    roleId,
    roadIds: [],
  })
  assert(res.status === 201 && res.body.data?.id, `create ${roleName} failed: ${brief(res)}`)
  createdUserIds.push(res.body.data.id as string)
  return login(mobile, 'SmokePass1')
}

async function ticketRow(publicId: string) {
  const r = await query<{ id: string; status: string; assignee_id: string | null; closed_at: Date | null }>(
    `SELECT id, status, assignee_id, closed_at FROM tickets WHERE public_id = $1`,
    [publicId],
  )
  return r.rows[0]
}

async function eventCount(ticketUuid: string) {
  const r = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ticket_events WHERE ticket_id = $1`,
    [ticketUuid],
  )
  return r.rows[0]?.n ?? 0
}

async function main() {
  const admin = await login('9000000001', 'Password123')

  const roads = await call('/api/roads', { headers: admin.auth })
  const roadId = roads.body.data[0].id as string
  const cats = await call('/api/lookups/issue-categories', { headers: admin.auth })
  const issue = { categoryId: cats.body.data[0].id, subCategoryId: cats.body.data[0].subs[0].id }

  let deviceSeq = 0
  async function newDevice() {
    deviceSeq += 1
    const res = await post('/api/devices', admin.auth, {
      roadId,
      slotNumber: `FLOW-${Date.now()}-${deviceSeq}`,
      installedOn: '2026-09-01',
    })
    assert(res.status === 201, `device create failed: ${brief(res)}`)
    return res.body.data.publicId as string
  }

  async function raise(session: Session, extra: Record<string, unknown> = {}) {
    const deviceId = await newDevice()
    const res = await post('/api/tickets', session.auth, {
      deviceId,
      issues: [issue],
      reporterType: 'Control room',
      ...extra,
    })
    return { res, deviceId }
  }

  const update = (session: Session, ticketId: string, payload: Record<string, unknown> = {}) =>
    post(`/api/tickets/${ticketId}/updates`, session.auth, {
      updateType: 'Site visit — not resolved',
      workDone: 'Smoke flow update',
      ...payload,
    })

  const tech = await createFieldUser(admin.auth, 'Technician')
  const tech2 = await createFieldUser(admin.auth, 'Technician')
  const engineer = await createFieldUser(admin.auth, 'Engineer')
  const electrician = await createFieldUser(admin.auth, 'Electrician')

  // --- A/B/C: each field role raises (always Open, never assigned) ----------
  const raisedA = await raise(tech)
  assert(raisedA.res.status === 201, `A: Technician raise failed: ${brief(raisedA.res)}`)
  const raisedB = await raise(engineer)
  assert(raisedB.res.status === 201, `B: Engineer raise failed: ${brief(raisedB.res)}`)
  const raisedC = await raise(electrician)
  assert(raisedC.res.status === 201, `C: Electrician raise failed: ${brief(raisedC.res)}`)
  const tA = raisedA.res.body.data.id as string
  const tB = raisedB.res.body.data.id as string
  const tC = raisedC.res.body.data.id as string
  for (const id of [tA, tB, tC]) {
    const row = await ticketRow(id)
    assert(row.status === 'Open' && row.assignee_id == null, `D: ${id} must be Open + unassigned`)
  }
  console.log('OK A/B/C — Technician, Engineer, Electrician can raise; tickets start Open with no assignee')

  // --- F: a field user who did not raise the ticket updates it ---------------
  const rowA = await ticketRow(tA)
  const f = await update(electrician, tA)
  assert(f.status === 201, `F: update failed: ${brief(f)}`)
  assert((await ticketRow(tA)).assignee_id == null, 'F: an update must never assign the ticket')
  const fEvent = await query<{ actor_user_id: string }>(
    `SELECT actor_user_id FROM ticket_events WHERE id = $1`,
    [f.body.data.eventId],
  )
  assert(fEvent.rows[0]?.actor_user_id === electrician.id, 'F: update created_by must be the updater')
  const h = await update(tech2, tA)
  assert(h.status === 201, `F: any other field user may update too, got ${brief(h)}`)
  console.log('OK F — any field user updates any open ticket; the author is recorded, nobody is assigned')

  // --- I / K: closeTicket false or omitted keeps the ticket open -----------
  const i = await update(electrician, tA, { closeTicket: false })
  assert(i.status === 201 && i.body.data?.closed === false, `I: update failed: ${brief(i)}`)
  assert((await ticketRow(tA)).status === 'Under repair', 'I: ticket must remain open')
  const k = await update(electrician, tA, { updateType: 'Site visit — resolved' })
  assert(k.status === 201 && k.body.data?.resolvedReady === true, `K: resolved update failed: ${brief(k)}`)
  const rowK = await ticketRow(tA)
  assert(rowK.status === 'Under repair' && rowK.closed_at == null, 'K: resolved update without closeTicket stays open')
  console.log('OK I — closeTicket=false keeps the ticket open')
  console.log('OK K — request without closeTicket (even resolved) keeps the ticket open')

  // --- J: closeTicket true closes with one event in the trail --------------
  const beforeJ = await eventCount(rowA.id)
  const j = await update(electrician, tA, {
    updateType: 'Site visit — resolved',
    workDone: 'Fixed and verified',
    closeTicket: true,
  })
  assert(j.status === 201 && j.body.data?.status === 'Closed' && j.body.data?.closed === true, `J: close failed: ${brief(j)}`)
  const rowJ = await ticketRow(tA)
  assert(rowJ.status === 'Closed' && rowJ.closed_at != null, 'J: ticket must be Closed with closed_at')
  assert((await eventCount(rowA.id)) === beforeJ + 1, 'J: close-with-update must create exactly one event')
  const detailJ = await call(`/api/tickets/${tA}`, { headers: electrician.auth })
  const latest = detailJ.body.data?.workHistory?.[0]
  assert(
    latest?.status === 'Closed' && latest?.eventType === 'visit_resolved' && latest?.workDone === 'Fixed and verified',
    'J: closing update must appear in the ticket trail',
  )
  const photos = await call(`/api/tickets/${tA}/updates/${j.body.data.eventId}/photos`, {
    method: 'PATCH',
    headers: electrician.auth,
    body: JSON.stringify({ photos: ['/uploads/smoke-flow.jpg'] }),
  })
  assert(photos.status === 200, `J: photo attach after close must succeed: ${brief(photos)}`)
  const afterClose = await update(electrician, tA)
  assert(afterClose.status === 409 && afterClose.body.code === 'CLOSED', 'J: closed ticket rejects updates')
  console.log('OK J — closeTicket=true saves the update and closes the ticket')

  // --- L: the raiser (not anyone's "holder") closes through an update -------
  const l = await update(engineer, tB, { updateType: 'Site visit — resolved', closeTicket: true })
  assert(l.status === 201 && l.body.data?.closed === true, `L: close-with-update failed: ${brief(l)}`)
  assert((await ticketRow(tB)).status === 'Closed', 'L: ticket must be Closed')
  console.log('OK L — any user with Update ticket x closes through an update')

  // --- M: concurrent updates by two users both succeed ---------------------
  const raisedM = await raise(admin)
  const tM = raisedM.res.body.data.id as string
  const rowM = await ticketRow(tM)
  const [m1, m2] = await Promise.all([update(tech2, tM), update(engineer, tM)])
  assert(m1.status === 201 && m2.status === 201, `M: both concurrent updates must succeed, got ${brief(m1)} / ${brief(m2)}`)
  assert((await eventCount(rowM.id)) === 3, 'M: both updates must be in the trail (raise + 2)')
  console.log('OK M — concurrent updates on one ticket both succeed')

  // --- N: QR scan → open ticket → update -----------------------------------
  const raisedN = await raise(admin)
  const tN = raisedN.res.body.data.id as string
  const scan = await call(`/api/devices/scan?q=${encodeURIComponent(raisedN.deviceId)}`, { headers: tech2.auth })
  assert(scan.status === 200 && scan.body.data?.openTicketId === tN, `N: scan must return openTicketId: ${brief(scan)}`)
  const n = await update(tech2, scan.body.data.openTicketId as string)
  assert(n.status === 201, `N: QR update failed: ${brief(n)}`)
  assert((await ticketRow(tN)).assignee_id == null, 'N: QR update must not assign the scanner')
  console.log('OK N — QR scan → existing open ticket → update works')

  // Close the leftover open smoke tickets so the devices stay clean.
  await query(
    `UPDATE tickets SET status = 'Closed', closed_at = NOW(), updated_at = NOW()
     WHERE public_id = ANY($1::text[]) AND status <> 'Closed'`,
    [[tC, tM, tN]],
  )
  // A Closed ticket never keeps Open issues (and they would block re-raising that issue).
  await query(
    `UPDATE ticket_issues ti SET status = 'Resolved', resolved_at = NOW()
     FROM tickets t
     WHERE t.id = ti.ticket_id AND t.public_id = ANY($1::text[])
       AND ti.role = 'reported' AND ti.status = 'Open'`,
    [[tC, tM, tN]],
  )

  console.log('\nTicket update flow verification passed')
}

main()
  .then(async () => {
    await deleteSmokeUsers(createdUserIds)
    server.close()
    await closeDb()
    process.exit(0)
  })
  .catch(async (err) => {
    console.error(err)
    await deleteSmokeUsers(createdUserIds).catch(() => {})
    server.close()
    await closeDb()
    process.exit(1)
  })
