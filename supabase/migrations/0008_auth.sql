-- Supabase Auth compatibility.
--
-- On Supabase the `auth` schema and `auth.users` already exist; this migration only creates a
-- minimal stub when the database is plain PostgreSQL (local development and CI), so foreign keys
-- and tests work without the full Supabase stack. The stub is never touched on Supabase because
-- the table exists there (checked through pg_class, which every role can read).

CREATE SCHEMA IF NOT EXISTS auth;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'auth' AND c.relname = 'users' AND c.relkind = 'r'
  ) THEN
    CREATE TABLE auth.users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text,
      email_confirmed_at timestamptz,
      raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX auth_users_email_lower_uniq
      ON auth.users (lower(email))
      WHERE email IS NOT NULL;
  END IF;
END $$;

ALTER TABLE sources ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS sources_owner_idx ON sources (owner_id);

ALTER TABLE kdrive_accounts ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX IF NOT EXISTS kdrive_accounts_owner_uniq ON kdrive_accounts (owner_id);

DROP INDEX IF EXISTS sources_kdrive_folder_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS sources_kdrive_folder_uniq
  ON sources (owner_id, kdrive_drive_id, kdrive_folder_id)
  WHERE kind = 'kdrive';
