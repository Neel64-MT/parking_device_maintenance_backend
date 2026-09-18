/**
 * Domain write-path smoke — never prints tokens or passwords.
 * Run: npx tsx scripts/smoke-writes.ts
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
    device.status === 201 && device.body.data?.publicId,
    `device create failed: ${device.status} ${JSON.stringify(device.body).slice(0, 300)}`,
  )
  const devicePublicId = device.body.data.publicId as string
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
    body: JSON.stringify({ assigneeId: tech.id, reason: 'Smoke assign note' }),
  })
  assert(assign.status === 200, `assign failed: ${JSON.stringify(assign.body).slice(0, 200)}`)
  assert(assign.body.data?.assigneeId === tech.id, 'assign response assigneeId')
  assert(typeof assign.body.data?.assigneeName === 'string' && assign.body.data.assigneeName.length > 0, 'assign assigneeName')
  assert(Array.isArray(assign.body.data?.assignmentTrail), 'assign assignmentTrail')
  const trailAfterAssign = assign.body.data.assignmentTrail.length as number
  assert(trailAfterAssign >= 1, 'assignment trail should grow after assign')
  assert(
    assign.body.data.assignmentTrail.some((row: { body?: string }) => row.body === 'Smoke assign note'),
    'optional reason on trail',
  )
  console.log('OK assign')

  const detailAfter = await call(`/api/tickets/${ticketId}`, { headers: auth })
  assert(detailAfter.status === 200 && detailAfter.body.data?.assigneeId === tech.id, 'detail assignee after assign')
  assert(
    Array.isArray(detailAfter.body.data?.assignmentTrail) &&
      detailAfter.body.data.assignmentTrail.length === trailAfterAssign,
    'detail trail matches assign response',
  )

  const sameAssign = await call(`/api/tickets/${ticketId}/assign`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ assigneeId: tech.id }),
  })
  assert(sameAssign.status === 200 && sameAssign.body.message === 'Already assigned', 'idempotent same assignee')
  assert(
    sameAssign.body.data?.assignmentTrail?.length === trailAfterAssign,
    'same assignee must not grow trail',
  )
  console.log('OK assign idempotent')

  const techB = users.body.data.users.find(
    (u: { role: string; status: string; id: string }) =>
      u.role === 'Technician' && u.status === 'Active' && u.id !== tech.id,
  )
  if (techB?.id) {
    const reassign = await call(`/api/tickets/${ticketId}/assign`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ assigneeId: techB.id }),
    })
    assert(reassign.status === 200 && reassign.body.data?.assigneeId === techB.id, 'reassign failed')
    assert(
      reassign.body.data.assignmentTrail.length === trailAfterAssign + 1,
      'reassign must grow trail',
    )
    console.log('OK reassign trail')
  }

  const badAssignee = await call(`/api/tickets/${ticketId}/assign`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ assigneeId: '00000000-0000-4000-8000-000000000099' }),
  })
  assert(
    badAssignee.status === 400 && badAssignee.body.code === 'INVALID_ASSIGNEE',
    `expected INVALID_ASSIGNEE: ${JSON.stringify(badAssignee.body).slice(0, 200)}`,
  )
  console.log('OK invalid assignee rejected')

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
  assert(device2.status === 201 && device2.body.data?.publicId, 'device2 create failed')
  const device2Id = device2.body.data.publicId as string
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
  const [raceA, raceB] = await Promise.all([
    call('/api/tickets', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        deviceId: device2Id,
        categoryId,
        subCategoryId,
        description: 'Race A',
        reporterType: 'Control room',
      }),
    }),
    call('/api/tickets', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        deviceId: device2Id,
        categoryId,
        subCategoryId,
        description: 'Race B',
        reporterType: 'Control room',
      }),
    }),
  ])
  assert(
    [raceA, raceB].every((r) => r.status === 409 && r.body.code === 'OPEN_TICKET_EXISTS'),
    'concurrent raises against open device must both 409',
  )
  assert(
    raceA.body.details?.openTicketId === t1.body.data.id &&
      raceB.body.details?.openTicketId === t1.body.data.id,
    'race 409 must return existing openTicketId',
  )
  console.log('OK concurrent raise blocked by one-open index')

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

  // Phase 38 — hard-delete unused category via API; used category → IN_USE
  const delEmptyCat = await call(`/api/issues/categories/${smokeCatId}`, {
    method: 'DELETE',
    headers: auth,
  })
  assert(delEmptyCat.status === 200, `delete unused category failed: ${JSON.stringify(delEmptyCat.body).slice(0, 200)}`)
  console.log('OK unused category hard-delete')

  const usedCatId = (
    await query<{ id: string }>(
      `SELECT reported_category_id AS id FROM tickets WHERE reported_category_id IS NOT NULL LIMIT 1`,
    )
  ).rows[0]?.id
  if (usedCatId) {
    const delUsedCat = await call(`/api/issues/categories/${usedCatId}`, {
      method: 'DELETE',
      headers: auth,
    })
    assert(
      delUsedCat.status === 409 && delUsedCat.body.code === 'IN_USE',
      `expected IN_USE on used category: ${JSON.stringify(delUsedCat.body).slice(0, 200)}`,
    )
    console.log('OK used category cannot hard-delete')
  } else {
    console.log('SKIP used category IN_USE (no ticket with reported_category_id)')
  }

  const softCat = await call('/api/issues/categories', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: `Smoke Soft Cat ${suffix}` }),
  })
  assert(softCat.status === 201 && softCat.body.data?.id, 'soft-test category create failed')
  const softPatch = await call(`/api/issues/categories/${softCat.body.data.id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ active: false }),
  })
  assert(softPatch.status === 200 && softPatch.body.data?.active === false, 'category soft-deactivate failed')
  const techDelLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9099941128', password: 'Password123' }),
  })
  assert(techDelLogin.status === 200 && techDelLogin.body.data?.token, 'tech login for category delete')
  const techDelAuth = { Authorization: `Bearer ${techDelLogin.body.data.token as string}` }
  // Soft-inactive category still hard-deletes when unused
  const techDelCat = await call(`/api/issues/categories/${softCat.body.data.id}`, {
    method: 'DELETE',
    headers: techDelAuth,
  })
  assert(techDelCat.status === 200, `tech delete unused category failed: ${JSON.stringify(techDelCat.body).slice(0, 200)}`)
  console.log('OK tech hard-delete unused category')

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

  // Phase 33 — slot-mac validation (no live SmartPark required)
  const slotMacEmpty = await call('/api/devices/slot-mac', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({}),
  })
  assert(
    slotMacEmpty.status === 400 && slotMacEmpty.body.code === 'VALIDATION_ERROR',
    'slot-mac empty body must be 400',
  )
  const prevSlotTok = process.env.DEVICE_SYNC_API_TOKEN
  process.env.DEVICE_SYNC_API_TOKEN = ''
  const slotMacNoCfg = await call('/api/devices/slot-mac', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ qr_token: 'smoke-token' }),
  })
  assert(
    slotMacNoCfg.status === 503 && slotMacNoCfg.body.code === 'DEVICE_SYNC_NOT_CONFIGURED',
    'slot-mac without token must be 503',
  )
  if (prevSlotTok === undefined) delete process.env.DEVICE_SYNC_API_TOKEN
  else process.env.DEVICE_SYNC_API_TOKEN = prevSlotTok
  console.log('OK slot-mac validation')

  // Soft-inactivate a non-admin user created earlier is covered in auth smoke;
  // here verify PATCH inactive on a technician is allowed for Admin
  const patchUser = await call(`/api/users/${tech.id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ status: 'Active' }),
  })
  assert(patchUser.status === 200, `user patch failed: ${JSON.stringify(patchUser.body).slice(0, 200)}`)
  console.log('OK user patch')

  // Phase 36 — role hierarchy on user create / role assign
  const rolesRes = await call('/api/roles', { headers: auth })
  assert(rolesRes.status === 200 && Array.isArray(rolesRes.body.data), 'roles list failed')
  const roleIdByName = Object.fromEntries(
    (rolesRes.body.data as Array<{ id: string; name: string }>).map((r) => [r.name, r.id]),
  ) as Record<string, string>
  assert(roleIdByName.Admin && roleIdByName['Project manager'] && roleIdByName.Technician, 'missing seeded roles')

  const adminCreatesPm = await call('/api/users', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      fullName: `Smoke Hier PM ${suffix}`,
      mobile: `91${suffix}001`,
      email: `smoke.hier.pm.${suffix}@yopmail.com`,
      password: 'Password123',
      roleId: roleIdByName['Project manager'],
      roadIds: [],
    }),
  })
  assert(
    adminCreatesPm.status === 201,
    `admin create PM failed: ${JSON.stringify(adminCreatesPm.body).slice(0, 200)}`,
  )
  console.log('OK admin creates Project manager')

  const pmLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9825012345', password: 'Password123' }),
  })
  assert(pmLogin.status === 200 && pmLogin.body.data?.token, 'PM login failed')
  const pmAuth = { Authorization: `Bearer ${pmLogin.body.data.token as string}` }

  const pmCreatesSame = await call('/api/users', {
    method: 'POST',
    headers: pmAuth,
    body: JSON.stringify({
      fullName: `Smoke Hier Same ${suffix}`,
      mobile: `91${suffix}002`,
      email: `smoke.hier.same.${suffix}@yopmail.com`,
      password: 'Password123',
      roleId: roleIdByName['Project manager'],
      roadIds: [],
    }),
  })
  assert(
    pmCreatesSame.status === 201,
    `PM create same role failed: ${JSON.stringify(pmCreatesSame.body).slice(0, 200)}`,
  )

  const pmCreatesTech = await call('/api/users', {
    method: 'POST',
    headers: pmAuth,
    body: JSON.stringify({
      fullName: `Smoke Hier Tech ${suffix}`,
      mobile: `91${suffix}003`,
      email: `smoke.hier.tech.${suffix}@yopmail.com`,
      password: 'Password123',
      roleId: roleIdByName.Technician,
      roadIds: [],
    }),
  })
  assert(
    pmCreatesTech.status === 201,
    `PM create Technician failed: ${JSON.stringify(pmCreatesTech.body).slice(0, 200)}`,
  )
  console.log('OK PM creates same and lower roles')

  const pmCreatesAdmin = await call('/api/users', {
    method: 'POST',
    headers: pmAuth,
    body: JSON.stringify({
      fullName: `Smoke Hier Admin ${suffix}`,
      mobile: `91${suffix}004`,
      email: `smoke.hier.admin.${suffix}@yopmail.com`,
      password: 'Password123',
      roleId: roleIdByName.Admin,
      roadIds: [],
    }),
  })
  assert(
    pmCreatesAdmin.status === 403 && pmCreatesAdmin.body.code === 'FORBIDDEN',
    `expected PM create Admin 403: ${JSON.stringify(pmCreatesAdmin.body).slice(0, 200)}`,
  )
  console.log('OK PM cannot create Admin')

  const pmPromoteAdmin = await call(`/api/users/${pmCreatesTech.body.data.id}`, {
    method: 'PATCH',
    headers: pmAuth,
    body: JSON.stringify({ roleId: roleIdByName.Admin }),
  })
  assert(
    pmPromoteAdmin.status === 403 && pmPromoteAdmin.body.code === 'FORBIDDEN',
    `expected PM promote Admin 403: ${JSON.stringify(pmPromoteAdmin.body).slice(0, 200)}`,
  )
  console.log('OK PM cannot PATCH role to Admin')

  // Phase 39 — Roles matrix hierarchy + upload gate
  // PM seed is Roles view-only; temporarily grant `e` so hierarchy (not missing `e`) is what we test.
  const pmRoleRow = (rolesRes.body.data as Array<{
    id: string
    name: string
    permissions: Record<string, string>
  }>).find((r) => r.name === 'Project manager')
  assert(pmRoleRow?.permissions, 'Project manager role permissions missing')
  const pmPermsWithRolesEdit = {
    ...pmRoleRow.permissions,
    'Roles & permissions': 'v.e...',
  }
  const grantPmRolesEdit = await call(`/api/roles/${roleIdByName['Project manager']}/permissions`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ permissions: pmPermsWithRolesEdit }),
  })
  assert(
    grantPmRolesEdit.status === 200,
    `grant PM Roles e failed: ${JSON.stringify(grantPmRolesEdit.body).slice(0, 200)}`,
  )
  // Re-login so JWT session loads fresh permissions from DB
  const pmLogin2 = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9825012345', password: 'Password123' }),
  })
  assert(pmLogin2.status === 200 && pmLogin2.body.data?.token, 'PM re-login after Roles e')
  const pmAuth2 = { Authorization: `Bearer ${pmLogin2.body.data.token as string}` }

  const techRoleRow = (rolesRes.body.data as Array<{
    id: string
    name: string
    permissions: Record<string, string>
  }>).find((r) => r.name === 'Technician')
  assert(techRoleRow?.permissions, 'Technician role permissions missing')

  const pmPatchAdminPerms = await call(`/api/roles/${roleIdByName.Admin}/permissions`, {
    method: 'PATCH',
    headers: pmAuth2,
    body: JSON.stringify({ permissions: { Dashboard: 'v.....' } }),
  })
  assert(
    pmPatchAdminPerms.status === 403 && pmPatchAdminPerms.body.code === 'FORBIDDEN',
    `expected PM PATCH Admin perms 403: ${JSON.stringify(pmPatchAdminPerms.body).slice(0, 200)}`,
  )

  const pmPatchTechPerms = await call(`/api/roles/${roleIdByName.Technician}/permissions`, {
    method: 'PATCH',
    headers: pmAuth2,
    body: JSON.stringify({ permissions: techRoleRow.permissions }),
  })
  assert(
    pmPatchTechPerms.status === 200,
    `PM PATCH Technician perms failed: ${JSON.stringify(pmPatchTechPerms.body).slice(0, 200)}`,
  )

  const restorePmRoles = await call(`/api/roles/${roleIdByName['Project manager']}/permissions`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ permissions: pmRoleRow.permissions }),
  })
  assert(restorePmRoles.status === 200, 'restore PM Roles matrix failed')
  console.log('OK Roles matrix hierarchy (PM cannot edit Admin; can edit Technician)')

  const adminPatchAdminPerms = await call(`/api/roles/${roleIdByName.Admin}/permissions`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ permissions: { Dashboard: '......' } }),
  })
  assert(
    adminPatchAdminPerms.status === 403 && adminPatchAdminPerms.body.code === 'FORBIDDEN',
    `expected Admin PATCH Admin perms 403: ${JSON.stringify(adminPatchAdminPerms.body).slice(0, 200)}`,
  )

  const techDefaults = (
    rolesRes.body.data as Array<{ name: string; defaultPermissions?: Record<string, string> }>
  ).find((r) => r.name === 'Technician')?.defaultPermissions
  assert(techDefaults?.['Raise ticket'], 'Technician defaultPermissions missing from GET /api/roles')

  const resetTech = await call(`/api/roles/${roleIdByName.Technician}/permissions/reset`, {
    method: 'POST',
    headers: auth,
  })
  assert(
    resetTech.status === 200 && resetTech.body.data?.permissions?.['Raise ticket'] === 'vc....',
    `reset Technician failed: ${JSON.stringify(resetTech.body).slice(0, 200)}`,
  )
  console.log('OK Admin locked + reset to defaults')

  const amcLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9879060013', password: 'Password123' }),
  })
  assert(amcLogin.status === 200 && amcLogin.body.data?.token, 'AMC login for upload gate')
  const amcAuth = { Authorization: `Bearer ${amcLogin.body.data.token as string}` }
  const amcForm = new FormData()
  amcForm.append('file', new Blob(['amc-photo'], { type: 'image/jpeg' }), 'amc.jpg')
  const amcUpload = await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: amcAuth,
    body: amcForm,
  })
  const amcUploadBody = await amcUpload.json().catch(() => ({}))
  assert(
    amcUpload.status === 403 && amcUploadBody.code === 'FORBIDDEN',
    `expected AMC upload 403: ${JSON.stringify(amcUploadBody).slice(0, 200)}`,
  )
  console.log('OK upload gated for view-only role')

  const badRoleId = await call('/api/users', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      fullName: `Smoke Hier Bad ${suffix}`,
      mobile: `91${suffix}005`,
      email: `smoke.hier.bad.${suffix}@yopmail.com`,
      password: 'Password123',
      roleId: '00000000-0000-4000-8000-000000000099',
      roadIds: [],
    }),
  })
  assert(
    badRoleId.status === 404 && badRoleId.body.code === 'NOT_FOUND',
    `expected invalid roleId 404: ${JSON.stringify(badRoleId.body).slice(0, 200)}`,
  )
  console.log('OK invalid roleId 404')

  // Soft-inactivate is preferred for real users; hard-delete smoke hier leftovers so Users UI stays clean
  const smokeHierIds = [
    adminCreatesPm.body.data?.id,
    pmCreatesSame.body.data?.id,
    pmCreatesTech.body.data?.id,
  ].filter(Boolean) as string[]
  if (smokeHierIds.length) {
    await query(`DELETE FROM user_roads WHERE user_id = ANY($1::uuid[])`, [smokeHierIds])
    await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [smokeHierIds])
  }
  console.log('OK smoke hierarchy users cleaned up')

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
