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

**FRONTEND CHANGE REQUIRED:** Forgot/Reset pages + Login link; Users form password field wired to existing PATCH.
