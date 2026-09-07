# Design — Forgot Password & Admin Password Change

## Forgot Password flow

```text
User → Login → Forgot Password
  → POST /api/auth/forgot-password { email }
  → If Active user with that email:
       invalidate prior unused reset tokens
       create crypto token (raw) + store sha256 hash (TTL 1h)
       send reset link via SMTP (or log URL in development)
  → Always return generic success (no account enumeration)
```

Reset link: `{APP_URL or FRONTEND_ORIGIN}/reset-password?token=<raw>`

## Reset Password flow

```text
User opens link → POST /api/auth/reset-password { token, password }
  → Hash token, lookup unused non-expired row
  → Validate password (min 8, shared schema)
  → bcrypt hash → update users.password_hash
  → Set users.password_changed_at = NOW()
  → Mark token used_at; invalidate other unused tokens for user
  → Login with new password works; JWTs with iat < password_changed_at rejected
```

## Admin Password Change flow

```text
Admin → Users panel → PATCH /api/users/:id { password }
  → requireAuth + authorize('Users', 'e')
  → Same password schema + hashPassword
  → Set password_changed_at; clear unused reset tokens
```

No separate `/admin/users/:id/password` route (would duplicate).

## Token strategy

| Item | Choice |
|------|--------|
| Raw token | `crypto.randomBytes(32).toString('hex')` |
| Stored | SHA-256 hex of raw token only |
| TTL | 1 hour |
| Reuse | One-time (`used_at`); new forgot request invalidates prior unused tokens |
| API | Never return or log raw token |

## Email

- Optional SMTP via `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`
- If SMTP unset: still generic success; in `development` log reset URL to console (not API body)
- Production without SMTP: no email sent (documented)

## Session behavior after password change

- Set `users.password_changed_at` and increment `users.password_version`
- JWTs include claim `pv` (password version) at login
- `requireAuth` rejects tokens when `pv` does not match current `password_version`
- Logout denylist of current `jti` unchanged
- No multi-device denylist table

## Password validation

Shared Zod: minimum 8 characters (same for create user, admin patch, reset).

## Frontend (not in this backend workstream)

**FRONTEND CHANGE REQUIRED:** Forgot/Reset pages + Login link; Users form password field wired to existing PATCH; Signup copy may say “Admin or Project manager”.

---

# Design — Ticket Visibility & PM Signup Approval

## Ticket visibility

Privileged roles (`Admin`, `Project manager`): no assignee/raiser filter (still subject to `assigned_roads` if ever scoped that way; defaults are `all_roads`).

All other roles: list/export/aggregate SQL adds  
`(t.assignee_id = $userId OR t.raised_by_user_id = $userId)`.

Detail, updates, close-preview, close call `assertTicketAccess` after load (plus existing road/holder rules).

**Assign exception:** `POST /api/tickets/:id/assign` uses `assertCanAssignTickets` (Control room / Admin / Project manager only) plus `assertRoadAccess` (not `assertTicketAccess`) so Control room can assign tickets they did not raise. Technicians cannot assign, reassign, or handover (`handoverToUserId` is rejected unless the caller can assign). List, detail, dashboard, devices, and work report remain visibility-scoped.

Helpers live in `src/lib/ticket-access.ts` — single reusable rule reused by:

- `tickets.ts` — list, export, detail, mutations
- `dashboard.ts` — fleet open-ticket lateral, down reasons, open tickets, open-over-3
- `devices.ts` — list/export/scan open ticket + 6m counts; detail history/parts/fail ranks
- `reports.ts` — work report events and CSV export

Pagination totals and search/filter on tickets already run after the visibility WHERE clause.

Road master / Users / Issue master usage counts stay unscoped catalog aggregates.

Backward compatible for Admin/PM city-wide views. Narrows Control room vs prior city-wide list (per product requirement).

**FRONTEND CHANGE REQUIRED:** wire Dashboard / All Tickets / Devices to APIs without client-side role ticket filters.

## Project Manager signup approval

Pending signups remain `users.status = 'Pending'` from `POST /api/auth/signup`.

Approval remains `PATCH /api/users/:id` with `status: 'Active'` (and optional `roleId` / details).

Project manager Users permission: `vce...` (view, create, edit). Roles & permissions stay view-only.

No new signup-request table or approve endpoint.

---

# Design — QR Scan Payload & One-Open-Ticket Rule

## Scan API

Canonical endpoint: `GET /api/devices/scan?q={identifier}` (`authorize('Scan QR', 'v')`).

Matches `public_id`, `qr_code`, or `slot_number` (case-insensitive). Applies road scope and ticket visibility on the open-ticket lateral / 6-month count.

Canonical response fields (Phase 17): `deviceId`, `deviceName` (from `model`), `locationSite` (road name), `slot`, `currentStatus` (derived), `statusDate` (open ticket raised date when open, else installed date), `ticketsLast6Months`, `openTicketId`, `openTicketAge`, `openTicketIssue`, `latitude`, `longitude`.

Legacy fields (`id`, `location`, `status`, `statusTone`, `facts`, `deviceUuid`, `roadId`) remain for older ScanQr clients.

No `/api/devices/:id/scan-details` path — avoids conflict with `GET /:deviceId`.

## Device coordinates

`devices.latitude` / `devices.longitude` are TEXT (migration `001_init`). Seed populates Ahmedabad-area dummy strings. Create/PATCH accept optional string coords.

## One open ticket

Before insert on `POST /api/tickets`, query non-`Closed` tickets for the device. If any exist → `ApiError(409, ..., 'OPEN_TICKET_EXISTS', { ticketId, openTicketId })`.

Frontend should redirect to `openTicketId` instead of creating another ticket.

---

# Design — Ticket Status (Open, not New)

## Stored statuses

Exactly four values on `tickets.status`:

| Status | Written by |
|--------|------------|
| `Open` | `POST /api/tickets` when `assigneeId` is omitted |
| `Under repair` | Raise with assignee; `POST /:id/assign`; most site updates |
| `Waiting for spare` | Site update `updateType === 'Waiting for spare'` |
| `Closed` | `POST /:id/close` |

There is no `New` status. Schema default is already `Open` (`001_init`). Migration `007_ticket_status_open.sql` updates any remaining `New` rows.

## “Open” vs “open ticket”

- Status **`Open`**: unassigned, newly raised.
- **Open ticket** (one-per-device / dashboard overlays): any ticket with `status <> 'Closed'` (`Open`, `Under repair`, or `Waiting for spare`).

## List UI

The tickets list tab query `tab=new` means **unassigned and not closed**. Tab key `new` is not a stored status. Tab `asg` = has assignee; `cls` = Closed.

List/export/tiles presentation (`listStatus` in `tickets.ts`):

- Stored `New` → `Open`
- Has `assignee_id` and stored `Open` → list shows `Under repair` (DB unchanged; detail still returns stored status)

Badges for unassigned tickets must render `Open`, never `New`.

**FRONTEND CHANGE REQUIRED:** replace `New` badges with `Open`; trust list `status` for Assigned vs Under repair alignment.

---

# Design — Ticket list `daysAfterClose`

`GET /api/tickets` already returned `daysOpen` (life of the ticket until close or now). Closed rows now also return `daysAfterClose`:

```text
if closed_at set → floor((now - closed_at) / 1 day)
else → null
```

Purpose: All Tickets closed tab / 7-day reopen copy can show “N days since close” without the client parsing dates.

Not added to `GET /api/tickets/:id` (detail still has “Days open” in `header.facts`). No migration.

**FRONTEND CHANGE REQUIRED:** bind closed-ticket aging to `daysAfterClose`.

---

# Design — List presentation for assigned `Open`

Some rows can have `assignee_id` set while stored `status` remains `Open` (legacy / edge cases). Assign path normally writes `Under repair`.

For **list, tiles, and CSV only**, `listStatus(status, assigneeId)` maps assigned + `Open` → `Under repair` so the Assigned tab pills match the Under repair tile without a data migration.

Detail and mutate paths keep stored status (with `New` → `Open` display normalization where applied).
