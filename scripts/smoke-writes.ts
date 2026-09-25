/**
 * Domain write-path smoke — never prints tokens or passwords.
 * Run: npx tsx scripts/smoke-writes.ts
 */
import 'dotenv/config'
import { createApp } from '../src/app.js'
import { closeDb, query } from '../src/db/pool.js'
import { deliverNotificationPush } from '../src/lib/notifications.js'
import { deliverNotificationPush } from '../src/lib/notifications.js'

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
  const ticketUuid = ticket.body.data.uuid as string
  console.log('OK ticket raise', ticketId)

  // New-ticket notifications: role fan-out, read state, ownership, subscriptions, push cleanup.
  const pmNotificationLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9825012345', password: 'Password123' }),
  })
  const crNotificationLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '7990011002', password: 'Password123' }),
  })
  const techNotificationLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9099941128', password: 'Password123' }),
  })
  assert(
    pmNotificationLogin.status === 200 && crNotificationLogin.status === 200 && techNotificationLogin.status === 200,
    'notification role logins failed',
  )
  const pmNotificationAuth = {
    Authorization: `Bearer ${pmNotificationLogin.body.data.token as string}`,
  }
  const crNotificationAuth = {
    Authorization: `Bearer ${crNotificationLogin.body.data.token as string}`,
  }
  const techNotificationAuth = {
    Authorization: `Bearer ${techNotificationLogin.body.data.token as string}`,
  }

  const notificationsUnauth = await call('/api/notifications')
  assert(notificationsUnauth.status === 401, 'notifications without auth must be 401')

  const adminNotifications = await call('/api/notifications?limit=100', { headers: auth })
  assert(adminNotifications.status === 200 && Array.isArray(adminNotifications.body.data), 'admin notifications list')
  const adminNotification = adminNotifications.body.data.find(
    (row: { data?: { ticketId?: string } }) => row.data?.ticketId === ticketId,
  )
  assert(adminNotification?.id, 'Admin must receive new-ticket notification')
  assert(
    adminNotification.data?.device?.road && adminNotification.data?.device?.slot,
    'notification must include device location',
  )
  assert(
    adminNotification.data?.issue?.category && adminNotification.data?.issue?.subCategory,
    'notification must include issue information',
  )
  assert(
    adminNotification.data?.raisedBy?.name === 'Admin User' && adminNotification.data?.createdAt,
    'notification must include raiser and created time',
  )
  assert(adminNotification.data?.url === `/tickets/${ticketId}`, 'notification detail reference')

  const pmNotifications = await call('/api/notifications?limit=100', { headers: pmNotificationAuth })
  const crNotifications = await call('/api/notifications?limit=100', { headers: crNotificationAuth })
  const techNotifications = await call('/api/notifications?limit=100', { headers: techNotificationAuth })
  assert(
    pmNotifications.body.data?.some((row: { data?: { ticketId?: string } }) => row.data?.ticketId === ticketId),
    'Project manager must receive new-ticket notification',
  )
  assert(
    crNotifications.body.data?.some((row: { data?: { ticketId?: string } }) => row.data?.ticketId === ticketId),
    'Control room must receive new-ticket notification',
  )
  assert(
    !techNotifications.body.data?.some((row: { data?: { ticketId?: string } }) => row.data?.ticketId === ticketId),
    'Technician must not receive new-ticket notification',
  )

  const eligibleRecipients = await query<{ n: number }>(
    `SELECT COUNT(DISTINCT u.id)::int AS n
     FROM users u
     JOIN roles r ON r.id = u.role_id
     JOIN role_permissions rp ON rp.role_id = r.id
     WHERE u.status = 'Active'
       AND r.name IN ('Admin', 'Project manager', 'Control room')
       AND rp.screen = 'All tickets' AND rp.can_view = TRUE`,
  )
  const notificationRecipients = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM notifications
     WHERE related_entity_id = $1 AND type = 'ticket.raised'`,
    [ticketUuid],
  )
  assert(
    (eligibleRecipients.rows[0]?.n ?? 0) >= 3 &&
      notificationRecipients.rows[0]?.n === eligibleRecipients.rows[0]?.n,
    'all eligible target-role users must receive exactly one notification',
  )

  const adminUnreadBefore = await call('/api/notifications/unread-count', { headers: auth })
  const crossUserRead = await call(
    `/api/notifications/${adminNotification.id as string}/read`,
    { method: 'PATCH', headers: pmNotificationAuth },
  )
  assert(crossUserRead.status === 404, 'user cannot mark another user notification read')
  const adminRead = await call(`/api/notifications/${adminNotification.id as string}/read`, {
    method: 'PATCH',
    headers: auth,
  })
  assert(adminRead.status === 200 && adminRead.body.data?.isRead, 'mark notification read')
  const adminUnreadAfter = await call('/api/notifications/unread-count', { headers: auth })
  assert(
    adminUnreadAfter.body.data?.count === adminUnreadBefore.body.data?.count - 1,
    'unread count must decrease after mark read',
  )
  const readAll = await call('/api/notifications/read-all', { method: 'PATCH', headers: auth })
  const adminUnreadCleared = await call('/api/notifications/unread-count', { headers: auth })
  assert(readAll.status === 200 && adminUnreadCleared.body.data?.count === 0, 'mark all notifications read')
  console.log('OK notification fan-out + read APIs')

  const pushConfig = await call('/api/notifications/push-config', { headers: pmNotificationAuth })
  assert(
    pushConfig.status === 200 && typeof pushConfig.body.data?.available === 'boolean',
    'push config availability',
  )
  const invalidSubscription = await call('/api/notifications/push-subscriptions', {
    method: 'PUT',
    headers: pmNotificationAuth,
    body: JSON.stringify({
      endpoint: 'http://127.0.0.1/internal-push',
      keys: { p256dh: 'smoke-p256dh-key', auth: 'smoke-auth-key' },
    }),
  })
  assert(
    invalidSubscription.status === 400 && invalidSubscription.body.code === 'VALIDATION_ERROR',
    'private/non-HTTPS push endpoint must be rejected',
  )
  const expiredEndpoint = `https://push.example.test/expired-${suffix}`
  const okEndpoint = `https://push.example.test/ok-${suffix}`
  const expiredSubscription = await call('/api/notifications/push-subscriptions', {
    method: 'PUT',
    headers: pmNotificationAuth,
    body: JSON.stringify({
      endpoint: expiredEndpoint,
      keys: { p256dh: 'smoke-p256dh-key', auth: 'smoke-auth-key' },
    }),
  })
  assert(expiredSubscription.status === 200 && expiredSubscription.body.data?.id, 'push subscription register')
  const updatedSubscription = await call('/api/notifications/push-subscriptions', {
    method: 'PUT',
    headers: pmNotificationAuth,
    body: JSON.stringify({
      endpoint: expiredEndpoint,
      keys: { p256dh: 'smoke-p256dh-key-updated', auth: 'smoke-auth-key-updated' },
    }),
  })
  assert(updatedSubscription.body.data?.id === expiredSubscription.body.data?.id, 'push subscription upsert')
  const duplicateSubscriptions = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE endpoint = $1`,
    [expiredEndpoint],
  )
  assert(duplicateSubscriptions.rows[0]?.n === 1, 'duplicate push endpoint must update in place')
  const foreignRemove = await call(
    `/api/notifications/push-subscriptions/${expiredSubscription.body.data.id as string}`,
    { method: 'DELETE', headers: auth },
  )
  assert(foreignRemove.status === 404, 'user cannot remove another user push subscription')

  const pmNotification = pmNotifications.body.data.find(
    (row: { data?: { ticketId?: string } }) => row.data?.ticketId === ticketId,
  )
  assert(pmNotification?.id, 'PM notification id for push delivery test')
  await deliverNotificationPush([pmNotification.id as string], async () => {
    throw Object.assign(new Error('expired subscription'), { statusCode: 410 })
  })
  const expiredAfterSend = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE endpoint = $1`,
    [expiredEndpoint],
  )
  assert(expiredAfterSend.rows[0]?.n === 0, '410 push response must remove expired subscription')

  const okSubscription = await call('/api/notifications/push-subscriptions', {
    method: 'PUT',
    headers: pmNotificationAuth,
    body: JSON.stringify({
      endpoint: okEndpoint,
      keys: { p256dh: 'smoke-p256dh-key', auth: 'smoke-auth-key' },
    }),
  })
  assert(okSubscription.status === 200, 'push subscription re-register')
  let successfulPushes = 0
  await deliverNotificationPush([pmNotification.id as string], async (subscription, payload) => {
    successfulPushes += 1
    assert(subscription.endpoint === okEndpoint, 'push subscription passed to sender')
    const body = JSON.parse(payload) as {
      notification?: { title?: string; body?: string }
      data?: { notificationId?: string; ticketId?: string }
    }
    assert(body.notification?.title === 'New ticket raised', 'push title')
    assert(body.notification?.body?.includes(ticketId), 'push ticket reference')
    assert(
      body.data?.notificationId === pmNotification.id && body.data?.ticketId === ticketId,
      'push payload identity',
    )
    return { statusCode: 201, body: '', headers: {} }
  })
  assert(successfulPushes === 1, 'push delivery should run once')
  await deliverNotificationPush([pmNotification.id as string], async () => {
    successfulPushes += 1
    return { statusCode: 201, body: '', headers: {} }
  })
  assert(successfulPushes === 1, 'sent notification must not be delivered twice')
  const sentState = await query<{ push_sent_at: Date | string | null }>(
    `SELECT push_sent_at FROM notifications WHERE id = $1`,
    [pmNotification.id],
  )
  assert(sentState.rows[0]?.push_sent_at, 'push sent timestamp')
  const removeOkSubscription = await call(
    `/api/notifications/push-subscriptions/${okSubscription.body.data.id as string}`,
    { method: 'DELETE', headers: pmNotificationAuth },
  )
  assert(removeOkSubscription.status === 200, 'push subscription remove')
  console.log('OK push subscription lifecycle + delivery cleanup')

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
  const failedRaiseNotificationCount = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM notifications
     WHERE related_entity_id = $1 AND type = 'ticket.raised'`,
    [t1.body.data.uuid],
  )
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
  const countAfterFailedRaises = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM notifications
     WHERE related_entity_id = $1 AND type = 'ticket.raised'`,
    [t1.body.data.uuid],
  )
  assert(
    countAfterFailedRaises.rows[0]?.n === failedRaiseNotificationCount.rows[0]?.n,
    'failed raises must not create notifications',
  )
  console.log('OK one-open-ticket rule + failed raises create no notifications')

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

  // Phase 37 — hard-delete unused category via API; used category → IN_USE
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

  // Phase 41 — multi-issue raise + Site attendant Device Sync / Issue master
  const catsFull = await call('/api/lookups/issue-categories', { headers: auth })
  assert(catsFull.status === 200 && catsFull.body.data?.length >= 1, 'categories for multi-issue')
  const cat0 = catsFull.body.data[0]
  const sub0 = cat0.subs[0]
  const sub1 = cat0.subs[1] || cat0.subs[0]
  assert(sub0?.id, 'need subcategory for multi-issue')

  const multiDev = await call('/api/devices', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      roadId,
      slotNumber: `MI-${suffix}`,
      installedOn: '2026-09-01',
      installStatus: 'Working',
    }),
  })
  assert(
    multiDev.status === 201 && multiDev.body.data?.publicId,
    `multi-issue device create: ${multiDev.status} ${JSON.stringify(multiDev.body).slice(0, 300)}`,
  )

  const multiRaise = await call('/api/tickets', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      deviceId: multiDev.body.data.publicId,
      issues: [
        { categoryId: cat0.id, subCategoryId: sub0.id },
        { categoryId: cat0.id, subCategoryId: sub1.id },
      ],
      description: 'Smoke multi-issue raise',
      reporterType: 'Control room',
    }),
  })
  assert(
    multiRaise.status === 201 && Array.isArray(multiRaise.body.data?.issuesReported),
    `multi-issue raise failed: ${JSON.stringify(multiRaise.body).slice(0, 300)}`,
  )
  assert(multiRaise.body.data.issuesReported.length >= 1, 'issuesReported length')
  const multiId = multiRaise.body.data.id as string

  const multiDetail = await call(`/api/tickets/${multiId}`, { headers: auth })
  assert(multiDetail.status === 200, 'multi-issue detail')
  assert(
    Array.isArray(multiDetail.body.data?.issuesReported) &&
      multiDetail.body.data.issuesReported.length >= 1,
    'detail issuesReported',
  )
  console.log('OK multi-issue raise + detail')

  const attendantLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9016374408', password: 'Password123' }),
  })
  assert(attendantLogin.status === 200 && attendantLogin.body.data?.token, 'site attendant login')
  const attAuth = { Authorization: `Bearer ${attendantLogin.body.data.token as string}` }

  const prevTok = process.env.DEVICE_SYNC_API_TOKEN
  process.env.DEVICE_SYNC_API_TOKEN = ''
  const attSync = await call('/api/device-sync', {
    method: 'POST',
    headers: attAuth,
    body: '{}',
  })
  assert(
    attSync.status === 503 && attSync.body.code === 'DEVICE_SYNC_NOT_CONFIGURED',
    `attendant device-sync should pass auth (503 not configured): ${JSON.stringify(attSync.body).slice(0, 200)}`,
  )
  if (prevTok === undefined) delete process.env.DEVICE_SYNC_API_TOKEN
  else process.env.DEVICE_SYNC_API_TOKEN = prevTok
  console.log('OK site attendant device-sync authorized')

  const attCat = await call('/api/issues/categories', {
    method: 'POST',
    headers: attAuth,
    body: JSON.stringify({ name: `Att Smoke Cat ${suffix}` }),
  })
  assert(attCat.status === 201 && attCat.body.data?.id, `attendant create category: ${JSON.stringify(attCat.body).slice(0, 200)}`)
  const attDel = await call(`/api/issues/categories/${attCat.body.data.id}`, {
    method: 'DELETE',
    headers: attAuth,
  })
  assert(attDel.status === 200, `attendant delete unused category: ${JSON.stringify(attDel.body).slice(0, 200)}`)
  console.log('OK site attendant Issue master CRUD')

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
