# Supabase cloud setup

Production layout: the API runs on the home VM, **Supabase cloud** hosts PostgreSQL + Auth
(GoTrue), **kDrive** stores the original images and the VM keeps the thumbnail cache. The database is
metadata only, so the free plan is plenty.

## 1. Project and extensions

1. Create the project at <https://supabase.com> (free plan, region close to Italy: Frankfurt or
   Zurich).
2. **Database → Extensions**: enable `postgis` and `pg_trgm` (`pgcrypto` is not needed,
   `gen_random_uuid()` is built in on PostgreSQL 13+).
3. Keep the database password safe: it is needed for `DATABASE_URL`.

## 2. Connection string (IPv4 pooler)

Supabase direct connections (`db.<ref>.supabase.co`) are IPv6-only for new projects and this VM has
no IPv6, so **always use the Session Pooler**:

```
Project settings → Database → Connection pooling → Session
postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
```

Store it as `DATABASE_URL` in the API `.env` (mode `600`, never committed). If the password
contains `@ # % : /`, percent-encode those characters.

## 3. API keys

From **Project settings → API** copy into `.env`:

| Key | Variable | Notes |
|---|---|---|
| Project URL | `SUPABASE_URL` | `https://<ref>.supabase.co`, also returned to the app by `GET /api/config` |
| Publishable key (`sb_publishable_…`) | `SUPABASE_PUBLISHABLE_KEY` | public, shipped to the app |
| Secret key (`sb_secret_…`) | `SUPABASE_SECRET_KEY` | server only: Auth admin API |
| JWKS URL | `SUPABASE_JWKS_URL` | `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json` |

The API verifies access tokens locally with `jose` and the JWKS (asymmetric signing keys); the
secret key never leaves the server.

## 4. Schema

```bash
npm run migrate    # applies supabase/migrations to DATABASE_URL
```

`0008_auth.sql` only creates a local `auth.users` stub when the real Supabase schema is missing
(local development and CI). `0012_rls_hardening.sql` enables RLS with no policies on every app table
and revokes the `anon`/`authenticated` grants: the Supabase Data API cannot read anything, while the
API (table owner) is unaffected. There is no seed on production.

## 5. Email confirmation

Email confirmation stays enabled. The confirmation link redirects to a static page that is built
from this repository:

```bash
bash scripts/build-netlify-page.sh          # dist/photo-atlas-confirm-email.zip
# or download the artifact from GitHub Actions (workflow "Netlify page")
```

1. Upload the zip on <https://app.netlify.com/drop> (drag & drop, no build).
2. In Supabase: **Authentication → URL Configuration** → Site URL and Redirect URLs = the Netlify
   page URL (for example `https://<site>.netlify.app/`).
3. Put the same URL, with the app marker, in `.env`:

   ```
   EMAIL_CONFIRM_REDIRECT_URL=https://<site>.netlify.app/?app=PhotoAtlas
   ```

   `GET /api/config` returns it and the app passes it as `emailRedirectTo`.
4. **Authentication → Providers → Email**: *Confirm email* ON. **Authentication → Emails**: the
   default *Confirm signup* template is fine (`{{ .ConfirmationURL }}`).
5. The built-in email service is rate limited and in practice only delivers to project team
   addresses; configure **Authentication → SMTP Settings** (for example Infomaniak) when other
   people need to register.

## 6. Users, MFA and recovery codes

- Accounts, passwords, email confirmation and TOTP factors live in Supabase Auth and are visible in
  **Authentication → Users** (ban, delete, inspect factors, resend emails).
- The app enforces TOTP through Supabase and the API rejects AAL1 sessions with
  `403 mfa_required` once a verified factor exists.
- Recovery codes stay in our database (`password_recovery_codes`, `mfa_recovery_codes`): the app
  shows them once, each code works once, and the API uses the secret key to reset the password or
  delete the TOTP factors through the Auth admin API.
- The API also mirrors `email`, `display_name` and `mfa_enabled` into `profiles` for joins and
  filters.

## 7. Free plan limits

| Resource | Free plan | Impact |
|---|---|---|
| Database size | 500 MB | Metadata only; images stay on kDrive or on the device |
| Egress | 5 GB / month | Only JSON + `pg_dump`; thumbnails are served by the VM |
| Project pause | after ~1 week idle | Wake it from the dashboard; the first request after a pause fails |
| Auth emails | built-in service, very limited | Configure SMTP for real users |

## 8. Backups

```bash
pg_dump "$DATABASE_URL" --no-owner --no-acl -f photo-atlas-$(date +%F).sql
```

Keep the `KDRIVE_ENC_KEY` of the API `.env` safe: it decrypts the kDrive token stored in the
database.
