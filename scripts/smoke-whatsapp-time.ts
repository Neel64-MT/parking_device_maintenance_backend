/**
 * WhatsApp time (migration 028): raise / update / close accept an optional `whatsappAt`,
 * and the list, detail, device detail and export return it (NULL when not given).
 * Runs against an isolated PGlite database. Never prints tokens/passwords.
 */
import 'dotenv/config'
import { createApp } from '../src/app.js'
import { closeDb } from '../src/db/pool.js'

const app = createApp()
const server = app.listen(0)
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const text = await res.text()
  let body: any = text
  try {
    body = JSON.parse(text)
  } catch {
    /* CSV export */
  }
  return { status: res.status, body }
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

const sameInstant = (a: unknown, b: string) => a != null && new Date(String(a)).getTime() === new Date(b).getTime()

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
  const issue = { categoryId: cats.body.data[0].id, subCategoryId: cats.body.data[0].subs[0].id }

  async function newDevice(tag: string) {
    const device = await call('/api/devices', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ roadId, slotNumber: `WA-${tag}-${Date.now()}`, installedOn: '2026-09-01' }),
    })
    assert(device.status === 201, `device create failed: ${device.status}`)
    return device.body.data.publicId as string
  }
  const raise = (deviceId: string, extra: Record<string, unknown> = {}) =>
    call('/api/tickets', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ deviceId, issues: [issue], reporterType: 'Control room', ...extra }),
    })

  // Raise without WhatsApp time: stays NULL, created time is returned for the UI fallback.
  const plainDevice = await newDevice('plain')
  const plain = await raise(plainDevice)
  assert(plain.status === 201, `raise failed: ${plain.status} ${JSON.stringify(plain.body)}`)
  const plainDetail = await call(`/api/tickets/${plain.body.data.id}`, { headers: auth })
  assert(plainDetail.body.data.header.whatsappAt === null, 'raise without whatsappAt must stay NULL')
  assert(plainDetail.body.data.header.createdAt, 'detail must return createdAt')
  assert(plainDetail.body.data.workHistory[0].whatsappAt === null, 'raised event must stay NULL')
  console.log('OK raise without WhatsApp time stays empty')

  // Raise with WhatsApp time.
  const raisedAt = '2026-10-08T10:15:00+05:30'
  const waDevice = await newDevice('wa')
  const wa = await raise(waDevice, { whatsappAt: raisedAt })
  assert(wa.status === 201, `raise with whatsappAt failed: ${wa.status} ${JSON.stringify(wa.body)}`)
  const ticketId = wa.body.data.id as string

  // Update with and without WhatsApp time.
  const updateAt = '2026-10-08T12:40:00+05:30'
  const upd = await call(`/api/tickets/${ticketId}/updates`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ updateType: 'Remote check', workDone: 'Checked remotely', whatsappAt: updateAt }),
  })
  assert(upd.status === 201, `update failed: ${upd.status} ${JSON.stringify(upd.body)}`)
  const upd2 = await call(`/api/tickets/${ticketId}/updates`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ updateType: 'Remote check', workDone: 'Second check' }),
  })
  assert(upd2.status === 201, `update without whatsappAt failed: ${upd2.status}`)

  // Under repair tab shows Assigned to: no assignee, so the person who added the latest update.
  const me = await call('/api/auth/me', { headers: auth })
  const adminName = me.body.data.name || me.body.data.fullName
  const urp = await call(`/api/tickets?device=${encodeURIComponent(waDevice)}`, { headers: auth })
  const urpRow = urp.body.data[0]
  assert(urpRow.assignedTo && urpRow.assignedTo === adminName, `assignedTo expected ${adminName}, got ${urpRow.assignedTo}`)
  assert(urpRow.closedBy === null, 'open ticket must have no closedBy')
  console.log('OK Under repair row shows Assigned to (latest updater)')

  // Rejected values write nothing.
  const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString()
  for (const bad of [future, 'not a date']) {
    const r = await call(`/api/tickets/${ticketId}/updates`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ updateType: 'Remote check', whatsappAt: bad }),
    })
    assert(r.status === 400, `whatsappAt "${bad}" must be rejected, got ${r.status}`)
  }
  const badRaise = await raise(await newDevice('bad'), { whatsappAt: future })
  assert(badRaise.status === 400, `future whatsappAt on raise must be rejected, got ${badRaise.status}`)
  console.log('OK future / invalid WhatsApp time rejected with 400')

  const closeAt = '2026-10-09T07:05:00+05:30'
  const closed = await call(`/api/tickets/${ticketId}/close`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      issues: [issue],
      workDone: 'Fixed',
      deviceTested: 'Yes, tested with 5 open-close cycles',
      whatsappAt: closeAt,
    }),
  })
  assert(closed.status === 200, `close failed: ${closed.status} ${JSON.stringify(closed.body)}`)

  const detail = await call(`/api/tickets/${ticketId}`, { headers: auth })
  const h = detail.body.data.header
  assert(sameInstant(h.whatsappAt, raisedAt), `header.whatsappAt expected ${raisedAt}, got ${h.whatsappAt}`)
  const byType = (t: string) => detail.body.data.workHistory.filter((e: { eventType: string }) => e.eventType === t)
  assert(sameInstant(byType('raised')[0].whatsappAt, raisedAt), 'raised event whatsappAt mismatch')
  const visits = byType('visit_open')
  assert(visits.length === 2, `expected 2 visits, got ${visits.length}`)
  assert(visits.some((e: { whatsappAt: string | null }) => sameInstant(e.whatsappAt, updateAt)), 'update whatsappAt missing')
  assert(visits.some((e: { whatsappAt: string | null }) => e.whatsappAt === null), 'update without whatsappAt must stay NULL')
  assert(sameInstant(byType('closed')[0].whatsappAt, closeAt), 'closed event whatsappAt mismatch')
  console.log('OK detail returns WhatsApp time on header, raised, update and close events')

  const list = await call(`/api/tickets?device=${encodeURIComponent(waDevice)}`, { headers: auth })
  const row = list.body.data.find((r: { id: string }) => r.id === ticketId)
  assert(row && sameInstant(row.whatsappAt, raisedAt) && row.createdAt, `list row missing whatsappAt/createdAt: ${JSON.stringify(row)}`)
  assert(row.closedBy === adminName, `closedBy expected ${adminName}, got ${row.closedBy}`)
  console.log('OK Closed row shows Closed by')
  const plainList = await call(`/api/tickets?device=${encodeURIComponent(plainDevice)}`, { headers: auth })
  const plainRow = plainList.body.data[0]
  assert(plainRow.whatsappAt === null && plainRow.createdAt, 'plain list row must have NULL whatsappAt and createdAt')
  console.log('OK list rows return whatsappAt and createdAt')

  const dev = await call(`/api/devices/${waDevice}`, { headers: auth })
  assert(sameInstant(dev.body.data.tickets[0].whatsappAt, raisedAt), 'device detail tickets[].whatsappAt mismatch')
  console.log('OK device detail returns whatsappAt')

  const csv = await call('/api/tickets/export', { headers: auth })
  assert(String(csv.body).split('\n')[0].endsWith('Reported time'), 'export must have a Reported time column')
  console.log('OK export has a Reported time column')

  console.log('\nWhatsApp time verification passed')
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
