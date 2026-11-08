import { createInterface } from 'node:readline/promises';
import { AccountService } from '../src/accounts.mjs';
import { AccountFeePolicy } from '../src/account-policy.mjs';
import { accountRoot } from '../src/host-server.mjs';
import { readSecret } from './terminal-secret.mjs';
import { managedAccountsEnabled, toolkitEnabled } from '../src/product-mode.mjs';
async function ask(question) { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return (await rl.question(question)).trim(); } finally { rl.close(); } }
async function main() {
  const accounts = await new AccountService(accountRoot()).init();
  console.log('Launchpad owner setup. This local command grants administrator access.');
  const managed = managedAccountsEnabled();
  const username = await ask(managed ? 'Owner username (existing or new): ' : 'Existing owner username: ');
  const existing = (await accounts.list()).find(a => a.username === username.toLowerCase());
  if (!existing && !managed) throw Error('New password accounts and user wallet generation are disabled. Recover your existing owner account to link its sign-in wallet. This command did not create an account or wallet.');
  if (existing?.authType === 'wallet') throw Error('This command verifies an existing password-protected owner account. It cannot promote a wallet account without the separate owner recovery process.');
  const password = await readSecret('Password (10–128 characters): ');
  const code = existing?.mfaEnabled ? await readSecret('Authenticator or recovery code: ') : undefined;
  const account = existing ? await accounts.authenticate(username, password, code) : await accounts.register(username, password);
  await accounts.setAdmin(account.id, true);
  if (toolkitEnabled()) {
    const recipient = await ask('Solana toolkit fee-collection wallet address (blank to leave unchanged): ');
    if (recipient) await new AccountFeePolicy(accounts).setRecipient(recipient);
  }
  console.log(`Administrator ready: ${account.username}. Recover this account with its existing password, enable two-factor authentication under Account → Security, and link your external sign-in wallet. Configure launchpad fees in Admin.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
