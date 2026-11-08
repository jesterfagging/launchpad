import test from 'node:test';
import assert from 'node:assert/strict';
import { PositionMarketFeed } from '../src/position-feed.mjs';
import { SOL } from '../src/core.mjs';
import { mint, quote } from './fixtures.mjs';

test('dashboard price refresh coalesces viewers and updates after its cache interval', async () => {
  let now = 10000; const calls = [];
  const feed = new PositionMarketFeed({ now: () => now, readMarkets: async keys => {
    calls.push(keys); return new Map(keys.map(key => [key, { price: calls.length, receivedAt: now }]));
  } });
  const [first, second] = await Promise.all([feed.prices([mint]), feed.prices([mint, quote])]);
  assert.equal(calls.length, 1); assert.deepEqual(new Set(calls[0]), new Set([SOL, mint, quote]));
  assert.equal(first.get(mint).price, 1); assert.equal(second.get(quote).price, 1);
  await feed.prices([mint]); assert.equal(calls.length, 1);
  now += 5000;
  const refreshed = await feed.prices([mint]); assert.equal(calls.length, 2); assert.equal(refreshed.get(mint).price, 2);
  feed.close(); assert.equal((await feed.prices([mint])).size, 0);
});

test('price outages retain their original timestamp, back off, and recover without blocking positions', async () => {
  let now = 10000, fail = false, calls = 0;
  const feed = new PositionMarketFeed({ now: () => now, readMarkets: async keys => {
    calls++; if (fail) throw Error('Provider unavailable');
    return new Map(keys.map(key => [key, { price: 10, receivedAt: now }]));
  } });
  await feed.prices([mint]); now += 6000; fail = true;
  const stale = await feed.prices([mint]); assert.equal(stale.get(mint).receivedAt, 10000);
  await feed.prices([mint]); assert.equal(calls, 2);
  now += 6000; fail = false; assert.equal((await feed.prices([mint])).get(mint).receivedAt, now);
  feed.close();
});

test('dashboard price keys cannot inject URLs and Stop cancels price reads', async () => {
  const calls = []; let release;
  const entered = new Promise(resolve => { release = resolve; });
  const feed = new PositionMarketFeed({ readMarkets: async (keys, signal) => {
    calls.push(keys); release();
    await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(Error('Stopped')), { once: true }); });
  } });
  const result = feed.prices([mint, 'https://private.invalid/?secret=x', '../bad']);
  await entered; feed.close(); assert.equal((await result).size, 0);
  assert.deepEqual(calls[0], [SOL, mint]);
});
