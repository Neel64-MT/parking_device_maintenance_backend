-- Project manager may view/create/edit users (approve Pending signups, update role/details).
UPDATE role_permissions rp
SET
  can_view = TRUE,
  can_create = TRUE,
  can_edit = TRUE
FROM roles r
WHERE rp.role_id = r.id
  AND r.name = 'Project manager'
  AND rp.screen = 'Users';
