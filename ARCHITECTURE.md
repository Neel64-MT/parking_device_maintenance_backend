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
│   ├── controllers/
│   ├── services/
│   ├── repositories/
│   └── schemas/
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
- **Masters** — Roads, issue categories/subs, parts (seeded, no UI CRUD)
- **Devices** — Inventory, QR scan, derived operational status from open tickets
- **Tickets** — Lifecycle (raise → assign → update → close), events, costs, photos
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
