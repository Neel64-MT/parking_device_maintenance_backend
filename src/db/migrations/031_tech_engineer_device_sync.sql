-- Re-grant Device Sync (Device list create) for Technician and Engineer where the
-- matrix drifted off. Matches DEFAULT_ROLE_PERMS ('Device list' = 'vc....').
-- Add device remains a separate screen (still denied).

UPDATE role_permissions rp
SET can_view = TRUE,
    can_create = TRUE
FROM roles r
WHERE rp.role_id = r.id
  AND r.name IN ('Technician', 'Engineer')
  AND rp.screen = 'Device list'
  AND (rp.can_view = FALSE OR rp.can_create = FALSE);

INSERT INTO role_permissions (role_id, screen, can_view, can_create, can_edit, can_assign, can_close, can_delete)
SELECT r.id, 'Device list', TRUE, TRUE, FALSE, FALSE, FALSE, FALSE
FROM roles r
WHERE r.name IN ('Technician', 'Engineer')
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.screen = 'Device list'
  );
