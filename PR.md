# Project Requirements — Parking Device Maintenance API

## What to build

A Node.js + Express + TypeScript REST API that backs the existing React design-preview frontend for **AMC flap-based parking device maintenance** (~1,000 devices across 5 Ahmedabad roads).

The frontend remains **unchanged unless explicitly authorized**. The API supplies every screen’s data and mutations so the UI can be wired later without redesign.

## Target Users

| Role | Purpose |
|------|---------|
| Admin | Full control including users and masters |
| Project manager | City-wide ops; can approve Pending signups and manage users (Users `vce...`); cannot delete masters |
| Control room | Raise and route tickets; does not close or edit masters |
| Technician | Scan any road; update/close tickets they hold or raised (any road); list assignee/raiser-scoped |
| Site attendant | Scan QR and raise tickets on any road; list raiser-scoped |
| AMC officer | View-only everywhere |
| Custom roles | Created via Roles & permissions UI |

**Login:** Email or 10-digit mobile plus password. Self-signup creates `Pending` users (Site attendant) until Admin or Project manager approves via Users.

## Features (API-backed)

1. **Authentication** — Email or mobile + password, JWT session, logout, current user (`/me`), forgot password, reset password
2. **Authorization** — Screen × flag matrix (`v c e a x d`), road scope, ticket holder rules
3. **Dashboard** — Fleet status, down reasons, road-wise status, oldest open tickets
4. **Tickets** — List (tabs/filters), raise, detail, assign, site-update, close; one non-`Closed` ticket per device (`409 OPEN_TICKET_EXISTS` with `openTicketId`); 7-day reopen = same ticket. List rows include `daysOpen` and `daysAfterClose` (whole days since `closed_at`, or `null` if still open). **Pagination:** `page`/`limit` with default `page=1`, `limit=10`; allowed limits `10|25|50|100`; DB `LIMIT`/`OFFSET` after visibility + filters; response `pagination: { page, limit, total, totalPages }`. **Statuses:** `Open`, `Under repair`, `Waiting for spare`, `Closed` (no `New`). **Visibility:** Admin and Project manager see all (within road scope). All other roles see only tickets where `assignee_id` or `raised_by_user_id` is the current user (enforced in SQL and on detail/mutations).
5. **Devices** — List, add, history, QR scan/lookup (`GET /api/devices/scan?q=`), QR label PNG, export; optional `latitude` / `longitude` (TEXT). **List / export / history are city-wide** for every role with Device list/history view (not filtered by `assigned_roads`). Open-ticket overlays on list/history remain ticket-visibility scoped. Create/PATCH keep `assertRoadAccess`. Scan and ticket raise use `assertRoadAccessUnlessFieldWork` (Site attendant / Technician bypass). **Pagination:** same `page`/`limit` rules as tickets (DB-level after status/repeats filters). **Device Sync** — `POST /api/device-sync` starts an async import from SmartPark (locations → roads, then QR pages → devices); poll `GET /api/device-sync/:id` or `/latest` for `started` / `completed` / `failed`.
6. **Issue master** — Categories / sub-categories with severity; deactivate if used (no hard delete when used)
7. **Parts master** — Active parts with `amount` (`NUMERIC(12,2)`); list/lookups return `{ id, name, amount }`; create/patch via `/api/parts` using Issue master `c`/`e`
8. **Road master** — CRUD roads; sequential `RD-xx` codes
9. **Users & roles** — Create/edit/inactivate users; Admin and Project manager may approve Pending signups, update details/role/password via `PATCH /api/users/:id`; role permission matrix; never hard-delete users
10. **Work report** — Day/week/month/range technician load and outcomes
11. **Lookups** — Roads, technicians, parts (with amount), issue categories, road slots
12. **Uploads** — Multipart photos for tickets/devices
13. **Exports** — CSV for tickets, devices, roads, work report

### QR scan & raise-ticket requirements

- After scanning a QR / device code, clients call `GET /api/devices/scan?q={identifier}` (canonical scan-details API; no separate `/scan-details` path).
- Scan response includes: `deviceId` (Slot Id preferred), `deviceName`, `locationSite`, `slot`, `slotId`, `slotLabel`, `slotIdentifier`, `currentStatus`, `statusDate`, `ticketsLast6Months`, `openTicketId`, `openTicketAge`, `openTicketIssue`, `latitude`, `longitude` (plus legacy fields for older clients).
- Branch: `openTicketId` set → open that ticket and use `POST /api/tickets/:id/updates`; else `POST /api/tickets` with scan `deviceId` / `deviceUuid` / `publicId` (not QR alone).
- A device (and thus its Slot Id when set) may have at most one non-`Closed` ticket. Raising another returns `409` / `OPEN_TICKET_EXISTS` with `details.openTicketId` (and `ticketId`). Enforced by app pre-check + DB unique index `012_one_open_ticket_per_device.sql`.
- Scan `openTicketId` is not ticket-list visibility filtered (Raise vs Update must be reliable for any role with Scan QR; Site attendant / Technician need no road match).
- Device coordinates are optional TEXT on create/PATCH; seed includes Ahmedabad-area dummy values.

### Device Sync requirements

- Frontend **Sync Device** calls `POST /api/device-sync` (JWT + `authorize('Device list', 'c')`).
- Handler returns **202** immediately with a sync run (`started`); work continues in the background (non-blocking).
- Flow: fetch SmartPark `/locations` → insert new `roads` only → then page QR codes (`status=all`, `per_page=50`) using `data.summary.total` / `data.pagination.last_page` → create/update devices by `qr_code` = external `qr_number`.
- Device columns: Slot Id (`slot_id`, **stable** — never overwritten after first sync), Slot Label (`slot_number`), Slot Identifier (`slot_identifier` ← external `mac_address`, may change on hardware swap), QR Number (`qr_code`, may change), Parking Location (`road_id` → roads). Device `public_id` remains internal/DB-only for uniqueness; APIs prefer Slot Id for display and links.
- Tickets list/detail/dashboard/reports expose `deviceId` as **Slot Id** (fallback to `public_id` only for legacy seed rows without `slot_id`).
- Device history `GET /api/devices/:deviceId` resolves by `public_id`, UUID, or Slot Id text; response `header.id` prefers Slot Id. Devices CSV “Device ID” column uses the same display rule. Create/PATCH device responses expose `id` (Slot Id preferred), `publicId`, and `slotId`.
- Acceptance (smoke): list/detail `deviceId` equals `slot_id` when present; `GET /api/devices/{slotId}` returns 200; legacy `GET /api/devices/PD-xxxx` still works when `slot_id` is null; PATCH by Slot Id + create without `slot_id` return mapped ids.
- Idempotent: re-running sync does not duplicate roads/devices; updates existing devices’ sync fields only.
- Status: `GET /api/device-sync/:id` and `GET /api/device-sync/latest` (`started` | `completed` | `failed`).
- Config: `DEVICE_SYNC_BASE_URL`, `DEVICE_SYNC_API_TOKEN` (sent as `Authorization: Bearer …` with `Accept: application/json` and `Cache-Control: no-cache`). Locations path: `/locations`.
- Synced locations upsert into `roads` (single source of truth). Existing `GET /api/roads` / `GET /api/lookups/roads` already return them — no sync-specific road API.

**FRONTEND:** Device list road filter reads `GET /api/lookups/roads` (same `roads` table) and refetches after sync. **Still FRONTEND CHANGE REQUIRED:** Road master / TicketList mocks → `/api/roads` or lookups when authorized.

### Ticket status requirements

Canonical `tickets.status` values (exactly four; never `New`):

| Status | When |
|--------|------|
| `Open` | Raised without an assignee |
| `Under repair` | Assigned at raise, or after assign / site update |
| `Waiting for spare` | Technician update type is waiting for spare |
| `Closed` | Ticket closed |

- Unassigned raise writes `Open` (not `New`).
- List tab key `new` is UI-only: **unassigned and not closed** (not a stored status). Tab `asg` = has assignee; `cls` = Closed.
- List/export/tiles presentation: if a ticket has an assignee but stored status is still `Open`/`New`, list `status` is shown as `Under repair` (DB row unchanged). Detail API still returns stored status (normalized `New` → `Open`).
- “One open ticket” means `status <> 'Closed'`, not status `Open` only.
- Existing `New` rows migrated to `Open` (`007_ticket_status_open.sql`).

**FRONTEND CHANGE REQUIRED:** All Tickets / detail badges must show `Open`, not `New`. Closed-tab aging can use list field `daysAfterClose` (do not recompute from dates in the browser unless needed). Trust list `status` for Assigned-tab pills vs Under repair tile alignment.

### Ticket visibility requirements

- Admin and Project manager retain city-wide ticket list/detail/export access.
- Every other role may only access tickets assigned to them or raised by them.
- Restrictions are enforced server-side on ticket list, export, detail, update, and close.
- The same visibility scope applies to dashboard ticket metrics, device open-ticket overlays/history counts, and work report ticket rows/export.
- Assign (`POST /api/tickets/:id/assign`) is **Control room, Admin, or Project manager only**. Technicians cannot assign, reassign, or handover. Assign is road-scoped so Control room can route tickets they did not raise.
- Frontend role filtering is presentation only; never the security boundary.

### Ticket list aging fields

- `GET /api/tickets` each row: `daysOpen` (raised → closed or now) and `daysAfterClose` (now → `closed_at`, or `null` if not closed).
- `daysAfterClose` is list-only (not ticket detail). Supports the 7-day reopen rule in the UI.
- List tiles (`underRepair`, `waitingSpare`, `openOver3`) and CSV export use the same list presentation status rules as row `status`.

### List pagination requirements

- `GET /api/tickets` and `GET /api/devices` paginate at the database (`LIMIT`/`OFFSET` + `COUNT`), never by loading all rows into memory.
- Defaults when omitted: `page=1`, `limit=10`.
- Allowed `limit` values only: `10`, `25`, `50`, `100` (others → Zod 400).
- Response keeps `pagination: { page, limit, total, totalPages }` (no duplicate `hasNextPage` fields).
- Ticket `total` / pages respect visibility (Admin/PM all; others assignee/raiser) after search/filters.
- Users/Roads lists remain unpaginated (no table consumer yet).

**FRONTEND CHANGE REQUIRED:** TicketList service default `limit` is still 50 and UI hardcodes 100 — align to allowed limits and use `pagination` for a pager when authorized.

### Parts master & visit cost

- `parts.amount` is authoritative; seed and CRUD set prices.
- Ticket update/close accept `parts: uuid[]` and labour-only `cost`. Server computes `eventCost = labourCost + SUM(selected active part amounts)` (dedupe IDs), stores JSONB snapshot `[{ id, name, amount }]` plus `ticket_event_parts`, and adds `eventCost` to `tickets.total_cost`.
- Client-supplied part prices are ignored; unknown/inactive part IDs → `400` / `INVALID_PARTS`.

**FRONTEND CHANGE REQUIRED:** PartChips must send part UUIDs (not names). The update/close `cost` field must be labour / non-part charges only — do not pre-add part prices into `cost`.

### Signup approval requirements

- `POST /api/auth/signup` creates `Pending` users.
- Admin or Project manager can list Pending users, update details/role, and set `status: Active` to approve.
- Normal users cannot call Users create/edit APIs.

### Password security requirements

- Forgot password must not reveal whether an email exists (generic success message).
- Reset tokens are short-lived, one-time, stored hashed only; never returned in API responses or logs.
- Password hashing uses the same bcrypt helper as login/user create.
- Admin password changes require server-side `authorize('Users', 'e')` (not frontend role checks).
- After any password change (reset or admin), outstanding JWTs issued before `password_changed_at` are rejected.

## Database

PostgreSQL via discrete env vars: `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME`.

## Out of scope (v1)

- Device telemetry / auto “no data 24 hrs” ticket generation (enum value only)
- Modifying the React frontend (unless user authorizes)
- Real SMS provider for ticket alerts (auth is email/mobile + password)

## Conflicts / later UI work

**FRONTEND CHANGE REQUIRED** — most feature screens still use `frontend/src/data/*` mocks. Wire later to:

| Screen | API |
|--------|-----|
| Dashboard | `GET /api/dashboard` |
| Tickets | `/api/tickets*` |
| Devices | `/api/devices*`, especially `GET /api/devices/scan?q=`; Sync Device → `POST /api/device-sync` + status poll |
| Roads | `/api/roads*` |
| Issue master | `/api/issues*` |
| Users / roles | `/api/users*`, `/api/roles*` |
| Work report | `/api/reports/work*` |
| Uploads | `POST /api/uploads` |

| Auth login page may already proxy to the backend; feature screens still need full API integration. Ticket/device detail pages historically ignored URL params in the design preview.

**Also FRONTEND CHANGE REQUIRED for password flows:**

| UI | Wire to |
|----|---------|
| Login “Forgot password?” link | `/forgot-password` page |
| Forgot password form | `POST /api/auth/forgot-password` |
| Reset password page (`?token=`) | `POST /api/auth/reset-password` |
| Users Add/Edit password field | `POST/PATCH /api/users` (password already supported) |
