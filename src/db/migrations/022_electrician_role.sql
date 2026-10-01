-- Electrician role: field staff with the same screen permissions as Engineer
-- (raise/update/close tickets they hold, may hold/claim tickets, Device Sync, Issue master delete).
INSERT INTO roles (name, scope, note)
SELECT 'Electrician', 'assigned_roads',
  'Field electrician: same ticket raise/update/close rules as Technician and Engineer; may hold or claim unassigned tickets on update. Cannot assign or reassign. May run Device Sync.'
WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'Electrician');

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
    ('Device list', TRUE, TRUE, FALSE, FALSE, FALSE, FALSE),
    ('Add device', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE),
    ('Device history', TRUE, FALSE, FALSE, FALSE, FALSE, FALSE),
    ('Scan QR', TRUE, FALSE, FALSE, FALSE, FALSE, FALSE),
    ('Issue master', TRUE, FALSE, FALSE, FALSE, FALSE, TRUE),
    ('Road master', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE),
    ('Users', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE),
    ('Roles & permissions', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE)
) AS t(screen, can_view, can_create, can_edit, can_assign, can_close, can_delete)
WHERE r.name = 'Electrician'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.screen = t.screen
  );
