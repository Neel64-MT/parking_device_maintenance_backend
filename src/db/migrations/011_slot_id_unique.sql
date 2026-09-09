-- Slot Id is the stable cross-system key (immutable once set)
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_slot_id_unique
  ON devices (slot_id)
  WHERE slot_id IS NOT NULL;
