import test from 'node:test';
import assert from 'node:assert/strict';
import { createRace, applySample, finalizeScores, rankHolders, selectWinner, splitPot, payoutPlan, transition, canTransition, usdToUsd8, holdingUsd8, averageHoldingUsd } from '../src/gotchi-race.mjs';
import { evolutionStage, milestoneProgress, gotchiFundingSummary, validGotchiId, GOTCHI_THEMES } from '../public/gotchi-catalog.mjs';

const A = '7rvRFpzP5W18yZcNpPNqtWgPTxLaFrnutz5QPxXpyupc', B = 'Bz3zS37oQ3vm8itxXxsXGJPKyQnHii3xMroaA9hZCwEb', C = 'So11111111111111111111111111111111111111112';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', MINT2 = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const HOUR = 3600000, usd = value => usdToUsd8(value).toString();

test('usd fixed point conversions', () => {
  assert.equal(usd('1'), '100000000');
  assert.equal(usd(0.5), '50000000');
  assert.equal(usd('0.000000019'), '1');
  assert.equal(holdingUsd8('1000000', usd('2'), 6).toString(), '200000000');
  assert.throws(() => usdToUsd8('abc'));
  assert.throws(() => usdToUsd8(-1));
});

test('time-averaged holdings use the previous sample over each interval', () => {
  const race = createRace({ index: 1, startedAt: 0 + 1 });
  const start = 1;
  applySample(race, { mint: MINT, at: start, graduatedAt: start, priceUsd8: usd('1'), decimals: 6, rows: [{ owner: A, amount: '1000000' }, { owner: B, amount: '3000000' }] });
  assert.equal(Object.keys(race.scores).length, 0, 'the first sample integrates nothing');
  applySample(race, { mint: MINT, at: start + HOUR, priceUsd8: usd('2'), decimals: 6, rows: [{ owner: A, amount: '2000000' }] });
  // Previous balances at the previous price: A $1 × 1h, B $3 × 1h.
  assert.equal(race.scores[A], (100000000n * BigInt(HOUR)).toString());
  assert.equal(race.scores[B], (300000000n * BigInt(HOUR)).toString());
  const final = finalizeScores(race, start + 2 * HOUR);
  // A now holds 2 tokens at $2 for the last hour: +$4h. B sold: nothing more.
  assert.equal(final.scores[A], (100000000n * BigInt(HOUR) + 400000000n * BigInt(HOUR)).toString());
  assert.equal(final.scores[B], (300000000n * BigInt(HOUR)).toString());
  assert.equal(final.duration, 2 * HOUR);
  assert.equal(averageHoldingUsd(final.scores[A], final.duration), 2.5);
  assert.equal(race.status, 'open');
});

test('gaps beyond the limit and missing prices contribute nothing', () => {
  const race = createRace({ index: 1, startedAt: 1 });
  applySample(race, { mint: MINT, at: 1, priceUsd8: usd('1'), decimals: 6, rows: [{ owner: A, amount: '1000000' }] });
  applySample(race, { mint: MINT, at: 1 + 3 * HOUR, priceUsd8: usd('1'), decimals: 6, rows: [{ owner: A, amount: '1000000' }] }, { maxGapMs: 2 * HOUR });
  assert.equal(race.scores[A], undefined);
  assert.equal(race.gaps.length, 1);
  assert.equal(race.gaps[0].reason, 'sample-gap');
  // No price: the previous price carries forward within the gap limit.
  applySample(race, { mint: MINT, at: 1 + 4 * HOUR, priceUsd8: null, decimals: 6, rows: [{ owner: A, amount: '1000000' }] }, { maxGapMs: 2 * HOUR });
  assert.equal(race.scores[A], (100000000n * BigInt(HOUR)).toString());
  assert.equal(race.coins[MINT].lastPriceUsd8, usd('1'));
  // Price still missing after the limit: the next interval is a documented gap.
  applySample(race, { mint: MINT, at: 1 + 7 * HOUR, priceUsd8: null, decimals: 6, rows: [{ owner: A, amount: '1000000' }] }, { maxGapMs: 2 * HOUR });
  assert.equal(race.coins[MINT].lastPriceUsd8, null);
  applySample(race, { mint: MINT, at: 1 + 8 * HOUR, priceUsd8: usd('1'), decimals: 6, rows: [{ owner: A, amount: '1000000' }] }, { maxGapMs: 2 * HOUR });
  assert.equal(race.gaps.at(-1).reason, 'price-unavailable');
  assert.equal(race.scores[A], (100000000n * BigInt(HOUR)).toString());
});

test('samples reject regressions, decimal changes and invalid rows', () => {
  const race = createRace({ index: 2, startedAt: 10 });
  applySample(race, { mint: MINT, at: 10, priceUsd8: usd('1'), decimals: 6, rows: [] });
  assert.throws(() => applySample(race, { mint: MINT, at: 10, priceUsd8: usd('1'), decimals: 6, rows: [] }), /advance in time/);
  assert.throws(() => applySample(race, { mint: MINT, at: 11, priceUsd8: usd('1'), decimals: 9, rows: [] }), /decimals changed/);
  assert.throws(() => applySample(race, { mint: MINT, at: 11, priceUsd8: usd('1'), decimals: 6, rows: [{ owner: 'nope', amount: '1' }] }), /Invalid holder owner/);
  assert.throws(() => applySample(race, { mint: MINT, at: 11, priceUsd8: usd('1'), decimals: 6, rows: [{ owner: A, amount: '-1' }] }), /Invalid holder balance/);
  transition(race, 'closing', 11); transition(race, 'frozen', 12);
  assert.throws(() => applySample(race, { mint: MINT, at: 13, priceUsd8: usd('1'), decimals: 6, rows: [] }), /open race/);
});

test('multiple coins aggregate per owner and ranking is deterministic', () => {
  const race = createRace({ index: 1, startedAt: 1 });
  applySample(race, { mint: MINT, at: 1, priceUsd8: usd('1'), decimals: 6, rows: [{ owner: A, amount: '1000000' }, { owner: B, amount: '1000000' }] });
  applySample(race, { mint: MINT2, at: 1, priceUsd8: usd('10'), decimals: 9, rows: [{ owner: B, amount: '100000000' }, { owner: C, amount: '100000000' }] });
  const final = finalizeScores(race, 1 + HOUR);
  const ranked = rankHolders(final.scores, { limit: 10, exclude: new Set([C]) });
  assert.deepEqual(ranked.winners.map(row => row.owner), [B, A]);
  assert.equal(ranked.eligible, 2);
  // Equal scores order by address.
  const tie = rankHolders({ [B]: '5', [A]: '5', [C]: '7' });
  assert.deepEqual(tie.winners.map(row => row.owner), [C, A, B]);
  assert.deepEqual(rankHolders({ [A]: '0' }).winners, []);
  assert.throws(() => rankHolders({}, { limit: 0 }));
});

test('winner selection is the highest market cap with deterministic ties', () => {
  const result = selectWinner([
    { mint: MINT, marketCapUsd: 5000, graduatedAt: 20 },
    { mint: MINT2, marketCapUsd: 5000, graduatedAt: 10 },
    { mint: C, marketCapUsd: null, reason: 'stale' },
  ]);
  assert.equal(result.winner.mint, MINT2);
  assert.equal(result.unvalued.length, 1);
  assert.equal(selectWinner([]).winner, null);
  assert.throws(() => selectWinner([{ mint: 'x', marketCapUsd: 1 }]));
});

test('pot split and payout plan never exceed the budget or invent recipients', () => {
  const split = splitPot({ spendableLamports: '1000000001', reserveLamports: '1' });
  assert.deepEqual(split, { distributable: '1000000000', buyLamports: '500000000', solLamports: '500000000', reserveLamports: '1' });
  assert.equal(splitPot({ spendableLamports: '5', reserveLamports: '10' }).distributable, '0');
  const plan = payoutPlan({ winners: [{ owner: A, score: '2' }, { owner: B, score: '1' }], solLamports: '100', tokensRaw: '7' });
  assert.deepEqual(plan.payouts, [{ owner: A, score: '2', lamports: '66', tokens: '4' }, { owner: B, score: '1', lamports: '33', tokens: '2' }]);
  assert.equal(plan.solRemainder, '1'); assert.equal(plan.tokenRemainder, '1');
  assert.deepEqual(payoutPlan({ winners: [], solLamports: '9', tokensRaw: '9' }), { payouts: [], solRemainder: '9', tokenRemainder: '9', totalScore: '0' });
  assert.throws(() => payoutPlan({ winners: [{ owner: A, score: '1' }, { owner: A, score: '1' }], solLamports: '1', tokensRaw: '1' }), /Duplicate/);
});

test('race state machine only moves forward', () => {
  const race = createRace({ index: 1, startedAt: 1 });
  assert.ok(canTransition('open', 'closing')); assert.ok(!canTransition('open', 'buying'));
  transition(race, 'closing', 2); transition(race, 'open', 3); transition(race, 'closing', 4); transition(race, 'frozen', 5); transition(race, 'buying', 6); transition(race, 'distributing', 7); transition(race, 'settled', 8);
  assert.throws(() => transition(race, 'open', 9), /cannot become/);
  assert.equal(race.events.at(-1).kind, 'settled');
});

test('catalogue helpers', () => {
  assert.equal(evolutionStage(0), 1); assert.equal(evolutionStage(2499.99), 1); assert.equal(evolutionStage(2500), 2); assert.equal(evolutionStage(5000), 3); assert.equal(evolutionStage(99999), 3);
  assert.deepEqual(milestoneProgress(1250).reached, []); assert.equal(milestoneProgress(1250).next, 2500); assert.equal(milestoneProgress(1250).percentToNext, 50);
  assert.equal(milestoneProgress(10000).next, null); assert.equal(milestoneProgress(10000).percentToGoal, 100);
  assert.ok(validGotchiId('fomogotchi')); assert.ok(!validGotchiId('dogegotchi')); assert.equal(GOTCHI_THEMES.length, 2);
  const meteora = gotchiFundingSummary('meteora'), raydium = gotchiFundingSummary('raydium');
  assert.ok(Math.abs(meteora.potPercent - 1.008) < 1e-9); assert.ok(Math.abs(meteora.protocolPercent - 1.008) < 1e-9);
  assert.equal(raydium.transferTaxPercent, 1); assert.ok(Math.abs(raydium.potPercent - 0.95) < 1e-9);
});
