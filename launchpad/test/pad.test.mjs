// A launchpad's own features (src/tenant/pad.mjs): the registry, stats, Summit, the ticker lock with lookalike and copied
// image flags, the bundle check and community takeovers, on a fake discovery and a fake RPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { tickerKey, nameKey, leetKey, looksAlike, editDistance, established, drawSummit, summitWeight, bundleCheck, createPadFeatures, takeoverMessage, payloadHash, walletSigned, LOCK_MS } from '../src/tenant/pad.mjs';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58 = bytes => { let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0')), out = ''; while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; } for (const b of bytes) { if (b) break; out = '1' + out; } return out; };
const address = seed => base58(createHash('sha256').update(String(seed)).digest());
const DAY = 86400000, NOW = Date.UTC(2026, 10, 5, 12);

test('tickers and names: locked as keys, lookalikes read through digits and one edit', () => {
  assert.equal(tickerKey('$pepe'), 'PEPE'); assert.equal(nameKey('Peak Cat!'), nameKey('peakcat'));
  assert.equal(leetKey('P3PE'), 'PEPE'); assert.equal(leetKey('$HIB'), 'SHIB');
  assert.equal(looksAlike('PEPE', 'P3PE'), true); assert.equal(looksAlike('PEPE', 'PEPE2'), true); assert.equal(looksAlike('PEPE', 'pepe'), false, 'the same ticker is a lock, not a lookalike');
  assert.equal(looksAlike('MOON', 'BEAM'), false); assert.equal(looksAlike('AB', 'AC'), false, 'short tickers are not compared by edits');
  assert.equal(looksAlike('PEPE', 'PEPEAI'), true); assert.equal(looksAlike('BABYPEPE', 'PEPE'), true); assert.equal(looksAlike('SOLANA', 'SOLANO'), true);
  assert.equal(looksAlike('DOGE', 'DOGS'), false, 'different short words'); assert.equal(looksAlike('CAT', 'CATS'), false); assert.equal(looksAlike('PEPE', 'PEPECOINAI'), false, 'a long add-on is a new name');
  assert.equal(looksAlike('CN12', 'CN10'), false);
  assert.equal(editDistance('kitten', 'sitten'), 1);
});

test('established: $20K, or graduated and $10K, and traded in the last 7 days', () => {
  assert.equal(established({ valueUsd: 25000, activeAt: NOW - DAY }, NOW), true);
  assert.equal(established({ valueUsd: 12000, graduated: true, activeAt: NOW - DAY }, NOW), true);
  assert.equal(established({ valueUsd: 12000, graduated: false, activeAt: NOW - DAY }, NOW), false);
  assert.equal(established({ valueUsd: 90000, activeAt: NOW - 8 * DAY }, NOW), false, 'a coin nobody traded for a week lets its ticker go');
});

test('the summit draw: weighted, and the same seed always draws the same coin', () => {
  const big = { mint: 'big', valueUsd: 500000, volume24h: 200000, createdAt: NOW - DAY }, small = { mint: 'small', valueUsd: 4000, volume24h: 10, createdAt: NOW - 20 * DAY };
  assert.ok(summitWeight(big, NOW) > 5 * summitWeight(small, NOW));
  const entries = [big, small].map(entry => ({ ...entry, weight: summitWeight(entry, NOW) }));
  const seed = Buffer.alloc(32, 7); assert.equal(drawSummit(entries, seed).mint, drawSummit(entries, seed).mint);
  let bigWins = 0; for (let i = 0; i < 400; i++) { const s = createHash('sha256').update('d' + i).digest(); if (drawSummit(entries, s).mint === 'big') bigWins++; }
  assert.ok(bigWins > 300 && bigWins < 400, `the bigger coin wins most days, not all (${bigWins}/400)`);
  assert.equal(drawSummit([], seed), null);
});

function fakeDiscovery(coins) { return { coins, records: new Map(), inventory: async () => {}, catalogue() { return { coins: this.coins }; } }; }
const coin = (n, patch = {}) => ({ mint: address('mint' + n), name: 'Coin ' + n, symbol: 'C' + n, image: `/token-images/${createHash('sha256').update('img' + n).digest('hex')}.png`, createdAt: NOW - 10 * DAY + n * 60000, platform: 'raydium', marketCapUsd: 5000, volume24h: 0, stage: 'new', progressPercent: 10, creator: { username: 'maker' + n }, ...patch });

test('the registry: launch order numbers, Founding, flags, the ticker lock and the race guard', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pad-')); let now = NOW;
  try {
    const coins = [coin(1, { symbol: 'PEPE', name: 'Pepe', marketCapUsd: 30000, volume24h: 900 }), coin(2), coin(3, { symbol: 'MOON', createdAt: NOW - DAY })];
    const discovery = fakeDiscovery(coins);
    const pad = createPadFeatures({ config: { features: { registry: true, summit: true, tickerLock: true, bundleCheck: false, takeover: false } }, discovery, dir, rpc: async () => ({}), now: () => now });
    await pad.sync();
    assert.deepEqual(Object.values(pad.state.registry.coins).map(entry => [entry.symbol, entry.no]), [['PEPE', 1], ['C2', 2], ['MOON', 3]]);
    // a lookalike and a copied image are numbered and flagged, not refused
    discovery.coins = [...coins, coin(4, { symbol: 'P3PE', createdAt: NOW - 1000 }), coin(5, { symbol: 'NEW', image: coins[1].image, createdAt: NOW - 500 })];
    await pad.sync();
    const view = mint => pad.registry(new URLSearchParams({ q: mint })).coins[0];
    assert.equal(view(address('mint4')).flags.lookalikeOf.symbol, 'PEPE'); assert.equal(view(address('mint5')).flags.copiedImageOf.symbol, 'C2');
    assert.equal(view(address('mint1')).founding, true);
    // locks: MOON launched a day ago, PEPE is established (a $30K cap traded today), C2 is old and quiet
    assert.throws(() => pad.checkLaunch({ name: 'Another', symbol: 'moon' }), /less than 3 days ago/);
    assert.throws(() => pad.checkLaunch({ name: 'Different', symbol: '$PEPE' }), /still active here/);
    assert.throws(() => pad.checkLaunch({ name: 'coin 3', symbol: 'XYZ' }), /with that name/, 'names lock too, ignoring case and spaces');
    assert.doesNotThrow(() => pad.checkLaunch({ name: 'Fresh', symbol: 'C2' }));
    now += LOCK_MS; assert.doesNotThrow(() => pad.checkLaunch({ name: 'Moon again', symbol: 'MOON' }), 'the lock lifts after 3 days');
    // two creators racing for one new ticker
    pad.checkLaunch({ name: 'Race', symbol: 'RACE', owner: 'alice' });
    assert.doesNotThrow(() => pad.checkLaunch({ name: 'Race', symbol: 'RACE', owner: 'alice' }), 'the same creator can prepare again');
    assert.throws(() => pad.checkLaunch({ name: 'Race 2', symbol: 'race', owner: 'bob' }), /launching that ticker here right now/);
    // the APIs
    const [, registry] = await pad.handlePublic('GET', '/api/pad/registry', new URLSearchParams({ sort: 'value', limit: '2' }));
    assert.equal(registry.registered, 5); assert.equal(registry.coins.length, 2); assert.equal(registry.coins[0].symbol, 'PEPE');
    const [, stats] = await pad.handlePublic('GET', '/api/pad/stats', new URLSearchParams()); assert.equal(stats.coins, 5); assert.equal(stats.biggest[0].symbol, 'PEPE');
    const [, summit] = await pad.handlePublic('GET', '/api/pad/summit', new URLSearchParams()); assert.ok(summit.today, 'a coin holds the summit');
    assert.ok(!['P3PE', 'NEW'].includes(summit.today.symbol), 'flagged coins are never drawn');
    const [, check] = await pad.handlePublic('GET', '/api/pad/check', new URLSearchParams({ ticker: 'PEP3' })); assert.equal(check.lookalike.symbol, 'PEPE');
    assert.equal((await pad.handlePublic('POST', '/api/pad/takeover', new URLSearchParams(), async () => ({})))[0], 404, 'a feature that is off answers 404');
    // a restart keeps the numbers
    const again = createPadFeatures({ config: { features: { registry: true } }, discovery, dir, rpc: async () => ({}), now: () => now }); await again.sync();
    assert.equal(Object.values(again.state.registry.coins).length, 5); assert.equal(again.state.registry.next, 6);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the bundle check: buyers in the first slots, their funders, and what the linked ones still hold', async () => {
  const mint = address('bundled'), creator = address('creator'), funder = address('shared funder'), vault = address('vault');
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(address);
  const tokenRow = (owner, amount) => ({ mint, owner, uiTokenAmount: { amount: String(amount) } });
  const txs = {
    create: { slot: 100, meta: { err: null, preTokenBalances: [], postTokenBalances: [tokenRow(vault, 1e15)] } },
    buyA: { slot: 101, meta: { err: null, preTokenBalances: [tokenRow(vault, 1e15)], postTokenBalances: [tokenRow(vault, 99e13), tokenRow(a, 1e13)] } },
    buyB: { slot: 103, meta: { err: null, preTokenBalances: [], postTokenBalances: [tokenRow(b, 2e13)] } },
    buyC: { slot: 104, meta: { err: null, preTokenBalances: [], postTokenBalances: [tokenRow(c, 3e13)] } },
    buyD: { slot: 140, meta: { err: null, preTokenBalances: [], postTokenBalances: [tokenRow(d, 5e13)] } }, // after the first 20 slots
  };
  const transfer = (source, destination) => ({ transaction: { message: { instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source, destination, lamports: 1e9 } } }] } }, meta: { innerInstructions: [] } });
  const funding = { fundA: transfer(creator, a), fundB: transfer(funder, b), fundC: transfer(funder, c) };
  const held = { [a]: 1e13, [b]: 0, [c]: 25e12 };
  const rpc = async (method, params) => {
    if (method === 'getSignaturesForAddress') {
      if (params[0] === mint) return ['buyD', 'buyC', 'buyB', 'buyA', 'create'].map(signature => ({ signature, slot: txs[signature].slot, err: null }));
      return { [a]: [{ signature: 'fundA' }], [b]: [{ signature: 'fundB' }], [c]: [{ signature: 'fundC' }] }[params[0]] || [];
    }
    if (method === 'getTransaction') return txs[params[0]] || funding[params[0]] || null;
    if (method === 'getTokenSupply') return { value: { amount: String(1e15) } };
    if (method === 'getTokenAccountsByOwner') return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(held[params[0]] || 0) } } } } } }] };
    throw new Error('unexpected ' + method);
  };
  const result = await bundleCheck({ rpc, mint, creatorWallets: [creator] });
  assert.equal(result.status, 'checked'); assert.equal(result.buyers, 3, 'the vault and the late buyer are not early buyers');
  assert.deepEqual(result.linked.map(row => [row.wallet, row.reason, row.holdsPct]).sort(), [[a, 'funded by the creator', 1], [b, 'shares a funder with other early buyers', 0], [c, 'shares a funder with other early buyers', 2.5]].sort());
  assert.equal(result.linkedHoldPct, 3.5);
  // No creator wallet from the launch record (a Pump.fun coin): the creation transaction's fee payer is the creator.
  txs.create.transaction = { message: { accountKeys: [{ pubkey: creator, signer: true, writable: true }] } };
  const fromPayer = await bundleCheck({ rpc, mint, creatorWallets: [] });
  assert.deepEqual(fromPayer.linked.map(row => [row.wallet, row.reason]).sort(), [[a, 'funded by the creator'], [b, 'shares a funder with other early buyers'], [c, 'shares a funder with other early buyers']].sort());
  delete txs.create.transaction;
  const unknown = await bundleCheck({ rpc, mint, creatorWallets: [] });
  assert.deepEqual(unknown.linked.map(row => row.wallet).sort(), [b, c].sort(), 'without a creator, A is only an early buyer');
});

test('community takeover: a holder signs, the owner approves, the coin shows it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pad-'));
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519'), wallet = base58(Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url'));
    const target = coin(9, { symbol: 'TAKE' }), discovery = fakeDiscovery([target]);
    let holds = 4e12; // 0.4% of a 1e15 supply
    const rpc = async method => method === 'getTokenSupply' ? { value: { amount: String(1e15) } } : { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(holds) } } } } } }] };
    const pad = createPadFeatures({ config: { features: { takeover: true, registry: true } }, discovery, dir, rpc, host: 'moon.pads.example', now: () => NOW });
    await pad.sync();
    const png = 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]).toString('base64');
    const request = { mint: target.mint, logo: png, banner: '', links: { x: 'https://x.com/takecoin', telegram: '', website: '' }, description: 'Holders run it now.' };
    const payload = { mint: request.mint, logo: payloadHash(png), banner: '', links: request.links, description: request.description };
    const signed = (host, at = NOW) => sign(null, Buffer.from(takeoverMessage({ host, mint: target.mint, payloadHash: payloadHash(payload), at })), privateKey).toString('base64');
    assert.equal(walletSigned(wallet, takeoverMessage({ host: 'moon.pads.example', mint: target.mint, payloadHash: payloadHash(payload), at: NOW }), signed('moon.pads.example')), true);
    const post = (body, requestHost = 'moon.pads.example') => pad.handlePublic('POST', '/api/pad/takeover', new URLSearchParams(), async () => body, { requestHost });
    await assert.rejects(post({ ...request, wallet, at: NOW, signature: signed('moon.pads.example') }), /holds 0\.4% of \$TAKE/);
    holds = 6e12;
    await assert.rejects(post({ ...request, description: 'changed after signing', wallet, at: NOW, signature: signed('moon.pads.example') }), /does not match/);
    await assert.rejects(post({ ...request, wallet, at: NOW - 3600000, signature: signed('moon.pads.example', NOW - 3600000) }), /expired/);
    const [status, sent] = await post({ ...request, wallet, at: NOW, signature: signed('owner-domain.xyz') }, 'owner-domain.xyz');
    assert.equal(status, 201); assert.equal(sent.status, 'pending', 'a request signed on the owner’s own domain is accepted');
    const [, list] = await pad.handleAdmin('GET', '/api/admin/pad/takeovers', async () => ({}));
    assert.equal(list.requests[0].holdsPct, 0.6); assert.match(list.requests[0].logo, /^\/pad-media\/[a-f0-9]{64}\.png$/);
    assert.ok(await pad.mediaFile(list.requests[0].logo.split('/').at(-1)));
    await pad.handleAdmin('POST', '/api/admin/pad/takeovers/decide', async () => ({ id: sent.id, approve: true }));
    const [, view] = await pad.handlePublic('GET', '/api/pad/coin', new URLSearchParams({ mint: target.mint }));
    assert.equal(view.flags.takeover, true); assert.equal(view.takeover.description, 'Holders run it now.'); assert.equal(view.image, list.requests[0].logo, 'the registry shows the new logo');
    await assert.rejects(pad.handleAdmin('POST', '/api/admin/pad/takeovers/decide', async () => ({ id: sent.id, approve: false })), /already decided/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
