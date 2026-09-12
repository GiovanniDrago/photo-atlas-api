DROP FUNCTION IF EXISTS media_clusters(double precision, double precision, double precision, double precision, integer);

CREATE OR REPLACE FUNCTION media_cell_size(p_zoom integer)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT 360.0 / power(2.0, greatest(least(p_zoom, 18), 0)::double precision);
$$;

CREATE OR REPLACE FUNCTION media_clusters(
  p_west double precision,
  p_south double precision,
  p_east double precision,
  p_north double precision,
  p_zoom integer,
  p_source_id uuid DEFAULT NULL
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
