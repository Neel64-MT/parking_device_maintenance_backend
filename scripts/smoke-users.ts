/**
 * Users visibility + delete smoke — never prints tokens or passwords.
 * Run: npm run test:smoke:users
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

type UserRow = {
  id: string
  name: string
  role: string
  status: string
  mobile: string
  email: string | null
}

type Session = { auth: Record<string, string>; me: UserRow }

/** Users created by this smoke, removed at the end so the list stays clean. */
const createdUserIds: string[] = []

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

async function login(identifier: string, password = 'Password123'): Promise<Session> {
  const res = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier, password }),
  })
  assert(res.status === 200 && res.body.data?.token, `login failed for ${identifier}`)
  const auth = { Authorization: `Bearer ${res.body.data.token as string}` }
  const me = await call('/api/auth/me', { headers: auth })
  assert(me.status === 200 && me.body.data?.id, `me failed for ${identifier}`)
  return { auth, me: me.body.data as UserRow }
}

async function listUsers(auth: Record<string, string>, qs = '') {
  const res = await call(`/api/users${qs}`, { headers: auth })
  assert(res.status === 200 && Array.isArray(res.body.data?.users), `users list failed: ${res.status}`)
  return {
    users: res.body.data.users as UserRow[],
    tiles: res.body.data.tiles as Array<{ value: string; label: string }>,
  }
}

async function createUser(adminAuth: Record<string, string>, roleName: string) {
  const roles = await call('/api/roles', { headers: adminAuth })
  const roleId = (roles.body.data as Array<{ id: string; name: string }>).find(
    (r) => r.name === roleName,
  )?.id
  assert(roleId, `${roleName} role not found`)

  const suffix = String(Date.now()).slice(-8) + Math.floor(Math.random() * 90 + 10)
  const res = await call('/api/users', {
    method: 'POST',
    headers: adminAuth,
    body: JSON.stringify({
      fullName: `Smoke ${roleName} ${suffix}`,
      mobile: `95${suffix}`.slice(0, 10),
      email: `smoke.${suffix}@yopmail.com`,
      password: 'SmokePass1',
      roleId,
      roadIds: [],
    }),
  })
  assert(
    res.status === 201 && res.body.data?.id,
    `create ${roleName} failed: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`,
  )
  createdUserIds.push(res.body.data.id as string)
  return res.body.data as UserRow
}

async function main() {
  const admin = await login('9000000001')
  const pm = await login('9825012345')
  const tech = await login('9099941128')

  // A second Admin + a second PM so cross-role visibility is observable.
  const adminB = await createUser(admin.auth, 'Admin')
  const pmB = await createUser(admin.auth, 'Project manager')
  const techB = await createUser(admin.auth, 'Technician')

  // --- A. Admin sees other Admins, never own account -------------------
  {
    const { users, tiles } = await listUsers(admin.auth)
    const ids = users.map((u) => u.id)
    assert(!ids.includes(admin.me.id), 'Admin must not see own account')
    assert(ids.includes(adminB.id), 'Admin must see other Admin accounts')
    assert(ids.includes(pm.me.id), 'Admin must see Project Managers')
    assert(ids.includes(tech.me.id), 'Admin must see other eligible users')
    const total = Number(tiles.find((t) => t.label === 'Total users')?.value)
    assert(total === users.length, `tile total ${total} must match visible rows ${users.length}`)
    console.log('OK A — Admin sees all other accounts including Admins, not own')
  }

  // --- B. PM cannot see Admin accounts, cannot see own account ----------
  {
    const { users } = await listUsers(pm.auth)
    const ids = users.map((u) => u.id)
    assert(!users.some((u) => u.role === 'Admin'), 'PM must not see any Admin account')
    assert(!ids.includes(admin.me.id), 'PM must not see Admin A')
    assert(!ids.includes(adminB.id), 'PM must not see Admin B')
    assert(!ids.includes(pm.me.id), 'PM must not see own account')
    assert(ids.includes(pmB.id), 'PM must see other Project Managers')
    assert(
      users.some((u) => ['Technician', 'Engineer', 'Control room', 'Site attendant'].includes(u.role)),
      'PM must still see non-Admin users',
    )
    console.log('OK B — PM sees no Admin accounts and not own account')
  }

  // --- C. Other roles: existing authorization unchanged ------------------
  {
    const res = await call('/api/users', { headers: tech.auth })
    assert(res.status === 403, `Technician list must stay forbidden, got ${res.status}`)
    console.log('OK C — non-privileged role list visibility unchanged (403)')
  }

  // --- I/J. PM cannot retrieve Admins via direct API, search or status --
  for (const qs of ['', '?q=Admin', '?q=admin', '?status=Active', '?status=Inactive', '?q=Admin&status=Active']) {
    const { users } = await listUsers(pm.auth, qs)
    assert(!users.some((u) => u.role === 'Admin'), `PM must not see Admin accounts via "${qs}"`)
  }
  {
    const { users } = await listUsers(admin.auth, '?q=Admin')
    assert(
      users.some((u) => u.id === adminB.id),
      'Admin search for "Admin" must still return Admin accounts',
    )
  }
  console.log('OK I/J — PM cannot retrieve Admin accounts by search/status/query manipulation')

  // --- E/D. Authorized user (Admin, Users `d`) hard-deletes an eligible user
  {
    const res = await call(`/api/users/${techB.id}`, { method: 'DELETE', headers: admin.auth })
    assert(res.status === 200 && res.body.success, `admin delete failed: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`)

    // The row is gone, not deactivated.
    const row = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users WHERE id = $1`, [techB.id])
    assert(row.rows[0].n === 0, 'hard delete must remove the user row')

    // K. disappears from every list, and cannot be deleted twice
    for (const qs of ['', '?status=Active', '?status=Inactive', '?status=']) {
      const { users } = await listUsers(admin.auth, qs)
      assert(!users.some((u) => u.id === techB.id), `deleted user must leave the "${qs}" list`)
    }
    const again = await call(`/api/users/${techB.id}`, { method: 'DELETE', headers: admin.auth })
    assert(again.status === 404, `deleting an unknown user must be 404, got ${again.status}`)
    console.log('OK D/E/K — Admin hard-deletes an eligible user; row and list state are correct')
  }

  // --- Hard delete also works on an already-Inactive account --------------
  {
    const inactive = await createUser(admin.auth, 'Site attendant')
    const off = await call(`/api/users/${inactive.id}`, {
      method: 'PATCH',
      headers: admin.auth,
      body: JSON.stringify({ status: 'Inactive' }),
    })
    assert(off.status === 200, `deactivate failed: ${off.status}`)
    const res = await call(`/api/users/${inactive.id}`, { method: 'DELETE', headers: admin.auth })
    assert(res.status === 200, `deleting an Inactive account must succeed, got ${res.status}`)
    const row = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM users WHERE id = $1`, [inactive.id])
    assert(row.rows[0].n === 0, 'an Inactive account must be hard-deleted too')
    console.log('OK — an already-Inactive account can be hard-deleted (no ALREADY_INACTIVE)')
  }

  // --- L. Failed deletion keeps the user and its status ------------------
  {
    const before = await query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [pmB.id])
    const res = await call(`/api/users/${pmB.id}`, { method: 'DELETE', headers: pm.auth })
    assert(res.status === 403 && res.body.code === 'FORBIDDEN', `PM delete must be 403, got ${res.status}`)
    const after = await query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [pmB.id])
    assert(before.rows[0].status === after.rows[0].status, 'failed delete must not change status')
    console.log('OK L — unauthorized delete rejected; user unchanged and still listed')
  }

  // --- F. Unauthorized roles cannot delete -------------------------------
  {
    const res = await call(`/api/users/${pmB.id}`, { method: 'DELETE', headers: tech.auth })
    assert(res.status === 403, `Technician delete must be 403, got ${res.status}`)
    console.log('OK F — Technician cannot delete a user')
  }

  // --- H. Self-delete is blocked by the backend (direct API call) -------
  {
    // Admin holds Users `d`, so it reaches the self-delete guard.
    const adminSelf = await call(`/api/users/${admin.me.id}`, { method: 'DELETE', headers: admin.auth })
    assert(
      adminSelf.status === 400 && adminSelf.body.code === 'SELF_DELETE_FORBIDDEN',
      `Admin self-delete must be 400 SELF_DELETE_FORBIDDEN, got ${adminSelf.status} ${adminSelf.body.code}`,
    )
    assert(
      adminSelf.body.error === 'You cannot delete your own account.',
      `self-delete error message, got "${adminSelf.body.error}"`,
    )

    // PM and Technician have no Users `d`, so the permission gate rejects first.
    for (const session of [pm, tech]) {
      const res = await call(`/api/users/${session.me.id}`, { method: 'DELETE', headers: session.auth })
      assert(res.status === 403, `${session.me.role} self-delete must be 403, got ${res.status}`)
    }

    // None of it removed the account.
    const still = await query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [admin.me.id])
    assert(still.rows[0].status === 'Active', 'self-delete attempt must not change the account')
  }
  console.log('OK H — self-delete rejected by the backend for every role')

  // --- G. Own account is never in the list (no self-delete affordance) --
  for (const session of [admin, pm]) {
    const { users } = await listUsers(session.auth)
    assert(!users.some((u) => u.id === session.me.id), 'own account must never be listed')
  }
  console.log('OK G — own account absent from the list, so no self-delete control is rendered')

  // --- Last active Admin can never be removed ---------------------------
  {
    // Deleting the *other* admin is allowed while the caller stays active.
    const res = await call(`/api/users/${adminB.id}`, { method: 'DELETE', headers: admin.auth })
    assert(
      res.status === 200,
      `deleting a second admin should succeed, got ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`,
    )

    // The caller is now the only Active Admin, so deactivating it is refused.
    const guard = await call(`/api/users/${admin.me.id}`, {
      method: 'PATCH',
      headers: admin.auth,
      body: JSON.stringify({ status: 'Inactive' }),
    })
    assert(
      guard.status === 409 && guard.body.code === 'LAST_ADMIN',
      `last active admin must be guarded, got ${guard.status} ${guard.body.code}`,
    )

    // The seeded admin is untouched, and no other Admin account remains.
    const still = await query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [admin.me.id])
    assert(still.rows[0].status === 'Active', 'the last active admin must stay active')
    const { users } = await listUsers(admin.auth)
    assert(
      !users.some((u) => u.role === 'Admin' && u.status === 'Active'),
      'no other Active Admin should remain after the delete',
    )
  }

  await deleteSmokeUsers(createdUserIds)

  console.log('\nAll user visibility + delete smoke checks passed')
  server.close()
  await closeDb()
  process.exit(0)
}

main().catch(async (err) => {
  console.error(err)
  await deleteSmokeUsers(createdUserIds).catch(() => {})
  server.close()
  await closeDb()
  process.exit(1)
})
