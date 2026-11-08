import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {LAUNCH_ASSETS} from '../public/launch-assets.mjs';
import {LaunchQuoteCatalogue, sunriseAsset} from '../src/launchpad-quotes.mjs';

const NOW = Date.parse('2026-09-25T22:00:00Z');
const mint = n => new PublicKey(Buffer.alloc(32, n)).toBase58();
const listing = (n, token = {}, metadata = {}) => ({
  listing: {appId:'sunrise', status:'active', visibleFrom:'2026-09-25T21:00:00Z', visibleUntil:null, ...metadata},
  token: {horizonChainId:'solana', address:mint(n), name:`Example ${n}`, symbol:`EX${n}`, assetClass:'crypto', isNative:false, ...token},
});
const page = (rows, nextCursor = null) => ({success:true, data:{listings:rows, count:rows.length, pagination:{limit:200, nextCursor}}});
const response = data => new Response(JSON.stringify(data));

test('current public listing schema maps issuer labels and categories while keeping verified identity', () => {
  const stock = sunriseAsset(listing(191, {assetClass:'stock', issuer:'backpack_securities', issuerName:'Backpack Securities'}), {now:NOW});
  assert.equal(stock.category, 'stocks');
  assert.equal(stock.issuer, 'Backpack Securities');
  assert.equal(stock.supported, undefined, 'a listing does not imply LaunchLab support');
  assert.equal(sunriseAsset(listing(192, {assetClass:'stablecoin'}), {now:NOW}).category, 'crypto');
  assert.equal(sunriseAsset(listing(193, {assetClass:'commodity'}), {now:NOW}).category, 'other');
  assert.equal(sunriseAsset(listing(194, {assetClass:'unknown'}), {now:NOW}).category, 'other');
  assert.equal(sunriseAsset(listing(195, {issuer:null, issuerName:null}), {now:NOW}).issuer, 'Sunrise listing');
  const known = LAUNCH_ASSETS.find(a => a.symbol === 'OPENAI');
  assert.deepEqual(sunriseAsset(listing(196, {address:known.mint, name:'Generic feed name', symbol:'WRONG', assetClass:'stock'}), {now:NOW}), known);
});

test('inactive, future, expired, malformed, non-Solana and retired tokens never become new choices', () => {
  const retired = ['PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh', 'PreC1KtJ1sBPPqaeeqL6Qb15GTLCYVvyYEwxhdfTwfx'];
  const rows = [
    listing(191, {}, {status:'inactive'}),
    listing(191, {}, {status:'pending'}),
    listing(191, {}, {appId:'other-app'}),
    listing(191, {}, {visibleFrom:'2026-09-26T00:00:00Z'}),
    listing(191, {}, {visibleFrom:'invalid'}),
    listing(191, {}, {visibleFrom:null}),
    listing(191, {}, {visibleUntil:'2026-09-25T22:00:00Z'}),
    listing(191, {}, {visibleUntil:'invalid'}),
    listing(191, {horizonChainId:'ethereum'}),
    listing(191, {address:'not a mint'}),
    listing(191, {address:123}),
    listing(191, {address:PublicKey.default.toBase58()}),
    listing(191, {symbol:''}),
    listing(191, {name:''}),
    ...retired.map(address => listing(191, {address})),
    {listing:null, token:listing(191).token},
  ];
  for (const row of rows) assert.equal(sunriseAsset(row, {now:NOW}), null, JSON.stringify(row));
  for (const address of retired) assert.equal(sunriseAsset({chain:'solana', address, symbol:'RETIRED', name:'Retired'}), null);
  assert(sunriseAsset(listing(191, {}, {visibleFrom:'2026-09-25T22:00:00Z', visibleUntil:'2026-09-25T22:00:01Z'}), {now:NOW}));
});

test('native SOL maps only to the verified wrapped SOL mint', () => {
  const native = listing(191, {address:'native', isNative:true, symbol:'SOL', name:'Solana'});
  assert.deepEqual(sunriseAsset(native, {now:NOW}), LAUNCH_ASSETS.find(a => a.symbol === 'SOL'));
  assert.equal(sunriseAsset(listing(191, {address:'native', isNative:true, symbol:'OTHER'}), {now:NOW}), null);
  assert.equal(sunriseAsset(listing(191, {address:'native'}), {now:NOW}), null);
  assert.equal(sunriseAsset(listing(191, {isNative:true}), {now:NOW}), null);
});

test('a completed paginated public refresh merges by mint without overwriting verified identities', async () => {
  const known = LAUNCH_ASSETS.find(a => a.symbol === 'OPENAI'), calls = [];
  const first = listing(191, {assetClass:'stock', issuerName:'Example issuer'});
  const pages = [page([
    listing(190, {address:known.mint, symbol:'WRONG', name:'Incorrect name'}),
    first,
    listing(192, {}, {status:'inactive'}),
    listing(193, {}, {visibleFrom:'2026-09-26T00:00:00Z'}),
    listing(194, {address:'native', isNative:true, symbol:'SOL'}),
  ], 'page:2/+='), page([
    listing(191, {symbol:'DUPLICATE', name:'Duplicate label'}),
    listing(195, {assetClass:'commodity'}),
  ])];
  const catalogue = new LaunchQuoteCatalogue({now:()=>NOW, fetcher:async (url, options) => {
    assert(options.signal instanceof AbortSignal);
    calls.push(url); return response(pages.shift());
  }});
  const result = await catalogue.read();
  assert.equal(calls[0], 'https://sunrise.xyz/api/tokens?includeChains=true');
  assert.equal(calls[1], 'https://sunrise.xyz/api/tokens?includeChains=true&cursor=page%3A2%2F%2B%3D');
  assert.equal(result.assets.length, LAUNCH_ASSETS.length + 2);
  assert.equal(new Set(result.assets.map(a => a.mint)).size, result.assets.length);
  assert.deepEqual(result.assets.find(a => a.mint === known.mint), known);
  assert.equal(result.assets.find(a => a.mint === mint(191)).symbol, 'EX191');
  assert.equal(result.assets.find(a => a.mint === mint(195)).category, 'other');
  assert.equal(result.notice, undefined);
  assert.equal(result.source, 'Sunrise + verified issuers');
});

test('failed later pages preserve the last completed catalogue and retry only after the failure cache', async () => {
  let now = NOW, calls = 0;
  const responses = [response(page([listing(191)])), response(page([listing(192)], 'next')), new Response('unavailable', {status:503}), response(page([listing(193)]))];
  const catalogue = new LaunchQuoteCatalogue({now:()=>now, fetcher:async()=>{calls++; return responses.shift();}});
  const initial = await catalogue.read();
  now += 60001;
  const failed = await catalogue.read();
  assert.equal(calls, 3);
  assert.strictEqual(failed.assets, initial.assets);
  assert(failed.notice);
  assert(!failed.assets.some(a => a.mint === mint(192)));
  await catalogue.read(); assert.equal(calls, 3);
  now += 60001;
  const recovered = await catalogue.read();
  assert.equal(calls, 4);
  assert(recovered.assets.some(a => a.mint === mint(193)));
  assert(!recovered.assets.some(a => a.mint === mint(191)));
});

test('concurrent catalogue requests share refresh and successful results cache for one minute', async () => {
  let now = NOW, calls = 0, release;
  const gate = new Promise(resolve => {release = resolve;});
  const catalogue = new LaunchQuoteCatalogue({now:()=>now, fetcher:async()=>{calls++; await gate; return response(page([listing(191)]));}});
  const a = catalogue.read(), b = catalogue.read();
  assert.equal(calls, 1); release();
  const [first, second] = await Promise.all([a, b]);
  assert.strictEqual(first.assets, second.assets);
  now += 59999; await catalogue.read(); assert.equal(calls, 1);
  now += 1; await catalogue.read(); assert.equal(calls, 2);
});

test('malformed current pages cannot replace the snapshot', async t => {
  const malformed = {
    'wrong envelope': {success:false, data:page([listing(191)]).data},
    'old schema': {success:true, data:{tokens:[listing(191).token], pagination:{nextCursor:null}}},
    'missing count': (()=>{const value=page([listing(191)]); delete value.data.count; return value;})(),
    'mismatched count': {...page([listing(191)]), data:{...page([listing(191)]).data, count:2}},
    'string count': {...page([listing(191)]), data:{...page([listing(191)]).data, count:'1'}},
    'count exceeds limit': {...page([listing(191), listing(192)]), data:{...page([listing(191), listing(192)]).data, pagination:{limit:1, nextCursor:null}}},
    'missing pagination': {success:true, data:{listings:[listing(191)], count:1}},
    'missing terminal cursor': {success:true, data:{listings:[listing(191)], count:1, pagination:{limit:200}}},
    'object cursor': page([listing(191)], {}),
    'nonstring cursor': page([listing(191)], 0),
    'oversized cursor': page([listing(191)], 'x'.repeat(2049)),
    'control character cursor': page([listing(191)], 'next\npage'),
    'empty continuing page': page([], 'next'),
    'unwrapped row': page([listing(191).token]),
    'null row': page([null]),
    'invalid token wrapper': page([{listing:listing(191).listing, token:[]}]),
    'oversized page': page(Array.from({length:201}, ()=>listing(191))),
    'oversized limit': {success:true, data:{listings:[listing(191)], count:1, pagination:{limit:201, nextCursor:null}}},
  };
  for (const [name, body] of Object.entries(malformed)) await t.test(name, async () => {
    let calls = 0;
    const catalogue = new LaunchQuoteCatalogue({now:()=>NOW, fetcher:async()=>{calls++; return response(body);}});
    const result = await catalogue.read();
    assert.strictEqual(result.assets, LAUNCH_ASSETS);
    assert(result.notice);
    assert.equal(calls, 1);
  });
});

test('repeating cursors and page limits never publish a partial catalogue', async () => {
  for (const looping of [true, false]) {
    let calls = 0;
    const catalogue = new LaunchQuoteCatalogue({now:()=>NOW, fetcher:async()=>{calls++; return response(page([listing(191)], looping ? 'same' : `page-${calls}`));}});
    const result = await catalogue.read();
    assert.equal(calls, looping ? 2 : 20);
    assert.strictEqual(result.assets, LAUNCH_ASSETS);
    assert(result.notice);
  }
});

test('invalid JSON and excessive response bodies retain the snapshot', async () => {
  for (const body of ['{', ' '.repeat(2000001)]) {
    const catalogue = new LaunchQuoteCatalogue({now:()=>NOW, fetcher:async()=>new Response(body)});
    const result = await catalogue.read();
    assert.strictEqual(result.assets, LAUNCH_ASSETS);
    assert(result.notice);
  }
});
