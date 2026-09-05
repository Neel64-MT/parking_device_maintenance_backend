# Project Requirements — Parking Device Maintenance API

## What to build

A Node.js + Express + TypeScript REST API that backs the existing React design-preview frontend for **AMC flap-based parking device maintenance** (~1,000 devices across 5 Ahmedabad roads).

The frontend remains **unchanged unless explicitly authorized**. The API supplies every screen’s data and mutations so the UI can be wired later without redesign.

## Target Users

| Role | Purpose |
|------|---------|
| Admin | Full control including users and masters |
| Project manager | City-wide ops; can approve Pending signups and manage users (Users `vce...`); cannot delete masters |
| Control room | Raise and route tickets; does not close or edit masters |
| Technician | Attend/update/close tickets on assigned roads only |
| Site attendant | Scan QR and raise tickets on assigned roads |
| AMC officer | View-only everywhere |
| Custom roles | Created via Roles & permissions UI |

**Login:** Email or 10-digit mobile plus password. Self-signup creates `Pending` users (Site attendant) until Admin or Project manager approves via Users.

## Features (API-backed)

1. **Authentication** — Email or mobile + password, JWT session, logout, current user (`/me`), forgot password, reset password
2. **Authorization** — Screen × flag matrix (`v c e a x d`), road scope, ticket holder rules
3. **Dashboard** — Fleet status, down reasons, road-wise status, oldest open tickets
4. **Tickets** — List (tabs/filters), raise, detail, assign, site-update, close; one open ticket per device; 7-day reopen = same ticket. **Visibility:** Admin and Project manager see all (within road scope). All other roles see only tickets where `assignee_id` or `raised_by_user_id` is the current user (enforced in SQL and on detail/mutations).
5. **Devices** — List, add, history, QR scan/lookup, QR label PNG, export
6. **Issue master** — Categories / sub-categories with severity; deactivate if used (no hard delete when used)
7. **Road master** — CRUD roads; sequential `RD-xx` codes
8. **Users & roles** — Create/edit/inactivate users; Admin and Project manager may approve Pending signups, update details/role/password via `PATCH /api/users/:id`; role permission matrix; never hard-delete users
9. **Work report** — Day/week/month/range technician load and outcomes
10. **Lookups** — Roads, technicians, parts, issue categories, road slots
11. **Uploads** — Multipart photos for tickets/devices
12. **Exports** — CSV for tickets, devices, roads, work report

### Ticket visibility requirements

- Admin and Project manager retain city-wide ticket list/detail/export access.
- Every other role may only access tickets assigned to them or raised by them.
- Restrictions are enforced server-side on ticket list, export, detail, update, and close.
- The same visibility scope applies to dashboard ticket metrics, device open-ticket overlays/history counts, and work report ticket rows/export.
- Assign (`POST /api/tickets/:id/assign`) remains road-scoped only so Control room can route tickets they did not raise; list/detail/dashboard stay visibility-scoped.
- Frontend role filtering is presentation only; never the security boundary.

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
| Devices | `/api/devices*` |
| Roads | `/api/roads*` |
| Issue master | `/api/issues*` |
| Users / roles | `/api/users*`, `/api/roles*` |
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
