-- Parking Device Maintenance schema
-- gen_random_uuid() is available in modern Postgres / PGlite

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('all_roads', 'assigned_roads')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  screen TEXT NOT NULL,
  can_view BOOLEAN NOT NULL DEFAULT FALSE,
  can_create BOOLEAN NOT NULL DEFAULT FALSE,
  can_edit BOOLEAN NOT NULL DEFAULT FALSE,
  can_assign BOOLEAN NOT NULL DEFAULT FALSE,
  can_close BOOLEAN NOT NULL DEFAULT FALSE,
  can_delete BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (role_id, screen)
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  mobile TEXT NOT NULL UNIQUE,
  role_id UUID NOT NULL REFERENCES roles(id),
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  last_active_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  stretch_from TEXT NOT NULL,
  stretch_to TEXT NOT NULL,
  zone TEXT,
  ward TEXT,
  length_text TEXT,
  side TEXT,
  surveyed_slots INTEGER DEFAULT 0,
  devices_sanctioned INTEGER DEFAULT 0,
  vehicle_type TEXT,
  parking_rate TEXT,
  slot_prefix TEXT,
  operating_hours TEXT,
  status TEXT NOT NULL DEFAULT 'Operational',
  go_live_date DATE,
  supervisor_name TEXT,
  supervisor_mobile TEXT,
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_roads (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  road_id UUID NOT NULL REFERENCES roads(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, road_id)
);

CREATE TABLE IF NOT EXISTS issue_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS issue_subcategories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES issue_categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('Critical', 'Major', 'Minor')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (category_id, name)
);

CREATE TABLE IF NOT EXISTS parts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id TEXT NOT NULL UNIQUE,
  qr_code TEXT NOT NULL UNIQUE,
  road_id UUID NOT NULL REFERENCES roads(id),
  slot_number TEXT NOT NULL,
  side_of_road TEXT,
  landmark TEXT,
  latitude TEXT,
  longitude TEXT,
  model TEXT,
  installed_on DATE,
  commissioned_on DATE,
  install_status TEXT DEFAULT 'Working',
  photo_url TEXT,
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (road_id, slot_number)
);

CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id TEXT NOT NULL UNIQUE,
  device_id UUID NOT NULL REFERENCES devices(id),
  status TEXT NOT NULL DEFAULT 'Open',
  priority TEXT,
  reporter_type TEXT,
  description TEXT,
  reported_category_id UUID REFERENCES issue_categories(id),
  reported_subcategory_id UUID REFERENCES issue_subcategories(id),
  found_category_id UUID REFERENCES issue_categories(id),
  found_subcategory_id UUID REFERENCES issue_subcategories(id),
  raised_by_user_id UUID REFERENCES users(id),
  assignee_id UUID REFERENCES users(id),
  raised_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  reopen_of_ticket_id UUID REFERENCES tickets(id),
  total_cost NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  title TEXT,
  body TEXT,
  status_label TEXT,
  actor_user_id UUID REFERENCES users(id),
  category_id UUID REFERENCES issue_categories(id),
  subcategory_id UUID REFERENCES issue_subcategories(id),
  cost NUMERIC(12, 2) DEFAULT 0,
  next_visit_at DATE,
  not_fixed_reason TEXT,
  work_done TEXT,
  photos JSONB NOT NULL DEFAULT '[]'::jsonb,
  parts JSONB NOT NULL DEFAULT '[]'::jsonb,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  from_user_id UUID REFERENCES users(id),
  to_user_id UUID REFERENCES users(id),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mobile TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS token_denylist (
  jti TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS id_counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tickets_device ON tickets(device_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee_id);
CREATE INDEX IF NOT EXISTS idx_devices_road ON devices(road_id);
CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_events(ticket_id);
CREATE INDEX IF NOT EXISTS idx_otp_mobile ON otp_challenges(mobile);
