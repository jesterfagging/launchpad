// Deterministic holder-reward maths for AI Agent treasuries. Input is a series
// of complete finalized holder snapshots (owner -> aggregated raw balance);
// output is a frozen recipient list. No randomness, no model input.
import { largestRemainder, nonNegative } from './ledger.mjs';
import { AGENT_POLICY_V1 } from '../../public/agent-catalog.mjs';

const MINUTE = 60000;
/** Validates that the samples cover one continuous hour ending now (every gap <= 5 min, plus 30 s of scheduler slack). */
export function rewardWindow(samples, { now, windowMs = AGENT_POLICY_V1.rewards.windowMinutes * MINUTE, maxGapMs = AGENT_POLICY_V1.rewards.sampleIntervalMinutes * MINUTE + 30000 } = {}) {
  const sorted = [...samples].filter(sample => sample && sample.complete).sort((a, b) => a.at - b.at);
  if (!sorted.length) return { ok: false, reason: 'No complete holder snapshots yet.' };
  const last = sorted.at(-1); if (now - last.at > maxGapMs) return { ok: false, reason: 'The latest holder snapshot is too old.' };
  const from = now - windowMs; let start = -1;
  for (let i = 0; i < sorted.length; i++) if (sorted[i].at <= from) start = i;
  if (start < 0) return { ok: false, reason: 'Less than one hour of holder snapshots is available.' };
  const window = sorted.slice(start);
  for (let i = 1; i < window.length; i++) if (window[i].at - window[i - 1].at > maxGapMs) return { ok: false, reason: 'A gap in the holder snapshots invalidates the current window.' };
  return { ok: true, from: window[0].at, to: last.at, samples: window };
}
/** Minimum observed balance per owner across every sample (an owner missing from any sample has no minimum). */
export function minimumBalances(samples) {
  const minima = new Map();
  samples.forEach((sample, index) => {
    const seen = new Set();
    for (const row of sample.rows || []) { const amount = nonNegative(row.amount, 'Balance'); seen.add(row.owner); if (index === 0) minima.set(row.owner, amount); else if (minima.has(row.owner) && amount < minima.get(row.owner)) minima.set(row.owner, amount); }
    for (const owner of [...minima.keys()]) if (!seen.has(owner)) minima.delete(owner);
  });
  return minima;
}
/** Top holders by minimum balance, address ascending as the tie-break, after exclusions. */
export function topHolders(minima, { limit = AGENT_POLICY_V1.rewards.topHolders, exclude = new Set() } = {}) {
  return [...minima].filter(([owner, amount]) => amount > 0n && !exclude.has(owner)).sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : (a[1] > b[1] ? -1 : 1))).slice(0, limit).map(([owner, weight]) => ({ owner, weight }));
}
/** Integer largest-remainder allocation of the total over the frozen recipient list. */
export function allocateRewards(totalLamports, holders) {
  const shares = largestRemainder(totalLamports, holders.map(row => ({ key: row.owner, weight: row.weight })));
  return holders.map((row, index) => ({ owner: row.owner, weight: row.weight.toString(), lamports: shares[index].amount }));
}
/** Public, non-identifying summary of the latest snapshot. */
export function holderSummary(sample, { exclude = new Set() } = {}) {
  if (!sample) return null;
  const rows = (sample.rows || []).filter(row => !exclude.has(row.owner)).map(row => BigInt(row.amount)).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const total = rows.reduce((sum, amount) => sum + amount, 0n), share = n => total > 0n ? Number(rows.slice(0, n).reduce((sum, amount) => sum + amount, 0n) * 10000n / total) / 100 : 0;
  return { holders: rows.length, at: sample.at, slot: sample.slot, complete: sample.complete === true || sample.complete === 1, top10SharePercent: share(10), top100SharePercent: share(100) };
}
