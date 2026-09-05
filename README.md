# Parking Device Maintenance — Backend

Node.js (Express + TypeScript) REST API for the parking device maintenance frontend.

## Stack

- Express + TypeScript + Zod
- PostgreSQL via `pg` (discrete `DB_*` env vars)
- JWT Bearer auth (email or mobile + password)
- Local file uploads (`uploads/`)
- QR PNG via `qrcode`

## Setup

```bash
cp .env.example .env
# edit DB_* and JWT_SECRET
npm install
npm run db:setup
npm run dev
```

Server: `http://localhost:5000`

### Database

Configure Postgres in `.env` (do not wrap values in quotes):

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
| POST | `/api/auth/forgot-password` | `{ "email": "alkesh.patel@yopmail.com" }` |
| POST | `/api/auth/reset-password` | `{ "token": "...", "password": "NewPassword1" }` |

`identifier` is a 10-digit mobile **or** an email address.

Admin password change: `PATCH /api/users/:id` with `{ "password": "..." }` (`authorize('Users','e')`).

Optional SMTP: set `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM`. Without SMTP, development logs the reset link to the server console.

### Demo users (seed)

| Name | Role | Mobile | Email | Password |
|------|------|--------|-------|----------|
| Alkesh Patel | Project manager | `9825012345` | `alkesh.patel@yopmail.com` | `Password123` |
| Admin User | Admin | `9000000001` | `admin.user@yopmail.com` | `Password123` |

## Smoke tests

```bash
npm run test:smoke          # auth + core GETs + user create + logout
npm run test:smoke:writes   # device / ticket lifecycle / road create
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
- `DESIGN.md` — forgot/reset + admin password design
- `MEMORY.md` — implementation state
- `PHASES.md` — phase checklist
- `SKILL.md` — API design standards

## Frontend

The sibling `frontend/` directory is **read-only** for this backend agent unless you explicitly authorize UI changes.

**FRONTEND CHANGE REQUIRED** — feature screens still on `src/data/*` mocks:

| Screen | Wire to |
|--------|---------|
| Dashboard | `GET /api/dashboard` |
| Tickets | `/api/tickets*` |
| Devices | `/api/devices*` |
| Road master | `/api/roads*` |
| Issue master | `/api/issues*` |
| Users & roles | `/api/users*` (+ password on create/edit), `/api/roles*` |
| Work report | `/api/reports/work*` |
| Photos | `POST /api/uploads` |
| Forgot password | Login link → `/forgot-password` → `POST /api/auth/forgot-password` |
| Reset password | `/reset-password?token=` → `POST /api/auth/reset-password` |
