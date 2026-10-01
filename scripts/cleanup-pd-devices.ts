/**
 * Remove devices that have neither a Slot Id (`slot_id`) nor a MAC address
 * (`slot_identifier`) — unbound devices the UI shows as "—" in both columns —
 * together with all of their tickets.
 *
 * Dry run by default; pass --apply to delete.
 *   npx tsx scripts/cleanup-pd-devices.ts
 *   npx tsx scripts/cleanup-pd-devices.ts --apply
 */
import { query, withTransaction, closeDb } from '../src/db/pool.js'

const APPLY = process.argv.includes('--apply')

const DEVICE_MATCH = `slot_id IS NULL AND NULLIF(TRIM(slot_identifier), '') IS NULL`
const MATCHED_DEVICE_IDS = `SELECT id FROM devices WHERE ${DEVICE_MATCH}`
const MATCHED_TICKET_IDS = `SELECT id FROM tickets WHERE device_id IN (${MATCHED_DEVICE_IDS})`

async function main() {
  const devices = await query<{ public_id: string; qr_code: string }>(
    `SELECT public_id, qr_code FROM devices WHERE ${DEVICE_MATCH} ORDER BY public_id`,
  )
  const tickets = await query<{ public_id: string; status: string; device: string }>(
    `SELECT t.public_id, t.status, d.public_id AS device
     FROM tickets t JOIN devices d ON d.id = t.device_id
     WHERE t.id IN (${MATCHED_TICKET_IDS})
     ORDER BY t.public_id`,
  )
  const otherDevices = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM devices WHERE NOT (${DEVICE_MATCH})`,
  )

  console.log(`devices with no Slot Id and no MAC: ${devices.rows.length}`)
  console.log(`  ${devices.rows.map((d) => d.public_id).join(', ')}`)
  console.log(`tickets on those devices: ${tickets.rows.length}`)
  for (const t of tickets.rows) console.log(`  ${t.public_id} [${t.status}] device ${t.device}`)
  console.log(`devices that will be kept: ${otherDevices.rows[0].n}`)

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to delete.')
    await closeDb()
    return
  }

  const result = await withTransaction(async (client) => {
    const notifications = await client.query(
      `DELETE FROM notifications
       WHERE related_entity_type = 'ticket' AND related_entity_id IN (${MATCHED_TICKET_IDS})`,
    )
    await client.query(
      `UPDATE tickets SET reopen_of_ticket_id = NULL
       WHERE reopen_of_ticket_id IN (${MATCHED_TICKET_IDS})`,
    )
    const deletedTickets = await client.query(`DELETE FROM tickets WHERE id IN (${MATCHED_TICKET_IDS})`)
    const deletedDevices = await client.query(`DELETE FROM devices WHERE ${DEVICE_MATCH}`)
    return {
      notifications: notifications.rowCount,
      tickets: deletedTickets.rowCount,
      devices: deletedDevices.rowCount,
    }
  })

  console.log('\nDeleted:', result)
  await closeDb()
}

main().catch(async (e) => {
  console.error(e)
  await closeDb()
  process.exit(1)
})
