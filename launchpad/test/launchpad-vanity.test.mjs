// Vanity contract addresses on Raydium launches (v71.20): a launch review
// leases the next vanity address (one per account) and uses its key as the
// coin's mint without revealing it; the created draft keeps it on an hour's
// lease; the address is used up when the launch's first transaction is signed.
// Expired reviews and drafts that never sign give it back; at most two unsigned
// drafts per account hold addresses. Only the market preview, media storage and
// the wallet signature are local fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Launchpad } from '../src/launchpad.mjs';
import { SOL_MINT } from '../public/launchpad-model.mjs';
import { VanityMintPool } from '../src/vanity-pool.mjs';
import { generateWallet } from '../src/pump-classic/service.mjs';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=';
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'launch-vanity-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const values = new Map(), docs = new Map(), stores = new Map(), owner = generateWallet().address, treasury = generateWallet().address;
  let clock = Date.UTC(2026, 9, 3, 12);
  const accounts = {
    dir, hostStore: { read: async (key, fallback) => key === 'launch-protocol-fees' ? { recipient: treasury } : docs.has(key) ? structuredClone(docs.get(key)) : fallback, write: async (key, value) => { docs.set(key, structuredClone(value)); } },
    get: async id => id === 'admin' ? { id, role: 'admin', mfaEnabled: true } : { id, mainWallet: owner },
    storeFor: id => { if (!stores.has(id)) stores.set(id, { dir: join(dir, id), read: async (key, fallback) => structuredClone(values.get(id + ':' + key) ?? fallback), write: async (key, value) => values.set(id + ':' + key, structuredClone(value)) }); return stores.get(id); },
  };
  const pool = new VanityMintPool({ accounts, now: () => clock });
  const minted = [];
  const chain = { preview: async input => ({ platformFeeBps: 100, protocolFees: structuredClone(input.protocolFees), creatorFeeRatePpm: 2500, quoteProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', quoteDecimals: 9, price: { usd: '100' }, minimumSol: '0.06', platformRent: '15000000', serviceReserve: '0', devBuy: { gross: '0', net: '0', solBudget: '0' } }), close: () => {},
    acceptSigned: async op => ({ signature: '5'.repeat(88), raw: 'c2lnbmVk', needsSignature: false, state: 'pending' }), broadcast: async () => {} };
  const manager = new Launchpad(accounts, null, { now: () => clock, chainFactory: () => chain, metadataStorage: { prepare: async (input, keys) => { minted.push(keys.mint.address); return { uri: 'https://gateway.irys.xyz/' + 'a'.repeat(43), imageUrl: 'https://gateway.irys.xyz/' + 'b'.repeat(43), metadata: { mint: keys.mint.address }, storage: { provider: 'irys', budget: '0', items: [] } }; }, upload: async () => true } });
  manager.kick = () => {}; manager.vanity = pool; t.after(() => manager.close());
  const image = await manager.uploadImage('acct', PNG);
  const input = (extra = {}) => ({ name: 'Vanity launch', symbol: 'VANE', quoteMint: SOL_MINT, feeMode: 'creator', walletMode: 'external', externalWallet: owner, devBuySol: '0', imageId: image.imageId, ...extra });
  const keys = (n, scope = 'all') => pool.importKeys({ actorId: 'admin', entries: [{ name: 'k', text: Array.from({ length: n }, () => generateWallet()).map(w => (keys.made.push(w), w.secret)).join('\n') }], scope });
  keys.made = [];
  // The launch's first wallet request, as the launch action would leave it; signing it goes through Launchpad.sign.
  const firstSignature = async (account, launchId) => {
    const book = values.get(account + ':launchpad'), l = book.launches.find(x => x.id === launchId);
    l.authorizedAt = clock; l.state = 'awaiting_signature'; l.operations.push({ operationId: 'op-' + launchId, kind: 'setup', state: 'awaiting_signature', needsSignature: true, unsignedRaw: 'AA==', messageHash: 'h' });
    values.set(account + ':launchpad', book);
    return manager.sign(account, launchId, 'op-' + launchId, 'signed-by-wallet');
  };
  return { manager, pool, input, keys, minted, values, firstSignature, advance: ms => { clock += ms; } };
}

test('a Raydium review holds the next vanity address; the created launch uses it up at its first signature', async t => {
  const h = await setup(t);
  await h.keys(1); await h.keys(1, 'raydium');
  const [anyKey, rayKey] = h.keys.made;
  const review = await h.manager.prepare('acct', h.input());
  assert.equal(review.mint, null, 'the review does not reveal the address: unused pool addresses stay private');
  assert.deepEqual(h.minted, [rayKey.address], 'the Raydium address first; its metadata is prepared for it');
  const launch = await h.manager.create('acct', { ...h.input(), prepareId: review.prepareId });
  assert.equal(launch.mint, rayKey.address);
  const saved = h.values.get('acct:launchpad').launches.find(l => l.id === launch.id);
  assert.deepEqual(saved.keys.mint, { address: rayKey.address, secret: rayKey.secret }, 'the launch keeps the vanity key to sign the coin’s creation');
  assert.deepEqual({ ...saved.vanity, heldAt: undefined }, { address: rayKey.address, committed: false, heldAt: undefined });
  let view = await h.pool.view('admin');
  assert.deepEqual([view.counts.reserved, view.used.length], [1, 0], 'the draft holds the address until it signs');
  await h.firstSignature('acct', launch.id);
  view = await h.pool.view('admin');
  assert.deepEqual(view.used.map(r => [r.address, r.venue, r.symbol]), [[rayKey.address, 'raydium', 'VANE']], 'used up at the first signature');
  assert.deepEqual(view.pool.map(r => r.address), [anyKey.address]);
  assert.equal(h.values.get('acct:launchpad').launches.find(l => l.id === launch.id).vanity.committed, true);
});

test('one held address per account; expired reviews and lapsed drafts give it back; a lapsed draft that lost it cannot sign', async t => {
  const h = await setup(t);
  await h.keys(1);
  const [key] = h.keys.made;
  const first = await h.manager.prepare('acct', h.input());
  assert.deepEqual(h.minted, [key.address]);
  const second = await h.manager.prepare('acct', h.input({ name: 'Another launch' }));
  assert.deepEqual(h.minted, [key.address, key.address], 'editing the form moves the account’s one address to the newer review');
  const back = await h.manager.prepare('acct', h.input());
  assert.equal(back.prepareId, first.prepareId, 'undoing the edit returns the cached review, which takes the address back');
  const image2 = (await h.manager.uploadImage('acct-2', PNG)).imageId;
  const other = await h.manager.prepare('acct-2', h.input({ name: 'Someone else', imageId: image2 }));
  assert.notEqual(other.mint, null, 'another account finds no address left: a random mint, shown');
  const draft = await h.manager.create('acct', { ...h.input(), prepareId: first.prepareId });
  assert.equal(draft.mint, key.address, 'the review that holds the address creates its launch');
  h.advance(61 * 60000);
  const third = await h.manager.prepare('acct-2', h.input({ name: 'Third launch', imageId: image2 }));
  assert.equal(h.minted.at(-1), key.address, 'the draft never signed: its lease lapsed and another review took the address');
  await assert.rejects(h.firstSignature('acct', draft.id), /no longer available/);
  const created = await h.manager.create('acct-2', { ...h.input({ name: 'Third launch', imageId: image2 }), prepareId: third.prepareId });
  await h.firstSignature('acct-2', created.id);
  assert.deepEqual((await h.pool.view('admin')).used.map(r => [r.address, r.symbol]), [[key.address, 'VANE']]);
  const othersDraft = await h.manager.create('acct-2', { ...h.input({ name: 'Someone else', imageId: image2 }), prepareId: (await h.manager.prepare('acct-2', h.input({ name: 'Someone else', imageId: image2 }))).prepareId });
  await h.firstSignature('acct-2', othersDraft.id);
  assert.equal((await h.pool.view('admin')).fallbacks.total, 1, 'a launch that found no address is reported once it signs');
});

test('an account holds at most two addresses in unsigned drafts', async t => {
  const h = await setup(t);
  await h.keys(4);
  const ids = [];
  for (const name of ['One', 'Two', 'Three']) { const review = await h.manager.prepare('acct', h.input({ name })); ids.push((await h.manager.create('acct', { ...h.input({ name }), prepareId: review.prepareId })).mint); }
  const made = new Set(h.keys.made.map(k => k.address));
  assert.deepEqual(ids.map(mint => made.has(mint)), [true, true, false], 'the third unsigned draft launches on a random address');
  assert.equal((await h.pool.view('admin')).fallbacks.total, 0, 'that is not counted as an empty pool');
});

test('refreshing a draft renews its address, or stops when another launch took it', async t => {
  const h = await setup(t);
  await h.keys(1);
  const [key] = h.keys.made;
  const review = await h.manager.prepare('acct', h.input());
  const draft = await h.manager.create('acct', { ...h.input(), prepareId: review.prepareId });
  h.advance(50 * 60000);
  await h.manager.refresh('acct', draft.id);
  h.advance(50 * 60000);
  assert.equal((await h.pool.view('admin')).counts.reserved, 1, 'still held: the refresh renewed the hour');
  h.advance(11 * 60000);
  const image2 = (await h.manager.uploadImage('acct-2', PNG)).imageId;
  await h.manager.prepare('acct-2', h.input({ name: 'Other', imageId: image2 }));
  assert.equal(h.minted.at(-1), key.address, 'the lapsed address went to another review');
  await assert.rejects(h.manager.refresh('acct', draft.id), /no longer available/);
});
