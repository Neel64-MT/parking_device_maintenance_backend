/**
 * Regression probe for the event-scoped notification key.
 *
 * 1. Raising a ticket notifies oversight roles (ticket.raised) and, when assigned,
 *    the holder (ticket.assigned) — both keyed to the same 'raised' event.
 * 2. Reassigning a ticket to the SAME person more than once notifies every time.
 *    This is the regression: the old 4-column unique key collapsed them to one.
 * 3. Re-notifying the same person with the same event is a no-op (exactly-once).
 * 4. Handover on update notifies the new holder.
 *
 * Run with the backend listening: npx tsx scripts/probe-assignment-notifications.ts
 */
const BASE = process.env.API_BASE || 'http://127.0.0.1:5000'
const PASSWORD = process.env.QA_PASSWORD || 'Password123'

async function login(identifier: string) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password: PASSWORD }),
  })
  const body = (await res.json()) as { data?: { token?: string } }
  const token = body.data?.token
  if (!token) throw new Error(`login failed for ${identifier}`)
  return token
}

const jsonHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
})
const authHeader = (token: string) => ({ authorization: `Bearer ${token}` })

async function api<T = any>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...authHeader(token), ...(init?.headers || {}) } })
  return (await res.json()) as T
}

/** Notification rows the given user holds for one ticket. */
async function rowsFor(userToken: string, ticketId: string) {
  const body = await api<{ data: any[] }>('/api/notifications?page=1&limit=50', userToken)
  return (body.data || []).filter((n) => n.data?.ticketId === ticketId)
}

async function assign(token: string, ticketId: string, assigneeId: string, reason: string) {
  const body = await api<{ message?: string; error?: string }>(
    `/api/tickets/${ticketId}/assign`,
    token,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assigneeId, reason }) },
  )
  return body.message || body.error || 'unknown'
}

const results: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`)
}

async function main() {
  const pm = await login('alkesh.patel@yopmail.com')
  const workers = (await api<{ data: { id: string; name: string }[] }>('/api/lookups/technicians', pm)).data
  const jignesh = workers.find((w) => w.name === 'Jignesh Solanki')!.id
  const mahesh = workers.find((w) => w.name === 'Mahesh Thakor')!.id

  // ---- find a free device and raise an assigned ticket
  const devices = (await api<{ data: any[] }>('/api/devices?status=Working&page=1&limit=100', pm)).data
  const categories = (await api<{ data: { categories: any[] } }>('/api/issues', pm)).data.categories
  const cat = categories.find((c) => c.name === 'Electrical')!

  let raised: { id: string; eventId: string } | null = null
  for (const d of devices.filter((x) => !x.ticketId && !x.ticketNote)) {
    const res = await api<any>('/api/tickets', pm, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: String(d.slotId ?? d.id),
        description: `event-key probe ${new Date().toISOString()}`,
        issues: [{ categoryId: cat.id, subCategoryId: cat.subs[0].id }],
        photos: [],
        assigneeId: jignesh,
        status: 'Open',
      }),
    })
    if (res.success) {
      raised = res.data
      break
    }
  }
  if (!raised) throw new Error('could not raise a probe ticket (all free devices blocked by the 7-day reopen rule)')

  const ticketId = raised.id
  console.log(`probe ticket: ${ticketId} (eventId ${raised.eventId})\n`)

  // ---- 1. raise notified both audiences, keyed to the raised event
  const jRows1 = await rowsFor(await login('jignesh.solanki@yopmail.com'), ticketId)
  check(
    'raise notifies the assigned holder',
    jRows1.some((r) => r.type === 'ticket.assigned'),
    `Jignesh rows: ${jRows1.map((r) => r.type).join(', ') || '(none)'}`,
  )

  // ---- 2. THE REGRESSION: repeated reassignment to the same person
  const jt = await login('jignesh.solanki@yopmail.com')
  const before = (await rowsFor(jt, ticketId)).length
  await assign(pm, ticketId, mahesh, 'probe: move away')
  const mid = (await rowsFor(jt, ticketId)).length
  await assign(pm, ticketId, jignesh, 'probe: move back 1')
  const afterBack1 = (await rowsFor(jt, ticketId)).length
  await assign(pm, ticketId, mahesh, 'probe: move away 2')
  await assign(pm, ticketId, jignesh, 'probe: move back 2')
  const afterBack2 = (await rowsFor(jt, ticketId)).length

  check(
    'repeated reassignment to the same person notifies every time',
    afterBack1 === mid + 1 && afterBack2 === afterBack1 + 1,
    `rows ${before} -> away ${mid} -> back#1 ${afterBack1} -> back#2 ${afterBack2} (two separate hand-backs to the same person must yield two new notifications)`,
  )

  // ---- 3. no-op assignment is a no-op
  const noopBefore = (await rowsFor(jt, ticketId)).length
  const noopMsg = await assign(pm, ticketId, jignesh, 'probe: already holder')
  const noopAfter = (await rowsFor(jt, ticketId)).length
  check(
    'assigning the current holder again adds nothing',
    noopAfter === noopBefore && noopMsg === 'Already assigned',
    `"${noopMsg}", rows ${noopBefore} -> ${noopAfter}`,
  )

  // ---- 4. handover on update notifies the new holder
  // Handover requires an assign-capable role (assertCanAssignTickets), so this runs as
  // the Project Manager while Jignesh still holds the ticket.
  const mech = categories.find((c) => c.name === 'Mechanical')!
  await assign(pm, ticketId, jignesh, 'probe: back to holder for handover test')
  const maheshBefore = (await rowsFor(await login('mahesh.thakor@yopmail.com'), ticketId)).length
  const upd = await api<any>(`/api/tickets/${ticketId}/updates`, pm, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      updateType: 'Site visit — not resolved',
      workDone: 'probe: handover to another worker',
      cost: 0,
      parts: [],
      photos: [],
      issues: [{ categoryId: mech.id, subCategoryId: mech.subs[0].id }],
      handoverToUserId: mahesh,
    }),
  })
  const maheshRows = await rowsFor(await login('mahesh.thakor@yopmail.com'), ticketId)
  check(
    'handover on update notifies the new holder',
    upd.success && maheshRows.length === maheshBefore + 1 && maheshRows.some((r) => r.type === 'ticket.reassigned'),
    `update ${upd.success ? 'ok' : `failed: ${upd.error}`}; Mahesh rows ${maheshBefore} -> ${maheshRows.length}: ${maheshRows.map((r) => r.type).join(', ') || '(none)'}`,
  )

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
