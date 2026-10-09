-- Time the ticket / update was posted in the WhatsApp group (NULL = not from WhatsApp).
-- The UI shows it when set and falls back to created_at otherwise.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS whatsapp_at TIMESTAMPTZ;
ALTER TABLE ticket_events ADD COLUMN IF NOT EXISTS whatsapp_at TIMESTAMPTZ;
