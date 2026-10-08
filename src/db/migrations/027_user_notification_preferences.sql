-- Per-user application notification preferences (Phase 54).
-- TRUE keeps the pre-existing behaviour: every subscribed user receives push with sound.
ALTER TABLE users ADD COLUMN IF NOT EXISTS push_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS play_notification_sound BOOLEAN NOT NULL DEFAULT TRUE;
