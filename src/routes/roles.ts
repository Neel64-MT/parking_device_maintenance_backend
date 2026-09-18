import { Router } from 'express'
import { z } from 'zod'
import { ApiError, handleApiError } from '../lib/api-error.js'
import { created, ok } from '../lib/respond.js'
import { query } from '../db/pool.js'
import { authorize, requireAuth, type AuthedRequest } from '../middleware/auth.js'
import {
  SCREENS,
  codeToFlags,
  defaultPermissionsForRole,
  flagsToCode,
  fullAccessPermissions,
} from '../lib/permissions.js'
import { assertCanManageRolePermissions } from '../lib/role-hierarchy.js'

const router = Router()
router.use(requireAuth)

async function upsertRolePermissions(roleId: string, permissions: Record<string, string>) {
  for (const [screen, code] of Object.entries(permissions)) {
    const flags = codeToFlags(code)
    await query(
      `INSERT INTO role_permissions
       (role_id, screen, can_view, can_create, can_edit, can_assign, can_close, can_delete)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (role_id, screen) DO UPDATE SET
         can_view = EXCLUDED.can_view,
         can_create = EXCLUDED.can_create,
         can_edit = EXCLUDED.can_edit,
         can_assign = EXCLUDED.can_assign,
         can_close = EXCLUDED.can_close,
         can_delete = EXCLUDED.can_delete`,
      [
        roleId,
        screen,
        flags.can_view,
        flags.can_create,
        flags.can_edit,
        flags.can_assign,
        flags.can_close,
        flags.can_delete,
      ],
    )
  }
}

router.get('/', authorize('Roles & permissions', 'v'), async (_req, res) => {
  try {
    const roles = await query(`SELECT * FROM roles ORDER BY name`)
    const perms = await query(`SELECT * FROM role_permissions`)
    const counts = await query(
      `SELECT role_id, COUNT(*)::int AS n FROM users GROUP BY role_id`,
    )
    const countMap = Object.fromEntries(counts.rows.map((c) => [c.role_id, c.n]))

    return ok(
      res,
      roles.rows.map((role) => {
        const name = String(role.name)
        const locked = name === 'Admin'
        const defaults = defaultPermissionsForRole(name)
        const p: Record<string, string> = {}
        for (const screen of SCREENS) {
          if (locked) {
            p[screen] = 'vceaxd'
            continue
          }
          const row = perms.rows.find((x) => x.role_id === role.id && x.screen === screen)
          p[screen] = row ? flagsToCode(row) : '......'
        }
        return {
          id: role.id,
          name,
          scope: role.scope === 'all_roads' ? 'All roads' : 'Assigned roads only',
          scopeCode: role.scope,
          users: countMap[role.id] || 0,
          note: role.note,
          permissions: locked ? fullAccessPermissions() : p,
          defaultPermissions: defaults,
          permissionsLocked: locked,
          canReset: Boolean(defaults) && !locked,
        }
      }),
    )
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.post('/', authorize('Roles & permissions', 'c'), async (req, res) => {
  try {
    const body = z
      .object({
        name: z.string().min(2),
        scope: z.enum(['all_roads', 'assigned_roads']).default('assigned_roads'),
        copyFromRoleId: z.string().uuid().nullable().optional(),
        note: z.string().optional(),
      })
      .parse(req.body)

    if (body.name.trim().toLowerCase() === 'admin') {
      throw new ApiError(400, 'Admin role already exists and cannot be recreated', 'VALIDATION_ERROR')
    }

    const role = await query(
      `INSERT INTO roles (name, scope, note) VALUES ($1,$2,$3) RETURNING *`,
      [body.name, body.scope, body.note || null],
    )
    const roleId = role.rows[0].id

    let sourcePerms: Array<Record<string, unknown>> = []
    if (body.copyFromRoleId) {
      const copied = await query(`SELECT * FROM role_permissions WHERE role_id = $1`, [
        body.copyFromRoleId,
      ])
      sourcePerms = copied.rows
    }

    for (const screen of SCREENS) {
      const src = sourcePerms.find((p) => p.screen === screen)
      const flags = src
        ? {
            can_view: Boolean(src.can_view),
            can_create: Boolean(src.can_create),
            can_edit: Boolean(src.can_edit),
            can_assign: Boolean(src.can_assign),
            can_close: Boolean(src.can_close),
            can_delete: Boolean(src.can_delete),
          }
        : codeToFlags('......')
      await query(
        `INSERT INTO role_permissions
         (role_id, screen, can_view, can_create, can_edit, can_assign, can_close, can_delete)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          roleId,
          screen,
          flags.can_view,
          flags.can_create,
          flags.can_edit,
          flags.can_assign,
          flags.can_close,
          flags.can_delete,
        ],
      )
    }

    return created(res, role.rows[0], 'Role created')
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.patch('/:id/permissions', authorize('Roles & permissions', 'e'), async (req: AuthedRequest, res) => {
  try {
    const body = z
      .object({
        permissions: z.record(z.string(), z.string().length(6)),
      })
      .parse(req.body)

    const role = await query('SELECT * FROM roles WHERE id = $1', [req.params.id])
    if (!role.rowCount) throw new ApiError(404, 'Role not found', 'NOT_FOUND')

    const roleName = String(role.rows[0].name)
    if (roleName === 'Admin') {
      throw new ApiError(
        403,
        'Admin permissions are fixed and cannot be changed.',
        'FORBIDDEN',
      )
    }

    assertCanManageRolePermissions(req.user!.roleName, roleName)
    await upsertRolePermissions(req.params.id, body.permissions)

    return ok(res, { id: req.params.id }, 'Permissions saved')
  } catch (error) {
    return handleApiError(res, error)
  }
})

/** Restore seeded default matrix for a known role. Admin is locked. */
router.post(
  '/:id/permissions/reset',
  authorize('Roles & permissions', 'e'),
  async (req: AuthedRequest, res) => {
    try {
      const role = await query('SELECT * FROM roles WHERE id = $1', [req.params.id])
      if (!role.rowCount) throw new ApiError(404, 'Role not found', 'NOT_FOUND')

      const roleName = String(role.rows[0].name)
      if (roleName === 'Admin') {
        throw new ApiError(
          403,
          'Admin permissions are fixed and cannot be changed.',
          'FORBIDDEN',
        )
      }

      assertCanManageRolePermissions(req.user!.roleName, roleName)

      const defaults = defaultPermissionsForRole(roleName)
      if (!defaults) {
        throw new ApiError(
          400,
          'This role has no seeded defaults to reset to.',
          'VALIDATION_ERROR',
        )
      }

      await upsertRolePermissions(req.params.id, defaults)
      return ok(res, { id: req.params.id, permissions: defaults }, 'Permissions reset to defaults')
    } catch (error) {
      return handleApiError(res, error)
    }
  },
)

export default router
