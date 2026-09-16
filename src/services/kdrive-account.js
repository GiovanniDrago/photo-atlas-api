import { query } from '../db.js';
import { config } from '../config.js';
import { decryptSecret } from '../lib/crypto.js';
import { KDriveClient } from './kdrive.js';

export async function getKDriveClient(userId) {
  const { rows } = await query(
    'SELECT * FROM kdrive_accounts WHERE owner_id = $1 ORDER BY created_at ASC LIMIT 1',
    [userId],
  );
  if (rows.length === 0) {
    const error = new Error('kDrive account is not connected');
    error.statusCode = 409;
    throw error;
  }
  const account = rows[0];
  const token = decryptSecret(
    { cipher: account.token_cipher, iv: account.token_iv, tag: account.token_tag },
    config.kdriveEncKey,
  );
  return {
    account,
    client: new KDriveClient({
      token,
      driveId: Number(account.drive_id),
      baseUrl: config.kdriveApiBase,
    }),
  };
}
