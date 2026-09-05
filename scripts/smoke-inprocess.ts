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
    body: JSON.stringify({ password: 'ShouldFail1' }),
  })
  assert(pmPatch.status === 403, 'PM must not change passwords')
  console.log('OK PM forbidden from password change')

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
