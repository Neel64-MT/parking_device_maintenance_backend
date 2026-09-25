import webpush from 'web-push'
import { env } from '../config/env.js'
import { query, withTransaction } from '../db/pool.js'
import { ApiError } from './api-error.js'
import { deviceDisplayId } from './device-ref.js'
import { paginationMeta, type AllowedPageLimit } from './pagination.js'
import type {
  AppNotification,
  PushConfig,
  PushSubscriptionSummary,
} from '../types/api.js'

/** New-ticket alerts are intentionally limited to these existing business roles. */
export const NEW_TICKET_NOTIFICATION_ROLES = [
  'Admin',
  'Project manager',
  'Control room',
] as const

type NotificationRow = {
  id: string
  recipient_user_id: string
  type: string
  title: string
  message: string
  related_entity_type: string
  related_entity_id: string
  data: unknown
  push_sent_at: Date | string | null
  read_at: Date | string | null
  created_at: Date | string
}

type PushSubscriptionRow = {
  notification_id: string
  notification_type: string
  title: string
  message: string
  data: unknown
  subscription_id: string
  endpoint: string
  p256dh: string
  auth: string
}

export type NotificationPushSender = (
  subscription: webpush.PushSubscription,
  payload: string,
  options?: webpush.RequestOptions,
) => Promise<webpush.SendResult>

function rolePlaceholders(startAt: number) {
  return NEW_TICKET_NOTIFICATION_ROLES.map(
    (_role, index) => `$${startAt + index}`,
  ).join(',')
}

function parseData(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  return {}
}

function mapNotification(row: NotificationRow): AppNotification {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    relatedEntityType: row.related_entity_type,
    relatedEntityId: row.related_entity_id,
    data: parseData(row.data),
    pushSentAt: row.push_sent_at,
    readAt: row.read_at,
    isRead: row.read_at != null,
    createdAt: row.created_at,
  }
}

function mapPushSubscription(row: {
  id: string
  created_at: Date | string
  updated_at: Date | string
}): PushSubscriptionSummary {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function isPushConfigured() {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT)
}

function pushRequestOptions(): webpush.RequestOptions | undefined {
  if (!isPushConfigured()) return undefined
  return {
    vapidDetails: {
      subject: env.VAPID_SUBJECT!,
      publicKey: env.VAPID_PUBLIC_KEY!,
      privateKey: env.VAPID_PRIVATE_KEY!,
    },
    TTL: 60 * 60,
    urgency: 'high',
  }
}

/**
 * Persist one idempotent notification per eligible user after a ticket is committed.
 * Existing Control Room ticket visibility is preserved in the optional detail link.
 */
export async function createNewTicketNotifications(ticketId: string) {
  const ticketResult = await query<{
    id: string
    public_id: string
    raised_at: Date | string
    raised_by_user_id: string | null
    assignee_id: string | null
    road_id: string
    device_public_id: string
    slot_id: number | string | null
    slot_number: string
    road_name: string
    category_id: string | null
    category_name: string | null
    subcategory_id: string | null
    subcategory_name: string | null
    severity: string | null
    raised_by_name: string | null
  }>(
    `SELECT t.id, t.public_id, t.raised_at, t.raised_by_user_id, t.assignee_id,
            d.road_id, d.public_id AS device_public_id, d.slot_id, d.slot_number,
            r.name AS road_name,
            t.reported_category_id AS category_id,
            c.name AS category_name,
            t.reported_subcategory_id AS subcategory_id,
            s.name AS subcategory_name, s.severity,
            u.full_name AS raised_by_name
     FROM tickets t
     JOIN devices d ON d.id = t.device_id
     JOIN roads r ON r.id = d.road_id
     LEFT JOIN issue_categories c ON c.id = t.reported_category_id
     LEFT JOIN issue_subcategories s ON s.id = t.reported_subcategory_id
     LEFT JOIN users u ON u.id = t.raised_by_user_id
     WHERE t.id = $1`,
    [ticketId],
  )
  if (!ticketResult.rowCount) {
    throw new ApiError(404, 'Ticket not found for notification', 'NOT_FOUND')
  }
  const ticket = ticketResult.rows[0]

  const recipients = await query<{
    id: string
    road_access: boolean
  }>(
    `SELECT DISTINCT u.id,
            (r.scope = 'all_roads' OR EXISTS (
               SELECT 1 FROM user_roads ur
               WHERE ur.user_id = u.id AND ur.road_id = $1
            )) AS road_access
     FROM users u
     JOIN roles r ON r.id = u.role_id
     JOIN role_permissions rp ON rp.role_id = r.id
     WHERE u.status = 'Active'
       AND rp.screen = 'All tickets'
       AND rp.can_view = TRUE
       AND r.name IN (${rolePlaceholders(2)})`,
    [
      ticket.road_id,
      ...NEW_TICKET_NOTIFICATION_ROLES,
    ],
  )

  const title = 'New ticket raised'
  const message = `New ticket ${ticket.public_id} has been raised for Slot ${ticket.slot_number} on ${ticket.road_name}.`
  const createdIds = await withTransaction(async (client) => {
    const ids: string[] = []
    for (const recipient of recipients.rows) {
      const canOpen =
        recipient.road_access ||
        recipient.id === ticket.raised_by_user_id ||
        recipient.id === ticket.assignee_id
      const data = {
        ticketId: ticket.public_id,
        reference: ticket.public_id,
        canOpen,
        url: canOpen ? `/tickets/${ticket.public_id}` : null,
        device: {
          id: deviceDisplayId({
            slot_id: ticket.slot_id,
            public_id: ticket.device_public_id,
          }),
          road: ticket.road_name,
          slot: ticket.slot_number,
        },
        issue: ticket.subcategory_id
          ? {
              categoryId: ticket.category_id,
              subCategoryId: ticket.subcategory_id,
              category: ticket.category_name,
              subCategory: ticket.subcategory_name,
              severity: ticket.severity,
            }
          : null,
        raisedBy: {
          id: ticket.raised_by_user_id,
          name: ticket.raised_by_name,
        },
        createdAt: ticket.raised_at,
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO notifications (
           recipient_user_id, type, title, message,
           related_entity_type, related_entity_id, data
         ) VALUES ($1, 'ticket.raised', $2, $3, 'ticket', $4, $5::jsonb)
         ON CONFLICT (recipient_user_id, type, related_entity_type, related_entity_id)
         DO NOTHING
         RETURNING id`,
        [recipient.id, title, message, ticket.id, JSON.stringify(data)],
      )
      if (inserted.rowCount) ids.push(inserted.rows[0].id)
    }
    return ids
  })

  scheduleNotificationPush(createdIds)
  return createdIds
}

export async function listNotifications(
  userId: string,
  page: number,
  limit: AllowedPageLimit,
  unreadOnly: boolean,
) {
  const where = unreadOnly
    ? 'WHERE recipient_user_id = $1 AND read_at IS NULL'
    : 'WHERE recipient_user_id = $1'
  const countResult = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM notifications ${where}`,
    [userId],
  )
  const total = countResult.rows[0]?.n ?? 0
  const result = await query<NotificationRow>(
    `SELECT * FROM notifications
     ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [userId, limit, (page - 1) * limit],
  )
  return {
    items: result.rows.map(mapNotification),
    pagination: paginationMeta(page, limit, total),
  }
}

export async function getUnreadNotificationCount(userId: string) {
  const result = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
     FROM notifications
     WHERE recipient_user_id = $1 AND read_at IS NULL`,
    [userId],
  )
  return result.rows[0]?.n ?? 0
}

export async function markNotificationRead(userId: string, notificationId: string) {
  const result = await query<NotificationRow>(
    `UPDATE notifications
     SET read_at = COALESCE(read_at, NOW())
     WHERE id = $1 AND recipient_user_id = $2
     RETURNING *`,
    [notificationId, userId],
  )
  if (!result.rowCount) {
    throw new ApiError(404, 'Notification not found', 'NOT_FOUND')
  }
  return mapNotification(result.rows[0])
}

export async function markAllNotificationsRead(userId: string) {
  const result = await query(
    `UPDATE notifications
     SET read_at = NOW()
     WHERE recipient_user_id = $1 AND read_at IS NULL`,
    [userId],
  )
  return result.rowCount ?? 0
}

export async function getPushConfig(userId: string): Promise<PushConfig> {
  const result = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = $1`,
    [userId],
  )
  const available = isPushConfigured()
  return {
    available,
    publicKey: available ? env.VAPID_PUBLIC_KEY! : null,
    registered: (result.rows[0]?.n ?? 0) > 0,
  }
}

export async function registerPushSubscription(
  userId: string,
  input: { endpoint: string; p256dh: string; auth: string },
) {
  const result = await query<{
    id: string
    created_at: Date | string
    updated_at: Date | string
  }>(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE
       SET p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           updated_at = NOW()
       WHERE push_subscriptions.user_id = EXCLUDED.user_id
     RETURNING id, created_at, updated_at`,
    [userId, input.endpoint, input.p256dh, input.auth],
  )
  if (!result.rowCount) {
    throw new ApiError(
      409,
      'Push subscription is registered to another user',
      'PUSH_SUBSCRIPTION_OWNED',
    )
  }
  return mapPushSubscription(result.rows[0])
}

export async function removePushSubscription(userId: string, subscriptionId: string) {
  const result = await query(
    `DELETE FROM push_subscriptions
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [subscriptionId, userId],
  )
  if (!result.rowCount) {
    throw new ApiError(404, 'Push subscription not found', 'NOT_FOUND')
  }
  return { id: subscriptionId, removed: true }
}

function pushErrorStatus(error: unknown) {
  if (!error || typeof error !== 'object') return null
  const status = (error as { statusCode?: unknown }).statusCode
  return typeof status === 'number' ? status : null
}

/** Testable delivery helper. Production scheduling uses the default web-push sender. */
export async function deliverNotificationPush(
  notificationIds: string[],
  sendPush: NotificationPushSender = (subscription, payload, options) =>
    webpush.sendNotification(subscription, payload, options),
) {
  if (!notificationIds.length) return

  const result = await query<PushSubscriptionRow>(
    `SELECT n.id AS notification_id, n.type AS notification_type,
            n.title, n.message, n.data,
            ps.id AS subscription_id, ps.endpoint, ps.p256dh, ps.auth
     FROM notifications n
     JOIN users u ON u.id = n.recipient_user_id
     JOIN roles r ON r.id = u.role_id
     JOIN role_permissions rp ON rp.role_id = r.id
     JOIN push_subscriptions ps ON ps.user_id = u.id
     WHERE n.id = ANY($1::uuid[])
       AND n.push_sent_at IS NULL
       AND u.status = 'Active'
       AND rp.screen = 'All tickets'
       AND rp.can_view = TRUE
       AND r.name IN (${rolePlaceholders(2)})`,
    [notificationIds, ...NEW_TICKET_NOTIFICATION_ROLES],
  )

  const sentNotificationIds = new Set<string>()
  const options = pushRequestOptions()
  for (const row of result.rows) {
    const data = parseData(row.data)
    const url = typeof data.url === 'string' ? data.url : null
    const payload = JSON.stringify({
      notification: {
        title: row.title,
        body: row.message,
        tag: `notification.${row.notification_id}`,
        data: { url },
      },
      data: {
        notificationId: row.notification_id,
        type: row.notification_type,
        url,
        ...data,
      },
    })

    try {
      await sendPush(
        {
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
        },
        payload,
        options,
      )
      sentNotificationIds.add(row.notification_id)
    } catch (error) {
      const status = pushErrorStatus(error)
      if (status === 404 || status === 410) {
        await query(`DELETE FROM push_subscriptions WHERE id = $1`, [row.subscription_id])
        continue
      }
      console.error(
        `[notifications] push delivery failed for notification ${row.notification_id}` +
          (status ? ` (status ${status})` : ''),
      )
    }
  }

  if (sentNotificationIds.size) {
    await query(
      `UPDATE notifications
       SET push_sent_at = NOW()
       WHERE id = ANY($1::uuid[]) AND push_sent_at IS NULL`,
      [[...sentNotificationIds]],
    )
  }
}

export function scheduleNotificationPush(notificationIds: string[]) {
  if (!notificationIds.length || !isPushConfigured()) return
  setImmediate(() => {
    void deliverNotificationPush(notificationIds).catch((error) => {
      console.error('[notifications] background delivery failed:', error)
    })
  })
}
