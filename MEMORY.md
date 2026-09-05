# Memory — Implementation State

## Completed

- Phase 0 — Documentation (`PR.md`, `ARCHITECTURE.md`, `RULES.md`, `MEMORY.md`, `PHASES.md`, `SKILL.md` addendum)
- Phase 1 — Express + TypeScript foundation, Zod, `ApiError`, logger, health route
- Phase 2 — SQL migrations + seed against real PostgreSQL via `DB_*` env
- Phase 3 — Email/mobile + password JWT auth, `/me`, logout (token denylist), `authorize(screen, flag)`, road scope
- Phase 4 — Roads, issues, parts, lookups
- Phase 5 — Users & roles APIs (create user requires email/password)
- Phase 6 — Devices list/create/detail/scan/QR/export
- Phase 7 — Tickets lifecycle + uploads
- Phase 8 — Dashboard & work report + CSV exports
- Phase 9 — Smoke tests: `npm run test:smoke` + `npm run test:smoke:writes`
- Phase 10 — Postgres cutover + API verification
- Phase 11 — Forgot Password + Admin password hardening (`003`/`004` migrations, mail helper, `pv` JWT claim)

## Currently Working On

- (idle — password reset APIs complete; frontend wiring out of scope until authorized)

## Pending

### FRONTEND CHANGE REQUIRED (do not implement until authorized)

Pages still on `frontend/src/data/*` mocks (or design-preview toasts):

- Dashboard → `GET /api/dashboard`
- Tickets list / raise / detail / assign / update / close → `/api/tickets*`
- Devices list / add / history / scan / QR → `/api/devices*`
- Road master → `/api/roads*`
- Issue master → `/api/issues*`
- Users & roles → `/api/users*`, `/api/roles*` (add password field on create/edit)
- Work report → `/api/reports/work*`
- Photo uploads → `POST /api/uploads`
- Auth partially wired; still need Forgot/Reset pages:
  - Login link → `/forgot-password` → `POST /api/auth/forgot-password`
  - `/reset-password?token=` → `POST /api/auth/reset-password`

## Important Decisions

- Runtime: Node.js + `tsx`
- DB: PostgreSQL via `DB_*` (preferred)
- Auth: email or mobile + password, Bearer JWT
- Reset tokens: sha256-hashed, 1h TTL, one-time; optional SMTP; dev console link if no SMTP
- Password change increments `password_version`; JWTs carry `pv` and are rejected when mismatched
- Admin password change reuses `PATCH /api/users/:id` + `authorize('Users','e')`
- Frontend: never modified unless user explicitly authorizes
