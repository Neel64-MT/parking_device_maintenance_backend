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
- `npm run test:smoke:writes` — device/ticket lifecycle, road create, one-open-ticket rule, issue category/subcategory delete/IN_USE, uploads, user patch, dashboard/report

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
