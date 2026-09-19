-- Devices, kDrive backup state and verification runs.

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  name text,
  platform text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS devices_owner_fingerprint_uniq ON devices (owner_id, fingerprint);

ALTER TABLE sources ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS album_key text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS auto_backup boolean NOT NULL DEFAULT false;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS backup_folder_id bigint;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS backup_folder_path text;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS backup_enabled_at timestamptz;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS backup_last_run_at timestamptz;

CREATE INDEX IF NOT EXISTS sources_device_idx ON sources (device_id);
CREATE UNIQUE INDEX IF NOT EXISTS sources_local_album_uniq
  ON sources (owner_id, device_id, album_key)
  WHERE kind = 'local' AND album_key IS NOT NULL;

ALTER TABLE media_items ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS hash_algo text;
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS backup_status text NOT NULL DEFAULT 'none'
  CONSTRAINT media_items_backup_status_check
  CHECK (backup_status IN ('none', 'pending', 'uploading', 'uploaded', 'failed', 'skipped'));
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS kdrive_file_id bigint;
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS kdrive_parent_id bigint;
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS backed_up_at timestamptz;
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS backup_error text;
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS backup_attempts integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS media_items_backup_queue_idx
  ON media_items (source_id, backup_status)
  WHERE backup_status IN ('none', 'pending', 'failed');
CREATE INDEX IF NOT EXISTS media_items_backed_up_at_idx ON media_items (backed_up_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS media_items_kdrive_file_idx
  ON media_items (kdrive_file_id)
  WHERE kdrive_file_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS backup_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'backup' CHECK (kind IN ('backup', 'verify')),
  source_id uuid REFERENCES sources(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  files_seen integer NOT NULL DEFAULT 0,
  files_uploaded integer NOT NULL DEFAULT 0,
  files_skipped integer NOT NULL DEFAULT 0,
  files_failed integer NOT NULL DEFAULT 0,
  verified_ok integer NOT NULL DEFAULT 0,
  verified_missing integer NOT NULL DEFAULT 0,
  bytes_uploaded bigint NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS backup_runs_started_idx ON backup_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS backup_runs_source_idx ON backup_runs (source_id);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id uuid NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  session_token text,
  upload_url text,
  total_chunks integer,
  uploaded_chunks integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

CREATE INDEX IF NOT EXISTS upload_sessions_media_idx ON upload_sessions (media_id);

DO $$
DECLARE
  tbl text;
  guarded text[] := ARRAY['devices', 'backup_runs', 'upload_sessions'];
BEGIN
  FOREACH tbl IN ARRAY guarded LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = tbl AND c.relkind = 'r'
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
  END IF;
END $$;
