-- Engineer role: field staff (same screen permissions as Technician) for Visited By / hold tickets
INSERT INTO roles (name, scope, note)
SELECT 'Engineer', 'assigned_roads',
  'Scan/raise any road; update/close only tickets they hold or raised. Cannot assign or reassign. List stays assignee/raiser-scoped. Eligible for Visited By.'
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'Engineer');

INSERT INTO role_permissions (role_id, screen, can_view, can_create, can_edit, can_assign, can_close, can_delete)
SELECT r.id, t.screen, t.can_view, t.can_create, t.can_edit, t.can_assign, t.can_close, t.can_delete
FROM roles r
CROSS JOIN (
  VALUES
    ('Dashboard', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE),
    ('Raise ticket', TRUE, TRUE, FALSE, FALSE, FALSE, FALSE),
    ('Update ticket', TRUE, TRUE, TRUE, FALSE, TRUE, FALSE),
    ('All tickets', TRUE, FALSE, FALSE, FALSE, FALSE, FALSE),
    ('Work report', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE),
    ('Device list', TRUE, FALSE, FALSE, FALSE, FALSE, FALSE),
    ('Add device', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE),
    ('Device history', TRUE, FALSE, FALSE, FALSE, FALSE, FALSE),
    ('Scan QR', TRUE, FALSE, FALSE, FALSE, FALSE, FALSE),
    ('Issue master', TRUE, FALSE, FALSE, FALSE, FALSE, FALSE),
    ('Road master', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE),
    ('Users', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE),
    ('Roles & permissions', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE)
) AS t(screen, can_view, can_create, can_edit, can_assign, can_close, can_delete)
WHERE r.name = 'Engineer'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.screen = t.screen
  );
