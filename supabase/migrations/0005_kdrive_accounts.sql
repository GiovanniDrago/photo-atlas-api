CREATE TABLE IF NOT EXISTS kdrive_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL DEFAULT 'kDrive',
  drive_id bigint NOT NULL,
  token_cipher text NOT NULL,
  token_iv text NOT NULL,
  token_tag text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
