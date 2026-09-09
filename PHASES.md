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
- `npm run test:smoke:writes` — device/ticket lifecycle, road create, one-open-ticket rule, issue subcategory delete/IN_USE, uploads, user patch, dashboard/report

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
