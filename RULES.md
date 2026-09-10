# Rules — Parking Device Maintenance API

## What to do

- Follow `SKILL.md`: Zod validation, consistent `{ success, data }` / `{ success, false, error, code }`, HTTP status codes, `ApiError`, request logging.
- Keep business logic in **services**; routes/controllers stay thin.
- Validate **body, params, and query** with Zod on every endpoint.
- Enforce **authorization server-side** via `authorize(screen, flag)` plus road scope, ticket holder checks, and ticket visibility (assignee/raiser for non-Admin/non-PM).
- Store secrets only in environment variables (`.env` / `.env.local`).
- Never return passwords, password hashes, JWT secrets, raw reset tokens, or stack traces to clients.
- Soft-inactivate users; never hard-delete (ticket history must remain readable).
- Soft-deactivate issue sub-categories that have been used on tickets; hard-delete only when unused.
- Derive device operational status from open tickets after go-live (do not trust client status for runtime).
- One open ticket per device / Slot Id (`status <> 'Closed'`). Backend enforces in app code and via partial unique index `idx_tickets_one_open_per_device` on `tickets(device_id) WHERE status <> 'Closed'`. Concurrent duplicate raises must map to `409` / `OPEN_TICKET_EXISTS`. Closed ticket within 7 days reopens the same ticket (reject new raise).
- QR → device → raise/update: `GET /api/devices/scan?q=` then either `POST /api/tickets` or `POST /api/tickets/:id/updates`. Do not invent parallel by-qr / by-slot ticket APIs.
- Scan `openTicketId` is authoritative for Raise vs Update (not filtered by ticket list visibility); still require `Scan QR` `v`. Site attendant and Technician skip road checks on scan/raise (`assertRoadAccessUnlessFieldWork`); other roles still need road access. Keep `ticketsLast6Months` visibility-filtered.
- Ticket list rows expose `daysOpen` and `daysAfterClose` (`null` when not closed). Do not invent a second list endpoint for close-age.
- Ticket list tab `new` = unassigned non-closed; do not treat tab key `new` as stored status `New`.
- List/export may present assigned + stored `Open` as `Under repair` without changing the DB row; do not duplicate that mapping in the frontend.
- Paginate `GET /api/tickets` and `GET /api/devices` at SQL `LIMIT`/`OFFSET` after auth scope and filters — never fetch all rows then slice in memory.
- Default list `limit` is **10**; allowed limits are only **10, 25, 50, 100**; reuse [`src/lib/pagination.ts`](src/lib/pagination.ts).
- Pagination `total` / `totalPages` must reflect only authorized (+ filtered) rows.
- Parts master `amount` is authoritative for visit pricing; ticket update/close `cost` is labour-only; compute `eventCost = labour + SUM(selected part amounts)` server-side (dedupe IDs; reject unknown/inactive parts).
- Parts create/patch use Issue master `c`/`e`; do not invent a new permission screen name.
- Ticket `status` is one of `Open`, `Under repair`, `Waiting for spare`, `Closed`. Never persist `New`; unassigned raise uses `Open`.
- Duplicate raise must return `409` / `OPEN_TICKET_EXISTS` with `details.openTicketId` (and `ticketId`) for UI redirect — never create a second open ticket.
- QR scan details use `GET /api/devices/scan?q=` (do not invent a second `/scan-details` route that fights `/:deviceId`). Trim `q` before lookup. When the device has no open ticket, respond with message `No tickets available` (still 200 + device payload, `openTicketId: null`) so Update can show that copy; raise remains available.
- Ticket update (`POST /api/tickets/:id/updates`) when the ticket id does not exist returns `404` / `NO_TICKETS_AVAILABLE` with error `No tickets available`.
- Device `latitude` / `longitude` are optional TEXT; seed and create/PATCH may set them.
- Only the current ticket holder may update or close. Assign / reassign is Control room, Admin, or Project manager only — technicians cannot handover.
- Admin and Project manager retain city-wide ticket visibility; other roles only see tickets they raised or are assigned to (SQL + detail asserts).
- Apply the same ticket visibility helper to dashboard metrics, device ticket overlays/history, and work report rows — do not duplicate Admin/PM branches per route.
- Backend authorization is mandatory; frontend filtering is not a security boundary.
- Assign may use road scope only (Control room routing); ticket list/detail/dashboard/reports stay visibility-scoped. Device **list / export / history** are city-wide for any role with Device list/history view (no `assigned_roads` filter). Create/PATCH still use `assertRoadAccess`. Scan and ticket raise use `assertRoadAccessUnlessFieldWork` (Site attendant / Technician bypass).
- Signup approval/update requires `authorize('Users', 'e')` (Admin or Project manager with Users edit).
- Reuse existing authorization mechanisms; avoid duplicate Admin/PM code paths.
- Keep the sibling `frontend/` directory **read-only** — document needed UI wiring as FRONTEND CHANGE REQUIRED.
- Update `MEMORY.md` / `PHASES.md` after each meaningful phase.
- Forgot-password: only **Admin** / **Project manager** receive a reset email. Other Active roles get `403` / `FORGOT_PASSWORD_ROLE_DENIED` with an explicit message. Unknown / Pending / Inactive emails still get the generic 200 (no account enumeration for missing users).
- Reset-password must also reject non–Admin/PM users (`FORGOT_PASSWORD_ROLE_DENIED`) without marking the token used.
- Forgot-password responses must not reveal whether an account exists (except the intentional role-denied path for known Active non–ops-lead users).
- Reset tokens must expire, be one-time-use, and be stored hashed only.
- Admin password changes require server-side `authorize('Users', 'e')`; reuse existing user PATCH.
- Reuse existing auth hashing, Zod password rules, and JWT middleware; avoid duplicate auth stacks.
- Do not modify unrelated working login/logout flows except where password-reset/session invalidation requires it.
- Device Sync must not block the HTTP request for the full import; return 202 and run in the background.
- Location sync must succeed before QR/device sync starts.
- Device sync must be idempotent (no duplicate roads/devices); use unique keys / upserts.
- Process QR data page-by-page (`per_page=50`); do not load the entire external dataset into memory.
- Do not hardcode SmartPark URLs/tokens in routes — use `DEVICE_SYNC_BASE_URL` and `DEVICE_SYNC_API_TOKEN` env.
- Preserve `authorize('Device list', …)` for sync endpoints; do not invent a separate auth system.
- Device Sync matches by stable `slot_id`; never overwrite `slot_id` after it is set. Update `slot_identifier` (mac) and `qr_code` when hardware changes.
- Map Slot Identifier from external `mac_address` into `devices.slot_identifier`; leave null only when the QR item omits `mac_address`.
- Prefer Slot Id over `public_id` in ticket/device API display fields when `slot_id` is present.
- Resolve `GET /api/devices/:deviceId` (and QR/PATCH) by `public_id` **or** device UUID **or** `CAST(slot_id AS TEXT)` via `deviceLookupWhere`; display ids via `deviceDisplayId` (including create/PATCH response `id`).
- Do not accept or overwrite `slot_id` on manual Add/Edit device — Slot Id is set only by Device Sync.
- Keep Device Sync code concise; reuse Express + `pg` patterns; no new queue libraries unless required.

## What to avoid

- Do not modify the frontend source.
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
- Site attendant: scan + raise on **any** road (field-work bypass); list stays raiser-scoped; cannot assign/close.
- Technician: scan any road; update/close only tickets they hold or raised (any road); cannot assign or reassign; list stays assignee/raiser-scoped.
- Assign / reassign: Control room, Admin, or Project manager only (`assertCanAssignTickets`). Technicians cannot use `/assign` or `handoverToUserId`.
- Control room: raise/assign; cannot close; list/dashboard visibility is assignee/raiser only; assign uses road access so CR can route tickets they did not raise.
- AMC officer: view only.
- Project manager: Users `vce...` — can approve Pending signups and edit users; Roles matrix remains view-only.
- At least one Admin must always remain active.
- Cost fields on work report: omit for roles without Work report view.
- Do not add a second permission system or duplicate role checks across dashboard/tickets/devices/reports.
