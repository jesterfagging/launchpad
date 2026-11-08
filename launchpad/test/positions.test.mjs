import test from 'node:test';
import assert from 'node:assert/strict';
import { SOL } from '../src/core.mjs';
import { Providers } from '../src/providers.mjs';
import { captureEntryCost, costBasisFromFill, summarizePositions } from '../src/positions.mjs';

const now = 100000, mint = 'asset', btc = 'bitcoin', wallet = 'wallet';
const market = (price, extra = {}) => ({ price, receivedAt: now, symbol: 'TOKEN', ...extra });
const markets = () => new Map([[SOL, market(100, { symbol: 'SOL' })], [mint, market(5)], [btc, market(50000)]]);
const basis = (inputAmount, extra = {}) => ({ version: 1, inputMint: SOL, inputAmount: String(inputAmount), inputDecimals: 9,
  inputPriceUsd: 100, solPriceUsd: 100, estimated: false, source: 'confirmed-native-debit', ...extra });
const lot = (extra = {}) => ({ id: 'buy1', wallet, walletLabel: 'Follower 1', mint, decimals: 6, remaining: '100000000', original: '100000000', costBasis: basis(2000000000n), ...extra });
const token = (mint, raw, index, owner = wallet, decimals = 6) => ({ mint, owner, accountIndex: index, uiTokenAmount: { amount: String(raw), decimals } });
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-10, `${actual} should be ${expected}`);

test('position average entry weights fills and wallets by remaining tokens after partial sales', () => {
  const lots = [lot(), lot({ id: 'buy2', original: '300000000', remaining: '150000000', costBasis: basis(12000000000n) }),
    lot({ id: 'buy3', wallet: 'second', walletLabel: 'Follower 2', original: '50000000', remaining: '50000000', costBasis: basis(1000000000n) })];
  const before = structuredClone(lots), view = summarizePositions(lots, markets(), { now });
  assert.deepEqual(lots, before, 'view calculations cannot change held amounts or historical cost');
  const summary = view.positionSummary, group = summary.groups[0], first = group.wallets[0];
  assert.equal(summary.openCount, 1); assert.equal(summary.positionCount, 2); assert.equal(summary.pricedCount, 1); assert.equal(summary.costedCount, 1);
  assert.equal(group.balance, '300'); assert.equal(first.balance, '250');
  close(first.avgEntrySol, .032); close(first.avgEntryUsd, 3.2); close(first.pnlSol, 4.5);
  close(group.avgEntrySol, .03); close(summary.totalValueSol, 15); close(summary.totalPnlSol, 6); close(summary.totalPnlUsd, 600);
  close(view.positions[1].avgEntrySol, .04); assert.equal(group.basisEstimated, false);
});

test('zero holdings disappear immediately and no positions means exact zero totals', () => {
  const summary = summarizePositions([lot({ remaining: '0' })], markets(), { now }).positionSummary;
  assert.equal(summary.openCount, 0); assert.equal(summary.positionCount, 0); assert.deepEqual(summary.groups, []);
  assert.equal(summary.totalValueSol, 0); assert.equal(summary.totalPnlSol, 0); assert.equal(summary.totalPnlUsd, 0);
});

test('outside balance reductions retain a proportionate but explicitly estimated entry basis', () => {
  const view = summarizePositions([lot({ remaining: '50000000', externalAdjusted: true })], markets(), { now });
  assert.equal(view.positions[0].costSol, 1);
  assert.equal(view.positions[0].basisEstimated, true);
  assert.equal(view.positionSummary.groups[0].basisEstimated, true);
  assert.equal(view.positionSummary.basisEstimated, true);
});

test('missing legacy cost is unknown, not its old market reference or zero', () => {
  const view = summarizePositions([lot({ costBasis: undefined, entryPrice: 1 })], markets(), { now });
  assert.equal(view.positions[0].avgEntrySol, null); assert.equal(view.positions[0].avgEntryUsd, null);
  assert.equal(view.positionSummary.totalValueSol, 5); assert.equal(view.positionSummary.totalPnlSol, null);
  assert.equal(view.positionSummary.totalPnlUsd, null); assert.equal(view.positionSummary.costedCount, 0);
});

test('old fee receipts recover explicitly estimated SOL budgets, never invented historical USD', () => {
  const feeReceipts = [{ signature: 'buy1', wallet, kind: 'copy', mint: SOL, grossAmount: '1000000000', decimals: 9 }];
  const { positions, positionSummary } = summarizePositions([lot({ costBasis: undefined, remaining: '50000000', entryPrice: 2 })], markets(), { now, feeReceipts });
  close(positions[0].avgEntrySol, .01); assert.equal(positions[0].avgEntryUsd, null);
  close(positionSummary.totalPnlSol, 2); assert.equal(positionSummary.totalPnlUsd, null);
  assert(positionSummary.basisEstimated); assert.equal(positions[0].costBasisSource, 'legacy-order-budget');
  const otherWallet = feeReceipts.map(row => ({ ...row, wallet: 'not-owner' }));
  assert.equal(summarizePositions([lot({ costBasis: undefined })], markets(), { now, feeReceipts: otherWallet }).positions[0].avgEntrySol, null);
});

test('stale or missing prices suppress incomplete totals while keeping known cost and balances', () => {
  const prices = markets(); prices.set(mint, market(5, { receivedAt: now - 30001 }));
  const result = summarizePositions([lot()], prices, { now });
  assert.equal(result.positions[0].market, null); assert.equal(result.positions[0].avgEntrySol, .02);
  assert.equal(result.positionSummary.totalValueSol, null); assert.equal(result.positionSummary.totalPnlSol, null);
  prices.set(mint, market(5)); prices.delete(SOL);
  const noSol = summarizePositions([lot()], prices, { now });
  assert.equal(noSol.positionSummary.totalValueSol, null); assert.equal(noSol.positionSummary.totalValueUsd, 500);
  assert.equal(noSol.positionSummary.pricedCount, 0);
  prices.set(SOL, market(100));
  const mixed = summarizePositions([lot(), lot({ id: 'unpriced', mint: 'missing' })], prices, { now });
  assert.equal(mixed.positionSummary.totalValueSol, null); assert.equal(mixed.positionSummary.pricedCount, 1);
  assert.equal(mixed.positionSummary.groups[0].valueSol, 5);
});

test('partial cost allocation retains fractional raw input units rather than rounding a small lot to zero', () => {
  const tiny = lot({ original: '3', remaining: '1', decimals: 0, costBasis: basis(1n) });
  const row = summarizePositions([tiny], markets(), { now }).positions[0];
  assert(row.costSol > 0); assert(Math.abs(row.costSol - 1 / 3e9) < 1e-20);
});

test('confirmed native cost cancels ATA rent, priority/base fees and configured sender tips', () => {
  const order = { kind: 'buy', inputMint: SOL, outputMint: mint, amount: '1000000000' };
  order.entryCostContext = captureEntryCost(order, markets(), { now, tipsLamports: 100000n });
  const tx = { transaction: { message: { accountKeys: [{ pubkey: wallet }, 'ata'] } },
    meta: { err: null, fee: 15000, preBalances: [3000000000, 0], postBalances: [3000000000 - 800000000 - 15000 - 100000 - 2039280, 2039280],
      preTokenBalances: [], postTokenBalances: [token(mint, 100000000, 1)] } };
  const cost = costBasisFromFill(order, 100000000n, tx, markets(), wallet);
  assert.equal(cost.inputAmount, '800000000'); assert.equal(cost.estimated, false); assert.equal(cost.inputPriceUsd, 100);
  const changedPrices = markets(); changedPrices.set(SOL, market(500));
  assert.equal(costBasisFromFill(order, 100000000n, tx, changedPrices, wallet).inputPriceUsd, 100, 'later prices do not rewrite entry');
});

test('confirmed native cost includes existing wrapped SOL and offsets closure refunds', () => {
  const order = { inputMint: SOL, outputMint: mint, amount: '1000000000' };
  order.entryCostContext = captureEntryCost(order, markets(), { now });
  const tx = { transaction: { message: { accountKeys: [wallet, 'wrapped', 'output'] } }, meta: {
    err: null, fee: 5000, preBalances: [3000000000, 1002039280, 2039280], postBalances: [3202034280, 0, 2039280],
    preTokenBalances: [token(SOL, 1000000000, 1, wallet, 9)], postTokenBalances: [token(mint, 100000000, 2)] } };
  assert.equal(costBasisFromFill(order, 100000000n, tx, markets(), wallet).inputAmount, '800000000');
});

test('unattributed new protocol account rent cannot be reported as an exact entry debit', () => {
  const order = { inputMint: SOL, outputMint: mint, amount: '1000000000' };
  order.entryCostContext = captureEntryCost(order, markets(), { now });
  const tx = { transaction: { message: { accountKeys: [wallet, 'output', 'volume-pda'] } }, meta: {
    err: null, fee: 5000, preBalances: [3000000000, 2039280, 0], postBalances: [2198995000, 2039280, 1000000],
    preTokenBalances: [], postTokenBalances: [token(mint, 100000000, 1)] } };
  const cost = costBasisFromFill(order, 100000000n, tx, markets(), wallet);
  assert.equal(cost.source, 'order-budget'); assert(cost.estimated); assert.equal(cost.inputAmount, '1000000000');
});

test('non-SOL buys use confirmed quote token debit and immutable entry conversions', () => {
  const order = { inputMint: btc, inputDecimals: 8, outputMint: mint, amount: '2000000' };
  order.entryCostContext = captureEntryCost(order, markets(), { now });
  const tx = { meta: { err: null, preTokenBalances: [token(btc, 3000000, 1, wallet, 8)],
    postTokenBalances: [token(btc, 2000000, 1, wallet, 8), token(mint, 100000000, 2)] } };
  const cost = costBasisFromFill(order, 100000000n, tx, markets(), wallet);
  assert.equal(cost.inputAmount, '1000000'); assert.equal(cost.inputDecimals, 8); assert.equal(cost.estimated, false);
  const prices = markets(); prices.set(btc, market(80000)); prices.set(SOL, market(200));
  const summary = summarizePositions([lot({ costBasis: cost })], prices, { now }).positionSummary;
  close(summary.groups[0].avgEntrySol, .05); close(summary.groups[0].avgEntryUsd, 5);
  close(summary.totalPnlSol, -2.5); close(summary.totalPnlUsd, 0);
});

test('unavailable entry quote conversion remains unknown even once a price is available', () => {
  const order = { inputMint: btc, inputDecimals: 8, outputMint: mint, amount: '1000000' };
  order.entryCostContext = captureEntryCost(order, new Map(), { now });
  const cost = costBasisFromFill(order, 100000000n, null, markets(), wallet, { paper: true });
  const row = summarizePositions([lot({ costBasis: cost })], markets(), { now }).positions[0];
  assert.equal(row.avgEntrySol, null); assert.equal(row.avgEntryUsd, null); assert.equal(row.valueUsd, 500);
});

test('incomplete native receipt or quote surplus is a labelled budget estimate, failed transaction has no cost', () => {
  const order = { inputMint: SOL, outputMint: mint, amount: '1000000000' };
  order.entryCostContext = captureEntryCost(order, markets(), { now });
  const tx = { meta: { err: null, preTokenBalances: [], postTokenBalances: [token(mint, 100000000, 1)] } };
  const cost = costBasisFromFill(order, 100000000n, tx, markets(), wallet);
  assert.equal(cost.inputAmount, '1000000000'); assert(cost.estimated); assert.equal(cost.source, 'order-budget');
  tx.meta.err = { InstructionError: [0, 'Custom'] };
  assert.equal(costBasisFromFill(order, 100000000n, tx, markets(), wallet), null);
});

test('market fetching includes SOL and uses USD prices for non-SOL pairs', async () => {
  const provider = new Providers({}, () => {}), calls = [];
  provider.fetch = async url => { calls.push(url); return [
    { chainId: 'solana', baseToken: { address: SOL, symbol: 'SOL' }, quoteToken: { address: 'usdc' }, priceUsd: '100', liquidity: { usd: 1000000 } },
    { chainId: 'solana', baseToken: { address: mint, symbol: 'TOKEN' }, quoteToken: { address: btc }, priceNative: '0.0001', priceUsd: '5', liquidity: { usd: 100000 } },
    { chainId: 'solana', baseToken: { address: mint }, priceUsd: 'Infinity', liquidity: { usd: 1e12 } },
    { chainId: 'ethereum', baseToken: { address: mint }, priceUsd: '9000', liquidity: { usd: 1e12 } },
  ]; };
  await provider.markets([mint, mint]);
  assert.equal(calls.length, 1); assert(calls[0].endsWith(`${SOL},${mint}`));
  assert.equal(provider.market.get(mint).price, 5); assert.equal(provider.market.get(mint).quoteMint, btc);
  assert.equal(summarizePositions([lot()], provider.market).positionSummary.totalValueSol, 5);
  provider.fetch = async () => []; await provider.markets([mint]);
  assert.equal(provider.market.size, 0, 'disappearing quote cannot stay falsely fresh');
});
