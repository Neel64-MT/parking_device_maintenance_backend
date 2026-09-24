-- Phase 41: Site attendant may Device Sync (Device list c) and Issue Master CRUD (vce..d).
-- Add device stays denied.

UPDATE role_permissions rp
SET can_create = TRUE
FROM roles r
WHERE rp.role_id = r.id
  AND r.name = 'Site attendant'
  AND rp.screen = 'Device list';

UPDATE role_permissions rp
SET
  can_view = TRUE,
  can_create = TRUE,
  can_edit = TRUE,
  can_assign = FALSE,
  can_close = FALSE,
  can_delete = TRUE
FROM roles r
WHERE rp.role_id = r.id
  AND r.name = 'Site attendant'
  AND rp.screen = 'Issue master';
