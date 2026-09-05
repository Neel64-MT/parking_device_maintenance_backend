-- Technicians cannot assign or reassign tickets (Control room / Admin / PM only).
UPDATE role_permissions rp
SET can_assign = FALSE
FROM roles r
WHERE rp.role_id = r.id
  AND r.name = 'Technician'
  AND rp.screen = 'All tickets';
