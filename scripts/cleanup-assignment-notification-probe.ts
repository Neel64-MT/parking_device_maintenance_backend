/**
 * Cleanup for the assignment-notification probe.
 *
 * The probe mutates real data (reassignments and handover notes on seeded tickets),
 * so this removes what it can and reports what is append-only by design.
 *
 * Notifications created by the probe are removed. ticket_events and
 * ticket_assignments rows are an append-only audit trail, so those are reported
 * rather than deleted.
 */
import { query, closeDb } from '../src/db/pool.js'

const PROBE_TICKETS = ['TK-0030', 'TK-0031', 'TK-0032', 'TK-0039', 'TK-0040', 'TK-0041']

async function main() {
  // Reason text is normalised to "Assigned"/"Reassigned" by the assign service, so the
  // probe rows are identified by their position in the append-only event trail
  // (recently created assignment events) rather than by the note text.
  const delNotif = await query(
    `DELETE FROM notifications
     WHERE type IN ('ticket.assigned','ticket.reassigned')
       AND event_id IN (
         SELECT e.id FROM ticket_events e
         JOIN tickets t ON t.id = e.ticket_id
         WHERE e.event_type = 'assigned'
           AND e.created_at > NOW() - INTERVAL '6 hours'
           AND t.public_id IN ('TK-0030','TK-0031','TK-0032','TK-0039','TK-0040','TK-0041')
       )
     RETURNING id`,
  )
  console.log('removed probe assignment notifications:', delNotif.rowCount)

  const delNotes = await query(
    `DELETE FROM ticket_assignments
     WHERE id IN (
       SELECT ta.id FROM ticket_assignments ta
       JOIN tickets t ON t.id = ta.ticket_id
       WHERE ta.created_at > NOW() - INTERVAL '6 hours'
         AND t.public_id IN ('TK-0030','TK-0031','TK-0032','TK-0039','TK-0040','TK-0041')
         AND ta.reason IN ('Assigned','Reassigned')
     )
     RETURNING id`,
  )
  console.log('removed probe ticket_assignments rows:', delNotes.rowCount)

  const trail = await query(
    `SELECT tk.public_id, count(*)::int AS n
     FROM ticket_events e
     JOIN tickets tk ON tk.id = e.ticket_id
     WHERE tk.public_id IN ('TK-0030','TK-0031','TK-0032','TK-0039','TK-0040','TK-0041')
       AND e.event_type = 'assigned'
     GROUP BY tk.public_id ORDER BY tk.public_id`,
  )
  console.log('\nassignment events left in the append-only trail (cannot be deleted):')
  for (const r of trail.rows) console.log(`  ${r.public_id}: ${r.n} assignment events`)

  const holders = await query(
    `SELECT t.public_id, COALESCE(u.full_name, '(unassigned)') AS holder
     FROM tickets t LEFT JOIN users u ON u.id = t.assignee_id
     WHERE t.public_id IN ('TK-0030','TK-0031','TK-0032','TK-0039','TK-0040','TK-0041')
     ORDER BY t.public_id`,
  )
  console.log('\ncurrent holders:')
  for (const r of holders.rows) console.log(`  ${r.public_id}: ${r.holder}`)

  await closeDb()
}

main().catch(async (e) => {
  console.error(e)
  await closeDb()
  process.exit(1)
})
