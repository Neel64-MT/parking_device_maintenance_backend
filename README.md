# Parking Device Maintenance — Backend

Node.js (Express + TypeScript) REST API for the parking device maintenance frontend.

## Stack

- Express + TypeScript + Zod
- PostgreSQL-compatible SQL via `pg`, with local **PGlite** default (no server required)
- JWT Bearer auth (email or mobile + password)
- Local file uploads (`uploads/`)
- QR PNG via `qrcode`

## Setup

```bash
cp .env.example .env
npm install
npm run db:setup
npm run dev
```

Server: `http://localhost:5000`

### Database options

Configure Postgres with discrete env vars in `.env`:

```env
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=your_password_here
DB_NAME=parking_device_maintenance
```

Optional fallbacks:

| Mode | How |
|------|-----|
| Connection string | `DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/parking_device_maintenance` |
| Embedded local DB | `USE_PGLITE=1` or `DATABASE_URL=pglite:./data/pdm` |

## Auth

| Method | Path | Body |
|--------|------|------|
| POST | `/api/auth/login` | `{ "identifier": "9825012345", "password": "Password123" }` |
| GET | `/api/auth/me` | `Authorization: Bearer <token>` |
| POST | `/api/auth/logout` | Bearer token |

`identifier` is a 10-digit mobile **or** an email address.

### Demo user (seed)

| Field | Value |
|-------|-------|
| Name | Alkesh Patel |
| Role | Project manager |
| Mobile | `9825012345` |
| Email | `alkesh.patel@pdm.local` |
| Password | `Password123` |

## Smoke test

```bash
npx tsx scripts/smoke-inprocess.ts
```

## Response shape

```json
{ "success": true, "data": {}, "message": "Optional" }
```

```json
{ "success": false, "error": "...", "code": "ERROR_CODE" }
```

## Docs

- `PR.md` — requirements
- `ARCHITECTURE.md` — structure
- `RULES.md` — conventions / authz
- `MEMORY.md` — implementation state
- `PHASES.md` — phase checklist
- `SKILL.md` — API design standards

## Frontend

The sibling `frontend/` directory is **read-only**. Wiring UI to these APIs is **FRONTEND CHANGE REQUIRED** (no login page, no API client, detail pages ignore URL params, etc.).
