import 'dotenv/config';
import { config } from '../src/config.js';
import { query } from '../src/db.js';
import { getKDriveClient } from '../src/services/kdrive-account.js';

const content = Buffer.from(`photo-atlas probe ${new Date().toISOString()}\n`);
const name = `photo-atlas-probe-${Date.now()}.txt`;

async function main() {
  const { rows } = await query(
    'SELECT owner_id FROM kdrive_accounts ORDER BY created_at ASC LIMIT 1',
  );
  if (rows.length === 0) {
    console.error('no kDrive account connected: connect it from the app first');
    process.exit(1);
  }
  const { client } = await getKDriveClient(rows[0].owner_id);

  const drive = await client.getDrive();
  console.log('drive ok:', drive?.data?.id ?? drive?.id ?? 'unknown');

  const folder = await client.ensureFolderPath(config.kdriveBasePath);
  console.log(`base folder ready: ${folder.path} (id ${folder.id})`);

  const uploaded = await client.uploadFile({
    parentId: folder.id,
    name,
    size: content.length,
    body: content,
  });
  console.log(`uploaded: id=${uploaded.id} name=${uploaded.name} size=${uploaded.size}`);

  const prefix = await client.readPrefix(uploaded.id, content.length + 32);
  console.log('downloaded content matches:', prefix.subarray(0, content.length).equals(content));

  await client.deleteFile(uploaded.id);
  console.log('probe file moved to trash');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('probe failed:', error.message);
    process.exit(1);
  });
