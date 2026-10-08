/**
 * In-process smoke tests — never prints tokens or passwords.
 * Run: npx tsx scripts/smoke-inprocess.ts
 */
import 'dotenv/config'

import { createApp } from '../src/app.js'
import {
  createRawResetToken,
  hashResetToken,
  issuePasswordResetToken,
} from '../src/lib/auth.js'
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
  const body = await res.json()
  return { status: res.status, body }
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

/** Remove smoke-created users so Users list / lookups stay clean. */
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

async function main() {
  const health = await call('/api/health')
  assert(health.status === 200 && health.body.success, 'health failed')

  const login = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9825012345', password: 'Password123' }),
  })
  assert(login.status === 200 && login.body.success && login.body.data?.token, 'login failed')
  const token = login.body.data.token as string

  const emailLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'alkesh.patel@yopmail.com', password: 'Password123' }),
  })
  assert(emailLogin.status === 200 && emailLogin.body.success && emailLogin.body.data?.token, 'email login failed')

  const auth = { Authorization: `Bearer ${token}` }

  // Ensure smoke fixtures exist (DB may drift after Device Sync / prior writes)
  // Prefer Science City so seeded technician (Ramesh) can scan PD-0428
  const science = await query<{ id: string }>(`SELECT id FROM roads WHERE name = 'Science City' LIMIT 1`)
  const anyRoad = await query<{ id: string }>(`SELECT id FROM roads ORDER BY name LIMIT 1`)
  const fixtureRoadId = science.rows[0]?.id || anyRoad.rows[0]?.id
  assert(fixtureRoadId, 'need at least one road for smoke fixtures')
  // Align field roles with DEFAULT_ROLE_PERMS (DB may have drifted Device list create)
  await query(
    `UPDATE role_permissions rp
     SET can_create = FALSE
     FROM roles r
     WHERE rp.role_id = r.id
       AND r.name IN ('Technician', 'Engineer')
       AND rp.screen = 'Device list'
       AND rp.can_create = TRUE`,
  )
  await query(
    `INSERT INTO devices (public_id, qr_code, road_id, slot_number, model, installed_on, install_status, latitude, longitude)
     SELECT 'PD-0428', 'QR-PD0428', $1, 'S2-114', 'Flap barrier — 4 wheeler', '2026-04-02', 'Working', '23.079200', '72.497500'
     WHERE NOT EXISTS (SELECT 1 FROM devices WHERE public_id = 'PD-0428')`,
    [fixtureRoadId],
  )
  await query(
    `UPDATE devices SET
       road_id = $1,
       latitude = COALESCE(latitude, '23.079200'),
       longitude = COALESCE(longitude, '72.497500'),
       slot_id = NULL
     WHERE public_id = 'PD-0428'`,
    [fixtureRoadId],
  )
  const cats = await query<{ cid: string; sid: string }>(
    `SELECT c.id AS cid, s.id AS sid
     FROM issue_categories c
     JOIN issue_subcategories s ON s.category_id = c.id
     WHERE s.active = TRUE
     ORDER BY c.name, s.name LIMIT 1`,
  )
  assert(cats.rows[0], 'need issue category/sub for TK-1042 fixture')
  const me = await query<{ id: string }>(
    `SELECT id FROM users WHERE mobile = '9825012345' LIMIT 1`,
  )
  const forceClosed = await query<{ id: string }>(
    `UPDATE tickets SET status = 'Closed', closed_at = COALESCE(closed_at, NOW()), updated_at = NOW()
     WHERE device_id = (SELECT id FROM devices WHERE public_id = 'PD-0428')
       AND status <> 'Closed'
       AND public_id <> 'TK-1042'
     RETURNING id`,
  )
  // A Closed ticket never keeps Open issues (RULES Phase 49 / 50).
  if (forceClosed.rows.length) {
    await query(
      `UPDATE ticket_issues SET status = 'Resolved', resolved_at = NOW()
       WHERE ticket_id = ANY($1::uuid[]) AND role = 'reported' AND status = 'Open'`,
      [forceClosed.rows.map((r) => r.id)],
    )
  }
  const tkExists = await query(`SELECT 1 FROM tickets WHERE public_id = 'TK-1042'`)
  // The fixture is reset to a freshly raised ticket: `Open` with no assignee (tickets are never
  // assigned since Phase 51), so the device card and the All Tickets tiles agree on it.
  if (!tkExists.rowCount) {
    await query(
      `INSERT INTO tickets (
         public_id, device_id, status, reporter_type, description,
         reported_category_id, reported_subcategory_id, raised_by_user_id, raised_at
       ) VALUES (
         'TK-1042', (SELECT id FROM devices WHERE public_id = 'PD-0428'),
         'Open', 'Site attendant', 'Smoke fixture open ticket',
         $1, $2, $3, NOW() - INTERVAL '3 days'
       )`,
      [cats.rows[0].cid, cats.rows[0].sid, me.rows[0].id],
    )
  } else {
    await query(
      `UPDATE tickets SET
         device_id = (SELECT id FROM devices WHERE public_id = 'PD-0428'),
         status = 'Open',
         assignee_id = NULL,
         closed_at = NULL,
         updated_at = NOW()
       WHERE public_id = 'TK-1042'`,
    )
  }
  // The re-opened fixture keeps one Open reported issue, like a ticket raised through the API.
  await query(
    `INSERT INTO ticket_issues (ticket_id, device_id, role, category_id, subcategory_id, sort_order)
     SELECT t.id, t.device_id, 'reported', t.reported_category_id, t.reported_subcategory_id, 0
     FROM tickets t
     WHERE t.public_id = 'TK-1042'
       AND t.reported_subcategory_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM ticket_issues ti WHERE ti.ticket_id = t.id AND ti.role = 'reported'
       )`,
  )
  await query(
    `UPDATE ticket_issues SET status = 'Open', resolved_at = NULL, resolved_by_user_id = NULL, resolved_event_id = NULL
     WHERE ticket_id = (SELECT id FROM tickets WHERE public_id = 'TK-1042') AND role = 'reported'`,
  )

  const paths = [
    '/api/auth/me',
    '/api/dashboard',
    '/api/tickets',
    '/api/notifications',
    '/api/notifications/unread-count',
    '/api/notifications/push-config',
    '/api/devices',
    '/api/roads',
    '/api/issues',
    '/api/users',
    '/api/roles',
    '/api/reports/work?view=day',
    '/api/lookups/roads',
    '/api/lookups/parts',
    '/api/lookups/issue-categories',
    '/api/devices/scan?q=PD-0428',
    '/api/tickets/TK-1042',
    '/api/devices/PD-0428',
  ]

  for (const path of paths) {
    const r = await call(path, { headers: auth })
    assert(r.status === 200 && r.body.success, `${path} => ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`)
    console.log('OK', path)
  }

  const scan = await call('/api/devices/scan?q=PD-0428', { headers: auth })
  assert(scan.status === 200 && scan.body.success, 'scan recheck failed')
  const scanData = scan.body.data as Record<string, unknown>
  for (const key of [
    'deviceId',
    'deviceName',
    'locationSite',
    'slot',
    'currentStatus',
    'statusDate',
    'ticketsLast6Months',
    'openTicketId',
    'openTicketAge',
    'openTicketIssue',
    'latitude',
    'longitude',
  ]) {
    assert(key in scanData, `scan missing field ${key}`)
  }
  assert(scanData.deviceId === 'PD-0428', 'scan deviceId mismatch')
  assert(typeof scanData.latitude === 'string' && scanData.latitude, 'scan latitude required')
  assert(typeof scanData.longitude === 'string' && scanData.longitude, 'scan longitude required')
  assert(scanData.openTicketId === 'TK-1042', 'PD-0428 should have open TK-1042')
  assert(typeof scanData.openTicketAge === 'string' && scanData.openTicketAge, 'openTicketAge required when open')
  console.log('OK scan canonical payload')

  const qrRow = await query<{ qr_code: string }>(
    `SELECT qr_code FROM devices WHERE public_id = 'PD-0428'`,
  )
  assert(qrRow.rows[0]?.qr_code, 'PD-0428 qr_code missing')
  const qrScan = await call(`/api/devices/scan?q=${encodeURIComponent(qrRow.rows[0].qr_code)}`, {
    headers: auth,
  })
  assert(qrScan.status === 200 && qrScan.body.success, 'scan by QR number failed')
  assert(qrScan.body.data?.openTicketId === 'TK-1042', 'QR scan must return open TK-1042')
  assert(qrScan.body.data?.qrNumber === qrRow.rows[0].qr_code, 'QR scan qrNumber mismatch')
  console.log('OK scan by QR number openTicketId')

  const paddedQr = await call(
    `/api/devices/scan?q=${encodeURIComponent(`  ${qrRow.rows[0].qr_code}  `)}`,
    { headers: auth },
  )
  assert(paddedQr.status === 200 && paddedQr.body.success, 'padded QR scan must trim and succeed')
  assert(paddedQr.body.data?.openTicketId === 'TK-1042', 'padded QR scan openTicketId')
  console.log('OK scan trims QR input')

  // Device with no open ticket → message for update path
  const quietDev = await query<{ public_id: string }>(
    `SELECT d.public_id FROM devices d
     WHERE NOT EXISTS (
       SELECT 1 FROM tickets t WHERE t.device_id = d.id AND t.status <> 'Closed'
     )
     LIMIT 1`,
  )
  if (quietDev.rows[0]) {
    const noOt = await call(`/api/devices/scan?q=${encodeURIComponent(quietDev.rows[0].public_id)}`, {
      headers: auth,
    })
    if (noOt.status === 200) {
      assert(noOt.body.data?.openTicketId == null, 'expected no open ticket')
      assert(
        noOt.body.message === 'No tickets available',
        `expected No tickets available message, got ${noOt.body.message}`,
      )
      console.log('OK scan no-open-ticket message')
    }
  }

  const missingUpdate = await call('/api/tickets/TK-DOES-NOT-EXIST/updates', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      updateType: 'Site visit — not resolved',
      workDone: 'n/a',
      cost: 0,
      parts: [],
      photos: [],
    }),
  })
  assert(
    missingUpdate.status === 404 && missingUpdate.body.code === 'NO_TICKETS_AVAILABLE',
    `update missing ticket must be NO_TICKETS_AVAILABLE: ${missingUpdate.status} ${missingUpdate.body.code}`,
  )
  assert(
    missingUpdate.body.error === 'No tickets available',
    'update missing ticket error text',
  )
  console.log('OK update no tickets available')

  // Dual identity: legacy PD-xxxx when no slot_id; Slot Id preferred when set
  await query(`UPDATE devices SET slot_id = NULL WHERE public_id = 'PD-0428'`)
  const legacyPd = await call('/api/devices/PD-0428', { headers: auth })
  assert(legacyPd.status === 200 && legacyPd.body.success, 'legacy PD-0428 history failed')
  assert(legacyPd.body.data?.header?.id === 'PD-0428', 'legacy header.id must be PD-0428 when no slot_id')
  assert(legacyPd.body.data?.header?.publicId === 'PD-0428', 'legacy header.publicId')
  assert(
    legacyPd.body.data?.header?.slotId == null,
    'PD-0428 must remain without slot_id for legacy smoke',
  )
  const legacyTicket = await call('/api/tickets/TK-1042', { headers: auth })
  assert(legacyTicket.status === 200 && legacyTicket.body.success, 'TK-1042 detail failed')
  assert(
    legacyTicket.body.data?.header?.deviceId === 'PD-0428',
    'TK-1042 deviceId must stay PD-0428 when device has no slot_id',
  )
  console.log('OK legacy PD-xxxx device identity')

  const testSlotId = 9001001
  await query(`UPDATE devices SET slot_id = NULL WHERE slot_id = $1`, [testSlotId])
  await query(`UPDATE devices SET slot_id = $1 WHERE public_id = 'PD-0428'`, [testSlotId])
  const slotHistory = await call(`/api/devices/${testSlotId}`, { headers: auth })
  assert(
    slotHistory.status === 200 && slotHistory.body.success,
    `GET /api/devices/${testSlotId} failed: ${slotHistory.status} ${JSON.stringify(slotHistory.body).slice(0, 200)}`,
  )
  assert(
    slotHistory.body.data?.header?.id === String(testSlotId),
    'slot history header.id must be Slot Id',
  )
  assert(
    slotHistory.body.data?.header?.publicId === 'PD-0428',
    'slot history header.publicId must remain PD-0428',
  )
  assert(
    slotHistory.body.data?.header?.slotId === testSlotId,
    'slot history header.slotId mismatch',
  )
  const slotTicket = await call('/api/tickets/TK-1042', { headers: auth })
  assert(slotTicket.status === 200 && slotTicket.body.success, 'TK-1042 detail failed after slot_id')
  assert(
    slotTicket.body.data?.header?.deviceId === String(testSlotId),
    'TK-1042 deviceId must equal slot_id when present',
  )
  assert(
    slotTicket.body.data?.header?.slotId === testSlotId,
    'TK-1042 slotId must be numeric Slot Id',
  )
  const slotList = await call(`/api/tickets?q=${testSlotId}&limit=25`, { headers: auth })
  assert(slotList.status === 200 && slotList.body.success, 'tickets search by slot_id failed')
  const slotListRow = (slotList.body.data as Array<{ id: string; deviceId: string; slotId: number | null }>).find(
    (t) => t.id === 'TK-1042',
  )
  assert(slotListRow, 'TK-1042 must appear in search by slot_id')
  assert(slotListRow!.deviceId === String(testSlotId), 'list deviceId must equal slot_id')
  assert(slotListRow!.slotId === testSlotId, 'list slotId must equal Slot Id')
  console.log('OK Slot Id device / ticket identity')

  const patchBySlot = await call(`/api/devices/${testSlotId}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ remarks: 'slot-id-identity-smoke' }),
  })
  assert(patchBySlot.status === 200 && patchBySlot.body.success, 'PATCH by Slot Id failed')
  assert(patchBySlot.body.data?.id === String(testSlotId), 'PATCH response id must prefer Slot Id')
  assert(patchBySlot.body.data?.publicId === 'PD-0428', 'PATCH response publicId must stay PD-0428')
  assert(patchBySlot.body.data?.slotId === testSlotId, 'PATCH response slotId mismatch')
  // Clear smoke slot_id so later seed-style PD asserts stay valid
  await query(`UPDATE devices SET slot_id = NULL WHERE public_id = 'PD-0428'`)
  const roadsForCreate = await call('/api/lookups/roads', { headers: auth })
  const createRoadId = (roadsForCreate.body.data as Array<{ id: string }>)?.[0]?.id
  assert(createRoadId, 'need a road for create-device smoke')
  const createDevice = await call('/api/devices', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      roadId: createRoadId,
      slotNumber: `SMOKE-${Date.now()}`,
      installedOn: '2024-01-15',
    }),
  })
  assert(
    createDevice.status === 201 && createDevice.body.success,
    `POST /api/devices failed: ${createDevice.status} ${JSON.stringify(createDevice.body).slice(0, 200)}`,
  )
  assert(
    typeof createDevice.body.data?.publicId === 'string' &&
      createDevice.body.data.publicId.startsWith('PD-'),
    'create must return publicId PD-xxxx',
  )
  assert(
    createDevice.body.data?.id === createDevice.body.data?.publicId,
    'create without slot_id: id must equal publicId',
  )
  assert(createDevice.body.data?.slotId == null, 'manual create must not invent slotId')
  console.log('OK add/edit device Slot Id response shape')

  // Pagination: defaults, allowed limits, invalid, page nav (PM = city-wide)
  const tickDefault = await call('/api/tickets', { headers: auth })
  assert(tickDefault.status === 200 && tickDefault.body.success, 'tickets default page failed')
  assert(tickDefault.body.pagination?.page === 1, 'tickets default page must be 1')
  assert(tickDefault.body.pagination?.limit === 10, 'tickets default limit must be 10')
  assert(
    Array.isArray(tickDefault.body.data) && tickDefault.body.data.length <= 10,
    'tickets default page size exceeded',
  )
  console.log('OK tickets default pagination')

  const tick25 = await call('/api/tickets?limit=25', { headers: auth })
  assert(tick25.status === 200 && tick25.body.pagination?.limit === 25, 'tickets limit=25 failed')
  const tickBadLimit = await call('/api/tickets?limit=15', { headers: auth })
  assert(tickBadLimit.status === 400, 'tickets limit=15 must be 400')
  const tickBadPage = await call('/api/tickets?page=0', { headers: auth })
  assert(tickBadPage.status === 400, 'tickets page=0 must be 400')
  console.log('OK tickets limit validation')

  const tickPage2 = await call('/api/tickets?page=2&limit=10', { headers: auth })
  assert(tickPage2.status === 200 && tickPage2.body.success, 'tickets page=2 failed')
  assert(tickPage2.body.pagination?.page === 2, 'tickets page 2 metadata')
  assert(
    Array.isArray(tickPage2.body.data) && tickPage2.body.data.length <= 10,
    'tickets page 2 size',
  )
  if (tickDefault.body.pagination.total > 10) {
    assert(tickPage2.body.pagination.total === tickDefault.body.pagination.total, 'page total stable')
  }
  console.log('OK tickets page navigation')

  const devDefault = await call('/api/devices', { headers: auth })
  assert(devDefault.status === 200 && devDefault.body.pagination?.limit === 10, 'devices default limit 10')
  assert(devDefault.body.pagination?.page === 1, 'devices default page 1')
  const devBad = await call('/api/devices?limit=200', { headers: auth })
  assert(devBad.status === 400, 'devices limit=200 must be 400')
  console.log('OK devices default pagination')

  const devBadStatus = await call('/api/devices?status=broken', { headers: auth })
  assert(devBadStatus.status === 400, 'devices status=broken must be 400')
  const unfilteredTiles = await call('/api/devices?limit=10', { headers: auth })
  assert(unfilteredTiles.status === 200 && Array.isArray(unfilteredTiles.body.tiles), 'devices tiles required')
  const tileMap = Object.fromEntries(
    (unfilteredTiles.body.tiles as Array<{ label: string; value: string }>).map((t) => [
      t.label,
      Number(t.value),
    ]),
  )
  const workingList = await call('/api/devices?status=Working&limit=10', { headers: auth })
  assert(workingList.status === 200 && workingList.body.success, 'devices status=Working failed')
  assert(
    Array.isArray(workingList.body.data) &&
      workingList.body.data.every((d: { status: string }) => d.status === 'Working'),
    'Working filter must return only Working rows',
  )
  assert(workingList.body.pagination?.limit === 10, 'Working filter pagination')
  const workingTiles = Object.fromEntries(
    (workingList.body.tiles as Array<{ label: string; value: string }>).map((t) => [
      t.label,
      Number(t.value),
    ]),
  )
  assert(
    workingTiles['Total devices'] === tileMap['Total devices'] &&
      workingTiles.Working === tileMap.Working &&
      workingTiles['Under repair'] === tileMap['Under repair'] &&
      workingTiles['Not working'] === tileMap['Not working'],
    'status filter must not collapse status-card tile counts',
  )
  for (const status of ['Under repair', 'Not working'] as const) {
    const filtered = await call(`/api/devices?status=${encodeURIComponent(status)}&limit=10`, {
      headers: auth,
    })
    assert(filtered.status === 200 && filtered.body.success, `devices status=${status} failed`)
    assert(
      Array.isArray(filtered.body.data) &&
        filtered.body.data.every((d: { status: string }) => d.status === status),
      `${status} filter must return only matching rows`,
    )
  }
  console.log('OK devices status-card filter')

  // Device list order: Slot Label (slot_number) ascending, and stable across pages.
  const slotLabels: string[] = []
  for (const page of [1, 2]) {
    const devPage = await call(`/api/devices?page=${page}&limit=10`, { headers: auth })
    assert(devPage.status === 200 && devPage.body.success, `devices page=${page} failed`)
    for (const row of devPage.body.data as Array<{ slotLabel: string | null }>) {
      if (row.slotLabel) slotLabels.push(row.slotLabel)
    }
  }
  const slotLabelsSorted = [...slotLabels].sort((a, b) => a.localeCompare(b))
  assert(
    JSON.stringify(slotLabels) === JSON.stringify(slotLabelsSorted),
    `device list must be Slot Label ascending across pages (${slotLabels.join(',')})`,
  )
  console.log('OK devices Slot Label ascending')

  const partsLookup = await call('/api/lookups/parts', { headers: auth })
  assert(partsLookup.status === 200 && Array.isArray(partsLookup.body.data), 'lookups parts failed')
  assert(
    partsLookup.body.data.length === 0 ||
      typeof partsLookup.body.data[0].amount === 'number',
    'lookups parts must include amount',
  )
  const partsApi = await call('/api/parts', { headers: auth })
  assert(partsApi.status === 200 && Array.isArray(partsApi.body.data), 'GET /api/parts failed')
  assert(
    partsApi.body.data.length === 0 || typeof partsApi.body.data[0].amount === 'number',
    'GET /api/parts must include amount',
  )
  console.log('OK parts amount on list/lookups')

  const bad = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'abc', password: 'x' }),
  })
  assert(bad.status === 400, 'expected validation 400')
  console.log('OK validation 400')

  const wrong = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9825012345', password: 'wrong-password' }),
  })
  assert(wrong.status === 401, 'expected invalid credentials 401')
  console.log('OK invalid credentials 401')

  const unauth = await call('/api/dashboard')
  assert(unauth.status === 401, 'expected 401')
  console.log('OK unauthorized 401')

  // Forgot password — no enumeration
  const forgotKnown = await call('/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email: 'alkesh.patel@yopmail.com' }),
  })
  assert(forgotKnown.status === 200 && forgotKnown.body.success, 'forgot known failed')
  assert(!JSON.stringify(forgotKnown.body).includes('token'), 'forgot must not return token')
  console.log('OK forgot-password known Admin/PM email')

  const forgotUnknown = await call('/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email: 'nobody@example.com' }),
  })
  assert(
    forgotUnknown.status === 200 &&
      forgotUnknown.body.message === forgotKnown.body.message,
    'forgot unknown must match generic message',
  )
  console.log('OK forgot-password unknown email (no enumeration)')

  const forgotTech = await call('/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email: 'ramesh.vaghela@yopmail.com' }),
  })
  assert(
    forgotTech.status === 403 && forgotTech.body.code === 'FORGOT_PASSWORD_ROLE_DENIED',
    `forgot Technician must be 403 role denied: ${JSON.stringify(forgotTech.body)}`,
  )
  console.log('OK forgot-password Technician role denied')

  const forgotBad = await call('/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email: 'not-an-email' }),
  })
  assert(forgotBad.status === 400, 'forgot invalid email expected 400')
  console.log('OK forgot-password validation 400')

  // Reset password — Technician token must be rejected without consuming
  const techResetUser = await query<{ id: string }>(
    `SELECT id FROM users WHERE email = 'ramesh.vaghela@yopmail.com'`,
  )
  const techResetToken = await issuePasswordResetToken(techResetUser.rows[0].id)
  const techReset = await call('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token: techResetToken, password: 'ResetPass1' }),
  })
  assert(
    techReset.status === 403 && techReset.body.code === 'FORGOT_PASSWORD_ROLE_DENIED',
    `reset Technician must be 403: ${JSON.stringify(techReset.body)}`,
  )
  const techReuse = await call('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token: techResetToken, password: 'ResetPass1' }),
  })
  assert(
    techReuse.status === 403 && techReuse.body.code === 'FORGOT_PASSWORD_ROLE_DENIED',
    'Technician reset token must remain usable until role-denied without mark-used',
  )
  console.log('OK reset-password Technician role denied (token unused)')

  // Reset password — Admin/PM
  const alkesh = await query<{ id: string }>(
    `SELECT id FROM users WHERE email = 'alkesh.patel@yopmail.com'`,
  )
  const alkeshId = alkesh.rows[0].id
  const resetToken = await issuePasswordResetToken(alkeshId)

  const weakReset = await call('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token: resetToken, password: 'short' }),
  })
  assert(weakReset.status === 400, 'weak password expected 400')
  console.log('OK reset weak password 400')

  const resetOk = await call('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token: resetToken, password: 'ResetPass1' }),
  })
  assert(resetOk.status === 200 && resetOk.body.success, `reset failed: ${JSON.stringify(resetOk.body)}`)
  console.log('OK reset-password')

  const loginNew = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: 'alkesh.patel@yopmail.com', password: 'ResetPass1' }),
  })
  assert(loginNew.status === 200, 'login with new password failed')
  console.log('OK login after reset')

  const reuse = await call('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token: resetToken, password: 'ResetPass2' }),
  })
  assert(reuse.status === 400 && reuse.body.code === 'INVALID_RESET_TOKEN', 'used token must fail')
  console.log('OK used reset token rejected')

  const bogus = await call('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token: 'deadbeef'.repeat(8), password: 'ResetPass1' }),
  })
  assert(bogus.status === 400 && bogus.body.code === 'INVALID_RESET_TOKEN', 'bogus token must fail')
  console.log('OK invalid reset token rejected')

  const expiredRaw = createRawResetToken()
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() - INTERVAL '1 minute')`,
    [alkeshId, hashResetToken(expiredRaw)],
  )
  const expired = await call('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token: expiredRaw, password: 'ResetPass1' }),
  })
  assert(expired.status === 400 && expired.body.code === 'INVALID_RESET_TOKEN', 'expired must fail')
  console.log('OK expired reset token rejected')

  const oldMe = await call('/api/auth/me', { headers: auth })
  assert(oldMe.status === 401, 'JWT before password change must be rejected')
  console.log('OK JWT invalidated after password reset')

  let adminLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9000000001', password: 'Password123' }),
  })
  assert(adminLogin.status === 200 && adminLogin.body.data?.token, 'admin login failed')
  let adminAuth = { Authorization: `Bearer ${adminLogin.body.data.token as string}` }
  console.log('OK admin login')

  const restore = await call(`/api/users/${alkeshId}`, {
    method: 'PATCH',
    headers: adminAuth,
    body: JSON.stringify({ password: 'Password123' }),
  })
  assert(restore.status === 200, 'restore alkesh password failed')
  console.log('OK admin PATCH password')

  const pmLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9825012345', password: 'Password123' }),
  })
  assert(pmLogin.status === 200, 'pm login failed')
  const pmAuth = { Authorization: `Bearer ${pmLogin.body.data.token as string}` }
  const usersList = await call('/api/users', { headers: adminAuth })
  const techUser = usersList.body.data.users.find(
    (u: { role: string; status: string; mobile: string }) =>
      u.role === 'Technician' && u.status === 'Active',
  )
  assert(techUser?.id, 'technician for admin password test')
  const pmPatch = await call(`/api/users/${techUser.id}`, {
    method: 'PATCH',
    headers: pmAuth,
    body: JSON.stringify({ fullName: techUser.name }),
  })
  assert(pmPatch.status === 200, 'PM should be able to edit users')
  console.log('OK PM can edit users')

  const techLoginBefore = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: techUser.mobile, password: 'Password123' }),
  })
  assert(techLoginBefore.status === 200, 'tech login before admin change failed')
  const techTokenBefore = techLoginBefore.body.data.token as string

  const adminPw = await call(`/api/users/${techUser.id}`, {
    method: 'PATCH',
    headers: adminAuth,
    body: JSON.stringify({ password: 'AdminSet99' }),
  })
  assert(adminPw.status === 200, 'admin set password failed')
  console.log('OK admin set technician password')

  const techOldMe = await call('/api/auth/me', {
    headers: { Authorization: `Bearer ${techTokenBefore}` },
  })
  assert(techOldMe.status === 401, 'tech JWT must die after admin password change')
  console.log('OK JWT invalidated after admin password change')

  const techNew = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: techUser.mobile, password: 'AdminSet99' }),
  })
  assert(techNew.status === 200, 'tech login with admin-set password failed')
  console.log('OK tech login with admin-set password')

  await call(`/api/users/${techUser.id}`, {
    method: 'PATCH',
    headers: adminAuth,
    body: JSON.stringify({ password: 'Password123' }),
  })

  adminLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9000000001', password: 'Password123' }),
  })
  adminAuth = { Authorization: `Bearer ${adminLogin.body.data.token as string}` }

  const roles = await call('/api/roles', { headers: adminAuth })
  assert(roles.status === 200 && roles.body.success, 'roles list failed')
  const roleList = Array.isArray(roles.body.data) ? roles.body.data : []
  const roleId = roleList.find((r: { name: string }) => r.name === 'Technician')?.id as string | undefined
  assert(roleId, 'Technician role not found for user-create smoke')

  const suffix = String(Date.now()).slice(-8)
  const mobile = `98${suffix}`.slice(0, 10)
  const email = `smoke.tech.${suffix}@yopmail.com`
  const createUser = await call('/api/users', {
    method: 'POST',
    headers: adminAuth,
    body: JSON.stringify({
      fullName: `Smoke Tech ${suffix}`,
      mobile,
      email,
      password: 'SmokePass1',
      roleId,
      roadIds: [],
    }),
  })
  assert(
    createUser.status === 201 && createUser.body.success && createUser.body.data?.id,
    `user create failed: ${createUser.status} ${JSON.stringify(createUser.body).slice(0, 200)}`,
  )
  console.log('OK POST /api/users')
  const smokeTechId = createUser.body.data.id as string

  const newLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: email, password: 'SmokePass1' }),
  })
  assert(newLogin.status === 200 && newLogin.body.data?.token, 'new user login failed')
  console.log('OK new user login')

  await deleteSmokeUsers([smokeTechId])
  console.log('OK smoke tech removed')

  const logout = await call('/api/auth/logout', {
    method: 'POST',
    headers: adminAuth,
  })
  assert(logout.status === 200 && logout.body.success, 'logout failed')
  console.log('OK POST /api/auth/logout')

  const afterLogout = await call('/api/auth/me', { headers: adminAuth })
  assert(afterLogout.status === 401, 'expected 401 after logout')
  console.log('OK token revoked after logout')

  // Signup + pending approval
  const signupSuffix = String(Date.now()).slice(-8)
  const signupMobile = `97${signupSuffix}`.slice(0, 10)
  const signupEmail = `signup.${signupSuffix}@yopmail.com`
  const signup = await call('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      fullName: `Pending User ${signupSuffix}`,
      mobile: signupMobile,
      email: signupEmail,
      password: 'PendingPass1',
    }),
  })
  assert(signup.status === 200 && signup.body.success, `signup failed: ${JSON.stringify(signup.body)}`)
  console.log('OK POST /api/auth/signup')

  const pendingLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: signupEmail, password: 'PendingPass1' }),
  })
  assert(
    pendingLogin.status === 403 && pendingLogin.body.code === 'PENDING_APPROVAL',
    `pending login should be blocked: ${JSON.stringify(pendingLogin.body)}`,
  )
  console.log('OK pending login blocked')

  adminLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9000000001', password: 'Password123' }),
  })
  adminAuth = { Authorization: `Bearer ${adminLogin.body.data.token as string}` }

  const pendingList = await call('/api/users?status=Pending', { headers: adminAuth })
  assert(pendingList.status === 200 && pendingList.body.success, 'pending users list failed')
  const pendingUser = pendingList.body.data.users.find(
    (u: { email: string }) => u.email === signupEmail,
  )
  assert(pendingUser?.id, 'pending user not in list')

  const approve = await call(`/api/users/${pendingUser.id}`, {
    method: 'PATCH',
    headers: adminAuth,
    body: JSON.stringify({ status: 'Active' }),
  })
  assert(approve.status === 200, `approve failed: ${JSON.stringify(approve.body)}`)
  console.log('OK admin approve pending user')

  const afterApprove = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: signupEmail, password: 'PendingPass1' }),
  })
  assert(afterApprove.status === 200 && afterApprove.body.data?.token, 'login after approve failed')
  console.log('OK login after approval')

  await deleteSmokeUsers([pendingUser.id])

  // Project manager can approve pending signup
  const signup2Suffix = String(Date.now()).slice(-8)
  const signup2Mobile = `96${signup2Suffix}`.slice(0, 10)
  const signup2Email = `signup.pm.${signup2Suffix}@yopmail.com`
  const signup2 = await call('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({
      fullName: `PM Pending ${signup2Suffix}`,
      mobile: signup2Mobile,
      email: signup2Email,
      password: 'PendingPass1',
    }),
  })
  assert(signup2.status === 200, `second signup failed: ${JSON.stringify(signup2.body)}`)

  const pmLoginApprove = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9825012345', password: 'Password123' }),
  })
  assert(pmLoginApprove.status === 200 && pmLoginApprove.body.data?.token, 'pm login for approve failed')
  const pmAuthApprove = { Authorization: `Bearer ${pmLoginApprove.body.data.token as string}` }

  const pendingForPm = await call('/api/users?status=Pending', { headers: pmAuthApprove })
  assert(pendingForPm.status === 200, 'pm pending list failed')
  const pending2 = pendingForPm.body.data.users.find(
    (u: { email: string }) => u.email === signup2Email,
  )
  assert(pending2?.id, 'pending user for pm not found')

  const pmApprove = await call(`/api/users/${pending2.id}`, {
    method: 'PATCH',
    headers: pmAuthApprove,
    body: JSON.stringify({ status: 'Active' }),
  })
  assert(pmApprove.status === 200, `pm approve failed: ${JSON.stringify(pmApprove.body)}`)
  console.log('OK PM approve pending user')

  const techCannotApprove = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9099941128', password: 'Password123' }),
  })
  assert(techCannotApprove.status === 200, 'tech login failed')
  const techAuth = { Authorization: `Bearer ${techCannotApprove.body.data.token as string}` }
  const techPatchUser = await call(`/api/users/${pending2.id}`, {
    method: 'PATCH',
    headers: techAuth,
    body: JSON.stringify({ status: 'Inactive' }),
  })
  assert(techPatchUser.status === 403, 'tech must not edit users')
  console.log('OK tech forbidden from user approve/edit')

  await deleteSmokeUsers([pending2.id])

  // Every Ticket, Every Road (Phase 51): tickets have no holder, so anyone with All tickets `v`
  // lists and opens every ticket regardless of road or who raised it.
  const pmAll = await call('/api/tickets?limit=100', { headers: pmAuthApprove })
  assert(pmAll.status === 200 && Array.isArray(pmAll.body.data), 'pm ticket list failed')
  assert(
    pmAll.body.tabCounts &&
      'open' in pmAll.body.tabCounts &&
      'urp' in pmAll.body.tabCounts &&
      'cls' in pmAll.body.tabCounts &&
      !('asg' in pmAll.body.tabCounts),
    'tabCounts must be { open, urp, cls }',
  )
  const anyOpen = pmAll.body.data.find(
    (t: { id: string; deviceId: string }) => t.deviceId,
  ) as { id: string; deviceId: string } | undefined
  assert(anyOpen?.id, 'need a ticket for the every-ticket checks')

  const techAll = await call('/api/tickets?limit=100', { headers: techAuth })
  assert(techAll.status === 200, 'tech ticket list failed')
  assert(
    techAll.body.pagination.total === pmAll.body.pagination.total,
    `tech must list every ticket like PM (${techAll.body.pagination.total} vs ${pmAll.body.pagination.total})`,
  )
  const techDetail = await call(`/api/tickets/${anyOpen.id}`, { headers: techAuth })
  assert(techDetail.status === 200, `tech must open any ticket: ${techDetail.status}`)
  console.log('OK tech lists and opens every ticket (no holder filter)')

  const attendantLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9016374408', password: 'Password123' }),
  })
  assert(attendantLogin.status === 200 && attendantLogin.body.data?.token, 'site attendant login failed')
  const attendantAuth = { Authorization: `Bearer ${attendantLogin.body.data.token as string}` }
  const attendantTickets = await call('/api/tickets?limit=100', { headers: attendantAuth })
  assert(attendantTickets.status === 200, 'site attendant ticket list failed')
  assert(
    attendantTickets.body.pagination.total === pmAll.body.pagination.total,
    'site attendant must list every ticket',
  )
  const attendantDetail = await call(`/api/tickets/${anyOpen.id}`, { headers: attendantAuth })
  assert(attendantDetail.status === 200, 'site attendant must open any ticket')
  console.log('OK site attendant lists and opens every ticket')

  // Site attendant may scan + raise on any road (field-work bypass)
  const cgRoad = await query<{ id: string }>(`SELECT id FROM roads WHERE name = 'CG Road' LIMIT 1`)
  assert(cgRoad.rows[0]?.id, 'need CG Road for attendant off-road raise')
  await query(
    `INSERT INTO devices (public_id, qr_code, road_id, slot_number, model, installed_on, install_status)
     SELECT 'PD-SMOKE-CG', 'QR-PDSMOKECG', $1, 'CG-SMOKE', 'Flap barrier — 4 wheeler', '2026-04-01', 'Working'
     WHERE NOT EXISTS (SELECT 1 FROM devices WHERE public_id = 'PD-SMOKE-CG')`,
    [cgRoad.rows[0].id],
  )
  await query(
    `UPDATE tickets SET status = 'Closed', closed_at = NOW() - INTERVAL '8 days', updated_at = NOW()
     WHERE device_id = (SELECT id FROM devices WHERE public_id = 'PD-SMOKE-CG')
       AND status <> 'Closed'`,
  )
  await query(
    `UPDATE ticket_issues ti SET status = 'Resolved', resolved_at = NOW()
     FROM tickets t
     WHERE t.id = ti.ticket_id AND t.status = 'Closed'
       AND t.device_id = (SELECT id FROM devices WHERE public_id = 'PD-SMOKE-CG')
       AND ti.role = 'reported' AND ti.status = 'Open'`,
  )
  await query(
    `UPDATE tickets SET closed_at = NOW() - INTERVAL '8 days'
     WHERE device_id = (SELECT id FROM devices WHERE public_id = 'PD-SMOKE-CG')
       AND status = 'Closed'
       AND closed_at >= NOW() - INTERVAL '7 days'`,
  )
  const attendantScanCg = await call('/api/devices/scan?q=PD-SMOKE-CG', { headers: attendantAuth })
  assert(
    attendantScanCg.status === 200 && attendantScanCg.body.success,
    `attendant scan off-road must succeed: ${attendantScanCg.status} ${JSON.stringify(attendantScanCg.body)}`,
  )
  assert(!attendantScanCg.body.data?.openTicketId, 'PD-SMOKE-CG must have no open ticket for raise')
  const attendantRaiseCg = await call('/api/tickets', {
    method: 'POST',
    headers: attendantAuth,
    body: JSON.stringify({
      deviceId: 'PD-SMOKE-CG',
      categoryId: cats.rows[0].cid,
      subCategoryId: cats.rows[0].sid,
      description: 'Smoke attendant raise off assigned road',
    }),
  })
  assert(
    attendantRaiseCg.status === 201 && attendantRaiseCg.body.data?.id,
    `attendant raise off-road must succeed: ${attendantRaiseCg.status} ${JSON.stringify(attendantRaiseCg.body)}`,
  )
  console.log('OK site attendant scan+raise on non-assigned road')

  const crLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '7990011002', password: 'Password123' }),
  })
  assert(crLogin.status === 200 && crLogin.body.data?.token, 'control room login failed')
  const crAuth = { Authorization: `Bearer ${crLogin.body.data.token as string}` }

  const techLookup = await call('/api/lookups/technicians', { headers: crAuth })
  assert(techLookup.status === 200, 'technicians lookup for roles')
  const lookupRoles = new Set(
    (techLookup.body.data || []).map((u: { role: string }) => u.role),
  )
  assert(lookupRoles.has('Technician'), 'lookup includes Technician')
  console.log('OK technicians lookup roles')

  // Technician scan any road; update tickets they hold on any road (field-work bypass)
  const makarba = await query<{ id: string }>(`SELECT id FROM roads WHERE name = 'Makarba' LIMIT 1`)
  assert(makarba.rows[0]?.id, 'need Makarba for tech off-road scan')
  await query(
    `INSERT INTO devices (public_id, qr_code, road_id, slot_number, model, installed_on, install_status)
     SELECT 'PD-SMOKE-MK', 'QR-PDSMOKEMK', $1, 'MK-SMOKE', 'Flap barrier — 4 wheeler', '2026-04-01', 'Working'
     WHERE NOT EXISTS (SELECT 1 FROM devices WHERE public_id = 'PD-SMOKE-MK')`,
    [makarba.rows[0].id],
  )
  const techScanOffRoad = await call('/api/devices/scan?q=PD-SMOKE-MK', { headers: techAuth })
  assert(
    techScanOffRoad.status === 200 && techScanOffRoad.body.success,
    `tech scan off-road must succeed: ${techScanOffRoad.status} ${JSON.stringify(techScanOffRoad.body)}`,
  )
  console.log('OK tech scan on non-assigned road')

  // Any user with Update ticket `e` updates any open ticket, on any road, without holding it.
  const techUpdateAny = await call('/api/tickets/TK-1042/updates', {
    method: 'POST',
    headers: techAuth,
    body: JSON.stringify({
      updateType: 'Site visit — not resolved',
      workDone: 'Smoke tech update on a ticket nobody holds',
    }),
  })
  assert(
    techUpdateAny.status === 201 && techUpdateAny.body.success,
    `tech update on any open ticket must succeed: ${techUpdateAny.status} ${JSON.stringify(techUpdateAny.body)}`,
  )
  const tk1042 = await query<{ assignee_id: string | null }>(`SELECT assignee_id FROM tickets WHERE public_id = 'TK-1042'`)
  assert(tk1042.rows[0]?.assignee_id == null, 'an update must never assign the ticket')
  console.log('OK tech updates any open ticket; nobody is assigned')

  const techAssign = await call('/api/tickets/TK-1042/assign', {
    method: 'POST',
    headers: techAuth,
    body: JSON.stringify({ assigneeId: crLogin.body.data.user?.id || null }),
  })
  assert(techAssign.status === 404, `the assign endpoint must be gone: ${techAssign.status}`)
  console.log('OK assign endpoint removed')

  const crDash = await call('/api/dashboard', { headers: crAuth })
  assert(crDash.status === 200 && crDash.body.success, 'control room dashboard failed')
  console.log('OK control room dashboard')

  const techDevices = await call('/api/devices?limit=100', { headers: techAuth })
  assert(techDevices.status === 200 && Array.isArray(techDevices.body.data), 'tech devices failed')
  assert(
    (techDevices.body.pagination?.total ?? 0) > 0,
    'tech device list must return city-wide devices',
  )
  console.log('OK tech device list city-wide')

  const techScanOpen = await call('/api/devices/scan?q=PD-0428', { headers: techAuth })
  assert(techScanOpen.status === 200 && techScanOpen.body.success, 'tech scan PD-0428 failed')
  assert(techScanOpen.body.data?.openTicketId === 'TK-1042', 'tech scan must surface openTicketId')
  console.log('OK tech scan openTicketId')

  const techDeviceDetail = await call(`/api/devices/${anyOpen.deviceId}`, { headers: techAuth })
  assert(
    techDeviceDetail.status === 200 && techDeviceDetail.body.success,
    `tech device detail must be city-wide (200): ${techDeviceDetail.status}`,
  )
  const histIds = (techDeviceDetail.body.data.tickets || []).map((t: { id: string }) => t.id)
  assert(histIds.includes(anyOpen.id), 'tech device history must include every ticket of the device')
  console.log('OK tech device history lists every ticket')

  const crWork = await call('/api/reports/work?view=month', { headers: crAuth })
  assert(crWork.status === 200 && crWork.body.success, 'control room work report failed')
  console.log('OK control room work report')

  // Device Sync — authz, config, single-flight (no live external call)
  const adminSyncLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9825012345', password: 'Password123' }),
  })
  assert(adminSyncLogin.status === 200 && adminSyncLogin.body.data?.token, 'admin re-login for device-sync')
  const adminSyncAuth = { Authorization: `Bearer ${adminSyncLogin.body.data.token as string}` }

  const syncUnauth = await call('/api/device-sync', { method: 'POST', body: '{}' })
  assert(syncUnauth.status === 401, 'device-sync without auth must be 401')

  const prevSyncToken = process.env.DEVICE_SYNC_API_TOKEN
  process.env.DEVICE_SYNC_API_TOKEN = ''

  const syncTech = await call('/api/device-sync', {
    method: 'POST',
    headers: techAuth,
    body: '{}',
  })
  // Technician has Device list c (migration 014) — authz passes; unconfigured → 503
  assert(
    syncTech.status === 503 && syncTech.body.code === 'DEVICE_SYNC_NOT_CONFIGURED',
    `tech device-sync should be authorized (503): ${JSON.stringify(syncTech.body).slice(0, 200)}`,
  )

  const attSyncLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9016374408', password: 'Password123' }),
  })
  assert(attSyncLogin.status === 200 && attSyncLogin.body.data?.token, 'attendant login for sync')
  const attSyncAuth = { Authorization: `Bearer ${attSyncLogin.body.data.token as string}` }
  const syncAtt = await call('/api/device-sync', {
    method: 'POST',
    headers: attSyncAuth,
    body: '{}',
  })
  assert(
    syncAtt.status === 503 && syncAtt.body.code === 'DEVICE_SYNC_NOT_CONFIGURED',
    `site attendant device-sync should be authorized (503): ${JSON.stringify(syncAtt.body).slice(0, 200)}`,
  )

  const syncNoToken = await call('/api/device-sync', {
    method: 'POST',
    headers: adminSyncAuth,
    body: '{}',
  })
  assert(
    syncNoToken.status === 503 && syncNoToken.body.code === 'DEVICE_SYNC_NOT_CONFIGURED',
    'device-sync without DEVICE_SYNC_API_TOKEN must be 503',
  )

  await query(
    `INSERT INTO device_sync_runs (status, triggered_by_user_id)
     VALUES ('started', (SELECT id FROM users WHERE mobile = '9825012345' LIMIT 1))`,
  )
  process.env.DEVICE_SYNC_API_TOKEN = 'smoke-test-token-not-used'

  const syncBusy = await call('/api/device-sync', {
    method: 'POST',
    headers: adminSyncAuth,
    body: '{}',
  })
  assert(
    syncBusy.status === 409 && syncBusy.body.code === 'SYNC_IN_PROGRESS',
    'device-sync while started must be 409',
  )

  const syncLatest = await call('/api/device-sync/latest', { headers: adminSyncAuth })
  assert(syncLatest.status === 200 && syncLatest.body.data?.status === 'started', 'GET latest sync run')
  const runId = syncLatest.body.data.id as string
  const syncById = await call(`/api/device-sync/${runId}`, { headers: adminSyncAuth })
  assert(syncById.status === 200 && syncById.body.data?.id === runId, 'GET sync by id')

  await query(
    `UPDATE device_sync_runs
     SET status = 'failed', finished_at = NOW(), error_message = 'smoke cleanup'
     WHERE status = 'started'`,
  )
  if (prevSyncToken === undefined) delete process.env.DEVICE_SYNC_API_TOKEN
  else process.env.DEVICE_SYNC_API_TOKEN = prevSyncToken
  console.log('OK device-sync authz + single-flight + status')

  // Phase 33 — QR token → slot-mac proxy (validation / authz; live SmartPark optional)
  const slotMacUnauth = await call('/api/devices/slot-mac', {
    method: 'POST',
    body: JSON.stringify({ qrToken: 'smoke-token' }),
  })
  assert(slotMacUnauth.status === 401, 'slot-mac without auth must be 401')

  const slotMacEmpty = await call('/api/devices/slot-mac', {
    method: 'POST',
    headers: adminSyncAuth,
    body: JSON.stringify({}),
  })
  assert(
    slotMacEmpty.status === 400 && slotMacEmpty.body.code === 'VALIDATION_ERROR',
    `slot-mac empty body must be 400: ${JSON.stringify(slotMacEmpty.body).slice(0, 200)}`,
  )

  const prevSlotToken = process.env.DEVICE_SYNC_API_TOKEN
  process.env.DEVICE_SYNC_API_TOKEN = ''
  const slotMacNoCfg = await call('/api/devices/slot-mac', {
    method: 'POST',
    headers: adminSyncAuth,
    body: JSON.stringify({ qrToken: 'smoke-token' }),
  })
  assert(
    slotMacNoCfg.status === 503 && slotMacNoCfg.body.code === 'DEVICE_SYNC_NOT_CONFIGURED',
    'slot-mac without DEVICE_SYNC_API_TOKEN must be 503',
  )
  if (prevSlotToken === undefined) delete process.env.DEVICE_SYNC_API_TOKEN
  else process.env.DEVICE_SYNC_API_TOKEN = prevSlotToken
  console.log('OK slot-mac validation + authz')

  console.log('\nAll smoke checks passed')
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
