import { env } from '../config/env.js'

const FETCH_TIMEOUT_MS = 30_000

export class DeviceSyncClientError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
  ) {
    super(message)
    this.name = 'DeviceSyncClientError'
  }
}

function baseUrl() {
  return (process.env.DEVICE_SYNC_BASE_URL || env.DEVICE_SYNC_BASE_URL).replace(/\/+$/, '')
}

/** SmartPark `/api/v1` root for endpoints like get-slot-mac. */
export function smartParkV1Base() {
  const explicit = (
    process.env.SMARTPARK_API_BASE_URL ||
    env.SMARTPARK_API_BASE_URL ||
    ''
  ).trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  return baseUrl().replace(/\/engineer\/device-binding\/?$/i, '')
}

/** Read at call time so tests can override process.env. */
export function getDeviceSyncApiToken() {
  if (Object.prototype.hasOwnProperty.call(process.env, 'DEVICE_SYNC_API_TOKEN')) {
    return (process.env.DEVICE_SYNC_API_TOKEN || '').trim()
  }
  return (env.DEVICE_SYNC_API_TOKEN || '').trim()
}

function authorizationHeader() {
  const token = getDeviceSyncApiToken()
  if (!token) {
    throw new DeviceSyncClientError('Device sync API token is not configured')
  }
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`
}

export type SlotMacResult = {
  macId: string | null
  bleMac: string | null
  slotLabel: string | null
}

/**
 * POST SmartPark `/api/v1/get-slot-mac` with `{ qr_token }`.
 * Uses the same Bearer token as Device Sync.
 * SmartPark may return success with null mac_id (slot known, MAC not bound yet).
 */
export async function fetchSlotMacByQrToken(qrToken: string): Promise<SlotMacResult> {
  const url = `${smartParkV1Base()}/get-slot-mac`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: authorizationHeader(),
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify({ qr_token: qrToken }),
      signal: controller.signal,
    })
    const text = await res.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new DeviceSyncClientError(
        `Invalid JSON from get-slot-mac (${res.status})`,
        res.status,
      )
    }
    if (!res.ok) {
      throw new DeviceSyncClientError(`get-slot-mac error (${res.status})`, res.status)
    }
    const root = json as {
      success?: boolean
      data?: { mac_id?: unknown; ble_mac?: unknown; slot_label?: unknown }
    }
    if (root?.success === false) {
      throw new DeviceSyncClientError('get-slot-mac returned success=false', 404)
    }
    const data = root?.data
    const macId =
      typeof data?.mac_id === 'string' && data.mac_id.trim() ? data.mac_id.trim() : null
    const bleMac =
      typeof data?.ble_mac === 'string' && data.ble_mac.trim() ? data.ble_mac.trim() : null
    const slotLabel =
      typeof data?.slot_label === 'string' && data.slot_label.trim()
        ? data.slot_label.trim()
        : null
    return { macId, bleMac, slotLabel }
  } catch (err) {
    if (err instanceof DeviceSyncClientError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      throw new DeviceSyncClientError('get-slot-mac request timed out')
    }
    throw new DeviceSyncClientError(
      err instanceof Error ? err.message : 'get-slot-mac request failed',
    )
  } finally {
    clearTimeout(timer)
  }
}

export async function deviceSyncFetch<T = unknown>(
  path: string,
  query?: Record<string, string | number>,
): Promise<T> {
  const url = new URL(`${baseUrl()}${path.startsWith('/') ? path : `/${path}`}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, String(v))
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: authorizationHeader(),
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
      },
      signal: controller.signal,
    })
    const text = await res.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      throw new DeviceSyncClientError(
        `Invalid JSON from external sync API (${res.status})`,
        res.status,
      )
    }
    if (!res.ok) {
      throw new DeviceSyncClientError(
        `External sync API error (${res.status})`,
        res.status,
      )
    }
    return json as T
  } catch (err) {
    if (err instanceof DeviceSyncClientError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      throw new DeviceSyncClientError('External sync API request timed out')
    }
    throw new DeviceSyncClientError(
      err instanceof Error ? err.message : 'External sync API request failed',
    )
  } finally {
    clearTimeout(timer)
  }
}

export type ExternalLocation = {
  id: number
  name: string
  type?: string | null
}

export type ExternalQrItem = {
  id?: number
  qr_number: string
  mac_address?: string | null
  slot?: { id?: number; slot_label?: string | null; slot_identifier?: string | null } | null
  parking_location?: { id?: number; name?: string | null; type?: string | null } | null
}

export function parseLocationList(payload: unknown): ExternalLocation[] {
  const root = payload as { data?: unknown; success?: boolean }
  const data = root?.data
  let items: unknown[] = []
  if (Array.isArray(data)) items = data
  else if (data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items)) {
    items = (data as { items: unknown[] }).items
  } else if (Array.isArray(payload)) items = payload
  else {
    throw new DeviceSyncClientError('Invalid locations response shape')
  }

  const out: ExternalLocation[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const id = Number(row.id)
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    if (!Number.isFinite(id) || !name) continue
    out.push({
      id,
      name,
      type: typeof row.type === 'string' ? row.type : null,
    })
  }
  return out
}

export function parseQrPage(payload: unknown): {
  total: number
  lastPage: number
  perPage: number
  items: ExternalQrItem[]
} {
  const root = payload as {
    data?: {
      summary?: { total?: unknown }
      items?: unknown[]
      pagination?: {
        current_page?: unknown
        last_page?: unknown
        per_page?: unknown
        total?: unknown
      }
    }
  }
  const data = root?.data
  if (!data || typeof data !== 'object') {
    throw new DeviceSyncClientError('Invalid QR codes response shape')
  }
  const total = Number(data.summary?.total ?? data.pagination?.total)
  if (!Number.isFinite(total) || total < 0) {
    throw new DeviceSyncClientError('Missing or invalid data.summary.total')
  }
  const perPageRaw = Number(data.pagination?.per_page)
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? perPageRaw : 50
  const lastPageRaw = Number(data.pagination?.last_page)
  const lastPage =
    Number.isFinite(lastPageRaw) && lastPageRaw > 0
      ? lastPageRaw
      : Math.max(1, Math.ceil(total / perPage))

  const rawItems = Array.isArray(data.items) ? data.items : []
  const items: ExternalQrItem[] = []
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const qr = typeof row.qr_number === 'string' ? row.qr_number.trim() : ''
    if (!qr) continue
    items.push({
      id: row.id != null ? Number(row.id) : undefined,
      qr_number: qr,
      mac_address:
        typeof row.mac_address === 'string' && row.mac_address.trim()
          ? row.mac_address.trim()
          : null,
      slot: (row.slot as ExternalQrItem['slot']) ?? null,
      parking_location: (row.parking_location as ExternalQrItem['parking_location']) ?? null,
    })
  }
  return { total, lastPage, perPage, items }
}
