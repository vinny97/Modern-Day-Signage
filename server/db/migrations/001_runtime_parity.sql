-- Bring the Postgres bootstrap schema to parity with columns and tables that
-- legacy SQLite installations add through startup migrations.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_alerts INTEGER DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_started INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_plan TEXT DEFAULT 'pro';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS welcome_email_sent_at INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS activation_nudge_sent_at INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password INTEGER NOT NULL DEFAULT 0;

ALTER TABLE assignments ADD COLUMN IF NOT EXISTS muted INTEGER DEFAULT 0;

ALTER TABLE devices ADD COLUMN IF NOT EXISTS layout_id TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'UTC';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS reported_timezone TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS reported_utc INTEGER;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS reported_at INTEGER;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS wall_id TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS team_id TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS orientation TEXT DEFAULT 'landscape';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS default_content_id TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_token TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS workspace_id TEXT;

ALTER TABLE content ADD COLUMN IF NOT EXISTS team_id TEXT;
ALTER TABLE content ADD COLUMN IF NOT EXISTS folder TEXT;
ALTER TABLE content ADD COLUMN IF NOT EXISTS folder_id TEXT;
ALTER TABLE content ADD COLUMN IF NOT EXISTS workspace_id TEXT;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  owner_user_id TEXT NOT NULL,
  plan_id TEXT DEFAULT 'free',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT DEFAULT 'active',
  subscription_ends INTEGER,
  grace_period_ends INTEGER,
  locked_at INTEGER,
  default_brand_name TEXT,
  default_logo_url TEXT,
  default_primary_color TEXT,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

CREATE TABLE IF NOT EXISTS organization_members (
  id BIGSERIAL PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'org_admin',
  invited_by TEXT,
  joined_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  UNIQUE (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT,
  created_by TEXT,
  billing_type TEXT DEFAULT 'client_billable',
  billing_notes TEXT,
  billing_contact_email TEXT,
  billing_contract_ref TEXT,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  updated_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS workspace_members (
  id BIGSERIAL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'workspace_viewer',
  invited_by TEXT,
  joined_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  UNIQUE (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS workspace_invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'workspace_viewer',
  invited_by TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
);

CREATE TABLE IF NOT EXISTS content_folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  workspace_id TEXT
);

ALTER TABLE playlists ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE layouts ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE widgets ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE video_walls ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE device_groups ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE white_labels ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE kiosk_pages ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE alert_configs ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS workspace_id TEXT;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS acting_user_id TEXT;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS was_acting_as INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_devices_workspace ON devices(workspace_id);
CREATE INDEX IF NOT EXISTS idx_content_workspace ON content(workspace_id);
CREATE INDEX IF NOT EXISTS idx_playlists_workspace ON playlists(workspace_id);
CREATE INDEX IF NOT EXISTS idx_video_walls_workspace ON video_walls(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_organization ON workspaces(organization_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id);
CREATE INDEX IF NOT EXISTS idx_organization_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_content_folders_user ON content_folders(user_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_content_folders_workspace ON content_folders(workspace_id);
CREATE INDEX IF NOT EXISTS idx_content_folder ON content(folder_id);
