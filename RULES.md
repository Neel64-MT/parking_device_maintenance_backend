# Rules — Parking Device Maintenance API

## What to do

- Follow `SKILL.md`: Zod validation, consistent `{ success, data }` / `{ success, false, error, code }`, HTTP status codes, `ApiError`, request logging.
- Keep business logic in **services**; routes/controllers stay thin.
- Validate **body, params, and query** with Zod on every endpoint.
- Enforce **authorization server-side** via `authorize(screen, flag)` plus road scope, ticket holder checks, and ticket visibility (assignee/raiser for non-Admin/non-PM).
- New-ticket notification recipients are Active `Admin` / `Project manager` / `Control room` users with existing `All tickets v`; never hardcode user IDs or add a second permission system.
- Create notifications only after the ticket, raised event, and optional assignment writes succeed. Notification persistence/delivery failure must never change a successful ticket response; failed ticket requests create none.
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
- `DELETE /api/roles/:id` requires `Roles & permissions` `d` (Admin is the only seeded role with it). A role can only be deleted while **no Active or Pending account** is assigned to it; otherwise reject with `409` / `ROLE_IN_USE` / "Role is assigned to users. Please change their role before deleting it." (plus `details.users` = the count of those accounts). **Inactive accounts are deliberately ignored** — they cannot sign in and must not keep a role alive forever. Read the count inside the request so a role assigned after the page loaded is still rejected. Unknown role → `404` / `NOT_FOUND`. `role_permissions` cascades.
- Migration 021 (`users_role_set_null`) makes `users.role_id` nullable and re-points the FK at `ON DELETE SET NULL`, which is what lets an Inactive account survive its role as a role-less account. That state is only safe because activation is gated (`ROLE_REQUIRED`) — `requireAuth` resolves permissions through a join on roles, so an Active user with no role could not be authorised. Never drop the NOT NULL/ON DELETE SET NULL pair, and never let an Active account hold a NULL role.
- Soft-deactivate issue categories/sub-categories that have been used on tickets; hard-delete only when unused (`Issue master` `d`: Admin, Project manager, Technician, Engineer). Category delete: `DELETE /api/issues/categories/:id` — tickets/events on category or its subs → `409 IN_USE`.
- Soft-deactivate parts used on ticket visits; hard-delete unused via `DELETE /api/parts/:id` (same Issue master `d`). Used → `409 IN_USE`.
- Derive device operational status from open tickets after go-live (do not trust client status for runtime).
- Device status cards (Working / Under repair / Not working) must filter the Device List via `GET /api/devices?status=…` with those exact labels — do not redirect to tickets or invent a second list API. Filter at SQL (`derived_status`); keep pagination/auth. Tile counts stay unfiltered by `status` so cards remain meaningful while the list is filtered.
- One open ticket per device / Slot Id (`status <> 'Closed'`). Backend enforces in app code and via partial unique index `idx_tickets_one_open_per_device` on `tickets(device_id) WHERE status <> 'Closed'`. Concurrent duplicate raises must map to `409` / `OPEN_TICKET_EXISTS`. Closed ticket within 7 days reopens the same ticket (reject new raise).
- Cannot raise a ticket when `devices.slot_identifier` is null/blank → `400` / `SLOT_IDENTIFIER_REQUIRED`. Sync or set MAC first.
- QR → device → raise/update: `GET /api/devices/scan?q=` for legacy codes; sticker `qr_token` → `POST /api/devices/slot-mac` (server proxies SmartPark `get-slot-mac`, matches local `slot_identifier` to `mac_id`, returns scan shape). Do not call SmartPark from the browser. Do not invent parallel by-qr / by-slot ticket APIs.
- Scan `openTicketId` is authoritative for Raise vs Update (not filtered by ticket list visibility); still require `Scan QR` `v`. Site attendant and Technician skip road checks on scan/raise (`assertRoadAccessUnlessFieldWork`); other roles still need road access. Keep `ticketsLast6Months` visibility-filtered.
- Ticket list rows expose `daysOpen` and `daysAfterClose` (`null` when not closed). Do not invent a second list endpoint for close-age.
- Ticket list tab `new` = unassigned non-closed; do not treat tab key `new` as stored status `New`.
- List/export may present assigned + stored `Open` as `Under repair` without changing the DB row; do not duplicate that mapping in the frontend.
- Paginate `GET /api/tickets` and `GET /api/devices` at SQL `LIMIT`/`OFFSET` after auth scope and filters — never fetch all rows then slice in memory.
- Default list `limit` is **10**; allowed limits are only **10, 25, 50, 100**; reuse [`src/lib/pagination.ts`](src/lib/pagination.ts).
- Pagination `total` / `totalPages` must reflect only authorized (+ filtered) rows.
- Parts master `amount` is authoritative for visit pricing; ticket update/close `cost` is labour-only; compute `eventCost = labour + SUM(selected part amounts)` server-side (dedupe IDs; reject unknown/inactive parts).
- Parts create/patch use Issue master `c`/`e` (or Technician/Engineer); hard-delete uses Issue master `d`; do not invent a new permission screen name.
- Image zoom/crop are frontend-only; do not change upload APIs for crop/zoom.
- Add Update (`POST /api/tickets/:id/updates`) requires `assignee_id`; reject unassigned with `409` / `TICKET_NOT_ASSIGNED` / `Ticket not assigned` for **every** role, including Admin/PM. Do not auto-claim on update, and never silently set `assignee_id` to the updater — an unassigned ticket must be routed by an assigner first.
- Notify the new assignee whenever `tickets.assignee_id` actually changes: `ticket.assigned` (first assign / raise-with-assignee) and `ticket.reassigned` (reassign / update handover). Trigger it from the backend business layer after the owning transaction commits — never from frontend events.
- Notify **only the newly assigned user**. Never notify the previous assignee on reassignment, and never create a second notification when the assignee does not actually change.
- Assignment notification recipients are the assignee only and require Active + a role in `NOTIFICATION_DELIVERY_ROLES`. `canOpen` is always `true` for assignment notifications because the recipient is the assignee.
- Two role lists are intentional and must not be merged: `NEW_TICKET_NOTIFICATION_ROLES` (Admin / Project manager / Control room) governs `ticket.raised` fan-out; `NOTIFICATION_DELIVERY_ROLES` (those plus Technician / Engineer) governs Web Push delivery and frontend bell eligibility. Field roles must not start receiving `ticket.raised`.
- Mark a ticket's notifications read via `POST /api/notifications/ticket/:ticketId/read` when the user opens that ticket. Always scope the update by `recipient_user_id` and `read_at IS NULL`; return `{ updated }` and use `0` to mean "nothing unread, no write". Register the route **before** `PATCH /:id/read` so the literal `ticket` segment is not captured by `:id`.
- Notification creation/delivery failure must be caught and logged at the call site; it must never roll back or fail the ticket, assignment, or update transaction that produced it.
- One `POST /api/tickets/:id/updates` request creates exactly one ticket event. When the on-site (found) issue differs from the reported issue, store it on that visit event (`category_id` / `subcategory_id` + `ticket_issues`) — never insert an extra `reclassified` event for the same request.
- Map update types to events by exact value: `Site visit — resolved` → `visit_resolved`; `Waiting for spare` → `waiting_spare`; everything else (including `Site visit — not resolved`) → `visit_open`. Never use substring matching for `resolved`.
- Ticket list `updates` counts `visit_open`, `visit_resolved`, `waiting_spare`, plus legacy `reclassified` rows; exclude raised, assigned, and closed events and do not filter by actor role.
- Add Update is allowed only for **Admin** or the **current assignee**. Reject others (including PM/raiser/user B after QR scan) with `403` / `NOT_ASSIGNED_USER` / `This ticket is assigned to another user` and `details.assignedTo`. Enforce server-side — do not rely on frontend hiding the button.
- `visitedBy` is required on Add Update; return structured Zod/`VALIDATION_ERROR` JSON (`details[].field = "visitedBy"`), never HTML. Eligible users: Active Technician or Engineer.
- API validation and business errors must return the existing JSON envelope via `handleApiError` — never framework HTML pages for handled routes.
- Ticket `status` is one of `Open`, `Under repair`, `Waiting for spare`, `Closed`. Never persist `New`; unassigned raise uses `Open`.
- `Waiting for spare` is reachable **only** through Add Update, which requires an assignee (`409` / `TICKET_NOT_ASSIGNED`). Never seed it on an unassigned ticket — not even in a smoke fixture. An unassigned waiting-spare row makes the two screens disagree: `deriveDeviceStatus` folds `Waiting for spare` into the device's `Under repair` (Dashboard counts devices) while the All Tickets tiles bucket any `status <> 'Closed' AND assignee_id IS NULL` ticket under `Open, not attended` (tiles count tickets). Keep fixture tickets unassigned + `Open`.
- Duplicate raise must return `409` / `OPEN_TICKET_EXISTS` with `details.openTicketId` (and `ticketId`) for UI redirect — never create a second open ticket.
- QR scan details use `GET /api/devices/scan?q=` (do not invent a second `/scan-details` route that fights `/:deviceId`). Trim `q` before lookup. When the device has no open ticket, respond with message `No tickets available` (still 200 + device payload, `openTicketId: null`) so Update can show that copy; raise remains available.
- Ticket update (`POST /api/tickets/:id/updates`) when the ticket id does not exist returns `404` / `NO_TICKETS_AVAILABLE` with error `No tickets available`.
- Device `latitude` / `longitude` are optional TEXT; seed and create/PATCH may set them.
- Close: only the current ticket holder (or privileged close path) may close. Assign / reassign is Control room, Admin, or Project manager only — technicians cannot handover. Add Update holder rule is Admin-or-assignee (stricter than list visibility).
- Admin and Project manager retain city-wide ticket visibility; other roles only see tickets they raised or are assigned to (SQL + detail asserts). Visibility is not the same as Add Update permission.
- Apply the same ticket visibility helper to dashboard metrics, device ticket overlays/history, and work report rows — do not duplicate Admin/PM branches per route.
- Backend authorization is mandatory; frontend filtering is not a security boundary.
- Assign may use road scope only (Control room routing); ticket list/detail/dashboard/reports stay visibility-scoped. Device **list / export / history** are city-wide for any role with Device list/history view (no `assigned_roads` filter). Create/PATCH still use `assertRoadAccess`. Scan and ticket raise use `assertRoadAccessUnlessFieldWork` (Site attendant / Technician / Engineer bypass).
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

`Dashboard`, `Raise ticket`, `Update ticket`, `All tickets`, `Work report`, `Device list`, `Add device`, `Device history`, `Scan QR`, `Issue master`, `Road master`, `Users`, `Roles & permissions`

### Flags

`v` view · `c` create · `e` edit · `a` assign · `x` close · `d` delete

### Scope

- `all_roads` — city-wide
- `assigned_roads` — only roads linked via `user_roads`

### Special rules

- Technician / Site attendant / Control room / AMC officer: ticket list/detail/export, dashboard ticket stats, device open-ticket overlays/history ticket rows, and work report ticket rows limited to `assignee_id = me OR raised_by_user_id = me`. Device list/history itself is city-wide (not road-filtered).
- Admin / Project manager: city-wide ticket visibility (road scope still `all_roads`).
- Technician: no Work report cost visibility when matrix denies Work report. Cannot assign or reassign (`All tickets` has no `a`); cannot send `handoverToUserId`.
- Technician / Engineer: Device list includes create (`vc....`) so they may run Device Sync; Add device stays denied.
- Site attendant: scan + raise on **any** road (field-work bypass); list stays raiser-scoped; cannot assign/close; may Device Sync (Device list `c`) and Issue master CRUD (`vce..d`); Add device stays denied.
- Technician: scan any road; update/close only tickets they hold or raised (any road); cannot assign or reassign; list stays assignee/raiser-scoped.
- Assign / reassign: Control room, Admin, or Project manager only (`assertCanAssignTickets`). Technicians cannot use `/assign` or `handoverToUserId`. Validate assignee eligibility; keep assign + trail insert transactional; same assignee must not duplicate trail rows.
- **Assignable (ticket-holder) roles are `ASSIGNABLE_ROLES` in [`src/lib/ticket-access.ts`](src/lib/ticket-access.ts): Technician, Engineer only.** `Project manager` and `Control room` are deliberately **not** assignable — a PM routes and closes work, and Control room raises and routes; neither attends the ticket. Both `GET /api/lookups/technicians` (the Hand to dropdown) and `assertEligibleAssignee` read that one constant, so the dropdown and the API can never disagree; never re-inline the role list in a route. A PM or Control room assignee returns `400` / `INVALID_ASSIGNEE` and the ticket is unchanged. This is **narrower than** `canAssignTickets` (Control room / Admin / Project manager), which answers a different question — who may *perform* an assign. Do not merge the two.
- Control room: raise/assign; cannot close; list/dashboard visibility is assignee/raiser only; assign uses road access so CR can route tickets they did not raise. Receives persistent/browser new-ticket notifications as an alert; fan-out does not widen list authorization.
- Admin / Project manager / Control room: receive `ticket.raised` notifications only while Active and retaining `All tickets v`; all other roles receive none for this event.
- AMC officer: view only.
- Project manager: Users `vce...` — can approve Pending signups and edit users; Roles matrix remains view-only. A PM never receives Admin-role accounts from `GET /api/users`.
- Admin: Users `vceaxd` — the only seeded role with Users `d`, so only Admin can delete an account. Admin still never sees their own row.
- At least one Admin must always remain active.
- Cost fields on work report: omit for roles without Work report view.
- Work report actors are Technician and Engineer only; filter road by `roads.name` (`rd`), never the roles alias; export must use the same filters as `/work`; keep view-shaped `tickets` tuples for FE table headers.
- Do not add a second permission system or duplicate role checks across dashboard/tickets/devices/reports.
