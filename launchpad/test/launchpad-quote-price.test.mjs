import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { ExtensionType, ScaledUiAmountConfigLayout } from '@solana/spl-token';
import { dexQuotePrice, readQuoteReference } from '../src/launchpad-quote-price.mjs';
import { LAUNCH_ASSETS } from '../public/launch-assets.mjs';
import { SOL_MINT, USDC_MINT } from '../public/launchpad-model.mjs';

const NOW = 1790380800000, key = n => new PublicKey(Buffer.alloc(32, n)).toBase58();
const asset = symbol => LAUNCH_ASSETS.find(row => row.symbol === symbol);
const pair = (mint, patch = {}) => ({ chainId: 'solana', pairAddress: key(1), baseToken: { address: mint }, quoteToken: { address: USDC_MINT }, priceUsd: '12', priceNative: '12', liquidity: { usd: 50000 }, ...patch });
const json = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers });
const mint = (decimals = 9, extensions = []) => ({ mint: { decimals }, extensions });
function scaledMint(multiplier = 1, newMultiplier = 1, extra = []) {
  const info = mint(9, [ExtensionType.ScaledUiAmountConfig, ...extra]);
  const data = Buffer.alloc(ScaledUiAmountConfigLayout.span);
  ScaledUiAmountConfigLayout.encode({ authority: new PublicKey(key(11)), multiplier, newMultiplier,
    newMultiplierEffectiveTimestamp: BigInt(Math.floor(NOW / 1000) + 60) }, data);
  const header = Buffer.alloc(4); header.writeUInt16LE(ExtensionType.ScaledUiAmountConfig); header.writeUInt16LE(data.length, 2);
  info.mint.tlvData = Buffer.concat([header, data]); return info;
}
const quote = (mint, patch = {}) => ({ inputMint: mint, outputMint: USDC_MINT, inAmount: '1000000000', outAmount: '12000000', swapMode: 'ExactIn', priceImpactPct: '.001', routePlan: [{}], ...patch });
function fixture(respond, options = {}) {
  const calls = [], gates = [], cooldowns = [];
  const config = { now: () => NOW, jupiterKey: 'operator-key', jupiterGate: { acquire: async (...args) => gates.push(args), cooldown: (...args) => cooldowns.push(args) },
    fetcher: async (url, init) => { calls.push({ url, init }); return respond(url, init); }, ...options };
  return { calls, gates, cooldowns, read: (address, info = mint()) => readQuoteReference(config, { quoteMint: address }, info) };
}

test('DEX reference prices the exact mint on either side and chooses the deepest valid pool', () => {
  const m = asset('OPENAI').mint;
  assert.equal(dexQuotePrice([pair(m)], m), 12);
  assert.equal(dexQuotePrice([pair(SOL_MINT, { quoteToken: { address: m }, priceUsd: '100', priceNative: '2' })], m), 50);
  assert.equal(dexQuotePrice([pair(m), pair(m, { pairAddress: key(2), priceUsd: '13', liquidity: { usd: 100000 } })], m), 13);
});

test('DEX reference rejects unrelated tickers, invalid identities, low liquidity and unusable amounts', () => {
  const m = asset('GRND').mint;
  for (const row of [
    pair(SOL_MINT, { baseToken: { address: SOL_MINT, symbol: 'GRND' } }), pair(m, { chainId: 'ethereum' }),
    pair(m, { pairAddress: 'invalid' }), pair(m, { quoteToken: { address: m } }), pair(m, { liquidity: { usd: 9999 } }),
    pair(m, { liquidity: { usd: Infinity } }), pair(m, { priceUsd: true }), pair(m, { priceUsd: '0' }), pair(m, { priceUsd: 'Infinity' }),
    pair(SOL_MINT, { quoteToken: { address: m }, priceNative: '0' }), pair(SOL_MINT, { quoteToken: { address: m }, priceNative: null }),
  ]) assert.equal(dexQuotePrice([row], m), null);
});

test('unscaled liquid quote assets avoid unnecessary authenticated route requests', async () => {
  const m = asset('OPENAI').mint, f = fixture(async () => json([pair(m)]));
  assert.deepEqual(await f.read(m), { usd: '12.00000000', source: 'Live market reference', at: NOW });
  assert.equal(f.calls.length, 1); assert.equal(f.gates.length, 0); assert.equal(f.calls[0].init.headers, undefined);
});

test('scaled and interest-bearing GRND, FLWS, KOx and OPENAI references use authenticated raw-token routes', async () => {
  for (const symbol of ['GRND', 'FLWS', 'KOx', 'OPENAI']) for (const extension of [ExtensionType.ScaledUiAmountConfig, ExtensionType.InterestBearingConfig]) {
    const m = asset(symbol).mint, f = fixture(async () => json(quote(m)));
    const result = await f.read(m, mint(9, [extension]));
    assert.equal(result.usd, '12.00000000'); assert.equal(result.at, NOW); assert.match(result.source, /raw-token/);
    assert.equal(f.calls.length, 1); const request = f.calls[0], url = new URL(request.url);
    assert.equal(url.origin, 'https://api.jup.ag'); assert.equal(url.pathname, '/swap/v1/quote');
    assert.equal(url.searchParams.get('inputMint'), m); assert.equal(url.searchParams.get('outputMint'), USDC_MINT);
    assert.equal(url.searchParams.get('amount'), '1000000000'); assert.equal(request.init.headers['x-api-key'], 'operator-key');
    assert.equal(f.gates.length, 1); assert.equal(f.gates[0][0].jupiterKey, 'operator-key');
    assert.equal(request.init.method, undefined); assert.equal(request.init.body, undefined);
  }
});

test('verified current and scheduled identity scales let AMD and GRND use liquid DEX references without an API key', async () => {
  for (const symbol of ['AMD', 'GRND']) {
    const m = asset(symbol).mint, f = fixture(async () => json([pair(m)]), { jupiterKey: '' });
    const result = await f.read(m, scaledMint());
    assert.equal(result.usd, '12.00000000'); assert.equal(result.source, 'Live market reference');
    assert.equal(f.calls.length, 1); assert(f.calls[0].url.startsWith('https://api.dexscreener.com/'));
    assert.equal(f.gates.length, 0);
  }
});

test('nonidentity current/future scales, interest, and malformed or missing extension bytes keep the raw route', async () => {
  const m = asset('OPENAI').mint;
  const missing = mint(9, [ExtensionType.ScaledUiAmountConfig]);
  const truncated = scaledMint(); truncated.mint.tlvData = truncated.mint.tlvData.subarray(0, 12);
  const absent = scaledMint(); absent.mint.tlvData = Buffer.alloc(0);
  for (const info of [scaledMint(1.4861347, 1.4861347), scaledMint(1, 2), scaledMint(2, 1),
    scaledMint(NaN, 1), scaledMint(1, Infinity), scaledMint(1, 1, [ExtensionType.InterestBearingConfig]), missing, truncated, absent]) {
    const f = fixture(async () => json(quote(m)));
    const result = await f.read(m, info);
    assert.match(result.source, /raw-token/); assert.equal(f.calls.length, 1);
    assert(f.calls[0].url.startsWith('https://api.jup.ag/'));
  }
});

test('identity-scale DEX failures retain the exact raw-unit fallback and its impact protection', async () => {
  const m = asset('AMD').mint;
  for (const impact of ['.001', '.03']) {
    const f = fixture(async url => url.startsWith('https://api.dexscreener.com/') ? json([pair(m, { liquidity: { usd: 99 } })]) : json(quote(m, { priceImpactPct: impact })));
    if (impact === '.001') assert.match((await f.read(m, scaledMint())).source, /raw-token/);
    else await assert.rejects(f.read(m, scaledMint()), /reliable price route/);
    assert.equal(f.calls.length, 2); assert.equal(f.gates.length, 1);
  }
});

test('a missing or failed DEX index falls back to an exact live route without reducing liquidity checks', async () => {
  for (const failure of ['empty', 'low-liquidity', 'http', 'network', 'malformed']) {
    const m = asset('OPENAI').mint, f = fixture(async url => {
      if (url.startsWith('https://api.jup.ag/')) return json(quote(m));
      if (failure === 'network') throw Error('offline');
      return failure === 'http' ? json({}, 503) : failure === 'malformed' ? new Response('broken') : json(failure === 'empty' ? [] : [pair(m, { liquidity: { usd: 100 } })]);
    });
    assert.equal((await f.read(m)).usd, '12.00000000'); assert.equal(f.calls.length, 2); assert.equal(f.gates.length, 1);
  }
});

test('route references reject malformed, mismatched, zero, excessive-impact and out-of-range prices', async () => {
  const m = asset('KOx').mint;
  for (const patch of [{ inputMint: SOL_MINT }, { outputMint: SOL_MINT }, { inAmount: '1' }, { outAmount: '0' }, { outAmount: 12000000 }, { outAmount: '1000000000000000' }, { swapMode: 'ExactOut' }, { routePlan: [] }, { routePlan: 'route' }, { priceImpactPct: '.03' }, { priceImpactPct: null }, { priceImpactPct: Infinity }]) {
    const f = fixture(async () => json(quote(m, patch)));
    await assert.rejects(f.read(m, mint(9, [ExtensionType.ScaledUiAmountConfig])), /reliable price route|Invalid asset price/);
  }
});

test('a failed scaled raw-unit reference never uses a potentially UI-scaled DEX price or fabricated zero', async () => {
  const m = asset('FLWS').mint, f = fixture(async () => json({}, 401));
  await assert.rejects(f.read(m, mint(9, [ExtensionType.ScaledUiAmountConfig])), /current price is unavailable/);
  assert.equal(f.calls.length, 1); assert(f.calls[0].url.startsWith('https://api.jup.ag/'));
});

test('route rate limits preserve the provider cooldown and do not expose response errors', async () => {
  const m = asset('GRND').mint, f = fixture(async () => json({ error: 'PRIVATE-PROVIDER-DETAIL' }, 429, { 'retry-after': '8' }));
  await assert.rejects(f.read(m, mint(9, [ExtensionType.ScaledUiAmountConfig])), error => !error.message.includes('PRIVATE'));
  assert.equal(f.cooldowns[0][1], 8000);
});

test('raw quote input uses the actual mint decimals, with no UI multiplier', async () => {
  const m = asset('KOx').mint, f = fixture(async () => json(quote(m, { inAmount: '1000000' })));
  assert.equal((await f.read(m, mint(6, [ExtensionType.ScaledUiAmountConfig]))).usd, '12.00000000');
  assert.equal(new URL(f.calls[0].url).searchParams.get('amount'), '1000000');
});

test('coarse one-token USDC output retries at a larger raw sample and prices each token', async () => {
  const m = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const f = fixture(async url => {
    const amount = new URL(url).searchParams.get('amount');
    return json(quote(m, { inAmount: amount, outAmount: amount === '100000' ? '3' : '3661', priceImpactPct: amount === '100000' ? '.1815' : '0' }));
  });
  assert.equal((await f.read(m, mint(5, [ExtensionType.ScaledUiAmountConfig]))).usd, '0.00000366');
  assert.deepEqual(f.calls.map(call => new URL(call.url).searchParams.get('amount')), ['100000', '100000000']);
  assert.equal(f.gates.length, 2);
  assert(f.calls.every(call => call.init.signal === f.calls[0].init.signal));
  assert(f.gates.every(([, signal, deadline]) => signal === f.calls[0].init.signal && deadline === NOW + 15000));
});

test('zero and tiny valid routes can reach the existing minimum price with at most three samples', async () => {
  const m = asset('KOx').mint, outputs = ['0', '10', '10000'];
  const f = fixture(async url => json(quote(m, { inAmount: new URL(url).searchParams.get('amount'), outAmount: outputs.shift(), priceImpactPct: '.001' })));
  assert.equal((await f.read(m, mint(12, [ExtensionType.ScaledUiAmountConfig]))).usd, '0.00000001');
  assert.deepEqual(f.calls.map(call => new URL(call.url).searchParams.get('amount')), ['1000000000000', '1000000000000000', '1000000000000000000']);
  assert.equal(f.gates.length, 3);
});

test('sample escalation rejects malformed identity, route, output or impact on every attempt', async () => {
  const m = asset('KOx').mint;
  for (const attempt of [1, 2, 3]) for (const patch of [{ inputMint: SOL_MINT }, { outputMint: SOL_MINT }, { inAmount: '1' }, { swapMode: 'ExactOut' }, { routePlan: [] }, { outAmount: '-1' }, { outAmount: '01' }, { outAmount: 3 }, { priceImpactPct: null }, { priceImpactPct: 'invalid' }, { outAmount: '1000', priceImpactPct: '.021' }]) {
    let requests = 0;
    const f = fixture(async url => json(quote(m, { inAmount: new URL(url).searchParams.get('amount'), outAmount: '3', ...(++requests === attempt ? patch : {}) })));
    await assert.rejects(f.read(m, mint(5, [ExtensionType.ScaledUiAmountConfig])), /reliable price route/);
    assert.equal(f.calls.length, attempt);
  }
});

test('insufficient precision or excessive final impact cannot produce a price', async () => {
  const m = asset('KOx').mint;
  for (const outAmount of ['0', '999']) {
    const f = fixture(async url => json(quote(m, { inAmount: new URL(url).searchParams.get('amount'), outAmount, priceImpactPct: '.5' })));
    await assert.rejects(f.read(m, mint(5, [ExtensionType.ScaledUiAmountConfig])), /reliable price route/);
    assert.equal(f.calls.length, 3); assert.equal(f.gates.length, 3);
  }
});

test('sample retries share the original deadline and preserve provider cooldown', async () => {
  const m = asset('KOx').mint;
  let clock = NOW;
  const expired = fixture(async url => { clock += 15001; return json(quote(m, { inAmount: new URL(url).searchParams.get('amount'), outAmount: '3' })); }, { now: () => clock });
  await assert.rejects(expired.read(m, mint(5, [ExtensionType.ScaledUiAmountConfig])), /current price is unavailable/);
  assert.equal(expired.calls.length, 1); assert.equal(expired.gates.length, 1);
  clock = NOW;
  const late = fixture(async url => { clock += 15001; return json(quote(m, { inAmount: new URL(url).searchParams.get('amount') })); }, { now: () => clock });
  await assert.rejects(late.read(m, mint(5, [ExtensionType.ScaledUiAmountConfig])), /current price is unavailable/);
  assert.equal(late.calls.length, 1);
  let requests = 0;
  const limited = fixture(async url => ++requests === 1 ? json(quote(m, { inAmount: new URL(url).searchParams.get('amount'), outAmount: '3' })) : json({ error: 'PRIVATE-DETAIL' }, 429, { 'retry-after': '9' }));
  await assert.rejects(limited.read(m, mint(5, [ExtensionType.ScaledUiAmountConfig])), error => /current price is unavailable/.test(error.message) && !error.message.includes('PRIVATE'));
  assert.equal(limited.calls.length, 2); assert.equal(limited.gates.length, 2); assert.equal(limited.cooldowns[0][1], 9000);
});
