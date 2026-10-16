-- Resumable (chunked) uploads for large files and claim recovery for
-- interrupted backup runs.

-- When a run dies without releasing its claims, the row stays
-- backup_status='uploading' and is invisible to /api/backup/pending until the
-- stale sweep. backup_claimed_at lets the sweep use a short, precise TTL.
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS backup_claimed_at timestamptz;

-- Resume state for client-driven chunked uploads. A row is 'open' while the
-- kDrive session can still receive chunks; uploaded_chunks is the number of
-- contiguous chunks already stored on kDrive.
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS chunk_size integer;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS size_bytes bigint;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS parent_id bigint;
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open';
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS upload_sessions_open_media_uniq
  ON upload_sessions (media_id)
  WHERE status = 'open';
