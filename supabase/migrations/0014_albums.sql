-- Albums are database relations, never kDrive folders: a media item can belong
-- to many albums and removing it from an album never deletes the file.

CREATE TABLE IF NOT EXISTS albums (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual', 'smart')),
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  cover_media_id uuid REFERENCES media_items(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS albums_owner_idx ON albums (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS album_items (
  album_id uuid NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (album_id, media_id)
);

CREATE INDEX IF NOT EXISTS album_items_media_idx ON album_items (media_id);

DO $$
DECLARE
  tbl text;
  guarded text[] := ARRAY['albums', 'album_items'];
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
