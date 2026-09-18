import crypto from 'node:crypto';
import 'dotenv/config';
import { query } from '../src/db.js';
import { passwordPolicyError } from '../src/lib/passwords.js';
import * as gotrue from '../src/lib/gotrue.js';

function randomPassword() {
  return `pa-${crypto.randomBytes(12).toString('base64url')}`;
}

async function main() {
  const [, , emailArg, passwordArg] = process.argv;
  const email = String(emailArg ?? '').trim().toLowerCase();
  if (!email) {
    console.error('usage: npm run reset-password -- <email> [new_password]');
    process.exit(1);
  }
  const password = passwordArg || randomPassword();
  const policyError = passwordPolicyError(password, { email });
  if (policyError) {
    console.error(policyError);
    process.exit(1);
  }

  const user = await gotrue.adminFindUserByEmail(email);
  if (!user) {
    console.error(`no Supabase Auth user found for ${email}`);
    process.exit(1);
  }
  await gotrue.adminUpdateUser(user.id, { password, email_confirm: true });
  try {
    await gotrue.adminSignOutUser(user.id);
  } catch {
    // Older GoTrue deployments may not expose the admin sign-out route.
  }
  await query("INSERT INTO auth_events (user_id, kind) VALUES ($1, 'password_reset_cli')", [user.id]);
  console.log(`password updated for ${email}: ${password}`);
  console.log('every existing session was signed out where supported');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
