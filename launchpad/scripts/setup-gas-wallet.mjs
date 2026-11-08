import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { AccountService } from '../src/accounts.mjs';
import { ProtocolGasFunding } from '../src/protocol-gas-funding.mjs';
import { preflightTreasuryStore, treasurySetupError } from './setup-treasury-wallet.mjs';
import { readSecret } from './terminal-secret.mjs';

class SetupError extends Error {}
const fail = message => { throw new SetupError(message); };
const ADMIN_REQUIRED = 'Use an existing password-protected administrator account with two-factor authentication enabled. This command cannot create or promote an account.';
const publicBackendErrors = new Set([
  'Administrator access with two-factor authentication is required.',
  'The private key does not match the gas wallet address you confirmed.',
  'A gas funding wallet is already configured. Setup cannot replace it or reset its ledger.',
  'The gas wallet must be separate from treasury, protocol revenue, user and launch wallets.',
  'Enter a valid 64-byte Solana private key for the dedicated gas wallet.',
  'The gas funding ledger has existing activity. Restore its original wallet before continuing.',
  'The encrypted gas funding ledger could not be read. Restore its original data before continuing.',
  'The encrypted gas signing key does not match its wallet. Restore its original data.',
]);

// Decoder/dependency errors can include their input. Never print arbitrary
// exception text after accepting a private key or authentication secret.
export function gasSetupError(error) {
  if (error instanceof SetupError || publicBackendErrors.has(error?.message)) return error.message;
  return 'Gas wallet setup could not be completed. Check access to the existing account data and retry. No key or error details were printed.';
}

export async function preflightGasStore(options = {}) {
  try { return await preflightTreasuryStore(options); }
  catch (error) {
    const safe = treasurySetupError(error);
    if (safe.startsWith('Treasury setup could not be completed.')) fail('Gas wallet setup could not be completed. Check access to the existing account data and retry.');
    fail(safe);
  }
}

async function askTerminal(question, { input, output }) {
  const rl = createInterface({ input, output, historySize: 0 });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

export async function runGasWalletSetup({
  env = process.env, input = process.stdin, output = process.stdout,
  ask = askTerminal, secret = readSecret,
  createAccounts = (dir, options) => new AccountService(dir, options),
  createGasFunding = accounts => new ProtocolGasFunding({ accounts }),
} = {}) {
  if (!input.isTTY || !output.isTTY) fail('Open an interactive VPS terminal. Gas wallet keys are accepted only at a hidden terminal prompt, never through pipes or command arguments.');
  const paths = await preflightGasStore({ env });
  const accounts = await createAccounts(paths.dir, { keyFile: paths.keyFile, requireExisting: true }).init();
  const io = { input, output }, say = value => output.write(`${value}\n`);
  let gasFunding, password = '', code = '', text = '', bytes;
  try {
    say('Launchpad automatic gas funding wallet setup');
    say(`Existing account data: ${paths.dir}`);
    say('Use a NEW dedicated Solana wallet whose backup you control. Keep it separate from the protocol treasury, user and creator wallets.');
    say('The VPS will also have signing access. This wallet funds network costs only; it does not spend the treasury buyback allocation.');
    say('Setup saves its key encrypted. It does not enable refills, change fee routing, or submit a transaction.');
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
    gasFunding = createGasFunding(accounts);
    const current = await gasFunding.read(actor.id);
    if (current.configured) {
      say(`Configured gas funding wallet: ${current.address}`);
      say('A gas funding wallet is already configured. Its key, accounting and activation state were left unchanged.');
      say('This command cannot replace a configured gas funding wallet.');
      return { configured: true, unchanged: true, address: current.address, enabled: current.enabled };
    }
    const suppliedAddress = await ask('NEW gas funding wallet PUBLIC address: ', io);
    let expectedAddress;
    try { const key = new PublicKey(suppliedAddress); if (!PublicKey.isOnCurve(key.toBytes())) throw Error(); expectedAddress = key.toBase58(); }
    catch { fail('Enter the dedicated gas funding wallet\'s public Solana address.'); }
    say(`Gas funding address: ${expectedAddress}`);
    if (await ask('Confirm by entering the SAME gas funding public address again: ', io) !== expectedAddress) fail('Gas funding address confirmation did not match. No key was saved.');
    if (await ask('Have you backed up this dedicated wallet privately? Type BACKED UP: ', io) !== 'BACKED UP') fail('Back up the dedicated wallet first, then run setup again. No key was saved.');
    text = await secret('Gas funding PRIVATE key (base58, hidden; never paste it in chat): ', io);
    try {
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(text)) throw Error();
      bytes = bs58.decode(text);
      if (bytes.length !== 64) throw Error();
    } catch { fail('Use the exported base58 private key for this Solana account, not its seed phrase or public address.'); }
    finally { text = ''; }
    const installed = await gasFunding.installSigner(actor.id, {
      secretKey: bytes, expectedAddress,
      reason: 'Owner-controlled gas funding setup from local console',
    });
    say(`Gas funding wallet saved: ${installed.address}`);
    say('Automatic gas refills remain OFF. Protocol fees and buyback allocations are unchanged.');
    say('Open Admin > Revenue > Gas refills, verify this address, fund this separate wallet with SOL, and enable refills when ready.');
    return { configured: true, unchanged: false, address: installed.address, enabled: false };
  } finally {
    password = ''; code = ''; text = ''; bytes?.fill(0);
    try { await gasFunding?.close?.(); }
    finally { accounts.master?.fill(0); accounts.hostStore?.key?.fill(0); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) fail('Run setup-gas-wallet.mjs without arguments. Enter credentials and the private key only at its hidden prompts.');
    await runGasWalletSetup();
  } catch (error) { console.error(gasSetupError(error)); process.exitCode = 1; }
}
