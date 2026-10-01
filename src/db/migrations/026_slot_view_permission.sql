-- Slot View screen: its own row in the Roles & permissions matrix.
-- Only Admin and Project manager may view it by default; every other role (including
-- custom roles) gets an all-off row so the toggle shows up and can be granted later.
INSERT INTO role_permissions (role_id, screen, can_view, can_create, can_edit, can_assign, can_close, can_delete)
SELECT r.id, 'Slot View', r.name IN ('Admin', 'Project manager'), FALSE, FALSE, FALSE, FALSE, FALSE
FROM roles r
ON CONFLICT (role_id, screen) DO NOTHING;
