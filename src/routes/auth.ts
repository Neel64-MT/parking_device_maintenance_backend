import { z } from 'zod'
import jwt from 'jsonwebtoken'
import { Router } from 'express'
import { ApiError, handleApiError } from '../lib/api-error.js'
import {
  consumePasswordResetToken,
  hashPassword,
  isEmailIdentifier,
  issuePasswordResetToken,
  markPasswordChanged,
  markPasswordResetTokenUsed,
  normalizeEmail,
  normalizeMobile,
  passwordSchema,
  signAccessToken,
  verifyPassword,
} from '../lib/auth.js'
import { sendPasswordResetEmail } from '../lib/mail.js'
import { ok } from '../lib/respond.js'
import { query } from '../db/pool.js'
import {
  loadAuthUser,
  logoutCurrentToken,
  requireAuth,
  type AuthUser,
  type AuthedRequest,
} from '../middleware/auth.js'

const router = Router()

const GENERIC_FORGOT_MESSAGE =
  'If an account exists for this email, a password reset link has been sent.'

const FORGOT_PASSWORD_ROLE_MESSAGE =
  'Only Admin or Project Manager can reset a password using Forgot Password.'

const PENDING_APPROVAL_MESSAGE = 'Please ask the admin to approve your request.'

/** Forgot / email-reset is limited to ops-lead roles (same names as dashboard home). */
function canUseForgotPassword(roleName: string) {
  return roleName === 'Admin' || roleName === 'Project manager'
}

function toClientUser(u: AuthUser) {
  return {
    id: u.id,
    name: u.fullName,
    email: u.email,
    mobile: u.mobile,
    role: u.roleName,
    initials: u.initials,
    scope: u.scope,
    roads: u.roadNames,
    permissions: u.permissions,
  }
}
const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1, 'Password is required'),
})

const signupSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  mobile: z.string().trim().min(10).max(20),
  email: z.string().trim().email('Valid email is required'),
  password: passwordSchema,
})

const forgotSchema = z.object({
  email: z.string().trim().email('Valid email is required'),
})

const resetSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  password: passwordSchema,
})

function resolveLoginIdentifier(raw: string) {
  if (isEmailIdentifier(raw)) {
    const email = normalizeEmail(raw)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiError(400, 'Identifier must be a valid email or 10-digit mobile', 'VALIDATION_ERROR')
    }
    return email
  }
  const mobile = normalizeMobile(raw)
  if (!/^\d{10}$/.test(mobile)) {
    throw new ApiError(400, 'Identifier must be a valid email or 10-digit mobile', 'VALIDATION_ERROR')
  }
  return mobile
}

router.post('/signup', async (req, res) => {
  try {
    const body = signupSchema.parse(req.body)
    const mobile = normalizeMobile(body.mobile)
    if (!/^\d{10}$/.test(mobile)) {
      throw new ApiError(400, 'Mobile must be a 10-digit number', 'VALIDATION_ERROR')
    }
    const email = normalizeEmail(body.email)
    const passwordHash = await hashPassword(body.password)

    const roleResult = await query<{ id: string }>(
      `SELECT id FROM roles WHERE name = 'Site attendant' LIMIT 1`,
    )
    if (!roleResult.rowCount) {
      throw new ApiError(500, 'Default signup role is not configured', 'INTERNAL_ERROR')
    }

    await query(
      `INSERT INTO users (full_name, mobile, email, password_hash, role_id, status)
       VALUES ($1, $2, $3, $4, $5, 'Pending')`,
      [body.fullName.trim(), mobile, email, passwordHash, roleResult.rows[0].id],
    )

    return ok(
      res,
      null,
      'Signup request received. Please ask the admin to approve your request before signing in.',
    )
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.post('/login', async (req, res) => {
  try {
    const { identifier: raw, password } = loginSchema.parse(req.body)
    const identifier = resolveLoginIdentifier(raw)

    const userResult = await query<{ id: string; status: string; password_hash: string; password_version: number }>(
      `SELECT id, status, password_hash, COALESCE(password_version, 0) AS password_version FROM users
       WHERE mobile = $1 OR LOWER(email) = LOWER($1)`,
      [identifier],
    )
    if (!userResult.rowCount) {
      throw new ApiError(401, 'Invalid credentials', 'INVALID_CREDENTIALS')
    }

    const user = userResult.rows[0]
    const passwordOk = await verifyPassword(password, user.password_hash)
    if (!passwordOk) {
      throw new ApiError(401, 'Invalid credentials', 'INVALID_CREDENTIALS')
    }

    if (user.status === 'Pending') {
      throw new ApiError(403, PENDING_APPROVAL_MESSAGE, 'PENDING_APPROVAL')
    }
    if (user.status !== 'Active') {
      throw new ApiError(403, 'Account is inactive', 'INACTIVE')
    }

    const { token, jti } = signAccessToken(user.id, undefined, user.password_version)
    const decoded = jwt.decode(token) as { exp: number }
    const authUser = await loadAuthUser(user.id, jti, decoded.exp, user.password_version)

    return ok(
      res,
      {
        token,
        user: toClientUser(authUser),
      },
      'Logged in',
    )
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.post('/forgot-password', async (req, res) => {
  try {
    const { email: rawEmail } = forgotSchema.parse(req.body)
    const email = normalizeEmail(rawEmail)

    const userResult = await query<{ id: string; email: string; role_name: string }>(
      `SELECT u.id, u.email, r.name AS role_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE LOWER(u.email) = LOWER($1) AND u.status = 'Active'`,
      [email],
    )

    if (userResult.rowCount) {
      const user = userResult.rows[0]
      if (!canUseForgotPassword(user.role_name)) {
        throw new ApiError(403, FORGOT_PASSWORD_ROLE_MESSAGE, 'FORGOT_PASSWORD_ROLE_DENIED')
      }
      const rawToken = await issuePasswordResetToken(user.id)
      try {
        await sendPasswordResetEmail(user.email, rawToken)
      } catch {
        // Do not reveal email delivery failures (same generic response).
      }
    }

    return ok(res, null, GENERIC_FORGOT_MESSAGE)
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = resetSchema.parse(req.body)
    const row = await consumePasswordResetToken(token)
    if (!row) {
      throw new ApiError(400, 'Invalid or expired reset token', 'INVALID_RESET_TOKEN')
    }

    const roleResult = await query<{ role_name: string }>(
      `SELECT r.name AS role_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1`,
      [row.user_id],
    )
    if (!roleResult.rowCount || !canUseForgotPassword(roleResult.rows[0].role_name)) {
      throw new ApiError(403, FORGOT_PASSWORD_ROLE_MESSAGE, 'FORGOT_PASSWORD_ROLE_DENIED')
    }

    const passwordHash = await hashPassword(password)
    await query(`UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`, [
      row.user_id,
      passwordHash,
    ])
    await markPasswordResetTokenUsed(row.id)
    await markPasswordChanged(row.user_id)

    return ok(res, null, 'Password updated')
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  try {
    return ok(res, toClientUser(req.user!), 'OK')
  } catch (error) {
    return handleApiError(res, error)
  }
})

const profileSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  mobile: z.string().trim().min(10).max(20),
  email: z.string().trim().email('Valid email is required'),
})

router.patch('/me', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const body = profileSchema.parse(req.body)
    const mobile = normalizeMobile(body.mobile)
    if (!/^\d{10}$/.test(mobile)) {
      throw new ApiError(400, 'Mobile must be a 10-digit number', 'VALIDATION_ERROR')
    }
    const email = normalizeEmail(body.email)
    const userId = req.user!.id

    await query(
      `UPDATE users SET
         full_name = $2,
         mobile = $3,
         email = $4,
         updated_at = NOW()
       WHERE id = $1`,
      [userId, body.fullName, mobile, email],
    )

    const version = await query<{ password_version: number }>(
      `SELECT COALESCE(password_version, 0) AS password_version FROM users WHERE id = $1`,
      [userId],
    )
    const authUser = await loadAuthUser(
      userId,
      req.user!.jti,
      req.user!.tokenExp,
      version.rows[0].password_version,
    )
    return ok(res, toClientUser(authUser), 'Profile updated')
  } catch (error) {
    return handleApiError(res, error)
  }
})

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: passwordSchema,
})

router.post('/change-password', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const body = changePasswordSchema.parse(req.body)
    const userId = req.user!.id

    const row = await query<{ password_hash: string; password_version: number }>(
      `SELECT password_hash, COALESCE(password_version, 0) AS password_version FROM users WHERE id = $1`,
      [userId],
    )
    if (!row.rowCount) throw new ApiError(401, 'Unauthorized', 'UNAUTHORIZED')

    const currentOk = await verifyPassword(body.currentPassword, row.rows[0].password_hash)
    if (!currentOk) {
      throw new ApiError(400, 'Current password is incorrect', 'INVALID_PASSWORD')
    }
    if (body.currentPassword === body.newPassword) {
      throw new ApiError(400, 'New password must be different from the current password', 'VALIDATION_ERROR')
    }

    const passwordHash = await hashPassword(body.newPassword)
    await query(`UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`, [
      userId,
      passwordHash,
    ])
    await markPasswordChanged(userId)
    await logoutCurrentToken(req.user!)

    const version = await query<{ password_version: number }>(
      `SELECT COALESCE(password_version, 0) AS password_version FROM users WHERE id = $1`,
      [userId],
    )
    const passwordVersion = version.rows[0].password_version
    const { token, jti } = signAccessToken(userId, undefined, passwordVersion)
    const decoded = jwt.decode(token) as { exp: number }
    const authUser = await loadAuthUser(userId, jti, decoded.exp, passwordVersion)

    return ok(
      res,
      {
        token,
        user: toClientUser(authUser),
      },
      'Password updated',
    )
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.post('/logout', requireAuth, async (req: AuthedRequest, res) => {
  try {
    await logoutCurrentToken(req.user!)
    return ok(res, null, 'Logged out')
  } catch (error) {
    return handleApiError(res, error)
  }
})

export default router
