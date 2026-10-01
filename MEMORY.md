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
- Phase 42 — Assignment/reassignment notifications (`ticket.assigned` / `ticket.reassigned`), ticket-open mark-as-read, and removal of the silent auto-claim on Add Update
- Frontend Phase 39 — NotificationBell, explicit browser permission/subscription UI, service-worker click relay, and shared Tickets/All Tickets unread badges consuming the Phase 38 APIs
- Phase 41 — Device list / export ordered by Slot Label (`slot_number`) ascending in SQL (`DEVICE_LIST_ORDER_BY`); assign eligibility deliberately unchanged (the frontend narrows the dropdown only)
- Phase 44 — Users visibility + account deletion: `src/lib/user-access.ts` (`appendUserVisibilitySql`, `assertNotLastActiveAdmin`); own account always excluded, Admin accounts hidden from non-Admin viewers; `DELETE /api/users/:id` (Users `d`, Admin only) deactivates and blocks self-delete
- Phase 45 - Project manager and Control room are not assignable ticket holders: ASSIGNABLE_ROLES in src/lib/ticket-access.ts is the single source for the assignee dropdown and 400 INVALID_ASSIGNEE
- Phase 46 - Role delete guard + user hard delete: `DELETE /api/roles/:id` (Roles & permissions d, Admin only) is refused with 409 ROLE_IN_USE while any Active or Pending account holds the role; Inactive accounts are ignored and end up role-less. Migration 021 `users_role_set_null` makes users.role_id nullable and re-points the FK to ON DELETE SET NULL; PATCH /api/users/:id then refuses status=Active on a role-less account (409 ROLE_REQUIRED) and an unknown roleId (400 ROLE_NOT_FOUND). The users list and tiles LEFT JOIN roles (COALESCE in the Admin exclusion) so role-less accounts stay visible with `roleMissing`. `DELETE /api/users/:id` is a HARD delete: one withTransaction nulls tickets.raised_by_user_id/assignee_id, ticket_events.actor_user_id, ticket_assignments.from/to_user_id, device_sync_runs.triggered_by_user_id, then deletes the row (self-delete 400, unknown 404, last Active Admin 409 LAST_ADMIN; ALREADY_INACTIVE removed). Smokes: npm run test:smoke:roles, npm run test:smoke:users
- Dashboard vs All Tickets count mismatch was smoke-fixture data, not a code bug: `test:smoke` seeds `TK-1042` as `Waiting for spare` with **no assignee**, which the app itself can no longer create (Add Update requires an assignee). That one row made the Dashboard read 17 / 5 and All Tickets 16 / 6. Fixed the fixture to unassigned `Open` (and reset the live row). Dashboard now 612 / 16 / 6 and All Tickets 6 / 16 / 0 - both pairs agree. Note the two tiles measure different things: Dashboard legend = devices (one per device, latest open ticket), All Tickets tiles = tickets.

- Phase 47 - Field roles raise + auto-assign on update + close with update: new `Electrician` role (`022`), `023` restores `Raise ticket` v+c for Technician/Engineer/Electrician, `FIELD_ROLES` single list in `lib/permissions.ts`. Add Update on an unassigned ticket: field role claims it, Admin/PM must pick via `handoverToUserId`; row-locked transaction (`TICKET_ALREADY_ASSIGNED` on lost race); optional `closeTicket` closes in the same transaction. Smoke: `npm run test:smoke:ticket-flow`
- Phase 48 - Field roles see unassigned open tickets (view only): `appendTicketVisibilitySql` adds `(t.assignee_id IS NULL AND t.status <> 'Closed')` for `FIELD_ROLES`, so All Tickets list/export, device overlays/history and Work report widen together; `GET /api/tickets/:id` uses new `assertTicketViewAccess`. Mutation paths (close, close-preview, photo attach, update on assigned) keep `assertTicketAccess`, so no action rule changed. Once assigned, the ticket leaves other field roles' view. Smoke: `test:smoke:ticket-flow` section P

## Currently Working On

- (idle - Phase 48 field-role unassigned visibility complete)

## Pending

### FRONTEND CHANGE REQUIRED (do not implement until authorized)

- Feature screens still on mocks / partial wiring
- **No backend role hierarchy on `POST` / `PATCH /api/users`:** any caller holding Users `c`/`e` (including a Project manager) can pass an Admin `roleId` on create, or promote an existing user to Admin on PATCH. `ROLE_HIERARCHY` in `frontend/src/services/users.js` filters the role dropdowns in the browser only, so the API is the weaker boundary. Deliberately out of scope for Phase 44; needs its own `assertCanAssignRole` in `lib/user-access.ts` (Admin rank 0) plus tests.
- PartMaster: Delete → `DELETE /api/parts/:id`; on `409 IN_USE` toast deactivate instead; Tech/Engineer/PM/Admin may delete unused
- IssueMaster: wire live APIs; Site attendant now has `vce..d`; add `createIssueCategory` / `createIssueSubcategory` / `deleteIssueCategory`; Delete unused → `DELETE`; used → deactivate
- Raise/Update/Close: send `issues: [{ categoryId, subCategoryId }, …]`; read `issuesReported` / `issuesFound` on detail (legacy single fields still accepted)
- DeviceList Sync: Site attendant has Device list `c` — Sync button should show for attendant
- Image zoom/crop: FE-only (no backend upload change)
- Wire Scan QR to `GET /api/devices/scan?q=`; if `openTicketId` → ticket detail / update; else raise; on raise `409 OPEN_TICKET_EXISTS` redirect via `details.openTicketId`
- Wire Sync Device to `POST /api/device-sync`; poll `GET /api/device-sync/latest` or `/:id` for status (Device list done)
- Device list road filter: reads `roads` via `GET /api/lookups/roads` (done); Road master / TicketList still on mocks
- Device status cards: call `GET /api/devices?status=Working|Under%20repair|Not%20working` (exact labels); stay on Device List — do not open Tickets
- Add Update (Phase 47): let field roles update unassigned tickets (backend assigns them); Close Ticket Yes/No default No → `closeTicket`; Admin/PM assignee picker on unassigned → `handoverToUserId`; toast `TICKET_NOT_ASSIGNED` / `TICKET_ALREADY_ASSIGNED` from `error`
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
- Users visibility is SQL-level via one helper, mirroring the ticket-access precedent: `u.id <> $me` for every role, plus `r.name <> 'Admin'` for non-Admin viewers. Tiles share the clause (own params) so counts never exceed what the caller can see
- `DELETE /api/users/:id` is a **deactivation** (`status = 'Inactive'`), never a row delete — the name must stay readable on past tickets. Gated by the existing Users `d` flag (Admin is the only seeded role with it, so no permission was granted to anyone). Self-delete → `400 SELF_DELETE_FORBIDDEN`; last-active-Admin guard is shared with `PATCH` via `assertNotLastActiveAdmin`
- The Users list still has **no pagination** parameters, so there is no page/limit bypass surface; `q` and `status` are ANDed into the same WHERE as the visibility clause
- Notification recipients: Active `Admin` / `Project manager` / `Control room` with `All tickets v`; no hardcoded user IDs and no new permission screen
- Notification APIs scope every read/update to the authenticated recipient; browser permission stays in the browser, subscription keys stay server-side
- Web Push uses `web-push` + VAPID and existing `setImmediate`; no WebSocket/SSE/queue. `404`/`410` deletes expired endpoints; `push_sent_at` prevents repeat sends
- Control Room notification links preserve existing road/ownership access; notification fan-out does not widen ticket list authorization
- Multi-issue tickets prefer `issues[]`; legacy single category/subcategory remains accepted; `ticket_issues` stores ordered reported/found rows while scalar fields retain the primary pair
- Ticket raise returns `eventId` so the frontend can attach photos through the raised-event endpoint without changing ticket creation semantics
- Add Update (Phase 47, supersedes Phase 30/42): unassigned + field role → updater becomes assignee (by user id; need not be raiser, enables QR); unassigned + Admin/PM → `handoverToUserId` required else `409 TICKET_NOT_ASSIGNED`; assigned → `assertTicketAccess` + `assertCanAddUpdate` (Admin/PM, assignee, raiser), assignee never auto-changed. `SELECT … FOR UPDATE` re-check inside the existing transaction; lost race `409 TICKET_ALREADY_ASSIGNED`. Claim fires `ticket.assigned` after commit
- Close with update: `closeTicket` optional, default false; only explicit `true` closes (needs `Update ticket` x + holder). Keeps one event per update (`status_label 'Closed'`, `meta.closedTicket`); Resolve (`Site visit — resolved`) never closes by itself; no `Resolved` status
- `FIELD_ROLES` (`lib/permissions.ts`) = Technician / Engineer / Electrician; single source for assignable roles, notification delivery, road bypass, work report actors, Visited By, issue sub-edit
- Assignment notifications: only the new assignee is notified — `ticket.assigned` on first assign / raise-with-assignee, `ticket.reassigned` on reassign / update handover. Triggered in the backend after the owning transaction commits, wrapped in its own try/catch so a notification failure never fails the assignment. No notification when the assignee is unchanged (early return + existing unique key)
- Two separate role lists, deliberately not merged: `NEW_TICKET_NOTIFICATION_ROLES` (Admin/PM/CR) governs `ticket.raised` fan-out; `NOTIFICATION_DELIVERY_ROLES` (those + Technician/Engineer) governs Web Push delivery and frontend bell eligibility — an assignee must never be un-alertable, but field staff still get no new-ticket alerts. Site attendant / AMC officer are in neither (never eligible assignees)
- Assignment notifications always set `canOpen: true` (recipient is the assignee, so assignee-scoped access applies) — unlike `ticket.raised`, where the link may be suppressed for road-scoped recipients
- Ticket-open read: `POST /api/notifications/ticket/:ticketId/read` marks the caller's unread rows for that ticket and returns `{ updated }`; `0` means nothing unread so no row is rewritten. Scoped by `recipient_user_id` so users cannot mark others' notifications. Registered before `PATCH /:id/read` so the literal `ticket` segment is not captured by `:id`
- Notification `UPDATE`s must use `RETURNING` — the PGlite pool derives `rowCount` from returned rows, so a bare `UPDATE` always reports 0 on that driver
- `assertValidVisitedBy` (currently not wired into Add Update) accepts Active `FIELD_ROLES`
- Engineer and Electrician roles: Technician-like permissions; field-work road bypass like Technician
- Work report: `FIELD_ROLES` actors (Technician/Engineer/Electrician); road filter on `rd.name`; view-shaped tickets; export filtered like `/work`
- Visit cost: `eventCost = body.cost (labour) + SUM(parts.amount)`; master amount authoritative; dedupe part IDs per event
- Parts CRUD reuses Issue master `c`/`e` (+ Technician/Engineer create/update exception); hard-delete uses Issue master `d` (Admin, PM, Technician, Engineer); list/lookups need Update ticket `v`
- Unused Part/Issue category/sub hard-delete; used → `409 IN_USE` then soft-deactivate; historical visit JSONB / ticket issue FKs untouched
- Image zoom/crop are FE-only; `POST /api/uploads` unchanged
- Ticket visibility privileged roles: only `Admin` and `Project manager`
- Other roles: `assignee_id = me OR raised_by_user_id = me` in SQL + `assertTicketAccess`; field roles additionally view unassigned non-closed tickets (Phase 48, `assertTicketViewAccess` on detail only — never on mutations)
- Same helper scopes dashboard ticket metrics, device ticket overlays/history, and work report rows
- Assign / reassign: Control room, Admin, or Project manager only; technicians cannot `/assign` or `handoverToUserId`
- Assignable **ticket-holder** roles are `ASSIGNABLE_ROLES` in `lib/ticket-access.ts` = `[...FIELD_ROLES]` = **Technician / Engineer / Electrician only**. Neither `Project manager` (routes and closes) nor `Control room` (raises and routes) may hold a ticket, and neither appears in the Hand to dropdown. One shared constant feeds both `GET /api/lookups/technicians` and `assertEligibleAssignee`; such an assignee is `400 INVALID_ASSIGNEE` and leaves the ticket unchanged. This list is deliberately **narrower than** `canAssignTickets` (Control room / Admin / PM) — holding a ticket vs performing an assign are different questions; keep them separate. Verified: all 23 assigned seeded tickets are Technician, so existing data is unaffected
- `lookups/technicians` `label` is **`Name (Role)`** and display-only (`Jignesh Solanki (Technician)`). Replaced `Name — lowercased-role[, road-when-not-"All roads"]`, which was inconsistent: road was appended only when it was not "All roads", so rows silently changed shape and a missing road could not be distinguished from "not shown". `roads` is still returned separately. `name` is the wire value for assignee filters, `id` is what assign submits — the label must never be parsed. Consumers: `TicketList` + `TicketDetail` Assign/Reassign dropdowns only; `Work report` uses `name`
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
- Device list / export order (Phase 41): Slot Label ascending via `DEVICE_LIST_ORDER_BY` (`ORDER BY (slot_number = ''), slot_number, public_id`) in `src/routes/devices.ts`; SQL-side so it survives pagination. `GET /api/lookups/technicians` still returns CR/PM because Work report Person filter needs them; the frontend Assign dropdown narrows to Technician/Engineer, and `assertEligibleAssignee` is unchanged.

## Known Issues

- Device Sync skips QR items that omit Slot Id (`slot.id`); missing MAC/QR still syncs. Existing devices are left untouched when other records fail.
- Device Sync `devicesUpdated` only counts rows whose road/label/QR/MAC actually changed vs DB; duplicate QRs resolved once per run (last Slot Id wins) so a second sync on the same feed should show Updated: 0.
- Live Device Sync requires `DEVICE_SYNC_API_TOKEN`; without it `POST /api/device-sync` returns `503 DEVICE_SYNC_NOT_CONFIGURED`.
- Ticket Detail assignment Save is still a design-preview toast until FE wires `POST …/assign`.
- `npm run test:smoke` stops at the site-attendant assertion `raiser must see Open ticket on a non-assigned road (TK-1099)` on a reused local pglite database: TK-1099 does not exist because earlier smoke runs already consumed the `public_id` sequence. Data-state issue in the ticket flow, unrelated to the Phase 41 device ordering (the new `OK devices Slot Label ascending` assertion runs before it and passes).
