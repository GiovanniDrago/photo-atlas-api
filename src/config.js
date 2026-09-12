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
  kdriveApiBase: process.env.KDRIVE_API_BASE ?? 'https://api.infomaniak.com',
  localMediaRoots: splitRoots(process.env.LOCAL_MEDIA_ROOTS),
  maxBatchSize: 500,
};
