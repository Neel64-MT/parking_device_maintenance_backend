/**
 * Device CRUD smoke — manual create/read/update/soft-delete with the five form fields.
 * Covers the Add Device contract: slotId → public_id, slotNumber, slotIdentifier (MAC),
 * qrNumber → qr_code, roadId. installedOn is optional. Never prints tokens.
 * Run: npx tsx scripts/smoke-device-crud.ts
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

  const roads = await call('/api/lookups/roads', { headers: auth })
  assert(
    roads.status === 200 && Array.isArray(roads.body.data) && roads.body.data.length,
    'roads lookup failed',
  )
  const roadId = roads.body.data[0].id as string

  const cats = await call('/api/lookups/issue-categories', { headers: auth })
  assert(cats.status === 200 && cats.body.data?.[0]?.subs?.[0], 'issue categories failed')
  const categoryId = cats.body.data[0].id as string
  const subCategoryId = cats.body.data[0].subs[0].id as string

  const suffix = String(Date.now()).slice(-6)
  const slotId = `SMK-${suffix}`
  const slotNumber = `SM-${suffix}`
  const mac = `AA:BB:CC:${suffix.slice(0, 2)}:${suffix.slice(2, 4)}:${suffix.slice(4, 6)}`
  const qrNumber = `SMK${suffix}`

  // CREATE — all five fields; installedOn omitted (now optional).
  const created = await call('/api/devices', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ slotId, slotNumber, slotIdentifier: mac, qrNumber, roadId }),
  })
  assert(
    created.status === 201,
    `create failed: ${created.status} ${JSON.stringify(created.body).slice(0, 300)}`,
  )
  assert(created.body.data?.publicId === slotId, 'slotId must persist as public_id')
  assert(created.body.data?.id === slotId, 'display id must be the user slotId (slot_id NULL)')
  assert(created.body.data?.qrNumber === qrNumber, 'user QR must persist')
  assert(created.body.data?.slotIdentifier === mac, 'MAC must persist')
  assert(created.body.data?.slotId === null, 'manual device slot_id must stay NULL')
  const deviceUuid = created.body.data.uuid as string
  console.log('OK create persists all five fields')

  // READ — list finds it by slotId, and detail returns persisted values.
  const list = await call(`/api/devices?q=${encodeURIComponent(slotId)}`, { headers: auth })
  assert(
    list.status === 200 && list.body.data?.some((r: { id: string }) => r.id === slotId),
    'created device must appear in the list',
  )
  const detail = await call(`/api/devices/${encodeURIComponent(slotId)}`, { headers: auth })
  assert(detail.status === 200, 'detail by slotId failed')
  assert(detail.body.data?.header?.qrNumber === qrNumber, 'detail QR mismatch')
  assert(detail.body.data?.header?.slotIdentifier === mac, 'detail MAC mismatch')
  assert(detail.body.data?.header?.roadId === roadId, 'detail roadId must be exposed for edit')
  console.log('OK read: list + detail reflect persisted data')

  // UPDATE — MAC + QR + label now actually persist (previously silently dropped).
  const newMac = `DD:EE:FF:${suffix.slice(0, 2)}:${suffix.slice(2, 4)}:${suffix.slice(4, 6)}`
  const newQr = `SMKU${suffix}`
  const newLabel = `SM-${suffix}-U`
  const patched = await call(`/api/devices/${encodeURIComponent(slotId)}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ slotIdentifier: newMac, qrNumber: newQr, slotNumber: newLabel }),
  })
  assert(patched.status === 200, `update failed: ${JSON.stringify(patched.body).slice(0, 300)}`)
  assert(patched.body.data?.slotIdentifier === newMac, 'MAC edit must persist')
  assert(patched.body.data?.qrNumber === newQr, 'QR edit must persist')
  assert(patched.body.data?.slotLabel === newLabel, 'label edit must persist')
  console.log('OK update persists MAC/QR/label (silent-drop bug fixed)')

  // VALIDATION — duplicate QR → 409, invalid roadId → 400.
  const dupQr = await call('/api/devices', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ slotId: `${slotId}-B`, slotNumber: `${slotNumber}-B`, qrNumber: newQr, roadId }),
  })
  assert(
    dupQr.status === 409 && dupQr.body.code === 'DUPLICATE_ERROR',
    `duplicate QR must be 409 DUPLICATE_ERROR, got ${dupQr.status} ${dupQr.body.code}`,
  )
  const badRoad = await call('/api/devices', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ slotId: `${slotId}-C`, slotNumber: `${slotNumber}-C`, qrNumber: `${qrNumber}C`, roadId: 'not-a-uuid' }),
  })
  assert(
    badRoad.status === 400 && badRoad.body.code === 'VALIDATION_ERROR',
    `invalid roadId must be 400 VALIDATION_ERROR, got ${badRoad.status} ${badRoad.body.code}`,
  )
  console.log('OK validation: duplicate QR 409, invalid roadId 400')

  // DELETE — soft delete: drops out of reads, row + relationships preserved.
  const del = await call(`/api/devices/${encodeURIComponent(slotId)}`, {
    method: 'DELETE',
    headers: auth,
  })
  assert(del.status === 200, `delete failed: ${JSON.stringify(del.body).slice(0, 300)}`)
  const listAfter = await call(`/api/devices?q=${encodeURIComponent(slotId)}`, { headers: auth })
  assert(
    !listAfter.body.data?.some((r: { id: string }) => r.id === slotId),
    'deleted device must not appear in the list',
  )
  const detailAfter = await call(`/api/devices/${encodeURIComponent(slotId)}`, { headers: auth })
  assert(detailAfter.status === 404, 'deleted device detail must be 404')
  const stillThere = await query<{ deleted_at: Date | null }>(
    `SELECT deleted_at FROM devices WHERE id = $1`,
    [deviceUuid],
  )
  assert(stillThere.rows[0]?.deleted_at != null, 'soft-deleted row must be preserved with deleted_at set')
  const raiseOnDeleted = await call('/api/tickets', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ deviceId: slotId, categoryId, subCategoryId, reporterType: 'Control room' }),
  })
  assert(
    raiseOnDeleted.status === 404,
    `cannot raise a ticket on a deleted device, got ${raiseOnDeleted.status} ${raiseOnDeleted.body.code}`,
  )
  console.log('OK soft delete: hidden from reads, row preserved, not ticketable')

  console.log('\nDevice CRUD checks passed')
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
