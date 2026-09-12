CREATE TABLE IF NOT EXISTS scan_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid REFERENCES sources(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  files_seen integer NOT NULL DEFAULT 0,
  files_indexed integer NOT NULL DEFAULT 0,
  files_skipped integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS scan_runs_started_at_idx ON scan_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS scan_runs_source_idx ON scan_runs (source_id);
