import { Router } from 'express'
import { z } from 'zod'
import { handleApiError } from '../lib/api-error.js'
import {
  getPushConfig,
  getUnreadNotificationCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  registerPushSubscription,
  removePushSubscription,
} from '../lib/notifications.js'
import { limitSchema, pageSchema } from '../lib/pagination.js'
import { ok, paginated } from '../lib/respond.js'
import { authorize, requireAuth, type AuthedRequest } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

const listSchema = z.object({
  page: pageSchema,
  limit: limitSchema,
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
})

const pushEndpointSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .url()
  .refine(
    (value) => {
      const url = new URL(value)
      const host = url.hostname.toLowerCase()
      if (url.protocol !== 'https:' || url.username || url.password) return false
      if (host === 'localhost' || host.endsWith('.local') || host.includes(':')) return false
      const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
      if (!ipv4) return true
      const [a, b] = ipv4.slice(1).map(Number)
      return !(
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
      )
    },
    { message: 'Push endpoint must be a public HTTPS URL' },
  )

const pushSubscriptionSchema = z.object({
  endpoint: pushEndpointSchema,
  keys: z.object({
    p256dh: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+={0,2}$/, 'Invalid p256dh key'),
    auth: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+={0,2}$/, 'Invalid auth key'),
  }),
})

router.get('/', authorize('All tickets', 'v'), async (req: AuthedRequest, res) => {
  try {
    const query = listSchema.parse(req.query)
    const result = await listNotifications(
      req.user!.id,
      query.page,
      query.limit,
      query.unreadOnly,
    )
    return paginated(res, result.items, result.pagination)
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/unread-count', authorize('All tickets', 'v'), async (req: AuthedRequest, res) => {
  try {
    return ok(res, { count: await getUnreadNotificationCount(req.user!.id) })
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.patch('/read-all', authorize('All tickets', 'v'), async (req: AuthedRequest, res) => {
  try {
    const updated = await markAllNotificationsRead(req.user!.id)
    return ok(res, { updated }, 'Notifications marked as read')
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.get('/push-config', authorize('All tickets', 'v'), async (req: AuthedRequest, res) => {
  try {
    return ok(res, await getPushConfig(req.user!.id))
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.put('/push-subscriptions', authorize('All tickets', 'v'), async (req: AuthedRequest, res) => {
  try {
    const body = pushSubscriptionSchema.parse(req.body)
    const subscription = await registerPushSubscription(req.user!.id, {
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
    })
    return ok(res, subscription, 'Push subscription registered')
  } catch (error) {
    return handleApiError(res, error)
  }
})

router.delete(
  '/push-subscriptions/:id',
  authorize('All tickets', 'v'),
  async (req: AuthedRequest, res) => {
    try {
      const id = z.string().uuid().parse(req.params.id)
      return ok(res, await removePushSubscription(req.user!.id, id), 'Push subscription removed')
    } catch (error) {
      return handleApiError(res, error)
    }
  },
)

router.patch(
  '/:id/read',
  authorize('All tickets', 'v'),
  async (req: AuthedRequest, res) => {
    try {
      const id = z.string().uuid().parse(req.params.id)
      const notification = await markNotificationRead(req.user!.id, id)
      return ok(res, notification, 'Notification marked as read')
    } catch (error) {
      return handleApiError(res, error)
    }
  },
)

export default router
