/**
 * Ticket soft-delete verification (Phase 60).
 * Confirms DELETE /api/tickets/:id soft-deletes a ticket (any status), drops it out of the
 * list / tiles / Slot View / device status / EOD report, is idempotent (second delete 404s),
 * frees the one-open-issue-per-device index for a re-raise, preserves history, and is enforced
 * by the All tickets `d` flag (granted to every role; a role with `d` revoked gets 403).
 * Runs against the isolated PGlite database. Never prints tokens/passwords.
 * Run: npm run test:smoke:ticket-delete
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

async function login(identifier: string): Promise<Auth> {
  const res = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier, password: 'Password123' }),
  })
  assert(res.status === 200 && res.body.data?.token, `login failed for ${identifier}`)
  return { Authorization: `Bearer ${res.body.data.token as string}` }
}

let seq = 0
async function createDevice(auth: Auth, roadId: string): Promise<string> {
  const res = await call('/api/devices', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ roadId, slotNumber: `DEL-${Date.now()}-${seq++}`, installedOn: '2026-09-01' }),
  })
  assert(res.status === 201, `device create failed: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body.data.publicId as string
}

async function raise(auth: Auth, deviceId: string, issue: { categoryId: string; subCategoryId: string }) {
  const res = await call('/api/tickets', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ deviceId, issues: [issue], reporterType: 'Control room' }),
  })
  assert(res.status === 201, `raise failed: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body.data.id as string
}

async function main() {
  const admin = await login('9000000001')

  const roads = await call('/api/roads', { headers: admin })
  const roadId = roads.body.data[0].id as string
  const cats = await call('/api/lookups/issue-categories', { headers: admin })
  const issue = { categoryId: cats.body.data[0].id, subCategoryId: cats.body.data[0].subs[0].id }

  // --- Core soft-delete flow ---
  const deviceId = await createDevice(admin, roadId)
  const ticketId = await raise(admin, deviceId, issue)

  // Before delete: the slot shows exactly one ticket.
  const slotBefore = await call(`/api/slot-view/${encodeURIComponent(deviceId)}`, { headers: admin })
  assert(slotBefore.body.data?.ticketCount === 1, `slot ticketCount before delete should be 1, got ${slotBefore.body.data?.ticketCount}`)

  const del = await call(`/api/tickets/${ticketId}`, { method: 'DELETE', headers: admin })
  assert(del.status === 200, `delete failed: ${del.status} ${JSON.stringify(del.body)}`)
  assert(del.body.message === 'Ticket deleted', `unexpected delete message: ${del.body.message}`)
  assert(del.body.data?.id === ticketId, 'delete should echo the public id')
  console.log('OK delete returned 200')

  // History preserved: events/issues rows still exist, flagged on issues.
  const keptEvents = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ticket_events WHERE ticket_id = (SELECT id FROM tickets WHERE public_id = $1)`,
    [ticketId],
  )
  assert(keptEvents.rows[0].n >= 1, 'history (ticket_events) must be preserved on soft delete')
  const flaggedIssues = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM ticket_issues
     WHERE ticket_id = (SELECT id FROM tickets WHERE public_id = $1) AND deleted_at IS NULL`,
    [ticketId],
  )
  assert(flaggedIssues.rows[0].n === 0, 'all ticket_issues of a deleted ticket must be flagged deleted')
  console.log('OK history preserved, issue rows flagged deleted')

  // GET + every mutate route on a deleted ticket → 404.
  const getDeleted = await call(`/api/tickets/${ticketId}`, { headers: admin })
  assert(getDeleted.status === 404, `GET deleted ticket should 404, got ${getDeleted.status}`)
  const upd = await call(`/api/tickets/${ticketId}/updates`, {
    method: 'POST', headers: admin, body: JSON.stringify({ updateType: 'Remote check' }),
  })
  assert(upd.status === 404, `update on deleted ticket should 404, got ${upd.status}`)
  const prev = await call(`/api/tickets/${ticketId}/close-preview`, { headers: admin })
  assert(prev.status === 404, `close-preview on deleted ticket should 404, got ${prev.status}`)
  const close = await call(`/api/tickets/${ticketId}/close`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ issues: [issue], workDone: 'x', deviceTested: 'Yes, tested' }),
  })
  assert(close.status === 404, `close on deleted ticket should 404, got ${close.status}`)
  console.log('OK GET/update/close/close-preview on deleted ticket all 404')

  // Idempotent: a second delete 404s.
  const del2 = await call(`/api/tickets/${ticketId}`, { method: 'DELETE', headers: admin })
  assert(del2.status === 404, `second delete should 404, got ${del2.status}`)
  console.log('OK second delete is idempotent 404')

  // Deleted ticket is absent from the list (search by its id returns nothing).
  const list = await call(`/api/tickets?q=${encodeURIComponent(ticketId)}&limit=50`, { headers: admin })
  const found = (list.body.data || []).some((r: { id: string }) => r.id === ticketId)
  assert(!found, 'deleted ticket must not appear in the ticket list')
  console.log('OK deleted ticket excluded from the list')

  // Device returns to Working (its only open ticket is gone).
  const dev = await call(`/api/devices/${encodeURIComponent(deviceId)}`, { headers: admin })
  assert(
    String(dev.body.data?.header?.status || '').toLowerCase() === 'working',
    `device should be Working after its only ticket is deleted, got ${dev.body.data?.header?.status}`,
  )
  console.log('OK device status back to Working')

  // Slot View count excludes the deleted ticket.
  const slotAfter = await call(`/api/slot-view/${encodeURIComponent(deviceId)}`, { headers: admin })
  assert(slotAfter.body.data?.ticketCount === 0, `slot ticketCount after delete should be 0, got ${slotAfter.body.data?.ticketCount}`)
  console.log('OK Slot View count excludes the deleted ticket')

  // EOD report (today, IST) must not list the deleted ticket.
  const day = todayIst()
  const eod = await call(`/api/dashboard/eod-report?from=${day}&to=${day}`, { headers: admin })
  const inEod = (eod.body.data?.raised || []).some((r: { ticketId: string }) => r.ticketId === ticketId)
  assert(!inEod, 'deleted ticket must not appear in the EOD report')
  console.log('OK EOD report excludes the deleted ticket')

  // The one-open-issue-per-device index is freed: the same issue can be raised again.
  const reraise = await call('/api/tickets', {
    method: 'POST', headers: admin,
    body: JSON.stringify({ deviceId, issues: [issue], reporterType: 'Control room' }),
  })
  assert(reraise.status === 201, `re-raise of the same issue should succeed, got ${reraise.status} ${JSON.stringify(reraise.body)}`)
  console.log('OK same issue can be re-raised after delete (unique index freed)')

  // --- Authorization: a non-admin role with `d` can delete; revoking `d` → 403 ---
  const tech = await login('9099941128') // Ramesh Vaghela, Technician (granted All tickets d by default)
  const devT = await createDevice(admin, roadId)
  const ticketT = await raise(admin, devT, issue)
  const techDel = await call(`/api/tickets/${ticketT}`, { method: 'DELETE', headers: tech })
  assert(techDel.status === 200, `Technician with d should delete, got ${techDel.status} ${JSON.stringify(techDel.body)}`)
  console.log('OK non-admin role (Technician) with d can delete')

  // Revoke d from the Technician role, re-login, and confirm a delete is refused (403).
  const rolesList = await call('/api/roles', { headers: admin })
  const techRole = rolesList.body.data.find((r: { name: string }) => r.name === 'Technician')
  assert(techRole, 'Technician role not found')
  const patch = await call(`/api/roles/${techRole.id}/permissions`, {
    method: 'PATCH', headers: admin,
    body: JSON.stringify({ permissions: { 'All tickets': 'v.....' } }),
  })
  assert(patch.status === 200, `revoke d failed: ${patch.status} ${JSON.stringify(patch.body)}`)

  const techNoD = await login('9099941128') // fresh token reloads permissions
  const devT2 = await createDevice(admin, roadId)
  const ticketT2 = await raise(admin, devT2, issue)
  const refused = await call(`/api/tickets/${ticketT2}`, { method: 'DELETE', headers: techNoD })
  assert(refused.status === 403, `Technician without d should be refused, got ${refused.status}`)
  console.log('OK backend refuses delete (403) when the role lacks d')

  // Restore the Technician d flag (disposable DB, but keep it tidy).
  await call(`/api/roles/${techRole.id}/permissions`, {
    method: 'PATCH', headers: admin,
    body: JSON.stringify({ permissions: { 'All tickets': 'v....d' } }),
  })

  console.log('\nTicket delete verification passed')
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
