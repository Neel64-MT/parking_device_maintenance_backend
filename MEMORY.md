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
- Phase 27 — Device Sync Slot/MAC validation: skip incomplete records; update MAC on existing Slot Id; no-op when unchanged; keep async `setImmediate`
- Phase 28 — Manual device edit: PATCH/create accept MAC (`slotIdentifier`) + QR (`qrNumber`); Slot Id never writable
- Phase 29 — Device Sync Slot Id only required; MAC/QR optional; update existing row when MAC/QR change for Slot Id
- Phase 30 — Add Update: require assignee; Admin or assignee only (`NOT_ASSIGNED_USER`); required `visitedBy` (Technician|Engineer); Engineer role
- Phase 31 — Work report API gap-close: road filter fix, Engineer actors, real days, view-shaped tickets, filtered export
- Phase 35 — Ticket assign harden: transactional, eligible assignee, idempotent, trail response; technicians lookup includes Engineer
- Phase 36 — Part/Issue hard delete: `DELETE /api/parts/:id` + Issue master `d` for Technician/Engineer/PM; used → `409 IN_USE` (deactivate)
- Phase 37 — Issue category gap-close: `DELETE /api/issues/categories/:id` + IN_USE; name max 120; sub create parent active check
- Phase 38 — Persistent new-ticket notifications + browser Web Push; role fan-out, unread/read APIs, VAPID subscriptions
- Phase 40 — Multi-issue ticket contract parity: `issues[]` accepted on raise/update/close, `ticket_issues` persistence, detail arrays, and raised-event photo attachment
- Frontend Phase 39 — NotificationBell, explicit browser permission/subscription UI, service-worker click relay, and shared Tickets/All Tickets unread badges consuming the Phase 38 APIs
- Phase 38 — Persistent new-ticket notifications + browser Web Push; role fan-out, unread/read APIs, VAPID subscriptions
- Phase 40 — Multi-issue ticket contract parity: `issues[]` accepted on raise/update/close, `ticket_issues` persistence, detail arrays, and raised-event photo attachment
- Frontend Phase 39 — NotificationBell, explicit browser permission/subscription UI, service-worker click relay, and shared Tickets/All Tickets unread badges consuming the Phase 38 APIs

## Currently Working On

- (idle — Phase 37 complete)
- (idle — backend Phase 38 and frontend Phase 39 notification integration complete)

## Pending

### FRONTEND CHANGE REQUIRED (do not implement until authorized)

- Feature screens still on mocks / partial wiring
- PartMaster: Delete → `DELETE /api/parts/:id`; on `409 IN_USE` toast deactivate instead; Tech/Engineer/PM/Admin may delete unused
- IssueMaster: wire live APIs; Site attendant now has `vce..d`; add `createIssueCategory` / `createIssueSubcategory` / `deleteIssueCategory`; Delete unused → `DELETE`; used → deactivate
- Raise/Update/Close: send `issues: [{ categoryId, subCategoryId }, …]`; read `issuesReported` / `issuesFound` on detail (legacy single fields still accepted)
- DeviceList Sync: Site attendant has Device list `c` — Sync button should show for attendant
- Image zoom/crop: FE-only (no backend upload change)
- Wire Scan QR to `GET /api/devices/scan?q=`; if `openTicketId` → ticket detail / update; else raise; on raise `409 OPEN_TICKET_EXISTS` redirect via `details.openTicketId`
- Wire Sync Device to `POST /api/device-sync`; poll `GET /api/device-sync/latest` or `/:id` for status (Device list done)
- Device list road filter: reads `roads` via `GET /api/lookups/roads` (done); Road master / TicketList still on mocks
- Device status cards: call `GET /api/devices?status=Working|Under%20repair|Not%20working` (exact labels); stay on Device List — do not open Tickets
- Add Update: send `visitedBy` UUID; toast `Ticket not assigned` / `This ticket is assigned to another user`; field error for Visited By; only Admin/assignee UI affordance (API enforces)
- Work report: replace `data/workReport.js` with `GET /api/reports/work`; Export → `/api/reports/work/export`; Person from lookups; gate with Work report `v`
- When wiring Dashboard / All Tickets / Devices / Work report, trust API ticket scope — no client-side role filters
- TicketList: change default `limit` from 50/100 to allowed values; use `pagination` for pager UI
- All Tickets / detail status badge: show `Open`, never `New`
- Closed tickets list: use `daysAfterClose` (null when still open)
- Trust list `status` for Assigned-tab vs Under repair tile (do not remap assigned Open in the browser)
- Hide technician reassign / handover; only Control room, Admin, Project manager assign
- Scan QR: do not treat road-mismatch as expected for Site attendant / Technician (API allows any road for scan/raise)
- Signup success copy: “Admin” → “Admin or Project manager” (optional; API already unlocks Approve for PM)
- Parts / update-ticket UI: PartChips send part UUIDs (not names); `cost` is labour-only — do not add master part prices into `cost`; show amounts from Parts/lookups APIs
- Wire Edit/Add device Save to `PATCH`/`POST /api/devices` with `slotIdentifier`, `qrNumber`, `slotNumber`, `roadId`, etc.; keep Slot Id read-only and do not rely on writing `slotId`
- Raise/Update/Close: send `issues: [{ categoryId, subCategoryId }, …]`; detail reads `issuesReported` / `issuesFound`; raised photos use the returned `eventId`

## Important Decisions

- New-ticket notifications: persistent rows created only after successful ticket/event/assignment writes; failures are logged but never change the ticket response
- Notification recipients: Active `Admin` / `Project manager` / `Control room` with `All tickets v`; no hardcoded user IDs and no new permission screen
- Notification APIs scope every read/update to the authenticated recipient; browser permission stays in the browser, subscription keys stay server-side
- Web Push uses `web-push` + VAPID and existing `setImmediate`; no WebSocket/SSE/queue. `404`/`410` deletes expired endpoints; `push_sent_at` prevents repeat sends
- Control Room notification links preserve existing road/ownership access; notification fan-out does not widen ticket list authorization
- Multi-issue tickets prefer `issues[]`; legacy single category/subcategory remains accepted; `ticket_issues` stores ordered reported/found rows while scalar fields retain the primary pair
- Ticket raise returns `eventId` so the frontend can attach photos through the raised-event endpoint without changing ticket creation semantics
- Add Update: require `assignee_id`; only Admin or assignee; `NOT_ASSIGNED_USER` for others (QR user B); no auto-claim; no `assertTicketAccess` on this path (clear toast)
- `visitedBy` required on Add Update; Active Technician or Engineer; stored in `ticket_events.meta`
- Engineer role: Technician-like permissions; eligible Visited By; field-work road bypass like Technician
- Work report: Technician+Engineer actors; road filter on `rd.name`; view-shaped tickets; export filtered like `/work`
- Visit cost: `eventCost = body.cost (labour) + SUM(parts.amount)`; master amount authoritative; dedupe part IDs per event
- Parts CRUD reuses Issue master `c`/`e` (+ Technician/Engineer create/update exception); hard-delete uses Issue master `d` (Admin, PM, Technician, Engineer); list/lookups need Update ticket `v`
- Unused Part/Issue category/sub hard-delete; used → `409 IN_USE` then soft-deactivate; historical visit JSONB / ticket issue FKs untouched
- Image zoom/crop are FE-only; `POST /api/uploads` unchanged
- Ticket visibility privileged roles: only `Admin` and `Project manager`
- Other roles: `assignee_id = me OR raised_by_user_id = me` in SQL + `assertTicketAccess`
- Same helper scopes dashboard ticket metrics, device ticket overlays/history, and work report rows
- Assign / reassign: Control room, Admin, or Project manager only; technicians cannot `/assign` or `handoverToUserId`
- Assign stays road-only (`assertRoadAccess`) for Control room routing; list/detail/dashboard/reports stay visibility-scoped
- Device list / export / history are city-wide (no `assigned_roads` filter); open-ticket overlays stay ticket-visibility scoped; create/PATCH keep `assertRoadAccess`; scan + raise use `assertRoadAccessUnlessFieldWork` (Site attendant / Technician / Engineer)
- Raise / Update / Close tickets accept `issues: [{ categoryId, subCategoryId }, …]` (legacy single `categoryId`/`subCategoryId` still works); persisted in `ticket_issues` with scalar primary for compat
- Site attendant: city-wide scan/raise; Device Sync + Issue master CRUD; Technician/Engineer: city-wide scan; Add Update = Admin or assignee only
- Scan details stay on `GET /api/devices/scan?q=` (no `/scan-details` alias); scan `openTicketId` is not ticket-visibility filtered
- One open ticket per device means `status <> 'Closed'`; unassigned stored status is `Open` (not `New`); DB partial unique index `idx_tickets_one_open_per_device` (migration `012`); Slot Id uniqueness follows via unique `devices.slot_id`
- List tab `new` = unassigned non-closed; list may show assigned+`Open` as `Under repair` without DB update
- Ticket list `daysAfterClose` is days since `closed_at` (`null` if open); list-only
- List pagination: `page`/`limit`, default limit **10**, allowed **10|25|50|100**, SQL LIMIT/OFFSET after scope/filters; shared `src/lib/pagination.ts`
- Pagination response shape stays `{ page, limit, total, totalPages }` (no hasNextPage)
- Device Sync unique keys: **Slot Id (`slot_id`)** is primary and immutable after first write; roads by `external_location_id` then `LOWER(name)`; QR/`mac_address` may change on re-sync for the same slot
- Slot Identifier comes from SmartPark `mac_address` → `devices.slot_identifier` (optional on sync; null does not wipe existing); manual create/PATCH may also set/update MAC + QR; Slot Id never writable manually
- Raise ticket requires non-empty Slot Identifier → `400` / `SLOT_IDENTIFIER_REQUIRED` if missing
- Technician / Engineer have Device list `c` (migration `014`) so they can `POST /api/device-sync`; Add device remains separate/denied
- Ticket/device APIs prefer Slot Id over `public_id` for `deviceId` / list `id` display and links
- Device `:deviceId` lookup is dual-key (`deviceLookupWhere`: `public_id` | UUID | `slot_id` text); smoke covers Slot Id path (in-process `UPDATE` on a seeded device) plus PD-xxxx when `slot_id` is null; create/PATCH responses map `id` via `deviceDisplayId`
- Device Sync auth to SmartPark: `Authorization: Bearer` via `DEVICE_SYNC_API_TOKEN`; also `Accept: application/json`, `Cache-Control: no-cache`; locations path `/locations`
- QR sticker token: `POST /api/devices/slot-mac` → SmartPark `get-slot-mac` → local match on `slot_identifier` = `mac_id` → scan-shaped response; reuse same token; `SMARTPARK_API_BASE_URL` optional
- Device Sync pagination: `per_page=50`, pages from `data.pagination.last_page` (fallback `ceil(summary.total / per_page)`); background via `setImmediate` + `device_sync_runs`
- Duplicate raise 409 includes both `ticketId` and `openTicketId`
- Device lat/lng are TEXT strings; seed includes Ahmedabad-area dummies
- PM Users permission: `vce...` (approve Pending via existing PATCH); Roles matrix remains view-only
- No separate signup-request table
- Control room is scoped like other non-privileged roles for viewing (per product requirement)
- Ticket assign (Phase 35): transactional `POST …/assign`; eligible Active Technician/Engineer/CR/PM; idempotent same assignee; response `{ id, assigneeId, assigneeName, assignmentTrail }`; detail trail from `ticket_assignments`; lookups/technicians includes Engineer
- FRONTEND CHANGE REQUIRED: TicketDetail Save → `POST /api/tickets/:id/assign`; Hand to → `GET /api/lookups/technicians`

## Known Issues

- Device Sync skips QR items that omit Slot Id (`slot.id`); missing MAC/QR still syncs. Existing devices are left untouched when other records fail.
- Device Sync `devicesUpdated` only counts rows whose road/label/QR/MAC actually changed vs DB; duplicate QRs resolved once per run (last Slot Id wins) so a second sync on the same feed should show Updated: 0.
- Live Device Sync requires `DEVICE_SYNC_API_TOKEN`; without it `POST /api/device-sync` returns `503 DEVICE_SYNC_NOT_CONFIGURED`.
- Ticket Detail assignment Save is still a design-preview toast until FE wires `POST …/assign`.
