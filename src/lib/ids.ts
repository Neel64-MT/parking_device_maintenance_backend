import type { DbClient } from '../db/pool.js'
import { query, withTransaction } from '../db/pool.js'

export async function nextPublicId(
  counterName: 'RD' | 'PD' | 'TK',
  pad = 2,
  client?: DbClient,
): Promise<string> {
  const runner = client
    ? (text: string, params?: unknown[]) => client.query(text, params)
    : (text: string, params?: unknown[]) => query(text, params)

  if (!client) {
    return withTransaction(async (tx) => nextPublicId(counterName, pad, tx))
  }

  await runner(
    `INSERT INTO id_counters (name, value) VALUES ($1, 0)
     ON CONFLICT (name) DO NOTHING`,
    [counterName],
  )
  const result = await runner(
    `UPDATE id_counters SET value = value + 1 WHERE name = $1 RETURNING value`,
    [counterName],
  )
  const n = Number(result.rows[0].value)
  if (counterName === 'RD') return `RD-${String(n).padStart(pad, '0')}`
  if (counterName === 'PD') return `PD-${String(n).padStart(4, '0')}`
  return `TK-${String(n).padStart(4, '0')}`
}

export function qrFromDeviceId(publicId: string) {
  return `QR-${publicId.replace('-', '')}`
}
