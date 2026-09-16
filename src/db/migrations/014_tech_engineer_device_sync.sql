-- Technician and Engineer may start Device Sync (Device list create flag).
-- Add device remains a separate screen (still denied for these roles).

UPDATE role_permissions rp
SET can_create = TRUE
FROM roles r
WHERE rp.role_id = r.id
  AND r.name IN ('Technician', 'Engineer')
  AND rp.screen = 'Device list';
