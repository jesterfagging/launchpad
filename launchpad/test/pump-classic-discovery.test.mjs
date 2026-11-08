// Pump.fun coins in public discovery: the projection keeps only verified identity
// and links, lists use the Pump.fun service's own snapshots (never Raydium), and
// hidden coins leave lists while direct links keep working for holders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { LaunchpadExplore, pumpClassicDiscoveryRecord } from '../src/launchpad-explore.mjs';
import { launchAmm } from '../public/amm-branding.mjs';
import { exploreFilters } from '../public/explore-view.mjs';

const NOW = 1790668800000, key = n => new PublicKey(Buffer.alloc(32, n)).toBase58(), SOL = 'So11111111111111111111111111111111111111112';
const row = extra => ({ platform: 'pump-classic', status: 'trading', id: 'ab'.repeat(12), creatorId: 'a'.repeat(32), mint: key(1), name: 'Orbit Garden', symbol: 'ORBIT', description: 'A garden', image: '/token-images/' + 'c'.repeat(64) + '.png', createdAt: NOW - 100000, mode: 'market_maker', bondingCurve: key(2), poolId: null, venue: 'curve', website: 'https://orbit.example', twitter: '', telegram: '', gotchi: null, agent: null, hidden: false, privateNote: 'DO_NOT_EXPOSE', ...extra });
function fixture(t, rows) {
  const account = { id: 'a'.repeat(32), username: 'orbit_maker', mainWallet: key(4) }, calls = { ray: 0, pump: 0 };
  const pumpClassic = {
    publicList: async () => rows.filter(r => !r.hidden), publicDetail: async mint => rows.find(r => r.mint === mint) || null,
    marketSnapshot: async mint => { calls.pump++; const r = rows.find(x => x.mint === mint); return { mint, curve: r.bondingCurve, quote: { mint: SOL, symbol: 'SOL', usd: 150, at: NOW, stale: false }, status: r.status === 'migrated' ? 'migrated' : 'curve', at: NOW, slot: 100, supply: 1e9, priceQuote: 0.00000003, fdvQuote: 30, priceUsd: 0.0000045, fdvUsd: 4500, raisedQuote: 3, targetQuote: 85, progressPercent: 3.5 }; },
    trades: async () => [{ time: Math.floor(NOW / 1000) - 60, side: 'buy', quote: 0.25, amount: 8000000, wallet: key(9), signature: '5'.repeat(88) }],
  };
  const service = new LaunchpadExplore({ accounts: { list: async () => [account], get: async () => account, storeFor: () => ({ read: async () => ({ launches: [] }) }) }, pumpClassic, now: () => NOW, chainFactory: async () => { calls.ray++; throw Error('Pump.fun coins must not use the Raydium reader'); }, marketData: { pools: async (_chain, mint) => ({ tokenAddress: mint, at: NOW, pools: [] }) }, history: { close() {} }, activity: { close() {} }, listWaitMs: 500 });
  t.after(() => service.close()); return { service, calls };
}

test('the Pump.fun projection validates identity, maps the option and never leaks private fields', () => {
  const record = pumpClassicDiscoveryRecord(row(), NOW);
  assert.equal(record.coin.platform, 'pump-classic'); assert.equal(record.coin.launchMode, 'pump-classic'); assert.equal(record.coin.feeMode, 'market_maker');
  assert.equal(record.coin.curve, key(2)); assert.equal(record.coin.quote.mint, SOL); assert.equal(record.coin.taxBps, 0); assert.equal(record.coin.pumpUrl, 'https://pump.fun/coin/' + key(1));
  assert.equal(record.chainRecord.input.route, 'pump-classic'); assert.deepEqual(record.coin.links, { website: 'https://orbit.example/' });
  assert.doesNotMatch(JSON.stringify(record), /DO_NOT_EXPOSE|creatorId/);
  for (const extra of [{ status: 'draft' }, { mint: 'bad' }, { bondingCurve: null }, { status: 'migrated', poolId: null }, { mode: 'buyback' }, { mode: 'gotchi', gotchi: null }, { mode: 'agent', agent: { id: 'x' } }, { createdAt: NOW + 60000 }]) assert.equal(pumpClassicDiscoveryRecord(row(extra), NOW), null, JSON.stringify(extra));
  assert.equal(pumpClassicDiscoveryRecord(row({ hidden: true }), NOW), null); assert.ok(pumpClassicDiscoveryRecord(row({ hidden: true }), NOW, { includeHidden: true }));
  const graduated = pumpClassicDiscoveryRecord(row({ status: 'migrated', poolId: key(3) }), NOW); assert.equal(graduated.coin.poolId, key(3));
  const gotchi = pumpClassicDiscoveryRecord(row({ mode: 'gotchi', gotchi: { id: 'fomogotchi', theme: 'fomogotchi' } }), NOW); assert.equal(gotchi.coin.gotchi.id, 'fomogotchi');
});

test('a Pump.fun coin on another pair is listed with that pair; rows from before pairs are SOL coins', () => {
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', XSTOCK = key(7);
  const usdc = pumpClassicDiscoveryRecord(row({ quoteMint: USDC, quoteSymbol: 'USDC', quoteDecimals: 6, quoteProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', quoteName: 'USD Coin', quoteCategory: 'crypto', creatorFeeBps: 0, mode: 'creator' }), NOW);
  assert.deepEqual([usdc.coin.quote.mint, usdc.coin.quote.symbol, usdc.coin.quote.name, usdc.coin.quote.decimals, usdc.coin.creatorFeeBps, usdc.chainRecord.input.quoteMint, usdc.chainRecord.review.quoteDecimals], [USDC, 'USDC', 'USD Coin', 6, null, USDC, 6]);
  const custom = pumpClassicDiscoveryRecord(row({ quoteMint: XSTOCK, quoteSymbol: 'EXMx', quoteDecimals: 8, quoteProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', quoteName: 'Example xStock', quoteCategory: 'custom', creatorFeeBps: 250, mode: 'holders' }), NOW);
  assert.deepEqual([custom.coin.quote.symbol, custom.coin.quote.category, custom.coin.creatorFeeBps], ['EXMx', 'custom', 250], 'the creator-chosen creator fee is a public coin parameter');
  assert.equal(pumpClassicDiscoveryRecord(row({ quoteMint: USDC, quoteDecimals: 99 }), NOW), null);
  assert.equal(pumpClassicDiscoveryRecord(row({ quoteMint: 'not-a-mint', quoteDecimals: 6 }), NOW), null);
  assert.equal(pumpClassicDiscoveryRecord(row(), NOW).coin.quote.mint, SOL, 'v71.18 rows carry no pair fields');
});

test('lists, activity and rewards for Pump.fun coins use the Pump.fun service only', async t => {
  const h = fixture(t, [row()]);
  const list = await h.service.list({ launchMode: 'pump-classic' });
  assert.equal(list.total, 1); assert.equal(list.coins[0].marketSource, 'Pump.fun onchain'); assert.equal(list.coins[0].fdvUsd, 4500); assert.equal(h.calls.ray, 0); assert.ok(h.calls.pump > 0);
  assert.equal((await h.service.list({ launchMode: 'raydium' })).total, 0);
  const trades = await h.service.trades(key(1)); assert.equal(trades.trades.length, 1); assert.match(trades.note, /Pump\.fun/);
  assert.equal((await h.service.rewards(key(1))).mode, 'none', 'rewards and strategies live in the Pump.fun coin panel');
});

test('hidden Pump.fun coins leave public lists while holders can still open them', async t => {
  const h = fixture(t, [row({ hidden: true })]);
  assert.equal((await h.service.list()).total, 0);
  assert.equal((await h.service.find(key(1))).coin.platform, 'pump-classic');
});

test('explore filters and AMM badges name Pump.fun coins', () => {
  assert.equal(launchAmm({ platform: 'pump-classic' }), 'pump-classic');
  assert.equal(exploreFilters(new URLSearchParams('launchMode=pump-classic')).launchMode, 'pump-classic');
});
