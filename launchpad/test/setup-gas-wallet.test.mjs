import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { AccountService } from '../src/accounts.mjs';
import { ProtocolGasFunding } from '../src/protocol-gas-funding.mjs';
import { ProtocolTreasury } from '../src/protocol-treasury.mjs';
import { newTotpSecret, totp } from '../src/totp.mjs';
import { readSecret } from '../scripts/terminal-secret.mjs';
import { preflightGasStore, runGasWalletSetup, gasSetupError } from '../scripts/setup-gas-wallet.mjs';

const password = 'curve-setup-test-password', clock = 1_900_000_000_000;
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-gas-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const accounts = await new AccountService(dir, { now: () => clock, keyFile: undefined }).init();
  const admin = await accounts.register('gas_owner', password), factor = newTotpSecret();
  await accounts.mutate(registry => { const record = registry.accounts.find(row => row.id === admin.id); record.role = 'admin'; record.mfa = { secret: factor, lastCounter: -1, recoveryHashes: [] }; });
  const previous = Keypair.generate().publicKey.toBase58(), wallet = Keypair.generate(), address = wallet.publicKey.toBase58(), privateKey = bs58.encode(wallet.secretKey);
  await accounts.hostStore.write('launch-protocol-fees', { recipient: previous, creationFeeSol: '0.015' });
  return { dir, accounts, admin, previous, wallet, address, privateKey, code: totp(factor, clock) };
}
function terminal(h, overrides = {}) {
  const questions = [], secretQuestions = [], answers = ['gas_owner', h.address, h.address, 'BACKED UP'], secrets = [password, h.code, h.privateKey];
  let output = '';
  return {
    questions, secretQuestions, answers, secrets, output: () => output,
    options: {
      env: { LAUNCHPAD_DATA_DIR: h.dir }, input: { isTTY: true }, output: { isTTY: true, write: value => { output += value; } },
      ask: async question => { questions.push(question); return answers.shift(); },
      secret: async question => { secretQuestions.push(question); return secrets.shift(); },
      createAccounts: (dir, options) => new AccountService(dir, { ...options, now: () => clock }),
      ...overrides,
    },
  };
}

test('interactive setup authenticates the real admin and saves only an encrypted, inactive signer', async t => {
  const h = await fixture(t), ui = terminal(h); let receivedBytes, chainCalls = 0;
  const treasuryWallet = Keypair.generate(), treasury = new ProtocolTreasury({ accounts: h.accounts });
  await treasury.installSigner(h.admin.id, { secretKey: treasuryWallet.secretKey, expectedAddress: treasuryWallet.publicKey.toBase58(), expectedRecipient: h.previous, reason: 'Independent protocol treasury fixture' });
  const treasuryBefore = await readFile(join(h.dir, 'protocol-treasury.enc'));
  ui.options.createGasFunding = accounts => {
    const gasFunding = new ProtocolGasFunding({ accounts, chainFactory: async () => { chainCalls++; throw Error('No network during setup'); } });
    const install = gasFunding.installSigner.bind(gasFunding);
    gasFunding.installSigner = async (id, options) => { receivedBytes = options.secretKey; return install(id, options); };
    return gasFunding;
  };
  const result = await runGasWalletSetup(ui.options);
  assert.deepEqual(result, { configured: true, unchanged: false, address: h.address, enabled: false });
  const state = await h.accounts.hostStore.read('protocol-gas-funding');
  assert.equal(state.wallet.address, h.address); assert.equal(result.enabled, false);
  assert.equal(state.enabled, false); assert.equal(state.pending, null);
  assert.equal(state.activation, undefined); assert.equal(chainCalls, 0);
  assert.deepEqual(await h.accounts.hostStore.read('launch-protocol-fees'), { recipient: h.previous, creationFeeSol: '0.015' });
  assert.deepEqual(await readFile(join(h.dir, 'protocol-treasury.enc')), treasuryBefore, 'gas setup must not alter treasury keys or buyback allocations');
  assert.equal((await h.accounts.hostStore.read('registry')).accounts[0].mfa.lastCounter, Math.floor(clock / 30000));
  assert(receivedBytes.every(byte => byte === 0), 'decoded input key must be wiped after install');
  const disk = await readFile(join(h.dir, 'protocol-gas-funding.enc'), 'utf8');
  for (const secret of [password, h.code, h.privateKey]) { assert(!ui.output().includes(secret)); assert(!disk.includes(secret)); }
  assert.match(ui.output(), /Automatic gas refills remain OFF/); assert.equal(ui.secretQuestions.length, 3);
});

test('missing or empty store is refused before init, with no directory or key creation', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'launchpad-setup-preflight-')); t.after(() => rm(parent, { recursive: true, force: true }));
  for (const dir of [join(parent, 'missing'), parent]) {
    let created = false;
    const ui = terminal({ dir }, { createAccounts: () => { created = true; throw Error('Unexpected initialization'); } });
    await assert.rejects(runGasWalletSetup(ui.options), /existing account registry/);
    assert.equal(created, false); assert.deepEqual(await readdir(parent), []);
  }
  await assert.rejects(preflightGasStore({ env: {} }), /LAUNCHPAD_DATA_DIR/);
});

test('missing, mismatched and symlinked master keys fail preflight without changing registry', async t => {
  const h = await fixture(t), original = await readFile(join(h.dir, 'registry.enc'));
  await rename(join(h.dir, 'master.key'), join(h.dir, 'saved-master.key'));
  await assert.rejects(preflightGasStore({ env: { LAUNCHPAD_DATA_DIR: h.dir } }), /matching 32-byte/);
  await writeFile(join(h.dir, 'master.key'), Buffer.alloc(32), { mode: 0o600 });
  await assert.rejects(preflightGasStore({ env: { LAUNCHPAD_DATA_DIR: h.dir } }), /matching 32-byte/);
  await rm(join(h.dir, 'master.key')); await symlink(join(h.dir, 'saved-master.key'), join(h.dir, 'master.key'));
  await assert.rejects(preflightGasStore({ env: { LAUNCHPAD_DATA_DIR: h.dir } }), /matching 32-byte/);
  assert.deepEqual(await readFile(join(h.dir, 'registry.enc')), original);
  const custom = await preflightGasStore({ env: { LAUNCHPAD_DATA_DIR: h.dir, LAUNCHPAD_MASTER_KEY_FILE: join(h.dir, 'saved-master.key') } });
  assert.equal(custom.keyFile, join(h.dir, 'saved-master.key'));
});

test('a registry or key disappearing after preflight cannot initialize replacement data', async t => {
  for (const name of ['registry.enc', 'master.key']) {
    const h = await fixture(t), ui = terminal(h);
    ui.options.createAccounts = (dir, options) => {
      assert.equal(options.requireExisting, true);
      const accounts = new AccountService(dir, options), init = accounts.init.bind(accounts);
      accounts.init = async () => { await rm(join(dir, name)); return init(); };
      return accounts;
    };
    await assert.rejects(runGasWalletSetup(ui.options));
    assert(!(await readdir(h.dir)).includes(name), 'missing file must not be recreated');
    assert.equal(ui.secretQuestions.length, 0);
  }
  const base = await mkdtemp(join(tmpdir(), 'launchpad-existing-only-')); t.after(() => rm(base, { recursive: true, force: true }));
  await assert.rejects(new AccountService(join(base, 'absent'), { requireExisting: true }).init());
  assert.deepEqual(await readdir(base), []);
});

test('piped input/output and command arguments are rejected without accepting or printing secrets', async t => {
  const h = await fixture(t);
  for (const bad of ['input', 'output']) {
    const ui = terminal(h); ui.options[bad].isTTY = false;
    await assert.rejects(runGasWalletSetup(ui.options), /interactive VPS terminal/);
    assert.equal(ui.questions.length, 0); assert.equal(ui.secretQuestions.length, 0);
  }
  for (const args of [[], [h.privateKey]]) {
    const child = spawnSync(process.execPath, ['scripts/setup-gas-wallet.mjs', ...args], { cwd: new URL('../', import.meta.url), input: h.privateKey, encoding: 'utf8', env: { ...process.env, LAUNCHPAD_DATA_DIR: h.dir } });
    assert.equal(child.status, 1); assert(!`${child.stdout}${child.stderr}`.includes(h.privateKey));
    assert.match(child.stderr, args.length ? /without arguments/ : /interactive VPS terminal/);
  }
  assert.equal(await h.accounts.hostStore.read('protocol-gas-funding'), null);
});

test('wrong password or factor never reaches the private key prompt or creates a signer', async t => {
  for (const field of [0, 1]) {
    const h = await fixture(t), ui = terminal(h); ui.secrets[field] = field ? 'not-an-authenticator-code' : 'wrong-secret-password';
    await assert.rejects(runGasWalletSetup(ui.options), /authentication failed/);
    assert.equal(ui.secretQuestions.length, 2); assert.equal(await h.accounts.hostStore.read('protocol-gas-funding'), null);
    assert.equal((await h.accounts.hostStore.read('launch-protocol-fees')).recipient, h.previous);
  }
});

test('missing admin, nonadmin, wallet-only, banned and no-MFA accounts are never promoted', async t => {
  for (const change of [record => { record.username = 'other_owner'; }, record => { record.role = 'user'; }, record => { record.authType = 'wallet'; }, record => { record.banned = true; }, record => { delete record.mfa; }]) {
    const h = await fixture(t); await h.accounts.mutate(registry => change(registry.accounts[0]));
    const before = await readFile(join(h.dir, 'registry.enc')), ui = terminal(h);
    await assert.rejects(runGasWalletSetup(ui.options), /existing password-protected administrator/);
    assert.equal(ui.secretQuestions.length, 0); assert.equal(await h.accounts.hostStore.read('protocol-gas-funding'), null);
    assert.deepEqual(await readFile(join(h.dir, 'registry.enc')), before);
  }
});

test('wallet confirmation and backup acknowledgement precede private-key entry', async t => {
  for (const [field, value, pattern] of [[2, 'wrong-address', /confirmation did not match/], [3, 'no', /Back up/]]) {
    const h = await fixture(t), ui = terminal(h); ui.answers[field] = value;
    await assert.rejects(runGasWalletSetup(ui.options), pattern);
    assert.equal(ui.secretQuestions.length, 2); assert.equal(await h.accounts.hostStore.read('protocol-gas-funding'), null);
  }
});

test('wrong private key and seed phrase are rejected without printing their contents', async t => {
  for (const [secret, pattern] of [[bs58.encode(Keypair.generate().secretKey), /does not match/], ['never paste an account seed phrase into this setup', /exported base58 private key/]]) {
    const h = await fixture(t), ui = terminal(h); ui.secrets[2] = secret;
    try { await runGasWalletSetup(ui.options); assert.fail('Unexpected setup'); }
    catch (error) { assert.match(gasSetupError(error), pattern); assert(!gasSetupError(error).includes(secret)); }
    assert(!ui.output().includes(secret)); assert.equal(await h.accounts.hostStore.read('protocol-gas-funding'), null);
  }
});

test('already configured setup cannot replace a wallet or reset its ledger', async t => {
  const h = await fixture(t), gasFunding = new ProtocolGasFunding({ accounts: h.accounts });
  await gasFunding.installSigner(h.admin.id, { secretKey: h.privateKey, expectedAddress: h.address, reason: 'Test initial local setup' });
  const before = await readFile(join(h.dir, 'protocol-gas-funding.enc')), ui = terminal(h);
  const result = await runGasWalletSetup(ui.options);
  assert.equal(result.unchanged, true); assert.equal(ui.secretQuestions.length, 2); assert.equal(ui.questions.length, 1);
  assert.deepEqual(await readFile(join(h.dir, 'protocol-gas-funding.enc')), before);
});

test('unexpected errors are sanitized even if a dependency echoes a private key', async t => {
  const h = await fixture(t), ui = terminal(h, { createGasFunding: () => ({ read: async () => { throw Error(h.privateKey); }, close: async () => {} }) });
  try { await runGasWalletSetup(ui.options); assert.fail('Unexpected setup'); }
  catch (error) { const message = gasSetupError(error); assert(!message.includes(h.privateKey)); assert.match(message, /could not be completed/); }
});

test('failed gas-key persistence wipes decoded secret bytes and closes without printing dependency details', async t => {
  const h = await fixture(t); let bytes, closed = false;
  const ui = terminal(h, { createGasFunding: () => ({
    read: async () => ({ configured: false }),
    installSigner: async (_actor, options) => { bytes = options.secretKey; throw Error('Decoder echoed ' + h.privateKey); },
    close: async () => { closed = true; },
  }) });
  try { await runGasWalletSetup(ui.options); assert.fail('Unexpected setup'); }
  catch (error) { assert(!gasSetupError(error).includes(h.privateKey)); assert.match(gasSetupError(error), /could not be completed/); }
  assert.equal(closed, true); assert(bytes.every(byte => byte === 0));
  assert(!ui.output().includes(h.privateKey)); assert.equal(await h.accounts.hostStore.read('protocol-gas-funding'), null);
});

test('gas setup uses masked private-key entry with cancellation and no raw echo', async () => {
  for (const cancel of [false, true]) {
    const input = new PassThrough(); input.isTTY = true; input.setRawMode = value => { input.isRaw = value; };
    let printed = ''; const output = new Writable({ write(chunk, _encoding, done) { printed += chunk.toString(); done(); } }); output.isTTY = true;
    const raw = bs58.encode(Keypair.generate().secretKey), result = readSecret('Private key (hidden): ', { input, output });
    setImmediate(() => input.write(raw + (cancel ? '\u0003' : '\r')));
    if (cancel) await assert.rejects(result, /cancelled/); else assert.equal(await result, raw);
    assert(!printed.includes(raw)); assert.match(printed, /\*/); assert.equal(input.listenerCount('keypress'), 0);
    input.destroy(); output.end();
  }
});
