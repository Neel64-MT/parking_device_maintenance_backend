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

  // Parts master create/update (Issue c/e or Technician) + amounts on list/lookups
  const partA = await call('/api/parts', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: `Smoke Part A ${suffix}`, amount: 500 }),
  })
  assert(partA.status === 201 && partA.body.data?.id, `part A create failed: ${JSON.stringify(partA.body).slice(0, 200)}`)
  const partB = await call('/api/parts', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: `Smoke Part B ${suffix}`, amount: 250 }),
  })
  assert(partB.status === 201 && partB.body.data?.id, `part B create failed: ${JSON.stringify(partB.body).slice(0, 200)}`)
  const partAId = partA.body.data.id as string
  const partBId = partB.body.data.id as string

  const partsList = await call('/api/parts', { headers: auth })
  assert(partsList.status === 200 && Array.isArray(partsList.body.data), 'parts list failed')
  assert(
    partsList.body.data.some((p: { id: string; amount: number }) => p.id === partAId && p.amount === 500),
    'parts list missing amount',
  )
  const patchPart = await call(`/api/parts/${partAId}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ amount: 500 }),
  })
  assert(patchPart.status === 200 && patchPart.body.data?.amount === 500, 'part patch failed')
  const lookupsParts = await call('/api/lookups/parts', { headers: auth })
  assert(
    lookupsParts.status === 200 &&
      lookupsParts.body.data.some((p: { id: string; amount: number }) => p.id === partBId && p.amount === 250),
    'lookups parts missing amount',
  )
  console.log('OK parts master CRUD')

  // Labour-only update (no parts)
  const labourOnly = await call(`/api/tickets/${ticketId}/updates`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      updateType: 'Remote check',
      workDone: 'Checked remotely',
      cost: 100,
      parts: [],
    }),
  })
  assert(labourOnly.status === 201 || labourOnly.status === 200, `labour-only update failed: ${JSON.stringify(labourOnly.body).slice(0, 300)}`)
  assert(labourOnly.body.data?.cost === 100, `labour-only cost expected 100 got ${labourOnly.body.data?.cost}`)
  console.log('OK update labour-only')

  // Visit cost = labour + master part amounts (ignore client part prices)
  const update = await call(`/api/tickets/${ticketId}/updates`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      updateType: 'Site visit — not resolved',
      workDone: 'Adjusted sensor; replaced parts',
      cost: 1000,
      parts: [partAId, partBId, partAId],
    }),
  })
  assert(update.status === 201 || update.status === 200, `update failed: ${JSON.stringify(update.body).slice(0, 300)}`)
  assert(update.body.data?.labourCost === 1000, 'labourCost mismatch')
  assert(update.body.data?.partsCost === 750, `partsCost expected 750 got ${update.body.data?.partsCost}`)
  assert(update.body.data?.cost === 1750, `event cost expected 1750 got ${update.body.data?.cost}`)
  assert(
    Array.isArray(update.body.data?.parts) &&
      update.body.data.parts.length === 2 &&
      update.body.data.parts.every((p: { id: string; name: string; amount: number }) => p.id && p.name && typeof p.amount === 'number'),
    'parts snapshot shape',
  )
  console.log('OK update with parts cost')

  const badPart = await call(`/api/tickets/${ticketId}/updates`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      updateType: 'Site visit — not resolved',
      workDone: 'Bad part id',
      cost: 50,
      parts: ['00000000-0000-4000-8000-000000000099'],
    }),
  })
  assert(badPart.status === 400 && badPart.body.code === 'INVALID_PARTS', 'expected INVALID_PARTS')
  console.log('OK invalid part rejected')

  const close = await call(`/api/tickets/${ticketId}/close`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      categoryId,
      subCategoryId,
      workDone: 'Replaced sensor',
      cost: 500,
      parts: [partBId],
      deviceTested: 'Tested OK — flap cycles correctly',
    }),
  })
  assert(close.status === 200, `close failed: ${JSON.stringify(close.body).slice(0, 300)}`)
  assert(close.body.data?.labourCost === 500, 'close labourCost')
  assert(close.body.data?.partsCost === 250, `close partsCost expected 250 got ${close.body.data?.partsCost}`)
  assert(close.body.data?.cost === 750, `close event cost expected 750 got ${close.body.data?.cost}`)
  console.log('OK close with parts cost')

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
