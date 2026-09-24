-- Phase 36: Issue master hard-delete for Technician, Engineer, Project manager
-- (Admin already has can_delete). Soft-deactivate remains for in-use records.
UPDATE role_permissions rp
SET can_delete = TRUE
FROM roles r
WHERE rp.role_id = r.id
  AND r.name IN ('Technician', 'Engineer', 'Project manager')
  AND rp.screen = 'Issue master'
  AND rp.can_delete = FALSE;
