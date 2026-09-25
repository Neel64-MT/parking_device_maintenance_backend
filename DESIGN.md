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

**Assign exception:** `POST /api/tickets/:id/assign` uses `assertCanAssignTickets` (Control room / Admin / Project manager only) plus `assertRoadAccess` (not `assertTicketAccess`) so Control room can assign tickets they did not raise. Technicians cannot assign, reassign, or handover (`handoverToUserId` is rejected unless the caller can assign). Eligible assignees: Active Technician / Engineer / Control room / Project manager. Writes are transactional (`tickets.assignee_id` + `ticket_assignments` + `ticket_events`). Same assignee → no new history. Detail `assignmentTrail` and assign response use `{ when, title, body }` from `ticket_assignments` (newest first). List, detail, dashboard, devices, and work report remain visibility-scoped.

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

## QR sticker token → Slot MAC (Phase 33)

`POST /api/devices/slot-mac` (`authorize('Scan QR', 'v')`), body `{ "qr_token": "..." }` (also accepts `qrToken`).

Flow: require `DEVICE_SYNC_API_TOKEN` → SmartPark `POST {SMARTPARK_API_BASE_URL}/get-slot-mac` with `{ qr_token }` → match local device `LOWER(TRIM(slot_identifier)) = LOWER(TRIM(mac_id))` → return the same scan payload as `/scan`, plus `macId` / `bleMac` (and SmartPark `slotLabel` when present).

Errors: `503 DEVICE_SYNC_NOT_CONFIGURED`; `502 SLOT_MAC_UPSTREAM_ERROR`; `404 SLOT_MAC_NOT_FOUND`; `404 NOT_FOUND` if MAC resolves but no local device.

## Device coordinates

`devices.latitude` / `devices.longitude` are TEXT (migration `001_init`). Seed populates Ahmedabad-area dummy strings. Create/PATCH accept optional string coords.

## One open ticket

Before insert on `POST /api/tickets`, require non-empty `devices.slot_identifier`. If missing → `ApiError(400, ..., 'SLOT_IDENTIFIER_REQUIRED', { deviceId })`.

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

CRUD: `POST/PATCH /api/parts` (Issue master `c`/`e`, or Technician/Engineer). Hard-delete unused: `DELETE /api/parts/:id` (Issue master `d` — Admin, PM, Technician, Engineer). Used parts → `409 IN_USE` (deactivate via `PATCH active: false`). List: `GET /api/parts` and `GET /api/lookups/parts` (Update ticket `v`).

Image zoom/crop are frontend-only; `POST /api/uploads` is unchanged.

---

# Design — Issue Category & Subcategory (Phase 37)

## Master

| Endpoint | Notes |
|----------|-------|
| `GET /api/issues` | Nested categories + subs (`Issue master` `v`) |
| `POST /api/issues/categories` | `{ name }` trimmed `min(2)`/`max(120)` — `c` |
| `PATCH /api/issues/categories/:id` | `{ name?, active? }` — `e`; soft-deactivate via `active: false` |
| `DELETE /api/issues/categories/:id` | Hard-delete unused — `d`; tickets/events on category or its subs → `409 IN_USE`; unused subs CASCADE |
| `POST /api/issues/subcategories` | `{ categoryId, name, severity }`; parent must exist and be active (`404` / `400 CATEGORY_INACTIVE`) — `c` |
| `DELETE /api/issues/subcategories/:id` | Hard-delete unused — `d`; used on tickets → `409 IN_USE` |

Raise picker stays `GET /api/lookups/issue-categories` (active only).

---

# Design — Multiple issues per ticket (Phase 41)

## Storage

| Table / column | Notes |
|----------------|-------|
| `ticket_issues` | `(ticket_id, role reported\|found, category_id, subcategory_id, sort_order)`; UNIQUE per ticket+role+sub |
| `tickets.reported_*` / `found_*` | Primary (first) issue for backward compatibility |

## API

- Raise / Update / Close: `issues: [{ categoryId, subCategoryId }, …]` preferred; legacy single pair still accepted
- Detail: `issuesReported` / `issuesFound` arrays `{ categoryId, subCategoryId, category, sub, severity }`
- Update with `issues` **replaces** found list; omit leaves found unchanged

Site attendant: Device list `vc....` (Sync); Issue master `vce..d`; Add device still denied.

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

# Design — Add Update restrictions (Phase 30)

## Gates (order)

1. Auth + `authorize('Update ticket','e')`
2. Ticket exists (`404 NO_TICKETS_AVAILABLE` if not)
3. `assertTicketAssigned` → `409 TICKET_NOT_ASSIGNED` / `Ticket not assigned`
4. `assertCanAddUpdate` → Admin or `assignee_id === me` else `403 NOT_ASSIGNED_USER` / `This ticket is assigned to another user` + `details.assignedTo`
5. Zod body including required `visitedBy` UUID
6. `assertValidVisitedBy` — Active user with role Technician or Engineer
7. Existing parts/cost/transaction (no auto-claim of unassigned tickets)

List visibility (`assertTicketAccess`) is not applied on Add Update so QR user B receives `NOT_ASSIGNED_USER` rather than a generic road Forbidden.

## Request

```json
{ "updateType": "Site visit — not resolved", "cost": 1000, "parts": ["uuid"], "visitedBy": "user-uuid" }
```

`visitedBy` is stored in `ticket_events.meta` as `{ "visitedBy": "<uuid>" }` (detail `workHistory[].meta`).

## Roles

- **Engineer** — seeded/migrated (`013_engineer_role.sql`); Technician-like permissions; included in `GET /api/lookups/technicians`.

## Frontend

**FRONTEND CHANGE REQUIRED:** require Visited By (Technician/Engineer UUID); toast business errors from `error`; map `details[].field === "visitedBy"` under the field; hide/disable Add Update when unassigned or when caller is not Admin/assignee (API still enforces).

---

# Design — Work report (Phase 31)

## Endpoint

`GET /api/reports/work` and `/work/export` — `authorize('Work report','v')`.

Query: `view` (`day|week|month|range`), `from`, `to`, `person` (`Everyone`), `road` (`All roads`).

## Response people shape

Matches frontend mock: `name`, `role`, `roads`, `days`, `visits`, `worked`, `closed`, `open`, `cost`, `load`, `tickets` (6-string tuples).

| view | tickets row meaning |
|------|---------------------|
| day | Ticket, Slot Id, Road/slot, Issue, Work done, Result |
| week / range | Day, Volume, Roads, Main issues, Outcome, Result |
| month | Week, Dates, Volume, Main issues, Outcome, Result |

Aggregation helpers: [`src/lib/work-report.ts`](src/lib/work-report.ts). Road filter uses `rd.name`. Actors: Technician + Engineer.

## Frontend

**FRONTEND CHANGE REQUIRED:** replace `REPORT[view]` with API fetch; Export → CSV blob; Person select from `/api/lookups/technicians`.

---

# Design — Device Sync (Phase 23 / 29)

## Device / road fields

| Concept | Column | Source |
|---------|--------|--------|
| Slot Id | `devices.slot_id` | external `slot.id` — **immutable once set**; **only required** sync match key |
| Slot Label | `devices.slot_number` | external `slot.slot_label` (fallback `String(slotId)`) |
| Slot Identifier | `devices.slot_identifier` | external `mac_address` (optional; updates when MAC changes; null does not wipe) |
| QR Number | `devices.qr_code` | external `qr_number` (may update; placeholder if omitted) |
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

## Per-record processing (Phase 29)

1. Missing Slot Id → skip (`devicesSkipped`). MAC/QR optional.
2. Missing label → `String(slotId)`; missing QR → `UNLINKED-SLOT-{slotId}`.
3. Collect all QR pages first; last payload per Slot Id wins. Duplicate QR across slots → last Slot Id keeps the real QR; others get stable `UNLINKED-SLOT-{slotId}`.
4. Find by `slot_id` → none → INSERT (MAC may be null).
5. Existing Slot Id → same effective MAC/QR/road/label → **no-op**. Null incoming MAC does not clear existing MAC.
6. Existing Slot Id → different MAC/QR/road/label → UPDATE; `devicesUpdated` counts rows that actually changed.
7. Existing devices stay usable for tickets even when a later sync item for another slot is incomplete.

## Sync run

Table `device_sync_runs`: `status` ∈ `started` | `completed` | `failed`, `stats` JSONB, `error_message`.

## Background

`POST /api/device-sync` schedules `setImmediate` work; single-flight while any run is `started` (`409 SYNC_IN_PROGRESS`).

QR fetch: `GET /qr-codes?status=all&page=N&per_page=50`. Page count from `data.pagination.last_page` (e.g. 22 for total 1094). Locations: `data` is a top-level array.

## Roads after sync

Device Sync upserts parking locations into `roads` (single source of truth). No separate sync-roads endpoint — `GET /api/roads` and `GET /api/lookups/roads` simply read that table.

---

# Design — New-ticket notifications and Web Push (Phase 38)

## Storage

| Table | Purpose |
|-------|---------|
| `notifications` | One persistent event per recipient, related ticket, read state, and accepted Web Push timestamp |
| `push_subscriptions` | Multiple browser/device endpoints per user with `p256dh` / `auth` keys |

`notifications` is unique on `(recipient_user_id, type, related_entity_type, related_entity_id)`. `push_subscriptions.endpoint` is unique, so registering the same browser endpoint updates keys instead of creating a duplicate.

## Recipients and authorization

- Event type: `ticket.raised`
- Recipients: Active users whose current role is `Admin`, `Project manager`, or `Control room` and whose existing `All tickets` permission has `v`
- API access: JWT + `authorize('All tickets', 'v')`
- No individual user IDs and no new permission screen
- Notification reads/updates always include `recipient_user_id = current user`; another user's notification returns `404`

The notification link follows existing road scope / raiser / assignee access. It does not widen ticket list or detail authorization.

## Ticket flow

1. `POST /api/tickets` writes the ticket, raised event, and optional initial assignment.
2. Only after those writes succeed, `createNewTicketNotifications(ticketId)` resolves the actual ticket/device/issue/raiser fields.
3. Recipient rows are inserted in a notification-only transaction with `ON CONFLICT DO NOTHING`.
4. The ticket route catches and logs notification errors independently; ticket creation still returns its original success response.
5. Failed ticket creation never calls the notification service.

## Notification content

Stored `data` contains ticket reference/link, road/slot/device identity, reported category/subcategory/severity, raiser, and created time. It excludes description, photos, costs, email, and mobile.

Browser payload:

```json
{
  "notification": {
    "title": "New ticket raised",
    "body": "New ticket TK-1042 has been raised for Slot 42 on Science City.",
    "tag": "notification.<uuid>",
    "data": { "url": "/tickets/TK-1042" }
  },
  "data": {
    "notificationId": "<uuid>",
    "type": "ticket.raised",
    "ticketId": "TK-1042"
  }
}
```

## Web Push lifecycle

- `GET /api/notifications/push-config` returns `{ available, publicKey, registered }`. Browser permission remains browser-owned and is never stored.
- `PUT /api/notifications/push-subscriptions` validates a public HTTPS endpoint and browser keys, then upserts by endpoint for the current user.
- `DELETE /api/notifications/push-subscriptions/:id` removes only the current user's subscription.
- Configured delivery uses `setImmediate` + `web-push`; there is no new queue or WebSocket/SSE system.
- Push service `404` / `410` deletes the expired subscription. Other errors are logged without endpoint/key contents.
- `push_sent_at` is set after at least one push is accepted, preventing a later delivery pass from sending that notification again.
- Without VAPID configuration, persistent in-app notifications still work and push delivery is skipped.

## Frontend

**FRONTEND INTEGRATION COMPLETE:** the sibling frontend owns the service worker, explicit permission action, VAPID subscription, authenticated read-state relay, and the shared unread badges on the Tickets parent and All Tickets child. No new menu item or realtime transport was added.
