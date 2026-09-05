-- Allow Pending signup requests. Existing Active/Inactive rows unchanged.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('Active', 'Inactive', 'Pending'));

CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
