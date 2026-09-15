ALTER TABLE sources ADD COLUMN IF NOT EXISTS include_subfolders boolean NOT NULL DEFAULT true;
