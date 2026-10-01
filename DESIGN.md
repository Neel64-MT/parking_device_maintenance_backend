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

> **Superseded by Phase 51** ("Every Ticket, Every Road" — see the last section). Every user with `All tickets` `v` now sees every ticket; `assertTicketAccess`, the assignee/raiser SQL filter and `POST /:id/assign` no longer exist. The text below is history.

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

## Users list visibility and account deletion

**Why the rules live in SQL.** Hiding rows in React would leak every restricted account to any caller who opens devtools, so `appendUserVisibilitySql` is ANDed into the single `WHERE` used by `GET /api/users`. It is applied to the tiles query too (with its own params, since tiles ignore `q` / `status`) so "Total users" equals the number of rows the caller may actually see.

**Two independent clauses, not one role check.** `u.id <> $me` applies to every role and is what removes the caller's own account. `r.name <> 'Admin'` is added only for non-Admin viewers, which is what makes a PM unable to retrieve Admin accounts. Admin therefore keeps full visibility over everyone else, including other Admins.

**Search cannot bypass it.** `q` also matches `LOWER(r.name)`, so searching "Admin" is the natural bypass attempt. Because the visibility clause is one of the ANDed predicates, that search simply returns nothing for a PM and still returns Admins for an Admin.

**Delete is a deactivation.** `RULES.md` requires that a user's name stay readable on the tickets they raised or closed, so `DELETE /api/users/:id` sets `status = 'Inactive'` instead of removing the row. This reuses the existing `users.status` enum — no migration, no new table, no cascade to reason about, and `loadAuthUser` already refuses non-`Active` users so the session dies immediately.

**Guard order in the handler** is deliberate: self first (the most specific, and it must fire even if the caller's other state changes), then existence, then the no-op guard, then `assertNotLastActiveAdmin` — the same helper `PATCH` uses, extracted so the "at least one active Admin" rule cannot drift between the two write paths.

---

# Design — QR Scan Payload & Duplicate-Ticket Rule

## Scan API

Canonical endpoint: `GET /api/devices/scan?q={identifier}` (`authorize('Scan QR', 'v')`).

Matches `public_id`, `qr_code`, `slot_number` (case-insensitive), or `slot_id` as text. Road scope via `assertRoadAccessUnlessFieldWork` (Site attendant / Technician bypass). Open-ticket lateral join is **not** ticket-visibility filtered (so Raise vs Update is reliable); 6-month count remains visibility-filtered.

Canonical response fields (Phase 17+): `deviceId` (Slot Id preferred), `deviceName`, `locationSite`, `slot`, `slotId`, `slotLabel`, `slotIdentifier`, `currentStatus`, `statusDate`, `ticketsLast6Months`, `openTicketId`, `openTicketAge`, `openTicketIssue`, `openTickets`, `latitude`, `longitude`, plus legacy `qr` / `qrNumber` / `parkingLocation`.

`openTickets` (Phase 50): every non-Closed ticket on the device, oldest first, as `{ id, status, assigneeId (historical only since Phase 51), age, issues: [{ id, categoryId, subCategoryId, category, sub, severity }] }` — `issues` holds only the still-Open reported issues (`loadOpenDeviceTickets`). `openTicketId` / `openTicketAge` / `openTicketIssue` describe the **worst** open ticket (the one driving `currentStatus`).

Legacy fields (`id`, `location`, `status`, `statusTone`, `facts`, `deviceUuid`, `roadId`) remain for older ScanQr clients.

No `/api/devices/:id/scan-details` path — avoids conflict with `GET /:deviceId`.

## QR sticker token → Slot MAC (Phase 33)

`POST /api/devices/slot-mac` (`authorize('Scan QR', 'v')`), body `{ "qr_token": "..." }` (also accepts `qrToken`).

Flow: require `DEVICE_SYNC_API_TOKEN` → SmartPark `POST {SMARTPARK_API_BASE_URL}/get-slot-mac` with `{ qr_token }` → match local device `LOWER(TRIM(slot_identifier)) = LOWER(TRIM(mac_id))` → return the same scan payload as `/scan`, plus `macId` / `bleMac` (and SmartPark `slotLabel` when present).

Errors: `503 DEVICE_SYNC_NOT_CONFIGURED`; `502 SLOT_MAC_UPSTREAM_ERROR`; `404 SLOT_MAC_NOT_FOUND`; `404 NOT_FOUND` if MAC resolves but no local device.

## Device coordinates

`devices.latitude` / `devices.longitude` are TEXT (migration `001_init`). Seed populates Ahmedabad-area dummy strings. Create/PATCH accept optional string coords.

## Duplicate tickets — by issue (Phase 50)

Before insert on `POST /api/tickets`, require non-empty `devices.slot_identifier`. If missing → `ApiError(400, ..., 'SLOT_IDENTIFIER_REQUIRED', { deviceId })`.

Duplicate key = **device + sub-category that is an Open reported issue on a non-Closed ticket**. Before insert, `assertNoOpenIssueConflicts` runs `findOpenIssueConflicts(deviceId, subIds)`. Any hit → `ApiError(409, ..., 'OPEN_TICKET_EXISTS', { ticketId, openTicketId, issues: [{ ticketId, id, categoryId, subCategoryId, category, sub }] })`; a mixed selection (some new, some duplicate) is rejected whole.

| Case | Result |
|------|--------|
| Issue already Open on an open ticket of this device | `409 OPEN_TICKET_EXISTS` → update that ticket |
| Different issue while other tickets are open | `201` new ticket |
| Issue only on a Closed ticket (any age) | `201` new ticket; the Closed ticket is never touched or reopened |
| Issue Resolved on a still-open ticket | `201` new ticket |

DB backstop: `ticket_issues.device_id` (copied from the ticket; a ticket's device never changes) + partial unique index `idx_ticket_issues_one_open_issue_per_device` on `ticket_issues(device_id, subcategory_id) WHERE role = 'reported' AND status = 'Open'` (migration `025`, which drops `idx_tickets_one_open_per_device` and resolves stray Open issues on Closed tickets). A concurrent same-issue raise hits the index, the whole raise transaction rolls back, and the catch re-runs the pre-check to answer the same `409` pointing at the winner. Resolving an issue removes it from the index, so a later raise of that issue succeeds.

Flow: QR → scan → `openTickets` — same problem ⇒ update that ticket via `POST /api/tickets/:id/updates`; different problem ⇒ `POST /api/tickets`. Since Phase 51 any user with `Update ticket` `e` updates that ticket directly (no assignment, no QR-specific path).

Notifications: a new ticket (even beside other open tickets) sends `ticket.raised`; a `409` or an update sends none.

## Device status with several open tickets (Phase 50)

`openTicketLateralSql(alias)` (`src/lib/device-status.ts`; the `visFilter` argument was removed in Phase 51) picks one row per device — the **worst** open ticket, ranked like `deriveDeviceStatus` (unassigned non-Minor = Not working > assigned / Under repair / Waiting for spare = Under repair > unassigned Minor = Working; ties → latest raise) — and exposes `open_ticket_count` and `first_open_at`. Used by Dashboard fleet/road stats, Device list (`derived_status`, `openTicketCount`), Device detail (status; days-down from `first_open_at`) and scan. Roads `down` = `COUNT(DISTINCT device_id)` of open tickets.

---

# Design — Ticket Status (Open, not New)

## Stored statuses

Exactly four values on `tickets.status`:

| Status | Written by |
|--------|------------|
| `Open` | `POST /api/tickets` (always, since Phase 51) |
| `Under repair` | Most site updates (before Phase 51 also raise-with-assignee and `POST /:id/assign`) |
| `Waiting for spare` | Site update `updateType === 'Waiting for spare'` |
| `Closed` | `POST /:id/close` |

There is no `New` status. Schema default is already `Open` (`001_init`). Migration `007_ticket_status_open.sql` updates any remaining `New` rows.

## “Open” vs “open ticket”

- Status **`Open`**: newly raised, no update yet.
- **Open ticket** (one-per-device / dashboard overlays): any ticket with `status <> 'Closed'` (`Open`, `Under repair`, or `Waiting for spare`).

## List UI

Since Phase 52 the tickets list tabs are `tab=open` (raised, no update yet), `tab=urp` (at least one update — Under repair, Waiting for spare, or legacy Open + assignee) and `tab=cls` (Closed). Phase 51's `open` meant every ticket not closed; the older `new` / `asg` tabs are gone and `tab=asg` → `400`. See "Design — Under repair tab and age filter (Phase 52)" at the end of this file.

List/export/tiles presentation (`listStatus` in `tickets.ts`):

- Stored `New` → `Open`
- Historical `assignee_id` and stored `Open` → list shows `Under repair` (DB unchanged; detail still returns stored status)

Badges for new tickets must render `Open`, never `New`.

---

# Design — Ticket list `daysAfterClose`

`GET /api/tickets` already returned `daysOpen` (life of the ticket until close or now). Closed rows now also return `daysAfterClose`:

```text
if closed_at set → floor((now - closed_at) / 1 day)
else → null
```

Purpose: All Tickets closed tab can show “N days since close” without the client parsing dates. (The 7-day reopen rule it once supported was removed in Phase 50 — a raise after close always creates a new ticket.)

Not added to `GET /api/tickets/:id` (detail still has “Days open” in `header.facts`). No migration.

**FRONTEND CHANGE REQUIRED:** bind closed-ticket aging to `daysAfterClose`.

---

# Design — List presentation for assigned `Open`

Some rows can have `assignee_id` set while stored `status` remains `Open` (legacy rows; since Phase 51 nothing writes `assignee_id`).

For **list, tiles, and CSV only**, `listStatus(status, assigneeId)` maps assigned + `Open` → `Under repair`, so a historically assigned ticket keeps reading as work in progress without a data migration.

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

Tickets also return `tiles` / `tabCounts` (aggregated over base filters, not only the current page). Devices return status tiles over the filtered device set **excluding** the `status` query (so Working / Under repair / Not working cards stay populated while the list is status-filtered). List rows and `pagination.total` still apply `status`.

Status-card → list contract (frontend): `GET /api/devices?status=Working|Under%20repair|Not%20working&page=1&limit=10` — same Device List API; not tickets.

### Device list ordering (Phase 41)

`deviceListQuery` sorts **Slot Label** (`devices.slot_number`) **ascending** in SQL, so the order holds on every page rather than only within a page:

```sql
ORDER BY (slot_number = ''), slot_number, public_id   -- DEVICE_LIST_ORDER_BY
```

- Blank labels sort last; `public_id` is the stable tie-break, so `LIMIT/OFFSET` paging never repeats or skips a row when two labels match.
- `slot_number` is a plain zero-padded `TEXT` (`S1-001` … `S1-010`, `S2-001`), so plain ascending text order is the expected Slot Label order — no natural-sort helper or extra dependency.
- The single constant feeds both `GET /api/devices` (paginated) and `GET /api/devices/export`, so the CSV matches the list.
- Ticket list ordering (`ORDER BY t.raised_at DESC`) is **unchanged** — the ticket list has no Slot Label column and its order is ticket chronology, used by the Open / Closed tabs.

## Tickets SQL

1. Base WHERE: `q` / road / category (no visibility or assignee filter since Phase 51)  
2. Aggregate query → tiles + tabCounts (+ `age` on the open / urp counts) + over3Counts  
3. Page WHERE = base + tab/status SQL (+ `age=over3` on open / urp)  
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
| `ticket_issues.status` (Phase 49) | `Open` \| `Resolved` + `resolved_at`, `resolved_by_user_id`, `resolved_event_id`; meaningful on `reported` rows only |
| `ticket_issues.device_id` (Phase 50) | Copy of `tickets.device_id`; backs the open-issue-per-device unique index |
| `tickets.reported_*` / `found_*` | Primary (first) issue for backward compatibility |

## API

- Raise / Update / Close: `issues: [{ categoryId, subCategoryId }, …]` preferred; legacy single pair still accepted
- Detail: `issuesReported` / `issuesFound` arrays `{ categoryId, subCategoryId, category, sub, severity }`; reported items also carry `{ id, status, resolvedAt, resolvedBy }` (Phase 49)
- Update with `issues` **replaces** found list; omit leaves found unchanged
- Update with `resolveIssueIds` resolves those Open reported issues (Phase 49); closing resolves the rest; `workHistory[].resolvedIssues` lists what each event resolved

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

# Design — Add Update: gates, auto-assign, close with update (Phase 47)

Supersedes the Phase 30 / Phase 42 gates (`assertTicketAssigned`, `visitedBy`, `NOT_ASSIGNED_USER`, "no auto-claim"), which the code no longer uses.

> **Gates 4, 5, 7 (claim / handover) and 8, the holder half of 6, `handoverToUserId` and the `assigneeId` / `autoAssigned` response fields were removed in Phase 51** — see "Main/Sub issue resolution and no assignment" at the end of this file. `closeTicket` behaviour is unchanged.

## Gates (order)

1. Auth + `authorize('Update ticket','e')`
2. Zod body
3. Ticket exists (`404 NO_TICKETS_AVAILABLE`), not Closed (`409 CLOSED`)
4. `resolveUpdateAssignee`:
   - Assigned → `assertTicketAccess` + `assertCanAddUpdate` (Admin/PM, assignee or raiser; else `403 NOT_HOLDER` / `FORBIDDEN`). The assignee is kept.
   - Unassigned + field role (`FIELD_ROLES`: Technician, Engineer, Electrician) → claim for the updater, whether or not they raised it.
   - Unassigned + Admin/PM → `handoverToUserId` required (`409 TICKET_NOT_ASSIGNED` "Select an assignee to update an unassigned ticket"), validated by `assertEligibleAssignee` (`400 INVALID_ASSIGNEE`).
   - Unassigned + other role → `assertTicketAccess`, then `409 TICKET_NOT_ASSIGNED`.
5. Field role claiming while sending `handoverToUserId` for another user → `assertCanAssignTickets` (`403`).
6. `closeTicket: true` → `Update ticket` `x` (`403 FORBIDDEN`) + `assertHolder` on the effective assignee (`403 NOT_HOLDER`).
7. Transaction: `SELECT … FOR UPDATE` re-check (`409 CLOSED` / `409 TICKET_ALREADY_ASSIGNED`), claim + `ticket_assignments`, one visit event, parts/cost, status, optional handover.
8. After commit: `ticket.assigned` notification for a claim, `ticket.reassigned` for a handover (failures logged, never fail the update).

## Request

```json
{
  "updateType": "Site visit — resolved",
  "workDone": "Replaced limit switch",
  "cost": 1000,
  "parts": ["uuid"],
  "handoverToUserId": "uuid (Admin/PM on an unassigned ticket; handover on an assigned one)",
  "closeTicket": false
}
```

`closeTicket` is optional; omitted or `false` never closes. `true` stores the visit event with `status_label = 'Closed'` and `meta = { "closedTicket": true }`, and sets `tickets.status = 'Closed'`, `closed_at = NOW()`.

## Response

Existing fields (`id`, `eventId`, `status`, `cost`, `partsCost`, `labourCost`, `parts`, `resolvedReady`) plus `assigneeId`, `autoAssigned`, `closed`.

## Resolve

Resolve = update type `Site visit — resolved` (`visit_resolved`, `resolvedReady: true`). No `Resolved` status exists; resolved keeps the ticket `Under repair` unless `closeTicket: true`.

## Roles

- **Engineer** — `013_engineer_role.sql`. **Electrician** — `022_electrician_role.sql`; both mirror Technician ticket permissions and are in `GET /api/lookups/technicians`.
- `023_field_roles_raise_ticket.sql` guarantees `Raise ticket` `v`+`c` for all three field roles.

## Frontend

**FRONTEND CHANGE REQUIRED:** allow field roles to open Add Update on an unassigned ticket (remove the client-side unassigned/not-assignee gate in `TicketUpdate.jsx`); add a Close Ticket Yes/No control defaulting to No that sends `closeTicket`; show an assignee picker for Admin/PM on unassigned tickets (send as `handoverToUserId`); toast `TICKET_ALREADY_ASSIGNED` and reload.

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

Two event families share one table but have different recipient rules.

### `ticket.raised` (unchanged)

- Recipients: Active users whose current role is `Admin`, `Project manager`, or `Control room` and whose existing `All tickets` permission has `v`
- Since Phase 51 every recipient can open every ticket, so `canOpen` is always `true` and `url` always points at `/tickets/TK-xxxx`.

### `ticket.assigned` / `ticket.reassigned` (historical — no longer created since Phase 51)

Existing rows stay listable and readable by their recipients; nothing writes new ones.

- Recipient: **only the newly assigned user**; the previous assignee is never notified
- The recipient is the assignee, so assignee-scoped ticket access always applies: `canOpen` is always `true` and `url` always points at `/tickets/TK-xxxx`
- The recipient must be Active and hold a role in `NOTIFICATION_DELIVERY_ROLES`; otherwise nothing is written and this is not an error

| Constant | Roles | Applies to |
|---|---|---|
| `NEW_TICKET_NOTIFICATION_ROLES` | Admin, Project manager, Control room | `ticket.raised` fan-out |
| `NOTIFICATION_DELIVERY_ROLES` | the above + Technician, Engineer | Web Push delivery, bell eligibility |

Field roles (Technician / Engineer / Electrician) stay in delivery so their historical assignment notifications remain readable. They never receive `ticket.raised`.

### Shared authorization rules

- API access: JWT + `authorize('All tickets', 'v')`
- No individual user IDs and no new permission screen
- Notification reads/updates always include `recipient_user_id = current user`; another user's notification returns `404`

## Ticket flow

1. `POST /api/tickets` writes the ticket and raised event.
2. Only after those writes succeed, `createNewTicketNotifications(ticketId)` resolves the actual ticket/device/issue/raiser fields.
3. Recipient rows are inserted in a notification-only transaction with `ON CONFLICT DO NOTHING`.
4. The ticket route catches and logs notification errors independently; ticket creation still returns its original success response.
5. Failed ticket creation never calls the notification service.

## Assignment flow (removed in Phase 51)

*Historical:* notifications were created from the business layer at every point where `tickets.assignee_id` actually changes, always after the owning transaction commits:

1. The assignment transaction updates `tickets`, writes the `ticket_assignments` trail, and writes the `ticket_events` row.
2. After it commits, the route calls `createTicketAssignmentNotification({ ticketId, toUserId, kind, assignedByUserId })` inside its own try/catch.
3. The service inserts one row with `ON CONFLICT DO NOTHING` and schedules background push.
4. A notification failure is logged and never rolls back or fails the assignment.

Idempotency comes from the existing unique key: assigning the same user again (or replaying the same event) cannot create a second row, and `POST /:ticketId/assign` returns early when the assignee is unchanged.

## Ticket-scoped read state

`POST /api/notifications/ticket/:ticketId/read` → `markTicketNotificationsRead(userId, ticketId)`:

```sql
UPDATE notifications
   SET read_at = NOW()
 WHERE recipient_user_id = $1
   AND related_entity_type = 'ticket'
   AND related_entity_id = $2
   AND read_at IS NULL
RETURNING id
```

- Scoped to the caller, so a user can never mark another user's row.
- Returns `{ updated }`; `0` means there was nothing unread and no row was rewritten.
- `RETURNING` is required because the PGlite pool derives `rowCount` from returned rows.
- The route is registered **before** `PATCH /:id/read` so the literal `ticket` segment is not captured by the `:id` param.

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

---

# Design — Main/Sub issue resolution and no assignment (Phase 51)

## Terms

- **Main Issue** = issue category (`issue_categories`). **Sub Issue** = sub-category (`issue_subcategories`). A ticket's reported issues are `ticket_issues` rows with `role = 'reported'`, each carrying its own Open/Resolved state (Phase 49). No schema change in this phase.

## Request (`POST /api/tickets/:id/updates`)

```json
{
  "updateType": "Site visit — not resolved",
  "visitedBy": "uuid",
  "workDone": "…",
  "resolveIssueIds": ["ticket_issues.id"],
  "resolveCategoryIds": ["issue_categories.id"],
  "addIssues": [{ "categoryId": "uuid", "subCategoryId": "uuid" }],
  "closeTicket": false
}
```

All three issue arrays are optional and deduped. `issues[]` (found-on-site replace) is still accepted for older clients; the current UI does not send it.

## Resolution semantics (`resolveIssueSelection`, `lib/ticket-issues.ts`)

1. Lock every reported row of the ticket that matches an id in `resolveIssueIds` or a category in `resolveCategoryIds` (`FOR UPDATE`).
2. Unknown / foreign / found-role issue id, or a category with no reported row on this ticket → `400 INVALID_ISSUES`.
3. An issue id that is not Open, or a category whose rows are all Resolved → `409 ISSUE_ALREADY_RESOLVED`.
4. Resolve the union of the Open rows: issue ids + every Open row of each category (already Resolved siblings are skipped, not an error). Set `status = 'Resolved'`, `resolved_at`, `resolved_by_user_id = caller`, `resolved_event_id = this update`.
5. Any error rolls back the whole update (no event, no added issues, no status change).

A concurrent second resolve of the same category waits on the ticket row lock, then finds nothing Open → `409`.

## Add issues (`appendTicketIssues`)

- Validated like raise (`resolveIssuePairs`: active category, active sub belonging to it) → `400 INVALID_ISSUES`.
- Sub already on this ticket (Open or Resolved) → `409 ISSUE_ALREADY_ON_TICKET`, `details.issues[] { id, categoryId, subCategoryId, category, sub, status }`.
- Sub Open on another non-Closed ticket of the device → `409 OPEN_TICKET_EXISTS` with the raise `details` (`ticketId`, `openTicketId`, `issues[]`); a concurrent raise that wins the partial unique index produces the same answer.
- Inserted as `role = 'reported'`, `status = 'Open'`, `device_id` from the ticket, `sort_order` after the current max — so raised issues stay first.
- Append runs before resolve inside the same transaction, so an update may add an issue and resolve it by `resolveCategoryIds`.

## Response

`{ id, eventId, status, cost, partsCost, labourCost, parts, resolvedReady, closed, addedIssues[], resolvedIssues[], openIssueCount }`. `assigneeId` / `autoAssigned` were removed.

## Status rules (unchanged)

Every visit sets `Under repair` (`Waiting for spare` for that update type). Resolving every issue does **not** close; only `closeTicket: true` (with `Update ticket` `x`) or `POST /:id/close` closes, resolving the remaining Open issues with the closing event.

## No assignment ("Every Ticket, Every Road")

| Action | Requirement |
|--------|-------------|
| See any ticket (list, detail, export, dashboard, devices, reports) | `All tickets` `v` |
| Add Update / resolve / add issues | `Update ticket` `e` |
| Close (`closeTicket` or `/close`) | `Update ticket` `x` |
| Attach photos to an event | Event author, or Admin / Project manager |
| Assign / reassign | Removed (`POST /:id/assign` → `404`) |

Removed fields: raise `assigneeId` (ignored), update `handoverToUserId`, list `assignee` filter / `assignedTo` / `actionLabel` / `actionPrimary`, detail `assigneeId` / `assignmentTrail`, update response `assigneeId` / `autoAssigned`; list tabs `new` / `asg` → `open`.

## Historical data

No migration. `tickets.assignee_id`, `ticket_assignments` and `ticket.assigned` / `ticket.reassigned` notifications stay as they are and are never written again. `listStatus`, `NOT_ATTENDED_SQL`, `deriveDeviceStatus` and `OPEN_TICKET_RANK_SQL` still treat an Open ticket with a historical assignee as "Under repair". Old `assigned` events stay in `workHistory`. Updating or closing a historically assigned ticket does not touch `assignee_id`.

## Frontend

**FRONTEND CHANGE (done, frontend Phase 51):** grouped Resolve Issues panels → `resolveCategoryIds` / `resolveIssueIds`; Add another issue → `addIssues`; every Assign / Reassign surface, the Assigned tab and the QR assignee gate removed.

---

# Design — Under repair tab and age filter (Phase 52)

## Tabs

| Tab | SQL | Meaning |
|-----|-----|---------|
| `open` | `NOT_ATTENDED_SQL` = `status IN ('Open','New') AND assignee_id IS NULL` | Raised, no update yet |
| `urp` | `UNDER_REPAIR_TAB_SQL` = `status <> 'Closed' AND NOT (NOT_ATTENDED_SQL)` | At least one update: `Under repair`, `Waiting for spare`, legacy Open + historical assignee |
| `cls` | `status = 'Closed'` | Unchanged |

The rule is status-based, not an event count: every Add Update sets `Under repair` (or `Waiting for spare`), so the stored status already says whether an update happened, and the legacy assignee rule keeps tab, pill and tiles consistent. `tabForStatus(status, assigneeId)` gives each row the same answer.

## Status within a tab

`status` is applied on top of the tab. The Under repair tab uses `All` / `Under repair` / `Waiting for spare`; Open and Closed hold one status each, so the client sends `All`. Older values (`Open + under repair`, `Open, not attended`, `Closed`) still parse.

## Age filter

`age=over3` → `status <> 'Closed' AND raised_at < NOW() - INTERVAL '3 days'` (`OVER_3_DAYS_SQL`), applied on `open` / `urp`, ignored on `cls`. The "Open over 3 days" tile spans both open tabs, so:

- `over3Counts { open, urp }` (base filters) tells the client which tab to select — Open when it has any, otherwise Under repair.
- `tabCounts.open` / `tabCounts.urp` apply `age` while it is set, so the badges show the split; `tabCounts.cls` and `tiles` never do.

## Frontend

**FRONTEND CHANGE (done, frontend Phase 52):** three tabs; cards → tab + status + age; status select only on Under Repair; sliding tab ink + panel transition.

---

# Design — Slot View (Phase 53)

## Endpoints

| Endpoint | Gate | Returns |
|----------|------|---------|
| `GET /api/slot-view?q&page&limit` | `Slot View` `v` | `data: [{ id, uuid, slotId, slotLabel, road, ticketCount }]`, `pagination` |
| `GET /api/slot-view/:slotId` | `Slot View` `v` | `data: { slot: { id, uuid, slotId, slotLabel, road }, ticketCount, unresolvedIssues[] }` |
| `GET /api/tickets?device=:slotId` | `All tickets` `v` | existing list shape, filtered to one slot; no `tab` = every status |

`id` = `deviceDisplayId` (Slot Id, else `PD-xxxx`); `:slotId` / `device` accept Slot Id, `public_id` or UUID (`deviceLookupWhere`).

## Permission

| Role | `Slot View` default |
|------|---------------------|
| Admin, Project manager | `v.....` |
| Every other role (built-in or custom) | `......` |

`SCREENS` / `DEFAULT_ROLE_PERMS` carry the defaults for seeds and new roles; migration `026_slot_view_permission.sql` back-fills existing roles. Changes made in Roles & permissions (`PATCH /api/roles/:id/permissions`) apply on the next request.

## Slot list query

```sql
SELECT d.id, d.public_id, d.slot_id, d.slot_number, r.name AS road_name,
       COUNT(t.id)::int AS ticket_count
FROM tickets t
JOIN devices d ON d.id = t.device_id
JOIN roads r ON r.id = d.road_id
[WHERE LOWER(d.slot_number) LIKE $1 OR CAST(d.slot_id AS TEXT) LIKE $1 OR LOWER(d.public_id) LIKE $1 OR LOWER(r.name) LIKE $1]
GROUP BY d.id, r.name
ORDER BY (d.slot_number = ''), <natural key>, d.slot_number, d.public_id
LIMIT $n OFFSET $m
```

- Tickets are the base table, so a device without tickets cannot appear; there is no `ticket_issues` join, so the count is tickets.
- Natural key: `string_agg` over `regexp_matches(slot_number, '[0-9]+|[^0-9]+', 'g') WITH ORDINALITY`, digit runs `lpad`-ed to 20 — `3-2` < `3-12` < `3-121`, `S1-002` < `S1-010`. Plain `slot_number` and `public_id` stay as tie-breaks.

## Unresolved issues

| Rule | Implementation |
|------|----------------|
| Only persisted Open | `loadOpenDeviceTickets` joins `ticket_issues` with `role = 'reported' AND status = 'Open'` |
| Issue = Main + Sub pair | entry keeps `categoryId` / `category` and `subCategoryId` / `sub`; Open is per Sub Issue |
| Unique per slot | `Map` keyed by `subCategoryId`; DB backstop `idx_ticket_issues_one_open_issue_per_device` |
| Ticket refs | `tickets: [{ id, uuid }]` per entry (normally one, since an Open sub lives on one ticket) |
| Closed tickets | contribute nothing — closing resolves every Open issue (Phase 49) |

## Frontend

**FRONTEND CHANGE (done, frontend Phase 53):** sidebar Slot View (after Dashboard, `Slot View` v) and a Slot View row in the Roles & permissions matrix; `/slot-view` list; `/slot-view/:slotId` with Unresolved issues (grouped by Main Issue) and Tickets (`TicketTable`, `listTickets({ device })`).
