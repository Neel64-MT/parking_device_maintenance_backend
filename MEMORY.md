# Memory — Implementation State

## Completed

- Phase 0–11 — foundation through forgot-password / password_version
- Phase 12 — Ticket visibility (assignee/raiser) + Project manager Users `vce...` for signup approval
- Phase 13 — Role-based ticket scope consistency: dashboard (already), devices open-ticket/history, work report reuse `ticket-access.ts`
- Phase 17 — QR scan canonical payload + seed lat/lng + `OPEN_TICKET_EXISTS.openTicketId`
- Phase 18 — Ticket status `New` removed; unassigned tickets use `Open` (`007_ticket_status_open.sql`)
- Phase 19 — Assign/reassign restricted to Control room, Admin, Project manager (no technician handover)
- Phase 20 — Ticket list `daysAfterClose` + tab `new` = unassigned only; list presents assigned+`Open` as `Under repair`
- Phase 21 — DB-level pagination for tickets + devices (`page`/`limit`, default 10, allowed 10/25/50/100)
- Phase 22 — Parts master `amount` + visit cost = labour `cost` + sum(master part amounts); `ticket_event_parts` + JSONB snapshot
- Forgot/reset password role gate — Admin / Project manager only; other Active roles `403 FORGOT_PASSWORD_ROLE_DENIED`; unknown email stays generic 200
- Phase 23 — Device Sync: async SmartPark locations→roads + QR pages→devices; `010_device_sync.sql`; `POST /api/device-sync`
- Phase 24 — QR raise harden: one-open partial unique index; scan `openTicketId` unfiltered by ticket visibility; raise unique-violation → `OPEN_TICKET_EXISTS`
- Phase 25 — Field-work road bypass: Site attendant / Technician scan + raise any road; tech update still holder/raiser-only
- Phase 26 — Device status-card filter: reuse `GET /api/devices?status=`; enum validation; tiles stable without status in tile WHERE

## Currently Working On

- (idle — Phase 26 complete)

## Pending

### FRONTEND CHANGE REQUIRED (do not implement until authorized)

- Feature screens still on mocks / partial wiring
- Wire Scan QR to `GET /api/devices/scan?q=`; if `openTicketId` → ticket detail / update; else raise; on raise `409 OPEN_TICKET_EXISTS` redirect via `details.openTicketId`
- Wire Sync Device to `POST /api/device-sync`; poll `GET /api/device-sync/latest` or `/:id` for status (Device list done)
- Device list road filter: reads `roads` via `GET /api/lookups/roads` (done); Road master / TicketList still on mocks
- Device status cards: call `GET /api/devices?status=Working|Under%20repair|Not%20working` (exact labels); stay on Device List — do not open Tickets
- When wiring Dashboard / All Tickets / Devices / Work report, trust API ticket scope — no client-side role filters
- TicketList: change default `limit` from 50/100 to allowed values; use `pagination` for pager UI
- All Tickets / detail status badge: show `Open`, never `New`
- Closed tickets list: use `daysAfterClose` (null when still open)
- Trust list `status` for Assigned-tab vs Under repair tile (do not remap assigned Open in the browser)
- Hide technician reassign / handover; only Control room, Admin, Project manager assign
- Scan QR: do not treat road-mismatch as expected for Site attendant / Technician (API allows any road for scan/raise)
- Signup success copy: “Admin” → “Admin or Project manager” (optional; API already unlocks Approve for PM)
- Parts / update-ticket UI: PartChips send part UUIDs (not names); `cost` is labour-only — do not add master part prices into `cost`; show amounts from Parts/lookups APIs

## Important Decisions

- Visit cost: `eventCost = body.cost (labour) + SUM(parts.amount)`; master amount authoritative; dedupe part IDs per event
- Parts CRUD reuses Issue master `c`/`e` (no new permission screen); list/lookups need Update ticket `v`
- Ticket visibility privileged roles: only `Admin` and `Project manager`
- Other roles: `assignee_id = me OR raised_by_user_id = me` in SQL + `assertTicketAccess`
- Same helper scopes dashboard ticket metrics, device ticket overlays/history, and work report rows
- Assign / reassign: Control room, Admin, or Project manager only; technicians cannot `/assign` or `handoverToUserId`
- Assign stays road-only (`assertRoadAccess`) for Control room routing; list/detail/dashboard/reports stay visibility-scoped
- Device list / export / history are city-wide (no `assigned_roads` filter); open-ticket overlays stay ticket-visibility scoped; create/PATCH keep `assertRoadAccess`; scan + raise use `assertRoadAccessUnlessFieldWork` (Site attendant / Technician)
- Site attendant: city-wide scan/raise; Technician: city-wide scan; update/close remain holder/raiser-only (any road)
- Scan details stay on `GET /api/devices/scan?q=` (no `/scan-details` alias); scan `openTicketId` is not ticket-visibility filtered
- One open ticket per device means `status <> 'Closed'`; unassigned stored status is `Open` (not `New`); DB partial unique index `idx_tickets_one_open_per_device` (migration `012`); Slot Id uniqueness follows via unique `devices.slot_id`
- List tab `new` = unassigned non-closed; list may show assigned+`Open` as `Under repair` without DB update
- Ticket list `daysAfterClose` is days since `closed_at` (`null` if open); list-only
- List pagination: `page`/`limit`, default limit **10**, allowed **10|25|50|100**, SQL LIMIT/OFFSET after scope/filters; shared `src/lib/pagination.ts`
- Pagination response shape stays `{ page, limit, total, totalPages }` (no hasNextPage)
- Device Sync unique keys: **Slot Id (`slot_id`)** is primary and immutable after first write; roads by `external_location_id` then `LOWER(name)`; QR/`mac_address` may change on re-sync for the same slot
- Slot Identifier comes from SmartPark `mac_address` → `devices.slot_identifier` (updatable)
- Ticket/device APIs prefer Slot Id over `public_id` for `deviceId` / list `id` display and links
- Device `:deviceId` lookup is dual-key (`deviceLookupWhere`: `public_id` | UUID | `slot_id` text); smoke covers Slot Id path (in-process `UPDATE` on a seeded device) plus PD-xxxx when `slot_id` is null; create/PATCH responses map `id` via `deviceDisplayId`
- Device Sync auth to SmartPark: `Authorization: Bearer` via `DEVICE_SYNC_API_TOKEN`; also `Accept: application/json`, `Cache-Control: no-cache`; locations path `/locations`
- Device Sync pagination: `per_page=50`, pages from `data.pagination.last_page` (fallback `ceil(summary.total / per_page)`); background via `setImmediate` + `device_sync_runs`
- Duplicate raise 409 includes both `ticketId` and `openTicketId`
- Device lat/lng are TEXT strings; seed includes Ahmedabad-area dummies
- PM Users permission: `vce...` (approve Pending via existing PATCH); Roles matrix remains view-only
- No separate signup-request table
- Control room is scoped like other non-privileged roles for viewing (per product requirement)

## Known Issues

- Device Sync Slot Identifier is sourced from external `mac_address` (nullable only when the QR item omits it).
- Live Device Sync requires `DEVICE_SYNC_API_TOKEN`; without it `POST /api/device-sync` returns `503 DEVICE_SYNC_NOT_CONFIGURED`.
