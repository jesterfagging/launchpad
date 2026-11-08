// Vanity contract addresses on Meteora launches (v71.20), through the service's
// own prepare/submit logic with the transaction encoding stubbed (the full
// flow with real transactions is in meteora-service.test.mjs): a new draft holds
// the next address on a lease and publishes its metadata there; the address is
// used up only when the draft's first transaction is signed; a preparation that
// fails gives it back; a draft that waited past its lease asks for a new launch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeteoraService } from '../src/meteora-service.mjs';
import { VanityMintPool, VANITY_LIMITS } from '../src/vanity-pool.mjs';
import { generateWallet } from '../src/pump-classic/service.mjs';

const SOL = 'So11111111111111111111111111111111111111112';
async function fixture(t, { keys = 1 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'meteora-vanity-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = Date.UTC(2026, 9, 3, 12);
  const authority = generateWallet(), treasury = generateWallet().address, user = generateWallet().address, docs = new Map(), metadata = [];
  docs.set('meteora-launches', { schemaVersion: 1, enabled: true, config: { authority: authority.address, treasury, migrationFeePercentage: 0 }, authority: { address: authority.address, secretBase64: 'x' }, launches: [], operations: [], cursor: 0 });
  const accounts = { dir, get: async id => ({ id, role: 'admin', mfaEnabled: true }), list: async () => [], hostStore: { read: async (key, fallback) => docs.has(key) ? structuredClone(docs.get(key)) : structuredClone(fallback), write: async (key, value) => { docs.set(key, structuredClone(value)); } } };
  const pool = new VanityMintPool({ accounts, now: () => clock }), made = Array.from({ length: keys }, () => generateWallet());
  if (made.length) await pool.importKeys({ actorId: 'admin', entries: [{ name: 'k', text: made.map(k => k.secret).join('\n') }], scope: 'meteora' });
  const adapter = { failPrepare: null, prepareLaunch: async ({ wallet, launch }) => { if (adapter.failPrepare) throw adapter.failPrepare; return { action: launch.configSignature ? 'initialize' : 'configure', unsignedTransaction: 'AA==', lastValidBlockHeight: 100, requiredSigners: [wallet], review: {} }; }, send: async () => 'sig' };
  const service = new MeteoraService({ accounts, adapter, requireOwner: async () => {}, getQuotePrice: async mint => ({ mint, usd: '100', at: clock }), getTreasury: async () => treasury, getCreationFee: async () => ({ lamports: '15000000', recipient: treasury }), publishMetadata: async args => { metadata.push(args); return `https://launch.example/token-metadata/${args.mint}.json`; }, quoteEligibility: async mint => ({ mint, symbol: 'SOL', decimals: 9, launchReady: true }), now: () => clock, verifyWalletTransaction: () => ({ message: { serialize: () => Buffer.from('signed') } }) });
  service.closed = true; service.vanity = pool;
  // Transaction encoding and the network are outside this test.
  Object.assign(service, { binding: async data => data.config, validateBundle: () => ({ message: { serialize: () => Buffer.from('message') } }), verifyWalletChange: async () => {}, sign: () => ({ signedTransaction: 'c2lnbmVk', signature: '5'.repeat(88) }), broadcast: async op => ({ operation: { id: op.id } }) });
  const session = { account: { id: 'alice' }, walletVerified: true, walletAddress: user }, context = { sessionToken: 'alice-session', authorize: async () => session };
  const input = { action: 'initialize', expectedWallet: user, quoteMint: SOL, name: 'Meteora Vanity', symbol: 'MV', feeMode: 'creator' };
  const read = () => docs.get('meteora-launches');
  return { service, pool, made, adapter, session, context, input, read, metadata, user, advance: ms => { clock += ms; } };
}

test('a Meteora draft holds its vanity address until its first transaction is signed; a failed preparation gives it back', async t => {
  const f = await fixture(t), [key] = f.made;
  f.adapter.failPrepare = Object.assign(Error('The adapter is unavailable.'), { statusCode: 503 });
  await assert.rejects(f.service.prepare(f.session, f.input, f.context), /adapter is unavailable/);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual([(await f.pool.view('admin')).counts.available, f.read().launches.length], [1, 0], 'the address is back and no draft was saved');
  f.adapter.failPrepare = null;
  const prepared = await f.service.prepare(f.session, f.input, f.context);
  assert.equal(prepared.launch.mint, key.address);
  assert.equal(f.metadata.at(-1).mint, key.address); assert.equal(f.metadata.at(-1).replace, true, 'a stale file for a leased address is replaced');
  const draft = f.read().launches[0]; assert.deepEqual({ ...draft.vanity, heldAt: undefined }, { address: key.address, committed: false, heldAt: undefined });
  let view = await f.pool.view('admin'); assert.deepEqual([view.counts.reserved, view.used.length], [1, 0], 'held, not used, until something is signed');
  assert.equal(view.pool[0].until - Date.UTC(2026, 9, 3, 12), VANITY_LIMITS.draftLeaseMs, 'a draft holds its address for an hour');
  await f.service.submit(f.session, { operationId: prepared.operation.id, signedTransaction: 'c2lnbmVk' }, f.context);
  view = await f.pool.view('admin'); assert.deepEqual(view.used.map(r => [r.address, r.venue, r.symbol]), [[key.address, 'meteora', 'MV']], 'used once the first transaction is signed');
  assert.equal(f.read().launches[0].vanity.committed, true);
  assert.equal(f.read().operations.at(-1).state, 'journaled');
});

test('a Meteora draft that waited past its lease asks for a new launch; an empty pool is reported once the launch signs', async t => {
  const f = await fixture(t), [key] = f.made;
  const prepared = await f.service.prepare(f.session, f.input, f.context);
  await f.service.cancel(f.session, { operationId: prepared.operation.id }, f.context);
  f.advance(VANITY_LIMITS.draftLeaseMs + 1);
  const resumedOk = await f.service.prepare(f.session, { action: 'initialize', expectedWallet: f.user, mint: key.address }, f.context);
  assert.equal(resumedOk.launch.mint, key.address, 'an expired lease nobody took is renewed when the draft resumes');
  assert.equal(f.metadata.at(-1).replace, true, 'and its metadata is restored');
  await f.service.cancel(f.session, { operationId: resumedOk.operation.id }, f.context);
  f.advance(VANITY_LIMITS.draftLeaseMs + 1);
  assert.equal((await f.pool.reserve({ venue: 'meteora', ref: 'another-draft-0001' })).address, key.address, 'another launch takes the lapsed address');
  await assert.rejects(f.service.prepare(f.session, { action: 'initialize', expectedWallet: f.user, mint: key.address }, f.context), /no longer available/);
  const second = await f.service.prepare(f.session, { ...f.input, name: 'No vanity left' }, f.context);
  assert.notEqual(second.launch.mint, key.address); assert.deepEqual(f.read().launches.at(-1).vanity, { missed: true });
  await f.service.submit(f.session, { operationId: second.operation.id, signedTransaction: 'c2lnbmVk' }, f.context);
  assert.equal((await f.pool.view('admin')).fallbacks.total, 1, 'the launch that found no address is reported when it signs');
});

test('a Meteora account holds at most two unsigned vanity drafts; an abandoned draft is retired when its address moves', async t => {
  const f = await fixture(t, { keys: 4 });
  const mints = [];
  for (const name of ['One', 'Two', 'Three']) { const prepared = await f.service.prepare(f.session, { ...f.input, name }, f.context); mints.push(prepared.launch.mint); await f.service.cancel(f.session, { operationId: prepared.operation.id }, f.context); }
  const made = new Set(f.made.map(k => k.address));
  assert.deepEqual(mints.map(m => made.has(m)), [true, true, false], 'the third unsigned draft uses a random address');
  assert.equal(f.read().launches.at(-1).vanity, undefined, 'and is not counted as an empty pool');
  // Both held drafts lapse. Their addresses go back to the pool; a new draft that takes one retires the abandoned draft.
  f.advance(VANITY_LIMITS.draftLeaseMs + 1);
  const other = { ...f.session, account: { id: 'bob' } }, otherContext = { sessionToken: 'bob-session', authorize: async () => other };
  const fresh = await f.service.prepare(other, { ...f.input, name: 'Bob' }, otherContext);
  assert.equal(fresh.launch.mint, mints[0], 'the oldest lapsed address is reused');
  assert.deepEqual(f.read().launches.map(l => l.name), ['Two', 'Three', 'Bob'], 'the abandoned draft that named it was retired');
  assert.equal(f.read().operations.some(o => o.mint === mints[0] && o.ownerId === 'alice'), false, 'with its unsigned requests');
  assert.equal(new Set(f.read().launches.map(l => l.mint)).size, f.read().launches.length, 'no two drafts share a mint');
  await assert.rejects(f.service.prepare(f.session, { action: 'initialize', expectedWallet: f.user, mint: mints[0] }, f.context), /cannot be resumed/, 'the address now belongs to the new draft');
});

test('an address an abandoned AI Agent draft named is never reused; a signed draft is never retired', async t => {
  const f = await fixture(t, { keys: 2 });
  const first = await f.service.prepare(f.session, f.input, f.context);
  await f.service.submit(f.session, { operationId: first.operation.id, signedTransaction: 'c2lnbmVk' }, f.context);
  f.pool.inUse = address => address === f.made[1].address;
  f.advance(VANITY_LIMITS.draftLeaseMs + 1);
  const bob = { ...f.session, account: { id: 'bob' } }, bobContext = { sessionToken: 'bob-session', authorize: async () => bob };
  const second = await f.service.prepare(bob, { ...f.input, name: 'Second' }, bobContext);
  assert.equal(made(f).has(second.launch.mint), false, 'the signed draft keeps its address; the agent-bound one is never handed out');
  assert.equal(f.read().launches.find(l => l.mint === f.made[0].address).vanity.committed, true);
});
function made(f) { return new Set(f.made.map(k => k.address)); }
