import type { Request, Response, NextFunction } from 'express'
import { ApiError, handleApiError } from '../lib/api-error.js'
import { denyToken, isTokenDenied, verifyAccessToken } from '../lib/auth.js'
import { query } from '../db/pool.js'
import type { PermissionFlag, RoadScope, ScreenName } from '../types/api.js'

export type AuthUser = {
  id: string
  fullName: string
  email: string | null
  mobile: string
  status: string
  roleId: string
  roleName: string
  scope: RoadScope
  initials: string
  roadIds: string[]
  roadNames: string[]
  permissions: Record<string, string>
  jti: string
  tokenExp: number
}

export type AuthedRequest = Request & { user?: AuthUser }

function initialsFromName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '??'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export async function loadAuthUser(
  userId: string,
  jti: string,
  exp: number,
  tokenPv?: number,
): Promise<AuthUser> {
  const userResult = await query<{
    id: string
    full_name: string
    email: string | null
    mobile: string
    status: string
    role_id: string
    role_name: string
    scope: RoadScope
    password_version: number
  }>(
    `SELECT u.id, u.full_name, u.email, u.mobile, u.status, u.role_id,
            COALESCE(u.password_version, 0) AS password_version,
            r.name AS role_name, r.scope
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1`,
    [userId],
  )
  const row = userResult.rows[0]
  if (!row) throw new ApiError(401, 'Unauthorized', 'UNAUTHORIZED')
  if (row.status !== 'Active') throw new ApiError(403, 'Account is inactive', 'INACTIVE')
  if (tokenPv == null || tokenPv !== row.password_version) {
    throw new ApiError(401, 'Unauthorized', 'UNAUTHORIZED')
  }

  const roads = await query<{ road_id: string; name: string }>(
    `SELECT ur.road_id, rd.name
     FROM user_roads ur
     JOIN roads rd ON rd.id = ur.road_id
     WHERE ur.user_id = $1`,
    [userId],
  )

  const perms = await query<{
    screen: string
    can_view: boolean
    can_create: boolean
    can_edit: boolean
    can_assign: boolean
    can_close: boolean
    can_delete: boolean
  }>('SELECT * FROM role_permissions WHERE role_id = $1', [row.role_id])

  const permissions: Record<string, string> = {}
  for (const p of perms.rows) {
    permissions[p.screen] = [
      p.can_view ? 'v' : '.',
      p.can_create ? 'c' : '.',
      p.can_edit ? 'e' : '.',
      p.can_assign ? 'a' : '.',
      p.can_close ? 'x' : '.',
      p.can_delete ? 'd' : '.',
    ].join('')
  }

  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    mobile: row.mobile,
    status: row.status,
    roleId: row.role_id,
    roleName: row.role_name,
    scope: row.scope,
    initials: initialsFromName(row.full_name),
    roadIds: roads.rows.map((r) => r.road_id),
    roadNames: roads.rows.map((r) => r.name),
    permissions,
    jti,
    tokenExp: exp,
  }
}

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      throw new ApiError(401, 'Unauthorized', 'UNAUTHORIZED')
    }
    const token = header.slice(7)
    let payload: { sub: string; jti: string; exp: number; iat: number; pv?: number }
    try {
      payload = verifyAccessToken(token)
    } catch {
      throw new ApiError(401, 'Unauthorized', 'UNAUTHORIZED')
    }
    if (await isTokenDenied(payload.jti)) {
      throw new ApiError(401, 'Unauthorized', 'UNAUTHORIZED')
    }
    req.user = await loadAuthUser(payload.sub, payload.jti, payload.exp, payload.pv ?? 0)
    await query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [req.user.id])
    next()
  } catch (error) {
    return handleApiError(res, error)
  }
}

export function authorize(screen: ScreenName, flag: PermissionFlag) {
  return (req: AuthedRequest, res: Response, next: NextFunction) => {
    try {
      const user = req.user
      if (!user) throw new ApiError(401, 'Unauthorized', 'UNAUTHORIZED')
      const code = user.permissions[screen] || '......'
      const idx = ['v', 'c', 'e', 'a', 'x', 'd'].indexOf(flag)
      if (idx < 0 || code[idx] !== flag) {
        throw new ApiError(403, 'Forbidden', 'FORBIDDEN')
      }
      next()
    } catch (error) {
      return handleApiError(res, error)
    }
  }
}

export function hasPermission(user: AuthUser, screen: ScreenName, flag: PermissionFlag) {
  const code = user.permissions[screen] || '......'
  const idx = ['v', 'c', 'e', 'a', 'x', 'd'].indexOf(flag)
  return idx >= 0 && code[idx] === flag
}

export async function logoutCurrentToken(user: AuthUser) {
  await denyToken(user.jti, new Date(user.tokenExp * 1000))
}

export function assertRoadAccess(user: AuthUser, roadId: string) {
  if (user.scope === 'all_roads') return
  if (!user.roadIds.includes(roadId)) {
    throw new ApiError(403, 'Forbidden for this road', 'FORBIDDEN')
  }
}
