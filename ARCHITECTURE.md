# Architecture — Parking Device Maintenance API

## App Flow

```text
Client (curl / future frontend)
  → HTTP JSON / multipart
Express (src/app.ts)
  → request logger middleware
  → optional JWT auth middleware
  → authorize(screen, flag) middleware
  → Zod validation (body / params / query)
  → Controller
  → Service (business rules)
  → Repository (SQL via pg)
  → PostgreSQL
  → { success, data, message } | { success: false, error, code }
```

Static uploads are served from `/uploads`.

## Folder & File Structure

```text
backend/
├── src/
│   ├── app.ts
│   ├── server.ts
│   ├── config/env.ts
│   ├── db/
│   │   ├── pool.ts
│   │   ├── migrate.ts
│   │   ├── migrations/
│   │   └── seed.ts
│   ├── types/api.ts
│   ├── lib/
│   │   ├── api-error.ts
│   │   ├── api-logger.ts
│   │   └── respond.ts
│   ├── middleware/
│   │   ├── auth.ts
│   │   ├── authorize.ts
│   │   ├── error-handler.ts
│   │   └── upload.ts
│   ├── routes/
│   ├── lib/ (incl. device-sync.ts, device-sync-client.ts)
│   └── types/api.ts
├── uploads/
├── .env.example
├── package.json
├── tsconfig.json
├── PR.md
├── ARCHITECTURE.md
├── RULES.md
├── DESIGN.md
├── MEMORY.md
├── PHASES.md
└── SKILL.md
```

## Tech Stack

| Layer | Choice |
|-------|--------|
| Runtime | Node.js + tsx (Bun optional if installed) |
| Language | TypeScript |
| HTTP | Express |
| Validation | Zod |
| Database | PostgreSQL (`pg`) via `DB_*` env; optional PGlite |
| Auth | JWT Bearer + email/mobile password |
| Uploads | multer → local disk |
| QR labels | `qrcode` PNG |

No Nest, Prisma, or Next.js file-based routing. Express routers live in `src/routes/*.ts`.

## Key Domains

- **Auth / Users / Roles** — Email or mobile + password login, forgot/reset password, permission matrix, road assignments
- **Masters** — Roads, issue categories/subs, parts (with `amount`; CRUD via `/api/parts` + Issue master flags)
- **Devices** — Inventory, QR scan, derived operational status from open tickets
- **Tickets** — Lifecycle (`Open` → assign/`Under repair` → `Waiting for spare` optional → `Closed`), events, visit cost = labour + parts master, photos
- **Reports** — Dashboard aggregates, work report by period

## Password reset architecture

```text
User
 → Login Screen
 → POST /api/auth/forgot-password
 → password_reset_tokens (hashed token, 1h TTL)
 → Email (SMTP) or development console link
 → POST /api/auth/reset-password
 → users.password_hash + password_changed_at
 → Existing login
```

```text
Admin
 → Admin Panel (Users)
 → PATCH /api/users/:id { password }
 → authorize('Users','e')
 → password_hash + password_changed_at
 → Prior JWTs (iat before password_changed_at) rejected
```

| Piece | Location |
|-------|----------|
| APIs | `src/routes/auth.ts` (`forgot-password`, `reset-password`), `src/routes/users.ts` (PATCH password) |
| Helpers | `src/lib/auth.ts` (hash/reset tokens/`pv`), `src/lib/mail.ts` |
| DB | `password_reset_tokens`, `users.password_changed_at`, `users.password_version` |
| Design | `DESIGN.md` |

## Ticket visibility

```text
Admin / Project manager
  → all tickets (all_roads)

Other roles
  → SQL: assignee_id = me OR raised_by_user_id = me
  → Detail/update/close: assertTicketAccess
  → Assign: Control room / Admin / PM only (`assertCanAssignTickets` + road access)
```

Single helper: [`src/lib/ticket-access.ts`](src/lib/ticket-access.ts) (`appendTicketVisibilitySql`, `assertTicketAccess`).

Consumed by:

| Area | Route file |
|------|------------|
| Ticket list / export / detail / mutations | [`src/routes/tickets.ts`](src/routes/tickets.ts) |
| Dashboard fleet overlay, down reasons, open list, open-over-3 | [`src/routes/dashboard.ts`](src/routes/dashboard.ts) |
| Device list / export / scan open ticket + 6m counts; device history tickets/parts/fail ranks | [`src/routes/devices.ts`](src/routes/devices.ts) |
| Work report + CSV export | [`src/routes/reports.ts`](src/routes/reports.ts) |

Road/user/issue-master aggregate catalogs stay city-wide admin metrics (not personal ticket scope).

**FRONTEND CHANGE REQUIRED:** when Dashboard / All Tickets / Device screens leave mocks, trust API scope — do not re-filter by role in the browser.

## QR scan → raise ticket

```text
Client scans QR / enters device code
  → GET /api/devices/scan?q={publicId|qr|slot}  (authorize Scan QR v)
  → Response: deviceId, deviceName, locationSite, slot, currentStatus, statusDate,
               ticketsLast6Months, openTicketId?, openTicketAge?, openTicketIssue?,
               latitude, longitude (+ legacy id/facts)
  → If openTicketId set → open existing ticket
  → Else POST /api/tickets { deviceId, ... }
       → if another open ticket: 409 OPEN_TICKET_EXISTS { openTicketId, ticketId }
```

Device `latitude` / `longitude` are TEXT columns (create/PATCH/seed). Open-ticket overlays on scan respect ticket visibility for non-Admin/PM.

## Signup approval

```text
POST /api/auth/signup → status Pending
Admin or Project manager (Users v/c/e)
  → GET /api/users?status=Pending
  → PATCH /api/users/:id { status: Active, roleId, ... }
```

Project manager Users permission: `vce...` (migration `006_pm_users_edit.sql`).

## Ticket statuses

```text
POST /api/tickets (no assignee) → Open
POST /api/tickets (with assignee) or POST .../assign → Under repair
POST .../updates (Waiting for spare) → Waiting for spare
POST .../updates (other visit) → Under repair
POST .../close → Closed
```

Stored values: `Open` | `Under repair` | `Waiting for spare` | `Closed`. Do not write `New`.

Migration `007_ticket_status_open.sql` rewrites leftover `New` → `Open`.

“One open ticket per device” = any row with `status <> 'Closed'`.

## Ticket list presentation (`GET /api/tickets`)

Tabs (query `tab`):

| Tab key | Meaning |
|---------|---------|
| `new` | Unassigned and not closed |
| `asg` | Has assignee (not closed) |
| `cls` | Closed |

List/export row `status` and tiles use presentation helpers (DB unchanged):

- `New` → display as `Open`
- Assigned + stored `Open` → list shows `Under repair` (so Assigned-tab pills align with Under repair tile)
- Detail (`GET /api/tickets/:id`) still returns stored status (`New` normalized to `Open` only)

## Ticket list aging

`GET /api/tickets` row fields:

| Field | Meaning |
|-------|---------|
| `daysOpen` | Whole days from `raised_at` to `closed_at` (or now if still open) |
| `daysAfterClose` | Whole days since `closed_at`, or `null` if not closed |

List-only. Ticket detail still uses a “Days open” header fact, not `daysAfterClose`.

## List pagination (Tickets + Devices)

```text
Request page/limit (+ filters)
  → Auth + authorize(screen, v)
  → Scope (ticket visibility / device road scope)
  → SQL search/filters (incl. ticket tab/status; device derived status/repeats)
  → COUNT(*) for total (+ tile aggregates)
  → SELECT ... ORDER BY ... LIMIT/OFFSET
  → { data, pagination: { page, limit, total, totalPages }, tiles... }
```

Shared helpers: [`src/lib/pagination.ts`](src/lib/pagination.ts) (`pageSchema`, `limitSchema`, `paginationMeta`, `sqlOffset`).

Defaults: `page=1`, `limit=10`. Allowed limits: `10|25|50|100`.

Routes: [`src/routes/tickets.ts`](src/routes/tickets.ts), [`src/routes/devices.ts`](src/routes/devices.ts). Export CSVs stay full-set (unpaginated).

## Parts master & visit cost

```text
POST /api/tickets/:id/updates|close
  body.cost = labour only
  body.parts = uuid[]
  → resolvePartsCost (dedupe, active master rows)
  → eventCost = labour + SUM(amount)
  → ticket_events.cost + parts JSONB snapshot
  → ticket_event_parts rows
  → tickets.total_cost += eventCost
```

| Piece | Location |
|-------|----------|
| Migration | [`src/db/migrations/009_parts_amount.sql`](src/db/migrations/009_parts_amount.sql) |
| Helper | [`src/lib/parts-cost.ts`](src/lib/parts-cost.ts) |
| CRUD / list | [`src/routes/parts.ts`](src/routes/parts.ts), lookups |
| Update / close | [`src/routes/tickets.ts`](src/routes/tickets.ts) |

**FRONTEND CHANGE REQUIRED:** send part UUIDs; keep `cost` labour-only.

## Device Sync (SmartPark)

```text
Client Sync Device
  → POST /api/device-sync  (authorize Device list c)
  → INSERT device_sync_runs status=started
  → 202 { id, status }
  → setImmediate background job
       → GET {DEVICE_SYNC_BASE_URL}/locations (Authorization Bearer)
       → insert new roads (match external_location_id / name)
       → GET .../qr-codes?status=all&page=1&per_page=50
       → total = data.summary.total; pages = data.pagination.last_page
       → upsert devices by qr_code (= qr_number)
       → status completed | failed
```

| Piece | Location |
|-------|----------|
| Migration | [`src/db/migrations/010_device_sync.sql`](src/db/migrations/010_device_sync.sql) |
| Client | [`src/lib/device-sync-client.ts`](src/lib/device-sync-client.ts) |
| Runner | [`src/lib/device-sync.ts`](src/lib/device-sync.ts) |
| Routes | [`src/routes/device-sync.ts`](src/routes/device-sync.ts) |
| Env | `DEVICE_SYNC_BASE_URL`, `DEVICE_SYNC_API_TOKEN` |

APIs: `POST /api/device-sync`, `GET /api/device-sync/latest`, `GET /api/device-sync/:id`.

Synced locations are written into the existing `roads` table (single source of truth). `GET /api/roads` and `GET /api/lookups/roads` are thin reads of that table — no separate sync-roads API.

Field mapping (external → DB): `slot.id` → `slot_id` (**immutable** match key), `slot.slot_label` → `slot_number`, `mac_address` → `slot_identifier` (updatable), `qr_number` → `qr_code` (updatable), `parking_location` → `roads` / `road_id`. Ticket/device APIs expose Slot Id as `deviceId` when available.
