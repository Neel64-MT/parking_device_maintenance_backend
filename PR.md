# Project Requirements — Parking Device Maintenance API

## What to build

A Node.js (Bun) + Express + TypeScript REST API that backs the existing React design-preview frontend for **AMC flap-based parking device maintenance** (~1,000 devices across 5 Ahmedabad roads).

The frontend remains **read-only / unchanged**. The API supplies every screen’s data and mutations so the UI can be wired later without redesign.

## Target Users

| Role | Purpose |
|------|---------|
| Admin | Full control including users and masters |
| Project manager | All screens except creating users / deleting masters |
| Control room | Raise and route tickets; does not close or edit masters |
| Technician | Attend/update/close tickets on assigned roads only |
| Site attendant | Scan QR and raise tickets on assigned roads |
| AMC officer | View-only everywhere |
| Custom roles | Created via Roles & permissions UI |

**Login:** Email or 10-digit mobile plus password. Ticket alerts still go to the mobile number.

## Features (API-backed)

1. **Authentication** — Email or mobile + password, JWT session, logout, current user (`/me`)
2. **Authorization** — Screen × flag matrix (`v c e a x d`), road scope, ticket holder rules
3. **Dashboard** — Fleet status, down reasons, road-wise status, oldest open tickets
4. **Tickets** — List (tabs/filters), raise, detail, assign, site-update, close; one open ticket per device; 7-day reopen = same ticket
5. **Devices** — List, add, history, QR scan/lookup, QR label PNG, export
6. **Issue master** — Categories / sub-categories with severity; deactivate if used (no hard delete when used)
7. **Road master** — CRUD roads; sequential `RD-xx` codes
8. **Users & roles** — Create/edit/inactivate users; role permission matrix; never hard-delete users
9. **Work report** — Day/week/month/range technician load and outcomes
10. **Lookups** — Roads, technicians, parts, issue categories, road slots
11. **Uploads** — Multipart photos for tickets/devices
12. **Exports** — CSV for tickets, devices, roads, work report

## Out of scope (v1)

- Device telemetry / auto “no data 24 hrs” ticket generation (enum value only)
- Modifying the React frontend
- Real SMS provider for ticket alerts (auth is email/mobile + password)

## Conflicts noted

- Frontend has no login page or API client — APIs are curl-testable; wiring is **FRONTEND CHANGE REQUIRED**.
- Ticket/device detail pages ignore URL params in the preview.
- Claude project-scope share URL was unreachable (Cloudflare); requirements follow frontend source of truth.
