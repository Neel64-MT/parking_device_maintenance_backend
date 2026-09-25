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
