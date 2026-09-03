/**
 * In-process smoke tests — never prints tokens or passwords.
 * Run: npx tsx scripts/smoke-inprocess.ts
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
    body: JSON.stringify({ identifier: 'alkesh.patel@pdm.local', password: 'Password123' }),
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
