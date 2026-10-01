/**
 * Ticket raise / Add Update flow smoke — field roles, optional assignee at raise,
 * auto-assign on update, close-with-update, concurrency, QR, notifications.
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

  // --- A/B/C + D: each field role raises without an assignee ---------------
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
  console.log('OK A/B/C — Technician, Engineer, Electrician can raise')
  console.log('OK D — ticket created without an assignee stays unassigned')

  // --- P: field roles see unassigned open tickets they did not raise (view only) ---
  const listedIds = async (session: Session, ticketId: string) => {
    const res = await call(`/api/tickets?q=${encodeURIComponent(ticketId)}`, { headers: session.auth })
    assert(res.status === 200, `P: list failed: ${brief(res)}`)
    return (res.body.data as Array<{ id: string }>).map((r) => r.id)
  }
  assert((await listedIds(tech2, tA)).includes(tA), 'P: field role must list an unassigned open ticket')
  const pDetail = await call(`/api/tickets/${tA}`, { headers: tech2.auth })
  assert(pDetail.status === 200, `P: field role must open an unassigned ticket, got ${brief(pDetail)}`)
  const pClose = await call(`/api/tickets/${tA}/close-preview`, { headers: tech2.auth })
  assert(pClose.status === 403, `P: viewing must not grant close access, got ${brief(pClose)}`)
  const attendant = await createFieldUser(admin.auth, 'Site attendant')
  assert(!(await listedIds(attendant, tA)).includes(tA), 'P: non-field role must not list others\' tickets')
  const pAttendant = await call(`/api/tickets/${tA}`, { headers: attendant.auth })
  assert(pAttendant.status === 403, `P: non-field role detail must be 403, got ${brief(pAttendant)}`)
  console.log('OK P — field roles can view unassigned open tickets; other roles and actions unchanged')

  // --- E: raise with an assignee (and ineligible assignee rejected) --------
  const raisedE = await raise(admin, { assigneeId: tech.id })
  assert(raisedE.res.status === 201, `E: raise with assignee failed: ${brief(raisedE.res)}`)
  const tE = raisedE.res.body.data.id as string
  const rowE = await ticketRow(tE)
  assert(rowE.assignee_id === tech.id && rowE.status === 'Under repair', 'E: must be assigned + Under repair')
  const badAssignee = await raise(admin, { assigneeId: admin.id })
  assert(
    badAssignee.res.status === 400 && badAssignee.res.body.code === 'INVALID_ASSIGNEE',
    `E: ineligible assignee must be 400 INVALID_ASSIGNEE, got ${brief(badAssignee.res)}`,
  )
  const fieldPick = await raise(tech, { assigneeId: tech2.id })
  assert(
    fieldPick.res.status === 403,
    `E: field role raising with an assignee must be 403, got ${brief(fieldPick.res)}`,
  )
  const fieldPickRow = await query(`SELECT 1 FROM tickets t JOIN devices d ON d.id = t.device_id WHERE d.public_id = $1`, [
    fieldPick.deviceId,
  ])
  assert(!fieldPickRow.rowCount, 'E: rejected field-role raise must not create a ticket')
  console.log('OK E — ticket created with an assignee; ineligible assignee rejected; field role cannot assign at raise')

  // --- F + O: field user (not the raiser) updates an unassigned ticket ----
  const rowA = await ticketRow(tA)
  const f = await update(electrician, tA)
  assert(f.status === 201, `F: update failed: ${brief(f)}`)
  assert(f.body.data?.autoAssigned === true, 'F: response must report autoAssigned')
  assert(f.body.data?.assigneeId === electrician.id, 'F: response assigneeId must be the updater')
  assert((await ticketRow(tA)).assignee_id === electrician.id, 'F: ticket must be assigned to the updater')
  const fEvent = await query<{ actor_user_id: string }>(
    `SELECT actor_user_id FROM ticket_events WHERE id = $1`,
    [f.body.data.eventId],
  )
  assert(fEvent.rows[0]?.actor_user_id === electrician.id, 'F: update created_by must be the updater')
  const fTrail = await query<{ from_user_id: string | null; to_user_id: string; reason: string }>(
    `SELECT from_user_id, to_user_id, reason FROM ticket_assignments WHERE ticket_id = $1`,
    [rowA.id],
  )
  assert(
    fTrail.rows.length === 1 &&
      fTrail.rows[0].from_user_id == null &&
      fTrail.rows[0].to_user_id === electrician.id &&
      fTrail.rows[0].reason === 'Auto-assigned on update',
    'F: exactly one auto-assign trail row expected',
  )
  console.log('OK F — unassigned ticket auto-assigned to the authenticated updater')

  const fNotify = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM notifications
     WHERE recipient_user_id = $1 AND type = 'ticket.assigned'
       AND related_entity_id = $2 AND event_id = $3`,
    [electrician.id, rowA.id, f.body.data.eventId],
  )
  assert(fNotify.rows[0]?.n === 0, 'O: self-assign on update must not create a ticket.assigned notification')
  const eNotify = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM notifications
     WHERE recipient_user_id = $1 AND type = 'ticket.assigned' AND related_entity_id = $2`,
    [tech.id, rowE.id],
  )
  assert(eNotify.rows[0]?.n === 1, 'O: raise-with-assignee notification must still be created')
  console.log('OK O — self-assign on update is silent; raise-with-assignee still notifies')

  // --- G: assigned ticket keeps its assignee -------------------------------
  const g1 = await update(electrician, tA)
  assert(g1.status === 201 && g1.body.data?.autoAssigned === false, `G: second update failed: ${brief(g1)}`)
  const g2 = await update(tech, tE)
  assert(g2.status === 201 && g2.body.data?.autoAssigned === false, `G: assignee update failed: ${brief(g2)}`)
  assert((await ticketRow(tA)).assignee_id === electrician.id, 'G: assignee must stay unchanged')
  assert((await ticketRow(tE)).assignee_id === tech.id, 'G: assignee must stay unchanged')
  console.log('OK G — assigned ticket keeps its existing assignee')

  // --- H: another field user cannot update / take over an assigned ticket --
  const h = await update(tech2, tA)
  assert(h.status === 403, `H: foreign update must be 403, got ${brief(h)}`)
  assert((await ticketRow(tA)).assignee_id === electrician.id, 'H: must not reassign on rejected update')
  console.log('OK H — unauthorized user cannot update an assigned ticket')

  assert(!(await listedIds(tech2, tA)).includes(tA), 'P: once assigned, other field roles must not list it')
  const pAssigned = await call(`/api/tickets/${tA}`, { headers: tech2.auth })
  assert(pAssigned.status === 403, `P: once assigned, other field roles detail must be 403, got ${brief(pAssigned)}`)
  console.log('OK P — an assigned ticket drops out of other field roles\' view')

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

  // --- Admin/PM on unassigned must pick an assignee ------------------------
  const rowB = await ticketRow(tB)
  const adminNoPick = await update(admin, tB)
  assert(
    adminNoPick.status === 409 && adminNoPick.body.code === 'TICKET_NOT_ASSIGNED',
    `Admin without assignee must be 409 TICKET_NOT_ASSIGNED, got ${brief(adminNoPick)}`,
  )
  assert((await eventCount(rowB.id)) === 1, 'rejected update must not write an event')
  const adminBadPick = await update(admin, tB, { handoverToUserId: admin.id })
  assert(adminBadPick.status === 400 && adminBadPick.body.code === 'INVALID_ASSIGNEE', 'Admin pick must be eligible')
  const adminPick = await update(admin, tB, { handoverToUserId: tech.id })
  assert(adminPick.status === 201 && adminPick.body.data?.assigneeId === tech.id, `Admin pick failed: ${brief(adminPick)}`)
  assert((await ticketRow(tB)).assignee_id === tech.id, 'Admin pick must assign the ticket')
  const pickNotify = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM notifications
     WHERE recipient_user_id = $1 AND type = 'ticket.assigned'
       AND related_entity_id = $2 AND event_id = $3`,
    [tech.id, rowB.id, adminPick.body.data.eventId],
  )
  assert(pickNotify.rows[0]?.n === 1, 'Admin pick on update must create one ticket.assigned notification')
  console.log('OK Admin/PM assign at update time on an unassigned ticket (notifies the picked worker)')

  // Raiser who is not the holder cannot close through an update.
  const raiserClose = await update(engineer, tB, { closeTicket: true })
  assert(raiserClose.status === 403 && raiserClose.body.code === 'NOT_HOLDER', `raiser close must be 403 NOT_HOLDER, got ${brief(raiserClose)}`)
  assert((await ticketRow(tB)).status !== 'Closed', 'rejected close must keep the ticket open')
  console.log('OK close-with-update requires the ticket holder')

  // Field user cannot hand an unassigned ticket to someone else.
  const fieldHandover = await update(tech2, tC, { handoverToUserId: tech.id })
  assert(fieldHandover.status === 403, `field handover must be 403, got ${brief(fieldHandover)}`)
  assert((await ticketRow(tC)).assignee_id == null, 'rejected handover must not assign')
  console.log('OK field role cannot assign someone else while claiming')

  // --- L: auto-assign + close in one request -------------------------------
  const l = await update(tech, tC, { updateType: 'Site visit — resolved', closeTicket: true })
  assert(l.status === 201 && l.body.data?.autoAssigned === true && l.body.data?.closed === true, `L: failed: ${brief(l)}`)
  const rowL = await ticketRow(tC)
  assert(rowL.assignee_id === tech.id && rowL.status === 'Closed', 'L: must be assigned to updater and Closed')
  console.log('OK L — auto-assign + update + close in one request')

  // --- M: concurrent updates on an unassigned ticket -----------------------
  const raisedM = await raise(admin)
  const tM = raisedM.res.body.data.id as string
  const [m1, m2] = await Promise.all([update(tech2, tM), update(engineer, tM)])
  const successes = [m1, m2].filter((r) => r.status === 201)
  const losers = [m1, m2].filter((r) => r.status !== 201)
  assert(successes.length === 1, `M: exactly one concurrent update may win, got ${brief(m1)} / ${brief(m2)}`)
  assert(
    losers[0].status === 403 || (losers[0].status === 409 && losers[0].body.code === 'TICKET_ALREADY_ASSIGNED'),
    `M: loser must be rejected, got ${brief(losers[0])}`,
  )
  const rowM = await ticketRow(tM)
  assert(rowM.assignee_id === successes[0].body.data.assigneeId, 'M: persisted assignee must be the winner')
  const mTrail = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ticket_assignments WHERE ticket_id = $1`,
    [rowM.id],
  )
  assert(mTrail.rows[0]?.n === 1, 'M: exactly one assignment row expected')
  console.log('OK M — concurrent updates leave exactly one assignee')

  // --- N: QR scan → open ticket → update (auto-assign) ---------------------
  const raisedN = await raise(admin)
  const tN = raisedN.res.body.data.id as string
  const scan = await call(`/api/devices/scan?q=${encodeURIComponent(raisedN.deviceId)}`, { headers: tech2.auth })
  assert(scan.status === 200 && scan.body.data?.openTicketId === tN, `N: scan must return openTicketId: ${brief(scan)}`)
  const n = await update(tech2, scan.body.data.openTicketId as string)
  assert(n.status === 201 && n.body.data?.autoAssigned === true, `N: QR update failed: ${brief(n)}`)
  assert((await ticketRow(tN)).assignee_id === tech2.id, 'N: QR update must auto-assign the scanner')
  console.log('OK N — QR scan → existing open ticket → update works')

  // Close the leftover open smoke tickets so the devices stay clean.
  await query(
    `UPDATE tickets SET status = 'Closed', closed_at = NOW(), updated_at = NOW()
     WHERE public_id = ANY($1::text[]) AND status <> 'Closed'`,
    [[tB, tE, tM, tN]],
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
