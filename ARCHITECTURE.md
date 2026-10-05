# Architecture — Parking Device Maintenance API

## App Flow

```text
Client (curl / future frontend)
  → HTTP JSON / multipart
Express (src/app.ts)
  → request logger middleware
  → optional JWT auth middleware
  → authorize(screen, flag) middleware
  → Zod validation (body / params / query)
  → Controller
  → Service (business rules)
  → Repository (SQL via pg)
  → PostgreSQL
  → { success, data, message } | { success: false, error, code }
```

Static uploads are served from `/uploads`.

## Folder & File Structure

```text
backend/
├── src/
│   ├── app.ts
│   ├── server.ts
│   ├── config/env.ts
│   ├── db/
│   │   ├── pool.ts
│   │   ├── migrate.ts
│   │   ├── migrations/
│   │   └── seed.ts
│   ├── types/api.ts
│   ├── lib/
│   │   ├── api-error.ts
│   │   ├── api-logger.ts
│   │   └── respond.ts
│   ├── middleware/
│   │   ├── auth.ts
│   │   ├── authorize.ts
│   │   ├── error-handler.ts
│   │   └── upload.ts
│   ├── routes/
│   ├── lib/ (incl. device-sync.ts, device-sync-client.ts)
│   └── types/api.ts
├── uploads/
├── .env.example
├── package.json
├── tsconfig.json
├── PR.md
├── ARCHITECTURE.md
├── RULES.md
├── DESIGN.md
├── MEMORY.md
├── PHASES.md
└── SKILL.md
```

## Tech Stack

| Layer | Choice |
|-------|--------|
| Runtime | Node.js + tsx (Bun optional if installed) |
| Language | TypeScript |
| HTTP | Express |
| Validation | Zod |
| Database | PostgreSQL (`pg`) via `DB_*` env; optional PGlite |
| Auth | JWT Bearer + email/mobile password |
| Uploads | multer → local disk |
| QR labels | `qrcode` PNG |
| Browser push | `web-push` + VAPID; persistent notifications/subscriptions in PostgreSQL |
| Browser push | `web-push` + VAPID; persistent notifications/subscriptions in PostgreSQL |

No Nest, Prisma, or Next.js file-based routing. Express routers live in `src/routes/*.ts`.

## Key Domains

- **Auth / Users / Roles** — Email or mobile + password login, forgot/reset password, permission matrix, road assignments. `DELETE /api/roles/:id` deletes a role only while no **Active or Pending** account is assigned to it; an assigned role is rejected with `409 ROLE_IN_USE` ("Role is assigned to users. Please change their role before deleting it."). Inactive accounts do not block it — the users→roles FK is `ON DELETE SET NULL` (migration 021), so they survive as role-less accounts and `PATCH /api/users/:id` refuses to make such an account `Active` (`409 ROLE_REQUIRED`) until a role is chosen. `DELETE /api/users/:id` is a hard delete that clears the six un-cascaded user references and keeps the tickets themselves
- **Masters** — Roads, issue categories/subs (hard-delete unused category/sub via `/api/issues`; used → `409 IN_USE`), parts (with `amount`; CRUD + hard-delete unused via `/api/parts` and Issue master flags including `d` for Tech/Engineer/PM/Admin)
- **Devices** — Inventory, QR scan, derived operational status from open tickets
- **Tickets** — Lifecycle (`Open` → first update `Under repair` → `Waiting for spare` optional → `Closed`; no assignment since Phase 51), per-issue Open/Resolved by Main/Sub issue, events, visit cost = labour + parts master, photos
- **Notifications** — Persistent per-user new-ticket alerts, unread/read state, VAPID browser subscriptions and non-blocking Web Push delivery
- **Reports** — Dashboard aggregates, work report by period

## Password reset architecture

```text
User
 → Login Screen
 → POST /api/auth/forgot-password
 → password_reset_tokens (hashed token, 1h TTL)
 → Email (SMTP) or development console link
 → POST /api/auth/reset-password
 → users.password_hash + password_changed_at
 → Existing login
```

```text
Admin
 → Admin Panel (Users)
 → PATCH /api/users/:id { password }
 → authorize('Users','e')
 → password_hash + password_changed_at
 → Prior JWTs (iat before password_changed_at) rejected
```

| Piece | Location |
|-------|----------|
| APIs | `src/routes/auth.ts` (`forgot-password`, `reset-password`), `src/routes/users.ts` (PATCH password) |
| Helpers | `src/lib/auth.ts` (hash/reset tokens/`pv`), `src/lib/mail.ts` |
| DB | `password_reset_tokens`, `users.password_changed_at`, `users.password_version` |
| Design | `DESIGN.md` |

## Ticket visibility (Phase 51 — "Every Ticket, Every Road")

```text
Any role with All tickets v
  → every ticket on every road (list / export / detail)
Update ticket e → Add Update on any non-Closed ticket
Update ticket x → close (closeTicket or POST /:id/close)
```

There is no visibility helper any more: `appendTicketVisibilitySql`, `assertTicketAccess`, `assertTicketViewAccess`, `assertCanAssignTickets` and `ASSIGNABLE_ROLES` were deleted. [`src/lib/ticket-access.ts`](src/lib/ticket-access.ts) keeps only `isTicketPrivilegedRole` (Admin / Project manager — photo attach on another user's event) and `isFieldRole`. Ticket list/export/detail ([`tickets.ts`](src/routes/tickets.ts)), dashboard ([`dashboard.ts`](src/routes/dashboard.ts)), device list/export/scan/history overlays ([`devices.ts`](src/routes/devices.ts)) and the work report ([`reports.ts`](src/routes/reports.ts)) read every ticket. The Phase 12/48 assignee/raiser scoping described in older phases is history.

**FRONTEND CHANGE REQUIRED:** when Dashboard / All Tickets / Device screens leave mocks, trust API scope — do not re-filter by role in the browser.

## QR scan → raise ticket

```text
Client scans QR / enters device code
  → Legacy PD/QR/slot: GET /api/devices/scan?q=…  (authorize Scan QR v)
  → Sticker qr_token: POST /api/devices/slot-mac { "qr_token": "..." }
       → SmartPark POST /api/v1/get-slot-mac { qr_token }
       → local device WHERE slot_identifier = mac_id
       → same ScanDevice shape (+ macId, bleMac)
  → Response: deviceId (Slot Id preferred), deviceName, locationSite, slot, slotId,
               slotLabel, slotIdentifier, qrNumber, parkingLocation,
               currentStatus, statusDate, ticketsLast6Months,
               openTicketId?, openTicketAge?, openTicketIssue?,
               latitude, longitude (+ legacy id/facts)
  → If openTicketId set → open existing ticket → POST /api/tickets/:id/updates
       (any user with Update ticket e; no assignment; closeTicket optional)
  → Else POST /api/tickets { deviceId, ... }  (Raise ticket c)
       → if device has no slot_identifier: 400 SLOT_IDENTIFIER_REQUIRED
       → if another open ticket: 409 OPEN_TICKET_EXISTS { openTicketId, ticketId }
```

Reuse only — no `/devices/by-qr` or `/tickets/by-slot` endpoints. Device `latitude` / `longitude` are TEXT. Scan `openTicketId` / `openTickets` and the 6-month ticket count read every ticket (no visibility filter since Phase 51). Scan and raise use `assertRoadAccessUnlessFieldWork` (Site attendant + `FIELD_ROLES` bypass); device create/PATCH still use `assertRoadAccess`. FE must not call SmartPark directly (`DEVICE_SYNC_API_TOKEN` stays server-side).

### Manual device create / edit (fallback when Sync is down)

```text
POST /api/devices          authorize Add device c
PATCH /api/devices/:id     authorize Device list e
  body may include: roadId, slotNumber, slotIdentifier (MAC), qrNumber, …
  never writes slot_id (Slot Id not editable; sync-owned)
```

`GET /api/devices/:deviceId` already returns `slotId` / `slotIdentifier` / `qrNumber` for the Edit form.

### Device list order

`GET /api/devices` and `GET /api/devices/export` both order by **Slot Label ascending** — `DEVICE_LIST_ORDER_BY` = `ORDER BY (slot_number = ''), slot_number, public_id` in `src/routes/devices.ts`. Sorting lives in SQL (not the frontend) so it is correct across `LIMIT/OFFSET` pagination; blank labels sort last and `public_id` is the stable tie-break. Filters, tiles, and the pagination envelope are unchanged. Ticket list order (`raised_at DESC`) is untouched.

Duplicate tickets are detected per issue (Phase 50): one Open reported issue per device + sub-category. DB: `idx_ticket_issues_one_open_issue_per_device` on `ticket_issues(device_id, subcategory_id) WHERE role='reported' AND status='Open'` (replaces `idx_tickets_one_open_per_device`). Raise pre-check (`assertNoOpenIssueConflicts`) + unique-violation → same `OPEN_TICKET_EXISTS` details (`openTicketId`, `issues[]`). A device may hold several open tickets for different issues. Raise also requires non-empty `slot_identifier` → `400` / `SLOT_IDENTIFIER_REQUIRED`.

## Signup approval

```text
POST /api/auth/signup → status Pending
Admin or Project manager (Users v/c/e)
  → GET /api/users?status=Pending
  → PATCH /api/users/:id { status: Active, roleId, ... }
```

Project manager Users permission: `vce...` (migration `006_pm_users_edit.sql`).

## Users list visibility and delete

Helper: [`src/lib/user-access.ts`](src/lib/user-access.ts), mirroring `lib/ticket-access.ts`.

```text
appendUserVisibilitySql(user, params)
  → u.id <> $me                      (every role, always)
  → AND r.name <> 'Admin'            (only when the viewer is not Admin)

GET /api/users        authorize('Users','v')  + that clause ANDed with q / status
GET /api/users tiles  same clause, own params (tiles ignore q / status)
```

Consequences: Admin sees every other account including other Admins; Project manager sees no Admin account and no self; every caller never sees their own row. Because the clause lives in the same SQL `WHERE`, `?q=Admin`, `?status=…` and any query-parameter manipulation cannot surface a hidden row. The list has no pagination parameters.

```text
DELETE /api/users/:id   authorize('Users','d')   → Admin only (Users 'vceaxd')
  self           → 400 SELF_DELETE_FORBIDDEN "You cannot delete your own account."
  unknown        → 404 NOT_FOUND
  already off    → 409 ALREADY_INACTIVE
  last admin     → 409 LAST_ADMIN   (assertNotLastActiveAdmin, shared with PATCH)
  otherwise      → UPDATE users SET status = 'Inactive'  → { id } "User deleted"
```

No hard delete, no schema change, no new role permission. `loadAuthUser` already rejects non-`Active` users, so a deleted account's JWT dies on its next request.

## Ticket statuses

```text
POST /api/tickets → Open   (assigneeId ignored; /assign removed — Phase 51)
POST .../updates (Waiting for spare) → Waiting for spare
POST .../updates (other visit, incl. "Site visit — resolved") → Under repair
POST .../updates { closeTicket: true } → Closed
POST .../close → Closed
```

Resolve is the `Site visit — resolved` update type (`visit_resolved`, `resolvedReady: true`); there is no `Resolved` status. A ticket closes only on `closeTicket: true` or `POST .../close`.

*Historical (removed in Phase 51 — `POST /:id/assign` now returns `404`; `GET /api/lookups/technicians` remains as the `FIELD_ROLES` person list for Visited by and the Work report):* Assign (`POST /api/tickets/:id/assign`): `{ assigneeId, reason? }` → Active field role (**Technician / Engineer / Electrician**, `FIELD_ROLES`) only (`400 INVALID_ASSIGNEE`). **Neither Project manager nor Control room may hold a ticket** — a PM routes and closes, Control room raises and routes; neither attends. The role list is the shared `ASSIGNABLE_ROLES` constant in [`src/lib/ticket-access.ts`](src/lib/ticket-access.ts), consumed by both `assertEligibleAssignee` and `GET /api/lookups/technicians`, so the Hand to dropdown and the API cannot drift apart. It is intentionally narrower than `canAssignTickets` (Control room / Admin / PM), which governs who may *perform* an assign. Same assignee → `200 Already assigned` (no trail growth). Else transactional `assignee_id` + `ticket_assignments` + `ticket_events`; response `{ id, assigneeId, assigneeName, assignmentTrail }`. Detail `assignmentTrail` uses the same shape. Hand-to options: `GET /api/lookups/technicians` → `{ id, label, name, role, roads }`, where `label` is display-only and reads **`Name (Role)`** (`Jignesh Solanki (Technician)`). Road scope is deliberately **not** in the label — the old format appended `, <road>` only when the road was not "All roads", so entries silently changed shape and a missing road was ambiguous between "works everywhere" and "not shown". `roads` is still returned separately for any caller that needs scope. `name` is the wire value for assignee filters; `id` is what assign submits. Only the Assign/Reassign dropdowns consume `label`; `Work report` uses `name`.

Stored values: `Open` | `Under repair` | `Waiting for spare` | `Closed`. Do not write `New`.

Migration `007_ticket_status_open.sql` rewrites leftover `New` → `Open`.

“Open ticket” = any row with `status <> 'Closed'`. Since Phase 50 a device may hold several; the uniqueness rule moved from the ticket to the Open reported issue (migration `025_open_issue_per_device.sql` drops the `012` index).

## Ticket list presentation (`GET /api/tickets`)

Tabs (query `tab`):

| Tab key | Meaning |
|---------|---------|
| `open` | Raised, no update yet — `NOT_ATTENDED_SQL` (Phase 52; Phase 51's `open` was every non-Closed) |
| `urp` | At least one update — Under repair, Waiting for spare, legacy Open + assignee (Phase 52) |
| `cls` | Closed |

Any other `tab` value (e.g. `asg`) → `400 VALIDATION_ERROR`. `tabCounts` = `{ open, urp, cls }`; `over3Counts` = `{ open, urp }`. Optional `age=over3` limits `open` / `urp` to tickets raised more than 3 days ago (also applied to `tabCounts.open` / `.urp`; never to `tiles`).

List/export row `status` and tiles use presentation helpers (DB unchanged):

- `New` → display as `Open`
- Historical assigned + stored `Open` → list shows `Under repair` (legacy rows only; new tickets never get an assignee)
- Detail (`GET /api/tickets/:id`) still returns stored status (`New` normalized to `Open` only)

## Ticket list aging

`GET /api/tickets` row fields:

| Field | Meaning |
|-------|---------|
| `daysOpen` | Whole days from `raised_at` to `closed_at` (or now if still open) |
| `daysAfterClose` | Whole days since `closed_at`, or `null` if not closed |
| `updates` | Count of `visit_open`, `visit_resolved`, and `waiting_spare` events, plus legacy `reclassified` rows; raised/assigned/closed excluded; no actor-role filter. One `POST /api/tickets/:id/updates` creates exactly one event, and the on-site (found) issue is stored on that visit event |

List-only. Ticket detail still uses a “Days open” header fact, not `daysAfterClose`.

## List pagination (Tickets + Devices)

```text
Request page/limit (+ filters)
  → Auth + authorize(screen, v)
  → Scope (every ticket since Phase 51; device list/history are city-wide — no road filter)
  → SQL search/filters (incl. ticket tab/status; device derived status/repeats)
  → COUNT(*) for total (+ tile aggregates; device tiles ignore `status` so cards stay stable)
  → SELECT ... ORDER BY ... LIMIT/OFFSET
  → { data, pagination: { page, limit, total, totalPages }, tiles... }
```

Device status cards on the Device List screen call the same list API with `status=Working|Under repair|Not working` (exact strings). Do not navigate to tickets for those cards.
Shared helpers: [`src/lib/pagination.ts`](src/lib/pagination.ts) (`pageSchema`, `limitSchema`, `paginationMeta`, `sqlOffset`).

Defaults: `page=1`, `limit=10`. Allowed limits: `10|25|50|100`.

Routes: [`src/routes/tickets.ts`](src/routes/tickets.ts), [`src/routes/devices.ts`](src/routes/devices.ts). Export CSVs stay full-set (unpaginated).

## Slot View (Phase 53)

```text
GET /api/slot-view?q&page&limit          (authorize Slot View v)
  → FROM tickets t JOIN devices d JOIN roads r [WHERE q]
  → COUNT(DISTINCT t.device_id)              → pagination.total
  → GROUP BY d.id, r.name, COUNT(t.id)       → ticketCount (tickets, not issues)
  → slotLabelOrderBy('d', { natural: true }) → LIMIT/OFFSET

GET /api/slot-view/:slotId               (authorize Slot View v)
  → devices WHERE deviceLookupWhere (404 NOT_FOUND) + COUNT(tickets)
  → loadOpenDeviceTickets(device.id)         → Open reported issues of non-Closed tickets
  → dedupe by subCategoryId, keep ticket refs → unresolvedIssues

GET /api/tickets?device=:slotId          (existing list, All tickets v, device filter, no tab = all statuses)
  → Slot View "Tickets" section
```

| Piece | Location |
|-------|----------|
| Router | [`src/routes/slot-view.ts`](src/routes/slot-view.ts) mounted at `/api/slot-view` in `src/app.ts` |
| Slot Label order (plain / natural) | `slotLabelOrderBy` in [`src/lib/device-ref.ts`](src/lib/device-ref.ts) |
| Open issues per device | `loadOpenDeviceTickets` in [`src/lib/ticket-issues.ts`](src/lib/ticket-issues.ts) |
| Slot tickets | `device` query param on `GET /api/tickets` ([`src/routes/tickets.ts`](src/routes/tickets.ts)) |

No schema change: tickets link to slots only through `tickets.device_id`; existing indexes cover the grouping and the Open-issue lookup.

## Parts master & visit cost

```text
POST /api/tickets/:id/updates|close
  body.cost = labour only
  body.parts = uuid[]
  → resolvePartsCost (dedupe, active master rows)
  → eventCost = labour + SUM(amount)
  → ticket_events.cost + parts JSONB snapshot
  → ticket_event_parts rows
  → tickets.total_cost += eventCost
```

| Piece | Location |
|-------|----------|
| Migration | [`src/db/migrations/009_parts_amount.sql`](src/db/migrations/009_parts_amount.sql) |
| Helper | [`src/lib/parts-cost.ts`](src/lib/parts-cost.ts) |
| CRUD / list | [`src/routes/parts.ts`](src/routes/parts.ts), lookups |
| Update / close | [`src/routes/tickets.ts`](src/routes/tickets.ts) |

**FRONTEND CHANGE REQUIRED:** send part UUIDs; keep `cost` labour-only.

## Add Update (Phase 51: no assignment, Main/Sub resolution, add issues)

Supersedes the Phase 47 auto-assign flow (`resolveUpdateAssignee`, claim, `handoverToUserId`, `assertHolder` were deleted).

```text
POST /api/tickets/:id/updates
  { updateType, visitedBy, …, resolveIssueIds?, resolveCategoryIds?, addIssues?, closeTicket? }
  → auth + authorize(Update ticket, e)
  → ticket lookup (404 NO_TICKETS_AVAILABLE) → 409 CLOSED
  → closeTicket=true → Update ticket x (403 FORBIDDEN otherwise)
  → addIssues → resolveIssuePairs (400 INVALID_ISSUES)
  → withTransaction
       SELECT tickets … FOR UPDATE              (serialises concurrent updates; re-check Closed)
       appendTicketIssues(addIssues)            lib/ticket-issues.ts
         sub already on ticket → 409 ISSUE_ALREADY_ON_TICKET { issues[] }
         assertNoOpenIssueConflicts (other open ticket) → 409 OPEN_TICKET_EXISTS
         INSERT role='reported', status='Open', sort_order after existing
         (unique violation on idx_ticket_issues_one_open_issue_per_device → same 409)
       optional legacy found-issue replace (issues[])
       insert the one visit event (actor_user_id = caller)
       resolveIssueSelection(resolveIssueIds, resolveCategoryIds, event)
       closeTicket → resolveOpenTicketIssues    (rest of the Open issues, same event)
       parts/cost, status (Under repair | Waiting for spare | Closed + closed_at)
  → 201 { eventId, status, closed, addedIssues, resolvedIssues, openIssueCount }
```

| Code | When |
|------|------|
| `FORBIDDEN` (403) | No `Update ticket` `e`; `closeTicket` without `x` |
| `CLOSED` (409) | Ticket already Closed |
| `INVALID_ISSUES` (400) | Unknown issue id, issue of another ticket / a found issue, category with no reported row on this ticket, bad `addIssues` pair |
| `ISSUE_ALREADY_RESOLVED` (409) | Issue id not Open, or category with no Open sub left |
| `ISSUE_ALREADY_ON_TICKET` (409) | `addIssues` sub already on this ticket (any status) |
| `OPEN_TICKET_EXISTS` (409) | `addIssues` sub is Open on another ticket of the device |

Field roles: `FIELD_ROLES` in [`src/lib/permissions.ts`](src/lib/permissions.ts). Engineer role: migration `013_engineer_role.sql`; Electrician: `022_electrician_role.sql`.

### Per-issue resolution (Phase 49)

```text
POST /api/tickets/:id/updates   { …, resolveIssueIds?: uuid[] }
  → (all Add Update gates above, unchanged)
  → withTransaction
       SELECT tickets … FOR UPDATE            (serialises concurrent updates)
       insert the one visit event
       resolveTicketIssues(ids)               lib/ticket-issues.ts  (Phase 51: resolveIssueSelection)
         SELECT ticket_issues … FOR UPDATE WHERE ticket_id AND role='reported'
         count mismatch → 400 INVALID_ISSUES; any Resolved → 409 ISSUE_ALREADY_RESOLVED
         UPDATE status='Resolved', resolved_at, resolved_by_user_id, resolved_event_id=event
       closeTicket → resolveOpenTicketIssues  (rest of the Open issues, same event)
POST /api/tickets/:id/close → resolveOpenTicketIssues(close event)
GET  /api/tickets/:id → issuesReported[].{id,status,resolvedAt,resolvedBy}, workHistory[].resolvedIssues
GET  /api/dashboard   → downReasons from Open reported issues; openIssues, openTicketsCount
```

| Code | When |
|------|------|
| `INVALID_ISSUES` (400) | A `resolveIssueIds` entry is unknown, belongs to another ticket, or is a found issue |
| `ISSUE_ALREADY_RESOLVED` (409) | An entry is already Resolved (stale form or concurrent resolve) |

### Issue-level duplicate tickets (Phase 50)

```text
POST /api/tickets   { deviceId, issues[] }
  → resolveIssuePairs (400 INVALID_ISSUES) → device lookup (404) → slot_identifier (400)
  → assertNoOpenIssueConflicts(device, subIds)        routes/tickets.ts
       findOpenIssueConflicts                          lib/ticket-issues.ts
         Open reported ticket_issues on non-Closed tickets of the device ∩ subIds
       any hit → 409 OPEN_TICKET_EXISTS { ticketId, openTicketId, issues[] }  (mixed raise rejected whole)
  → withTransaction: ticket + replaceTicketIssues (device_id copied from ticket) + raised event
       unique violation on idx_ticket_issues_one_open_issue_per_device
         → rollback → re-run assertNoOpenIssueConflicts → same 409 (concurrent winner)
  → after commit: createNewTicketNotifications

GET /api/devices/scan | POST /api/devices/slot-mac
  → openTicketLateralSql()  (worst open ticket → currentStatus, openTicketId)
  → loadOpenDeviceTickets   (openTickets[] with Open reported issues only; unfiltered by visibility)

Dashboard / Device list / Device detail → openTicketLateralSql(alias)   lib/device-status.ts (no visFilter since Phase 51)
Roads list `down` → COUNT(DISTINCT t.device_id)
```

| Case | Result |
|------|--------|
| Same Open issue on an open ticket | `409 OPEN_TICKET_EXISTS` |
| Different issue | `201` new ticket |
| Issue only on a Closed ticket | `201` new ticket (Closed ticket untouched; no 7-day reopen) |
| Issue Resolved on a still-open ticket | `201` new ticket |

## Work report (Phase 31)

```text
GET /api/reports/work
  → authorize(Work report, v)
  → ticket_events by FIELD_ROLES actors (Technician|Engineer|Electrician)
  → person / road (rd.name) / date filters   (no ticket visibility filter since Phase 51)
  → people[] + view-shaped tickets tuples
```

| Piece | Location |
|-------|----------|
| Route | [`src/routes/reports.ts`](src/routes/reports.ts) |
| Aggregation | [`src/lib/work-report.ts`](src/lib/work-report.ts) |
| Export | `GET /api/reports/work/export` (same filters) |

**FRONTEND CHANGE REQUIRED:** wire WorkReport.jsx to this API (drop `data/workReport.js` mock).

## Device Sync (SmartPark)

```text
Client Sync Device
  → POST /api/device-sync  (authorize Device list c)
     Default roles with Device list c: Admin, Project manager, Technician, Engineer
  → INSERT device_sync_runs status=started
  → 202 { id, status }
  → setImmediate background job (does not block HTTP)
       → GET {DEVICE_SYNC_BASE_URL}/locations (Authorization Bearer)
       → insert new roads (match external_location_id / name)
       → GET .../qr-codes?status=all&page=1&per_page=50
       → total = data.summary.total; pages = data.pagination.last_page
       → per item: require Slot Id only → skip if missing; MAC/QR optional
       → upsert by slot_id: create | update MAC/QR/road/label when changed | no-op if unchanged
       → status completed | failed
```

| Piece | Location |
|-------|----------|
| Migration | [`src/db/migrations/010_device_sync.sql`](src/db/migrations/010_device_sync.sql), [`011_slot_id_unique.sql`](src/db/migrations/011_slot_id_unique.sql) |
| Client | [`src/lib/device-sync-client.ts`](src/lib/device-sync-client.ts) |
| Runner | [`src/lib/device-sync.ts`](src/lib/device-sync.ts) (`scheduleDeviceSync` / `upsertDevice`) |
| Routes | [`src/routes/device-sync.ts`](src/routes/device-sync.ts) |
| Env | `DEVICE_SYNC_BASE_URL`, `DEVICE_SYNC_API_TOKEN` |

APIs: `POST /api/device-sync`, `GET /api/device-sync/latest`, `GET /api/device-sync/:id`. Background processing reuses in-process `setImmediate` + `device_sync_runs` (no external queue).

Synced locations are written into the existing `roads` table (single source of truth). `GET /api/roads` and `GET /api/lookups/roads` are thin reads of that table — no separate sync-roads API.

Field mapping (external → DB): `slot.id` → `slot_id` (**immutable** match key; **only required** sync field), `slot.slot_label` → `slot_number` (fallback `String(slotId)`), `mac_address` → `slot_identifier` (optional; null does not wipe existing), `qr_number` → `qr_code` (optional; placeholder `UNLINKED-SLOT-{slotId}` if empty), `parking_location` → `roads` / `road_id`. Same Slot Id + changed MAC/QR updates the existing row; duplicates prevented by unique `slot_id`. Ticket/device APIs expose Slot Id as `deviceId` when available (`deviceDisplayId`); `GET /api/devices/:deviceId` resolves by `public_id`, UUID, or Slot Id text (`deviceLookupWhere`). Device CSV “Device ID” prefers Slot Id the same way.

## New-ticket notifications and browser push

```text
POST /api/tickets succeeds
  → ticket + raised event are written
  → notifications service resolves eligible Active recipients
  → Admin / Project manager / Control room with All tickets v
  → one `ticket.raised` row per recipient (unique event key)
  → `/tickets/TK-xxxx` link always openable (canOpen: true — every ticket is visible since Phase 51)
  → setImmediate Web Push delivery when VAPID is configured
       → skip recipients with users.push_notifications_enabled = FALSE (Phase 54)
       → send to every active browser subscription for that recipient
         (notification.silent = NOT users.play_notification_sound)
       → 404/410 → delete expired subscription
       → success → set notifications.push_sent_at
```

Notification persistence runs after ticket creation and is wrapped separately by the ticket route. A notification database or push failure is logged but never changes the successful `201 Ticket raised` response or rolls back the ticket. Failed ticket requests never enter notification creation.

| Piece | Location |
|-------|----------|
| Migration | `src/db/migrations/019_notifications.sql` (`notifications`, `push_subscriptions`) |
| Service | `src/lib/notifications.ts` |
| Routes | `src/routes/notifications.ts` mounted at `/api/notifications` |
| Ticket hook | `src/routes/tickets.ts` after the raise transaction commits |
| Config | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |

No WebSocket, SSE, service worker, external queue, or second permission system is introduced. Web Push reuses the existing in-process `setImmediate` background pattern. The frontend owns browser permission and must provide its own service worker; the backend only stores the resulting subscription and sends encrypted Web Push payloads. The sibling frontend Phase 39 integration now consumes these APIs, relays notification IDs for authenticated read-state updates, and renders the shared unread badges.

### Notification preferences: browser permission vs application preference (Phase 54)

There are two independent layers. The backend owns only the second:

| Layer | Owner | Stored | Effect |
|-------|-------|--------|--------|
| Browser permission (`granted` / `default` / `denied`) | The user's browser | Nowhere on the server | Whether that one browser can show a notification |
| Application preference (`push_notifications_enabled`, `play_notification_sound`) | This API, per user | `users` (migration `027`, default `TRUE`) | Whether the user gets push at all, and whether it asks for sound |

- **Read:** `loadAuthUser` selects both columns in its existing query (no extra round trip). `toClientUser` exposes them as `notificationPreferences` on login and `/me`.
- **Write:** `PATCH /api/auth/me/notification-preferences` (`requireAuth`, strict Zod, `COALESCE` partial update). The user is always `req.user.id`, so nobody can change another user's preferences.
- **Enforce:** `deliverNotificationPush` adds `u.push_notifications_enabled = TRUE` to the single recipient/subscription JOIN, so the check costs no extra queries and is user-level. Every row in `push_subscriptions` for that user (desktop, laptop, any browser) is skipped together. The client can never re-enable delivery by itself.
- **Sound:** `u.play_notification_sound` is selected in the same query and becomes `notification.silent` / `data.playSound` in the payload. It never affects whether a push is sent.
- **Subscriptions:** turning push OFF does not delete subscriptions (no churn; turning it back ON works straight away). Logout deletes only that browser's row through the existing `DELETE /push-subscriptions/:id`. `404`/`410` cleanup is unchanged.
- Suppressed notifications keep `push_sent_at = NULL` and are not replayed later; the in-app row and unread count still work.

| Piece | Location |
|-------|----------|
| Migration | `src/db/migrations/027_user_notification_preferences.sql` |
| Read / client shape | `src/middleware/auth.ts` (`loadAuthUser`), `src/routes/auth.ts` (`toClientUser`) |
| Write | `src/routes/auth.ts` `PATCH /me/notification-preferences` |
| Enforcement | `src/lib/notifications.ts` `deliverNotificationPush` |
| Smoke | `scripts/smoke-notification-preferences.ts` (`npm run test:smoke:notification-prefs`) |

Deploy order: run `npm run db:migrate` before starting the new build. `loadAuthUser` reads the new columns on every authenticated request.

## Ticket-scoped read state (assignment notifications removed in Phase 51)

Phase 51 deleted `createTicketAssignmentNotification`; nothing creates `ticket.assigned` / `ticket.reassigned` any more. Existing rows of those types stay in `notifications` and remain listable / readable by their recipients. The Phase 42–48 assignment-notification material below is kept as history.

```text
User opens /tickets/:ticketId
  → POST /api/notifications/ticket/:ticketId/read
  → markTicketNotificationsRead(userId, ticketId)
  → UPDATE only rows WHERE recipient_user_id = current user AND read_at IS NULL
  → returns { updated }; 0 means nothing unread, so no row is rewritten
```

*Historical (before Phase 51):* assignment notifications were raised from the same three call sites that changed `tickets.assignee_id`, each after its own transaction commits and wrapped in its own try/catch, so a notification failure is logged but never rolls back or fails the assignment:

| Assignment path | `src/routes/tickets.ts` | Notification kind |
|---|---|---|
| Raise with `assigneeId` | after the raise transaction | `assigned` |
| `POST /:ticketId/assign` | after the assign transaction | `assigned` / `reassigned` |
| Update `handoverToUserId` | after the update transaction | `reassigned` |

`POST /:ticketId/assign` already returns early when the assignee is unchanged, so a no-op assign produces no notification.

### Role classification

Two separate role lists exist, because the two events have different business rules:

| List | Roles | Used by |
|---|---|---|
| `NEW_TICKET_NOTIFICATION_ROLES` | Admin, Project manager, Control room | `ticket.raised` **fan-out** (unchanged) |
| `NOTIFICATION_DELIVERY_ROLES` | the above **+ `FIELD_ROLES`** (Technician, Engineer, Electrician) | Web Push delivery + frontend bell eligibility |

Field roles were added to the delivery list when they were the only assignable roles; Phase 51 keeps them there so their historical `ticket.assigned` rows stay deliverable and readable. They still do **not** receive `ticket.raised` alerts. `Site attendant` and `AMC officer` are excluded from both, because they are never eligible assignees.

### Assignment on update (Phase 47 — removed in Phase 51)

*Historical:* an Add Update on an unassigned ticket assigns it inside the update transaction: a field role (`FIELD_ROLES`) claims it for themselves, and Admin/PM must name the assignee via `handoverToUserId` (otherwise `409 TICKET_NOT_ASSIGNED`). The claim is written to `ticket_assignments` (`Auto-assigned on update` / `Assigned on update`) and, after commit, fires the same `ticket.assigned` notification as a first assign, keyed on the update's event id. An already-assigned ticket is never reassigned by an update except through an explicit Admin/PM/Control room handover.
