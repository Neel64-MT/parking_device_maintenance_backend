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
