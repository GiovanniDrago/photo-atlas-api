DROP FUNCTION IF EXISTS media_clusters(double precision, double precision, double precision, double precision, integer, uuid);

CREATE OR REPLACE FUNCTION media_clusters(
  p_west double precision,
  p_south double precision,
  p_east double precision,
  p_north double precision,
  p_zoom integer,
  p_source_id uuid DEFAULT NULL,
  p_owner_id uuid DEFAULT NULL
)
RETURNS TABLE (
  cluster_key text,
  lat double precision,
  lon double precision,
  item_count bigint,
  min_lat double precision,
  min_lon double precision,
  max_lat double precision,
  max_lon double precision,
  representative_id uuid
)
LANGUAGE sql
STABLE
AS $$
  WITH points AS (
    SELECT
      m.id,
      m.lat,
      m.lon,
      floor((m.lon + 180.0) / media_cell_size(p_zoom)) AS cell_x,
      floor((m.lat + 90.0) / media_cell_size(p_zoom)) AS cell_y
    FROM media_items m
    WHERE m.lat IS NOT NULL
      AND m.lon IS NOT NULL
      AND m.lon BETWEEN p_west AND p_east
      AND m.lat BETWEEN p_south AND p_north
      AND (p_source_id IS NULL OR m.source_id = p_source_id)
      AND (
        p_owner_id IS NULL
        OR m.source_id IN (SELECT id FROM sources WHERE owner_id = p_owner_id)
      )
  )
  SELECT
    p.cell_x::text || ':' || p.cell_y::text AS cluster_key,
    avg(p.lat)::double precision AS lat,
    avg(p.lon)::double precision AS lon,
    count(*)::bigint AS item_count,
    min(p.lat) AS min_lat,
    min(p.lon) AS min_lon,
    max(p.lat) AS max_lat,
    max(p.lon) AS max_lon,
    (array_agg(p.id ORDER BY p.id))[1] AS representative_id
  FROM points p
  GROUP BY p.cell_x, p.cell_y
  ORDER BY item_count DESC, cluster_key ASC;
$$;

DROP FUNCTION IF EXISTS media_timeline(timestamptz, timestamptz, uuid);

CREATE OR REPLACE FUNCTION media_timeline(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT now(),
  p_source_id uuid DEFAULT NULL,
  p_owner_id uuid DEFAULT NULL
)
RETURNS TABLE (
  bucket_start timestamptz,
  bucket_end timestamptz,
  granularity text,
  item_count bigint,
  representative_id uuid
)
LANGUAGE sql
STABLE
AS $$
  WITH bounds AS (
    SELECT
      p_to AS upper_bound,
      p_to - interval '2 months' AS day_limit,
      p_to - interval '5 months' AS week_limit
  ),
  bucketed AS (
    SELECT
      m.id,
      m.taken_at,
      CASE
        WHEN m.taken_at >= b.day_limit THEN 'day'
        WHEN m.taken_at >= b.week_limit THEN 'week'
        ELSE 'month'
      END AS granularity,
      CASE
        WHEN m.taken_at >= b.day_limit THEN date_trunc('day', m.taken_at)
        WHEN m.taken_at >= b.week_limit THEN date_trunc('week', m.taken_at)
        ELSE date_trunc('month', m.taken_at)
      END AS bucket_start
    FROM media_items m
    CROSS JOIN bounds b
    WHERE m.taken_at IS NOT NULL
      AND (p_from IS NULL OR m.taken_at >= p_from)
      AND m.taken_at <= p_to
      AND (p_source_id IS NULL OR m.source_id = p_source_id)
      AND (
        p_owner_id IS NULL
        OR m.source_id IN (SELECT id FROM sources WHERE owner_id = p_owner_id)
      )
  )
  SELECT
    b.bucket_start,
    CASE b.granularity
      WHEN 'day' THEN b.bucket_start + interval '1 day'
      WHEN 'week' THEN b.bucket_start + interval '7 days'
      ELSE b.bucket_start + interval '1 month'
    END AS bucket_end,
    b.granularity,
    count(*)::bigint AS item_count,
    (array_agg(b.id ORDER BY b.taken_at DESC))[1] AS representative_id
  FROM bucketed b
  GROUP BY b.bucket_start, b.granularity
  ORDER BY b.bucket_start DESC;
$$;
