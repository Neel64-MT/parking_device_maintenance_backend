import { z } from 'zod'
import jwt from 'jsonwebtoken'
import { Router } from 'express'
import { ApiError, handleApiError } from '../lib/api-error.js'
import {
  isEmailIdentifier,
  normalizeEmail,
  normalizeMobile,
  signAccessToken,
  verifyPassword,
} from '../lib/auth.js'
import { ok } from '../lib/respond.js'
import { query } from '../db/pool.js'
import {
  loadAuthUser,
  logoutCurrentToken,
  requireAuth,
  type AuthedRequest,
} from '../middleware/auth.js'

const router = Router()

const loginSchema = z.object({
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1, 'Password is required'),
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

router.post('/login', async (req, res) => {
  try {
    const { identifier: raw, password } = loginSchema.parse(req.body)
    const identifier = resolveLoginIdentifier(raw)

    const userResult = await query<{ id: string; status: string; password_hash: string }>(
      `SELECT id, status, password_hash FROM users
       WHERE mobile = $1 OR LOWER(email) = LOWER($1)`,
      [identifier],
    )
    if (!userResult.rowCount) {
      throw new ApiError(401, 'Invalid credentials', 'INVALID_CREDENTIALS')
    }

    const user = userResult.rows[0]
    if (user.status !== 'Active') {
      throw new ApiError(403, 'Account is inactive', 'INACTIVE')
    }

    const passwordOk = await verifyPassword(password, user.password_hash)
    if (!passwordOk) {
      throw new ApiError(401, 'Invalid credentials', 'INVALID_CREDENTIALS')
    }

    const { token, jti } = signAccessToken(user.id)
    const decoded = jwt.decode(token) as { exp: number }
    const authUser = await loadAuthUser(user.id, jti, decoded.exp)

    return ok(
      res,
      {
        token,
        user: {
          id: authUser.id,
          name: authUser.fullName,
          email: authUser.email,
          mobile: authUser.mobile,
          role: authUser.roleName,
          initials: authUser.initials,
          scope: authUser.scope,
          roads: authUser.roadNames,
          permissions: authUser.permissions,
        },
      },
      'Logged in',
    )
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/me', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const u = req.user!
    return ok(res, {
      id: u.id,
      name: u.fullName,
      email: u.email,
      mobile: u.mobile,
      role: u.roleName,
      initials: u.initials,
      scope: u.scope,
      roads: u.roadNames,
      permissions: u.permissions,
    })
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
