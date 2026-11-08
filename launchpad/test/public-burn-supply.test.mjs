import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicBurnSupply, PUBLIC_BURN_MINT, PUBLIC_BURN_DECIMALS, PUBLIC_BURN_ORIGINAL_SUPPLY } from '../src/public-burn-supply.mjs';

const NOW = Date.parse('2026-10-01T17:30:00Z'), ORIGINAL = 1_000_000_000_000_000n;
const zero = new PublicKey(new Uint8Array(32));
function account({ supply = 814_000_000_000_000n, decimals = 6, mintAuthorityOption = 0, isInitialized = true, owner = TOKEN_2022_PROGRAM_ID, executable = false } = {}) {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode({ mintAuthorityOption, mintAuthority: zero, supply, decimals, isInitialized, freezeAuthorityOption: 0, freezeAuthority: zero }, data);
  return { data, owner, executable, lamports: 1_000_000 };
}
const result = (options = {}, slot = 450_000_000) => ({ context: { slot }, value: account(options) });
function fixture() {
  let now = NOW, calls = 0, response = result(); const configs = [];
  const reader = new PublicBurnSupply({ now: () => now, connection: { getAccountInfoAndContext: async (key, config) => {
    calls++; assert.equal(key.toBase58(), PUBLIC_BURN_MINT); configs.push(config);
    if (response instanceof Error) throw response; return response;
  } } });
  return { reader, configs, advance: (ms = 60_000) => { now += ms; }, set: next => { response = next; }, get calls() { return calls; } };
}

test('reports actual 186 million burned from immutable finalized mint supply, without journals or float rounding', async () => {
  const f = fixture(); assert.equal(PUBLIC_BURN_MINT, '7rvRFpzP5W18yZcNpPNqtWgPTxLaFrnutz5QPxXpyupc');
  assert.equal(PUBLIC_BURN_DECIMALS, 6); assert.equal(PUBLIC_BURN_ORIGINAL_SUPPLY, ORIGINAL.toString());
  assert.equal(f.reader.readPublic().status, 'unavailable');
  const value = await f.reader.tick(); assert.equal(value.status, 'available');
  assert.equal(value.totalBurned, '186000000000000'); assert.equal(value.currentSupply, '814000000000000');
  assert.equal(value.burnedPercent, '18.60'); assert.equal(value.at, NOW); assert.equal(value.slot, 450_000_000);
  assert.equal(value.commitment, 'finalized'); assert.equal(value.source, 'finalized-mint-supply');
  assert.deepEqual(f.configs, [{ commitment: 'finalized' }]);
  assert.throws(() => { value.totalBurned = '1'; }, TypeError); assert.equal(f.reader.readPublic().totalBurned, '186000000000000');
  f.advance(); f.set(result({ supply: 813_999_999_999_999n }, 450_000_001)); await f.reader.tick();
  assert.equal(f.reader.readPublic().totalBurned, '186000000000001');
  assert.deepEqual(f.configs[1], { commitment: 'finalized', minContextSlot: 450_000_000 }); f.reader.close();
});

test('public reads never request RPC, and parallel refreshes share at most two requests per minute', async () => {
  const f = fixture(); for (let i = 0; i < 100; i++) f.reader.readPublic(); assert.equal(f.calls, 0);
  await Promise.all(Array.from({ length: 100 }, () => f.reader.tick())); assert.equal(f.calls, 1);
  for (let i = 0; i < 100; i++) f.reader.readPublic(); await f.reader.tick(); assert.equal(f.calls, 1);
  f.advance(29_999); await f.reader.tick(); assert.equal(f.calls, 1); f.advance(1); await f.reader.tick(); assert.equal(f.calls, 2); f.reader.close();
});

test('RPC failures retain previous verified value as stale, throttle retries, and recover', async () => {
  const f = fixture(); await f.reader.tick(); f.advance(); assert.equal(f.reader.readPublic().status, 'stale');
  f.set(Error('provider unavailable')); const stale = await f.reader.tick();
  assert.equal(stale.status, 'stale'); assert.equal(stale.totalBurned, '186000000000000'); assert.equal(stale.at, NOW);
  await Promise.all(Array.from({ length: 100 }, () => f.reader.tick())); assert.equal(f.calls, 2);
  f.advance(); f.set(result({ supply: 800_000_000_000_000n }, 450_000_001)); const recovered = await f.reader.tick();
  assert.equal(recovered.status, 'available'); assert.equal(recovered.totalBurned, '200000000000000'); f.reader.close();
});

test('missing, malformed, wrong-owner, reissuable, wrong-decimal and impossible supply accounts never publish', async () => {
  const invalid = [
    { context: { slot: 450_000_000 }, value: null }, result({ owner: TOKEN_PROGRAM_ID }), result({ executable: true }),
    result({ mintAuthorityOption: 1 }), result({ decimals: 9 }), result({ isInitialized: false }), result({ supply: ORIGINAL + 1n }),
    result({}, 0), result({}, 1.5), { context: { slot: 450_000_000 }, value: { ...account(), data: Buffer.alloc(1) } },
  ];
  for (const bad of invalid) {
    const f = fixture(); f.set(bad); const value = await f.reader.tick(); assert.equal(value.status, 'unavailable');
    assert.equal(value.totalBurned, null); assert.equal(value.currentSupply, null); assert.equal(value.burnedPercent, null); f.reader.close();
  }
});

test('regressing finalized slots, same-slot contradictions and impossible supply increases cannot overwrite verified state', async () => {
  const f = fixture(); await f.reader.tick();
  for (const bad of [result({ supply: 800_000_000_000_000n }, 449_999_999), result({ supply: 800_000_000_000_000n }), result({ supply: 900_000_000_000_000n }, 450_000_001)]) {
    f.advance(); f.set(bad); const value = await f.reader.tick(); assert.equal(value.status, 'stale');
    assert.equal(value.currentSupply, '814000000000000'); assert.equal(value.slot, 450_000_000); assert.equal(value.at, NOW);
  }
  f.advance(); f.set(result()); assert.equal((await f.reader.tick()).status, 'available'); f.reader.close();
});

test('timeout bounds waiting, never publishes late data, and never multiplies hung RPC calls', async () => {
  let now = NOW, resolve, calls = 0;
  const reader = new PublicBurnSupply({ now: () => now, setTimer: callback => setTimeout(callback, 5), clearTimer: clearTimeout,
    connection: { getAccountInfoAndContext: () => { calls++; return new Promise(done => { resolve = done; }); } } });
  assert.equal((await reader.tick()).status, 'unavailable'); now += 600_000;
  await Promise.all(Array.from({ length: 100 }, () => reader.tick())); assert.equal(calls, 1);
  resolve(result()); await new Promise(done => setTimeout(done, 1)); assert.equal(reader.readPublic().totalBurned, null);
  reader.close();
});

test('connection factory resource closes, and closing prevents a pending valid result from publishing', async () => {
  let closed = 0, resolve;
  const reader = new PublicBurnSupply({ now: () => NOW, connectionFactory: async () => ({
    connection: { getAccountInfoAndContext: () => new Promise(done => { resolve = done; }) }, close: async () => { closed++; },
  }) });
  const pending = reader.tick(); await new Promise(done => setImmediate(done)); reader.close(); resolve(result());
  assert.equal((await pending).status, 'unavailable'); assert.equal(closed, 1); await reader.tick(); assert.equal(closed, 1);
});

test('a timed-out connection factory cannot start a late mint request and still releases its resource', async () => {
  let resolve, calls = 0, closes = 0;
  const reader = new PublicBurnSupply({ now: () => NOW, setTimer: callback => setTimeout(callback, 5), clearTimer: clearTimeout,
    connectionFactory: () => new Promise(done => { resolve = done; }) });
  assert.equal((await reader.tick()).status, 'unavailable');
  resolve({ connection: { getAccountInfoAndContext: async () => { calls++; return result(); } }, close: () => { closes++; } });
  await new Promise(done => setImmediate(done)); assert.equal(calls, 0); assert.equal(closes, 1); reader.close();
});

test('zero and fully burned supply are accurate and do not rely on truthiness', async () => {
  for (const [supply, expected, percent] of [[ORIGINAL, '0', '0.00'], [0n, ORIGINAL.toString(), '100.00']]) {
    const f = fixture(); f.set(result({ supply })); const value = await f.reader.tick();
    assert.equal(value.status, 'available'); assert.equal(value.totalBurned, expected); assert.equal(value.burnedPercent, percent); f.reader.close();
  }
});
