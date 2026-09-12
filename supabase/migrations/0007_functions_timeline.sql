DROP FUNCTION IF EXISTS media_timeline(timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION media_timeline(
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT now(),
  p_source_id uuid DEFAULT NULL
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
