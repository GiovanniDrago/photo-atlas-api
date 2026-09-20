import os from 'node:os';
import path from 'node:path';
import 'dotenv/config';

function splitRoots(value) {
  return (value ?? '')
    .split(':')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://photo_atlas:photo_atlas@127.0.0.1:54329/photo_atlas',
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  kdriveEncKey: process.env.KDRIVE_ENC_KEY ?? '',
  supabaseUrl: (process.env.SUPABASE_URL ?? '').replace(/\/+$/, ''),
  supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? '',
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY ?? '',
  supabaseJwksUrl: process.env.SUPABASE_JWKS_URL ?? '',
  emailConfirmRedirectUrl: process.env.EMAIL_CONFIRM_REDIRECT_URL ?? '',
  kdriveApiBase: process.env.KDRIVE_API_BASE ?? 'https://api.infomaniak.com',
  kdriveMinIntervalMs: Number(process.env.KDRIVE_MIN_INTERVAL_MS ?? 1100),
  mediaUrlSecret: process.env.MEDIA_URL_SECRET ?? process.env.KDRIVE_ENC_KEY ?? 'photo-atlas-dev-secret',
  mediaCacheDir: process.env.MEDIA_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'photo-atlas'),
  localMediaRoots: splitRoots(process.env.LOCAL_MEDIA_ROOTS),
  kdriveBasePath: (process.env.KDRIVE_BASE_PATH ?? 'Private/Media/PhotoAtlas')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean),
  uploadTmpDir: process.env.MEDIA_UPLOAD_TMP_DIR ?? path.join(os.homedir(), '.cache', 'photo-atlas', 'uploads'),
  uploadMaxBytes: Number(process.env.UPLOAD_MAX_BYTES ?? 8 * 1024 * 1024 * 1024),
  maxBatchSize: 500,
};
