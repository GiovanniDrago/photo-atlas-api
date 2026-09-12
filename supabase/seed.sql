DO $$
DECLARE
  v_source uuid;
BEGIN
  SELECT id INTO v_source FROM sources WHERE label = 'Demo library' LIMIT 1;
  IF v_source IS NULL THEN
    INSERT INTO sources (kind, label, root_path)
    VALUES ('local', 'Demo library', '/home/droid/Pictures')
    RETURNING id INTO v_source;
  END IF;

  DELETE FROM media_items WHERE source_id = v_source;

  WITH groups(name, lat, lon, item_count, base_days) AS (
    VALUES
      ('Turin', 45.0703, 7.6869, 8, 3),
      ('Milan', 45.4642, 9.1900, 5, 12),
      ('Rome', 41.9028, 12.4964, 3, 40),
      ('Paris', 48.8566, 2.3522, 2, 150),
      ('New York', 40.7128, -74.0060, 2, 600)
  )
  INSERT INTO media_items (
    source_id, external_key, name, path, mime, media_type, size_bytes,
    taken_at, file_created_at, lat, lon, metadata_status, width, height
  )
  SELECT
    v_source,
    'demo:' || lower(replace(g.name, ' ', '-')) || ':' || s.i,
    g.name || '_' || lpad(s.i::text, 3, '0') || '.jpg',
    '/home/droid/Pictures/' || lower(replace(g.name, ' ', '-')) || '/' || g.name || '_' || lpad(s.i::text, 3, '0') || '.jpg',
    'image/jpeg',
    'image',
    1800000 + (s.i * 37000),
    now() - ((g.base_days + s.i * 9) || ' days')::interval,
    now() - ((g.base_days + s.i * 9 + 1) || ' days')::interval,
    g.lat + (s.i - 3) * 0.004,
    g.lon + (s.i - 3) * 0.006,
    'full',
    4032,
    3024
  FROM groups g
  CROSS JOIN LATERAL generate_series(1, g.item_count) AS s(i);

  INSERT INTO media_items (
    source_id, external_key, name, path, mime, media_type, size_bytes,
    taken_at, lat, lon, metadata_status, width, height
  )
  SELECT
    v_source,
    'demo:unsorted:' || i,
    'Unsorted_' || lpad(i::text, 3, '0') || '.jpg',
    '/home/droid/Pictures/unsorted/Unsorted_' || lpad(i::text, 3, '0') || '.jpg',
    'image/jpeg',
    'image',
    900000 + i * 11000,
    CASE WHEN i % 2 = 0 THEN now() - (i * 20 || ' days')::interval ELSE NULL END,
    NULL,
    NULL,
    CASE WHEN i % 2 = 0 THEN 'partial' ELSE 'none' END,
    1280,
    960
  FROM generate_series(1, 3) AS i;

  INSERT INTO media_items (
    source_id, external_key, name, path, mime, media_type, size_bytes,
    taken_at, lat, lon, metadata_status, width, height, duration_s
  )
  SELECT
    v_source,
    'demo:video:' || i,
    'Clip_' || lpad(i::text, 3, '0') || '.mp4',
    '/home/droid/Videos/Clip_' || lpad(i::text, 3, '0') || '.mp4',
    'video/mp4',
    'video',
    35000000 + i * 4200000,
    now() - ((i * 70) || ' days')::interval,
    CASE WHEN i = 1 THEN 45.0703 ELSE NULL END,
    CASE WHEN i = 1 THEN 7.6869 ELSE NULL END,
    CASE WHEN i = 1 THEN 'partial' ELSE 'none' END,
    1920,
    1080,
    42.5 + i
  FROM generate_series(1, 2) AS i;
END $$;
