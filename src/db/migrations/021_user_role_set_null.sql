-- A user may outlive its role.
--
-- Deleting a role is refused while any *active* account is assigned to it, but an
-- Inactive account must not block it. `users.role_id` was NOT NULL REFERENCES roles(id)
-- with no ON DELETE action, so an Inactive account kept the role alive forever and a
-- role could not be removed while any user row referenced it.
--
-- Setting role_id to NULL on role delete gives the state a meaning: the account exists
-- but no longer has a role. PATCH /api/users/:id then refuses to set status = 'Active'
-- until a role is chosen again (409 ROLE_REQUIRED), so no Active account can ever end
-- up without a role -- which the requireAuth JOIN on roles depends on.
--
-- role_permissions keeps its own ON DELETE CASCADE and is unaffected.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_id_fkey;

ALTER TABLE users ALTER COLUMN role_id DROP NOT NULL;

ALTER TABLE users
  ADD CONSTRAINT users_role_id_fkey
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE SET NULL;
