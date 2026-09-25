-- Phase 40: Admin always has full permissions on every screen (vceaxd).
UPDATE role_permissions rp
SET
  can_view = TRUE,
  can_create = TRUE,
  can_edit = TRUE,
  can_assign = TRUE,
  can_close = TRUE,
  can_delete = TRUE
FROM roles r
WHERE rp.role_id = r.id
  AND r.name = 'Admin';

INSERT INTO role_permissions
  (role_id, screen, can_view, can_create, can_edit, can_assign, can_close, can_delete)
SELECT r.id, s.screen, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE
FROM roles r
CROSS JOIN (
  VALUES
    ('Dashboard'),
    ('Raise ticket'),
    ('Update ticket'),
    ('All tickets'),
    ('Work report'),
    ('Device list'),
    ('Add device'),
    ('Device history'),
    ('Scan QR'),
    ('Issue master'),
    ('Road master'),
    ('Users'),
    ('Roles & permissions')
) AS s(screen)
WHERE r.name = 'Admin'
ON CONFLICT (role_id, screen) DO UPDATE SET
  can_view = TRUE,
  can_create = TRUE,
  can_edit = TRUE,
  can_assign = TRUE,
  can_close = TRUE,
  can_delete = TRUE;
