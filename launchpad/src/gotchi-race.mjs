// Pure race arithmetic for Gotchi Mode. No I/O, no signing, no Number math on
// money: balances are raw token units, prices are USD × 1e8 and the time-
// averaged holdings integral is USD×1e8 × milliseconds, all as BigInt strings.
import { GOTCHI_MAX_SAMPLE_GAP_MS, GOTCHI_TOP_HOLDERS, GOTCHI_WINNER_SPLIT_BPS } from '../public/gotchi-catalog.mjs';

export const RACE_STATES = Object.freeze(['open', 'closing', 'frozen', 'buying', 'distributing', 'settled']);
const NEXT = Object.freeze({ open: ['closing'], closing: ['frozen', 'open'], frozen: ['buying'], buying: ['distributing'], distributing: ['settled'], settled: [] });
const MAX_U64 = (1n << 64n) - 1n;
const fail = (message, statusCode = 400) => { throw Object.assign(Error(message), { statusCode }); };
const base58 = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
export function uint(value, label = 'amount') {
  if (typeof value === 'bigint') { if (value < 0n) fail(`Invalid ${label}.`); return value; }
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value)) fail(`Invalid ${label}.`);
  return BigInt(value);
}
export function timestamp(value, label = 'timestamp') {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8640000000000000) fail(`Invalid ${label}.`);
  return value;
}
export const USD8 = 100000000n;
// Decimal USD string or number → USD × 1e8 (rounded down). Rejects non-finite input.
export function usdToUsd8(value) {
  const text = typeof value === 'number' ? (Number.isFinite(value) && value >= 0 ? value.toFixed(8) : '') : String(value ?? '').trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) fail('Invalid USD value.');
  return BigInt(match[1]) * USD8 + BigInt((match[2] || '').slice(0, 8).padEnd(8, '0'));
}
export function usd8ToNumber(value) { return Number(uint(value)) / 1e8; }
export function holdingUsd8(amountRaw, priceUsd8, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) fail('Invalid token decimals.');
  return uint(amountRaw) * uint(priceUsd8) / 10n ** BigInt(decimals);
}

export function createRace({ index, startedAt }) {
  if (!Number.isSafeInteger(index) || index < 1) fail('Invalid race index.');
  return { index, status: 'open', startedAt: timestamp(startedAt), closedAt: null, coins: {}, scores: {}, sampleCount: 0, gaps: [], events: [{ at: startedAt, kind: 'opened' }] };
}

export function canTransition(from, to) { return Array.isArray(NEXT[from]) && NEXT[from].includes(to); }
export function transition(race, to, at, detail = {}) {
  if (!race || !RACE_STATES.includes(race.status)) fail('Invalid race state.', 409);
  if (!canTransition(race.status, to)) fail(`A ${race.status} race cannot become ${to}.`, 409);
  race.status = to; race.events = [...(race.events || []), { at: timestamp(at), kind: to, ...detail }].slice(-200);
  return race;
}

function coinState(race, mint) {
  if (!base58(mint)) fail('Invalid race coin mint.');
  return race.coins[mint] ||= { graduatedAt: null, firstSampleAt: null, lastSampleAt: null, lastPriceUsd8: null, lastPriceAt: null, decimals: null, balances: {}, samples: 0 };
}
function addScore(scores, owner, value) {
  if (value <= 0n) return;
  scores[owner] = (BigInt(scores[owner] || '0') + value).toString();
}
// Left-rectangle integration of the previous sample over [lastSampleAt, at].
function integrate(race, coin, mint, at, scores, maxGapMs) {
  if (coin.lastSampleAt === null) return;
  const dt = at - coin.lastSampleAt;
  if (dt <= 0) return;
  if (dt > maxGapMs || coin.lastPriceUsd8 === null) { race.gaps = [...(race.gaps || []), { mint, from: coin.lastSampleAt, to: at, reason: coin.lastPriceUsd8 === null ? 'price-unavailable' : 'sample-gap' }].slice(-500); return; }
  // Multiply before the single division so dust-sized holdings are not
  // truncated to zero per interval; BigInt keeps the product exact.
  const price = BigInt(coin.lastPriceUsd8), scale = 10n ** BigInt(coin.decimals), weight = BigInt(dt);
  for (const [owner, amount] of Object.entries(coin.balances)) addScore(scores, owner, BigInt(amount) * price * weight / scale);
}

// A sample is one finalized holder scan of one graduated coin plus the USD
// price observed at the same time. Rows must already exclude custody wallets.
// priceUsd8 may be null when no fresh price exists; the last price carries
// forward for at most maxGapMs, after which the interval counts for nobody.
export function applySample(race, { mint, at, graduatedAt, priceUsd8, priceAt, decimals, rows }, { maxGapMs = GOTCHI_MAX_SAMPLE_GAP_MS } = {}) {
  if (race.status !== 'open' && race.status !== 'closing') fail('Samples apply to an open race only.', 409);
  timestamp(at, 'sample time');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) fail('Invalid token decimals.');
  if (!Array.isArray(rows) || rows.length > 200000) fail('Invalid holder sample.');
  const coin = coinState(race, mint);
  if (coin.decimals !== null && coin.decimals !== decimals) fail('Token decimals changed between samples.', 409);
  if (coin.lastSampleAt !== null && at <= coin.lastSampleAt) fail('Samples must advance in time.', 409);
  const balances = {};
  for (const row of rows) {
    if (!base58(row?.owner)) fail('Invalid holder owner.');
    const amount = uint(row.amount, 'holder balance');
    if (amount === 0n) continue;
    const next = BigInt(balances[row.owner] || '0') + amount;
    if (next > MAX_U64) fail('Holder balance exceeds token limits.');
    balances[row.owner] = next.toString();
  }
  integrate(race, coin, mint, at, race.scores, maxGapMs);
  let price = null, observedAt = null;
  if (priceUsd8 !== null && priceUsd8 !== undefined) { price = uint(priceUsd8, 'price').toString(); observedAt = timestamp(priceAt ?? at, 'price time'); }
  else if (coin.lastPriceUsd8 !== null && coin.lastPriceAt !== null && at - coin.lastPriceAt <= maxGapMs) { price = coin.lastPriceUsd8; observedAt = coin.lastPriceAt; }
  coin.graduatedAt = coin.graduatedAt ?? (graduatedAt ? timestamp(graduatedAt, 'graduation time') : null);
  coin.firstSampleAt ??= at; coin.lastSampleAt = at; coin.lastPriceUsd8 = price; coin.lastPriceAt = observedAt; coin.decimals = decimals; coin.balances = balances; coin.samples += 1;
  race.sampleCount += 1;
  return race;
}

// Scores at a cutoff. The last sample of every coin extends to the cutoff
// (bounded by the same gap rule); nothing is extrapolated beyond that.
export function finalizeScores(race, closeAt, { maxGapMs = GOTCHI_MAX_SAMPLE_GAP_MS } = {}) {
  timestamp(closeAt, 'cutoff');
  if (closeAt < race.startedAt) fail('The cutoff precedes the race start.');
  const scores = Object.fromEntries(Object.entries(race.scores || {}).map(([owner, value]) => [owner, uint(value).toString()]));
  const shadow = { gaps: [] };
  for (const [mint, saved] of Object.entries(race.coins || {})) {
    const coin = { ...saved, balances: saved.balances || {} };
    if (coin.lastSampleAt !== null && closeAt > coin.lastSampleAt) integrate(shadow, coin, mint, closeAt, scores, maxGapMs);
  }
  const duration = Math.max(1, closeAt - race.startedAt);
  return { scores, duration, tailGaps: shadow.gaps };
}

// Rank by integral (equivalently by time-average, the duration is shared).
// Deterministic: higher score first, then the lexically smaller address.
export function rankHolders(scores, { limit = GOTCHI_TOP_HOLDERS, exclude = new Set() } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('Invalid holder limit.');
  const rows = [];
  for (const [owner, value] of Object.entries(scores || {})) {
    if (!base58(owner) || exclude.has(owner)) continue;
    const score = uint(value);
    if (score > 0n) rows.push({ owner, score });
  }
  rows.sort((a, b) => a.score === b.score ? (a.owner < b.owner ? -1 : 1) : a.score > b.score ? -1 : 1);
  const total = rows.reduce((sum, row) => sum + row.score, 0n);
  return { winners: rows.slice(0, limit).map(row => ({ owner: row.owner, score: row.score.toString() })), eligible: rows.length, totalScore: total.toString() };
}

export function averageHoldingUsd(score, durationMs) {
  const value = uint(score), duration = BigInt(Math.max(1, Number(durationMs) || 1));
  return Number(value / duration) / 1e8;
}

// Winner: the graduated coin with the highest USD market cap at the cutoff.
// Ties break by earlier graduation, then by the lexically smaller mint. Coins
// without a fresh valuation are reported, never guessed.
export function selectWinner(coins) {
  if (!Array.isArray(coins)) fail('Invalid winner candidates.');
  const valued = [], unvalued = [];
  for (const coin of coins) {
    if (!base58(coin?.mint)) fail('Invalid candidate mint.');
    const cap = Number(coin.marketCapUsd);
    if (Number.isFinite(cap) && cap > 0) valued.push({ mint: coin.mint, marketCapUsd: cap, graduatedAt: Number.isSafeInteger(coin.graduatedAt) ? coin.graduatedAt : null, valuedAt: coin.valuedAt ?? null, source: coin.source || null });
    else unvalued.push({ mint: coin.mint, reason: coin.reason || 'No fresh valuation at the cutoff.' });
  }
  valued.sort((a, b) => b.marketCapUsd - a.marketCapUsd || (a.graduatedAt ?? Infinity) - (b.graduatedAt ?? Infinity) || (a.mint < b.mint ? -1 : 1));
  return { winner: valued[0] || null, ranked: valued, unvalued };
}

// Split the spendable pot after a disclosed reserve for distribution costs.
export function splitPot({ spendableLamports, reserveLamports, splitBps = GOTCHI_WINNER_SPLIT_BPS }) {
  const spendable = uint(spendableLamports, 'spendable pot'), reserve = uint(reserveLamports, 'reserve');
  if (!Number.isInteger(splitBps) || splitBps < 0 || splitBps > 10000) fail('Invalid pot split.');
  const distributable = spendable > reserve ? spendable - reserve : 0n;
  const buyLamports = distributable * BigInt(splitBps) / 10000n;
  return { distributable: distributable.toString(), buyLamports: buyLamports.toString(), solLamports: (distributable - buyLamports).toString(), reserveLamports: reserve.toString() };
}

// Proportional shares with integer division. Remainders are returned, never
// assigned to an arbitrary recipient. A zero-weight list distributes nothing.
export function payoutPlan({ winners, solLamports, tokensRaw }) {
  if (!Array.isArray(winners) || winners.length > 100) fail('Invalid winner list.');
  const sol = uint(solLamports, 'SOL share'), tokens = uint(tokensRaw, 'token share');
  const rows = winners.map(row => { if (!base58(row?.owner)) fail('Invalid winner wallet.'); return { owner: row.owner, score: uint(row.score, 'score') }; });
  if (new Set(rows.map(row => row.owner)).size !== rows.length) fail('Duplicate winner wallet.');
  const total = rows.reduce((sum, row) => sum + row.score, 0n);
  if (total === 0n) return { payouts: [], solRemainder: sol.toString(), tokenRemainder: tokens.toString(), totalScore: '0' };
  const payouts = rows.map(row => ({ owner: row.owner, score: row.score.toString(), lamports: (sol * row.score / total).toString(), tokens: (tokens * row.score / total).toString() }));
  const paidSol = payouts.reduce((sum, row) => sum + BigInt(row.lamports), 0n), paidTokens = payouts.reduce((sum, row) => sum + BigInt(row.tokens), 0n);
  return { payouts, solRemainder: (sol - paidSol).toString(), tokenRemainder: (tokens - paidTokens).toString(), totalScore: total.toString() };
}

export function raceView(race, { durationMs = null, now = Date.now() } = {}) {
  if (!race) return null;
  const duration = durationMs ?? Math.max(1, (race.closedAt || now) - race.startedAt);
  return { index: race.index, status: race.status, startedAt: race.startedAt, closedAt: race.closedAt || null, durationMs: duration, sampleCount: race.sampleCount || 0, gapCount: (race.gaps || []).length, coins: Object.fromEntries(Object.entries(race.coins || {}).map(([mint, coin]) => [mint, { graduatedAt: coin.graduatedAt, firstSampleAt: coin.firstSampleAt, lastSampleAt: coin.lastSampleAt, samples: coin.samples, holders: Object.keys(coin.balances || {}).length }])) };
}
