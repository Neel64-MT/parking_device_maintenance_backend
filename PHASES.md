# Phases — Backend Implementation

## Phase 0 — Documentation

**Status:** Complete

## Phase 1 — Foundation

**Status:** Complete

**APIs:** `GET /api/health`

## Phase 2 — Database

**Status:** Complete

**Commands:** `npm run db:migrate`, `npm run db:seed`

## Phase 3 — Auth & Authorization

**Status:** Complete

**APIs:** `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`

## Phase 4 — Masters & Lookups

**Status:** Complete

**APIs:** `/api/roads*`, `/api/issues*`, `/api/parts`, `/api/lookups/*`

## Phase 5 — Users & Roles

**Status:** Complete

**APIs:** `/api/users*`, `/api/roles*`

## Phase 6 — Devices

**Status:** Complete

**APIs:** `/api/devices*`

## Phase 7 — Tickets

**Status:** Complete

**APIs:** `/api/tickets*`, `/api/uploads`

## Phase 8 — Dashboard & Work Report

**Status:** Complete

**APIs:** `/api/dashboard`, `/api/reports/work*`

## Phase 9 — Hardening

**Status:** Complete

**Tests:**
- `npm run test:smoke` — password login (mobile + email), validation 400, unauthorized 401, core GET APIs, Admin user create, logout revoke
- `npm run test:smoke:writes` — device/ticket lifecycle, road create, same-open-issue duplicate rule (Phase 50: different issue → new ticket), issue category/subcategory delete/IN_USE, uploads, user patch, dashboard/report

## Phase 10 — Postgres cutover + API verification

**Status:** Complete

- Real PostgreSQL via `DB_*` env
- Auth + domain APIs verified on Postgres
- Docs synced for later UI integration (no frontend changes)

## Phase 11 — Forgot Password & Admin Password Hardening

**Status:** Complete

**Objective:** Secure forgot/reset password APIs; invalidate sessions after password change; reuse Admin user PATCH for password updates.

**APIs:**
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `PATCH /api/users/:id` (password — existing, hardened)

**Database:** migrations `003_password_reset.sql`, `004_password_version.sql`

**Files:** `src/routes/auth.ts`, `src/routes/users.ts`, `src/middleware/auth.ts`, `src/lib/auth.ts`, `src/lib/mail.ts`, `src/config/env.ts`, `DESIGN.md`

**Testing:** `npm run test:smoke` covers forgot/reset/admin password + JWT `pv` invalidation + regression login

**Done when:** smoke passes; docs match implementation; frontend remaining as FRONTEND CHANGE REQUIRED only

## Phase 12 — Ticket Visibility + PM Signup Approval

**Status:** Complete

**Objective:** Restrict non-Admin/non-PM ticket access to assignee or raiser; let Project manager approve/edit Pending signups.

**APIs:** `/api/tickets*` (scoped), `/api/users*` (PM gains `c`/`e`)

**Database:** migration `006_pm_users_edit.sql`

**Files:** `src/lib/ticket-access.ts`, `src/routes/tickets.ts`, `src/lib/permissions.ts`

**Testing:** smoke covers tech list/detail scoping, PM city-wide access, PM approve Pending, tech forbidden on Users edit

**Done when:** smoke passes; docs match implementation; frontend remaining as FRONTEND CHANGE REQUIRED only

## Phase 13 — Ticket Scope Consistency (Dashboard / Devices / Reports)

**Status:** Complete

**Objective:** Ensure every ticket-related API uses the same visibility rule as tickets list/detail (Admin/PM = all; others = assignee or raiser). Close leaks on devices and work report; dashboard already scoped in Phase 12.

**APIs:**
- `GET /api/dashboard` — already scoped (no change)
- `GET /api/devices`, `/export`, `/scan`, `/:id` — open ticket + history/counts scoped
- `GET /api/reports/work`, `/work/export` — events/CSV scoped

**Files:** `src/routes/devices.ts`, `src/routes/reports.ts`, `src/lib/ticket-access.ts` (reuse), docs, `scripts/smoke-inprocess.ts`

**Testing:** smoke covers tech device open-ticket leak, CR dashboard + work report scoping, existing ticket visibility + CR assign

**Done when:** smoke passes; docs match implementation; frontend remaining as FRONTEND CHANGE REQUIRED only

## Phase 17 — QR Scan Payload & One-Open-Ticket Hardening

**Status:** Complete

**Objective:** Finalize scan-details contract for frontend QR flow; ensure seed lat/lng; surface `openTicketId` on duplicate-raise 409.

**APIs:**
- `GET /api/devices/scan?q=` — canonical fields (`deviceId`, `deviceName`, `locationSite`, `slot`, `currentStatus`, `statusDate`, `ticketsLast6Months`, open-ticket fields, `latitude`, `longitude`) + legacy shape
- `POST /api/tickets` — already enforces one open ticket; details now include `openTicketId` and `ticketId`

**Database:** no new migration (`latitude`/`longitude` already TEXT); seed updated

**Files:** `src/db/seed.ts`, `src/routes/devices.ts`, `src/routes/tickets.ts`, smoke scripts, docs

**Testing:** `npm run test:smoke` (scan canonical payload); `npm run test:smoke:writes` (OPEN_TICKET_EXISTS + openTicketId)

**Done when:** smoke passes; docs match; FRONTEND CHANGE REQUIRED for Scan QR wiring only

## Phase 24 — QR raise reuse harden (one-open DB + scan openTicketId)

**Status:** Complete

**Objective:** Keep reusing scan + raise + updates; harden concurrency and Raise vs Update signal.

**Changes:**
- Migration `012_one_open_ticket_per_device.sql` — partial unique index one non-`Closed` ticket per `device_id` (closes older duplicates first)
- Raise maps unique-violation → `409 OPEN_TICKET_EXISTS` with `openTicketId`
- Scan open-ticket join no longer applies ticket visibility filter (6m count still filtered)

**Testing:** smoke — QR scan `openTicketId`; tech scan surfaces open ticket; smoke-writes concurrent duplicate raise

**Done when:** smoke + smoke:writes pass; docs match; FRONTEND CHANGE REQUIRED — Scan QR → raise or update existing

## Phase 25 — Field-work road bypass (attendant raise / tech holder update)

**Status:** Complete

**Objective:** Site attendants may raise on any device/road; technicians may scan any road and update tickets they hold on any road. Do not flip role `scope` to `all_roads`.

**Changes:**
- `assertRoadAccessUnlessFieldWork` in `src/middleware/auth.ts` — skips road check for Site attendant / Technician
- Used on `GET /api/devices/scan` and `POST /api/tickets` only
- Device create/PATCH and ticket assign stay on `assertRoadAccess`
- Holder/raiser rules on update/close unchanged; list visibility unchanged

**Testing:** smoke — attendant scan+raise on non-assigned CG Road device (`PD-SMOKE-CG`); tech scan Makarba (`PD-SMOKE-MK`); tech update held TK-1078 after CR assign to Ramesh; tech update unrelated still 403

**Done when:** smoke passes; docs match; FRONTEND CHANGE REQUIRED — Scan QR should not assume road-mismatch for Site attendant / Technician

## Phase 26 — Device status-card → filtered Device List

**Status:** Complete

**Objective:** Status cards (Working / Under repair / Not working) filter the Device List via existing `GET /api/devices?status=` — not tickets; no new API.

**Changes:**
- `status` query enum: `All` | `Working` | `Under repair` | `Not working`
- Tile aggregates ignore `status` (cards stay stable); page rows + `pagination.total` remain status-filtered
- Smoke: Working/Under repair/Not working filters; invalid status 400; tiles unchanged under `status=Working`

**Done when:** smoke passes; docs match; FRONTEND CHANGE REQUIRED — wire status cards to `GET /api/devices?status=`

## Phase 27 — Device Sync Slot/MAC validation

**Status:** Complete

**Objective:** Harden Device Sync so incomplete SmartPark QR rows are skipped, existing Slot Ids get MAC updates without duplicates, and sync stays non-blocking.

**Analysis:** Reused `POST /api/device-sync`, `scheduleDeviceSync` (`setImmediate`), `upsertDevice`, and `idx_devices_slot_id_unique`. No new API/queue.

**Changes:**
- Require Slot details + non-empty `mac_address` before create/update; otherwise skip
- Existing `slot_id`: same MAC + same QR/road/label → no-op; different MAC → update existing row
- Preserve locations → QR page sequence; ticket flows untouched

**Files:** `src/lib/device-sync.ts`, docs

**Testing:** typecheck; existing device-sync authz/single-flight smoke. Manual (live token): missing Slot/MAC skipped; Slot 6582 MAC change updates one row; unchanged re-sync no unnecessary write; tickets still raise on existing devices.

**Done when:** validation rules documented; sync remains 202 + background; no duplicate Slot Id devices

## Phase 28 — Manual device edit (MAC / QR fallback)

**Status:** Complete

**Objective:** When Device Sync is unavailable, allow Edit Device to update MAC and QR via existing `PATCH /api/devices/:deviceId`. Slot Id remains not editable.

**Changes:**
- Create/PATCH accept optional `slotIdentifier` and `qrNumber`
- Never write `slot_id` from manual API (Zod omits `slotId`; ignored if present)
- QR claim releases conflicts from other devices (same pattern as sync)
- Smoke: PATCH MAC/QR; `slot_id` stays null when body includes `slotId`

**Files:** `src/routes/devices.ts`, smoke, docs

**Done when:** smoke passes; FRONTEND CHANGE REQUIRED — wire DeviceAdd Save to PATCH/POST

## Phase 29 — Device Sync Slot Id only required

**Status:** Complete

**Objective:** Slot Id is the only required identity for Device Sync records. MAC and QR may be absent or change; updates apply to the existing row for that Slot Id.

**Changes:**
- `collectIntendedFromItems`: require only `slot.id`; drop MAC-required skip
- Missing label → `String(slotId)`; missing QR → `UNLINKED-SLOT-{slotId}`
- Upsert: `COALESCE` MAC so null incoming does not wipe; update when MAC/QR change
- Docs/RULES: remove “MAC required on sync”

**Files:** `src/lib/device-sync.ts`, docs

**Testing:** existing device-sync smoke; manual — Slot Id without MAC still syncs; later MAC/QR change updates same row

**Done when:** docs match; `POST /api/device-sync` contract unchanged

## Phase 18 — Ticket Status Open (drop New)

**Status:** Complete

**Objective:** Align stored ticket status with the UI `Open` badge. Unassigned tickets must not use `New`.

**Statuses:** `Open` · `Under repair` · `Waiting for spare` · `Closed`

**APIs:** `POST /api/tickets` writes `Open` when no assignee; list tab `new` still means unassigned/`Open`

**Database:** migration `007_ticket_status_open.sql` (`UPDATE tickets SET status = 'Open' WHERE status = 'New'`)

**Files:** `src/routes/tickets.ts`, `src/db/seed.ts`, `src/lib/device-status.ts`, docs

**Done when:** docs match implementation; UI wiring of badge text remains FRONTEND CHANGE REQUIRED

## Phase 19 — Assign / Reassign Roles

**Status:** Complete

**Objective:** Technicians must not reassign or handover tickets. Only Control room, Admin, and Project manager may change the assignee.

**APIs:** `POST /api/tickets/:id/assign` + `handoverToUserId` on updates both call `assertCanAssignTickets`

**Database:** migration `008_tech_cannot_assign.sql` (Technician All tickets `can_assign = false`)

**Files:** `src/lib/ticket-access.ts`, `src/lib/permissions.ts`, `src/routes/tickets.ts`, smoke, docs

**Testing:** smoke — Control room assign still works; technician assign and handover return 403

**Done when:** smoke passes; docs match; FRONTEND CHANGE REQUIRED to hide technician handover UI

## Phase 20 — Ticket list days after close + list presentation

**Status:** Complete

**Objective:** Expose whole days since close on the ticket list; align Open/Assigned tabs and Under repair tile presentation without changing stored statuses.

**APIs:** `GET /api/tickets` / export
- Each row: `daysAfterClose: number | null` (`null` when `closed_at` is empty)
- Tab `new` = unassigned non-closed (not stored status `New`)
- List/export/tiles: assigned + stored `Open` presented as `Under repair` (`listStatus`; DB unchanged)

**Database:** none

**Files:** `src/routes/tickets.ts`, docs

**Done when:** docs match; FRONTEND CHANGE REQUIRED to bind closed-tab aging to `daysAfterClose` and trust list `status`

## Phase 21 — List API pagination (Tickets + Devices)

**Status:** Complete

**Objective:** Enforce DB-level pagination with default limit 10 and allowed limits 10/25/50/100; stop in-memory fetch-all + slice.

**APIs:**
- `GET /api/tickets` — `LIMIT`/`OFFSET` + `COUNT` after visibility and filters; tiles/tabCounts via SQL aggregates
- `GET /api/devices` — CTE with derived status; filter then count/page; export unpaginated

**Files:** `src/lib/pagination.ts`, `src/routes/tickets.ts`, `src/routes/devices.ts`, smoke, docs

**Testing:** smoke — default page/limit, allowed/invalid limits, page 2, tech total ≤ PM total

**Done when:** smoke passes; docs match; FRONTEND CHANGE REQUIRED for TicketList pager/defaults

## Phase 22 — Parts master amount + visit cost from selected parts

**Status:** Complete

**Objective:** Price parts on the Parts master; ticket update/close accept part UUIDs and compute visit cost server-side (`labour cost` + sum of master amounts). Persist JSONB snapshot + `ticket_event_parts` junction; never trust client part prices.

**APIs:**
- `GET /api/parts` / `GET /api/lookups/parts` — `{ id, name, amount }`
- `POST /api/parts`, `PATCH /api/parts/:id` — Issue master `c` / `e`
- `POST /api/tickets/:id/updates` and `/close` — `parts: uuid[]` + labour-only `cost`; `eventCost = labour + partsCost`

**Files:** `009_parts_amount.sql`, `src/lib/parts-cost.ts`, `src/routes/parts.ts`, `lookups.ts`, `tickets.ts`, `devices.ts` (object/string part history), seed, smoke, docs

**Testing:** parts CRUD; update 0/1/many parts; labour 1000 + parts 500+250 → 1750; invalid part UUID rejected; labour-only preserved

**Done when:** smoke passes; docs match; FRONTEND CHANGE REQUIRED — PartChips send UUIDs; cost field is labour-only (do not pre-add part prices)

## Phase 23 — Device Sync (SmartPark)

**Status:** Complete

**Objective:** Non-blocking Device Sync that imports locations into `roads`, then paginates QR codes into `devices` (create/update), idempotent and authorized.

**APIs:**
- `POST /api/device-sync` — `authorize('Device list','c')` → 202 + background job
- `GET /api/device-sync/latest`, `GET /api/device-sync/:id` — run status

**Database:** migrations `010_device_sync.sql`, `011_slot_id_unique.sql` (`slot_id` unique when set; `slot_identifier` from `mac_address`)

**Files:** `src/lib/device-sync-client.ts`, `src/lib/device-sync.ts`, `src/routes/device-sync.ts`, `src/config/env.ts`, docs, smoke

**Testing:** smoke — 401/403/503/409 + GET latest/id; live sync requires `DEVICE_SYNC_API_TOKEN`. Dual identity: legacy `GET /api/devices/PD-xxxx` when no `slot_id`; `GET /api/devices/{slotId}` + ticket list/detail `deviceId`/`slotId` when `slot_id` is set (smoke may `UPDATE` a seeded device with a test Slot Id).

**Done when:** smoke passes; docs match; FRONTEND CHANGE REQUIRED — Sync Device → `POST /api/device-sync`; Ticket → Device history links by Slot Id

## Phase 35 — Ticket assignment harden

**Status:** Complete

**Objective:** Harden existing assign/reassign for Ticket Detail (no new tables/endpoints).

**Changes:**
- `POST /api/tickets/:id/assign` — transactional update + `ticket_assignments` + event
- Eligible assignee validation (`400 INVALID_ASSIGNEE`)
- Idempotent same assignee (`Already assigned`, no trail growth)
- Response `{ id, assigneeId, assigneeName, assignmentTrail }`
- `GET /api/lookups/technicians` includes Engineer

**Files:** `src/routes/tickets.ts`, `src/routes/lookups.ts`, smoke, docs

**Testing:** assign trail growth; reassign; idempotent; invalid assignee; CR assign; tech 403

**Done when:** smoke passes; FRONTEND CHANGE REQUIRED — Detail Save → assign API; Hand to → technicians lookup

## Phase 36 — Part & Issue Master hard delete

**Status:** Complete

**Objective:** Hard-delete unused Parts and Issue subcategories from Technician onward; keep soft-deactivate for in-use records.

**APIs:**
- `DELETE /api/parts/:id` — Issue master `d`; unused → delete; used (`ticket_event_parts`) → `409 IN_USE`
- `DELETE /api/issues/subcategories/:id` — same `d` (existing); Tech/Engineer/PM now allowed
- Soft: `PATCH /api/parts/:id { active: false }`; `POST …/subcategories/:id/deactivate` unchanged

**Database:** `015_issue_master_delete_field_roles.sql` — Issue master `can_delete` for Technician, Engineer, Project manager

**Files:** `src/routes/parts.ts`, `src/lib/permissions.ts`, migration `015`, smoke, docs

**Testing:** unused part/sub delete; used → IN_USE; tech hard-delete; soft-deactivate still works

**Done when:** smoke passes; FRONTEND CHANGE REQUIRED — PartMaster Delete → `DELETE /api/parts/:id`; IssueMaster wire delete/deactivate; image zoom/crop stay FE-only

## Phase 37 — Issue Category gap-close

**Status:** Complete

**Objective:** Hard-delete unused issue categories (matching subcategory/parts pattern); harden create validation; no schema migration.

**APIs:**
- `DELETE /api/issues/categories/:id` — Issue master `d`; unused → delete (subs CASCADE); tickets/events on category or its subs → `409 IN_USE`
- Soft: `PATCH /api/issues/categories/:id { active: false }` unchanged
- Validation: category/sub names trim `min(2)`/`max(120)`; sub create requires existing active parent (`404` / `400 CATEGORY_INACTIVE`)

**Files:** `src/routes/issues.ts`, `scripts/smoke-writes.ts`, docs

**Testing:** unused category delete; used → IN_USE; soft deactivate; tech hard-delete unused; API cleanup (no raw SQL)

**Done when:** smoke passes; FRONTEND CHANGE REQUIRED — `createIssueCategory`, `createIssueSubcategory`, `deleteIssueCategory` in `issues.js` + IssueMaster create/delete UI

## Phase 38 — New-ticket notifications and browser Web Push

**Status:** Complete

**Objective:** Persist and deliver a new-ticket alert to eligible Admin, Project manager, and Control room users without affecting ticket creation success.

**APIs:**
- `GET /api/notifications`, `/unread-count`, `/push-config`
- `PATCH /api/notifications/:id/read`, `/read-all`
- `PUT/DELETE /api/notifications/push-subscriptions[/:id]`

**Database:** `019_notifications.sql` — `notifications` + `push_subscriptions`; unique recipient/event and browser endpoint keys.

**Recipient rule:** Active `Admin` / `Project manager` / `Control room` users with existing `All tickets v`; no hardcoded user IDs.

**Delivery:** `web-push` + VAPID; `setImmediate` background send; `404`/`410` removes expired subscriptions; notification failure is logged and cannot fail the ticket response.

**Files:** `src/lib/notifications.ts`, `src/routes/notifications.ts`, `src/routes/tickets.ts`, `src/app.ts`, env/config, seed, types, smoke, docs.

**Testing:** role fan-out; unrelated role excluded; failed raises excluded; content/reference; read/unread and ownership; subscription upsert/removal; successful push; expired subscription cleanup; sent-state duplicate prevention.

**Done when:** build + write smoke pass; frontend notification integration is complete in the sibling frontend (service worker, explicit browser permission/subscription UI, authenticated read-state relay, and shared Tickets/All Tickets badges).

## Phase 42 — Assignment notifications, ticket-open read, and no silent auto-claim

**Status:** Complete

**Objective:** Alert the person a ticket was assigned to, clear the unread notification when a ticket is opened, and stop Add Update from silently claiming unassigned tickets.

**New behavior:**
- `ticket.assigned` — first assign, and raise with `assigneeId`
- `ticket.reassigned` — reassign, and update `handoverToUserId`
- Recipient is the **new assignee only**; the previous assignee is never notified
- No notification when the assignee is unchanged (assign route early-returns; the existing unique key also dedupes)
- `POST /api/notifications/ticket/:ticketId/read` marks the caller's unread rows for that ticket, returning `{ updated }` (`0` = nothing unread, no row rewritten)
- Unassigned tickets reject Add Update with `409 TICKET_NOT_ASSIGNED` for every role including Admin/PM; the silent auto-claim was removed

**Role classification (two lists, deliberately separate):**
- `NEW_TICKET_NOTIFICATION_ROLES` = Admin / Project manager / Control room → `ticket.raised` fan-out (unchanged)
- `NOTIFICATION_DELIVERY_ROLES` = the above + Technician / Engineer → Web Push delivery and frontend bell eligibility
- Rationale: Technician/Engineer are the only other roles `assertEligibleAssignee` can assign to, so an assignee is never un-alertable, while field staff still receive no new-ticket alerts. Site attendant / AMC officer are in neither list.

**Files:** `src/lib/notifications.ts`, `src/routes/notifications.ts`, `src/routes/tickets.ts`, `frontend/src/services/notifications.js`, `frontend/src/services/users.js`, `frontend/src/hooks/useTicketNotifications.js`, `scripts/smoke-writes.ts`, docs.

**Testing:** A open-ticket marks read; B no unread → no write; C ticket A opened leaves ticket B unread and drops the count by one; D cross-user read refused (404 per-id, ticket route scoped); E assign notifies; F reassign notifies the new assignee only; G same assignee → no duplicate; H notification insert failure still completes the assignment; plus `409 TICKET_NOT_ASSIGNED` and no auto-claim.

**Done when:** `npm run build` (backend + frontend) and `npm run test:smoke:writes` pass. Note: `npm run test:smoke` has a pre-existing unrelated failure in the device-sync authorization assertion (expects `503`, gets `403`).

## Phase 40 — Multi-issue ticket contract parity

**Status:** Complete

**Objective:** Align the backend with the frontend's multi-select issue contract without changing legacy single-issue clients.

**APIs / storage:**
- Raise / Update / Close accept `issues[]`; legacy `categoryId` + `subCategoryId` remains supported
- `ticket_issues` stores ordered `reported` / `found` rows with scalar primary compatibility
- Ticket detail returns `issuesReported` / `issuesFound`; raise returns `eventId`
- `PATCH /api/tickets/:ticketId/raised/:eventId/photos` supports post-raise photo attachment
- Issue master delete checks include `ticket_issues`

**Files:** `017_ticket_issues.sql`, `src/lib/ticket-issues.ts`, `src/routes/tickets.ts`, `src/routes/issues.ts`, seed, smoke, docs.

**Testing:** multi-issue raise/detail response, legacy payload compatibility, `eventId`, issue persistence, update/close issue replacement, and notification integration regression.

**Done when:** build and isolated smoke suites pass; no frontend source changes required beyond the already-integrated multi-select UI.

## Phase 41 — Device list Slot Label ascending order

**Status:** Complete

**Objective:** Show the Device List in ascending Slot Label order without breaking API-driven pagination, filters, search, or export.

**Behavior:**
- `GET /api/devices` and `GET /api/devices/export` order by Slot Label (`devices.slot_number`) ascending through one shared constant, `DEVICE_LIST_ORDER_BY` = `ORDER BY (slot_number = ''), slot_number, public_id`.
- Sorting is done in SQL, not in the frontend: `LIMIT/OFFSET` paging means client-side sorting would only order one page.
- Blank labels sort last; `public_id` is the stable tie-break so paging never repeats or skips a row when two labels are equal.
- `slot_number` is a plain zero-padded `TEXT` (`S1-001`, `S1-010`, `S2-001`), so plain ascending text order is the expected Slot Label order — no natural-sort library or dependency added.
- Unchanged: filters (`q` / road / status / repeats), status tiles, search, `pagination` envelope, columns, the `slotLabel` value, and ticket list order (`raised_at DESC`).

**Assign role filter:** frontend only. `GET /api/lookups/technicians` keeps returning Active Technician / Engineer / Control room / Project manager (Work report Person filter needs CR/PM) and `assertEligibleAssignee` is unchanged, so the backend stays the final source of truth. The frontend Assign / Reassign dropdown narrows to Technician / Engineer.

**Files:** `src/routes/devices.ts`, `scripts/smoke-inprocess.ts`, docs.

**Testing:** smoke fetches page 1 and 2 of `GET /api/devices` and asserts the concatenated Slot Labels are ascending (fails on the previous `public_id` order, passes on the new order). `npm run build` passes; `test:smoke:writes` and `test:smoke:close` pass. `npm run test:smoke` reaches a pre-existing, unrelated data-state failure at the site-attendant TK-1099 assertion (that ticket does not exist in the local pglite data because earlier runs consumed the public-id sequence); ticket list code is untouched by this phase.

## Phase 44 — Users list visibility and account deletion

**Status:** Complete

**Objective:** Stop exposing Admin accounts to non-Admin viewers, hide every caller's own account, and add a permission-gated delete that cannot remove your own account.

**Changes:**
- `src/lib/user-access.ts` (new) — `isAdminRoleName`, `appendUserVisibilitySql(user, params)`, `assertNotLastActiveAdmin(targetUserId)`. Mirrors `lib/ticket-access.ts` so the two visibility concerns read the same way.
- `src/routes/users.ts` — visibility clause ANDed into the `GET /api/users` WHERE (so `q` and `status` cannot bypass it) and into the tiles query with its own params; `assertNotLastActiveAdmin` replaces the inline last-admin block in `PATCH`; new `DELETE /:id`.
- No migration, no new table, no new role permission. Admin already held Users `d` (`vceaxd`), so delete is Admin-only with nothing granted to anyone else.

**Authorization:**
- Own account excluded for every role (`u.id <> $me`), matched on the authenticated UUID only.
- `r.name <> 'Admin'` added for every non-Admin viewer, so a PM cannot retrieve Admin accounts by any means.
- Admin sees all other accounts including other Admins; the PM exclusion is not applied to Admin.
- `DELETE` requires Users `d`; self-delete → `400` / `SELF_DELETE_FORBIDDEN`; already-Inactive → `409` / `ALREADY_INACTIVE`; last Active Admin → `409` / `LAST_ADMIN`.

**Delete semantics:** deactivate (`status = 'Inactive'`), never a hard delete — `RULES.md` requires the name to stay readable on past tickets. Reuses the existing `users.status` enum, and `loadAuthUser` already refuses non-`Active` users so the deleted account's JWT dies immediately.

**Files:** `src/lib/user-access.ts`, `src/routes/users.ts`, `scripts/smoke-users.ts`, `package.json`, docs.

**Testing:** `npm run test:smoke:users` — A Admin sees other Admins and not self; B PM sees no Admin and not self; C Technician stays 403; I/J PM cannot retrieve Admins via `?q=Admin` / `?status=…` / combined; D/E/K Admin deletes an eligible user and list state stays correct; F Technician and PM delete → 403; L failed delete leaves status unchanged; G own account never listed; H self-delete rejected at the API for every role; last-active-Admin stays guarded.

**Done when:** `npm run build` and `npm run test:smoke:users` pass; frontend `npm run lint` and `npm run build` pass. `npm run test:smoke` still fails at the pre-existing TK-1099 ticket-visibility assertion (unrelated; reproduced on a clean tree).

## Phase 45 — Project manager and Control room are not assignable ticket holders

**Status:** Complete

**Objective:** Remove Project manager and Control room from the Hand to / assignee dropdown and reject either as an assignee at the API.

**Changes:**
- `src/lib/ticket-access.ts` — new exported `ASSIGNABLE_ROLES = ['Technician', 'Engineer']` as the single source of truth.
- `src/routes/lookups.ts` — `/technicians` reads that constant instead of an inlined list.
- `src/routes/tickets.ts` — `assertEligibleAssignee` reads the same constant.
- `src/lib/notifications.ts` — corrected a stale comment that listed the old four-role set.

**Why one constant:** the dropdown and the eligibility guard previously duplicated the same four-role list in two files (the old comment even said "matches lookups/technicians"). Narrowing only the dropdown would have left those roles assignable by direct API call; narrowing only the guard would have hidden them in the UI while still accepting them. Sharing the constant removes the drift and the duplicate.

**Two different questions, kept separate:** `ASSIGNABLE_ROLES` (Technician / Engineer) answers *who may hold a ticket*. `canAssignTickets` (Control room / Admin / Project manager) answers *who may perform an assign*. Control room therefore can no longer *receive* a ticket but can still *route* one — verified live.

**Behavior:** PM and Control room no longer appear in Hand to, the assignee filter, or the work-report person list. `POST /api/tickets/:id/assign` with either role returns `400` / `INVALID_ASSIGNEE` and leaves the ticket unchanged. Technician and Engineer are unaffected.

**Data safety:** all 23 assigned seeded tickets belong to Technicians, so nothing already in the database changes appearance.

**Testing:** verified against the running API — the lookup returns 4 workers (3 Technician, 1 Engineer); PM and Control room assigns are both rejected `400 INVALID_ASSIGNEE` with the assignee unchanged; Control room can still perform an assign; the ticket was reverted after the check. Temporary probe script removed afterward.

**Note on `test:smoke:writes`:** its "notification role logins" assertion (line 103) fails because the seeded Control Room user is `Inactive` in the local database. That is pre-existing local data state, reproduced on a clean tree, and unrelated to this change; the user was restored to `Active` for verification.

**Done when:** `npm run build` passes and `npm run test:smoke:users` still passes. `npm run test:smoke` and `npm run test:smoke:writes` still fail for the pre-existing reasons noted above.

## Phase 46 - Role delete guard, Inactive exemption, and user hard delete

**Status:** Complete

**Objective:** Add role deletion, refused while a live account holds the role; let Inactive accounts stop blocking it; and make user deletion a real hard delete.

**APIs:**
- `DELETE /api/roles/:id` - requires `Roles & permissions` `d` (Admin is the only seeded role with it; Project manager stays view-only)
- `DELETE /api/users/:id` - requires Users `d`; now a **hard delete**
- `PATCH /api/users/:id` - two new guards: unknown `roleId` -> `400 ROLE_NOT_FOUND`, activating a role-less account -> `409 ROLE_REQUIRED`

**Database:** migration `021_user_role_set_null.sql` - `users.role_id` becomes nullable and the FK is re-pointed to `ON DELETE SET NULL`.

**Behavior - role delete:**
- Role not found -> `404` / `NOT_FOUND`
- One or more **Active or Pending** accounts assigned -> `409` / `ROLE_IN_USE` / "Role is assigned to users. Please change their role before deleting it." with `details.users` = that count
- Only Inactive accounts assigned -> the role is deleted, its `role_permissions` rows cascade, and those accounts end up with `role_id IS NULL`

**Behavior - user hard delete:**
- The six references with no `ON DELETE` clause are cleared in one transaction (`tickets.raised_by_user_id`, `tickets.assignee_id`, `ticket_events.actor_user_id`, `ticket_assignments.from_user_id` / `to_user_id`, `device_sync_runs.triggered_by_user_id`), then the row is deleted. `user_roads`, `password_reset_tokens`, `notifications` and `push_subscriptions` cascade.
- Tickets, events, photos and costs survive; only the person reference is cleared, so the deleted name no longer renders on past tickets. This is the accepted trade-off of hard delete.
- Self-delete `400 SELF_DELETE_FORBIDDEN`, unknown `404`, last Active Admin `409 LAST_ADMIN`. The old `409 ALREADY_INACTIVE` is gone - deleting an Inactive account is now a normal hard delete.

**Why the migration was needed:** `users.role_id` was `NOT NULL REFERENCES roles(id)` with no `ON DELETE`, so an Inactive account kept a role alive forever. `ON DELETE SET NULL` gives the state a meaning ("this account has no role") and makes the reactivation prompt reachable. The state is only safe because activation is gated - `requireAuth` resolves permissions through a join on roles, so an Active user with no role could not be authorised at all. Consequently the Users list and its tiles switched to `LEFT JOIN roles`, and the Admin exclusion in `appendUserVisibilitySql` uses `COALESCE(r.name, '')` so a role-less account is not filtered out of the list.

**Counting rule:** the guard counts `status <> 'Inactive'`, so a Pending signup still blocks. Reading the count inside the request is what makes "role assigned between page load and delete" safe.

**Files:** `src/routes/roles.ts`, `src/routes/users.ts`, `src/lib/user-access.ts`, `src/db/migrations/021_user_role_set_null.sql`, `scripts/smoke-roles.ts`, `scripts/smoke-users.ts`, `package.json` (`test:smoke:roles`)

**Testing:** `npm run test:smoke:roles` - A unassigned role deletes; B one assigned account -> 409; C two -> 409 with `details.users = 2`; D/H direct API delete as PM and Technician -> 403; a seeded in-use role -> 409; F rejected delete leaves role, matrix and assignments untouched; G deletable after reassignment; unknown role -> 404; H2 a Pending signup still blocks; I two Inactive accounts do not block, the role deletes and both accounts end up with `role_id IS NULL`; J a role-less account is still listed with `roleMissing`, activation is refused `409 ROLE_REQUIRED` and stays Inactive, activation with a role succeeds, unknown `roleId` -> `400 ROLE_NOT_FOUND`.
`npm run test:smoke:users` - hard delete removes the row (not deactivated), the account leaves every status-filtered list, a second delete is `404`, an already-Inactive account can be hard-deleted, and the last-Active-Admin guard still holds.

**Done when:** `npm run build`, `npm run test:smoke:roles` and `npm run test:smoke:users` pass, and the frontend `npm run lint` / `npm run build` pass.

## Phase 47 — Field roles raise, auto-assign on update, close with update

**Status:** Complete

**Objective:** Technician, Engineer and a new Electrician role can raise tickets; assignment stays optional at raise; an Add Update on an unassigned ticket assigns it; an update can explicitly close the ticket. Supersedes the Phase 42 "no silent auto-claim" rule.

**Roles:**
- New `Electrician` role (migration `022_electrician_role.sql`), same permission matrix as Engineer; `DEFAULT_ROLE_PERMS` + seed user (`Vikram Parmar`, 9824077315).
- `FIELD_ROLES = ['Technician', 'Engineer', 'Electrician']` in `src/lib/permissions.ts` is now the single field-role list, reused by `ASSIGNABLE_ROLES`, `NOTIFICATION_DELIVERY_ROLES`, `assertRoadAccessUnlessFieldWork`, the work report person filter, `authorizeIssueSubUpdate` and `assertValidVisitedBy`.
- Migration `023_field_roles_raise_ticket.sql` restores `Raise ticket` `v`+`c` for the three field roles (the local DB had drifted to no Technician raise permission). Other flags are untouched; the matrix remains editable.

**Raise (`POST /api/tickets`):** `assigneeId` was already optional (unassigned → `Open`). When given it now requires the same gates as `POST /:id/assign` — `All tickets` `a` + `assertCanAssignTickets` (`403` otherwise, so field roles raise unassigned) — and passes `assertEligibleAssignee` (`400 INVALID_ASSIGNEE` otherwise).

**Add Update (`POST /api/tickets/:id/updates`) — `resolveUpdateAssignee`:**
- Assigned ticket → unchanged `assertTicketAccess` + `assertCanAddUpdate`; the assignee is never changed automatically.
- Unassigned + field role → the updater claims it (need not be the raiser; this is what makes the QR flow work). Trail row `Auto-assigned on update`.
- Unassigned + Admin/PM → must send `handoverToUserId` (eligible assignee); otherwise `409 TICKET_NOT_ASSIGNED` "Select an assignee to update an unassigned ticket". Trail row `Assigned on update`.
- Unassigned + any other role → existing access check then `409 TICKET_NOT_ASSIGNED`.
- A field role sending `handoverToUserId` for someone else while claiming → `403` (cannot assign).

**Close with update:** optional `closeTicket: boolean` (default `false`). `true` requires `Update ticket` `x` and the holder check on the effective assignee (after any claim). The single visit event gets `status_label = 'Closed'` + `meta.closedTicket = true`; the ticket gets `status = 'Closed'`, `closed_at = NOW()`. One POST still creates exactly one event. Resolve stays the `Site visit — resolved` update type (no new status) and closes only with `closeTicket: true`.

**Concurrency / transaction:** inside the existing `withTransaction`, `SELECT … FOR UPDATE` locks the ticket and re-checks status + assignee. A lost race → `409 TICKET_ALREADY_ASSIGNED`, rolled back. Claim, event, parts, cost and close commit together.

**Notifications:** a field user's **self-assign on update is silent** — no `ticket.assigned` row, so no Web Push and no frontend sound. A claim only notifies when the saver is an assigner (`canAssignTickets`: Admin / Project manager / Control room — i.e. the Admin/PM holder pick), via the existing `createTicketAssignmentNotification` (`ticket.assigned`, keyed on the update event) after commit, wrapped in try/catch. Assign / Reassign, raise-with-assignee and handover notifications are unchanged (each already requires an assigner).

**Other:** `PATCH /:id/updates/:eventId/photos` accepts photos on the author's own closing event after the ticket closed (upload-after-save). Work report day rows label an event `Closed` when `status_label = 'Closed'`.

**Response additions:** `assigneeId`, `autoAssigned`, `closed` (existing fields unchanged).

**Files:** `src/routes/tickets.ts`, `src/lib/permissions.ts`, `src/lib/ticket-access.ts`, `src/lib/notifications.ts`, `src/lib/visited-by.ts`, `src/lib/work-report.ts`, `src/middleware/auth.ts`, `src/routes/issues.ts`, `src/routes/reports.ts`, `src/db/seed.ts`, migrations `022`/`023`, `scripts/smoke-ticket-update-flow.ts`, `scripts/smoke-writes.ts`, `package.json` (`test:smoke:ticket-flow`).

**Testing:** `npm run test:smoke:ticket-flow` — A/B/C each field role raises; D unassigned raise; E raise with assignee + ineligible rejected + field role raising with `assigneeId` → `403` (no ticket created); F non-raiser field user auto-assigned (assignee + event actor = updater, one trail row); G assigned ticket keeps assignee; H foreign field user 403, no reassign; I/K `closeTicket` false/omitted (even resolved) stays open; J `closeTicket: true` closes with one event in `workHistory`, photo attach still works, further updates 409; L auto-assign + close; M two parallel updates → one winner, one assignee, one trail row; N scan `openTicketId` → update auto-assigns; O no `ticket.assigned` for a field self-assign, one for raise-with-assignee and one for the Admin pick on update; Admin pick 409 without / success with `handoverToUserId`; raiser-not-holder close 403 `NOT_HOLDER`; field handover while claiming 403.

**Verification:** on a fresh isolated PGlite DB (`db:setup`), `test:smoke:ticket-flow`, `test:smoke:writes`, `test:smoke:close`, `test:smoke:roles`, `test:smoke:users` pass. `test:smoke` fails later at its pre-existing device-sync assertion (the script itself sets Technician `Device list` create to false, then expects Technician device sync to be authorized) — unrelated to this phase. On the local Postgres DB `test:smoke:writes` still fails at the pre-existing Inactive Control room login.

**Frontend (done, frontend Phase 47):**
- `pages/tickets/TicketUpdate.jsx` `gateAssigneeUpdate` allows an unassigned ticket for field roles (backend assigns it) and Admin/PM (holder picker).
- `components/tickets/TicketAddUpdateForm.jsx`: **Close Ticket** Yes/No, default **No**, sends `closeTicket: true` only on Yes; "closes only when resolved" copy replaced; `pickAssignee` → `handoverToUserId`; `409 TICKET_ALREADY_ASSIGNED` → toast + reload.
- `pages/tickets/TicketDetail.jsx`: Add update + **Resolve** (same form, `Site visit — resolved`) on unassigned tickets for field roles / Admin-PM.
- `pages/tickets/TicketRaise.jsx`: optional **Assign to** only for All tickets `a` (matches the raise guard above).

## Phase 49 — Per-issue Open/Resolved state on multi-issue tickets

**Status:** Complete

**Objective:** Each **reported** issue of a ticket has its own Open/Resolved state. An Add Update can resolve specific Open issues; resolved issues are never offered again; the ticket lifecycle is unchanged (closing stays explicit).

**Data model (migration `024_ticket_issue_status.sql`):** `ticket_issues` gains `status` (`'Open' | 'Resolved'`, default `Open`), `resolved_at`, `resolved_by_user_id` (→ users, `ON DELETE SET NULL`) and `resolved_event_id` (→ ticket_events, `ON DELETE SET NULL`). Status is only meaningful on `role = 'reported'` rows; found rows keep the default and are ignored everywhere. The migration re-runs the 017 reported backfill for tickets with no reported row (seed / legacy single-issue tickets) and marks reported issues on Closed tickets `Resolved`. `seed.ts` mirrors that backfill because it runs after migrations.

**Add Update (`POST /api/tickets/:id/updates`):** new optional `resolveIssueIds: uuid[]` (deduped) = `issuesReported[].id`. After all existing gates (`resolveUpdateAssignee`, holder, `x` for close, CLOSED) and inside the existing transaction, after the ticket `FOR UPDATE` lock and the event insert, `resolveTicketIssues` (`lib/ticket-issues.ts`) re-reads the rows `FOR UPDATE` and:
- `400 INVALID_ISSUES` when any id is unknown, not on this ticket, or not a reported issue;
- `409 ISSUE_ALREADY_RESOLVED` when any id is already Resolved (also the concurrent loser);
- otherwise sets `Resolved` + `resolved_at` / `resolved_by_user_id` / `resolved_event_id = this event`.
A failure rolls back the whole update (no event, no claim). The found-on-site `issues[]` picker and its replace behaviour are unchanged.

**Close:** `closeTicket: true` and `POST /:id/close` call `resolveOpenTicketIssues`, which resolves every still-Open reported issue tagged with the closing event, so a Closed ticket never has Open issues. Resolving the last issue does **not** close the ticket (smoke K of Phase 47 still holds).

**API responses:** `issuesReported[]` items add `id`, `status`, `resolvedAt`, `resolvedBy` (existing fields unchanged; `issuesFound` unchanged). `workHistory[]` items add `resolvedIssues[]` (grouped by `resolved_event_id`, so the trail shows which update resolved which issue — no new audit table). The update response adds `resolvedIssues[]` and `openIssueCount`.

**Dashboard (`GET /api/dashboard`):** fleet bar / legend / road-wise / device status / open-over-3-days stay ticket-level (a device stays down until its ticket closes; severity only matters for unassigned tickets and resolving always leaves the ticket assigned). `downReasons` now counts **Open reported issues** on visible non-Closed tickets grouped by sub-category, so resolved issues drop out. New totals `openIssues` and `openTicketsCount`.

**Unchanged:** ticket statuses, list/tabs/tiles/filters/search/pagination/export, reports, device status SQL, notifications (updates send none; resolving adds none), Control room's default `Update ticket` `v.....` (it can resolve only when the matrix grants `e`, and then only on tickets it raised).

**Files:** migration `024`, `src/lib/ticket-issues.ts`, `src/routes/tickets.ts`, `src/routes/dashboard.ts`, `src/db/seed.ts`, `scripts/smoke-issue-resolution.ts`, `package.json` (`test:smoke:issue-resolution`).

**Testing:** `npm run test:smoke:issue-resolution` — A 3 issues Open; B resolve A (B/C Open); C only B/C resolvable + trail shows A; D re-resolve A → 409; E resolve B; F last issue keeps Under repair, explicit close works, close-with-update and the Close page resolve the rest (tagged with the closing event); G QR scan → only Open issues; H Admin (holder pick + assigned); I Control room 403 by default, resolves once `Update ticket e` is granted (restored after); J PM resolves two in one update; K single-issue + legacy backfill + no Open issues on Closed tickets; L foreign field user 403; M other ticket's / unknown id → 400; N dashboard `openIssues` −1, `openTicketsCount` unchanged; O concurrent resolve → one 201, one 409, one event.

**Verification:** `npx tsc --noEmit`, `test:smoke:issue-resolution`, `test:smoke:ticket-flow`, `test:smoke:close`, `test:smoke:writes` pass on the local Postgres DB. `test:smoke` stops at its pre-existing `TK-1099` seed assertion (that ticket is absent from the local DB; identical failure on the pre-change code).

**Frontend (done, frontend Phase 49):** `TicketAddUpdateForm` "Resolve issues" chips (`openIssues` → `resolveIssueIds`, `ISSUE_ALREADY_RESOLVED` → `onConflict`), Detail status pills + View Update "Resolved issues", `/tickets/update` (QR) passes the same `openIssues`, Close page note, Dashboard subtitle from `openIssues` / `openTicketsCount`.

## Phase 50 — Issue-level duplicate tickets (several open tickets per device)

**Status:** Complete

**Objective:** Detect duplicate tickets by **issue**, not by device. The same Open issue on the same device never opens a second ticket; a different issue opens a new ticket even while other tickets are open; a Closed ticket never blocks a raise and is never reopened or modified by one. Device status, road stats and the Dashboard stop assuming one open ticket per device. Supersedes the Phase 17/24 one-open-ticket rule and the 7-day reopen rule.

**Data model (migration `025_open_issue_per_device.sql`):** `ticket_issues.device_id` (FK → devices, backfilled from `tickets.device_id`; a ticket's device never changes, so the copy cannot drift — a partial unique index cannot span two tables). Reported issues still Open on Closed tickets are marked Resolved. `idx_tickets_one_open_per_device` is dropped; new partial unique index `idx_ticket_issues_one_open_issue_per_device ON ticket_issues (device_id, subcategory_id) WHERE role = 'reported' AND status = 'Open'`. `replaceTicketIssues` and the `seed.ts` backfill fill `device_id`.

**Raise (`POST /api/tickets`):** after issue validation, device lookup and the Slot Identifier check, `assertNoOpenIssueConflicts` → `findOpenIssueConflicts` (`lib/ticket-issues.ts`) finds requested sub-categories that are Open reported issues on non-Closed tickets of the device. Any hit → `409 OPEN_TICKET_EXISTS` with `details.ticketId` / `openTicketId` (first duplicate's ticket, unchanged redirect contract) and `details.issues[] { ticketId, id, categoryId, subCategoryId, category, sub }`. A mixed raise is rejected whole. The device-level open check and the 7-day `REOPEN_SAME_TICKET` block are removed. A concurrent same-issue raise violates the index, rolls back the whole raise transaction (ticket, event, assignment) and re-runs the pre-check, so it answers the same `409` pointing at the winner. Notifications unchanged: new tickets notify, `409`s and updates do not.

**Updates:** unchanged (Phase 49). Several authorized users resolve different issues of the same ticket; User B still needs the existing update authorization (holder, raiser, Admin/PM, or claim of an unassigned ticket). Resolving an issue removes it from the index, so it can be raised again as a new ticket.

**Scan (`/scan`, `/slot-mac`):** adds `openTickets: [{ id, status, assigneeId, age, issues[] }]` — every non-Closed ticket, oldest first, with only its Open reported issues (`loadOpenDeviceTickets`, not visibility filtered, like `openTicketId`). `openTicketId` / `openTicketIssue` / `openTicketAge` describe the worst ticket; the "Open ticket(s)" fact lists all.

**Device status:** shared `openTicketLateralSql(visFilter)` (`lib/device-status.ts`) returns the **worst** open ticket per device (ranked like `deriveDeviceStatus`, ties → latest raise) plus `open_ticket_count` / `first_open_at`. Used by Dashboard fleet + road-wise stats (a device counts once), Device list `derived_status` (+ `openTicketCount` on rows), Device detail (status; days-down from the earliest open raise) and scan. Roads `down` = `COUNT(DISTINCT device_id)`.

**Files:** migration `025`, `src/lib/ticket-issues.ts`, `src/lib/device-status.ts`, `src/routes/tickets.ts`, `src/routes/devices.ts`, `src/routes/dashboard.ts`, `src/routes/roads.ts`, `src/db/seed.ts`, `scripts/smoke-multi-ticket-raise.ts`, `scripts/smoke-writes.ts`, smoke fixture cleanups (`smoke-inprocess`, `smoke-ticket-update-flow`), `package.json` (`test:smoke:multi-ticket`).

**Testing:** `npm run test:smoke:multi-ticket` — 1 different issue → new ticket, TK1 untouched; 2 same Open issue → 409 with `openTicketId` + `details.issues`, no ticket / notification; 3 mixed raise → 409, nothing created; 4 holder resolves A+B, scan shows only C, Admin (User B) resolves C, foreign technician 403, no new ticket; 5 all resolved keeps the ticket open, close then raise → new ticket, Closed ticket unchanged (no 7-day reopen); 6 issue resolved on an open ticket → new ticket; 7 concurrent same issue → one 201 + one 409 / one ticket, different issues → both 201; 8 scan `openTickets` with Open issues only; 9 two open tickets → device counted once, worst status, `openTicketsCount` +2, `openIssues` +2, road `down` +1; 10 new ticket notifies, update / 409 do not; 11 unknown device 404, invalid issue 400; 12 old index gone, new index present, every row has `device_id`. `smoke-writes` keeps same-issue duplicate/race 409 and adds a different-issue 201.

**Verification:** `npx tsc --noEmit` / `npm run build`, `test:smoke:multi-ticket`, `test:smoke:issue-resolution`, `test:smoke:ticket-flow`, `test:smoke:close`, `test:smoke:writes` pass on the local Postgres DB. `test:smoke` still stops at its pre-existing `TK-1099` seed-data assertion (and later at missing `TK-1078`), unrelated to this phase.

**Frontend (done, frontend Phase 50):** Raise has no device-level block; it lists open tickets with their Open issues (Update Ticket / Open), pre-checks same-issue duplicates (all on one ticket → Update Ticket; otherwise names them) and handles `409 details.issues`. QR Update auto-opens a single open ticket, offers a picker for several, and links to raise a different issue. `scanDevice.js` builds facts from `openTickets`.

## Phase 51 — Main/Sub issue resolution and removal of ticket assignment

**Status:** Complete

**Objective:** (1) Add Update resolves the ticket's raised issues by **Main Issue** (category — resolves all of its Open sub issues) or by single **Sub Issue**, and can append new Open issues to the same ticket. (2) Remove the ticket Assign / Reassign / auto-assign workflow end to end: tickets have no holder, every user with `All tickets` `v` sees every ticket on every road, `Update ticket` `e` updates any open ticket, `x` closes. No migration; historical assignee data stays readable.

**Add Update (`POST /api/tickets/:id/updates`):**
- New optional `resolveCategoryIds: uuid[]` (deduped) beside the existing `resolveIssueIds`. `resolveIssueSelection` (`lib/ticket-issues.ts`, replaces `resolveTicketIssues`) locks the matching reported rows `FOR UPDATE` and resolves the union. Unknown issue id, or a category with no reported row on this ticket → `400 INVALID_ISSUES`. Issue id not Open, or a category with no Open sub left → `409 ISSUE_ALREADY_RESOLVED`. A partly resolved category resolves only its remaining Open subs. One bad id rejects the whole request.
- New optional `addIssues: [{ categoryId, subCategoryId }]` (validated like raise: active + category/sub pair) appended by `appendTicketIssues` as Open **reported** issues, `sort_order` after the existing ones. A sub already on this ticket in any status → `409 ISSUE_ALREADY_ON_TICKET` (`details.issues` with status). A sub Open on another ticket of the same device → `409 OPEN_TICKET_EXISTS` (same `details` as raise, via the shared `assertNoOpenIssueConflicts`). A concurrent raise that wins the partial unique index rolls the update back and is answered with the same `409`.
- Order inside the one transaction: `SELECT … FOR UPDATE` on the ticket → append → optional legacy found replace (`issues[]`, kept for older clients) → event insert → resolve selection → resolve the rest when `closeTicket` → status update. Any rejection writes nothing.
- Response adds `addedIssues[]`; drops `assigneeId` / `autoAssigned`. Status rules unchanged: every visit → `Under repair` (`Waiting for spare` holds), only `closeTicket: true` closes (needs `x`). Resolving every issue never auto-closes.

**Assignment removal:**
- Deleted `POST /api/tickets/:id/assign` (→ `404`), `resolveUpdateAssignee` / auto-claim, `handoverToUserId`, `assertHolder`, `assertCanAddUpdate`, `assertEligibleAssignee`, `TICKET_NOT_ASSIGNED` / `NOT_HOLDER` / `TICKET_ALREADY_ASSIGNED` / `INVALID_ASSIGNEE` paths, the assignment trail query and the `ticket_assignments` inserts. Raise drops `assigneeId` (a stray value is ignored by zod) and always creates `Open`.
- Visibility filter removed from tickets list/detail/export, dashboard, devices (list, detail, scan, history overlays), reports and the device-status lateral (`openTicketLateralSql(alias)` has no `visFilter`). `lib/ticket-access.ts` keeps only `isTicketPrivilegedRole` / `isFieldRole`.
- List: tabs `open` (every non-Closed) and `cls`; `tabCounts { open, cls }`; the `assignee` filter, `assignedTo`, `actionLabel`, `actionPrimary` are gone. Detail drops `assigneeId`, `assignmentTrail` and the "Assigned to" fact.
- Close / close-preview keep `Update ticket` `x`; no holder check. Photo attach (`PATCH …/raised|updates/:eventId/photos`) = event author or Admin/PM (`403 FORBIDDEN` otherwise), replacing the holder check.
- Notifications: `createTicketAssignmentNotification` removed; `ticket.raised` recipients no longer compute road access (`canOpen: true`). `NOTIFICATION_DELIVERY_ROLES` keeps `FIELD_ROLES` so historical `ticket.assigned` rows stay deliverable / readable.
- `/api/lookups/technicians` = `FIELD_ROLES` (Work report person filter, Visited by).

**Historical data:** `tickets.assignee_id`, `ticket_assignments` and old `ticket.assigned` / `ticket.reassigned` notifications are untouched and never written again. The legacy display rule (Open + assignee → "Under repair") stays in `listStatus`, `deriveDeviceStatus`, `OPEN_TICKET_RANK_SQL` and the list tiles (`NOT_ATTENDED_SQL`). Old `assigned` events stay in work history. A historically assigned ticket is updated / closed by anyone with the permission; its `assignee_id` is not changed.

**Files:** `src/lib/ticket-issues.ts`, `src/lib/ticket-access.ts`, `src/lib/device-status.ts`, `src/lib/notifications.ts`, `src/lib/permissions.ts` (default role notes only — seed-time text, live `roles.note` rows unchanged), `src/routes/tickets.ts`, `src/routes/dashboard.ts`, `src/routes/devices.ts`, `src/routes/reports.ts`, `src/routes/lookups.ts`, `scripts/smoke-issue-groups.ts` (new), `scripts/smoke-no-assignment.ts` (new), rewritten `smoke-ticket-update-flow.ts`, `smoke-writes.ts`, `smoke-inprocess.ts`, `smoke-issue-resolution.ts`, `smoke-multi-ticket-raise.ts`; deleted `probe-assignment-notifications.ts`, `cleanup-assignment-notification-probe.ts`; `package.json` (`test:smoke:issue-groups`, `test:smoke:no-assignment`).

**Testing:**
- `npm run test:smoke:issue-groups` (spec §19): 1 main issue + 3 subs all Open; 2 main issue resolves all its subs, other main issue stays Open; 3/4 one sub resolved, siblings Open; 5/16 re-resolve sub or fully resolved main → 409, partly resolved main resolves only Open subs; 6/7 User A resolves a sub, User B's scan shows only the rest and resolves by main, resolver recorded per issue; 13 `addIssues` persisted Open after the raised ones, resolvable later, add + resolve in one update, one event; 13b same-ticket duplicate → `ISSUE_ALREADY_ON_TICKET`, other open ticket → `OPEN_TICKET_EXISTS`, no event; 14 mismatched pair / main not on ticket / unknown main → 400, nothing resolved; 15 other ticket's issue → 400; 17 QR path; 18 Admin; 19 Control room 403 until `e` granted (restored); 20 PM resolve + add; 21 dashboard `openIssues` −3 / +1, `openTicketsCount` unchanged until explicit close, no auto-close; concurrent main resolve → one 201, one 409.
- `npm run test:smoke:no-assignment` (spec §23.12 1–11): raise Open + unassigned (stray `assigneeId` ignored); every role with `All tickets` `v` lists / opens any ticket, no assignment fields, `tab=asg` → 400; users A, B, C update in turn, author recorded, `assignee_id` stays NULL, no `ticket_assignments`; resolving never assigns; concurrent updates both 201; no assignment notifications; historical assigned ticket loads, keeps its `assigned` event, shows Under repair, is updated / closed by non-assignees with `assignee_id` untouched; Site attendant 403 on update / close; photo attach author-only; `POST /assign` → 404.
- Updated: `smoke-issue-resolution` (L: other technician 201, Site attendant 403), `smoke-multi-ticket` (case 4 User B is another technician), `smoke-ticket-update-flow` (raise / any-user update / close flag / concurrency / QR), `smoke-writes` (assign 404 + ticket-scoped mark-read on `ticket.raised`), `smoke-inprocess` (every ticket, every road; no longer depends on seed `TK-1099` / `TK-1078`).

**Verification:** `npx tsc --noEmit -p .`; `test:smoke:issue-groups`, `test:smoke:no-assignment`, `test:smoke:issue-resolution`, `test:smoke:multi-ticket`, `test:smoke:ticket-flow`, `test:smoke:writes`, `test:smoke:close`, `test:smoke:users`, `test:smoke:roles` pass on the local Postgres DB. `test:smoke` passes every ticket check and now stops later, at "tech device-sync should be authorized": the local DB has `Device list` `c` off for Technician / Engineer (permission-matrix drift from migration `014`, unrelated to this phase).

**Frontend (done, frontend Phase 51):** Add Update "Resolve Issues" groups the raised issues by Main Issue in collapsible panels (`TicketResolveIssues`), progressive **Another Issue**, hidden-until-opened **Add another issue** (reuses `TicketIssueRows`) → `resolveCategoryIds` / `resolveIssueIds` / `addIssues`. All Assign / Reassign UI, the Assigned tab / column / filter, the raise **Assign to**, the QR assignee gate and the holder picker are removed.

## Phase 52 — Under repair tab, clickable list cards, age filter

**Status:** Complete

**Objective:** Split the All Tickets list into three tabs so a raised ticket and a ticket already being worked on are no longer mixed: **Open** (raised, no update yet), **Under repair** (at least one update) and **Closed** (unchanged). Give the frontend what it needs to make the summary cards select a tab + filter, including the "Open over 3 days" card that spans two tabs.

**Tab rules (`GET /api/tickets`, `routes/tickets.ts`):**
- `tab=open` → `NOT_ATTENDED_SQL` (`status IN ('Open','New') AND assignee_id IS NULL`) — the same set as the "Open, not attended" tile.
- `tab=urp` → `UNDER_REPAIR_TAB_SQL` (`status <> 'Closed' AND NOT (NOT_ATTENDED_SQL)`): stored `Under repair`, `Waiting for spare`, and legacy Open + historical assignee (already shown as Under repair). Every Add Update moves the status to `Under repair` / `Waiting for spare`, so "at least one update" = this set.
- `tab=cls` → `status = 'Closed'`. Schema `tab: z.enum(['open','urp','cls'])`; `tab=asg` stays `400`.
- Row `tab` comes from `tabForStatus(status, assigneeId)` with the same rules.
- `status` keeps every existing value and now narrows within the tab (`Under repair` excludes `Waiting for spare` and vice versa; `All` = whole tab).

**Age filter:** optional `age=over3` (`z.enum(['over3'])`, anything else → `400`) adds `status <> 'Closed' AND raised_at < NOW() - INTERVAL '3 days'` on the `open` / `urp` tabs; ignored on `cls`.

**Response:**
- `tabCounts { open, urp, cls }` — base filters (road / category / `q`); the `open` / `urp` counts also apply `age` so the tab badges show the over-3-days split while that filter is on.
- New `over3Counts { open, urp }` — over-3-days tickets per tab (base filters only), so the client picks the tab for the "Open over 3 days" card.
- `tiles` unchanged and still base filters only, so card numbers stay put when a card or tab is clicked.
- `/export` unchanged (no tab logic).

**Files:** `src/routes/tickets.ts`; `scripts/smoke-no-assignment.ts` (Phase 52 block + historical-assignee lookup moved to `tab=urp`); `scripts/smoke-inprocess.ts` (`tabCounts { open, urp, cls }`, every-ticket checks list without a tab).

**Testing:** `npm run test:smoke:no-assignment` adds: a new ticket is in `open` and not `urp`; after one update it moves to `urp` and leaves `open`; a Waiting for spare update keeps it in `urp` with its own status; `status=Under repair` excludes it then; a ticket raised 5 days ago is listed by `age=over3` and counted in `over3Counts.open` / `tabCounts.open`; a ticket raised today is excluded; `age=week` → `400`; `tabCounts` / `over3Counts` shapes.

**Verification:** `npx tsc --noEmit -p .`; `test:smoke:no-assignment`, `test:smoke:issue-groups`, `test:smoke:writes`, `test:smoke:ticket-flow`, `test:smoke:issue-resolution`, `test:smoke:close`, `test:smoke:multi-ticket` pass. `test:smoke` passes every ticket check and stops at the pre-existing device-sync permission drift.

**Frontend (done, frontend Phase 52):** All Tickets shows Open / Under Repair / Closed tabs, the four cards select tab + status + age, the status filter only appears on Under Repair, and tab switches slide (ink bar + panel).

**Follow-up (user request):** `GET /api/tickets` `tiles` gains a 5th entry `{ value: tab_cls, label: 'Closed', tone: 'ok' }` (same count as `tabCounts.cls`) so the Closed tab has its own active card. No query change. `npm run build` passes.

## Phase 53 — Slot View (slot-centric tickets + unresolved issues)

**Status:** Complete

**Objective:** A read-only, slot-centric view of existing ticket data: (1) the slots that have at least one ticket, with Slot Id, Slot Label, Road and ticket count; (2) per slot, its unresolved issues and every ticket. No new tables; one permission migration (`026`) for the new `Slot View` screen.

**Behavior:**
- New router `src/routes/slot-view.ts`, mounted at `/api/slot-view`, `requireAuth` + `authorize('Slot View', 'v')` on every route. Rows cover every road (no road scoping, like the ticket list since Phase 51).
- New permission screen **`Slot View`** (`ScreenName`, `SCREENS` after `Dashboard`, every `DEFAULT_ROLE_PERMS` entry): Admin and Project manager `v.....`, every other role `......`. Migration `026_slot_view_permission.sql` inserts one row per existing role (view only for Admin / Project manager, `ON CONFLICT DO NOTHING`); new roles get it from `SCREENS` like any other screen. Admins grant or revoke it per role in Roles & permissions (`PATCH /api/roles/:id/permissions`); the check reads `role_permissions` on every request, so a change applies without re-login. Only `v` is used.
- `GET /api/slot-view?q=&page=&limit=` — one aggregate with **tickets as the base table** (`FROM tickets t JOIN devices d JOIN roads r … GROUP BY d.id, r.name`), so a slot without tickets never appears. `ticketCount = COUNT(t.id)`: per ticket, never per issue (no `ticket_issues` join), every status including Closed. `q` matches Slot Label, Slot Id, `public_id`, road name. Total = `COUNT(DISTINCT t.device_id)`. Pagination = shared `pageSchema` / `limitSchema` (10/25/50/100) in SQL.
- Order: `slotLabelOrderBy('d', { natural: true })` — Slot Label with digit runs compared by value (`3-2` < `3-12` < `3-121`), blanks last, `public_id` tie-break; SQL-side so it holds across pages. Synced SmartPark labels are not zero-padded (405 of 748 local devices look like `3-12`), so plain text order would put `3-12` before `3-2`. The Device list keeps its plain order (`slotLabelOrderBy()`, unchanged output).
- `GET /api/slot-view/:slotId` — resolves the slot with `deviceLookupWhere` (Slot Id, `public_id` or UUID) → `404 NOT_FOUND` when unknown. Returns `{ slot: { id, uuid, slotId, slotLabel, road }, ticketCount, unresolvedIssues[] }`. Unresolved issues reuse `loadOpenDeviceTickets` (one query: non-Closed tickets of the device with only their `role='reported' AND status='Open'` rows), deduplicated by `subCategoryId` (stable id), each entry `{ id, categoryId, subCategoryId, category, sub, severity, status: 'Open', tickets: [{ id, uuid }] }`. Resolved Sub Issues and found-on-site rows never appear; a Main Issue appears while at least one of its Sub Issues is Open. Closing resolves every Open issue (Phase 49), so Closed tickets contribute none. `idx_ticket_issues_one_open_issue_per_device` already allows one Open copy per slot + Sub Issue; the dedup is the read-side guard.
- `GET /api/tickets` gains optional `device` (`deviceLookupWhere` in `baseWhere`). Without `tab` it lists every status, so Slot View's ticket section reuses the list row shape, pagination and `raised_at DESC` order — no second ticket query or mapper. Tiles / counts follow the same base filter. This endpoint keeps its own `All tickets` `v` gate (both Slot View default roles have it).
- `src/lib/device-ref.ts`: `slotLabelOrderBy(alias, { natural })` replaces the private `DEVICE_LIST_ORDER_BY` string.

**Response:** list `{ success, data: [{ id, uuid, slotId, slotLabel, road, ticketCount }], pagination }`; detail `{ success, data: { slot, ticketCount, unresolvedIssues } }`. `id` = `deviceDisplayId` (Slot Id, else `PD-xxxx`) and is the frontend route key.

**Files:** `src/routes/slot-view.ts` (new), `src/app.ts`, `src/routes/tickets.ts`, `src/routes/devices.ts`, `src/lib/device-ref.ts`, `src/lib/permissions.ts`, `src/types/api.ts`, `src/db/migrations/026_slot_view_permission.sql` (new), `scripts/smoke-slot-view.ts` (new), `package.json` (`test:smoke:slot-view`).

**Testing:** `npm run test:smoke:slot-view`: 1 only ticketed slots listed (a slot without tickets is absent), natural order (`-2` before `-10`), 3 tickets (one with 3 issues, one Closed) count 3; 2 page 2 empty, `limit=7` → 400, search by label; 3 detail returns only Open subs — a Resolved sub of a Main Issue is hidden while its Open sibling stays, issues of a Closed ticket are hidden, each issue links its ticket; 4 a re-raised sub points at the new ticket, Sub Issues unique, lookup by UUID; 5 `/api/tickets?device=` lists all 4 tickets incl. Closed and none from another slot, unknown device → empty; 6 unknown slot 404, existing slot without tickets → empty sections, no token 401; `GET /api/roles` shows Slot View `v` for Admin / Project manager only and `......` for a new role; a role with `All tickets v` but no Slot View → 403 on list and detail (200 on `?device=`); granting Slot View via `PATCH /api/roles/:id/permissions` → 200; Slot View without `All tickets` → 200 on Slot View, 403 on `?device=`; revoking → 403 again.

**Verification:** `npm run db:migrate` (applies `026`); `npx tsc --noEmit -p .`; `test:smoke:slot-view`, `test:smoke:roles`, `test:smoke:users`, `test:smoke:multi-ticket`, `test:smoke:issue-resolution`, `test:smoke:ticket-flow`, `test:smoke:issue-groups` pass on the local Postgres DB. (`test:smoke` stops at "tech device-sync should be authorized": the local DB has Technician / Engineer `Device list` `c` switched off in the matrix — data drift, unrelated to this phase.)

**Frontend (done, frontend Phase 53):** Sidebar **Slot View** after Dashboard, gated on the `Slot View` screen, with its own row in the Roles & permissions matrix; `/slot-view` list and `/slot-view/:slotId` detail (Unresolved issues + Tickets via the shared `TicketTable`).

## Phase 54 — Notification preferences (Push Notifications / Play Notification Sound)

**Status:** Complete

**Objective:** Store each user's application-level push preferences and make the delivery pipeline respect them. Browser permission stays browser-owned.

**Behavior:**
- Migration `027_user_notification_preferences.sql`: `users.push_notifications_enabled` and `users.play_notification_sound`, both `BOOLEAN NOT NULL DEFAULT TRUE`. Existing users keep the current behaviour (subscribed users received push with sound). No new table.
- `loadAuthUser` selects both columns in its existing query. `toClientUser` adds `notificationPreferences { pushNotificationsEnabled, playNotificationSound }` to the login and `/me` user.
- `PATCH /api/auth/me/notification-preferences` (`requireAuth`): strict body with optional booleans and at least one required; unknown keys such as `userId` → `400`. `COALESCE` partial update of `req.user.id` only. Returns the client user.
- `deliverNotificationPush`: `AND u.push_notifications_enabled = TRUE` plus `u.play_notification_sound` in the one recipient/subscription JOIN, so it adds no queries and covers every subscription the user holds. Payload `notification.silent = !play_notification_sound`, `data.playSound`. Suppressed rows keep `push_sent_at = NULL`; in-app rows, unread count and read APIs are unchanged; `404`/`410` cleanup is unchanged.

**Files:** `src/db/migrations/027_user_notification_preferences.sql` (new), `src/middleware/auth.ts`, `src/routes/auth.ts`, `src/lib/notifications.ts`, `src/types/api.ts`, `scripts/smoke-notification-preferences.ts` (new), `package.json` (`test:smoke:notification-prefs`).

**Testing:** `npm run test:smoke:notification-prefs`. It checks that the columns are NOT NULL with TRUE defaults; login and `/me` expose the preferences; no token → 401; body `userId` / empty / non-boolean → 400; changing your own preferences leaves other users untouched; the preference persists across a new login; push OFF with two subscriptions → sender never called, `push_sent_at` stays NULL, unread count still counts the row; push ON + sound OFF → both devices get `silent: true`; sound ON → `silent: false`; push OFF + sound ON → no delivery and sound preserved; `410` removes subscriptions. The script inserts and removes its own rows and restores the original preferences.

**Verification:** `npm run db:migrate` (applies `027`); `npx tsc --noEmit -p .`; `test:smoke:notification-prefs`, `test:smoke:writes`, `test:smoke:multi-ticket` and `test:smoke:no-assignment` pass (`test:smoke` stops at the known device-sync permission drift, the same on a clean tree).

**Frontend (done, frontend Phase 54):** Settings → Notifications panel (Push Notifications, Browser Permission status, Play Notification Sound), push controls removed from the bell, logout keeps the browser subscription, and the service worker honours `silent`.
