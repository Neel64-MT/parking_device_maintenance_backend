/**
 * Focused verification for the Close Ticket page wiring.
 * Confirms the real close API accepts the exact payload the frontend now sends
 * and that the ticket becomes Closed (one closed event, device back to working).
 * Runs against an isolated PGlite database. Never prints tokens/passwords.
 */
import 'dotenv/config'
import { createApp } from '../src/app.js'
import { closeDb, query } from '../src/db/pool.js'

const app = createApp()
const server = app.listen(0)
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

async function main() {
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9000000001', password: 'Password123' }),
  })
  assert(login.status === 200, 'admin login failed')
  const auth = { Authorization: `Bearer ${login.body.data.token as string}` }

  const roads = await call('/api/roads', { headers: auth })
  const roadId = roads.body.data[0].id as string

  const cats = await call('/api/lookups/issue-categories', { headers: auth })
  const reported = { categoryId: cats.body.data[0].id, subCategoryId: cats.body.data[0].subs[0].id }
  const pairs = cats.body.data.flatMap((c: { id: string; subs: { id: string }[] }) =>
    c.subs.map((s) => ({ categoryId: c.id, subCategoryId: s.id })),
  )
  const found = pairs.find((p) => p.subCategoryId !== reported.subCategoryId)
  assert(found, 'need a second subcategory for the confirmed issue')

  const partsRes = await call('/api/parts', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: `Close Smoke Part ${Date.now()}`, amount: 400 }),
  })
  const partId = partsRes.body.data.id as string

  const device = await call('/api/devices', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      roadId,
      slotNumber: `CLOSE-${Date.now()}`,
      installedOn: '2026-09-01',
    }),
  })
  assert(device.status === 201, `device create failed: ${device.status}`)

  const ticket = await call('/api/tickets', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      deviceId: device.body.data.publicId,
      issues: [reported],
      reporterType: 'Control room',
    }),
  })
  assert(ticket.status === 201, `raise failed: ${ticket.status} ${JSON.stringify(ticket.body)}`)
  const ticketId = ticket.body.data.id as string

  // Exact payload shape produced by frontend closeTicket().
  const closeBody = {
    issues: [found],
    workDone: 'Replaced the faulty assembly and verified 5 open-close cycles.',
    cost: 100,
    parts: [partId],
    photos: [],
    deviceTested: 'Yes, tested with 5 open-close cycles',
  }

  const closed = await call(`/api/tickets/${ticketId}/close`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(closeBody),
  })
  assert(
    closed.status === 200 && closed.body.data?.status === 'Closed',
    `close failed: ${closed.status} ${JSON.stringify(closed.body)}`,
  )
  assert(closed.body.data?.cost === 500, `close cost expected 500 got ${closed.body.data?.cost}`)
  assert(closed.body.data?.labourCost === 100, 'close labourCost mismatch')
  assert(closed.body.data?.partsCost === 400, 'close partsCost mismatch')
  assert(
    closed.body.data?.issuesFound?.[0]?.subCategoryId === found.subCategoryId,
    'close must persist the confirmed issue',
  )
  console.log('OK close accepted the frontend payload')

  const detail = await call(`/api/tickets/${ticketId}`, { headers: auth })
  assert(detail.body.data?.header?.status === 'Closed', 'detail must show Closed')
  const closedEvents = detail.body.data.workHistory.filter(
    (e: { eventType: string }) => e.eventType === 'closed',
  )
  assert(closedEvents.length === 1, `expected exactly 1 closed event, got ${closedEvents.length}`)
  console.log('OK ticket detail is Closed with one closed event')

  const deviceDetail = await call(`/api/devices/${device.body.data.publicId}`, { headers: auth })
  assert(
    String(deviceDetail.body.data?.header?.status || '').toLowerCase() === 'working',
    `device should be back to working, got ${deviceDetail.body.data?.header?.status}`,
  )
  console.log('OK device returned to Working after close')

  // Closing again must be rejected.
  const again = await call(`/api/tickets/${ticketId}/close`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(closeBody),
  })
  assert(again.status === 409 && again.body.code === 'CLOSED', 're-close must return 409 CLOSED')
  console.log('OK re-close rejected with 409 CLOSED')

  // "Not tested" must be rejected.
  const dev2 = await call('/api/devices', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ roadId, slotNumber: `CLOSE2-${Date.now()}`, installedOn: '2026-09-01' }),
  })
  const t2 = await call('/api/tickets', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ deviceId: dev2.body.data.publicId, issues: [reported], reporterType: 'Control room' }),
  })
  const notTested = await call(`/api/tickets/${t2.body.data.id}/close`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ ...closeBody, deviceTested: 'Not tested — keep the ticket open' }),
  })
  assert(notTested.status === 400 && notTested.body.code === 'NOT_TESTED', 'not-tested must be 400')
  console.log('OK not-tested close rejected with 400 NOT_TESTED')

  const leaked = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ticket_events WHERE ticket_id =
       (SELECT id FROM tickets WHERE public_id = $1) AND event_type = 'closed'`,
    [t2.body.data.id],
  )
  assert(leaked.rows[0]?.n === 0, 'rejected close must not create a closed event')

  console.log('\nClose ticket verification passed')
  server.close()
  await closeDb()
  process.exit(0)
}

main().catch(async (err) => {
  console.error(err)
  server.close()
  await closeDb()
  process.exit(1)
})
