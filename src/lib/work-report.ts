import { deviceDisplayId } from './device-ref.js'

export type WorkReportView = 'day' | 'week' | 'month' | 'range'

export type WorkReportEventRow = {
  user_id: string
  full_name: string
  role_name: string
  created_at: string | Date
  ticket_public_id: string
  ticket_status: string
  event_type: string
  cost: string | number | null
  work_done: string | null
  title: string | null
  body: string | null
  device_public_id: string
  slot_id: string | number | null
  slot_number: string | null
  road_name: string
  issue_name: string | null
}

/** Inclusive calendar days between from and to (date-only), min 1. */
export function daysInPeriodInclusive(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate())
  return Math.max(1, Math.round((b - a) / 86400000) + 1)
}

export function resolveWorkReportRange(
  view: WorkReportView,
  fromStr?: string,
  toStr?: string,
): { from: Date; to: Date } {
  const to = toStr ? new Date(toStr) : new Date()
  const from = fromStr
    ? new Date(fromStr)
    : view === 'month'
      ? new Date(to.getFullYear(), to.getMonth(), 1)
      : view === 'week' || view === 'range'
        ? new Date(to.getTime() - 6 * 86400000)
        : new Date(to.toISOString().slice(0, 10))
  return { from, to }
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function dateKey(createdAt: string | Date): string {
  return ymd(new Date(createdAt))
}

function readableDay(d: Date): string {
  return d.toLocaleDateString('en-IN', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  })
}

export function workReportSub(view: WorkReportView, from: Date, to: Date): string {
  if (view === 'day' || ymd(from) === ymd(to)) return readableDay(from)
  return `${ymd(from)} to ${ymd(to)}`
}

/** Monday-based ISO week label + date span for month view. */
function isoWeekBucket(createdAt: string | Date): {
  key: string
  weekLabel: string
  dateSpan: string
} {
  const d = new Date(createdAt)
  const day = d.getUTCDay() || 7
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  monday.setUTCDate(monday.getUTCDate() - day + 1)
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  const jan4 = new Date(Date.UTC(monday.getUTCFullYear(), 0, 4))
  const week1Mon = new Date(jan4)
  const jan4Day = jan4.getUTCDay() || 7
  week1Mon.setUTCDate(jan4.getUTCDate() - jan4Day + 1)
  const weekNum = Math.floor((monday.getTime() - week1Mon.getTime()) / (7 * 86400000)) + 1
  const year = monday.getUTCFullYear()
  const key = `${year}-W${String(weekNum).padStart(2, '0')}`
  const fmt = (x: Date) =>
    x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
  return {
    key,
    weekLabel: `Week ${weekNum}`,
    dateSpan: `${fmt(monday)} – ${fmt(sunday)}`,
  }
}

function dayLabel(createdAt: string | Date): string {
  const d = new Date(createdAt)
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

function topIssues(issues: string[], limit = 3): string {
  const counts = new Map<string, number>()
  for (const i of issues) {
    if (!i || i === '—') continue
    counts.set(i, (counts.get(i) || 0) + 1)
  }
  return (
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([n]) => n)
      .join('; ') || '—'
  )
}

function bucketOutcome(closed: number, open: number): { outcome: string; result: string } {
  if (closed === 0 && open === 0) return { outcome: 'No work logged', result: 'No work logged' }
  if (open === 0) return { outcome: `${closed} closed`, result: 'Closed' }
  if (closed === 0) return { outcome: `${open} open`, result: 'In progress' }
  return { outcome: `${closed} closed, ${open} open`, result: `${closed} closed` }
}

type Acc = {
  name: string
  role: string
  roads: Set<string>
  dayKeys: Set<string>
  visits: number
  worked: Set<string>
  closed: Set<string>
  open: Set<string>
  cost: number
  events: WorkReportEventRow[]
}

function isClosedEvent(e: WorkReportEventRow): boolean {
  return e.event_type === 'closed' || e.ticket_status === 'Closed'
}

function buildDayTickets(events: WorkReportEventRow[]): string[][] {
  return events.map((e) => [
    e.ticket_public_id,
    deviceDisplayId({
      slot_id: e.slot_id,
      public_id: e.device_public_id,
    }),
    `${e.road_name} · ${e.slot_number}`,
    e.issue_name || '—',
    e.work_done || e.title || e.body || '',
    e.event_type === 'closed' ? 'Closed' : 'In progress',
  ])
}

function buildDayBuckets(events: WorkReportEventRow[]): string[][] {
  const buckets = new Map<
    string,
    {
      label: string
      events: WorkReportEventRow[]
      roads: Set<string>
      closed: Set<string>
      open: Set<string>
    }
  >()
  for (const e of events) {
    const key = dateKey(e.created_at)
    if (!buckets.has(key)) {
      buckets.set(key, {
        label: dayLabel(e.created_at),
        events: [],
        roads: new Set(),
        closed: new Set(),
        open: new Set(),
      })
    }
    const b = buckets.get(key)!
    b.events.push(e)
    b.roads.add(e.road_name)
    if (isClosedEvent(e)) b.closed.add(e.ticket_public_id)
    else b.open.add(e.ticket_public_id)
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, b]) => {
      const closed = b.closed.size
      const open = Math.max(0, b.open.size - closed)
      const { outcome, result } = bucketOutcome(closed, open)
      return [
        b.label,
        String(b.events.length),
        [...b.roads].join(', ') || '—',
        topIssues(b.events.map((e) => e.issue_name || '')),
        outcome,
        result,
      ]
    })
}

function buildWeekBuckets(events: WorkReportEventRow[]): string[][] {
  const buckets = new Map<
    string,
    {
      weekLabel: string
      dateSpan: string
      events: WorkReportEventRow[]
      closed: Set<string>
      open: Set<string>
    }
  >()
  for (const e of events) {
    const { key, weekLabel, dateSpan } = isoWeekBucket(e.created_at)
    if (!buckets.has(key)) {
      buckets.set(key, { weekLabel, dateSpan, events: [], closed: new Set(), open: new Set() })
    }
    const b = buckets.get(key)!
    b.events.push(e)
    if (isClosedEvent(e)) b.closed.add(e.ticket_public_id)
    else b.open.add(e.ticket_public_id)
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, b]) => {
      const closed = b.closed.size
      const open = Math.max(0, b.open.size - closed)
      const { outcome, result } = bucketOutcome(closed, open)
      return [
        b.weekLabel,
        b.dateSpan,
        String(b.events.length),
        topIssues(b.events.map((e) => e.issue_name || '')),
        outcome,
        result,
      ]
    })
}

export function buildWorkReportPeople(
  rows: WorkReportEventRow[],
  view: WorkReportView,
  showCost: boolean,
) {
  const byUser = new Map<string, Acc>()

  for (const e of rows) {
    const key = e.user_id
    if (!byUser.has(key)) {
      byUser.set(key, {
        name: e.full_name,
        role: e.role_name,
        roads: new Set(),
        dayKeys: new Set(),
        visits: 0,
        worked: new Set(),
        closed: new Set(),
        open: new Set(),
        cost: 0,
        events: [],
      })
    }
    const u = byUser.get(key)!
    u.roads.add(e.road_name)
    u.dayKeys.add(dateKey(e.created_at))
    u.visits += 1
    u.worked.add(e.ticket_public_id)
    u.cost += Number(e.cost || 0)
    if (isClosedEvent(e)) u.closed.add(e.ticket_public_id)
    else u.open.add(e.ticket_public_id)
    u.events.push(e)
  }

  return [...byUser.values()].map((p) => {
    const closed = p.closed.size
    let tickets: string[][]
    if (view === 'day') tickets = buildDayTickets(p.events)
    else if (view === 'month') tickets = buildWeekBuckets(p.events)
    else tickets = buildDayBuckets(p.events)

    return {
      name: p.name,
      role: p.role,
      roads: [...p.roads].join(', ') || '—',
      days: p.dayKeys.size || 1,
      visits: p.visits,
      worked: p.worked.size,
      closed,
      open: Math.max(0, p.open.size - closed),
      cost: showCost ? `₹ ${p.cost.toLocaleString('en-IN')}` : undefined,
      load: Math.min(100, Math.round((p.visits / 10) * 100)),
      tickets,
    }
  })
}
