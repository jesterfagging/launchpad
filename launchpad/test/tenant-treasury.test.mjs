// A launchpad's treasury (LAUNCHPAD_PRODUCT=tenant): the server makes the wallet and runs it as the system; every SOL receipt
// splits into the platform share (paid automatically from its minimum) and the owner's share (withdrawable by an
// administrator); the owner cannot switch it off; a failed payout backs off; the first-start bootstrap makes the
// treasury the protocol fee recipient and opens Pump.fun launches once. The chain is a fake, like the other treasury tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { TenantTreasury, TENANT_SYSTEM_ACTOR, platformAccrual, platformOwed } from '../src/tenant/treasury.mjs';
import { bootstrapTenant } from '../src/tenant/bootstrap.mjs';
import { resetTenantConfig } from '../src/tenant/config.mjs';
import { openPumpClassicDatabase, PumpClassicStore } from '../src/pump-classic/store.mjs';
import { SOL_MINT } from '../public/launchpad-model.mjs';

const address = () => Keypair.generate().publicKey.toBase58(), signature = () => bs58.encode(randomBytes(64)), copy = value => structuredClone(value);
const PLATFORM = address();

async function fixture(t, { share = { wallet: PLATFORM, bps: 1000, minimumLamports: '50000000' } } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tenant-treasury-')); t.after(() => rm(dir, { recursive: true, force: true })); let clock = 1_700_000_000_000, sequence = 0;
  const admin = { id: 'a'.repeat(32), role: 'admin', mfaEnabled: true, username: 'owner', mainWallet: address() };
  const host = new Map([['fee-policy', { recipient: address() }]]), books = new Map([[admin.id, { launches: [] }]]), incoming = new Map(), confirmed = new Map(), calls = [];
  const accounts = { dir, get: async id => (id === admin.id ? copy(admin) : null), list: async () => [copy(admin)], hostStore: { read: async (name, fallback) => copy(host.get(name) ?? fallback), write: async (name, value) => host.set(name, copy(value)) }, storeFor: id => ({ read: async (name, fallback) => (name === 'launchpad' ? copy(books.get(id) || fallback) : copy(fallback)) }) };
  const chain = {
    incomingReceipt: async (source, { wallet }) => { const receipt = incoming.get(`${source.signature}:${wallet}`); return receipt ? copy(receipt) : null; },
    prepare: async input => { calls.push(['prepare', input.kind, input.mint, input.amount, input.recipient, input.minSolReserve]); const raw = Buffer.from(JSON.stringify({ n: ++sequence, kind: input.kind, amount: input.amount })); return { kind: input.kind, wallet: input.wallet.address, mint: input.mint, inputAmount: input.amount, recipient: input.recipient, signature: signature(), raw: raw.toString('base64'), rawHash: createHash('sha256').update(raw).digest('hex'), lastValidBlockHeight: 500, preparedSlot: 50 }; },
    broadcast: async op => { calls.push(['broadcast', op.kind]); }, receipt: async op => copy(confirmed.get(op.signature) || null), state: async () => ({ state: 'unknown' }), close: async () => {},
  };
  const manager = new TenantTreasury({ accounts, chainFactory: async () => chain, now: () => clock, share }); manager.kick = () => {}; t.after(() => manager.close());
  const state = () => host.get('protocol-treasury');
  const start = async () => { const wallet = await manager.ensureWallet(); host.set('launch-protocol-fees', { recipient: wallet, recipientScope: 'launchpad', creationFeeSol: '0' }); return wallet; };
  // A creation fee in SOL (a verified source the engine credits like any protocol receipt).
  const addCreationFee = (amount, { sig = signature(), source = address() } = {}) => {
    const recipient = state().wallet.address;
    books.get(admin.id).launches.push({ input: { route: 'raydium', network: 'mainnet-beta', quoteMint: SOL_MINT, symbol: 'TEST', quoteSymbol: 'SOL' }, keys: { wallet: { address: source }, payer: { address: source }, mint: { address: address() } }, review: { quoteDecimals: 9, quoteSymbol: 'SOL' }, operations: [{ kind: 'create', signature: sig, state: 'confirmed', creationFeeReceipt: { mint: SOL_MINT, decimals: 9, recipient, amount } }] });
    incoming.set(`${sig}:${recipient}`, { signature: sig, mint: SOL_MINT, wallet: recipient, sourceWallet: source, receivedAmount: amount, sourceDebitAmount: amount, slot: 60 });
  };
  const confirm = (state_ = 'confirmed') => { const op = state().pending; assert.ok(op, 'a transaction is pending'); confirmed.set(op.signature, { state: state_, signature: op.signature, slot: 90, inputAmount: op.inputAmount, outputAmount: '0', actualSolCostLamports: '5000' }); };
  const tick = async (n = 16000) => { clock += n; await manager.process(); };
  return { manager, admin, host, calls, state, start, addCreationFee, confirm, tick, advance: n => { clock += n; } };
}

test('the platform share is exact over any number of receipts', () => {
  assert.equal(platformAccrual('999', 1000), 99n); assert.equal(platformAccrual('1000', 1000), 100n); assert.equal(platformAccrual('0', 1000), 0n);
  assert.equal(platformOwed({ accrued: '500', paid: '100' }, { tag: { step: 'platform' }, inputAmount: '300' }), 100n); assert.equal(platformOwed({ accrued: '500', paid: '100' }, { tag: { step: 'other' }, inputAmount: '300' }), 400n);
});

test('the server makes the wallet once and runs it as the system; the owner cannot switch it off or replace it', async t => {
  const h = await fixture(t);
  const wallet = await h.start();
  assert.equal(await h.manager.ensureWallet(), wallet, 'idempotent');
  const state = h.state();
  assert.equal(state.wallet.origin, 'server-generated'); assert.equal(state.enabled, true); assert.equal(state.operatorId, TENANT_SYSTEM_ACTOR);
  assert.equal(Keypair.fromSecretKey(bs58.decode(state.wallet.secret)).publicKey.toBase58(), wallet);
  for (const call of [() => h.manager.configure(h.admin.id, { enabled: false }), () => h.manager.installSigner(h.admin.id, {}), () => h.manager.recognizeRevenue(h.admin.id, {})]) await assert.rejects(call, err => err.statusCode === 403 && /managed by the platform/.test(err.message));
  assert.equal((await h.manager.requireAdmin(TENANT_SYSTEM_ACTOR)).role, 'admin'); await assert.rejects(h.manager.requireAdmin('b'.repeat(32)), /two-factor/);
  const view = await h.manager.read(h.admin.id); assert.equal(view.managed, true); assert.equal(view.platform.wallet, PLATFORM); assert.equal(view.platform.bps, 1000);
});

test('SOL revenue splits 10/90, the platform is paid from its minimum, and an owner withdrawal leaves its share behind', async t => {
  const h = await fixture(t); await h.start();
  h.addCreationFee('30000000'); h.addCreationFee('30000003'); // 0.06 SOL
  await h.tick();
  const ledger = () => h.state().platform;
  assert.equal(ledger().basisSol, '60000003'); assert.equal(ledger().accrued, '6000000'); assert.equal(h.state().totals.retainedSol, '54000003'); assert.equal(h.state().totals.buybackAvailable, '0');
  assert.equal(h.calls.filter(c => c[0] === 'prepare').length, 0, 'below the 0.05 SOL minimum nothing is paid');
  // 0.5 SOL more: 0.056 SOL accrued → one payout of everything owed, to the platform wallet, tagged.
  h.addCreationFee('500000000'); await h.tick();
  assert.equal(ledger().accrued, '56000000');
  const pending = h.state().pending; assert.ok(pending); assert.equal(pending.kind, 'withdraw'); assert.equal(pending.recipient, PLATFORM); assert.equal(pending.inputAmount, '56000000'); assert.deepEqual(pending.tag, { product: 'tenant', step: 'platform' });
  assert.equal(h.calls.find(c => c[0] === 'prepare')[5], '10000000', 'the payout only keeps the operating reserve');
  assert.equal(platformOwed(ledger(), h.state().pending), 0n, 'nothing is owed twice while the payout is in flight');
  h.confirm(); await h.tick();
  assert.equal(ledger().paid, '56000000'); assert.equal(ledger().payouts.length, 1); assert.equal(h.state().pending, null);
  assert.equal(h.state().totals.withdrawnSol, '0', 'a platform payout is not an owner withdrawal'); assert.equal(h.state().totals.retainedSol, String(54000003 + 450000000 - 5000), 'the payout fee is a network cost');
  // The owner withdraws: what remains available excludes the reserve and the operation limit; the obligation is the platform's unpaid share.
  h.addCreationFee('100000000'); await h.tick(); // +0.01 SOL accrued, below the minimum
  const available = BigInt((await h.manager.read(h.admin.id)).availableRetainedSol);
  assert.equal(available, BigInt(h.state().totals.retainedSol) - 15000000n);
  await h.manager.withdrawRetained(h.admin.id, { amountSol: '0.2', recipient: address(), reason: 'Owner payout', requestId: 'req-0123456789abcdef' });
  h.calls.length = 0; await h.tick();
  const prepared = h.calls.find(c => c[0] === 'prepare'); assert.equal(prepared[1], 'withdraw'); assert.equal(prepared[3], '200000000'); assert.equal(prepared[5], String(10000000 + 10000000), 'the platform’s unpaid 0.01 SOL stays in the wallet');
  h.confirm(); await h.tick(); assert.equal(h.state().totals.withdrawnSol, '200000000');
});

test('a failed platform payout backs off and is prepared again', async t => {
  const h = await fixture(t); await h.start();
  h.addCreationFee('1000000000'); await h.tick();
  assert.equal(h.state().pending.inputAmount, '100000000');
  h.confirm('failed'); await h.tick();
  assert.equal(h.state().platform.paid, '0'); assert.ok(h.state().platform.retry?.nextAttemptAt > 0); assert.equal(h.state().pending, null);
  h.calls.length = 0; await h.tick(1000); assert.equal(h.calls.filter(c => c[0] === 'prepare').length, 0, 'not before the back-off');
  h.advance(3600000); await h.tick(); assert.equal(h.state().pending?.inputAmount, '100000000');
});

test('without a platform share the owner keeps everything', async t => {
  const h = await fixture(t, { share: null }); await h.start();
  h.addCreationFee('1000000000'); await h.tick();
  assert.equal(h.state().platform.accrued, '0'); assert.equal(h.state().totals.retainedSol, '1000000000'); assert.equal(h.state().pending, null);
});

test('the first start makes the treasury the fee recipient and opens Pump.fun launches once', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tenant-boot-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'tenant.json'); await writeFile(file, JSON.stringify({ version: 1, name: 'Moon Pad', slug: 'moon-pad', layout: 'terminal', preset: 'emerald', venues: ['pump-classic', 'raydium'], modes: ['creator', 'holders'] }));
  const env = { LAUNCHPAD_PRODUCT: 'tenant', LAUNCHPAD_TENANT_FILE: file, LAUNCHPAD_PLATFORM_SHARE_WALLET: PLATFORM };
  resetTenantConfig(); t.after(resetTenantConfig);
  const host = new Map([['launch-protocol-fees', { recipient: address(), recipientScope: 'legacy', creationFeeSol: '0.01', history: [] }]]);
  const accounts = { dir, get: async () => null, list: async () => [], hostStore: { read: async (name, fallback) => copy(host.get(name) ?? fallback), write: async (name, value) => host.set(name, copy(value)) } };
  const first = await bootstrapTenant({ accounts, env });
  const policy = host.get('launch-protocol-fees');
  assert.equal(policy.recipient, first.wallet); assert.equal(policy.recipientScope, 'launchpad'); assert.equal(policy.creationFeeSol, '0.01', 'the owner’s creation fee is kept'); assert.equal(policy.history.at(-1).to, first.wallet);
  const db = await openPumpClassicDatabase(join(dir, 'pump-classic', 'pump-classic.sqlite')), store = new PumpClassicStore(db);
  assert.equal(store.flag('intake'), true); store.setFlag('intake', false, { reason: 'owner paused', by: 'owner' }); db.close();
  const second = await bootstrapTenant({ accounts, env });
  assert.equal(second.wallet, first.wallet, 'the same treasury on every start');
  const again = await openPumpClassicDatabase(join(dir, 'pump-classic', 'pump-classic.sqlite')); assert.equal(new PumpClassicStore(again).flag('intake'), false, 'an owner’s pause is kept'); again.close();
});
