import { createHash, randomUUID, randomInt } from 'node:crypto';
import { open, realpath, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VersionedTransaction } from '@solana/web3.js';
import { launchpadEnv } from './brand-env.mjs';
import { verifySignedTransaction } from './providers.mjs';
import * as client from '../scripts/pump-private-test.mjs';
import { acquireProcessLock } from './process-lock.mjs';

export const PUMP_TEST_OPERATOR = '7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS';
export const PUMP_TEST_TREASURY = 'HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF';
const SOL = 'So11111111111111111111111111111111111111112';
const STORE = 'pump-funded-test';
const TERMINAL = new Set(['finalized', 'failed']);
const ACTIONS = new Set(['initialize', 'buy-to-bond', 'sell-recovery', 'migrate']);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const jsonSafe = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item));
const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const under = (root, file) => { const path = relative(root, file); return path === '' || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path); };
const object = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('Unsupported private-test input.');
};
function signedBytes(value) {
  if (typeof value !== 'string' || value.length > 1800 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail('A wallet-signed transaction is required.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || bytes.length > 1232) fail('Invalid wallet-signed transaction.');
  return bytes;
}
export function verifyFundedSignedTransaction(signed, bundle, wallet) {
  const bytes = signedBytes(signed);
  let tx, unsigned;
  try {
    tx = VersionedTransaction.deserialize(bytes);
    unsigned = VersionedTransaction.deserialize(Buffer.from(bundle.unsignedTransaction, 'base64'));
    if (tx.version !== 0 || unsigned.version !== 0 || !Buffer.from(tx.message.serialize()).equals(Buffer.from(unsigned.message.serialize()))) throw Error('message');
    verifySignedTransaction(bytes, wallet);
  } catch { fail('The wallet transaction does not match the reviewed operation.'); }
  return hash(tx.message.serialize());
}

/** Reads a private config only. The adapter also verifies its shipped deployment binding. */
export async function readPrivatePumpConfig(path) {
  if (!path || !isAbsolute(path)) fail('Private test deployment is not configured.', 409);
  const parent = await realpath(dirname(path));
  if (under(await realpath(publicRoot), resolve(parent, path.split(sep).at(-1)))) fail('Private configuration must be outside public assets.', 409);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 32768 || process.platform !== 'win32' && (info.mode & 0o077)) fail('Private deployment configuration is not protected.', 409);
    const config = JSON.parse(await file.readFile('utf8'));
    return { config, configDir: parent, configPath: path };
  } finally { await file.close(); }
}

// No signer or private key is accepted. The only broadcasting path consumes an
// exact wallet signature for a durable, server-prepared, session-bound operation.
export class PumpFundedTestService {
  constructor({ accounts, requireOwner, configPath = launchpadEnv('PUMP_TEST_CONFIG') || (accounts.dir ? resolve(accounts.dir, 'pump-test-config.json') : null), adapter = null, now = Date.now, ttlMs = 120000, verifySignature = verifyFundedSignedTransaction }) {
    this.accounts = accounts; this.requireOwner = requireOwner; this.configPath = configPath;
    this.adapter = adapter || new PumpFundedClientAdapter({ configPath });
    this.verifySignature = verifySignature; this.now = now; this.ttlMs = Math.min(120000, Math.max(1000, ttlMs));
  }
  async authorize(session, context) {
    if (!context || typeof context.authorize !== 'function' || !context.sessionToken) fail('A current owner session is required.', 403);
    const current = await context.authorize();
    if (!current || current.account?.id !== session.account?.id) fail('The owner session changed. Sign in again.', 403);
    await this.requireOwner(current);
    return current;
  }
  async readStore() {
    const data = await this.accounts.hostStore.read(STORE, { schemaVersion: 1, operations: [] });
    if (data?.schemaVersion !== 1 || !Array.isArray(data.operations)) fail('Private transaction history is unavailable.', 409);
    return data;
  }
  async writeStore(data) {
    await this.accounts.hostStore.write(STORE, data);
    // The encrypted store fsyncs its temporary file before rename. Persist the
    // directory entry too before any transaction may reach the network.
    const directory = await open(this.accounts.dir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async locked(fn) {
    await mkdir(this.accounts.dir, { recursive: true, mode: 0o700 });
    const lockPath = resolve(this.accounts.dir, 'pump-funded-test.lock');
    let release;
    try { release = await acquireProcessLock(lockPath, 0); }
    catch { fail('Another private-test operation is in progress. Retry its status.', 409); }
    try { return await fn(); } finally { await release(); }
  }
  publicOperation(operation) {
    if (!operation) return null;
    return { id: operation.id, action: operation.action, wallet: operation.wallet, state: operation.state,
      expiresAt: operation.expiresAt, messageHash: operation.messageHash,
      ...(operation.state === 'awaiting_signature' ? { transaction: operation.bundle.unsignedTransaction } : {}),
      ...(operation.signature ? { signature: operation.signature } : {}), review: operation.review,
      ...(operation.result ? { result: operation.result } : {}) };
  }
  async binding() {
    const loaded = await this.adapter.load();
    if (loaded.config.operator !== PUMP_TEST_OPERATOR || loaded.config.treasury !== PUMP_TEST_TREASURY || loaded.config.cluster !== 'mainnet-beta' || loaded.config.graduationFeeBps !== 2885 || loaded.config.tradeFeeBps !== 100) fail('Deployment does not match the owner microtest.', 409);
    loaded.fingerprint = hash(JSON.stringify(loaded.config));
    return loaded;
  }
  contextRpc(loaded, session, context, allowSend = false) {
    const rpc = this.adapter.rpc(loaded);
    return async (method, params) => {
      if (method === 'sendTransaction') {
        if (!allowSend) fail('This private-test action is read-only.', 403);
        await this.authorize(session, context);
        const fresh = await this.binding();
        if (fresh.fingerprint !== loaded.fingerprint) fail('Deployment configuration changed. Review again.', 409);
        await this.authorize(session, context);
      }
      return rpc(method, params);
    };
  }
  async status(session, context) {
    await this.authorize(session, context);
    const data = await this.readStore(), latest = data.operations.at(-1);
    const activeOperation = latest?.ownerId === session.account.id ? this.publicOperation(latest) : null;
    const base = { enabled: false, verifiedDeployment: false, operator: PUMP_TEST_OPERATOR, treasury: PUMP_TEST_TREASURY, quoteMint: SOL,
      preset: 'micro-test', cluster: 'mainnet-beta', phase: 'uninitialized', actions: [], activeOperation, blockers: [] };
    try {
      const loaded = await this.binding();
      const chain = await this.adapter.status(loaded, this.contextRpc(loaded, session, context));
      await this.authorize(session, context);
      if ((await this.binding()).fingerprint !== loaded.fingerprint) fail('Deployment configuration changed.', 409);
      const unresolved = latest && !TERMINAL.has(latest.state) && latest.state !== 'cancelled' && !(latest.state === 'awaiting_signature' && latest.expiresAt <= this.now());
      return { ...base, ...chain, enabled: true, verifiedDeployment: true, actions: unresolved ? [] : chain.actions,
        activeOperation, blockers: [...(chain.blockers || []), ...(unresolved ? ['Resolve the saved operation before preparing another.'] : [])] };
    } catch (error) {
      if ([401, 403].includes(error.statusCode)) throw error;
      await this.authorize(session, context);
      return { ...base, blockers: ['A verified owner-test deployment is required. No funded transaction is available.'] };
    }
  }
  async prepare(session, input, context) {
    object(input, ['action', 'expectedWallet', 'solUsdMicros']);
    if (input.action === 'initialize') {
      if (typeof input.solUsdMicros !== 'string' || !/^[1-9][0-9]{0,12}$/.test(input.solUsdMicros) || BigInt(input.solUsdMicros) > 1000000000000n) fail('Enter a current manual SOL/USD price before initialization.');
    } else if (Object.hasOwn(input, 'solUsdMicros')) fail('A price snapshot is accepted only for initialization.');
    if (!ACTIONS.has(input.action) || input.expectedWallet !== PUMP_TEST_OPERATOR) fail('Choose an available action with the configured operator wallet.');
    await this.authorize(session, context);
    return this.locked(async () => {
      let loaded = await this.binding();
      const data = await this.readStore(), previous = data.operations.at(-1);
      const sessionHash = hash(context.sessionToken);
      if (previous && !TERMINAL.has(previous.state) && previous.state !== 'cancelled') {
        if (previous.state === 'awaiting_signature' && previous.ownerId === session.account.id && previous.sessionHash === sessionHash && previous.action === input.action && previous.configFingerprint === loaded.fingerprint && previous.expiresAt > this.now() && (input.action !== 'initialize' || input.solUsdMicros === loaded.config.solUsdMicros)) {
          await this.authorize(session, context); return { operation: this.publicOperation(previous) };
        }
        if (previous.state === 'awaiting_signature' && previous.expiresAt <= this.now()) previous.state = 'cancelled';
        else fail('Resolve the saved operation before preparing another.', 409);
      }
      if (input.action === 'initialize') {
        const chain = await this.adapter.status(loaded, this.contextRpc(loaded, session, context));
        if (chain.phase !== 'uninitialized') fail('The private curve is already initialized. Its price cannot be changed.', 409);
        await this.authorize(session, context);
        await this.adapter.configurePrice(loaded, input.solUsdMicros, this.now());
        loaded = await this.binding();
      }
      const rpc = this.contextRpc(loaded, session, context);
      const bundle = await this.adapter.prepare(loaded, rpc, input.action);
      await this.authorize(session, context);
      if ((await this.binding()).fingerprint !== loaded.fingerprint) fail('Deployment changed during preparation.', 409);
      const tx = VersionedTransaction.deserialize(Buffer.from(bundle.unsignedTransaction, 'base64'));
      if (tx.version !== 0 || tx.message.header.numRequiredSignatures !== 1 || tx.message.staticAccountKeys[0]?.toBase58() !== PUMP_TEST_OPERATOR || tx.signatures.some(signature => signature.some(Boolean))) fail('Prepared transaction is not a supported owner-wallet message.', 409);
      const operation = { id: randomUUID(), ownerId: session.account.id, sessionHash, action: input.action, wallet: PUMP_TEST_OPERATOR,
        state: 'awaiting_signature', createdAt: this.now(), expiresAt: this.now() + this.ttlMs,
        configFingerprint: loaded.fingerprint, messageHash: hash(tx.message.serialize()), bundle: jsonSafe(bundle),
        review: { ...jsonSafe(bundle.details || {}), maxWalletDebitLamports: bundle.maxWalletDebitLamports, walletBalanceLamports: bundle.walletBalanceLamports,
          operator: PUMP_TEST_OPERATOR, treasury: PUMP_TEST_TREASURY, cluster: 'mainnet-beta', quoteMint: SOL, preset: 'micro-test', action: input.action,
          solUsdMicros: loaded.config.solUsdMicros, priceObservedAt: loaded.config.priceObservedAt },
        journal: { schemaVersion: 1, entries: [] } };
      data.operations.push(operation);
      if (data.operations.length > 100) data.operations.splice(0, data.operations.length - 100);
      await this.authorize(session, context); await this.writeStore(data);
      return { operation: this.publicOperation(operation) };
    });
  }
  async submit(session, input, context) {
    object(input, ['operationId', 'signedTransaction']); signedBytes(input.signedTransaction);
    await this.authorize(session, context);
    return this.locked(async () => {
      const data = await this.readStore(), operation = data.operations.at(-1);
      if (!operation || input.operationId !== operation.id || operation.ownerId !== session.account.id || operation.sessionHash !== hash(context.sessionToken)) fail('This reviewed operation belongs to another session.', 403);
      const loaded = await this.binding();
      if (operation.configFingerprint !== loaded.fingerprint) fail('Deployment configuration changed. No transaction was sent.', 409);
      this.verifySignature(input.signedTransaction, operation.bundle, operation.wallet);
      const previous = operation.journal.entries.at(-1);
      if (previous && previous.signedTransaction !== input.signedTransaction) fail('Only the saved signed transaction may be retried.', 409);
      if (TERMINAL.has(operation.state)) return { operation: this.publicOperation(operation) };
      if (!previous && operation.expiresAt <= this.now()) fail('The unsigned review expired. Prepare and review again.', 409);
      const journalStore = { read: async () => operation.journal, write: async journal => {
        operation.journal = jsonSafe(journal); const entry = journal.entries.at(-1);
        if (entry) { operation.state = entry.state; operation.signature = entry.signature; }
        await this.writeStore(data);
      } };
      try {
        const result = await this.adapter.submit(loaded, this.contextRpc(loaded, session, context, true), operation.bundle, input.signedTransaction, journalStore);
        operation.result = jsonSafe(result); operation.state = result.state; operation.signature = result.signature || operation.signature;
        await this.writeStore(data); await this.authorize(session, context);
        return { operation: this.publicOperation(operation) };
      } catch (error) {
        if ([401, 403].includes(error.statusCode)) throw error;
        if (operation.journal.entries.length) {
          const entry = operation.journal.entries.at(-1); operation.state = entry.state; operation.signature = entry.signature;
          await this.writeStore(data); await this.authorize(session, context);
          return { operation: this.publicOperation(operation), notice: 'Check the saved transaction receipt before taking another action.' };
        }
        fail('The transaction could not be submitted. Review its status before retrying.', 409);
      }
    });
  }
  async reconcile(session, input, context) {
    object(input, ['operationId']); await this.authorize(session, context);
    return this.locked(async () => {
      const data = await this.readStore(), operation = data.operations.at(-1);
      // Receipt checks can survive a renewed owner session; signing cannot.
      if (!operation || operation.id !== input.operationId || operation.ownerId !== session.account.id) fail('Saved operation was not found.', 404);
      if (operation.state === 'awaiting_signature' || TERMINAL.has(operation.state)) return { operation: this.publicOperation(operation) };
      const loaded = await this.binding();
      if (operation.configFingerprint !== loaded.fingerprint) fail('Deployment configuration changed. Receipt review is required.', 409);
      const result = await this.adapter.reconcile(loaded, this.contextRpc(loaded, session, context), operation.journal.entries.at(-1));
      await this.authorize(session, context);
      operation.result = jsonSafe(result); operation.state = result.state;
      Object.assign(operation.journal.entries.at(-1), jsonSafe(result));
      await this.writeStore(data);
      return { operation: this.publicOperation(operation) };
    });
  }
}

export class PumpFundedClientAdapter {
  constructor({ configPath }) { this.configPath = configPath; }
  async load() {
    const loaded = await readPrivatePumpConfig(this.configPath);
    // The reviewed binding verifier is intentionally mandatory; copying an
    // arbitrary JSON file or setting an enable flag cannot activate funding.
    if (typeof client.verifyWebConfigBinding !== 'function') fail('The deployment binding verifier is unavailable.', 409);
    await client.verifyWebConfigBinding(loaded.config, { configDir: loaded.configDir });
    loaded.config = client.validateConfig(loaded.config); return loaded;
  }
  async configurePrice(loaded, solUsdMicros, now) {
    const config = client.validateConfig({ ...loaded.config, solUsdMicros, priceObservedAt: new Date(now).toISOString() }, { now, requirePrice: true });
    await client.atomicJson(this.configPath, config);
  }
  rpc(loaded) { return client.createRpc(loaded.config); }
  async status(loaded, rpc) {
    await client.verifyDeployment(loaded.config, rpc, { configDir: loaded.configDir, operation: 'receipt-reconciliation' });
    let pumpCompatible = true;
    try { await client.verifyDeployment(loaded.config, rpc, { configDir: loaded.configDir }); } catch { pumpCompatible = false; }
    const addresses = await client.deriveAddresses(loaded.config);
    const account = await rpc('getAccountInfo', [addresses.state.toBase58(), { encoding: 'base64', commitment: 'finalized' }]);
    const state = client.decodeState(account?.value, loaded.config, addresses);
    const phase = state ? ['trading', 'bonded', 'migrated'][state.phase] : 'uninitialized';
    if (!phase) fail('Unrecognized private curve state.', 409);
    const recovery = state && state.phase < 2 && state.sold > 0n ? ['sell-recovery'] : [];
    const actions = pumpCompatible ? phase === 'uninitialized' ? ['initialize'] : phase === 'trading' ? ['buy-to-bond', ...recovery] : phase === 'bonded' ? [...recovery, 'migrate'] : [] : recovery;
    return { phase, actions, pumpCompatible, blockers: pumpCompatible ? [] : ['PumpSwap compatibility must be reverified before buying or migrating. Held tokens can still be recovered before migration.'], mint: addresses.mint.toBase58(), ...(state ? { curveState: jsonSafe(state) } : {}) };
  }
  async prepare(loaded, rpc, action) {
    const poolIndex = action === 'migrate' ? await selectCleanPumpPoolIndex(loaded.config, rpc) : 0;
    return client.prepare(loaded.config, rpc, action, { configDir: loaded.configDir, transactionVersion: 0, poolIndex });
  }
  submit(loaded, rpc, bundle, signedTransaction, journalStore) {
    return client.submitSignedPlan({ config: loaded.config, rpc, bundle, signedTransaction, journalStore, configDir: loaded.configDir, acknowledgement: 'I_ACCEPT_REAL_SOL_PRIVATE_TEST' });
  }
  async reconcile(loaded, rpc, entry) {
    await client.verifyDeployment(loaded.config, rpc, { configDir: loaded.configDir, operation: 'receipt-reconciliation' });
    return client.reconcileReceipt(loaded.config, rpc, entry);
  }
}

// A new reviewed migration may choose a fresh unused pool index. Retries always
// retain the original server-saved bundle and cannot select another index.
export async function selectCleanPumpPoolIndex(config, rpc, { derive = client.deriveAddresses, select = () => randomInt(65536) } = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const poolIndex = select(), addresses = await derive(config, poolIndex);
    const results = await Promise.all(['pool', 'lpMint', 'authorityLp', 'poolBase', 'poolQuote'].map(key => rpc('getAccountInfo', [addresses[key].toBase58(), { encoding: 'base64', commitment: 'finalized' }])));
    if (results.every(result => result && Object.hasOwn(result, 'value') && result.value === null)) return poolIndex;
  }
  fail('No clean pool index was found. No migration transaction was prepared.', 409);
}
