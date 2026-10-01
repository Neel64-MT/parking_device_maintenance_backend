# Project Requirements — Parking Device Maintenance API

## What to build

A Node.js + Express + TypeScript REST API that backs the existing React design-preview frontend for **AMC flap-based parking device maintenance** (~1,000 devices across 5 Ahmedabad roads).

The frontend remains **unchanged unless explicitly authorized**. The API supplies every screen’s data and mutations so the UI can be wired later without redesign.

## Target Users

| Role | Purpose |
|------|---------|
| Admin | Full control including users and masters |
| Project manager | City-wide ops; can approve Pending signups and manage users (Users `vce...`); cannot delete masters |
| Control room | Raise tickets and watch every ticket; does not close or edit masters |
| Technician | Scan any road; update/close any open ticket (Phase 51 — no holder); sees every ticket |
| Site attendant | Scan QR and raise tickets on any road; sees every ticket; Device Sync; Issue master CRUD |
| AMC officer | View-only everywhere |
| Custom roles | Created via Roles & permissions UI |

**Login:** Email or 10-digit mobile plus password. Self-signup creates `Pending` users (Site attendant) until Admin or Project manager approves via Users.

## Features (API-backed)

1. **Authentication** — Email or mobile + password, JWT session, logout, current user (`/me`), forgot password, reset password
2. **Authorization** — Screen × flag matrix (`v c e a x d`), road scope (no ticket holder since Phase 51)
3. **Dashboard** — Fleet status, down reasons, road-wise status, oldest open tickets
4. **Tickets** — List (tabs `open` / `urp` / `cls` since Phase 52, filters, `age=over3`), raise, detail, site-update, close (assign removed in Phase 51 — see "Main/Sub issue resolution and no assignment"); duplicates detected by issue (Phase 50): the same Open issue on the same device → `409 OPEN_TICKET_EXISTS` with `openTicketId` + `details.issues`, a different issue → new ticket (a device may hold several open tickets), a raise after close → new ticket (no reopen); raise requires Slot Identifier (`400 SLOT_IDENTIFIER_REQUIRED` if missing). **Multiple issues:** raise/update/close accept `issues: [{ categoryId, subCategoryId }, …]` (legacy single pair still works); detail returns `issuesReported` / `issuesFound`; primary pair kept on ticket scalars. List rows include `daysOpen` and `daysAfterClose` (whole days since `closed_at`, or `null` if still open). **Pagination:** `page`/`limit` with default `page=1`, `limit=10`; allowed limits `10|25|50|100`; DB `LIMIT`/`OFFSET` after visibility + filters; response `pagination: { page, limit, total, totalPages }`. **Statuses:** `Open`, `Under repair`, `Waiting for spare`, `Closed` (no `New`). **Visibility (Phase 51):** every user with `All tickets` `v` sees every ticket on every road. **Add Update (Phase 51):** any user with `Update ticket` `e` may post to any non-Closed ticket (no assignee, no holder); `closeTicket: true` additionally needs `x`; required `visitedBy` (active Technician or Engineer UUID) with structured `VALIDATION_ERROR` field details.
5. **Devices** — List, add, history, QR scan/lookup (`GET /api/devices/scan?q=`), QR label PNG, export; optional `latitude` / `longitude` (TEXT). **List / export / history are city-wide** for every role with Device list/history view (not filtered by `assigned_roads`). Open-ticket overlays on list/history remain ticket-visibility scoped. Create/PATCH keep `assertRoadAccess`. Scan and ticket raise use `assertRoadAccessUnlessFieldWork` (Site attendant / Technician bypass). **Status cards:** click Working / Under repair / Not working → same Device List with `?status=` (exact labels; SQL `derived_status` filter); not the Ticket page. Tile counts stay stable when `status` is set. **Pagination:** same `page`/`limit` rules as tickets (DB-level after status/repeats filters). **Device Sync** — `POST /api/device-sync` starts an async import from SmartPark (locations → roads, then QR pages → devices); poll `GET /api/device-sync/:id` or `/latest` for `started` / `completed` / `failed`.
6. **Issue master** — Categories / sub-categories with severity; hard-delete unused categories and subs (`Issue master` `d`); deactivate if used (`409 IN_USE`); create/patch names trimmed `min(2)`/`max(120)`; sub create requires active parent category
7. **Parts master** — Active parts with `amount` (`NUMERIC(12,2)`); list/lookups return `{ id, name, amount }`; create/patch via `/api/parts` (Issue master `c`/`e` or Technician/Engineer); hard-delete unused via `DELETE /api/parts/:id` (`Issue master` `d`); used → `409 IN_USE` (deactivate instead)
8. **Road master** — CRUD roads; sequential `RD-xx` codes
9. **Users & roles** — Create/edit/inactivate users; Admin and Project manager may approve Pending signups, update details/role/password via `PATCH /api/users/:id`; role permission matrix; never hard-delete users. **List visibility:** the authenticated user's own account is never returned, and a non-Admin viewer never receives Admin-role accounts (SQL-level, applies to search and status filters). **Delete:** `DELETE /api/users/:id` requires Users `d` (Admin) and deactivates the account (`status = 'Inactive'`); self-delete is rejected with `400` / `SELF_DELETE_FORBIDDEN`.
10. **Work report** — Day/week/month/range field-staff load and outcomes via `GET /api/reports/work` (`view`, `from`, `to`, `person`, `road`). Actors: Technician and Engineer. Road filter uses road name. Detail `tickets` tuples are view-shaped (day = per-event TK- rows; week/range = per-day; month = per-week). Export: `GET /api/reports/work/export` with the same filters (CSV).
11. **Lookups** — Roads, technicians, parts (with amount), issue categories, road slots
12. **Uploads** — Multipart photos for tickets/devices
13. **Exports** — CSV for tickets, devices, roads, work report
14. **Notifications** — Persistent new-ticket alerts, unread/read APIs, VAPID browser subscriptions, and non-blocking Web Push for eligible Admin / Project manager / Control room users

### QR scan & raise-ticket requirements

- After scanning a QR / device code, clients call `GET /api/devices/scan?q={identifier}` for legacy PD/QR/slot codes (canonical scan-details API; no separate `/scan-details` path).
- Sticker QR tokens: `POST /api/devices/slot-mac` with `{ "qr_token": "..." }` — backend calls SmartPark `get-slot-mac`, matches local device by **`mac_id` → `slot_identifier`**, returns the same scan payload (+ `macId`, `bleMac`). FE must not call SmartPark directly.
- Scan response includes: `deviceId` (Slot Id preferred), `deviceName`, `locationSite`, `slot`, `slotId`, `slotLabel`, `slotIdentifier`, `currentStatus`, `statusDate`, `ticketsLast6Months`, `openTicketId`, `openTicketAge`, `openTicketIssue`, `latitude`, `longitude` (plus legacy fields for older clients).
- Branch: `openTicketId` set → open that ticket and use `POST /api/tickets/:id/updates`; else `POST /api/tickets` with scan `deviceId` / `deviceUuid` / `publicId` (not QR alone).
- A device (and thus its Slot Id when set) may have at most one non-`Closed` ticket. Raising another returns `409` / `OPEN_TICKET_EXISTS` with `details.openTicketId` (and `ticketId`). Enforced by app pre-check + DB unique index `012_one_open_ticket_per_device.sql`.
- Raising a ticket requires a non-empty Slot Identifier (`devices.slot_identifier`). Missing/blank → `400` / `SLOT_IDENTIFIER_REQUIRED` (sync or set MAC on the device first).
- Scan `openTicketId` is not ticket-list visibility filtered (Raise vs Update must be reliable for any role with Scan QR; Site attendant / Technician need no road match).
- Device coordinates are optional TEXT on create/PATCH; seed includes Ahmedabad-area dummy values.
- Manual device create/PATCH may set `slotIdentifier` (MAC) and `qrNumber` when Device Sync is unavailable. **Slot Id is never editable** via create/PATCH (`slotId` in body is ignored; only Device Sync writes `slot_id`).

### Device Sync requirements

- Frontend **Sync Device** calls `POST /api/device-sync` (JWT + `authorize('Device list', 'c')`). Default roles with sync: Admin, Project manager, **Technician**, **Engineer**.
- Handler returns **202** immediately with a sync run (`started`); work continues in the background (non-blocking via `setImmediate`).
- Flow: fetch SmartPark `/locations` → insert new `roads` only → then page QR codes (`status=all`, `per_page=50`) using `data.summary.total` / `data.pagination.last_page` → create/update devices by stable **Slot Id** (`slot_id` = external `slot.id`).
- **Validation:** every QR record must have a Slot Id (`slot.id`). Missing Slot Id → skip that record; one skip does not stop the run. MAC and QR are optional — when they change for the same Slot Id, the existing device row is updated.
- **Existing Slot Id:** match on `slot_id`; never create a duplicate. Incoming MAC/QR/label/road update the same row when present and different. Null/empty MAC does not clear an existing MAC.
- Incomplete sync records never delete or disable existing devices — ticket raise/update keep working on existing rows.
- Device columns: Slot Id (`slot_id`, **stable** — never overwritten after first sync; **required** sync identity), Slot Label (`slot_number`, fallback to Slot Id text if label omitted), Slot Identifier (`slot_identifier` ← external `mac_address`, optional), QR Number (`qr_code`, may change; placeholder if omitted), Parking Location (`road_id` → roads). Device `public_id` remains internal/DB-only for uniqueness; APIs prefer Slot Id for display and links.
- Tickets list/detail/dashboard/reports expose `deviceId` as **Slot Id** (fallback to `public_id` only for legacy seed rows without `slot_id`).
- Device history `GET /api/devices/:deviceId` resolves by `public_id`, UUID, or Slot Id text; response `header.id` prefers Slot Id. Devices CSV “Device ID” column uses the same display rule. Create/PATCH device responses expose `id` (Slot Id preferred), `publicId`, and `slotId`.
- Acceptance (smoke): list/detail `deviceId` equals `slot_id` when present; `GET /api/devices/{slotId}` returns 200; legacy `GET /api/devices/PD-xxxx` still works when `slot_id` is null; PATCH by Slot Id + create without `slot_id` return mapped ids.
- Idempotent: re-running sync does not duplicate roads/devices; updates existing devices’ sync fields only.
- Status: `GET /api/device-sync/:id` and `GET /api/device-sync/latest` (`started` | `completed` | `failed`).
- Config: `DEVICE_SYNC_BASE_URL`, `DEVICE_SYNC_API_TOKEN` (sent as `Authorization: Bearer …` with `Accept: application/json` and `Cache-Control: no-cache`). Locations path: `/locations`. Optional `SMARTPARK_API_BASE_URL` (default `https://v2smartpark.mtapps.in/api/v1`) for `get-slot-mac`.
- Synced locations upsert into `roads` (single source of truth). Existing `GET /api/roads` / `GET /api/lookups/roads` already return them — no sync-specific road API.

**FRONTEND:** Device list road filter reads `GET /api/lookups/roads` (same `roads` table) and refetches after sync. **Still FRONTEND CHANGE REQUIRED:** Road master / TicketList mocks → `/api/roads` or lookups when authorized.

### Multi-issue ticket contract

- Raise, update, and close accept `issues: [{ categoryId, subCategoryId }, …]`; legacy single `categoryId` / `subCategoryId` remains accepted.
- `ticket_issues` stores ordered `reported` and `found` issue rows; scalar ticket columns retain the primary pair for compatibility.
- Ticket detail returns `issuesReported` / `issuesFound`; raise returns the raised `eventId` for the photo-attachment flow.
- Issue master hard-delete usage checks include `ticket_issues`.

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
- “Open ticket” means `status <> 'Closed'`, not status `Open` only (a device may hold several — Phase 50).
- Existing `New` rows migrated to `Open` (`007_ticket_status_open.sql`).

**FRONTEND CHANGE REQUIRED:** All Tickets / detail badges must show `Open`, not `New`. Closed-tab aging can use list field `daysAfterClose` (do not recompute from dates in the browser unless needed). Trust list `status` for Assigned-tab pills vs Under repair tile alignment.

### Ticket visibility requirements

- Admin and Project manager retain city-wide ticket list/detail/export access.
- Every other role may only access tickets assigned to them or raised by them.
- Restrictions are enforced server-side on ticket list, export, detail, update, and close.
- The same visibility scope applies to dashboard ticket metrics, device open-ticket overlays/history counts, and work report ticket rows/export.
- Assign (`POST /api/tickets/:id/assign`) is **Control room, Admin, or Project manager only**. Technicians cannot assign, reassign, or handover. Assign is road-scoped so Control room can route tickets they did not raise. Assignee must be an Active Technician / Engineer / Control room / Project manager (`400 INVALID_ASSIGNEE` otherwise). Same assignee is idempotent (`Already assigned`, no trail growth). Response includes `assigneeId`, `assigneeName`, `assignmentTrail`. Detail returns the same trail from `ticket_assignments`. **FRONTEND CHANGE REQUIRED:** Ticket Detail Save → this API; Hand to → `GET /api/lookups/technicians`.
- Frontend role filtering is presentation only; never the security boundary.

### Ticket list aging fields

- `GET /api/tickets` each row: `daysOpen` (raised → closed or now) and `daysAfterClose` (now → `closed_at`, or `null` if not closed).
- `daysAfterClose` is list-only (not ticket detail). Display only — the 7-day reopen rule was removed in Phase 50.
- List tiles (`underRepair`, `waitingSpare`, `openOver3`) and CSV export use the same list presentation status rules as row `status`.

### List pagination requirements

- `GET /api/tickets` and `GET /api/devices` paginate at the database (`LIMIT`/`OFFSET` + `COUNT`), never by loading all rows into memory.
- Defaults when omitted: `page=1`, `limit=10`.
- Allowed `limit` values only: `10`, `25`, `50`, `100` (others → Zod 400).
- Response keeps `pagination: { page, limit, total, totalPages }` (no duplicate `hasNextPage` fields).
- Ticket `total` / pages respect visibility (Admin/PM all; others assignee/raiser) after search/filters.
- Users/Roads lists remain unpaginated (no table consumer yet).

**FRONTEND CHANGE REQUIRED:** TicketList service default `limit` is still 50 and UI hardcodes 100 — align to allowed limits and use `pagination` for a pager when authorized.

### Device list order (Phase 41)

- `GET /api/devices` (and `GET /api/devices/export`) return rows ordered by **Slot Label ascending** (`devices.slot_number`), so the order is correct on every page rather than within a page only.
- Order is applied in SQL via one shared constant, `DEVICE_LIST_ORDER_BY` = `ORDER BY (slot_number = ''), slot_number, public_id`: blank labels last, `public_id` as the stable tie-break.
- `slot_number` is a plain zero-padded `TEXT`, so plain ascending order is the expected Slot Label order; no natural-sort dependency is added.
- Ticket list order stays `raised_at DESC` (the ticket list has no Slot Label column; its order drives the Open / Assigned / Closed tabs).

### Parts master & visit cost

- `parts.amount` is authoritative; seed and CRUD set prices.
- Ticket update/close accept `parts: uuid[]` and labour-only `cost`. Server computes `eventCost = labourCost + SUM(selected active part amounts)` (dedupe IDs), stores JSONB snapshot `[{ id, name, amount }]` plus `ticket_event_parts`, and adds `eventCost` to `tickets.total_cost`.
- Client-supplied part prices are ignored; unknown/inactive part IDs → `400` / `INVALID_PARTS`.
- Hard-delete unused parts: `DELETE /api/parts/:id` (`Issue master` `d` — Admin, PM, Technician, Engineer). Referenced in `ticket_event_parts` → `409` / `IN_USE` (deactivate instead). Soft: `PATCH { active: false }`.
- Hard-delete unused issue categories: `DELETE /api/issues/categories/:id` (`Issue master` `d`). Tickets/events referencing the category or any of its subcategories → `409` / `IN_USE` (deactivate via `PATCH { active: false }` instead). Unused subs cascade on category delete. Sub create rejects missing (`404`) or inactive (`400 CATEGORY_INACTIVE`) parent.

**FRONTEND CHANGE REQUIRED:** PartChips must send part UUIDs (not names). The update/close `cost` field must be labour / non-part charges only — do not pre-add part prices into `cost`. PartMaster Delete → `DELETE /api/parts/:id`; on `IN_USE` offer deactivate. Image zoom/crop stay FE-only. IssueMaster: add `createIssueCategory`, `createIssueSubcategory`, `deleteIssueCategory` in `issues.js`; Delete unused category → `DELETE /api/issues/categories/:id`; on `IN_USE` offer deactivate.

### Add Update: auto-assign and close with update (Phase 47)

- **Field roles** (`FIELD_ROLES`: Technician, Engineer, **Electrician** — new role, migration `022`) can raise tickets (`023` guarantees `Raise ticket` `v`+`c`). `assigneeId` on raise stays optional; when sent it must be an eligible field worker (`400 INVALID_ASSIGNEE`).
- `POST /api/tickets/:id/updates` on an **unassigned** ticket:
  - field role → the ticket is assigned to the authenticated updater (their user id), even if they did not raise it — this is how the QR flow (`openTicketId` → update) works;
  - Admin/PM → must send `handoverToUserId` (eligible assignee), else `409` / `TICKET_NOT_ASSIGNED` / "Select an assignee to update an unassigned ticket";
  - other roles → `409 TICKET_NOT_ASSIGNED`.
- On an **assigned** ticket the assignee never changes automatically; access stays Admin/PM, assignee or raiser (others `403`).
- New optional `closeTicket: boolean` (default `false`). Only `true` closes: needs `Update ticket` `x` + ticket holder (`403 NOT_HOLDER` otherwise); the ticket becomes `Closed` with `closed_at`, and the single update event (`status_label: "Closed"`) appears in `workHistory`. Omitted/`false` keeps the ticket open.
- Resolve = `updateType: "Site visit — resolved"` (`resolvedReady: true`); it does **not** close unless `closeTicket: true`. No `Resolved` status.
- Claim + update + close run in one transaction with a row lock; a concurrent claim loses with `409` / `TICKET_ALREADY_ASSIGNED`.
- A claim sends the existing `ticket.assigned` notification after commit.
- Response adds `assigneeId`, `autoAssigned`, `closed`; existing fields unchanged.
- One Add Update request produces exactly one work-history entry. If the on-site issue changes, the found issue is stored on that visit entry (and in `ticket_issues`); the API must not add a second `Issue reclassified` entry.
- Photos may still be attached (`PATCH …/updates/:eventId/photos`) to the author's own closing update after the ticket closed.

**FRONTEND CHANGE REQUIRED:** remove the client-side "no assignee / not assigned to you" gate for field roles in `TicketUpdate.jsx`; add Close Ticket Yes/No (default No) sending `closeTicket`; Admin/PM assignee picker on unassigned tickets sent as `handoverToUserId`; toast `TICKET_ALREADY_ASSIGNED` and reload.

### Per-issue Open/Resolved (Phase 49)

- Every **reported** issue (`issuesReported[]`) now has `id` and `status` (`Open` / `Resolved`, plus `resolvedAt`, `resolvedBy`). Migration `024_ticket_issue_status.sql`; legacy single-issue tickets are backfilled with a resolvable row; issues on Closed tickets start Resolved.
- `POST /api/tickets/:id/updates` accepts optional `resolveIssueIds: uuid[]`. Each id must be an Open reported issue **of this ticket**: unknown / other ticket's id → `400 INVALID_ISSUES`; already resolved (including a concurrent loser) → `409 ISSUE_ALREADY_RESOLVED`. Checked after the existing authorization and inside the existing row-locked transaction; a rejection writes nothing.
- One update may resolve several issues. Resolving the last one does **not** close the ticket; `closeTicket: true` or `POST /:id/close` resolves any still-Open issues with the closing event.
- `workHistory[].resolvedIssues` shows which update resolved which issue. Update response adds `resolvedIssues` and `openIssueCount`.
- Dashboard `downReasons` counts Open reported issues on open tickets (resolved issues drop out); new `openIssues` / `openTicketsCount`. Device status and ticket counts are unchanged.
- No new notifications; Control room still needs `Update ticket` `e` (not granted by default) to add any update.

### Issue-level duplicate tickets (Phase 50)

- Duplicate key is **device + Open reported issue**, not device. Same Open issue → `409 OPEN_TICKET_EXISTS` (`details.openTicketId` / `ticketId` as before, plus `details.issues[]` listing every duplicate); a mixed selection is rejected whole. A different issue, an issue only on a Closed ticket, or one already Resolved on a still-open ticket → `201` new ticket. A device may now hold several open tickets.
- The 7-day `REOPEN_SAME_TICKET` rule is removed: a raise never reopens or modifies a Closed ticket.
- Migration `025_open_issue_per_device.sql`: `ticket_issues.device_id` (backfilled), stray Open issues on Closed tickets → Resolved, drops `idx_tickets_one_open_per_device`, adds partial unique `idx_ticket_issues_one_open_issue_per_device (device_id, subcategory_id) WHERE role='reported' AND status='Open'`. Concurrent same-issue raises: exactly one `201`, the other `409`.
- Scan (`/scan`, `/slot-mac`) adds `openTickets: [{ id, status, assigneeId, age, issues[] }]` (Open issues only); `openTicketId` / `openTicketIssue` / `openTicketAge` stay (worst ticket).
- Device status (Dashboard, Device list, Device detail, scan) = the **worst** open ticket via shared `openTicketLateralSql`; a device with several open tickets counts once. Device list rows add `openTicketCount`. Roads `down` counts distinct devices. Device-detail days-down starts at the earliest open raise.
- Updates are unchanged: several authorized users can resolve different issues on the same ticket; nothing creates a ticket on update. Notifications unchanged (new ticket notifies, `409` / update do not).
- Smoke: `npm run test:smoke:multi-ticket` (cases 1–12); `smoke-writes` adds a different-issue `201` case.

**FRONTEND CHANGE REQUIRED (done, frontend Phase 50):** Raise drops the device-level block, lists open tickets with their open issues, pre-checks same-issue duplicates and handles `details.issues`; QR Update picks among several open tickets and links to raise a different issue.

### Main/Sub issue resolution and no assignment (Phase 51)

Supersedes the holder / auto-claim rules of Phases 18, 46 and 47 above (those sections are kept as history).

- **Resolve by group:** `POST /api/tickets/:id/updates` accepts `resolveCategoryIds: uuid[]` (Main Issue — resolves every Open reported sub of that category on this ticket) and `resolveIssueIds: uuid[]` (single Sub Issue). The server resolves the union. Category not on this ticket / unknown id → `400 INVALID_ISSUES`; an issue id that is no longer Open, or a category with no Open sub left → `409 ISSUE_ALREADY_RESOLVED`. A partly resolved category resolves only its remaining Open subs.
- **Add issues on update:** `addIssues: [{ categoryId, subCategoryId }]` appends Open reported issues after the existing ones (they become resolvable in later updates, or in the same update by `resolveCategoryIds`). Sub already on this ticket → `409 ISSUE_ALREADY_ON_TICKET` with `details.issues`; sub Open on another ticket of the device → `409 OPEN_TICKET_EXISTS` (same `details` as raise). Response adds `addedIssues[]`.
- Everything is checked and written in one row-locked transaction; any rejection writes nothing. Resolving every issue never closes the ticket — only `closeTicket: true` (with `x`) or `POST /:id/close`.
- **No assignment:** `POST /api/tickets/:id/assign` is removed (`404`). Raise ignores `assigneeId` and always creates `Open`. No auto-claim, no handover, no `ticket_assignments` writes, no `ticket.assigned` notifications. Every user with `All tickets` `v` sees every ticket on every road (list, detail, export, dashboard, devices, reports); `Update ticket` `e` updates any open ticket; `x` closes. Photo attach on an event: its author or Admin/PM.
- List tabs are `open` and `cls` (`tab=asg` → `400`); `tabCounts { open, cls }`; `assignee` filter and `assignedTo` / `actionLabel` / `actionPrimary` removed. Detail drops `assigneeId` / `assignmentTrail`. Update response drops `assigneeId` / `autoAssigned`.
- **Historical data:** `tickets.assignee_id`, `ticket_assignments` and old assignment notifications are kept unchanged (no migration). An old Open ticket with an assignee still reads "Under repair"; old `assigned` events stay in work history.
- Smoke: `npm run test:smoke:issue-groups`, `npm run test:smoke:no-assignment`.

**FRONTEND CHANGE REQUIRED (done, frontend Phase 51):** grouped Resolve Issues panels with Another Issue / Add another issue; remove every Assign / Reassign surface, the Assigned tab and the QR assignee gate.

### Under repair tab and list age filter (Phase 52)

Supersedes the Phase 51 two-tab list (`open` = every non-Closed).

- List tabs: `open` = raised, no update yet (`Open` with no historical assignee); `urp` = at least one update (`Under repair`, `Waiting for spare`, or legacy Open + historical assignee); `cls` = Closed. `tab=asg` → `400`. Row `tab` uses the same rules.
- `status` narrows within the tab (`Under repair` / `Waiting for spare` / `All`); older values still work.
- `age=over3` (optional; other values → `400`) limits `open` / `urp` to tickets raised more than 3 days ago; ignored on `cls`.
- Response: `tabCounts { open, urp, cls }` (the `open` / `urp` counts respect `age`); new `over3Counts { open, urp }`; `tiles` unchanged (base filters only).
- Smoke: `npm run test:smoke:no-assignment` (Phase 52 block).

**FRONTEND CHANGE REQUIRED (done, frontend Phase 52):** three tabs, clickable summary cards (tab + status + age), Under-Repair-only status filter, sliding tab transition.

### Work report (Phase 31)

- `GET /api/reports/work?view=&from=&to=&person=&road=` — people-centric payload matching WorkReport UI; actors Technician + Engineer; road filter on `roads.name`; `days` / `daysInPeriod` from calendar; `tickets` view-shaped (day / week|range / month).
- `GET /api/reports/work/export` — same filters; CSV `Person,Ticket,Event,Cost,Road,When`.
- Visibility: every viewer with Work report `v` sees all events (Phase 51 — no assignee/raiser scoping).

**FRONTEND CHANGE REQUIRED:** Replace `REPORT` mock in WorkReport.jsx with `GET /api/reports/work`; Export → `/work/export`; Person options from lookups; gate page with Work report `v`.

### New-ticket notification requirements

- A successful `POST /api/tickets` creates one persistent `ticket.raised` notification for every Active user whose role is `Admin`, `Project manager`, or `Control room` and whose existing `All tickets` permission has `v`.
- Notification failure must not change or roll back a successful ticket response. Failed ticket requests must not create notifications.
- Stored content includes ticket reference, authorized detail link when applicable, road/slot/device, reported issue, raiser, and created time. It excludes description, photos, cost, email, and mobile.
- `GET /api/notifications` lists only the authenticated user's rows; `/unread-count`, `/:id/read`, and `/read-all` enforce the same ownership boundary.
- `GET /api/notifications/push-config` exposes VAPID availability/public key and whether the user has a stored subscription. Browser permission remains browser-controlled.
- `PUT` / `DELETE /api/notifications/push-subscriptions` manage multiple browser/device subscriptions; duplicate endpoints update in place and expired `404`/`410` push endpoints are removed.
- Web Push runs through the existing in-process `setImmediate` pattern. No WebSocket, SSE, service worker, or external queue is implemented by the backend.
- Notification event uniqueness prevents duplicate rows on repeated processing. `push_sent_at` prevents a delivered notification from being sent again.

**FRONTEND INTEGRATION COMPLETE:** the sibling frontend now owns the browser service worker, explicit permission action, VAPID `applicationServerKey` subscription, authenticated read-state relay, and shared unread badges on Tickets parent and All Tickets child. It uses the existing `/api/notifications` contract without adding a menu item or realtime transport.

### Assignment notification requirements

- Whenever `tickets.assignee_id` actually changes, the **newly assigned user** receives a persistent notification. Types follow the existing ticket-event wording: `ticket.assigned` (first assign, and raise with `assigneeId`) and `ticket.reassigned` (reassign, and update `handoverToUserId`).
- Only the new assignee is notified. The previous assignee is **not** notified on reassignment.
- If the assignee does not change, no notification is created. `POST /api/tickets/:id/assign` already short-circuits on an unchanged assignee, and the existing unique key `(recipient_user_id, type, related_entity_type, related_entity_id)` prevents duplicate rows.
- Messages: `Ticket TK-XXXX has been assigned to you.` / `Ticket TK-XXXX has been reassigned to you.`
- Stored `data` carries `ticketId`, `reference`, `url`, `canOpen: true`, `device` (id/road/slot), `issue` (reported category/subcategory/severity), and `assignedBy`. Read state and timestamps come from the notification row itself.
- Notifications are created in the backend after the owning transaction commits. A notification failure is logged and must not roll back or fail the assignment, reassignment, or update.
- Recipient must be Active and hold a role in `NOTIFICATION_DELIVERY_ROLES` (`Admin`, `Project manager`, `Control room`, `Technician`, `Engineer`). `ticket.raised` fan-out stays limited to the first three — field roles are added for delivery only, so an assignee is never un-alertable.

### Ticket-open read behavior

- `POST /api/notifications/ticket/:ticketId/read` marks every unread notification the **caller** holds for that ticket as read and returns `{ updated }`.
- Only the authenticated user's rows are affected. A user can never mark another user's notification read; the per-id route still returns `404` for someone else's notification.
- `updated: 0` means nothing was unread, so no row is rewritten. The unread badge reflects the change on the next `/unread-count` poll.
- This makes opening a ticket directly (not only via the bell) clear its unread notification, while leaving every other ticket's notifications untouched.

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
| Ticket notifications | `/api/notifications*` + service-worker Web Push |
| Devices | `/api/devices*`, especially `GET /api/devices/scan?q=`; Sync Device → `POST /api/device-sync` + status poll |
| Roads | `/api/roads*` |
| Issue master | `/api/issues*` |
| Users / roles | `/api/users*` (DELETE is a hard delete), `/api/roles*` — `DELETE /api/roles/:id` needs `Roles & permissions` `d` and returns `409 ROLE_IN_USE` while any Active or Pending account holds the role; Inactive accounts are exempt and become role-less, and reactivating one needs a new role (`409 ROLE_REQUIRED`) |
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
