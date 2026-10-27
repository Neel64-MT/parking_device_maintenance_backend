-- Grant device delete (Device list 'd' flag) to Admin on databases where it drifted.
-- Matches DEFAULT_ROLE_PERMS (Admin 'Device list' = 'vce..d'); other flags untouched.
UPDATE role_permissions rp
SET can_delete = TRUE
FROM roles r
WHERE rp.role_id = r.id
  AND r.name = 'Admin'
  AND rp.screen = 'Device list'
  AND rp.can_delete = FALSE;

INSERT INTO role_permissions (role_id, screen, can_view, can_create, can_edit, can_assign, can_close, can_delete)
SELECT r.id, 'Device list', TRUE, TRUE, TRUE, FALSE, FALSE, TRUE
FROM roles r
WHERE r.name = 'Admin'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.screen = 'Device list'
  );
