# Move to Supabase cloud (free plan)

The local setup is intentionally compatible with the Supabase free plan. When you are ready:

## 1. Create the project

1. Sign in at <https://supabase.com> and create a project on the **free plan**.
2. Pick a region close to you (for Italy/Europe: Frankfurt or Zurich).
3. Store the database password safely.

## 2. Install and link the CLI

```bash
npm install -g supabase
supabase login
supabase link --project-ref <your-project-ref>
```

## 3. Push the schema

```bash
supabase db push
```

This applies every file in `supabase/migrations` to the cloud database. `pgcrypto` is not needed:
`gen_random_uuid()` is built in on PostgreSQL 13+. `postgis` and `pg_trgm` are available on the free
plan and are enabled by `0001_extensions.sql`.

Seed data is optional in production:

```bash
psql "$CLOUD_DATABASE_URL" -f supabase/seed.sql   # only for a demo instance
```

## 4. Point the API at Supabase

Copy the connection string from **Project settings → Database → Connection string**.

- Prefer the **pooler** (port 6543) for serverless or many short connections.
- Use `sslmode=require`:

```env
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require
```

Restart the API. No code changes are needed.

## 5. Row Level Security (recommended before exposing the project)

The local single-user setup does not enable RLS. If you plan to call the database directly from
clients or to use the Supabase auto-generated API, enable RLS per table and add policies, for
example:

```sql
ALTER TABLE media_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "media_items_owner" ON media_items
  FOR ALL
  USING (auth.uid() = (SELECT owner_id FROM sources WHERE sources.id = media_items.source_id))
  WITH CHECK (auth.uid() = (SELECT owner_id FROM sources WHERE sources.id = media_items.source_id));
```

That requires adding an `owner_id uuid REFERENCES auth.users(id)` column to `sources` and
backfilling it. Keep using Photo Atlas API as the only writer for the first versions: it connects
with the service role through `DATABASE_URL`, so RLS does not slow the scan pipeline.

## 6. Free plan limits to keep in mind

| Resource | Free plan | Impact |
|---|---|---|
| Database size | 500 MB | Metadata only; images stay on device or kDrive |
| Egress | 5 GB / month | Thumbnails are the main consumer; keep `?width=` small |
| Project pause | after 1 week idle | Wake it from the dashboard |
| PostgREST + Auth | included | usable later for a multi-user version |

Because images and videos are never copied into the database, 500 MB is plenty for hundreds of
thousands of indexed files.

## 7. Backups

Use `supabase db dump` for a schema + data snapshot before risky migrations:

```bash
supabase db dump -f backup-schema.sql
supabase db dump --data-only -f backup-data.sql
```
