-- One notification per real event, instead of one per (recipient, type, ticket).
--
-- 019_notifications.sql keyed notifications on (recipient_user_id, type,
-- related_entity_type, related_entity_id). That has no event identity in it, so a
-- ticket reassigned to the SAME person more than once could only ever produce one
-- notification: every later assignment event hit the unique key and was silently
-- dropped by ON CONFLICT DO NOTHING.
--
-- event_id names the ticket_events row that caused the notification. It is the
-- missing piece of identity: the same ticket legitimately raises many distinct
-- events, and each one deserves its own notification.
--
-- Backfill: existing rows keep working. A ticket.raised row maps to its ticket's
-- 'raised' event, which preserves the old exactly-once behaviour for raise. Rows
-- that cannot be resolved get a generated id, so they simply stay a single legacy
-- row as before and cannot collide with future events.

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS event_id UUID;

UPDATE notifications n
SET event_id = e.id
FROM tickets t, ticket_events e
WHERE n.related_entity_type = 'ticket'
  AND t.id = n.related_entity_id
  AND e.ticket_id = t.id
  AND e.event_type = CASE WHEN n.type = 'ticket.raised' THEN 'raised' ELSE 'assigned' END
  AND n.event_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM ticket_events earlier
    WHERE earlier.ticket_id = t.id
      AND earlier.event_type = CASE WHEN n.type = 'ticket.raised' THEN 'raised' ELSE 'assigned' END
      AND earlier.created_at < e.created_at
  );

UPDATE notifications
SET event_id = gen_random_uuid()
WHERE event_id IS NULL;

-- From here every row must have an event identity.
ALTER TABLE notifications ALTER COLUMN event_id SET NOT NULL;

-- The old key collapses a ticket's history to one row; replace it with the
-- event-scoped equivalent.
--
-- Dropped by matching the constraint definition, not its name: PostgreSQL
-- truncates generated names at 63 bytes, so 019's UNIQUE(...) landed as
-- `notifications_recipient_user_id_type_related_entity_type_re_key`. A
-- name-based DROP misses that on a real database too, leaving the old key in
-- place and silently swallowing the events this migration exists to allow.
DO $$
DECLARE
  old_key TEXT;
BEGIN
  SELECT conname INTO old_key
  FROM pg_constraint
  WHERE conrelid = 'notifications'::regclass
    AND contype = 'u'
    AND pg_get_constraintdef(oid) = 'UNIQUE (recipient_user_id, type, related_entity_type, related_entity_id)';

  IF old_key IS NOT NULL THEN
    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', old_key);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_recipient_event_key
  ON notifications (recipient_user_id, type, related_entity_type, related_entity_id, event_id);

-- Reading a ticket's notifications by event is the new hot path, so index it.
CREATE INDEX IF NOT EXISTS idx_notifications_entity_event
  ON notifications (related_entity_type, related_entity_id, event_id);
