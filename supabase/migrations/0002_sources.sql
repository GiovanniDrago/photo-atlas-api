CREATE TABLE IF NOT EXISTS sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('local', 'kdrive')),
  label text NOT NULL,
  root_path text,
  kdrive_drive_id bigint,
  kdrive_folder_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_scan_at timestamptz
);

CREATE INDEX IF NOT EXISTS sources_kind_idx ON sources (kind);
CREATE UNIQUE INDEX IF NOT EXISTS sources_kdrive_folder_uniq
  ON sources (kdrive_drive_id, kdrive_folder_id)
  WHERE kind = 'kdrive';
