# Design — Forgot Password & Admin Password Change

## Forgot Password flow

```text
User → Login → Forgot Password
  → POST /api/auth/forgot-password { email }
  → If Active user with that email:
       invalidate prior unused reset tokens
       create crypto token (raw) + store sha256 hash (TTL 1h)
       send reset link via SMTP (or log URL in development)
  → Always return generic success (no account enumeration)
```

Reset link: `{APP_URL or FRONTEND_ORIGIN}/reset-password?token=<raw>`

## Reset Password flow

```text
User opens link → POST /api/auth/reset-password { token, password }
  → Hash token, lookup unused non-expired row
  → Validate password (min 8, shared schema)
  → bcrypt hash → update users.password_hash
  → Set users.password_changed_at = NOW()
  → Mark token used_at; invalidate other unused tokens for user
  → Login with new password works; JWTs with iat < password_changed_at rejected
```

## Admin Password Change flow

```text
Admin → Users panel → PATCH /api/users/:id { password }
  → requireAuth + authorize('Users', 'e')
  → Same password schema + hashPassword
  → Set password_changed_at; clear unused reset tokens
```

No separate `/admin/users/:id/password` route (would duplicate).

## Token strategy

| Item | Choice |
|------|--------|
| Raw token | `crypto.randomBytes(32).toString('hex')` |
| Stored | SHA-256 hex of raw token only |
| TTL | 1 hour |
| Reuse | One-time (`used_at`); new forgot request invalidates prior unused tokens |
| API | Never return or log raw token |

## Email

- Optional SMTP via `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`
- If SMTP unset: still generic success; in `development` log reset URL to console (not API body)
- Production without SMTP: no email sent (documented)

## Session behavior after password change

- Set `users.password_changed_at` and increment `users.password_version`
- JWTs include claim `pv` (password version) at login
- `requireAuth` rejects tokens when `pv` does not match current `password_version`
- Logout denylist of current `jti` unchanged
- No multi-device denylist table

## Password validation

Shared Zod: minimum 8 characters (same for create user, admin patch, reset).

## Frontend (not in this backend workstream)

**FRONTEND CHANGE REQUIRED:** Forgot/Reset pages + Login link; Users form password field wired to existing PATCH; Signup copy may say “Admin or Project manager”.

---

# Design — Ticket Visibility & PM Signup Approval

## Ticket visibility

Privileged roles (`Admin`, `Project manager`): no assignee/raiser filter (still subject to `assigned_roads` if ever scoped that way; defaults are `all_roads`).

All other roles: list/export/aggregate SQL adds  
`(t.assignee_id = $userId OR t.raised_by_user_id = $userId)`.

Detail, updates, close-preview, close call `assertTicketAccess` after load (plus existing road/holder rules).

**Assign exception:** `POST /api/tickets/:id/assign` uses `assertCanAssignTickets` (Control room / Admin / Project manager only) plus `assertRoadAccess` (not `assertTicketAccess`) so Control room can assign tickets they did not raise. Technicians cannot assign, reassign, or handover (`handoverToUserId` is rejected unless the caller can assign). List, detail, dashboard, devices, and work report remain visibility-scoped.

**Field-work road bypass:** Site attendant and Technician skip road checks on `GET /api/devices/scan` and `POST /api/tickets` via `assertRoadAccessUnlessFieldWork`. Role scope stays `assigned_roads`. Technicians still only update/close tickets they hold or raised (`assertTicketAccess` / holder rules). Device create/PATCH and assign remain `assertRoadAccess`.

Helpers live in `src/lib/ticket-access.ts` — single reusable rule reused by:

- `tickets.ts` — list, export, detail, mutations
- `dashboard.ts` — fleet open-ticket lateral, down reasons, open tickets, open-over-3
- `devices.ts` — list/export/scan open ticket + 6m counts; detail history/parts/fail ranks
- `reports.ts` — work report events and CSV export

Pagination totals and search/filter on tickets already run after the visibility WHERE clause.

Road master / Users / Issue master usage counts stay unscoped catalog aggregates.

Backward compatible for Admin/PM city-wide views. Narrows Control room vs prior city-wide list (per product requirement).

**FRONTEND CHANGE REQUIRED:** wire Dashboard / All Tickets / Devices to APIs without client-side role ticket filters.

## Project Manager signup approval

Pending signups remain `users.status = 'Pending'` from `POST /api/auth/signup`.

Approval remains `PATCH /api/users/:id` with `status: 'Active'` (and optional `roleId` / details).

Project manager Users permission: `vce...` (view, create, edit). Roles & permissions stay view-only.

No new signup-request table or approve endpoint.

---

# Design — QR Scan Payload & One-Open-Ticket Rule

## Scan API

Canonical endpoint: `GET /api/devices/scan?q={identifier}` (`authorize('Scan QR', 'v')`).

Matches `public_id`, `qr_code`, `slot_number` (case-insensitive), or `slot_id` as text. Road scope via `assertRoadAccessUnlessFieldWork` (Site attendant / Technician bypass). Open-ticket lateral join is **not** ticket-visibility filtered (so Raise vs Update is reliable); 6-month count remains visibility-filtered.

Canonical response fields (Phase 17+): `deviceId` (Slot Id preferred), `deviceName`, `locationSite`, `slot`, `slotId`, `slotLabel`, `slotIdentifier`, `currentStatus`, `statusDate`, `ticketsLast6Months`, `openTicketId`, `openTicketAge`, `openTicketIssue`, `latitude`, `longitude`, plus legacy `qr` / `qrNumber` / `parkingLocation`.

Legacy fields (`id`, `location`, `status`, `statusTone`, `facts`, `deviceUuid`, `roadId`) remain for older ScanQr clients.

No `/api/devices/:id/scan-details` path — avoids conflict with `GET /:deviceId`.

## Device coordinates

`devices.latitude` / `devices.longitude` are TEXT (migration `001_init`). Seed populates Ahmedabad-area dummy strings. Create/PATCH accept optional string coords.

## One open ticket

Before insert on `POST /api/tickets`, query non-`Closed` tickets for the device. If any exist → `ApiError(409, ..., 'OPEN_TICKET_EXISTS', { ticketId, openTicketId })`.

DB backstop: partial unique index `idx_tickets_one_open_per_device` on `tickets(device_id) WHERE status <> 'Closed'` (migration `012`). Concurrent insert races map unique-violation to the same `OPEN_TICKET_EXISTS` payload.

Flow: QR → scan → (`openTicketId` ? update existing via `POST /api/tickets/:id/updates` : `POST /api/tickets`). Frontend should redirect to `openTicketId` instead of creating another ticket.

When `devices.slot_id` is set (unique), one open ticket per device UUID equals one open ticket per Slot Id.

---

# Design — Ticket Status (Open, not New)

## Stored statuses

Exactly four values on `tickets.status`:

| Status | Written by |
|--------|------------|
| `Open` | `POST /api/tickets` when `assigneeId` is omitted |
| `Under repair` | Raise with assignee; `POST /:id/assign`; most site updates |
| `Waiting for spare` | Site update `updateType === 'Waiting for spare'` |
| `Closed` | `POST /:id/close` |

There is no `New` status. Schema default is already `Open` (`001_init`). Migration `007_ticket_status_open.sql` updates any remaining `New` rows.

## “Open” vs “open ticket”

- Status **`Open`**: unassigned, newly raised.
- **Open ticket** (one-per-device / dashboard overlays): any ticket with `status <> 'Closed'` (`Open`, `Under repair`, or `Waiting for spare`).

## List UI

The tickets list tab query `tab=new` means **unassigned and not closed**. Tab key `new` is not a stored status. Tab `asg` = has assignee; `cls` = Closed.

List/export/tiles presentation (`listStatus` in `tickets.ts`):

- Stored `New` → `Open`
- Has `assignee_id` and stored `Open` → list shows `Under repair` (DB unchanged; detail still returns stored status)

Badges for unassigned tickets must render `Open`, never `New`.

**FRONTEND CHANGE REQUIRED:** replace `New` badges with `Open`; trust list `status` for Assigned vs Under repair alignment.

---

# Design — Ticket list `daysAfterClose`

`GET /api/tickets` already returned `daysOpen` (life of the ticket until close or now). Closed rows now also return `daysAfterClose`:

```text
if closed_at set → floor((now - closed_at) / 1 day)
else → null
```

Purpose: All Tickets closed tab / 7-day reopen copy can show “N days since close” without the client parsing dates.

Not added to `GET /api/tickets/:id` (detail still has “Days open” in `header.facts`). No migration.

**FRONTEND CHANGE REQUIRED:** bind closed-ticket aging to `daysAfterClose`.

---

# Design — List presentation for assigned `Open`

Some rows can have `assignee_id` set while stored `status` remains `Open` (legacy / edge cases). Assign path normally writes `Under repair`.

For **list, tiles, and CSV only**, `listStatus(status, assigneeId)` maps assigned + `Open` → `Under repair` so the Assigned tab pills match the Under repair tile without a data migration.

Detail and mutate paths keep stored status (with `New` → `Open` display normalization where applied).

---

# Design — List pagination (Phase 21)

## Parameters

| Param | Default | Rules |
|-------|---------|-------|
| `page` | `1` | Positive int (Zod coerce); `0` / negative → 400 |
| `limit` | `10` | Exactly `10`, `25`, `50`, or `100` |

Shared: `src/lib/pagination.ts`.

## Response

Unchanged envelope sibling:

```json
{ "success": true, "data": [], "pagination": { "page": 1, "limit": 10, "total": 42, "totalPages": 5 } }
```

Tickets also return `tiles` / `tabCounts` (aggregated over visibility + base filters, not only the current page). Devices return status tiles over the filtered device set **excluding** the `status` query (so Working / Under repair / Not working cards stay populated while the list is status-filtered). List rows and `pagination.total` still apply `status`.

Status-card → list contract (frontend): `GET /api/devices?status=Working|Under%20repair|Not%20working&page=1&limit=10` — same Device List API; not tickets.

## Tickets SQL

1. Base WHERE: visibility + `q` / road / category / assignee  
2. Aggregate query → tiles + tabCounts  
3. Page WHERE = base + tab/status SQL  
4. `COUNT(*)` → `pagination.total`  
5. `SELECT ... ORDER BY raised_at DESC LIMIT/OFFSET`

## Devices SQL

CTE with open-ticket LATERAL + derived status `CASE` (mirrors `deriveDeviceStatus`) + `tickets_6m`. Outer WHERE applies status/repeats; then COUNT aggregates + `LIMIT/OFFSET`. Export uses same CTE without paging.

## Frontend

**FRONTEND CHANGE REQUIRED:** align TicketList `limit` defaults with allowed values; render pager from `pagination` when authorized. Do not add client-side page slicing of full lists.

---

# Design — Parts master & visit cost (Phase 22)

## Master

| Column | Notes |
|--------|-------|
| `parts.amount` | `NUMERIC(12,2)` NOT NULL; list/lookups return as number |
| `ticket_event_parts` | `(event_id, part_id)` PK; stores snapshot `amount` at event time |

CRUD: `POST/PATCH /api/parts` (Issue master `c`/`e`). List: `GET /api/parts` and `GET /api/lookups/parts` (Update ticket `v`).

## Visit cost

```text
labourCost = body.cost
partsCost  = SUM(parts.amount for unique active part IDs)
eventCost  = labourCost + partsCost
tickets.total_cost += eventCost
```

Request: `{ "cost": 1000, "parts": ["uuid-1", "uuid-2"] }`  
Event `parts` JSONB: `[{ "id", "name", "amount" }, ...]`. Device history reads `name` from object or legacy string.

## Frontend

**FRONTEND CHANGE REQUIRED:** PartChips / update & close forms must send part UUIDs and labour-only `cost` (do not fold master prices into `cost`).

---

# Design — Device Sync (Phase 23 / 27)

## Device / road fields

| Concept | Column | Source |
|---------|--------|--------|
| Slot Id | `devices.slot_id` | external `slot.id` — **immutable once set**; sync match key |
| Slot Label | `devices.slot_number` | external `slot.slot_label` (required) |
| Slot Identifier | `devices.slot_identifier` | external `mac_address` (**required** on sync; updates when MAC changes) |
| QR Number | `devices.qr_code` | external `qr_number` (may update on sync) |
| Parking Location | `devices.road_id` → `roads` | `parking_location` via `roads.external_location_id` / name |

`devices.public_id` stays in the DB for internal uniqueness but is not the primary API identity when `slot_id` is present. Ticket list/detail expose `deviceId` (Slot Id preferred) plus numeric `slotId`. `GET /api/devices/:deviceId` accepts `public_id`, device UUID, or Slot Id as text and returns the same history shape (`header.id` = display id preferring Slot Id). Create/PATCH device responses use the same display rule (`id` / `publicId` / `slotId`); manual add/edit does not write `slot_id` (Slot Id not editable — sync-owned). Manual create/PATCH may set `slotIdentifier` (MAC) and `qrNumber` as a fallback when Device Sync is down.

## Manual Edit Device form mapping

| Form field | API body / response |
|------------|---------------------|
| Slot Id | Display only (`slotId`); never sent for write |
| Slot Label | `slotNumber` |
| MAC address | `slotIdentifier` |
| QR Number | `qrNumber` |
| Parking Location | `roadId` (UUID from lookups) |
| Side / landmark / lat / lng / model / dates / status / photo / remarks | same camelCase keys as create schema |

## Per-record processing (Phase 27)

1. Missing Slot details or empty MAC → skip (`devicesSkipped`); do not create a partial device.
2. Collect all QR pages first; last payload per Slot Id wins. Duplicate QR across slots → last Slot Id keeps the real QR; others get stable `UNLINKED-SLOT-{slotId}` (stops update thrash).
3. Find by `slot_id` → none → INSERT (with MAC).
4. Existing Slot Id → same MAC + same QR/road/label → **no-op** (no write, not counted as Updated).
5. Existing Slot Id → different MAC/QR/road/label vs DB → UPDATE only when values `IS DISTINCT FROM` stored; `devicesUpdated` counts rows that actually changed.
6. Existing devices stay usable for tickets even when a later sync item for another slot is incomplete.

## Sync run

Table `device_sync_runs`: `status` ∈ `started` | `completed` | `failed`, `stats` JSONB, `error_message`.

## Background

`POST /api/device-sync` schedules `setImmediate` work; single-flight while any run is `started` (`409 SYNC_IN_PROGRESS`).

QR fetch: `GET /qr-codes?status=all&page=N&per_page=50`. Page count from `data.pagination.last_page` (e.g. 22 for total 1094). Locations: `data` is a top-level array.

## Roads after sync

Device Sync upserts parking locations into `roads` (single source of truth). No separate sync-roads endpoint — `GET /api/roads` and `GET /api/lookups/roads` simply read that table.
