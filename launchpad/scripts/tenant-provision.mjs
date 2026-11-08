// Creates a white-label launchpad's owner account before its first start (for automated set-ups). Run with the
// launchpad's environment (LAUNCHPAD_DATA_DIR) and one line of JSON on stdin:
//   { "username": "...", "credential": { "algorithm": "scrypt-v1", "salt": "...", "hash": "..." } }
// The credential is a password hash made with src/password-hash.mjs; no password reaches this script.
// Prints one line of JSON: { "ownerId": "...", "username": "..." }. Safe to re-run: an existing owner is kept.
import { resolve } from 'node:path';
import { AccountService } from '../src/accounts.mjs';
import { launchpadEnv } from '../src/brand-env.mjs';

async function readInput() { let text = ''; for await (const chunk of process.stdin) { text += chunk; if (text.length > 4096) throw Error('Input too long.'); } return JSON.parse(text); }
async function main() {
  const input = await readInput();
  const dir = launchpadEnv('DATA_DIR'); if (!dir) throw Error('LAUNCHPAD_DATA_DIR is required.');
  const accounts = await new AccountService(resolve(dir)).init();
  const all = await accounts.list();
  const admin = all.find(account => account.role === 'admin' && account.authType !== 'wallet');
  if (admin) { process.stdout.write(JSON.stringify({ ownerId: admin.id, username: admin.username, existing: true }) + '\n'); return; }
  const account = all.find(row => row.username === String(input.username || '').trim().toLowerCase()) || await accounts.registerWithCredential(input.username, input.credential);
  await accounts.setAdmin(account.id, true);
  process.stdout.write(JSON.stringify({ ownerId: account.id, username: account.username }) + '\n');
}
main().catch(error => { process.stderr.write(String(error?.message || error).slice(0, 300) + '\n'); process.exitCode = 1; });
