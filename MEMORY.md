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
- Dashboard vs All Tickets count mismatch was smoke-fixture data, not a code bug: `test:smoke` seeds `TK-1042` as `Waiting for spare` with **no assignee**, which the app itself can no longer create (Add Update requires an assignee). That one row made the Dashboard read 17 / 5 and All Tickets 16 / 6. Fixed the fixture to unassigned `Open` (and reset the live row). Dashboard now 612 / 16 / 6 and All Tickets 6 / 16 / 0 - both pairs agree. Note the two tiles measure different things: Dashboard legend = devices (one per device, worst open ticket since Phase 50), All Tickets tiles = tickets.

- Phase 47 - Field roles raise + auto-assign on update + close with update: new `Electrician` role (`022`), `023` restores `Raise ticket` v+c for Technician/Engineer/Electrician, `FIELD_ROLES` single list in `lib/permissions.ts`. Add Update on an unassigned ticket: field role claims it, Admin/PM must pick via `handoverToUserId`; row-locked transaction (`TICKET_ALREADY_ASSIGNED` on lost race); optional `closeTicket` closes in the same transaction. Smoke: `npm run test:smoke:ticket-flow`
- Phase 48 - Field roles see unassigned open tickets (view only): `appendTicketVisibilitySql` adds `(t.assignee_id IS NULL AND t.status <> 'Closed')` for `FIELD_ROLES`, so All Tickets list/export, device overlays/history and Work report widen together; `GET /api/tickets/:id` uses new `assertTicketViewAccess`. Mutation paths (close, close-preview, photo attach, update on assigned) keep `assertTicketAccess`, so no action rule changed. Once assigned, the ticket leaves other field roles' view. Smoke: `test:smoke:ticket-flow` section P
- Phase 49 - Per-issue Open/Resolved: migration `024` adds `status` / `resolved_at` / `resolved_by_user_id` / `resolved_event_id` to `ticket_issues` (reported rows only). Add Update `resolveIssueIds[]` resolved inside the existing locked transaction via `resolveTicketIssues` (`400 INVALID_ISSUES`, `409 ISSUE_ALREADY_RESOLVED`); both close paths resolve the rest via `resolveOpenTicketIssues`; detail `issuesReported[].id/status`, `workHistory[].resolvedIssues`; dashboard `downReasons` counts Open reported issues + `openIssues` / `openTicketsCount`. Smoke: `npm run test:smoke:issue-resolution`
- Phase 50 - Issue-level duplicate tickets: duplicate key = device + Open reported issue (not device). Migration `025` adds `ticket_issues.device_id`, resolves stray Open issues on Closed tickets, drops `idx_tickets_one_open_per_device`, adds partial unique `idx_ticket_issues_one_open_issue_per_device`. Raise: `assertNoOpenIssueConflicts` → `409 OPEN_TICKET_EXISTS` + `details.issues[]`; different issue / issue only on a Closed ticket / issue Resolved on an open ticket → new ticket; 7-day `REOPEN_SAME_TICKET` removed. Scan adds `openTickets[]` (`loadOpenDeviceTickets`); device status everywhere = worst open ticket via `openTicketLateralSql`; device list `openTicketCount`; roads `down` = distinct devices. Smoke: `npm run test:smoke:multi-ticket`
- Phase 51 - Main/Sub issue resolution + no ticket assignment: Add Update `resolveCategoryIds[]` (Main Issue → all its Open subs) beside `resolveIssueIds[]` via `resolveIssueSelection`; `addIssues[]` appended Open by `appendTicketIssues` (`409 ISSUE_ALREADY_ON_TICKET` / `OPEN_TICKET_EXISTS`); response `addedIssues[]`. Assignment removed end to end: `POST /:id/assign` deleted (404), raise ignores `assigneeId`, no auto-claim / handover / holder / `ticket_assignments` writes / assignment notifications; every `All tickets v` user sees every ticket; `Update ticket e` updates any open ticket, `x` closes; photo attach = author or Admin/PM; list tabs `open` / `cls`. No migration; historical assignee data untouched (legacy Under repair display kept). Smoke: `npm run test:smoke:issue-groups`, `npm run test:smoke:no-assignment`
- Phase 52 - Under repair tab: list tabs `open` (raised, no update — `NOT_ATTENDED_SQL`) / `urp` (at least one update — `UNDER_REPAIR_TAB_SQL`, incl. Waiting for spare + legacy Open + assignee) / `cls`; `tabForStatus(status, assigneeId)`; `status` narrows within the tab; optional `age=over3` on open / urp; response `tabCounts { open, urp, cls }` (open / urp respect `age`) + `over3Counts { open, urp }`; tiles unchanged. Smoke: `npm run test:smoke:no-assignment` (Phase 52 block)

- Phase 53 - Slot View: `src/routes/slot-view.ts` at `/api/slot-view` (own screen `Slot View v`; defaults Admin + Project manager only, migration `026_slot_view_permission.sql`, managed per role in Roles & permissions). `GET /` = ticketed slots only (tickets base table, `GROUP BY` device, `ticketCount` per ticket, natural Slot Label order, SQL pagination, `q`); `GET /:slotId` = slot header + `ticketCount` + `unresolvedIssues` (Open reported Sub Issues via `loadOpenDeviceTickets`, one per `subCategoryId`, with their tickets; 404 unknown slot). `GET /api/tickets?device=` lists one slot's tickets (all statuses without `tab`). `slotLabelOrderBy(alias, { natural })` in `lib/device-ref.ts`. Smoke: `npm run test:smoke:slot-view`

- Phase 54 - Notification preferences: migration `027_user_notification_preferences.sql` adds `users.push_notifications_enabled` / `play_notification_sound` (`BOOLEAN NOT NULL DEFAULT TRUE`). `loadAuthUser` reads both and `toClientUser` returns `notificationPreferences` on login / `/me`. `PATCH /api/auth/me/notification-preferences` (own user, strict Zod, `COALESCE` partial update) returns the client user. `deliverNotificationPush` filters `u.push_notifications_enabled = TRUE` in its single JOIN and sends `notification.silent = !play_notification_sound` + `data.playSound`. Smoke: `npm run test:smoke:notification-prefs`

## Currently Working On

- (idle - Phase 54 notification preferences complete; edited `src/db/migrations/027_user_notification_preferences.sql`, `src/middleware/auth.ts`, `src/routes/auth.ts`, `src/lib/notifications.ts`, `src/types/api.ts`, `scripts/smoke-notification-preferences.ts`, `package.json`)

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
- Work report: replace `data/workReport.js` with `GET /api/reports/work`; Export → `/api/reports/work/export`; Person from lookups; gate with Work report `v`
- When wiring Dashboard / All Tickets / Devices / Work report, trust the API — no client-side role or assignee filters
- TicketList: change default `limit` from 50/100 to allowed values; use `pagination` for pager UI
- All Tickets / detail status badge: show `Open`, never `New`
- Closed tickets list: use `daysAfterClose` (null when still open)
- Trust list `status` (do not remap historical assigned Open in the browser)
- Scan QR: do not treat road-mismatch as expected for Site attendant / Technician (API allows any road for scan/raise)
- Signup success copy: “Admin” → “Admin or Project manager” (optional; API already unlocks Approve for PM)
- Parts / update-ticket UI: PartChips send part UUIDs (not names); `cost` is labour-only — do not add master part prices into `cost`; show amounts from Parts/lookups APIs
- Wire Edit/Add device Save to `PATCH`/`POST /api/devices` with `slotIdentifier`, `qrNumber`, `slotNumber`, `roadId`, etc.; keep Slot Id read-only and do not rely on writing `slotId`
- Raise/Update/Close: send `issues: [{ categoryId, subCategoryId }, …]`; detail reads `issuesReported` / `issuesFound`; raised photos use the returned `eventId`

## Important Decisions

- New-ticket notifications: persistent rows created only after successful ticket/event writes; failures are logged but never change the ticket response
- Users visibility is SQL-level via one helper, mirroring the ticket-access precedent: `u.id <> $me` for every role, plus `r.name <> 'Admin'` for non-Admin viewers. Tiles share the clause (own params) so counts never exceed what the caller can see
- `DELETE /api/users/:id` is a **deactivation** (`status = 'Inactive'`), never a row delete — the name must stay readable on past tickets. Gated by the existing Users `d` flag (Admin is the only seeded role with it, so no permission was granted to anyone). Self-delete → `400 SELF_DELETE_FORBIDDEN`; last-active-Admin guard is shared with `PATCH` via `assertNotLastActiveAdmin`
- The Users list still has **no pagination** parameters, so there is no page/limit bypass surface; `q` and `status` are ANDed into the same WHERE as the visibility clause
- Notification recipients: Active `Admin` / `Project manager` / `Control room` with `All tickets v`; no hardcoded user IDs and no new permission screen
- Notification APIs scope every read/update to the authenticated recipient; browser permission stays in the browser, subscription keys stay server-side
- Web Push uses `web-push` + VAPID and existing `setImmediate`; no WebSocket/SSE/queue. `404`/`410` deletes expired endpoints; `push_sent_at` prevents repeat sends
- Notification links are always openable since Phase 51 (`canOpen: true`) because every recipient sees every ticket
- Multi-issue tickets prefer `issues[]`; legacy single category/subcategory remains accepted; `ticket_issues` stores ordered reported/found rows while scalar fields retain the primary pair
- Ticket raise returns `eventId` so the frontend can attach photos through the raised-event endpoint without changing ticket creation semantics
- No ticket assignment (Phase 51, supersedes Phases 18/19/30/35/42/45/47/48 holder rules): "Every Ticket, Every Road" — `All tickets v` sees every ticket, `Update ticket e` updates any open ticket, `x` closes. `assertTicketAccess`, `appendTicketVisibilitySql`, `resolveUpdateAssignee`, `assertHolder`, `ASSIGNABLE_ROLES`, `createTicketAssignmentNotification` and `POST /:id/assign` deleted. Chosen by the user over a "field roles only" variant. Historical `assignee_id` / `ticket_assignments` / notifications kept without migration; Open + historical assignee still reads Under repair
- Main/Sub resolution (Phase 51): Main Issue = category, Sub Issue = sub-category; `resolveCategoryIds` resolves every Open reported sub of that category on the ticket, `resolveIssueIds` one sub; the server owns the expansion (never trust a client's sub list). `addIssues` appends Open reported rows after the raised ones (raised issues stay first — user's choice); same-ticket duplicate `409 ISSUE_ALREADY_ON_TICKET`, other open ticket `409 OPEN_TICKET_EXISTS`
- Close with update: `closeTicket` optional, default false; only explicit `true` closes (needs `Update ticket` x). Keeps one event per update (`status_label 'Closed'`, `meta.closedTicket`); Resolve (`Site visit — resolved`) never closes by itself; no `Resolved` status
- Per-issue state (Phase 49): only **reported** issues carry Open/Resolved (`ticket_issues.status`); the found-on-site set keeps its replace semantics and has no status. Resolving the last issue never closes the ticket; closing (either path) resolves the remaining Open issues with the closing event. Which update resolved an issue = `resolved_event_id` (no separate audit table). Dashboard `downReasons` is issue-level (Open reported issues); every other dashboard figure stays ticket/device-level
- `FIELD_ROLES` (`lib/permissions.ts`) = Technician / Engineer / Electrician; single source for notification delivery, road bypass, work report actors, Visited By, technicians lookup, issue sub-edit
- Two separate role lists, deliberately not merged: `NEW_TICKET_NOTIFICATION_ROLES` (Admin/PM/CR) governs `ticket.raised` fan-out; `NOTIFICATION_DELIVERY_ROLES` (those + `FIELD_ROLES`) governs Web Push delivery and frontend bell eligibility — field roles stay in it so historical `ticket.assigned` rows remain readable; they still get no new-ticket alerts. Site attendant / AMC officer are in neither
- Ticket-open read: `POST /api/notifications/ticket/:ticketId/read` marks the caller's unread rows for that ticket and returns `{ updated }`; `0` means nothing unread so no row is rewritten. Scoped by `recipient_user_id` so users cannot mark others' notifications. Registered before `PATCH /:id/read` so the literal `ticket` segment is not captured by `:id`
- Notification preferences (Phase 54): stored on `users`, not in a new table, because they are one-per-user and `loadAuthUser` already reads that row. The defaults are `TRUE` because every subscribed user already received push with sound. Browser permission is never stored. Push OFF is enforced in the delivery query for every device and keeps `push_subscriptions` rows (no churn); suppressed rows keep `push_sent_at = NULL` and are not replayed. Sound only sets `silent`. The endpoint lives under `/api/auth/me` (the user's own settings, like `PATCH /me`) and needs only `requireAuth`. The Settings panel is shown only to notification-eligible users.
- Deploy: run `npm run db:migrate` before the Phase 54 build. `loadAuthUser` selects the new columns on every authenticated request
- Notification `UPDATE`s must use `RETURNING` — the PGlite pool derives `rowCount` from returned rows, so a bare `UPDATE` always reports 0 on that driver
- `assertValidVisitedBy` (currently not wired into Add Update) accepts Active `FIELD_ROLES`
- Engineer and Electrician roles: Technician-like permissions; field-work road bypass like Technician
- Work report: `FIELD_ROLES` actors (Technician/Engineer/Electrician); road filter on `rd.name`; view-shaped tickets; export filtered like `/work`
- Visit cost: `eventCost = body.cost (labour) + SUM(parts.amount)`; master amount authoritative; dedupe part IDs per event
- Parts CRUD reuses Issue master `c`/`e` (+ Technician/Engineer create/update exception); hard-delete uses Issue master `d` (Admin, PM, Technician, Engineer); list/lookups need Update ticket `v`
- Unused Part/Issue category/sub hard-delete; used → `409 IN_USE` then soft-deactivate; historical visit JSONB / ticket issue FKs untouched
- Image zoom/crop are FE-only; `POST /api/uploads` unchanged
- Ticket visibility (Phase 51): none — every `All tickets v` user sees every ticket; `isTicketPrivilegedRole` (Admin/PM) survives only for photo attach on another user's event
- `lookups/technicians` (`FIELD_ROLES`) `label` is **`Name (Role)`** and display-only; `name` is the Work report person value. No longer feeds any Assign dropdown (removed in Phase 51)
- Device list / export / history are city-wide (no `assigned_roads` filter); open-ticket overlays read every ticket; create/PATCH keep `assertRoadAccess`; scan + raise use `assertRoadAccessUnlessFieldWork` (Site attendant / Technician / Engineer)
- Raise / Update / Close tickets accept `issues: [{ categoryId, subCategoryId }, …]` (legacy single `categoryId`/`subCategoryId` still works); persisted in `ticket_issues` with scalar primary for compat
- Site attendant: city-wide scan/raise; Device Sync + Issue master CRUD; Technician/Engineer: city-wide scan; Add Update = anyone with `Update ticket e` (Phase 51)
- Scan details stay on `GET /api/devices/scan?q=` (no `/scan-details` alias); scan `openTicketId` is not ticket-visibility filtered
- Open ticket means `status <> 'Closed'`; unassigned stored status is `Open` (not `New`). Since Phase 50 a device may hold several open tickets — uniqueness is per **Open reported issue** (`idx_ticket_issues_one_open_issue_per_device`, migration `025`, replacing the `012` one-open-ticket index). A raise never reopens a Closed ticket. SQL fixtures that force-close tickets must also resolve their reported issues
- Device status with several open tickets = the worst one (`openTicketLateralSql`, ranked like `deriveDeviceStatus`); Dashboard legend still counts devices once
- List tabs `open` (no update yet) / `urp` (at least one update) / `cls` (Phase 52; Phase 51's `open` was every non-Closed; `new` / `asg` gone); list may show historical assigned+`Open` as `Under repair` without DB update, and that row sits in the `urp` tab
- User chose (Phase 52): Waiting for spare stays in the Under repair tab with its own pill; the "Open over 3 days" card selects Open when Open has over-3-days tickets, otherwise Under repair
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
- Control room sees every ticket like every other role (Phase 51)
- Device list / export order (Phase 41): Slot Label ascending via `DEVICE_LIST_ORDER_BY` (`ORDER BY (slot_number = ''), slot_number, public_id`) in `src/routes/devices.ts`; SQL-side so it survives pagination. Since Phase 53 the string comes from `slotLabelOrderBy()` in `lib/device-ref.ts` (same output).
- Slot View (Phase 53): its own matrix screen `Slot View` (only `v` used), granted by default to Admin and Project manager only; other roles get an all-off row (migration `026`) so the toggle exists in Roles & permissions. `GET /api/tickets?device=` keeps `All tickets v`. Slot = `devices` row; ticket count = tickets (never issues), every status. "Unresolved issue" = reported Sub Issue with persisted `status = 'Open'`, unique per `subcategory_id`, grouped by Main Issue in the UI. Slot View order is natural (`slotLabelOrderBy(alias, { natural: true })`) because synced labels are not zero-padded; the Device list kept plain text order (not changed without a request). Slot tickets come from `GET /api/tickets?device=` rather than a second ticket query.

## Known Issues

- Device Sync skips QR items that omit Slot Id (`slot.id`); missing MAC/QR still syncs. Existing devices are left untouched when other records fail.
- Device Sync `devicesUpdated` only counts rows whose road/label/QR/MAC actually changed vs DB; duplicate QRs resolved once per run (last Slot Id wins) so a second sync on the same feed should show Updated: 0.
- Live Device Sync requires `DEVICE_SYNC_API_TOKEN`; without it `POST /api/device-sync` returns `503 DEVICE_SYNC_NOT_CONFIGURED`.
- `npm run test:smoke` no longer depends on seed tickets `TK-1099` / `TK-1078` (Phase 51 rewrote that section). It now stops at "tech device-sync should be authorized": the local DB has `Device list` `can_create = false` for Technician / Engineer, contrary to migration `014` — permission-matrix data drift, not a code bug; left untouched.
- Role notes in `roles.note` are written once at seed time; the live DB still carries the pre-Phase 51 "hold / assign" wording for Technician / Engineer / Electrician / Site attendant / Control room (`DEFAULT_ROLE_PERMS` notes were updated; no migration per Phase 51 policy). Edit them in Roles & permissions if needed.
- Users list `openTickets` per user still counts open tickets with that `assignee_id` — historical only since Phase 51 (new tickets never contribute).
- Device list order is plain text on `slot_number`; with non-padded synced labels it shows `3-12` before `3-2`. Slot View (Phase 53) uses the natural order; switching the Device list is one argument (`slotLabelOrderBy('', { natural: true })`) but was left for an explicit decision.
