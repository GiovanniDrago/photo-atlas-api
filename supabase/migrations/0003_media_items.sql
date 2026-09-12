CREATE TABLE IF NOT EXISTS media_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_key text NOT NULL,
  path text,
  name text NOT NULL,
  mime text,
  media_type text NOT NULL DEFAULT 'image' CHECK (media_type IN ('image', 'video')),
  size_bytes bigint,
  taken_at timestamptz,
  file_created_at timestamptz,
  modified_at timestamptz,
  lat double precision,
  lon double precision,
  geog geography(Point, 4326) GENERATED ALWAYS AS (
    CASE
      WHEN lat IS NOT NULL AND lon IS NOT NULL
        THEN ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography
      ELSE NULL
    END
  ) STORED,
  metadata_status text NOT NULL DEFAULT 'none' CHECK (metadata_status IN ('none', 'partial', 'full')),
  width integer,
  height integer,
  duration_s numeric(10, 3),
  thumb_path text,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_items_lat_range CHECK (lat IS NULL OR (lat >= -90 AND lat <= 90)),
  CONSTRAINT media_items_lon_range CHECK (lon IS NULL OR (lon >= -180 AND lon <= 180)),
  CONSTRAINT media_items_source_key UNIQUE (source_id, external_key)
);

CREATE INDEX IF NOT EXISTS media_items_geog_idx ON media_items USING GIST (geog);
CREATE INDEX IF NOT EXISTS media_items_taken_at_idx ON media_items (taken_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS media_items_metadata_status_idx ON media_items (metadata_status);
CREATE INDEX IF NOT EXISTS media_items_media_type_idx ON media_items (media_type);
CREATE INDEX IF NOT EXISTS media_items_source_idx ON media_items (source_id);
CREATE INDEX IF NOT EXISTS media_items_name_trgm_idx ON media_items USING GIN (name gin_trgm_ops);
