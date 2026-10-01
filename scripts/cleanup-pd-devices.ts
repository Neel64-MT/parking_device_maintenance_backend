/**
 * Remove devices whose displayed Slot Id starts with "PD" (no synced slot_id, so the
 * UI falls back to public_id like PD-0671) together with all of their tickets.
 *
 * Dry run by default; pass --apply to delete.
 *   npx tsx scripts/cleanup-pd-devices.ts
 *   npx tsx scripts/cleanup-pd-devices.ts --apply
 */
import { query, withTransaction, closeDb } from '../src/db/pool.js'

const APPLY = process.argv.includes('--apply')

const DEVICE_MATCH = `slot_id IS NULL AND UPPER(public_id) LIKE 'PD%'`

async function main() {
  const devices = await query<{ public_id: string; slot_identifier: string | null }>(
    `SELECT public_id, slot_identifier FROM devices WHERE ${DEVICE_MATCH} ORDER BY public_id`,
  )
  const tickets = await query<{ public_id: string; status: string; device: string }>(
    `SELECT t.public_id, t.status, d.public_id AS device
     FROM tickets t JOIN devices d ON d.id = t.device_id
     WHERE d.slot_id IS NULL AND UPPER(d.public_id) LIKE 'PD%'
     ORDER BY t.public_id`,
  )
  const otherDevices = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM devices WHERE NOT (${DEVICE_MATCH})`,
  )

  console.log(`devices matching (Slot Id starts with PD): ${devices.rows.length}`)
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
    const ticketIds = `SELECT t.id FROM tickets t JOIN devices d ON d.id = t.device_id
                       WHERE d.slot_id IS NULL AND UPPER(d.public_id) LIKE 'PD%'`
    const notifications = await client.query(
      `DELETE FROM notifications
       WHERE related_entity_type = 'ticket' AND related_entity_id IN (${ticketIds})`,
    )
    await client.query(
      `UPDATE tickets SET reopen_of_ticket_id = NULL
       WHERE reopen_of_ticket_id IN (${ticketIds})`,
    )
    const deletedTickets = await client.query(`DELETE FROM tickets WHERE id IN (${ticketIds})`)
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
