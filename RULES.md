# Rules — Parking Device Maintenance API

## What to do

- Follow `SKILL.md`: Zod validation, consistent `{ success, data }` / `{ success, false, error, code }`, HTTP status codes, `ApiError`, request logging.
- Keep business logic in **services**; routes/controllers stay thin.
- Validate **body, params, and query** with Zod on every endpoint.
- Enforce **authorization server-side** via `authorize(screen, flag)` plus road scope. Since Phase 51 there are no ticket holder checks and no assignee/raiser ticket visibility — the permission flags alone decide.
- New-ticket notification recipients are Active `Admin` / `Project manager` / `Control room` users with existing `All tickets v`; never hardcode user IDs or add a second permission system.
- Create notifications only after the ticket and raised event writes succeed. Notification persistence/delivery failure must never change a successful ticket response; failed ticket requests create none.
- Notification list/read/update APIs always scope by authenticated `recipient_user_id`. Browser permission stays in the browser; backend stores only Push API subscriptions.
- Reuse `web-push` + VAPID and the existing `setImmediate` background pattern. Do not add WebSocket/SSE, a queue library, or duplicate realtime infrastructure.
- Push `404` / `410` removes the expired subscription. Other push errors are logged without endpoint/key contents and do not fail ticket creation.
- Ticket raise/update/close prefer `issues[]`; keep the legacy single category/subcategory pair accepted. `ticket_issues` stores ordered reported/found rows while scalar fields retain the primary pair.
- Multi-issue raise returns `eventId`; raised photos attach through `PATCH /api/tickets/:ticketId/raised/:eventId/photos`.
- Store secrets only in environment variables (`.env` / `.env.local`).
- Never return passwords, password hashes, JWT secrets, raw reset tokens, or stack traces to clients.
- `DELETE /api/users/:id` is a **hard delete** (Users `d`). The row is removed; `user_roads`, `password_reset_tokens`, `notifications` and `push_subscriptions` cascade. The six references without `ON DELETE` are cleared first inside one `withTransaction`: `tickets.raised_by_user_id`, `tickets.assignee_id`, `ticket_events.actor_user_id`, `ticket_assignments.from_user_id`, `ticket_assignments.to_user_id`, `device_sync_runs.triggered_by_user_id`. Tickets, events, photos and costs all survive — only the person reference is emptied, so the deleted user's name no longer renders on past tickets. Do not reintroduce the old deactivation.
- Users list visibility is enforced in SQL by `src/lib/user-access.ts` (`appendUserVisibilitySql`), not in the frontend: always exclude the caller's own `users.id`, and exclude Admin-role accounts to every non-Admin viewer. The clause is ANDed into the same WHERE as `q` / `status`, so search and filters cannot bypass it. Tiles reuse the same clause so counts match the visible rows. Admin sees every other account, including other Admins. The Admin exclusion uses `COALESCE(r.name, '')` and the list/tiles join roles with **LEFT JOIN**, because a role-less account (`role_id IS NULL`, migration 021) must stay visible instead of being filtered away.
- `DELETE /api/users/:id` must reject self-deletion (`400` / `SELF_DELETE_FORBIDDEN` / "You cannot delete your own account."), an unknown user (`404`), and removing the last Active Admin (`409` / `LAST_ADMIN` via the shared `assertNotLastActiveAdmin`). An already-Inactive account **is** deletable — do not restore the old `ALREADY_INACTIVE` guard. Do not add a second Admin-vs-PM check — reuse `user-access.ts`.
- `PATCH /api/users/:id` must reject an unknown `roleId` (`400` / `ROLE_NOT_FOUND`) instead of letting the FK raise, and must refuse `status: 'Active'` when the resulting role is NULL (`409` / `ROLE_REQUIRED` / "Select a role for this user before activating the account."). `roleId` is omitted when unchanged, so a role-less account cannot be reactivated until a role is actually chosen.
- Do not add User list pagination, extra user endpoints, or a client-side role filter for visibility; the existing `Users` matrix flag decides delete authorization.
- `DELETE /api/roles/:id` requires `Roles & permissions` `d` (Admin is the only seeded role with it). A role can only be deleted while **no Active or Pending account** is assigned to it; otherwise reject with `409` / `ROLE_IN_USE` / "Role is assigned to users. Please change their role before deleting it." (plus `details.users` = the count of those accounts). **Inactive accounts are deliberately ignored** — they cannot sign in and must not keep a role alive forever. Read the count inside the request so a role assigned after the page loaded is still rejected. Unknown role → `404` / `NOT_FOUND`. The **Admin role is never deletable** — reject with `403` / `ADMIN_ROLE_PROTECTED` / "The Admin role cannot be deleted." before the user count, even with no users on it. `role_permissions` cascades.
- Migration 021 (`users_role_set_null`) makes `users.role_id` nullable and re-points the FK at `ON DELETE SET NULL`, which is what lets an Inactive account survive its role as a role-less account. That state is only safe because activation is gated (`ROLE_REQUIRED`) — `requireAuth` resolves permissions through a join on roles, so an Active user with no role could not be authorised. Never drop the NOT NULL/ON DELETE SET NULL pair, and never let an Active account hold a NULL role.
- Soft-deactivate issue categories/sub-categories that have been used on tickets; hard-delete only when unused (`Issue master` `d`: Admin, Project manager, Technician, Engineer, Electrician). Category delete: `DELETE /api/issues/categories/:id` — tickets/events on category or its subs → `409 IN_USE`.
- Soft-deactivate parts used on ticket visits; hard-delete unused via `DELETE /api/parts/:id` (same Issue master `d`). Used → `409 IN_USE`.
- Derive device operational status from open tickets after go-live (do not trust client status for runtime).
- Device status cards (Working / Under repair / Not working) must filter the Device List via `GET /api/devices?status=…` with those exact labels — do not redirect to tickets or invent a second list API. Filter at SQL (`derived_status`); keep pagination/auth. Tile counts stay unfiltered by `status` so cards remain meaningful while the list is filtered.
- Duplicate tickets are detected **by issue, not by device** (Phase 50, supersedes the Phase 17/24 one-open-ticket-per-device rule and the 7-day reopen rule). Duplicate key = same device + same sub-category that is still an **Open reported issue** on a non-`Closed` ticket. A different issue, an issue that only exists on a Closed ticket, or an issue already Resolved on a still-open ticket all create a **new** ticket — a device may hold several open tickets. A raise that contains any duplicate is rejected whole (`409` / `OPEN_TICKET_EXISTS`); nothing is created. Never reopen or modify a Closed ticket from a raise.
- The duplicate check runs in `assertNoOpenIssueConflicts` (`findOpenIssueConflicts`) before insert; the DB backstop is the partial unique index `idx_ticket_issues_one_open_issue_per_device` on `ticket_issues(device_id, subcategory_id) WHERE role = 'reported' AND status = 'Open'` (migration `025`; `idx_tickets_one_open_per_device` is dropped). A concurrent same-issue raise hits the index, rolls back the whole raise transaction, and answers the same `409` pointing at the winner. Every `ticket_issues` insert must fill `device_id` from its ticket (`replaceTicketIssues` does) — never insert without it.
- A Closed ticket never holds an Open reported issue (both close paths resolve the rest). Any SQL fixture that force-closes tickets must also mark their reported issues `Resolved`, or the index will block later raises.
- Cannot raise a ticket when `devices.slot_identifier` is null/blank → `400` / `SLOT_IDENTIFIER_REQUIRED`. Sync or set MAC first.
- QR → device → raise/update: `GET /api/devices/scan?q=` for legacy codes; sticker `qr_token` → `POST /api/devices/slot-mac` (server proxies SmartPark `get-slot-mac`, matches local `slot_identifier` to `mac_id`, returns scan shape). Do not call SmartPark from the browser. Do not invent parallel by-qr / by-slot ticket APIs.
- Scan `openTickets[]` (every open ticket with only its Open reported issues) plus `openTicketId` (the worst one) are authoritative for Raise vs Update (not filtered by ticket list visibility); still require `Scan QR` `v`. Site attendant and Technician skip road checks on scan/raise (`assertRoadAccessUnlessFieldWork`); other roles still need road access. `ticketsLast6Months` counts every ticket on the device (no visibility filter since Phase 51).
- Ticket list rows expose `daysOpen` and `daysAfterClose` (`null` when not closed). Do not invent a second list endpoint for close-age.
- Ticket list tabs are `open` (raised, no update yet — `NOT_ATTENDED_SQL`), `urp` (at least one update — `UNDER_REPAIR_TAB_SQL`, includes Waiting for spare and legacy Open + assignee) and `cls` (Phase 52; `new` / `asg` are gone and `tab=asg` must stay a `400`). Keep `tabForStatus`, the tab SQL and the tiles on the same predicates. Do not reintroduce an "assigned" tab or an `assignee` filter.
- `age=over3` narrows only `open` / `urp`. `tiles` and `over3Counts` stay on base filters only; `tabCounts.open` / `.urp` apply `age` (Phase 52).
- List/export still present a **historical** assigned + stored `Open` ticket as `Under repair` (`listStatus`, `NOT_ATTENDED_SQL`, `deriveDeviceStatus`, `OPEN_TICKET_RANK_SQL`) without changing the DB row; keep that legacy rule and do not duplicate it in the frontend.
- Paginate `GET /api/tickets` and `GET /api/devices` at SQL `LIMIT`/`OFFSET` after auth scope and filters — never fetch all rows then slice in memory.
- Default list `limit` is **10**; allowed limits are only **10, 25, 50, 100**; reuse [`src/lib/pagination.ts`](src/lib/pagination.ts).
- Pagination `total` / `totalPages` must reflect only authorized (+ filtered) rows.
- Parts master `amount` is authoritative for visit pricing; ticket update/close `cost` is labour-only; compute `eventCost = labour + SUM(selected part amounts)` server-side (dedupe IDs; reject unknown/inactive parts).
- Parts create/patch use Issue master `c`/`e` (or Technician/Engineer); hard-delete uses Issue master `d`; do not invent a new permission screen name.
- Image zoom/crop are frontend-only; do not change upload APIs for crop/zoom.
- **No ticket assignment (Phase 51, supersedes the Phase 18/19/30/35/42/45/47/48 holder, claim and handover rules).** Tickets have no holder. Never write `tickets.assignee_id`, `ticket_assignments` or `ticket.assigned` / `ticket.reassigned` notifications, and never reintroduce `POST /:id/assign`, `assigneeId` on raise, `handoverToUserId`, auto-claim, `TICKET_NOT_ASSIGNED`, `NOT_HOLDER` or `TICKET_ALREADY_ASSIGNED`.
- Add Update = `Update ticket` `e` on any non-Closed ticket ("Every Ticket, Every Road"); the author is `actor_user_id` (from the JWT, never the body). Close = `Update ticket` `x`; no holder check. Concurrent updates by different users both succeed — the ticket row lock (`SELECT … FOR UPDATE`) only serialises them.
- Historical assignee data (`tickets.assignee_id`, `ticket_assignments`, old notifications, `assigned` events) stays read-only and untouched — no migration, no clearing on update or close.
- Photo attach on an event (`PATCH …/raised|updates/:eventId/photos`) = the event's author or Admin/PM (`403 FORBIDDEN` otherwise).
- Close with update: optional `closeTicket` (default `false`). Close **only** on an explicit `true` — never because an update was added, because every issue is resolved, or because `updateType` is `Site visit — resolved`. `true` requires `Update ticket` `x`. It writes the single visit event with `status_label = 'Closed'` + `meta.closedTicket`, and sets `status = 'Closed'`, `closed_at = NOW()` in the same transaction.
- Resolve is the `Site visit — resolved` update type on the same endpoint; do not add a `Resolved` status or a second update implementation. `POST /:id/close` remains the full close form.
- `FIELD_ROLES` (`src/lib/permissions.ts`: Technician, Engineer, Electrician) is the single field-role list. Reuse it (or `isFieldRole` / `isFieldRoleName`) for notification delivery, road bypass, work report, Visited By, the technicians lookup and issue sub-edits — never re-inline role names.
- Technician, Engineer and Electrician can raise tickets (`Raise ticket` `v`+`c`, migrations `022`/`023`). Raise always creates `Open`; a stray `assigneeId` in the body is ignored (non-strict zod) and never stored.
- Two role lists are intentional and must not be merged: `NEW_TICKET_NOTIFICATION_ROLES` (Admin / Project manager / Control room) governs `ticket.raised` fan-out; `NOTIFICATION_DELIVERY_ROLES` (those plus `FIELD_ROLES`) governs Web Push delivery and frontend bell eligibility — field roles stay in it so their historical `ticket.assigned` rows remain readable. Field roles must not start receiving `ticket.raised`. Ticket updates and resolves create no notifications.
- Mark a ticket's notifications read via `POST /api/notifications/ticket/:ticketId/read` when the user opens that ticket. Always scope the update by `recipient_user_id` and `read_at IS NULL`; return `{ updated }` and use `0` to mean "nothing unread, no write". Register the route **before** `PATCH /:id/read` so the literal `ticket` segment is not captured by `:id`.
- Notification creation/delivery failure must be caught and logged at the call site; it must never roll back or fail the ticket or update transaction that produced it.
- One `POST /api/tickets/:id/updates` request creates exactly one ticket event. When the on-site (found) issue differs from the reported issue, store it on that visit event (`category_id` / `subcategory_id` + `ticket_issues`) — never insert an extra `reclassified` event for the same request.
- Per-issue state (Phase 49): only `ticket_issues` rows with `role = 'reported'` carry `status` (`Open` / `Resolved`). Resolve them only through `resolveIssueIds` / `resolveCategoryIds` on Add Update (`resolveIssueSelection`) or the close paths (`resolveOpenTicketIssues`), inside the existing ticket-locked transaction — never trust the client's view of which issues are Open, never add a second issue-status API or status column.
- Reject a `resolveIssueIds` entry that is not an Open reported issue of the same ticket (`400 INVALID_ISSUES` / `409 ISSUE_ALREADY_RESOLVED`) and roll back the whole update. Record the resolving event in `resolved_event_id`; that is the update trail for issues.
- Main/Sub resolution (Phase 51): `resolveCategoryIds` (Main Issue) resolves every **Open** reported sub of that category on this ticket; `resolveIssueIds` (Sub Issue) resolves one. Both go through `resolveIssueSelection` (row-locked, union of both). Category with no reported row on the ticket / unknown id → `400 INVALID_ISSUES`; category with nothing Open left → `409 ISSUE_ALREADY_RESOLVED`. Never resolve a sub by category name or from the client's list of sub ids for a category.
- `addIssues` (Phase 51) appends Open **reported** issues via `appendTicketIssues` (never `replaceTicketIssues`, which would wipe statuses). Same sub already on this ticket in any status → `409 ISSUE_ALREADY_ON_TICKET`; Open on another ticket of the device → `409 OPEN_TICKET_EXISTS` (reuse `assertNoOpenIssueConflicts`). Append runs before the resolve step so one update can add and resolve; one request still writes exactly one event.
- Resolving the last Open issue must not close the ticket or change its status; closing stays explicit (`closeTicket: true` or `POST /:id/close`) and resolves whatever is still Open with the closing event.
- Dashboard: `downReasons` / `openIssues` are issue-level (Open reported issues on non-Closed tickets); device status, fleet legend, road-wise and ticket counts stay ticket-level. Do not swap the rest to issue counts.
- Device status (Phase 50) comes from the device's **worst** open ticket via the shared `openTicketLateralSql` (`src/lib/device-status.ts`), ranked like `deriveDeviceStatus` (Not working > Under repair > Working, then latest raise). Reuse it for the Dashboard, Device list, Device detail and scan — never go back to "latest open ticket `LIMIT 1`" or count a device once per open ticket. Roads `down` counts `DISTINCT device_id`. Device-detail days-down runs from the earliest open raise (`first_open_at`).
- Several users may resolve different issues of the same ticket over time; every update stays on that ticket and never creates a new one. Each user only needs `Update ticket` `e` (Phase 51).
- Map update types to events by exact value: `Site visit — resolved` → `visit_resolved`; `Waiting for spare` → `waiting_spare`; everything else (including `Site visit — not resolved`) → `visit_open`. Never use substring matching for `resolved`.
- Ticket list `updates` counts `visit_open`, `visit_resolved`, `waiting_spare`, plus legacy `reclassified` rows; exclude raised, assigned, and closed events and do not filter by actor role.
- Add Update authorization is enforced server-side — do not rely on frontend hiding the button. A role without `Update ticket` `e` (e.g. Site attendant, default Control room) is rejected with `403` on every ticket.
- API validation and business errors must return the existing JSON envelope via `handleApiError` — never framework HTML pages for handled routes.
- Ticket `status` is one of `Open`, `Under repair`, `Waiting for spare`, `Closed`. Never persist `New`; unassigned raise uses `Open`.
- `Waiting for spare` is reachable **only** through Add Update. Keep smoke fixture tickets unassigned + `Open` unless a test deliberately builds a historical assigned ticket. The All Tickets "Open, not attended" tile is `status IN ('Open','New') AND assignee_id IS NULL` (`NOT_ATTENDED_SQL`), so a stored `Under repair` / `Waiting for spare` ticket never lands there.
- Duplicate raise (same Open issue) must return `409` / `OPEN_TICKET_EXISTS` with `details.openTicketId` (and `ticketId`) for UI redirect plus `details.issues[]` (`{ ticketId, id, categoryId, subCategoryId, category, sub }`) listing every duplicate — never create a second ticket for an issue that is already Open.
- QR scan details use `GET /api/devices/scan?q=` (do not invent a second `/scan-details` route that fights `/:deviceId`). Trim `q` before lookup. When the device has no open ticket, respond with message `No tickets available` (still 200 + device payload, `openTicketId: null`) so Update can show that copy; raise remains available.
- Ticket update (`POST /api/tickets/:id/updates`) when the ticket id does not exist returns `404` / `NO_TICKETS_AVAILABLE` with error `No tickets available`.
- Device `latitude` / `longitude` are optional TEXT; seed and create/PATCH may set them.
- Device list / export order by **Slot Label ascending** in SQL (`DEVICE_LIST_ORDER_BY` in `routes/devices.ts`), never client-side: sorting a single page breaks pagination. Keep `public_id` as the tie-break and blank labels last. Do not change ticket list order (`raised_at DESC`).
- Ticket visibility (Phase 51): every user with `All tickets` `v` sees every ticket on every road — list, detail, export, dashboard, device overlays/history, scan and work report. Do not reintroduce `appendTicketVisibilitySql` / `assertTicketAccess` or any assignee/raiser filter. Visibility is still not the same as Add Update permission (`e`).
- Backend authorization is mandatory; frontend filtering is not a security boundary.
- Device **list / export / history** are city-wide for any role with Device list/history view (no `assigned_roads` filter). Create/PATCH still use `assertRoadAccess`. Scan and ticket raise use `assertRoadAccessUnlessFieldWork` (Site attendant + `FIELD_ROLES` bypass).
- Signup approval/update requires `authorize('Users', 'e')` (Admin or Project manager with Users edit).
- Reuse existing authorization mechanisms; avoid duplicate Admin/PM code paths.
- Keep the sibling `frontend/` directory **read-only by default**; the explicitly authorized Phase 39 notification integration is the current exception. Document any remaining UI wiring as FRONTEND CHANGE REQUIRED.
- Update `MEMORY.md` / `PHASES.md` after each meaningful phase.
- Forgot-password: only **Admin** / **Project manager** receive a reset email. Other Active roles get `403` / `FORGOT_PASSWORD_ROLE_DENIED` with an explicit message. Unknown / Pending / Inactive emails still get the generic 200 (no account enumeration for missing users).
- Reset-password must also reject non–Admin/PM users (`FORGOT_PASSWORD_ROLE_DENIED`) without marking the token used.
- Forgot-password responses must not reveal whether an account exists (except the intentional role-denied path for known Active non–ops-lead users).
- Reset tokens must expire, be one-time-use, and be stored hashed only.
- Admin password changes require server-side `authorize('Users', 'e')`; reuse existing user PATCH.
- Reuse existing auth hashing, Zod password rules, and JWT middleware; avoid duplicate auth stacks.
- Do not modify unrelated working login/logout flows except where password-reset/session invalidation requires it.
- Device Sync must not block the HTTP request for the full import; return 202 and run in the background.
- Reuse existing background infrastructure (`setImmediate` + `device_sync_runs`); do not add a new queue library.
- Location sync must succeed before QR/device sync starts.
- Device sync must be idempotent (no duplicate roads/devices); use unique keys / upserts.
- Process QR data page-by-page (`per_page=50`); do not load the entire external dataset into memory.
- Do not hardcode SmartPark URLs/tokens in routes — use `DEVICE_SYNC_BASE_URL` and `DEVICE_SYNC_API_TOKEN` env.
- Preserve `authorize('Device list', …)` for sync endpoints; do not invent a separate auth system.
- Never add a synced device without a Slot Id (`slot.id`). Slot Id is the only required sync identity.
- MAC (`mac_address`) and QR (`qr_number`) are optional on sync; when they change for an existing Slot Id, update the device row. Do not clear an existing MAC when the incoming MAC is empty.
- One invalid sync record must not stop the complete sync — skip and continue.
- Device Sync matches by stable `slot_id`; never overwrite `slot_id` after it is set. Do not create duplicate devices for an existing Slot Id.
- When Slot Id exists and incoming MAC differs, update the existing device’s `slot_identifier` (and QR/road/label when changed).
- Count `devicesUpdated` only when a row’s synced fields actually change (`IS DISTINCT FROM`); unchanged external payload → no-op.
- Duplicate QR across Slot Ids in one sync: last Slot Id keeps the QR; others get stable `UNLINKED-SLOT-{slotId}` to avoid update thrash.
- Do not perform unnecessary database writes when MAC and synced fields are unchanged.
- Preserve existing ticket functionality — incomplete sync records must not disable existing devices.
- Prefer Slot Id over `public_id` in ticket/device API display fields when `slot_id` is present.
- Resolve `GET /api/devices/:deviceId` (and QR/PATCH) by `public_id` **or** device UUID **or** `CAST(slot_id AS TEXT)` via `deviceLookupWhere`; display ids via `deviceDisplayId` (including create/PATCH response `id`).
- Do not accept or overwrite `slot_id` on manual Add/Edit device — Slot Id is **not editable**; only Device Sync sets it.
- Manual create/PATCH may update `slot_identifier` (MAC) and `qr_code` (`qrNumber`) when Device Sync is unavailable; empty MAC clears `slot_identifier` on PATCH when the field is sent.
- Keep Device Sync code concise; reuse Express + `pg` patterns; avoid unnecessary APIs, libraries, abstractions, and refactoring.
- Slot View (Phase 53): list only slots that have tickets by aggregating from `tickets` (never list every device and filter); count tickets, never `ticket_issues` rows. Unresolved issues = reported rows with persisted `status = 'Open'` (reuse `loadOpenDeviceTickets`), deduplicated by `subcategory_id`, never by display text. Slot tickets go through `GET /api/tickets?device=` — do not add a second ticket list query or row mapper. Gate every Slot View route with `authorize('Slot View', 'v')` — never a role-name check; who sees it is decided in Roles & permissions (defaults: Admin and Project manager).
- Slot Label ordering goes through `slotLabelOrderBy` in `lib/device-ref.ts`; Slot View passes `{ natural: true }` (synced labels are not zero-padded). Never sort slot rows in JS after a paginated query.

## What to avoid

- Do not modify the frontend source unless explicitly authorized; the Phase 39 notification integration is explicitly authorized and consumes the existing API contract.
- Do not bypass Zod validation or authorization middleware.
- Do not expose secrets or internal DB details in responses.
- Do not add unnecessary libraries or deep abstractions.
- Do not put business rules only in route handlers.
- Do not invent APIs for screens/features that do not exist in the frontend.
- Do not implement device telemetry auto-ticketing in v1.
- Do not use Next.js-style `routes/[id]/route.ts` layout without a loader — use Express routers.

## Authorization

### Screens

`Dashboard`, `Slot View`, `Raise ticket`, `Update ticket`, `All tickets`, `Work report`, `Device list`, `Add device`, `Device history`, `Scan QR`, `Issue master`, `Road master`, `Users`, `Roles & permissions`

Adding a screen: `ScreenName`, `SCREENS`, every role in `DEFAULT_ROLE_PERMS`, the frontend `PERM_SCREENS` / `DEFAULT_ROLE_PERMS`, and a migration that inserts a row for every existing role (`ON CONFLICT DO NOTHING`, e.g. `026_slot_view_permission.sql`). A missing row reads as `......`.

### Flags

`v` view · `c` create · `e` edit · `a` assign · `x` close · `d` delete

### Scope

- `all_roads` — city-wide
- `assigned_roads` — only roads linked via `user_roads`

### Special rules

- Every role with `All tickets` `v`: every ticket on every road (Phase 51). The `a` (assign) flag is no longer used by any ticket route; leave it in the matrix (no migration).
- Technician: no Work report cost visibility when matrix denies Work report.
- Technician / Engineer / Electrician: Device list includes create (`vc....`) so they may run Device Sync; Add device stays denied. Update / close any open ticket (`Update ticket` `vce.x.`).
- Site attendant: scan + raise on **any** road (field-work bypass); sees every ticket; cannot update or close; may Device Sync (Device list `c`) and Issue master CRUD (`vce..d`); Add device stays denied.
- Control room: raise; sees every ticket; cannot update (default `Update ticket` `v.....`) or close. Receives persistent/browser new-ticket notifications.
- Admin / Project manager / Control room: receive `ticket.raised` notifications only while Active and retaining `All tickets v`; all other roles receive none for this event.
- AMC officer: view only.
- Project manager: Users `vce...` — can approve Pending signups and edit users; Roles matrix remains view-only. A PM never receives Admin-role accounts from `GET /api/users`.
- Admin: Users `vceaxd` — the only seeded role with Users `d`, so only Admin can delete an account. Admin still never sees their own row.
- At least one Admin must always remain active.
- Cost fields on work report: omit for roles without Work report view.
- Work report actors are Technician and Engineer only; filter road by `roads.name` (`rd`), never the roles alias; export must use the same filters as `/work`; keep view-shaped `tickets` tuples for FE table headers.
- Do not add a second permission system or duplicate role checks across dashboard/tickets/devices/reports.
