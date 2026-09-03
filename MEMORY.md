# Memory — Implementation State

## Completed

- Phase 0 — Documentation (`PR.md`, `ARCHITECTURE.md`, `RULES.md`, `MEMORY.md`, `PHASES.md`, `SKILL.md` addendum)
- Phase 1 — Express + TypeScript foundation, Zod, `ApiError`, logger, health route
- Phase 2 — SQL migrations + seed (PGlite local / PostgreSQL via `DATABASE_URL`)
- Phase 3 — Email/mobile + password JWT auth, `/me`, `authorize(screen, flag)`, road scope
- Phase 4 — Roads, issues, parts, lookups
- Phase 5 — Users & roles APIs
- Phase 6 — Devices list/create/detail/scan/QR/export
- Phase 7 — Tickets lifecycle + uploads
- Phase 8 — Dashboard & work report + CSV exports
- Phase 9 — In-process smoke tests (`scripts/smoke-inprocess.ts`)

## Currently Working On

- (idle — OTP auth replaced with email/mobile + password)

## Pending

- FRONTEND CHANGE REQUIRED (wiring UI — not in scope until authorized)
- Optional: point `DATABASE_URL` at a real PostgreSQL instance when credentials are available

## Decisions

- Runtime: Node.js + `tsx` (Bun not installed on this machine)
- DB: PostgreSQL-compatible SQL; local default is embedded **PGlite** (`pglite:./data/pdm`); real Postgres when `DATABASE_URL=postgresql://...`
- Auth: email or mobile + password, Bearer JWT (seeded demo password `Password123`)
- Uploads: local disk under `UPLOAD_DIR`
- Route style: Express routers in `src/routes/*.ts`
- Frontend: never modified
