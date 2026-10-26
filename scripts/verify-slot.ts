/**
 * Read-only: show (1) the raw system row and (2) the live API responses for a slot.
 * Mints an admin token (seeded admin password was rotated on this DB, so normal login fails).
 * Run (uses .env DB): npx tsx scripts/verify-slot.ts [slotId]
 */
import 'dotenv/config'
import { createApp } from '../src/app.js'
import { closeDb, query } from '../src/db/pool.js'
import { signAccessToken } from '../src/lib/auth.js'

const SLOT = process.argv[2] || '6677'

async function main() {
  // 1) Raw system row
  const raw = await query(
    `SELECT d.*, r.name AS road_name
     FROM devices d JOIN roads r ON r.id = d.road_id
     WHERE CAST(d.slot_id AS TEXT) = $1 OR d.public_id = $1`,
    [SLOT],
  )
  console.log('========== DATA IN THE SYSTEM (raw devices row) ==========')
  if (!raw.rowCount) {
    console.log(`  No device with slot_id/public_id = ${SLOT}`)
    return
  }
  const d = raw.rows[0]
  console.log(JSON.stringify(d, null, 2))

  // Mint a token for an active Admin (passes requireAuth: pv matches, random jti)
  const admin = await query<{ id: string; pv: number }>(
    `SELECT u.id, COALESCE(u.password_version, 0) AS pv
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE r.name = 'Admin' AND u.status = 'Active'
     ORDER BY u.created_at LIMIT 1`,
  )
  if (!admin.rowCount) {
    console.log('\n(No active Admin to mint a token — cannot call the API.)')
    return
  }
  const { token } = signAccessToken(admin.rows[0].id, undefined, admin.rows[0].pv)

  const app = createApp()
  const server = app.listen(0)
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`
  const auth = { Authorization: `Bearer ${token}` }

  const displayId = d.slot_id != null && d.slot_id !== '' ? String(d.slot_id) : d.public_id

  // 2a) List API — the row as the Devices list / search returns it
  const list = await (await fetch(`${base}/api/devices?q=${encodeURIComponent(displayId)}`, { headers: auth })).json()
  const listRow = (list.data || []).find((r: any) => String(r.id) === String(displayId)) || list.data?.[0]
  console.log('\n========== API DATA — GET /api/devices (list row) ==========')
  console.log(JSON.stringify(listRow ?? list, null, 2))

  // 2b) Detail API — device history header the detail/edit screens use
  const detail = await (await fetch(`${base}/api/devices/${encodeURIComponent(displayId)}`, { headers: auth })).json()
  console.log('\n========== API DATA — GET /api/devices/:id (header) ==========')
  console.log(JSON.stringify(detail.data?.header ?? detail, null, 2))

  server.close()
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDb()
  })
