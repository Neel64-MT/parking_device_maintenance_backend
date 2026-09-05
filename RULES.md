# Rules — Parking Device Maintenance API

## What to do

- Follow `SKILL.md`: Zod validation, consistent `{ success, data }` / `{ success, false, error, code }`, HTTP status codes, `ApiError`, request logging.
- Keep business logic in **services**; routes/controllers stay thin.
- Validate **body, params, and query** with Zod on every endpoint.
- Enforce **authorization server-side** via `authorize(screen, flag)` plus road scope and ticket holder checks.
- Store secrets only in environment variables (`.env` / `.env.local`).
- Never return passwords, password hashes, JWT secrets, raw reset tokens, or stack traces to clients.
- Soft-inactivate users; never hard-delete (ticket history must remain readable).
- Soft-deactivate issue sub-categories that have been used on tickets; hard-delete only when unused.
- Derive device operational status from open tickets after go-live (do not trust client status for runtime).
- One open ticket per device; closed ticket within 7 days reopens the same ticket.
- Only the current ticket holder may update or close; handover transfers that right.
- Keep the sibling `frontend/` directory **read-only** — document needed UI wiring as FRONTEND CHANGE REQUIRED.
- Update `MEMORY.md` / `PHASES.md` after each meaningful phase.
- Forgot-password responses must not reveal whether an account exists.
- Reset tokens must expire, be one-time-use, and be stored hashed only.
- Admin password changes require server-side `authorize('Users', 'e')`; reuse existing user PATCH.
- Reuse existing auth hashing, Zod password rules, and JWT middleware; avoid duplicate auth stacks.
- Do not modify unrelated working login/logout flows except where password-reset/session invalidation requires it.

## What to avoid

- Do not modify the frontend source.
- Do not bypass Zod validation or authorization middleware.
- Do not expose secrets or internal DB details in responses.
- Do not add unnecessary libraries or deep abstractions.
- Do not put business rules only in route handlers.
- Do not invent APIs for screens/features that do not exist in the frontend.
- Do not implement device telemetry auto-ticketing in v1.
- Do not use Next.js-style `routes/[id]/route.ts` layout without a loader — use Express routers.

## Authorization

### Screens

`Dashboard`, `Raise ticket`, `Update ticket`, `All tickets`, `Work report`, `Device list`, `Add device`, `Device history`, `Scan QR`, `Issue master`, `Road master`, `Users`, `Roles & permissions`

### Flags

`v` view · `c` create · `e` edit · `a` assign · `x` close · `d` delete

### Scope

- `all_roads` — city-wide
- `assigned_roads` — only roads linked via `user_roads`

### Special rules

- Technician: tickets they hold (+ raise on assigned roads); no Work report cost visibility (matrix denies Work report).
- Site attendant: raise + scan on assigned roads; cannot assign/close.
- Control room: raise/assign; cannot close.
- AMC officer: view only.
- At least one Admin must always remain active.
- Cost fields on work report: omit for roles without Work report view.
