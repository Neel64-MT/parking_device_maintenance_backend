/**
 * Notification preferences smoke (Phase 54) — per-user Push Notifications / Play Sound
 * preferences are returned by login + /me, are writable only by their owner, and are
 * enforced by deliverNotificationPush across every subscription the user holds.
 * Inserts its own notification rows and subscriptions, then removes them and restores
 * the original preferences. Never prints tokens or passwords.
 * Run: npm run test:smoke:notification-prefs
 */
import 'dotenv/config'
import { randomUUID } from 'node:crypto'

import { createApp } from '../src/app.js'
import { closeDb, query } from '../src/db/pool.js'
import { deliverNotificationPush } from '../src/lib/notifications.js'

const app = createApp()
const server = app.listen(0)
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`

type Auth = Record<string, string>
type Prefs = { pushNotificationsEnabled: boolean; playNotificationSound: boolean }
type Session = { auth: Auth; id: string; prefs: Prefs }

async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

function patchPrefs(auth: Auth | null, payload: unknown) {
  return call('/api/auth/me/notification-preferences', {
    method: 'PATCH',
    headers: auth || {},
    body: JSON.stringify(payload),
  })
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

function brief(res: { status: number; body: unknown }) {
  return `${res.status} ${JSON.stringify(res.body).slice(0, 240)}`
}

async function login(identifier: string): Promise<Session> {
  const res = await call('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier, password: 'Password123' }),
  })
  assert(res.status === 200, `login ${identifier}: ${res.status}`)
  const prefs = res.body.data?.user?.notificationPreferences as Prefs | undefined
  assert(
    typeof prefs?.pushNotificationsEnabled === 'boolean' &&
      typeof prefs?.playNotificationSound === 'boolean',
    'login user must include notificationPreferences',
  )
  return {
    auth: { Authorization: `Bearer ${res.body.data.token as string}` },
    id: res.body.data.user.id as string,
    prefs,
  }
}

const createdNotificationIds: string[] = []
const createdEndpoints: string[] = []
const restore: Array<{ id: string; prefs: Prefs }> = []

async function insertNotification(userId: string) {
  const inserted = await query<{ id: string }>(
    `INSERT INTO notifications (recipient_user_id, type, title, message, related_entity_type, related_entity_id, data, event_id)
     VALUES ($1, 'smoke.notification-prefs', 'Smoke notification', 'Smoke notification body', 'ticket', $2, $3::jsonb, $4)
     RETURNING id`,
    [userId, randomUUID(), JSON.stringify({ url: '/tickets/SMOKE' }), randomUUID()],
  )
  const id = inserted.rows[0].id
  createdNotificationIds.push(id)
  return id
}

async function registerSubscription(auth: Auth, label: string) {
  const endpoint = `https://push.example.test/prefs-${label}-${Date.now()}`
  const res = await call('/api/notifications/push-subscriptions', {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ endpoint, keys: { p256dh: 'smoke-p256dh-key', auth: 'smoke-auth-key' } }),
  })
  assert(res.status === 200, `register subscription ${label}: ${brief(res)}`)
  createdEndpoints.push(endpoint)
  return endpoint
}

async function main() {
  // 13. Existing-user migration default.
  const columns = await query<{ column_name: string; column_default: string | null; is_nullable: string }>(
    `SELECT column_name, column_default, is_nullable
     FROM information_schema.columns
     WHERE table_name = 'users'
       AND column_name IN ('push_notifications_enabled', 'play_notification_sound')`,
  )
  assert(columns.rowCount === 2, 'migration 027 must add both preference columns')
  for (const column of columns.rows) {
    assert(column.is_nullable === 'NO', `${column.column_name} must be NOT NULL`)
    assert(String(column.column_default).toLowerCase() === 'true', `${column.column_name} must default to TRUE`)
  }
  console.log('OK migration columns + TRUE defaults')

  const admin = await login('9000000001')
  const pm = await login('9825012345')
  restore.push({ id: admin.id, prefs: admin.prefs }, { id: pm.id, prefs: pm.prefs })

  // Start from the default state for deterministic checks.
  const reset = await patchPrefs(pm.auth, { pushNotificationsEnabled: true, playNotificationSound: true })
  assert(reset.status === 200, `reset PM preferences: ${brief(reset)}`)

  const me = await call('/api/auth/me', { headers: pm.auth })
  assert(
    me.status === 200 &&
      me.body.data?.notificationPreferences?.pushNotificationsEnabled === true &&
      me.body.data?.notificationPreferences?.playNotificationSound === true,
    '/me must include notificationPreferences',
  )
  console.log('OK login + /me expose notificationPreferences')

  // 16. Authorization + validation.
  const unauth = await patchPrefs(null, { pushNotificationsEnabled: false })
  assert(unauth.status === 401, `no token must be 401: ${brief(unauth)}`)
  const foreign = await patchPrefs(admin.auth, { pushNotificationsEnabled: false, userId: pm.id })
  assert(foreign.status === 400, `body userId must be rejected: ${brief(foreign)}`)
  const empty = await patchPrefs(pm.auth, {})
  assert(empty.status === 400, `empty body must be 400: ${brief(empty)}`)
  const wrongType = await patchPrefs(pm.auth, { pushNotificationsEnabled: 'no' })
  assert(wrongType.status === 400, `non-boolean must be 400: ${brief(wrongType)}`)

  const adminBefore = await query<{ push_notifications_enabled: boolean }>(
    `SELECT push_notifications_enabled FROM users WHERE id = $1`,
    [admin.id],
  )
  const pmOff = await patchPrefs(pm.auth, { pushNotificationsEnabled: false })
  assert(
    pmOff.status === 200 &&
      pmOff.body.data?.notificationPreferences?.pushNotificationsEnabled === false &&
      pmOff.body.data?.notificationPreferences?.playNotificationSound === true,
    `PM turns push off (sound preserved): ${brief(pmOff)}`,
  )
  const adminAfter = await query<{ push_notifications_enabled: boolean }>(
    `SELECT push_notifications_enabled FROM users WHERE id = $1`,
    [admin.id],
  )
  assert(
    adminAfter.rows[0].push_notifications_enabled === adminBefore.rows[0].push_notifications_enabled,
    'updating own preferences must not touch another user',
  )
  console.log('OK own-user only, strict body, 401 without token')

  // 10/11. Persistence across a new session.
  const pmAgain = await login('9825012345')
  assert(pmAgain.prefs.pushNotificationsEnabled === false, 'preference must persist across login')
  console.log('OK preference persists across sessions')

  // 12/14. Push OFF suppresses every device.
  await registerSubscription(pm.auth, 'desktop')
  await registerSubscription(pm.auth, 'laptop')
  const offNotification = await insertNotification(pm.id)
  let offSends = 0
  await deliverNotificationPush([offNotification], async () => {
    offSends += 1
    return { statusCode: 201, body: '', headers: {} }
  })
  assert(offSends === 0, 'push OFF must not send to any subscription')
  const offState = await query<{ push_sent_at: unknown }>(
    `SELECT push_sent_at FROM notifications WHERE id = $1`,
    [offNotification],
  )
  assert(offState.rows[0].push_sent_at == null, 'suppressed push must not be marked sent')
  const unread = await call('/api/notifications/unread-count', { headers: pm.auth })
  assert(unread.status === 200 && unread.body.data?.count >= 1, 'in-app notification is still counted when push is OFF')
  console.log('OK push OFF suppresses delivery on all devices; in-app row kept')

  // 7/8/15. Push ON — sound preference only changes the payload.
  const silentOn = await patchPrefs(pm.auth, { pushNotificationsEnabled: true, playNotificationSound: false })
  assert(silentOn.status === 200, `push ON + sound OFF: ${brief(silentOn)}`)
  const silentNotification = await insertNotification(pm.id)
  const silentPayloads: Array<{ notification?: { silent?: boolean }; data?: { playSound?: boolean } }> = []
  await deliverNotificationPush([silentNotification], async (_subscription, payload) => {
    silentPayloads.push(JSON.parse(payload))
    return { statusCode: 201, body: '', headers: {} }
  })
  assert(silentPayloads.length === 2, `push ON must reach both devices (got ${silentPayloads.length})`)
  assert(
    silentPayloads.every((p) => p.notification?.silent === true && p.data?.playSound === false),
    'sound OFF must send silent notifications',
  )

  const soundOn = await patchPrefs(pm.auth, { playNotificationSound: true })
  assert(soundOn.status === 200, `sound ON: ${brief(soundOn)}`)
  const soundNotification = await insertNotification(pm.id)
  const soundPayloads: Array<{ notification?: { silent?: boolean }; data?: { playSound?: boolean } }> = []
  await deliverNotificationPush([soundNotification], async (_subscription, payload) => {
    soundPayloads.push(JSON.parse(payload))
    return { statusCode: 201, body: '', headers: {} }
  })
  assert(
    soundPayloads.length === 2 &&
      soundPayloads.every((p) => p.notification?.silent === false && p.data?.playSound === true),
    'sound ON must send audible notifications',
  )
  console.log('OK push ON delivers; sound preference controls silent flag')

  // 9. Push OFF while sound ON: still no delivery, sound preference preserved.
  const offAgain = await patchPrefs(pm.auth, { pushNotificationsEnabled: false })
  assert(offAgain.body.data?.notificationPreferences?.playNotificationSound === true, 'sound preference preserved')
  const offAgainNotification = await insertNotification(pm.id)
  let offAgainSends = 0
  await deliverNotificationPush([offAgainNotification], async () => {
    offAgainSends += 1
    return { statusCode: 201, body: '', headers: {} }
  })
  assert(offAgainSends === 0, 'push OFF + sound ON must not deliver')
  console.log('OK push OFF + sound ON does not deliver')

  // 20. Expired subscription cleanup still runs when push is ON.
  await patchPrefs(pm.auth, { pushNotificationsEnabled: true })
  const expiredNotification = await insertNotification(pm.id)
  await deliverNotificationPush([expiredNotification], async () => {
    throw Object.assign(new Error('expired subscription'), { statusCode: 410 })
  })
  const remaining = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE endpoint = ANY($1::text[])`,
    [createdEndpoints],
  )
  assert(remaining.rows[0].n === 0, '410 must remove expired subscriptions')
  console.log('OK expired subscription cleanup')

  console.log('\nNotification preference checks passed')
}

async function cleanup() {
  if (createdNotificationIds.length) {
    await query(`DELETE FROM notifications WHERE id = ANY($1::uuid[])`, [createdNotificationIds])
  }
  if (createdEndpoints.length) {
    await query(`DELETE FROM push_subscriptions WHERE endpoint = ANY($1::text[])`, [createdEndpoints])
  }
  for (const entry of restore) {
    await query(
      `UPDATE users SET push_notifications_enabled = $2, play_notification_sound = $3 WHERE id = $1`,
      [entry.id, entry.prefs.pushNotificationsEnabled, entry.prefs.playNotificationSound],
    )
  }
}

main()
  .then(async () => {
    await cleanup()
    server.close()
    await closeDb()
    process.exit(0)
  })
  .catch(async (err) => {
    console.error(err)
    try {
      await cleanup()
    } catch (cleanupError) {
      console.error('cleanup failed:', cleanupError)
    }
    server.close()
    await closeDb()
    process.exit(1)
  })
