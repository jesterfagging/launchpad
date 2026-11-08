// Vanity contract addresses (v71.20): the pool of operator-supplied mint
// keypairs. Import formats and validation, encrypted storage, leases, commits,
// onchain checks, fallbacks, removal and the admin view. Dependency-free; real
// Ed25519 keys and the real encrypted host store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { TelegramStore } from '../src/telegram-store.mjs';
import { base58Encode } from '../src/pump-classic/codec.mjs';
import { VanityMintPool, parseVanityEntries, vanityKeyFromBytes, VANITY_LIMITS } from '../src/vanity-pool.mjs';

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32), pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32), bytes = Buffer.concat([seed, pub]);
  return { address: base58Encode(pub), bytes, json: JSON.stringify([...bytes]), b58: base58Encode(bytes) };
}
function harness({ onChain = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vanity-pool-')), store = new TelegramStore(dir, randomBytes(32), 'relay-accounts-host');
  let clock = Date.UTC(2026, 9, 3, 12);
  const accounts = { dir, hostStore: store, async get(id) { return id === 'admin' ? { id, role: 'admin', mfaEnabled: true } : id === 'user' ? { id, role: 'user', mfaEnabled: true } : null; } };
  const pool = new VanityMintPool({ accounts, onChain, now: () => clock });
  return { dir, store, pool, advance: ms => { clock += ms; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const secretsIn = (value, keys) => keys.filter(k => JSON.stringify(value).includes(k.b58) || JSON.stringify(value).includes(k.json.slice(1, 40)));

test('every accepted format is read; bad entries are rejected by source and line, never echoed', () => {
  const [a, b, c, d, e, f, g] = Array.from({ length: 7 }, keypair), other = keypair();
  const corrupt = Buffer.from(a.bytes); corrupt[40] ^= 1;
  const parsed = parseVanityEntries([
    { name: 'GrindA.json', text: a.json },                                     // solana-keygen file
    { name: 'batch.json', text: JSON.stringify([[...b.bytes], [...c.bytes]]) },   // array of keypairs
    { name: 'pasted', text: [`# my vanity keys`, d.b58, 'Public Key,Private Key', `address,private_key`, `${e.address},${e.b58}`, `${f.b58} ${f.address}`, `${g.address}`, `${other.address},${a.b58}`, 'not-a-key', base58Encode(corrupt)].join('\r\n') },
    { name: 'object.json', text: JSON.stringify({ publicKey: other.address, secretKey: [...other.bytes] }) },
    { name: 'empty.txt', text: '   ' },
  ]);
  assert.deepEqual(parsed.keys.map(k => k.address), [a.address, b.address, c.address, d.address, e.address, f.address, other.address]);
  assert.deepEqual(parsed.keys.map(k => k.where), ['GrindA.json', 'batch.json item 1', 'batch.json item 2', 'pasted line 2', 'pasted line 5', 'pasted line 6', 'object.json']);
  assert.ok(parsed.keys.every(k => typeof k.secret === 'string' && k.secret.length >= 86), 'secrets are normalised to base58 of the 64-byte key');
  assert.deepEqual(parsed.rejected.map(({ where, reason }) => ({ where, reason })), [
    { where: 'pasted line 7', reason: 'an address without its private key' },
    { where: 'pasted line 8', reason: 'the address next to it belongs to a different key' },
    { where: 'pasted line 9', reason: 'not a private key' },
    { where: 'pasted line 10', reason: 'the private key does not match its own public key' },
    { where: 'empty.txt', reason: 'empty' },
  ]);
  assert.equal(secretsIn(parsed.rejected, [a, b, c, d, e, f, g, other]).length, 0, 'rejections never carry key material');
  assert.equal(vanityKeyFromBytes(Buffer.alloc(32)).reason, 'not a 64-byte Solana private key', 'a 32-byte value is never taken as a key');
  assert.throws(() => parseVanityEntries([]), /Paste private keys/);
  const many = parseVanityEntries([{ name: 'big', text: Array.from({ length: 5 }, () => keypair().b58).join('\n') }], { max: 3 });
  assert.equal(many.keys.length, 3); assert.equal(many.truncated, true);
});

test('imports are encrypted at rest, deduplicated, admin-only, and the view never returns a key', async () => {
  const h = harness();
  try {
    const keys = Array.from({ length: 4 }, keypair);
    await assert.rejects(h.pool.importKeys({ actorId: 'user', entries: [{ name: 'k', text: keys[0].b58 }] }), /two-factor/);
    await assert.rejects(h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'k', text: keys[0].b58 }], scope: 'everything' }), /Choose which launches/);
    const first = await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'a.json', text: keys[0].json }, { name: 'pasted', text: [keys[1].b58, keys[2].b58, keys[1].b58].join('\n') }], scope: 'all' });
    assert.deepEqual(first.added, [keys[0].address, keys[1].address, keys[2].address]);
    assert.deepEqual(first.rejected, [{ where: 'pasted line 3', reason: 'listed twice in this import' }]);
    const second = await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'again', text: [keys[0].b58, keys[3].b58].join('\n') }], scope: 'pump' });
    assert.deepEqual(second.added, [keys[3].address]); assert.deepEqual(second.rejected, [{ where: 'again line 1', reason: 'already in the pool' }]);
    const files = readdirSync(h.dir).filter(n => n.endsWith('.enc')), raw = files.map(n => readFileSync(join(h.dir, n), 'utf8')).join('\n');
    assert.deepEqual(files.sort(), ['vanity-pool.enc', 'vanity-seen.enc'], 'the pool and the history of added addresses, both encrypted');
    for (const k of keys) { assert.ok(!raw.includes(k.b58) && !raw.includes(k.address), 'neither keys nor addresses are readable on disk'); }
    const view = await h.pool.view('admin');
    assert.equal(secretsIn(view, keys).length, 0); assert.equal(secretsIn(first, keys).length, 0); assert.equal(secretsIn(second, keys).length, 0);
    assert.deepEqual([view.counts.available, view.counts.byScope.all, view.counts.byScope.pump, view.counts.forVenue.pump, view.counts.forVenue.raydium], [4, 3, 1, 4, 3]);
    assert.deepEqual(view.pool.map(r => [r.address, r.scope]), [[keys[0].address, 'all'], [keys[1].address, 'all'], [keys[2].address, 'all'], [keys[3].address, 'pump']]);
    assert.deepEqual(view.low, ['pump', 'raydium', 'meteora'], 'fewer than ten addresses left is a warning');
    await assert.rejects(h.pool.view('user'), /two-factor/);
  } finally { h.cleanup(); }
});

test('launches lease, commit and release addresses: venue addresses first, oldest first, never twice', async () => {
  const h = harness();
  try {
    const [a, b, c] = [keypair(), keypair(), keypair()];
    await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'all', text: [a.b58, b.b58].join('\n') }] });
    h.advance(1000); await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'pump', text: c.b58 }], scope: 'pump' });
    const pump = await h.pool.reserve({ venue: 'pump', ref: 'launch-pump-1' });
    assert.deepEqual(pump, { address: c.address, secret: c.b58 }, 'the Pump.fun address first, with its key');
    assert.deepEqual(await h.pool.reserve({ venue: 'pump', ref: 'launch-pump-1' }), pump, 'asking again for the same launch returns the same address');
    const ray = await h.pool.reserve({ venue: 'raydium', ref: 'review-ray-1' }); assert.equal(ray.address, a.address, 'then the oldest address for every launch');
    const met = await h.pool.reserve({ venue: 'meteora', ref: 'draft-met-1' }); assert.equal(met.address, b.address);
    assert.equal(await h.pool.reserve({ venue: 'raydium', ref: 'review-ray-2' }), null, 'nothing left: the launch keeps its random address');
    assert.equal(await h.pool.noteFallback({ venue: 'raydium', ref: 'review-ray-2' }), true, 'the venue reports the fallback when that launch commits money');
    assert.equal(await h.pool.noteFallback({ venue: 'raydium', ref: 'review-ray-2' }), false, 'once per launch');
    let view = await h.pool.view('admin');
    assert.deepEqual([view.counts.available, view.counts.reserved, view.fallbacks.total, view.fallbacks.lastVenue], [0, 3, 1, 'raydium']);
    await assert.rejects(h.pool.commit({ venue: 'raydium', ref: 'review-ray-2', address: a.address }), /taken by another launch/);
    assert.equal(await h.pool.commit({ venue: 'pump', ref: 'launch-pump-1', address: c.address, launch: { name: 'Orbit', symbol: 'ORBIT', accountId: 'acct-1' } }), true);
    assert.equal(await h.pool.commit({ venue: 'pump', ref: 'launch-pump-1', address: c.address }), true, 'committing twice is a no-op');
    assert.equal(await h.pool.release({ venue: 'raydium', ref: 'someone-else', address: a.address }), false, 'only the holder can release');
    assert.equal(await h.pool.release({ venue: 'raydium', ref: 'review-ray-1', address: a.address }), true);
    assert.equal(await h.pool.release({ venue: 'pump', ref: 'launch-pump-1', address: c.address }), false, 'a used address never returns');
    h.advance(VANITY_LIMITS.leaseMs + 1);
    view = await h.pool.view('admin');
    assert.deepEqual([view.counts.available, view.counts.reserved, view.counts.used], [2, 0, 1], 'an expired lease returns to the pool');
    assert.deepEqual(view.used.map(r => [r.address, r.venue, r.symbol, r.state]), [[c.address, 'pump', 'ORBIT', 'used']]);
    const raw = await h.store.read('vanity-pool');
    assert.equal(raw.keys.find(k => k.address === c.address).secret, undefined, 'the pool forgets a used key');
    assert.equal(await h.pool.commit({ venue: 'meteora', ref: 'draft-met-1', address: b.address }), true, 'an expired lease nobody took can still be committed by its launch');
    assert.equal(await h.pool.claim({ venue: 'raydium', ref: 'review-ray-9', address: b.address }), false);
    assert.equal(await h.pool.claim({ venue: 'meteora', ref: 'draft-met-1', address: b.address }), true, 'claim: already used by this launch');
    assert.equal(await h.pool.claim({ venue: 'raydium', ref: 'review-ray-3', address: a.address }), true, 'claim: a free address is leased again');
    assert.equal(await h.pool.claim({ venue: 'raydium', ref: 'review-ray-4', address: a.address }), false, 'claim: held by another launch');
  } finally { h.cleanup(); }
});

test('concurrent launches never receive the same address', async () => {
  const h = harness();
  try {
    const keys = Array.from({ length: 6 }, keypair);
    await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'k', text: keys.map(k => k.b58).join('\n') }] });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => h.pool.reserve({ venue: ['pump', 'raydium', 'meteora'][i % 3], ref: 'launch-' + String(i).padStart(4, '0') })));
    const given = results.filter(Boolean).map(r => r.address);
    assert.equal(given.length, 6); assert.equal(new Set(given).size, 6); assert.equal(results.filter(r => r === null).length, 4);
    assert.equal((await h.pool.view('admin')).counts.reserved, 6);
  } finally { h.cleanup(); }
});

test('an address that already holds an account is skipped; an address that could not be checked is not handed out', async () => {
  const taken = new Set(), checked = [];
  let down = false;
  const h = harness({ onChain: async addresses => { checked.push(...addresses); if (down) throw Error('rpc down'); return addresses.map(a => taken.has(a)); } });
  try {
    const [a, b, c] = [keypair(), keypair(), keypair()];
    await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'k', text: [a.b58, b.b58, c.b58].join('\n') }] });
    taken.add(a.address);
    const first = await h.pool.reserve({ venue: 'pump', ref: 'launch-aaaa' });
    assert.equal(first.address, b.address, 'the address with an existing account was skipped');
    down = true;
    assert.equal(await h.pool.reserve({ venue: 'pump', ref: 'launch-bbbb' }), null, 'the chain cannot be asked: the launch keeps a random address');
    assert.equal((await h.pool.view('admin')).checks.failures, 1);
    down = false;
    const second = await h.pool.reserve({ venue: 'pump', ref: 'launch-bbbb' });
    assert.equal(second.address, c.address);
    await h.pool.commit({ venue: 'pump', ref: 'launch-aaaa', address: b.address, launch: { symbol: 'BEE' } });
    await h.pool.commit({ venue: 'pump', ref: 'launch-bbbb', address: c.address, launch: { symbol: 'SEA' } });
    taken.add(b.address);
    const view = await h.pool.view('admin');
    assert.deepEqual(view.used.map(r => [r.address, r.state, r.onChain ?? null]).sort(), [[a.address, 'skipped', null], [b.address, 'used', true], [c.address, 'used', false]].sort());
    assert.match(view.used.find(r => r.address === a.address).reason, /already exists/);
    assert.deepEqual([view.counts.used, view.counts.skipped], [2, 1]);
    assert.equal(typeof (await h.store.read('vanity-pool')).keys.find(k => k.address === a.address).secret, 'string', 'a skipped address keeps its key, set aside');
    const removed = await h.pool.remove({ actorId: 'admin', addresses: [a.address, b.address] });
    assert.deepEqual([removed.removed, removed.kept.map(k => k.reason)], [[a.address], ['already used']], 'an administrator can delete a skipped key; a used one stays');
  } finally { h.cleanup(); }
});

test('removing unused addresses: leased and used addresses stay; imports reset the fallback count', async () => {
  const h = harness();
  try {
    const [a, b, c] = [keypair(), keypair(), keypair()];
    await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'k', text: [a.b58, b.b58, c.b58].join('\n') }] });
    await h.pool.reserve({ venue: 'raydium', ref: 'review-1111' });
    const used = await h.pool.reserve({ venue: 'raydium', ref: 'review-2222' }); await h.pool.commit({ venue: 'raydium', ref: 'review-2222', address: used.address });
    await assert.rejects(h.pool.remove({ actorId: 'user', addresses: [c.address] }), /two-factor/);
    const result = await h.pool.remove({ actorId: 'admin', addresses: [a.address, b.address, c.address] });
    assert.deepEqual(result.removed, [c.address]);
    assert.deepEqual(result.kept.map(r => r.reason), ['a launch is using it right now; try again in a few minutes', 'already used']);
    assert.equal(await h.pool.reserve({ venue: 'pump', ref: 'launch-3333' }), null); await h.pool.noteFallback({ venue: 'pump', ref: 'launch-3333' });
    assert.equal((await h.pool.view('admin')).fallbacks.sinceImport, 1);
    await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'k', text: keypair().b58 }] });
    const view = await h.pool.view('admin');
    assert.deepEqual([view.fallbacks.total, view.fallbacks.sinceImport], [1, 0]);
    assert.ok(view.events.some(e => e.kind === 'remove') && view.events.some(e => e.kind === 'fallback'));
    await h.store.write('vanity-pool', { version: 2, keys: [], events: [] });
    await assert.rejects(h.pool.reserve({ venue: 'pump', ref: 'launch-4444' }), /newer release/, 'an unknown document version is never overwritten');
  } finally { h.cleanup(); }
});

test('a pool that was never stocked is never written and shows no warnings', async () => {
  const h = harness();
  try {
    assert.equal(await h.pool.reserve({ venue: 'pump', ref: 'launch-5555' }), null);
    assert.equal(await h.pool.noteFallback({ venue: 'pump', ref: 'launch-5555' }), false);
    assert.deepEqual(readdirSync(h.dir).filter(n => n.endsWith('.enc')), [], 'nothing was written');
    const view = await h.pool.view('admin');
    assert.deepEqual([view.stocked, view.low, view.fallbacks.total], [false, [], 0]);
  } finally { h.cleanup(); }
});

test('an address once added is never added again after its history is trimmed; a removed unused one can be', async () => {
  const h = harness();
  try {
    const [a, b] = [keypair(), keypair()];
    await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'k', text: [a.b58, b.b58].join('\n') }] });
    const leased = await h.pool.reserve({ venue: 'pump', ref: 'launch-6666' }); await h.pool.commit({ venue: 'pump', ref: 'launch-6666', address: leased.address });
    // Simulate the used entry having been trimmed from the pool document long ago.
    const doc = await h.store.read('vanity-pool'); doc.keys = doc.keys.filter(k => k.address !== a.address); await h.store.write('vanity-pool', doc);
    const again = await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'backup', text: a.b58 }] });
    assert.deepEqual([again.added, again.rejected], [[], [{ where: 'backup line 1', reason: 'already used' }]], 'a key restored from an old backup is refused');
    await h.pool.remove({ actorId: 'admin', addresses: [b.address] });
    assert.deepEqual((await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'k', text: b.b58 }] })).added, [b.address], 'a removed address that was never used can be added back');
  } finally { h.cleanup(); }
});

test('a venue can leave addresses its own records still name to other venues', async () => {
  const h = harness();
  try {
    const [a, b] = [keypair(), keypair()];
    await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'k', text: [a.b58, b.b58].join('\n') }] });
    assert.equal((await h.pool.reserve({ venue: 'meteora', ref: 'draft-7777', exclude: address => address === a.address })).address, b.address);
    assert.equal((await h.pool.reserve({ venue: 'pump', ref: 'launch-8888' })).address, a.address, 'still available to other venues');
  } finally { h.cleanup(); }
});

test('an address something on the host is bound to is never handed out; a ledger that cannot be checked fails closed', async () => {
  const h = harness();
  try {
    const [a, b] = [keypair(), keypair()];
    await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'k', text: [a.b58, b.b58].join('\n') }] });
    h.pool.inUse = async address => address === a.address;
    assert.equal((await h.pool.reserve({ venue: 'pump', ref: 'launch-9999' })).address, b.address, 'the bound address is skipped');
    h.pool.inUse = async () => { throw Error('ledger closed'); };
    assert.equal(await h.pool.reserve({ venue: 'pump', ref: 'launch-aaaa' }), null);
    assert.equal(await h.pool.noteFallback({ venue: 'pump', ref: 'launch-aaaa' }), false, 'not counted as an empty pool');
    const view = await h.pool.view('admin');
    assert.deepEqual([view.checks.failures, view.fallbacks.total, view.counts.available], [1, 0, 1]);
  } finally { h.cleanup(); }
});

test('an address whose launch never created its coin can be returned with its key, only by that launch', async () => {
  const h = harness(); const [a, b] = [keypair(), keypair()];
  try {
    await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'k', text: [a.b58, b.b58].join('\n') }], scope: 'pump' });
    const leased = await h.pool.reserve({ venue: 'pump', ref: 'launch-one' });
    await h.pool.commit({ venue: 'pump', ref: 'launch-one', address: leased.address, launch: { symbol: 'ONE' } });
    assert.deepEqual(await h.pool.usedFor('pump'), [{ address: leased.address, ref: 'launch-one', at: Date.UTC(2026, 9, 3, 12) }]);
    assert.deepEqual(await h.pool.usedFor('meteora'), []);
    const other = leased.address === a.address ? b : a, mine = leased.address === a.address ? a : b;
    await assert.rejects(h.pool.restore({ venue: 'pump', ref: 'launch-one', address: leased.address, secret: other.b58 }), /does not match its address/);
    await assert.rejects(h.pool.restore({ venue: 'pump', ref: 'launch-two', address: leased.address, secret: mine.b58 }), /Another launch recorded/);
    await assert.rejects(h.pool.restore({ venue: 'meteora', ref: 'launch-one', address: leased.address, secret: mine.b58 }), /Another launch recorded/);
    assert.equal(await h.pool.restore({ venue: 'pump', ref: 'launch-one', address: leased.address, secret: mine.b58 }), true);
    assert.equal(await h.pool.restore({ venue: 'pump', ref: 'launch-one', address: leased.address, secret: mine.b58 }), false, 'returning twice changes nothing');
    assert.deepEqual(await h.pool.returnedFor('pump'), [{ address: leased.address, ref: 'launch-one' }], 'unsettled until the venue forgets its copy');
    assert.equal(await h.pool.settleReturn({ venue: 'pump', ref: 'launch-two', address: leased.address }), false);
    assert.equal(await h.pool.settleReturn({ venue: 'pump', ref: 'launch-one', address: leased.address }), true);
    assert.equal(await h.pool.settleReturn({ venue: 'pump', ref: 'launch-one', address: leased.address }), false);
    assert.deepEqual(await h.pool.returnedFor('pump'), []);
    const view = await h.pool.view('admin');
    assert.deepEqual([view.counts.available, view.counts.used], [2, 0]); assert.ok(view.events.some(e => e.kind === 'returned'));
    assert.deepEqual(secretsIn(view, [a, b]), [], 'the view still carries no key');
    // The returned address is handed out again first (oldest), with its key.
    const again = await h.pool.reserve({ venue: 'pump', ref: 'launch-three' });
    assert.deepEqual([again.address, again.secret], [mine.address, mine.b58]);
    // An address whose used entry was trimmed from the history comes back for its venue.
    const c = keypair();
    assert.equal(await h.pool.restore({ venue: 'pump', ref: 'launch-four', address: c.address, secret: c.b58 }), true);
    assert.ok((await h.pool.view('admin')).pool.some(k => k.address === c.address && k.scope === 'pump'));
  } finally { h.cleanup(); }
});

// ---- v71.26: the admin view pages its lists ----
test('the admin view pages the pool and the used list separately, filters by state and finds addresses by prefix, coin or ticker', async () => {
  const h = harness({ onChain: async addresses => addresses.map(() => false) });
  try {
    const keys = Array.from({ length: 7 }, keypair), [a, b, c, d, e, f, g] = keys;
    await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'batch', text: keys.map(k => k.b58).join('\n') }], scope: 'all' });
    await h.pool.importKeys({ actorId: 'admin', entries: [{ name: 'x', text: keypair().b58 }], scope: 'pump' });
    const lease = await h.pool.reserve({ venue: 'raydium', ref: 'launch-1' }); await h.pool.commit({ venue: 'raydium', ref: 'launch-1', address: lease.address, launch: { name: 'Orbit Garden', symbol: 'ORBIT' } });
    await h.pool.reserve({ venue: 'pump', ref: 'launch-2' });
    const whole = await h.pool.view('admin');
    assert.deepEqual([whole.poolTotal, whole.pool.length, whole.poolMatched, whole.poolOffset, whole.poolLimit, whole.poolNextOffset, whole.usedTotal, whole.used.length], [7, 7, 7, 0, 2000, null, 1, 1], 'without a query the whole lists are returned as before');
    const page = await h.pool.view('admin', { pool: { offset: 0, limit: 3 }, used: { offset: 0, limit: 25 } });
    assert.deepEqual([page.pool.length, page.poolMatched, page.poolNextOffset, page.poolTotal], [3, 7, 3, 7]);
    const second = await h.pool.view('admin', { pool: { offset: 3, limit: 3 } });
    assert.deepEqual([second.pool.length, second.poolOffset, second.poolNextOffset], [3, 3, 6]);
    const third = await h.pool.view('admin', { pool: { offset: 6, limit: 3 } });
    assert.deepEqual([third.pool.length, third.poolNextOffset], [1, null]);
    const held = await h.pool.view('admin', { pool: { offset: 0, limit: 25, state: 'reserved' } });
    assert.deepEqual([held.pool.length, held.pool[0].state, held.poolMatched, held.poolTotal], [1, 'reserved', 1, 7], 'the state filter narrows the page; totals stay');
    assert.equal((await h.pool.view('admin', { pool: { offset: 0, limit: 25, state: 'pump' } })).pool.length, 1, 'a scope filter');
    const available = (await h.pool.view('admin')).pool.filter(r => r.state === 'available').map(r => r.address), free = [a, b, c, d, e, f, g].find(k => available.includes(k.address));
    const prefix = await h.pool.view('admin', { search: free.address.slice(0, 5).toLowerCase(), pool: { offset: 0, limit: 25 } });
    assert.ok(prefix.pool.some(r => r.address === free.address) && prefix.pool[0].address.toLowerCase().startsWith(free.address.slice(0, 5).toLowerCase()), 'a prefix match sorts first');
    assert.equal(prefix.search, free.address.slice(0, 5).toLowerCase());
    const coin = await h.pool.view('admin', { search: 'orbit', used: { offset: 0, limit: 25 } });
    assert.deepEqual(coin.used.map(r => r.address), [lease.address], 'used addresses are found by their coin');
    assert.deepEqual((await h.pool.view('admin', { search: 'orbit' })).pool, [], 'and the pool shows no match for that text');
    assert.deepEqual((await h.pool.view('admin', { used: { offset: 0, limit: 25, state: 'skipped' } })).used, []);
    await assert.rejects(h.pool.view('admin', { pool: { offset: 0, limit: 5000 } }), /Invalid vanity page/);
    await assert.rejects(h.pool.view('admin', { pool: { offset: 0, limit: 25, state: 'nonsense' } }), /valid vanity filter/);
    await assert.rejects(h.pool.view('user', { pool: { offset: 0, limit: 25 } }), /two-factor/);
    assert.equal(secretsIn(page, keys).length, 0);
  } finally { h.cleanup(); }
});
