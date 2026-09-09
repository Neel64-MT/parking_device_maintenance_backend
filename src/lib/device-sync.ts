import { query } from '../db/pool.js'
import { nextPublicId } from './ids.js'
import {
  DeviceSyncClientError,
  deviceSyncFetch,
  parseLocationList,
  parseQrPage,
  type ExternalQrItem,
} from './device-sync-client.js'

const PER_PAGE = 50

export type SyncRunStats = {
  locationsFetched: number
  locationsInserted: number
  locationsMatched: number
  qrTotal: number
  devicesCreated: number
  devicesUpdated: number
  devicesSkipped: number
  pagesProcessed: number
}

const emptyStats = (): SyncRunStats => ({
  locationsFetched: 0,
  locationsInserted: 0,
  locationsMatched: 0,
  qrTotal: 0,
  devicesCreated: 0,
  devicesUpdated: 0,
  devicesSkipped: 0,
  pagesProcessed: 0,
})

async function failRun(runId: string, message: string, stats: SyncRunStats) {
  await query(
    `UPDATE device_sync_runs
     SET status = 'failed', finished_at = NOW(), error_message = $2, stats = $3::jsonb
     WHERE id = $1`,
    [runId, message.slice(0, 500), JSON.stringify(stats)],
  )
}

async function completeRun(runId: string, stats: SyncRunStats) {
  await query(
    `UPDATE device_sync_runs
     SET status = 'completed', finished_at = NOW(), error_message = NULL, stats = $2::jsonb
     WHERE id = $1`,
    [runId, JSON.stringify(stats)],
  )
}

async function syncLocations(stats: SyncRunStats) {
  const payload = await deviceSyncFetch('/locations')
  const locations = parseLocationList(payload)
  stats.locationsFetched = locations.length

  for (const loc of locations) {
    const byExt = await query<{ id: string }>(
      `SELECT id FROM roads WHERE external_location_id = $1`,
      [loc.id],
    )
    if (byExt.rowCount) {
      stats.locationsMatched += 1
      continue
    }

    const byName = await query<{ id: string; external_location_id: number | null }>(
      `SELECT id, external_location_id FROM roads WHERE LOWER(name) = LOWER($1)`,
      [loc.name],
    )
    if (byName.rowCount) {
      const row = byName.rows[0]
      if (row.external_location_id == null) {
        await query(
          `UPDATE roads SET external_location_id = $2, updated_at = NOW() WHERE id = $1`,
          [row.id, loc.id],
        )
      }
      stats.locationsMatched += 1
      continue
    }

    const code = await nextPublicId('RD', 2)
    const stretchTo = loc.type?.trim() || 'Synced'
    await query(
      `INSERT INTO roads (
        code, name, stretch_from, stretch_to, surveyed_slots, devices_sanctioned,
        status, external_location_id
      ) VALUES ($1, $2, 'Synced', $3, 0, 0, 'Operational', $4)`,
      [code, loc.name, stretchTo, loc.id],
    )
    stats.locationsInserted += 1
  }
}

async function resolveRoadId(
  item: ExternalQrItem,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const locId = item.parking_location?.id
  const locName = item.parking_location?.name?.trim()
  const cacheKey =
    locId != null ? `id:${locId}` : locName ? `name:${locName.toLowerCase()}` : ''
  if (!cacheKey) return null
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null

  let roadId: string | null = null
  if (locId != null) {
    const r = await query<{ id: string }>(
      `SELECT id FROM roads WHERE external_location_id = $1`,
      [locId],
    )
    roadId = r.rows[0]?.id ?? null
  }
  if (!roadId && locName) {
    const r = await query<{ id: string }>(
      `SELECT id FROM roads WHERE LOWER(name) = LOWER($1)`,
      [locName],
    )
    roadId = r.rows[0]?.id ?? null
  }
  cache.set(cacheKey, roadId)
  return roadId
}

/** Free a QR code from another device so this row can claim it. */
async function releaseQrFromOthers(qr: string, keepDeviceId: string) {
  await query(
    `UPDATE devices
     SET qr_code = 'UNLINKED-' || public_id,
         updated_at = NOW()
     WHERE qr_code = $1 AND id <> $2`,
    [qr, keepDeviceId],
  )
}

/**
 * Upsert by stable Slot Id (external slot.id).
 * Once slot_id is written it is never changed. Hardware swap updates mac (slot_identifier) + qr.
 */
async function upsertDevice(
  item: ExternalQrItem,
  roadCache: Map<string, string | null>,
  stats: SyncRunStats,
) {
  const qr = item.qr_number
  const slotLabel = item.slot?.slot_label?.trim()
  if (!slotLabel) {
    stats.devicesSkipped += 1
    return
  }
  const roadId = await resolveRoadId(item, roadCache)
  if (!roadId) {
    stats.devicesSkipped += 1
    console.error(`[device-sync] skip QR ${qr}: parking location not found`)
    return
  }

  const slotId =
    item.slot?.id != null && Number.isFinite(Number(item.slot.id))
      ? Number(item.slot.id)
      : null
  if (slotId == null) {
    stats.devicesSkipped += 1
    console.error(`[device-sync] skip QR ${qr}: missing slot.id`)
    return
  }

  const slotIdentifier =
    typeof item.mac_address === 'string' && item.mac_address.trim()
      ? item.mac_address.trim()
      : null

  const bySlotId = await query<{ id: string }>(
    `SELECT id FROM devices WHERE slot_id = $1`,
    [slotId],
  )

  if (bySlotId.rowCount) {
    try {
      await releaseQrFromOthers(qr, bySlotId.rows[0].id)
      await query(
        `UPDATE devices SET
          road_id = $2,
          slot_number = $3,
          qr_code = $4,
          slot_identifier = COALESCE($5, slot_identifier),
          updated_at = NOW()
         WHERE id = $1`,
        [bySlotId.rows[0].id, roadId, slotLabel, qr, slotIdentifier],
      )
      stats.devicesUpdated += 1
    } catch (err) {
      stats.devicesSkipped += 1
      console.error(`[device-sync] update by slot_id ${slotId} failed:`, err)
    }
    return
  }

  // Legacy row: same QR, no slot_id yet — assign slot_id once (never overwrite later)
  const byQr = await query<{ id: string; slot_id: string | number | null }>(
    `SELECT id, slot_id FROM devices WHERE qr_code = $1`,
    [qr],
  )
  if (byQr.rowCount && byQr.rows[0].slot_id == null) {
    try {
      await query(
        `UPDATE devices SET
          road_id = $2,
          slot_number = $3,
          slot_id = $4,
          slot_identifier = COALESCE($5, slot_identifier),
          updated_at = NOW()
         WHERE id = $1 AND slot_id IS NULL`,
        [byQr.rows[0].id, roadId, slotLabel, slotId, slotIdentifier],
      )
      stats.devicesUpdated += 1
    } catch (err) {
      stats.devicesSkipped += 1
      console.error(`[device-sync] assign slot_id for QR ${qr} failed:`, err)
    }
    return
  }

  // Legacy row: same road + slot label, no slot_id yet
  const byLabel = await query<{ id: string }>(
    `SELECT id FROM devices
     WHERE road_id = $1 AND slot_number = $2 AND slot_id IS NULL`,
    [roadId, slotLabel],
  )
  if (byLabel.rowCount) {
    try {
      await releaseQrFromOthers(qr, byLabel.rows[0].id)
      await query(
        `UPDATE devices SET
          qr_code = $2,
          slot_id = $3,
          slot_identifier = COALESCE($4, slot_identifier),
          updated_at = NOW()
         WHERE id = $1 AND slot_id IS NULL`,
        [byLabel.rows[0].id, qr, slotId, slotIdentifier],
      )
      stats.devicesUpdated += 1
    } catch (err) {
      stats.devicesSkipped += 1
      console.error(`[device-sync] assign slot_id for label ${slotLabel} failed:`, err)
    }
    return
  }

  try {
    await releaseQrFromOthers(qr, '00000000-0000-0000-0000-000000000000')
    const publicId = await nextPublicId('PD', 4)
    await query(
      `INSERT INTO devices (
        public_id, qr_code, road_id, slot_number, slot_id, slot_identifier,
        model, installed_on, install_status
      ) VALUES ($1, $2, $3, $4, $5, $6, 'Flap barrier — 4 wheeler', CURRENT_DATE, 'Working')`,
      [publicId, qr, roadId, slotLabel, slotId, slotIdentifier],
    )
    stats.devicesCreated += 1
  } catch (err) {
    stats.devicesSkipped += 1
    console.error(`[device-sync] insert failed for slot_id ${slotId}:`, err)
  }
}

async function syncQrDevices(stats: SyncRunStats) {
  const first = await deviceSyncFetch('/qr-codes', {
    status: 'all',
    page: 1,
    per_page: PER_PAGE,
  })
  const page1 = parseQrPage(first)
  stats.qrTotal = page1.total
  const totalPages = page1.lastPage
  const roadCache = new Map<string, string | null>()

  for (const item of page1.items) {
    await upsertDevice(item, roadCache, stats)
  }
  stats.pagesProcessed = 1

  for (let page = 2; page <= totalPages; page += 1) {
    const payload = await deviceSyncFetch('/qr-codes', {
      status: 'all',
      page,
      per_page: PER_PAGE,
    })
    const { items } = parseQrPage(payload)
    for (const item of items) {
      await upsertDevice(item, roadCache, stats)
    }
    stats.pagesProcessed += 1
  }
}

/** Background runner — must not be awaited by HTTP handlers for the full duration. */
export async function runDeviceSync(runId: string) {
  const stats = emptyStats()
  try {
    await syncLocations(stats)
    await syncQrDevices(stats)
    await completeRun(runId, stats)
  } catch (err) {
    const message =
      err instanceof DeviceSyncClientError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Device sync failed'
    console.error(`[device-sync] run ${runId} failed:`, message)
    try {
      await failRun(runId, message, stats)
    } catch (updateErr) {
      console.error(`[device-sync] failed to mark run ${runId}:`, updateErr)
    }
  }
}

export function scheduleDeviceSync(runId: string) {
  setImmediate(() => {
    void runDeviceSync(runId)
  })
}
