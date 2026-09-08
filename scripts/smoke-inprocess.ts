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
  const paths = [
    '/api/auth/me',
    '/api/dashboard',
    '/api/tickets',
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

  // Ensure seeded coords exist for scan shape check (idempotent if seed already ran)
  await query(
    `UPDATE devices SET
       latitude = COALESCE(latitude, '23.079200'),
       longitude = COALESCE(longitude, '72.497500')
     WHERE public_id = 'PD-0428'`,
  )
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
  console.log('OK forgot-password known email')

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

  const forgotBad = await call('/api/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email: 'not-an-email' }),
  })
  assert(forgotBad.status === 400, 'forgot invalid email expected 400')
  console.log('OK forgot-password validation 400')

  // Reset password
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

  const newLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: email, password: 'SmokePass1' }),
  })
  assert(newLogin.status === 200 && newLogin.body.data?.token, 'new user login failed')
  console.log('OK new user login')

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

  // Ticket visibility: non-privileged user cannot open unrelated tickets
  const adminTickets = await call('/api/tickets?limit=100', { headers: pmAuthApprove })
  assert(adminTickets.status === 200 && Array.isArray(adminTickets.body.data), 'pm ticket list failed')
  const foreign = adminTickets.body.data.find(
    (t: { assignedTo: string | null; id: string }) =>
      t.assignedTo && t.assignedTo !== 'Ramesh Vaghela',
  )
  assert(foreign?.id, 'need a ticket not assigned to Ramesh for visibility test')

  const techList = await call('/api/tickets?limit=100', { headers: techAuth })
  assert(techList.status === 200, 'tech ticket list failed')
  assert(
    !techList.body.data.some((t: { id: string }) => t.id === foreign.id),
    'tech list must not include unrelated ticket',
  )
  console.log('OK tech ticket list scoped')
  assert(
    techList.body.pagination?.total <= adminTickets.body.pagination?.total ||
      techList.body.pagination?.total >= 0,
    'tech pagination total must be defined',
  )
  const techAll = await call('/api/tickets?limit=100', { headers: techAuth })
  const pmAll = await call('/api/tickets?limit=100', { headers: pmAuthApprove })
  assert(techAll.status === 200 && pmAll.status === 200, 'scoped total compare failed')
  assert(
    techAll.body.pagination.total <= pmAll.body.pagination.total,
    'tech total must be <= PM total',
  )
  console.log('OK tech pagination total scoped')

  const techDetail = await call(`/api/tickets/${foreign.id}`, { headers: techAuth })
  assert(techDetail.status === 403, `tech detail must be forbidden: ${techDetail.status}`)
  console.log('OK tech cannot open unrelated ticket by id')

  const owned = techList.body.data[0]
  if (owned?.id) {
    const ownDetail = await call(`/api/tickets/${owned.id}`, { headers: techAuth })
    assert(ownDetail.status === 200, 'tech should open own ticket')
    console.log('OK tech can open own ticket')
  }

  const pmDetail = await call(`/api/tickets/${foreign.id}`, { headers: pmAuthApprove })
  assert(pmDetail.status === 200, 'PM must still open any ticket')
  console.log('OK PM city-wide ticket access')

  // Site attendant sees tickets they raised even when the device road is outside their assignment
  const attendantLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '9016374408', password: 'Password123' }),
  })
  assert(attendantLogin.status === 200 && attendantLogin.body.data?.token, 'site attendant login failed')
  const attendantAuth = { Authorization: `Bearer ${attendantLogin.body.data.token as string}` }
  const attendantTickets = await call('/api/tickets?tab=new&limit=100', { headers: attendantAuth })
  assert(attendantTickets.status === 200, 'site attendant ticket list failed')
  const attendantIds = (attendantTickets.body.data || []).map((t: { id: string }) => t.id)
  assert(attendantIds.includes('TK-1099'), 'raiser must see Open ticket on a non-assigned road (TK-1099)')
  assert(attendantIds.includes('TK-1101'), 'raiser must see own Science City Open ticket (TK-1101)')
  const attendantDetail = await call('/api/tickets/TK-1099', { headers: attendantAuth })
  assert(attendantDetail.status === 200, 'raiser must open own ticket detail on non-assigned road')
  console.log('OK site attendant sees tickets they raised across roads')

  // Control room can assign a ticket they did not raise (road access only)
  const crLogin = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: '7990011002', password: 'Password123' }),
  })
  assert(crLogin.status === 200 && crLogin.body.data?.token, 'control room login failed')
  const crAuth = { Authorization: `Bearer ${crLogin.body.data.token as string}` }

  const techUsers = await call('/api/lookups/technicians', { headers: crAuth })
  assert(techUsers.status === 200 && Array.isArray(techUsers.body.data), 'technicians lookup failed')
  const techAssignee = techUsers.body.data.find(
    (u: { name: string; id: string }) => u.name === 'Ramesh Vaghela' || u.id,
  )
  assert(techAssignee?.id, 'need a technician id to assign')

  const assignOpen = await call('/api/tickets/TK-1078/assign', {
    method: 'POST',
    headers: crAuth,
    body: JSON.stringify({ assigneeId: techAssignee.id, reason: 'Smoke assign by control room' }),
  })
  assert(
    assignOpen.status === 200,
    `control room assign must succeed: ${assignOpen.status} ${JSON.stringify(assignOpen.body)}`,
  )
  console.log('OK control room assign without ownership')

  const techAssign = await call('/api/tickets/TK-1078/assign', {
    method: 'POST',
    headers: techAuth,
    body: JSON.stringify({ assigneeId: techAssignee.id, reason: 'tech must not assign' }),
  })
  assert(techAssign.status === 403, 'technician must not assign or reassign')
  console.log('OK tech cannot assign')

  const otherTech = techUsers.body.data.find((u: { name: string }) => u.name === 'Jignesh Solanki')
  assert(otherTech?.id, 'need another technician for handover test')
  const techHandover = await call('/api/tickets/TK-1042/updates', {
    method: 'POST',
    headers: techAuth,
    body: JSON.stringify({
      updateType: 'Site visit — not resolved',
      workDone: 'Handover attempt',
      handoverToUserId: otherTech.id,
    }),
  })
  assert(techHandover.status === 403, 'technician must not handover/reassign on update')
  console.log('OK tech cannot handover')

  // Control room has Dashboard v but is not Admin/PM — openTickets must respect visibility
  const crDash = await call('/api/dashboard', { headers: crAuth })
  assert(crDash.status === 200 && crDash.body.success, 'control room dashboard failed')
  const dashIds = (crDash.body.data.openTickets || []).map((t: { id: string }) => t.id)
  assert(!dashIds.includes(foreign.id), 'control room dashboard must not list unrelated open ticket')
  console.log('OK control room dashboard openTickets scoped')

  // Device list/history: open ticket overlays and history must respect visibility
  const foreignOpen = adminTickets.body.data.find(
    (t: { assignedTo: string | null; id: string; status: string; deviceId: string }) =>
      t.assignedTo &&
      t.assignedTo !== 'Ramesh Vaghela' &&
      t.status !== 'Closed' &&
      t.deviceId,
  )
  assert(foreignOpen?.deviceId, 'need an open unrelated ticket with device for device-scope test')

  const techDevices = await call('/api/devices', { headers: techAuth })
  assert(techDevices.status === 200 && Array.isArray(techDevices.body.data), 'tech devices failed')
  assert(
    !(techDevices.body.data || []).some(
      (d: { ticketId: string | null }) => d.ticketId === foreignOpen.id,
    ),
    'tech device list must not expose unrelated open ticket',
  )
  console.log('OK tech device list open-ticket scoped')

  const techDeviceDetail = await call(`/api/devices/${foreignOpen.deviceId}`, { headers: techAuth })
  if (techDeviceDetail.status === 200) {
    const histIds = (techDeviceDetail.body.data.tickets || []).map((t: { id: string }) => t.id)
    assert(
      !histIds.includes(foreignOpen.id),
      'tech device history must not include unrelated ticket',
    )
    console.log('OK tech device history ticket scoped')
  } else {
    assert(
      techDeviceDetail.status === 403,
      `tech device detail unexpected: ${techDeviceDetail.status}`,
    )
    console.log('OK tech device detail blocked by road scope')
  }

  // Work report (Control room): ticket rows must respect visibility
  const crWork = await call('/api/reports/work?view=month', { headers: crAuth })
  assert(crWork.status === 200 && crWork.body.success, 'control room work report failed')
  const workTicketIds = (crWork.body.data.people || []).flatMap(
    (p: { tickets?: string[][] }) => (p.tickets || []).map((row) => row[0]),
  )
  assert(
    !workTicketIds.includes(foreign.id),
    'control room work report must not include unrelated ticket',
  )
  console.log('OK control room work report scoped')

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
