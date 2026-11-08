// Vanity contract addresses on Pump.fun launches (v71.20): the address is
// switched in once the creator's funding is final, before the launch counts as
// funded, so quotes and fundings that never settle use none and the coin's
// address is final before anything binds to it. Restart recovery, an address
// taken meanwhile, a pool that was never stocked, a failing pool and agent
// listing. Dependency-free (real Ed25519 keys).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { PumpClassicService, generateWallet } from '../src/pump-classic/service.mjs';
import { base58Encode, base58Decode } from '../src/pump-classic/codec.mjs';
import { VanityMintPool, VANITY_LIMITS } from '../src/vanity-pool.mjs';
import { AGENT_MODE } from '../public/agent-catalog.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const signature = () => base58Encode(randomBytes(64));
function signedOp(fields) { const raw = Buffer.from(randomBytes(200)).toString('base64'); return { signature: signature(), raw, rawHash: sha(Buffer.from(raw, 'base64')), blockhash: base58Encode(randomBytes(32)), lastValidBlockHeight: 5000, preparedSlot: 100, createdAt: Date.now(), ...fields }; }
const vanityKey = () => { const w = generateWallet(); return { address: w.address, b58: w.secret }; };

class FakeChain {
  constructor(world) { this.w = world; }
  async quoteLaunch({ devBuyLamports }) { return { tokens: BigInt(devBuyLamports) * 30000n, costLamports: BigInt(devBuyLamports), maxSolCost: BigInt(devBuyLamports), feeBps: 125n, slot: 10 }; }
  async prepareSolDeposit(args) { return this.prepareDeposit(args); }
  async priorityPrice() { return 100000; }
  async prepareDeposit({ sender, recipient, lamports, memo }) { const unsignedRaw = Buffer.from(`unsigned:${sender}:${lamports}:${randomBytes(4).toString('hex')}`).toString('base64'); return { kind: 'deposit', needsSignature: true, state: 'awaiting_signature', externalSigner: sender, recipient, inputAmount: String(lamports), memo, unsignedRaw, messageHash: sha(unsignedRaw), blockhash: base58Encode(randomBytes(32)), lastValidBlockHeight: 5000, preparedSlot: 100, createdAt: Date.now() }; }
  async acceptSigned(op) { const { unsignedRaw, messageHash, ...rest } = op; return { ...rest, needsSignature: false, state: 'pending', signature: signature(), raw: Buffer.from('signed:' + unsignedRaw).toString('base64') }; }
  async broadcastSaved(op) { this.w.broadcasts.push(op.signature); }
  async broadcast(op) { this.w.broadcasts.push(op.signature); }
  async savedState(op) { return this.w.status.get(op.signature) || { state: 'pending' }; }
  async state(op) { return this.savedState(op); }
  async depositReceipt({ signature: sig }) { return this.w.deposits.get(sig) ?? null; }
  async prepareLaunch({ plan, signers }) {
    // The coin is created with the key of the address in the plan, whichever it is.
    assert.equal(signers.mint.address, plan.mint); assert.equal(base58Encode(base58Decode(signers.mint.secret).subarray(32)), plan.mint);
    this.w.created.push(plan.mint);
    return signedOp({ kind: 'launch', version: 1, wallet: plan.launchWallet, mint: plan.mint, expected: { tokens: String(plan.tokens), transfers: plan.transfers, shareholders: plan.shareholders } });
  }
  async launchReceipt(op) { return this.w.receipts.get(op.signature) ?? null; }
  async verifyCoinSetup() { return { ok: true, coin: null }; }
  async readCoin() { return { exists: false }; }
  async walletBalances(addresses) { return { slot: 1, balances: Object.fromEntries(addresses.map(a => [a, 0n])) }; }
  async signaturesFor() { return { rows: [], complete: true }; }
  async close() {}
}
function harness({ keys = [], onChain = null, pool: custom = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pump-vanity-')), docs = new Map(), world = { broadcasts: [], deposits: new Map(), status: new Map(), receipts: new Map(), created: [] };
  let clock = Date.UTC(2026, 9, 3, 12);
  const accounts = { dir, hostStore: { async read(name, fallback) { return docs.has(name) ? structuredClone(docs.get(name)) : fallback; }, async write(name, value) { docs.set(name, structuredClone(value)); } }, async get(id) { return id === 'admin' ? { id, role: 'admin', mfaEnabled: true } : null; } };
  const pool = custom || new VanityMintPool({ accounts, onChain, now: () => clock }), metadata = [];
  const agent = { version: 1, mode: AGENT_MODE, id: 'a'.repeat(24), wallet: generateWallet().address, policyHash: 'b'.repeat(64), policyVersion: 1, capabilities: 1, model: 'openai/gpt-4o' };
  const service = new PumpClassicService({ accounts, vanity: pool, chainFactory: async () => new FakeChain(world), publishMetadata: async args => { metadata.push(args.mint); return `https://launch.example/token-metadata/${args.mint}.json`; }, gotchiTarget: async () => null, agentTarget: async () => agent, protocolRecipient: async () => null, config: { enabled: true, dbPath: join(dir, 'pc.sqlite'), backupDir: join(dir, 'backups') }, now: () => clock });
  const dev = generateWallet().address, session = { account: { id: 'acct-1', mainWallet: dev }, walletVerified: true, walletAddress: dev };
  const h = { service, pool, docs, world, metadata, dev, session, advance: ms => { clock += ms; }, cleanup: async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); } };
  h.ready = (async () => { await service.ensure(); service.store().setFlag('intake', true, { reason: 'test' }); if (keys.length && !custom) await pool.importKeys({ actorId: 'admin', entries: [{ name: 'keys', text: keys.map(k => k.b58).join('\n') }], scope: keys.scope || 'all' }); })();
  return h;
}
const body = (overrides = {}) => ({ requestKey: randomBytes(12).toString('hex'), mode: 'creator', name: 'Vanity Signal', symbol: 'vane', description: 'A vanity coin', image: '/token-images/' + 'c'.repeat(64) + '.png', devBuySol: '0.01', ...overrides });
async function pass(h, times = 1) { for (let i = 0; i < times; i++) { await h.service.process(); h.advance(11000); } }
/** Quotes and submits the funding; the submission wakes the worker, whose pass (awaited here) switches the vanity address in before the funding settles. */
async function quoteAndSubmit(h, overrides) {
  const quote = await h.service.quote(h.session, { ...body(overrides), wallet: h.dev }), quoted = h.service.store().launch(quote.id).mint;
  const prepared = await h.service.prepareFunding(h.session, { launchId: quote.id });
  await h.service.submitFunding(h.session, { launchId: quote.id, operationId: prepared.operationId, signedTransaction: 'signed-by-wallet' });
  await h.service.running; h.advance(11000);
  const op = h.service.store().operationsFor(quote.id, 'funding').find(o => o.state === 'submitted');
  return { quote, quoted, prepared, op, fund: () => h.world.deposits.set(op.signature, { state: 'finalized', signature: op.signature, slot: 50, receivedAmount: prepared.amountLamports }) };
}

test('a funded Pump.fun launch is created at the next vanity address; quotes and fundings that never settle use none', async () => {
  const [pumpKey, anyKey] = [vanityKey(), vanityKey()], h = harness({ keys: [anyKey] });
  try {
    await h.ready; await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'pump', text: pumpKey.b58 }], scope: 'pump' });
    const abandoned = await h.service.quote(h.session, { ...body(), wallet: h.dev });
    h.advance(11 * 60000); await pass(h);
    assert.equal(h.service.store().launch(abandoned.id).state, 'expired');
    const failed = await quoteAndSubmit(h);
    h.world.deposits.set(failed.op.signature, { state: 'failed', signature: failed.op.signature, slot: 50, receivedAmount: '0' }); await pass(h);
    assert.equal(h.service.store().launch(failed.quote.id).state, 'awaiting_funding', 'a failed funding goes back to waiting');
    assert.equal(h.service.store().launch(failed.quote.id).mint, failed.quoted);
    assert.equal((await h.pool.view('admin')).counts.available, 2, 'neither an unfunded quote nor a failed funding takes an address');
    const { quote, quoted, fund } = await quoteAndSubmit(h);
    assert.notEqual(quoted, pumpKey.address);
    assert.deepEqual([h.service.store().launch(quote.id).state, h.service.store().launch(quote.id).mint], ['funding_pending', quoted], 'the quoted address stays until the funding is final');
    fund(); await pass(h);
    const launch = h.service.store().launch(quote.id);
    assert.equal(launch.state, 'creating'); assert.equal(launch.mint, pumpKey.address, 'the Pump.fun address first'); assert.equal(launch.metadata_uri, `https://launch.example/token-metadata/${pumpKey.address}.json`);
    assert.deepEqual(h.world.created, [pumpKey.address], 'the coin is created at the vanity address with its key');
    assert.ok(h.metadata.includes(pumpKey.address), 'its metadata is published at the vanity address');
    const doc = h.docs.get('pump-classic-keys-' + quote.id);
    assert.deepEqual([doc.mint.address, doc.randomMint.address, doc.vanity.state], [pumpKey.address, quoted, 'assigned']);
    const view = await h.pool.view('admin');
    assert.deepEqual(view.used.map(r => [r.address, r.venue, r.symbol]), [[pumpKey.address, 'pump', 'VANE']]);
    assert.equal(view.counts.available, 1); assert.equal(JSON.stringify(await h.service.adminOverview('admin')).includes(pumpKey.b58), false, 'admin views never carry the key');
    assert.ok(h.service.store().events(quote.id, { publicOnly: false, limit: 20 }).some(e => e.kind === 'vanity'));
    assert.ok(!h.service.store().events(quote.id, { publicOnly: true, limit: 20 }).some(e => e.kind === 'vanity'), 'the switch is an owner-only event');
    assert.equal((await h.service.keys(launch)).mint.address, pumpKey.address);
  } finally { await h.cleanup(); }
});

test('a pool that was never stocked is never written; a failing pool never holds up a launch; an emptied pool counts the fallback', async () => {
  const h = harness();
  try {
    await h.ready;
    const { quote, quoted, fund } = await quoteAndSubmit(h);
    fund(); await pass(h);
    assert.equal(h.service.store().launch(quote.id).state, 'creating'); assert.deepEqual(h.world.created, [quoted], 'no address: the quoted one');
    assert.equal(h.docs.get('pump-classic-keys-' + quote.id).vanity.state, 'none');
    assert.equal(h.docs.has('vanity-pool'), false, 'nothing is written for a pool that was never stocked');
    const key = vanityKey(); await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'k', text: key.b58 }] });
    const first = await quoteAndSubmit(h); first.fund(); await pass(h);
    const second = await quoteAndSubmit(h); second.fund(); await pass(h);
    assert.deepEqual(h.world.created, [quoted, key.address, second.quoted]);
    const view = await h.pool.view('admin');
    assert.deepEqual([view.fallbacks.total, view.fallbacks.lastVenue], [1, 'pump'], 'the launch that found the pool empty is counted once');
  } finally { await h.cleanup(); }
  const broken = { reserve: async () => { throw Error('pool storage unavailable'); }, release: async () => false, claim: async () => false, commit: async () => { throw Error('no'); }, noteFallback: async () => false };
  const b = harness({ pool: broken });
  try {
    await b.ready;
    const { quote, quoted, fund } = await quoteAndSubmit(b);
    fund(); await pass(b);
    assert.equal(b.service.store().launch(quote.id).state, 'creating', 'a pool error before anything was switched never blocks the funding');
    assert.deepEqual(b.world.created, [quoted]);
    assert.ok(b.service.store().events(quote.id, { publicOnly: false, limit: 20 }).some(e => e.title === 'Vanity address not settled'));
  } finally { await b.cleanup(); }
});

test('a switch interrupted by a restart resumes; an address taken meanwhile falls back to the quoted one', async () => {
  const [first, second] = [vanityKey(), vanityKey()], h = harness({ keys: [first, second] });
  try {
    await h.ready;
    // The process stops after the key is stored with the launch, before the pool records the address as used.
    const commit = h.pool.commit.bind(h.pool); let failures = 1;
    h.pool.commit = async args => { if (failures > 0) { failures--; throw Error('process stopped'); } return commit(args); };
    const a = await quoteAndSubmit(h);
    a.fund(); await pass(h);
    let launch = h.service.store().launch(a.quote.id);
    assert.deepEqual([launch.state, launch.mint, h.docs.get('pump-classic-keys-' + a.quote.id).vanity.state], ['funding_pending', a.quoted, 'pending'], 'half-switched: the funding waits and the launch keeps its quoted address');
    assert.equal((await h.service.keys(launch)).mint.address, a.quoted, 'the keys still resolve to the address on the launch row');
    assert.deepEqual(await h.service.agentLaunches(), []);
    await pass(h);
    launch = h.service.store().launch(a.quote.id);
    assert.deepEqual([launch.state, launch.mint, h.docs.get('pump-classic-keys-' + a.quote.id).vanity.state], ['creating', first.address, 'assigned'], 'resumed, then funded and created at the vanity address');
    assert.deepEqual(h.world.created, [first.address]);
    // The next launch's lease runs out while the process is down and another launch takes the address.
    failures = 1;
    const b = await quoteAndSubmit(h); b.fund(); await pass(h);
    assert.deepEqual([h.docs.get('pump-classic-keys-' + b.quote.id).vanity.address, h.docs.get('pump-classic-keys-' + b.quote.id).vanity.state], [second.address, 'pending']);
    h.advance(VANITY_LIMITS.leaseMs + 1);
    assert.equal((await h.pool.reserve({ venue: 'raydium', ref: 'review-elsewhere' })).address, second.address, 'the expired lease went back to the pool and another launch took it');
    await pass(h);
    launch = h.service.store().launch(b.quote.id);
    const doc = h.docs.get('pump-classic-keys-' + b.quote.id);
    assert.deepEqual([launch.state, launch.mint, doc.mint.address, doc.randomMint, doc.vanity.state], ['creating', b.quoted, b.quoted, undefined, 'failed'], 'the launch keeps its quoted address');
    assert.deepEqual(h.world.created, [first.address, b.quoted]);
  } finally { await h.cleanup(); }
});

test('a metadata file left by an attempt that gave its address back does not block the address', async () => {
  const key = vanityKey(), h = harness({ keys: [key] });
  try {
    await h.ready;
    const files = new Map(); h.service.publishMetadata = async args => { const text = JSON.stringify([args.name, args.symbol]); if (files.has(args.mint) && files.get(args.mint) !== text && args.replace !== true) throw Error('This mint already has different published metadata.'); files.set(args.mint, text); return `https://launch.example/token-metadata/${args.mint}.json`; };
    files.set(key.address, JSON.stringify(['Someone Else', 'ELSE']));
    const { quote, fund } = await quoteAndSubmit(h); fund(); await pass(h);
    assert.equal(h.service.store().launch(quote.id).mint, key.address); assert.equal(files.get(key.address), JSON.stringify(['Vanity Signal', 'VANE']));
  } finally { await h.cleanup(); }
});

test('AI Agent launches are listed to agents only once funded, with their final address', async () => {
  const key = vanityKey(), h = harness({ keys: [key] });
  try {
    await h.ready;
    const { quote, quoted, fund } = await quoteAndSubmit(h, { mode: 'agent', agent: { mission: 'Grow the community', model: 'openai/gpt-4o' } });
    assert.equal(h.service.store().launch(quote.id).mint, quoted);
    assert.deepEqual(await h.service.agentLaunches(), [], 'an unfunded agent launch is not listed (its address can still change)');
    fund(); await pass(h);
    const rows = await h.service.agentLaunches();
    assert.deepEqual(rows.map(r => [r.launchId, r.mint]), [[quote.id, key.address]]);
  } finally { await h.cleanup(); }
});

test('a vanity address whose launch ended without creating its coin returns to the pool after a day without activity', async () => {
  const [first, second] = [vanityKey(), vanityKey()], taken = new Set(), h = harness({ keys: Object.assign([first, second], { scope: 'pump' }), onChain: async addresses => addresses.map(a => taken.has(a)) });
  try {
    await h.ready; const store = h.service.store();
    // Two launches get the two addresses; neither coin is created and both launches fail.
    const a = await quoteAndSubmit(h), b = await quoteAndSubmit(h);
    store.setFlag('intake', false, { reason: 'test' }); // funded, but not created
    a.fund(); b.fund(); await pass(h);
    const [la, lb] = [store.launch(a.quote.id), store.launch(b.quote.id)];
    assert.deepEqual([la.state, lb.state], ['funded', 'funded']);
    assert.deepEqual(new Set([la.mint, lb.mint]), new Set([first.address, second.address]), 'both launches carry vanity addresses');
    for (const l of [la, lb]) h.service.failLaunch(store.launch(l.id), 'funded', 'Test failure');
    store.setFlag('intake', true, { reason: 'test' });
    assert.deepEqual([store.launch(la.id).state, store.launch(lb.id).state], ['failed', 'failed']);
    taken.add(lb.mint); // b's address holds an account onchain (say, created elsewhere): it is never handed out again.
    h.advance(23 * 3600000); await pass(h);
    assert.equal(store.launch(la.id).mint, la.mint, 'nothing is returned within a day of the launch’s last activity');
    h.advance(3600000 + 600000); await pass(h);
    // a's address is back in the pool with its key; the launch shows its own quoted address again.
    const back = store.launch(la.id);
    assert.equal(back.mint, a.quoted); assert.equal(back.metadata_uri, `https://launch.example/token-metadata/${a.quoted}.json`);
    const view = await h.pool.view('admin');
    assert.ok(view.pool.some(k => k.address === la.mint && k.state === 'available'), 'available again');
    assert.ok(view.used.some(k => k.address === lb.mint), 'an address that exists onchain stays used');
    assert.ok(view.events.some(e => e.kind === 'returned' && e.text.includes(la.mint)));
    const keys = h.docs.get('pump-classic-keys-' + la.id);
    assert.deepEqual([keys.mint.address, keys.vanity.state, keys.returning, keys.randomMint], [a.quoted, 'returned', undefined, undefined], 'the launch keeps only its own quoted key');
    assert.ok(store.events(la.id, { publicOnly: false }).some(e => e.title === 'Vanity address returned to the pool'));
    assert.ok(store.events(lb.id, { publicOnly: false }).some(e => e.title === 'Vanity address kept'));
    // The next launch gets the returned address and creates its coin with the restored key (the fake chain checks the signer).
    const c = await quoteAndSubmit(h); c.fund(); await pass(h, 2);
    assert.equal(store.launch(c.quote.id).mint, la.mint); assert.ok(h.world.created.includes(la.mint), 'created with the returned key');
  } finally { await h.cleanup(); }
});

test('a vanity return interrupted between its steps finishes on the next check, and a created coin’s address is never returned', async () => {
  const key = vanityKey(), h = harness({ keys: [key] });
  try {
    await h.ready; const store = h.service.store();
    const a = await quoteAndSubmit(h); store.setFlag('intake', false, { reason: 'test' }); a.fund(); await pass(h);
    const launch = store.launch(a.quote.id); assert.deepEqual([launch.mint, launch.state], [key.address, 'funded']);
    h.service.failLaunch(store.launch(launch.id), 'funded', 'Test failure'); store.setFlag('intake', true, { reason: 'test' });
    // The first write of the launch keys fails after the row was switched back: the next check resumes without another day's wait.
    const hostStore = h.service.accounts.hostStore, write = hostStore.write.bind(hostStore); let failOnce = true;
    hostStore.write = async (name, value) => { if (failOnce && name === 'pump-classic-keys-' + launch.id && value.returning) { failOnce = false; throw Error('disk full'); } return write(name, value); };
    h.advance(25 * 3600000); await pass(h);
    assert.equal(store.launch(launch.id).mint, a.quoted, 'the row is already back on its quoted address');
    assert.ok((await h.pool.view('admin')).used.some(k => k.address === key.address), 'the pool still lists it as used');
    assert.ok(store.events(launch.id, { publicOnly: false }).some(e => e.title === 'Vanity address not returned to the pool'));
    // This time the pool takes it back but the launch keys' last write fails: the next check finishes from the pool's record.
    let failFinal = 2; // the pass's own attempt and its follow-up both fail
    hostStore.write = async (name, value) => { if (failFinal > 0 && name === 'pump-classic-keys-' + launch.id && value.vanity?.state === 'returned') { failFinal--; throw Error('disk full'); } return write(name, value); };
    h.advance(11 * 60000); await pass(h);
    assert.ok((await h.pool.view('admin')).pool.some(k => k.address === key.address && k.state === 'available'), 'the pool has it back');
    assert.ok(h.docs.get('pump-classic-keys-' + launch.id).returning, 'the launch keys still hold the parked key');
    h.advance(11 * 60000); await pass(h);
    const finished = h.docs.get('pump-classic-keys-' + launch.id);
    assert.deepEqual([finished.vanity.state, finished.returning], ['returned', undefined], 'finished on the next check');
    assert.deepEqual(await h.pool.returnedFor('pump'), [], 'and recorded as settled');
    // A coin that was created keeps its address for good.
    const key2 = vanityKey(); await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'k', text: key2.b58 }], scope: 'pump' });
    const live = await quoteAndSubmit(h); live.fund(); await pass(h, 2);
    const coin = store.launch(live.quote.id);
    const op = store.operationsFor(coin.id, 'launch').at(-1); h.world.receipts.set(op.signature, { state: 'confirmed', signature: op.signature, slot: 60, tokens: op.expected.op.expected.tokens, feeLamports: 24000n, failed: false });
    await pass(h); assert.equal(store.launch(coin.id).state, 'created');
    h.advance(48 * 3600000); await pass(h, 2);
    assert.equal(store.launch(coin.id).mint, coin.mint); assert.ok((await h.pool.view('admin')).used.some(k => k.address === coin.mint));
  } finally { await h.cleanup(); }
});

test('an AI Agent launch keeps its vanity address: its agent is bound to it', async () => {
  const key = vanityKey(), h = harness({ keys: [key] });
  try {
    await h.ready; const store = h.service.store();
    const a = await quoteAndSubmit(h, { mode: 'agent', agent: { mission: 'Grow the community', model: 'openai/gpt-4o' } }); store.setFlag('intake', false, { reason: 'test' }); a.fund(); await pass(h);
    const launch = store.launch(a.quote.id); assert.deepEqual([launch.mint, launch.state, launch.mode], [key.address, 'funded', 'agent']);
    h.service.failLaunch(launch, 'funded', 'Test failure');
    h.advance(48 * 3600000); await pass(h, 2);
    assert.equal(store.launch(launch.id).mint, key.address); assert.ok((await h.pool.view('admin')).used.some(k => k.address === key.address));
  } finally { await h.cleanup(); }
});
