-- Ticket delete is open to every authenticated role: grant the All tickets 'd' flag to all roles.
-- Matches DEFAULT_ROLE_PERMS (every role's 'All tickets' now ends in 'd'); still editable in
-- Roles & permissions. Other flags are left untouched.
UPDATE role_permissions
SET can_delete = TRUE
WHERE screen = 'All tickets' AND can_delete = FALSE;

-- Safety net for any role missing the All tickets row (e.g. custom roles): grant view + delete.
INSERT INTO role_permissions (role_id, screen, can_view, can_create, can_edit, can_assign, can_close, can_delete)
SELECT r.id, 'All tickets', TRUE, FALSE, FALSE, FALSE, FALSE, TRUE
FROM roles r
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.screen = 'All tickets'
)
ON CONFLICT (role_id, screen) DO NOTHING;
