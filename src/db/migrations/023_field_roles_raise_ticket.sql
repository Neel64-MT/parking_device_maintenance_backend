-- Phase 47: Technician, Engineer and Electrician may raise tickets (Raise ticket v + c).
-- Restores the DEFAULT_ROLE_PERMS grant on databases where it drifted; other flags untouched.
UPDATE role_permissions rp
SET can_view = TRUE,
    can_create = TRUE
FROM roles r
WHERE rp.role_id = r.id
  AND r.name IN ('Technician', 'Engineer', 'Electrician')
  AND rp.screen = 'Raise ticket'
  AND (rp.can_view = FALSE OR rp.can_create = FALSE);

INSERT INTO role_permissions (role_id, screen, can_view, can_create, can_edit, can_assign, can_close, can_delete)
SELECT r.id, 'Raise ticket', TRUE, TRUE, FALSE, FALSE, FALSE, FALSE
FROM roles r
WHERE r.name IN ('Technician', 'Engineer', 'Electrician')
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.screen = 'Raise ticket'
  );
