import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { AccountService } from '../src/accounts.mjs';
import { launchpadEnv } from '../src/brand-env.mjs';
import { TelegramStore } from '../src/telegram-store.mjs';
import { ProtocolTreasury } from '../src/protocol-treasury.mjs';
import { readSecret } from './terminal-secret.mjs';

class SetupError extends Error {}
const fail = message => { throw new SetupError(message); };
const ADMIN_REQUIRED = 'Use an existing password-protected administrator account with two-factor authentication enabled. This command cannot create or promote an account.';
const STORE_REQUIRED = 'The existing account registry and matching 32-byte encryption key are required. Check the service environment and restore missing files; setup did not create an account store.';
const publicBackendErrors = new Set([
  'Administrator access with two-factor authentication is required.',
  'The protocol recipient changed. Refresh before setting up the treasury.',
  'The private key does not match the treasury address you confirmed.',
  'A treasury wallet is already configured. This setup cannot replace it or reset its ledger.',
  'The treasury has existing activity or accounting. Restore and review its original ledger before setting up a wallet.',
  'The treasury wallet must be separate from user, creator, service and toolkit wallets.',
  'Use a new dedicated wallet that has not received protocol revenue before. Existing revenue can be transferred and verified after activation.',
  'Enter a valid 64-byte Solana private key for the dedicated treasury wallet.',
  'The encrypted treasury ledger could not be read. Restore its original data before continuing.',
  'The encrypted treasury signing key does not match its wallet. Restore its original data.',
  'The treasury rounding ledger is invalid.',
]);

// Do not forward arbitrary exception strings: key decoders and dependencies can
// include their input in errors. Only fixed local messages leave this command.
export function treasurySetupError(error) {
  if (error instanceof SetupError || publicBackendErrors.has(error?.message)) return error.message;
  return 'Treasury setup could not be completed. Check access to the existing account data and retry. No key or error details were printed.';
}

export async function preflightTreasuryStore({ env = process.env } = {}) {
  let configuredDir, configuredKey;
  configuredDir = launchpadEnv('DATA_DIR', env); configuredKey = launchpadEnv('MASTER_KEY_FILE', env);
  if (!configuredDir?.trim()) fail('LAUNCHPAD_DATA_DIR must point to the existing service account data. Run setup using launchpad.service\'s environment file.');
  let key;
  try {
    const dir = await realpath(resolve(configuredDir));
    if (!(await lstat(dir)).isDirectory()) throw Error();
    const keyFile = resolve(configuredKey || join(dir, 'master.key'));
    const [registryInfo, keyInfo] = await Promise.all([lstat(join(dir, 'registry.enc')), lstat(keyFile)]);
    if (!registryInfo.isFile() || registryInfo.size === 0 || !keyInfo.isFile() || keyInfo.size !== 32) throw Error();
    if (process.platform !== 'win32' && (keyInfo.mode & 0o077)) throw Error();
    key = await readFile(keyFile);
    if (key.length !== 32) throw Error();
    const store = new TelegramStore(dir, key, 'relay-accounts-host');
    let registry;
    try { registry = await store.read('registry'); } finally { store.key.fill(0); }
    if (!Array.isArray(registry?.accounts) || registry.accounts.length === 0) throw Error();
    return { dir, keyFile };
  } catch { fail(STORE_REQUIRED); }
  finally { key?.fill(0); }
}

async function askTerminal(question, { input, output }) {
  const rl = createInterface({ input, output, historySize: 0 });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

export async function runTreasuryWalletSetup({
  env = process.env, input = process.stdin, output = process.stdout,
  ask = askTerminal, secret = readSecret,
  createAccounts = (dir, options) => new AccountService(dir, options),
  createTreasury = accounts => new ProtocolTreasury({ accounts }),
} = {}) {
  if (!input.isTTY || !output.isTTY) fail('Open an interactive VPS terminal. Treasury keys are accepted only at a hidden terminal prompt, never through pipes or command arguments.');
  const paths = await preflightTreasuryStore({ env });
  const accounts = await createAccounts(paths.dir, { keyFile: paths.keyFile, requireExisting: true }).init();
  const io = { input, output }, say = value => output.write(`${value}\n`);
  let treasury, password = '', code = '', text = '', bytes;
  try {
    say('Launchpad treasury wallet setup');
    say(`Existing account data: ${paths.dir}`);
    say('Use a NEW dedicated Solana wallet whose backup you control. The VPS will also have signing access.');
    say('Setup saves its key encrypted. It does not enable buybacks, change fee routing, or submit a transaction.');
    const username = (await ask('Existing Launchpad administrator username: ', io)).toLowerCase();
    const existing = (await accounts.list()).find(account => account.username === username);
    if (!existing || existing.role !== 'admin' || existing.authType === 'wallet' || !existing.mfaEnabled || existing.banned) fail(ADMIN_REQUIRED);
    password = await secret('Launchpad account password (hidden): ', io);
    code = await secret('Authenticator or recovery code (hidden): ', io);
    let actor;
    try { actor = await accounts.authenticate(username, password, code); }
    catch { fail('Administrator authentication failed. Check your password and use a new authenticator code, then run setup again.'); }
    finally { password = ''; code = ''; }
    if (actor.role !== 'admin' || !actor.mfaEnabled || actor.banned) fail(ADMIN_REQUIRED);
    treasury = createTreasury(accounts);
    const current = await treasury.read(actor.id);
    if (current.configured) {
      say(`Configured treasury: ${current.address}`);
      say('A treasury wallet is already configured. Its key, accounting and activation state were left unchanged.');
      say('This command cannot replace a configured treasury wallet.');
      return { configured: true, unchanged: true, address: current.address, enabled: current.enabled };
    }
    const suppliedAddress = await ask('NEW treasury wallet PUBLIC address: ', io);
    let expectedAddress;
    try { const key = new PublicKey(suppliedAddress); if (!PublicKey.isOnCurve(key.toBytes())) throw Error(); expectedAddress = key.toBase58(); }
    catch { fail('Enter the dedicated treasury wallet\'s public Solana address.'); }
    say(`Treasury address: ${expectedAddress}`);
    say(`Current protocol fee recipient: ${current.expectedRecipient || '(not configured)'}`);
    if (await ask('Confirm by entering the SAME treasury public address again: ', io) !== expectedAddress) fail('Treasury address confirmation did not match. No key was saved.');
    if (await ask('Have you backed up this dedicated wallet privately? Type BACKED UP: ', io) !== 'BACKED UP') fail('Back up the dedicated wallet first, then run setup again. No key was saved.');
    text = await secret('Treasury PRIVATE key (base58, hidden; never paste it in chat): ', io);
    try {
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(text)) throw Error();
      bytes = bs58.decode(text);
      if (bytes.length !== 64) throw Error();
    } catch { fail('Use the exported base58 private key for this Solana account, not its seed phrase or public address.'); }
    finally { text = ''; }
    const installed = await treasury.installSigner(actor.id, {
      secretKey: bytes, expectedAddress, expectedRecipient: current.expectedRecipient,
      reason: 'Owner-controlled treasury setup from local console',
    });
    say(`Treasury wallet saved: ${installed.address}`);
    say('Automatic buybacks remain OFF. The existing protocol fee recipient is unchanged.');
    say('Open Admin > Revenue > Treasury, verify this address, and enable automatic buybacks when ready.');
    return { configured: true, unchanged: false, address: installed.address, enabled: false };
  } finally {
    password = ''; code = ''; text = ''; bytes?.fill(0);
    await treasury?.close();
    accounts.master?.fill(0); accounts.hostStore?.key?.fill(0);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail('Run setup-treasury-wallet.mjs without arguments. Enter credentials and the private key only at its hidden prompts.');
    await runTreasuryWalletSetup();
  } catch (error) { console.error(treasurySetupError(error)); process.exitCode = 1; }
}
