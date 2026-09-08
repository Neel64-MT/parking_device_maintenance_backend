import { ApiError } from './api-error.js'
import type { DbClient } from '../db/pool.js'
import { query } from '../db/pool.js'

export type PartSnapshot = { id: string; name: string; amount: number }

/**
 * Resolve selected part UUIDs against Parts Master.
 * Master amounts are authoritative; duplicate IDs are charged once.
 */
export async function resolvePartsCost(
  partIds: string[],
  db: DbClient = { query },
): Promise<{ partsCost: number; snapshots: PartSnapshot[] }> {
  const unique = [...new Set(partIds.filter(Boolean))]
  if (!unique.length) return { partsCost: 0, snapshots: [] }

  const result = await db.query<{ id: string; name: string; amount: string | number; active: boolean }>(
    `SELECT id, name, amount, active FROM parts WHERE id = ANY($1::uuid[])`,
    [unique],
  )

  if (result.rows.length !== unique.length) {
    throw new ApiError(400, 'One or more parts are invalid', 'INVALID_PARTS')
  }
  const inactive = result.rows.find((r) => !r.active)
  if (inactive) {
    throw new ApiError(400, `Part is inactive: ${inactive.name}`, 'INVALID_PARTS')
  }

  const byId = new Map(result.rows.map((r) => [r.id, r]))
  const snapshots: PartSnapshot[] = unique.map((id) => {
    const row = byId.get(id)!
    return { id: row.id, name: row.name, amount: Number(row.amount) }
  })
  const partsCost = snapshots.reduce((s, p) => s + p.amount, 0)
  return { partsCost, snapshots }
}

export async function insertEventParts(
  client: DbClient,
  eventId: string,
  snapshots: PartSnapshot[],
) {
  for (const p of snapshots) {
    await client.query(
      `INSERT INTO ticket_event_parts (event_id, part_id, amount) VALUES ($1,$2,$3)`,
      [eventId, p.id, p.amount],
    )
  }
}

export function visitEventCost(labourCost: number, partsCost: number) {
  return Number(labourCost || 0) + Number(partsCost || 0)
}
