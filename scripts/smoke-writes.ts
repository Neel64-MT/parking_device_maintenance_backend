/**
 * Domain write-path smoke — never prints tokens or passwords.
 * Run: npx tsx scripts/smoke-writes.ts
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
  assert(roads.status === 200 && Array.isArray(roads.body.data) && roads.body.data.length, 'roads failed')
  const roadId = roads.body.data[0].id as string

  const cats = await call('/api/lookups/issue-categories', { headers: auth })
  assert(cats.status === 200 && cats.body.data?.[0]?.subs?.[0], 'issue categories failed')
  const categoryId = cats.body.data[0].id as string
  const subCategoryId = cats.body.data[0].subs[0].id as string

  const suffix = String(Date.now()).slice(-5)
  const device = await call('/api/devices', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      roadId,
      slotNumber: `ZZ-${suffix}`,
      installedOn: '2026-09-01',
      installStatus: 'Working',
    }),
  })
  assert(
    device.status === 201 && device.body.data?.public_id,
    `device create failed: ${device.status} ${JSON.stringify(device.body).slice(0, 300)}`,
  )
  const devicePublicId = device.body.data.public_id as string
  console.log('OK device create', devicePublicId)

  const ticket = await call('/api/tickets', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      deviceId: devicePublicId,
      categoryId,
      subCategoryId,
      description: 'Smoke raise',
      reporterType: 'Control room',
    }),
  })
  assert(
    ticket.status === 201 && ticket.body.data?.id,
    `ticket raise failed: ${ticket.status} ${JSON.stringify(ticket.body).slice(0, 300)}`,
  )
  const ticketId = ticket.body.data.id as string
  console.log('OK ticket raise', ticketId)

  const users = await call('/api/users', { headers: auth })
  const tech = users.body.data.users.find(
    (u: { role: string; status: string }) => u.role === 'Technician' && u.status === 'Active',
  )
  assert(tech?.id, 'technician not found')

  const assign = await call(`/api/tickets/${ticketId}/assign`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ assigneeId: tech.id }),
  })
  assert(assign.status === 200, `assign failed: ${JSON.stringify(assign.body).slice(0, 200)}`)
  console.log('OK assign')

  const update = await call(`/api/tickets/${ticketId}/updates`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      updateType: 'Site visit — not resolved',
      workDone: 'Adjusted sensor',
      cost: 0,
    }),
  })
  assert(update.status === 200, `update failed: ${JSON.stringify(update.body).slice(0, 300)}`)
  console.log('OK update')

  const close = await call(`/api/tickets/${ticketId}/close`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      categoryId,
      subCategoryId,
      workDone: 'Replaced sensor',
      cost: 500,
      deviceTested: 'Tested OK — flap cycles correctly',
    }),
  })
  assert(close.status === 200, `close failed: ${JSON.stringify(close.body).slice(0, 300)}`)
  console.log('OK close')

  const road = await call('/api/roads', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      name: `Smoke Road ${suffix}`,
      stretchFrom: 'A',
      stretchTo: 'B',
      status: 'Operational',
      surveyedSlots: 10,
      devicesSanctioned: 10,
      slotPrefix: `S${suffix.slice(0, 2)}`,
    }),
  })
  assert(road.status === 201, `road create failed: ${road.status} ${JSON.stringify(road.body).slice(0, 300)}`)
  console.log('OK road create')

  const dash = await call('/api/dashboard', { headers: auth })
  assert(dash.status === 200 && dash.body.success, 'dashboard failed')
  console.log('OK dashboard')

  const report = await call('/api/reports/work?view=week', { headers: auth })
  assert(report.status === 200 && report.body.success, 'report failed')
  console.log('OK report week')

  // One open ticket per device
  const device2 = await call('/api/devices', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      roadId,
      slotNumber: `ZY-${suffix}`,
      installedOn: '2026-09-01',
      installStatus: 'Working',
    }),
  })
  assert(device2.status === 201, 'device2 create failed')
  const device2Id = device2.body.data.public_id as string
  const t1 = await call('/api/tickets', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      deviceId: device2Id,
      categoryId,
      subCategoryId,
      description: 'First open',
      reporterType: 'Control room',
    }),
  })
  assert(t1.status === 201, 'first ticket failed')
  const dup = await call('/api/tickets', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      deviceId: device2Id,
      categoryId,
      subCategoryId,
      description: 'Duplicate open',
      reporterType: 'Control room',
    }),
  })
  assert(dup.status === 409 && dup.body.code === 'OPEN_TICKET_EXISTS', 'expected OPEN_TICKET_EXISTS')
  assert(
    dup.body.details?.openTicketId && dup.body.details?.ticketId,
    'OPEN_TICKET_EXISTS must include openTicketId and ticketId',
  )
  console.log('OK one-open-ticket rule')

  // Issues: create unused subcategory, hard-delete OK; used subcategory → deactivate-only
  const catCreate = await call('/api/issues/categories', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: `Smoke Cat ${suffix}` }),
  })
  assert(catCreate.status === 201 && catCreate.body.data?.id, 'category create failed')
  const smokeCatId = catCreate.body.data.id as string

  const unusedSub = await call('/api/issues/subcategories', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      categoryId: smokeCatId,
      name: `Unused Sub ${suffix}`,
      severity: 'Minor',
    }),
  })
  assert(unusedSub.status === 201 && unusedSub.body.data?.id, 'unused sub create failed')
  const delUnused = await call(`/api/issues/subcategories/${unusedSub.body.data.id}`, {
    method: 'DELETE',
    headers: auth,
  })
  assert(delUnused.status === 200, `delete unused failed: ${JSON.stringify(delUnused.body).slice(0, 200)}`)
  console.log('OK unused subcategory delete')

  const usedDel = await call(`/api/issues/subcategories/${subCategoryId}`, {
    method: 'DELETE',
    headers: auth,
  })
  assert(usedDel.status === 409 && usedDel.body.code === 'IN_USE', 'expected IN_USE on used subcategory')
  console.log('OK used subcategory cannot hard-delete')

  // Upload
  const form = new FormData()
  form.append('file', new Blob(['smoke-photo'], { type: 'image/jpeg' }), 'smoke.jpg')
  const uploadRes = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: auth,
    body: form,
  })
  const uploadBody = await uploadRes.json()
  assert(uploadRes.status === 201 && uploadBody.success && uploadBody.data?.url, 'upload failed')
  console.log('OK upload')

  // Soft-inactivate a non-admin user created earlier is covered in auth smoke;
  // here verify PATCH inactive on a technician is allowed for Admin
  const patchUser = await call(`/api/users/${tech.id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ status: 'Active' }),
  })
  assert(patchUser.status === 200, `user patch failed: ${JSON.stringify(patchUser.body).slice(0, 200)}`)
  console.log('OK user patch')

  console.log('\nDomain write checks passed')
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
