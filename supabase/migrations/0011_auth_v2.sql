-- Auth v2: email identity, MFA (TOTP), recovery codes, session hardening, audit log.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_cipher text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_iv text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_tag text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uniq
  ON users (lower(email))
  WHERE email IS NOT NULL;

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS mfa_satisfied boolean NOT NULL DEFAULT true;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip text;

CREATE INDEX IF NOT EXISTS sessions_active_user_idx
  ON sessions (user_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);

CREATE INDEX IF NOT EXISTS mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id);

CREATE TABLE IF NOT EXISTS password_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);

CREATE INDEX IF NOT EXISTS password_recovery_codes_user_idx ON password_recovery_codes (user_id);

CREATE TABLE IF NOT EXISTS auth_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL,
  ip text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_events_user_idx ON auth_events (user_id, created_at DESC);
