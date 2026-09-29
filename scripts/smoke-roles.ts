/**
 * Role delete guard smoke — never prints tokens or passwords.
 * Run: npm run test:smoke:roles
 *
 * Covers: delete with no users, delete blocked with one user, blocked with
 * several users, blocked through a direct API call, role + matrix intact after
 * a failed delete, authorization preserved, and delete allowed again once the
 * users are moved to another role.
 */
import 'dotenv/config'

import { createApp } from '../src/app.js'
import { closeDb, query } from '../src/db/pool.js'

const app = createApp()
const server = app.listen(0)
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`

const ASSIGNED_MESSAGE =
  'Role is assigned to users. Please change their role before deleting it.'

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

type Session = { auth: Record<string, string>; role: string }

async function login(identifier: string, password = 'Password123'): Promise<Session> {
  const res = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier, password }),
  })
  assert(res.status === 200 && res.body.data?.token, `login failed for ${identifier}`)
  const auth = { Authorization: `Bearer ${res.body.data.token as string}` }
  const me = await call('/api/auth/me', { headers: auth })
  assert(me.status === 200 && me.body.data?.id, `me failed for ${identifier}`)
  return { auth, role: String(me.body.data.role) }
}

type RoleRow = { id: string; name: string; users: number }

async function listRoles(auth: Record<string, string>): Promise<RoleRow[]> {
  const res = await call('/api/roles', { headers: auth })
  assert(res.status === 200 && Array.isArray(res.body.data), `roles list failed: ${res.status}`)
  return res.body.data as RoleRow[]
}

async function roleIdByName(auth: Record<string, string>, name: string): Promise<string> {
  const role = (await listRoles(auth)).find((r) => r.name === name)
  assert(role, `${name} role not found`)
  return role.id
}

const suffix = String(Date.now()).slice(-8)

/** Users created by this smoke, removed at the end so the list stays clean. */
const createdUserIds: string[] = []
/** Roles created by this smoke, removed at the end. */
const createdRoleIds: string[] = []
/** Second Inactive account created in the "Inactive does not block" case. */
let lastInactiveId = ''

async function createRole(auth: Record<string, string>, name: string): Promise<string> {
  const res = await call('/api/roles', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name }),
  })
  assert(
    res.status === 201 && res.body.data?.id,
    `create role ${name} failed: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`,
  )
  createdRoleIds.push(res.body.data.id as string)
  return res.body.data.id as string
}

async function createUser(auth: Record<string, string>, roleId: string, tag: string) {
  const n = `${suffix}${tag}`.slice(-10)
  const res = await call('/api/users', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      fullName: `Smoke Role ${tag} ${suffix}`,
      mobile: `9${n}`,
      email: `smoke.role.${n}@yopmail.com`,
      password: 'SmokePass1',
      roleId,
      roadIds: [],
    }),
  })
  assert(
    res.status === 201 && res.body.data?.id,
    `create user ${tag} failed: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`,
  )
  createdUserIds.push(res.body.data.id as string)
  return res.body.data.id as string
}

async function deleteSmokeData() {
  const users = createdUserIds.filter(Boolean)
  if (users.length) {
    await query(`UPDATE tickets SET raised_by_user_id = NULL WHERE raised_by_user_id = ANY($1::uuid[])`, [users])
    await query(`UPDATE tickets SET assignee_id = NULL WHERE assignee_id = ANY($1::uuid[])`, [users])
    await query(`UPDATE ticket_events SET actor_user_id = NULL WHERE actor_user_id = ANY($1::uuid[])`, [users])
    await query(`UPDATE ticket_assignments SET from_user_id = NULL WHERE from_user_id = ANY($1::uuid[])`, [users])
    await query(`UPDATE ticket_assignments SET to_user_id = NULL WHERE to_user_id = ANY($1::uuid[])`, [users])
    await query(
      `UPDATE device_sync_runs SET triggered_by_user_id = NULL WHERE triggered_by_user_id = ANY($1::uuid[])`,
      [users],
    )
    await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users])
  }
  const roles = createdRoleIds.filter(Boolean)
  if (roles.length) {
    await query(`DELETE FROM roles WHERE id = ANY($1::uuid[])`, [roles])
  }
}

async function main() {
  const admin = await login('9000000001')
  const pm = await login('9825012345')
  const tech = await login('9099941128')

  // --- A. Role with zero users deletes cleanly ---------------------------
  const emptyRoleId = await createRole(admin.auth, `Smoke Empty ${suffix}`)
  {
    const res = await call(`/api/roles/${emptyRoleId}`, { method: 'DELETE', headers: admin.auth })
    assert(
      res.status === 200 && res.body.success,
      `unassigned role delete failed: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`,
    )
    const still = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM roles WHERE id = $1`, [
      emptyRoleId,
    ])
    assert(still.rows[0].n === 0, 'unassigned role must be removed')
    const perms = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM role_permissions WHERE role_id = $1`,
      [emptyRoleId],
    )
    assert(perms.rows[0].n === 0, 'role permission matrix must cascade with the role')
    const list = await listRoles(admin.auth)
    assert(!list.some((r) => r.id === emptyRoleId), 'deleted role must leave the roles list')
    console.log('OK A — role with no assigned users is deleted')
  }

  // --- B/C. Assigned roles cannot be deleted ------------------------------
  const usedRoleId = await createRole(admin.auth, `Smoke Used ${suffix}`)
  const userA = await createUser(admin.auth, usedRoleId, '1')
  {
    const res = await call(`/api/roles/${usedRoleId}`, { method: 'DELETE', headers: admin.auth })
    assert(
      res.status === 409 && res.body.code === 'ROLE_IN_USE',
      `role with one user must be 409 ROLE_IN_USE, got ${res.status} ${res.body.code}`,
    )
    assert(res.body.error === ASSIGNED_MESSAGE, `message, got "${res.body.error}"`)
    console.log('OK B — role assigned to one user cannot be deleted')
  }

  const userB = await createUser(admin.auth, usedRoleId, '2')
  {
    const res = await call(`/api/roles/${usedRoleId}`, { method: 'DELETE', headers: admin.auth })
    assert(
      res.status === 409 && res.body.code === 'ROLE_IN_USE',
      `role with two users must be 409 ROLE_IN_USE, got ${res.status} ${res.body.code}`,
    )
    assert(Number(res.body.details?.users) === 2, `details.users, got ${res.body.details?.users}`)
    console.log('OK C — role assigned to several users cannot be deleted')
  }

  // --- D/H. Direct API call is rejected too, authorization is preserved ---
  for (const session of [pm, tech]) {
    const res = await call(`/api/roles/${usedRoleId}`, { method: 'DELETE', headers: session.auth })
    assert(
      res.status === 403 && res.body.code === 'FORBIDDEN',
      `${session.role} direct role delete must be 403 FORBIDDEN, got ${res.status} ${res.body.code}`,
    )
  }
  console.log('OK D/H — direct API delete rejected for roles without the permission')

  // Seeded role that always has users is guarded by the same rule.
  {
    const technicianRoleId = await roleIdByName(admin.auth, 'Technician')
    const res = await call(`/api/roles/${technicianRoleId}`, { method: 'DELETE', headers: admin.auth })
    assert(
      res.status === 409 && res.body.code === 'ROLE_IN_USE',
      `seeded in-use role must be 409 ROLE_IN_USE, got ${res.status} ${res.body.code}`,
    )
    console.log('OK D — a seeded role with users is rejected by the same guard')
  }

  // --- F. Nothing changed after the failed deletes -----------------------
  {
    const role = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM roles WHERE id = $1`, [
      usedRoleId,
    ])
    assert(role.rows[0].n === 1, 'rejected role must still exist')
    const perms = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM role_permissions WHERE role_id = $1`,
      [usedRoleId],
    )
    assert(perms.rows[0].n > 0, 'rejected role must keep its permission matrix')
    const list = await listRoles(admin.auth)
    const row = list.find((r) => r.id === usedRoleId)
    assert(row, 'rejected role must remain in the roles list')
    assert(row.users === 2, `role user count must stay 2, got ${row.users}`)
    for (const id of [userA, userB]) {
      const user = await query<{ role_id: string }>(`SELECT role_id FROM users WHERE id = $1`, [id])
      assert(user.rows[0].role_id === usedRoleId, 'rejected delete must not reassign users')
    }
    console.log('OK F — role, matrix and user assignments unchanged after a rejected delete')
  }

  // --- G. Once users move on, the role becomes deletable ------------------
  const technicianRoleId = await roleIdByName(admin.auth, 'Technician')
  for (const id of [userA, userB]) {
    const res = await call(`/api/users/${id}`, {
      method: 'PATCH',
      headers: admin.auth,
      body: JSON.stringify({ roleId: technicianRoleId }),
    })
    assert(res.status === 200, `moving user to another role failed: ${res.status}`)
  }
  {
    const res = await call(`/api/roles/${usedRoleId}`, { method: 'DELETE', headers: admin.auth })
    assert(
      res.status === 200 && res.body.success,
      `role must be deletable once unassigned: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`,
    )
    const list = await listRoles(admin.auth)
    assert(!list.some((r) => r.id === usedRoleId), 'role must leave the list after deletion')
    console.log('OK G — role becomes deletable after its users are reassigned')
  }

  // --- Unknown role ------------------------------------------------------
  {
    const res = await call('/api/roles/00000000-0000-0000-0000-000000000000', {
      method: 'DELETE',
      headers: admin.auth,
    })
    assert(
      res.status === 404 && res.body.code === 'NOT_FOUND',
      `unknown role must be 404 NOT_FOUND, got ${res.status} ${res.body.code}`,
    )
    console.log('OK — deleting an unknown role returns 404')
  }

  // --- H2. A Pending signup still blocks the delete -----------------------
  {
    const pendingRoleId = await createRole(admin.auth, `Smoke Pending ${suffix}`)
    const pending = await call('/api/users', {
      method: 'POST',
      headers: admin.auth,
      body: JSON.stringify({
        fullName: `Smoke Pending ${suffix}`,
        mobile: `8${suffix}9`.slice(0, 10),
        email: `smoke.pending.${suffix}@yopmail.com`,
        password: 'SmokePass1',
        roleId: pendingRoleId,
        roadIds: [],
        status: 'Pending',
      }),
    })
    assert(pending.status === 201, `pending user create failed: ${pending.status}`)
    createdUserIds.push(pending.body.data.id as string)
    const res = await call(`/api/roles/${pendingRoleId}`, { method: 'DELETE', headers: admin.auth })
    assert(
      res.status === 409 && res.body.code === 'ROLE_IN_USE',
      `a Pending signup must still block the delete, got ${res.status} ${res.body.code}`,
    )
    console.log('OK H2 — a Pending signup still blocks a role delete')
  }

  // --- I. Inactive accounts do not block the delete, and lose the role ----
  {
    const inactiveRoleId = await createRole(admin.auth, `Smoke Inactive ${suffix}`)
    const u1 = await createUser(admin.auth, inactiveRoleId, '3')
    const u2 = await createUser(admin.auth, inactiveRoleId, '4')
    for (const id of [u1, u2]) {
      const off = await call(`/api/users/${id}`, {
        method: 'PATCH',
        headers: admin.auth,
        body: JSON.stringify({ status: 'Inactive' }),
      })
      assert(off.status === 200, `deactivate failed: ${off.status}`)
    }

    // Both accounts are Inactive, so the delete is allowed.
    const res = await call(`/api/roles/${inactiveRoleId}`, { method: 'DELETE', headers: admin.auth })
    assert(
      res.status === 200 && res.body.success,
      `role with only Inactive accounts must delete: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`,
    )
    const roleGone = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM roles WHERE id = $1`, [
      inactiveRoleId,
    ])
    assert(roleGone.rows[0].n === 0, 'the role must be removed')
    for (const id of [u1, u2]) {
      const row = await query<{ role_id: string | null; status: string }>(
        `SELECT role_id, status FROM users WHERE id = $1`,
        [id],
      )
      assert(row.rows[0].role_id === null, 'a surviving account must end up with no role')
      assert(row.rows[0].status === 'Inactive', 'the account must stay Inactive')
    }
    lastInactiveId = u2
    console.log('OK I — Inactive accounts do not block a role delete and end up role-less')
  }

  // --- J. A role-less account stays listed and cannot be activated as-is --
  {
    const res = await call('/api/users?status=Inactive', { headers: admin.auth })
    const row = (res.body.data?.users || []).find((u: { id: string }) => u.id === lastInactiveId)
    assert(row, 'a role-less account must still be listed in the Users table')
    assert(row.roleMissing === true, 'the list must flag the account as having no role')
    assert(row.role === null, 'the role name must be null, not a stale value')

    // Reactivating without choosing a role is refused; the account stays Inactive.
    const bad = await call(`/api/users/${lastInactiveId}`, {
      method: 'PATCH',
      headers: admin.auth,
      body: JSON.stringify({ status: 'Active' }),
    })
    assert(
      bad.status === 409 && bad.body.code === 'ROLE_REQUIRED',
      `activating a role-less account must be 409 ROLE_REQUIRED, got ${bad.status} ${bad.body.code}`,
    )
    assert(
      bad.body.error === 'Select a role for this user before activating the account.',
      `message, got "${bad.body.error}"`,
    )
    const stillOff = await query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [
      lastInactiveId,
    ])
    assert(stillOff.rows[0].status === 'Inactive', 'the refused activation must not change the account')

    // Giving it a role first makes the activation succeed.
    const technicianRoleId2 = await roleIdByName(admin.auth, 'Technician')
    const good = await call(`/api/users/${lastInactiveId}`, {
      method: 'PATCH',
      headers: admin.auth,
      body: JSON.stringify({ roleId: technicianRoleId2, status: 'Active' }),
    })
    assert(good.status === 200, `activation with a role must succeed, got ${good.status}`)

    // An unknown roleId is rejected instead of raising a foreign-key error.
    const badRole = await call(`/api/users/${lastInactiveId}`, {
      method: 'PATCH',
      headers: admin.auth,
      body: JSON.stringify({ roleId: '00000000-0000-0000-0000-000000000000' }),
    })
    assert(
      badRole.status === 400 && badRole.body.code === 'ROLE_NOT_FOUND',
      `unknown roleId must be 400 ROLE_NOT_FOUND, got ${badRole.status} ${badRole.body.code}`,
    )
    console.log('OK J — role-less account: listed, activation refused until a role is chosen')
  }

  await deleteSmokeData()

  console.log('\nAll role delete guard smoke checks passed')
  server.close()
  await closeDb()
  process.exit(0)
}

main().catch(async (err) => {
  console.error(err)
  await deleteSmokeData().catch(() => {})
  server.close()
  await closeDb()
  process.exit(1)
})
