// AI Agent objectives (v71.27): the deterministic programs the platform runs for
// an agent, the proposal limiter, the schema migration that gives every older
// agent objective 'custom', the directory tools and the service surface
// (launch validation, revise, public views). Rules are exercised through the
// pure evaluator with a fixed clock and synthetic evidence; the end-to-end
// checks use the same mocked chain and launch book as the service tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { evaluateObjectiveProgram, recordProgramOutcome, modelProposalLimit, programStatus, normalizeProgramState, resetProgramSchedule, volumeTrend, experimentWindow, boundedAmount, runObjectivePrograms, PROGRAM_RULES, nextUtcDay } from '../src/agent/programs.mjs';
import { MIGRATIONS, AGENT_SCHEMA_VERSION, openAgentDatabase } from '../src/agent/db.mjs';
import { AgentStore } from '../src/agent/store.mjs';
import { AGENT_POLICY_HASH, AGENT_POLICY_V2, AGENT_POLICY_V2_HASH, treasuryCaps, priceMicro, dayKey } from '../src/agent/policy.mjs';
import { AgentService } from '../src/agent/service.mjs';
import { InlineWorker, coinSnapshot } from '../src/agent/runner.mjs';
import { dryRunModel } from '../src/agent/loop.mjs';
import { ModelRegistry } from '../src/agent/openrouter.mjs';
import { TOOL_SCHEMAS, DATA_TOOLS } from '../src/agent/tools.mjs';
import { systemPrompt, taskPrompt } from '../src/agent/prompt.mjs';
import { AGENT_MODE, AGENT_POLICY_V1, AGENT_RATE_CARD_V1, AGENT_OBJECTIVES, AGENT_OBJECTIVE_GROUPS, AGENT_TOOLS, capabilityMask, objectiveById } from '../public/agent-catalog.mjs';

const HOUR = 3600000, DAY = 86400000, MIN = 60000;
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0); // 2026-10-10 12:00 UTC
const BOTH = capabilityMask({ buyback: true, rewards: true }), BUYBACK = capabilityMask({ buyback: true }), REWARDS = capabilityMask({ rewards: true }), NONE = capabilityMask({});
// Synthetic caps wide enough that the rule amount, not the policy, decides (one test uses the real caps).
const CAPS = { perAction: 10_000_000_000n, hourly: 20_000_000_000n, daily: 50_000_000_000n, minimumPrincipal: 25_000_000n, gasReserve: 10_000_000n, baseline: 0n };
const RESERVES = { buyback_burn: 7_000_000n, holder_reward: 125_000_000n };
const GAS = BigInt(AGENT_POLICY_V1.treasury.gasReserveLamports);
const SOL = (value, extra = '') => ({ availableLamports: String(BigInt(Math.round(value * 1e9))), reservedLamports: extra ? String(BigInt(Math.round(extra * 1e9))) : '0', frozenLamports: '0' });
const BASE = 100_000_000_000n - GAS; // 100 SOL treasury after the gas reserve
const input = (over = {}) => ({ objective: 'long_game', settings: {}, state: {}, now: NOW, createdAt: NOW - 30 * DAY, capabilities: BOTH, treasury: SOL(100), caps: CAPS, spent: { hour: 0n, day: 0n }, reserves: RESERVES, market: null, history: [], income: '0', openActions: 0, ...over });
const market = (over = {}) => ({ priceUsd: 0.001, marketCapUsd: 1_000_000, volume24hUsd: 50_000, priceChange24h: 0, progressPercent: 40, graduated: false, stale: false, at: NOW, ...over });
const history = volumes => volumes.map((volume, index) => ({ dayKey: dayKey(NOW - index * DAY), at: NOW - index * DAY, volume24hUsd: volume }));
const only = result => { assert.equal(result.proposals.length, 1, result.note); return result.proposals[0]; };
const none = (result, pattern) => { assert.equal(result.proposals.length, 0, JSON.stringify(result.proposals)); assert.match(result.note, pattern); assert.equal(result.state.lastNote, result.note); return result; };

test('objectives without a program, unmet needs, finished programs and missing inputs never propose and leave a reason', () => {
  for (const id of ['custom', 'survivor', 'open_ledger', 'meme_engine', 'lore_keeper', 'connector', 'plain_truth', 'culture_first']) none(evaluateObjectiveProgram(input({ objective: id })), /No program/);
  none(evaluateObjectiveProgram(input({ objective: 'patience' })), /Limiter only/);
  none(evaluateObjectiveProgram(input({ objective: 'metronome', capabilities: NONE })), /Needs buy-and-burn/);
  none(evaluateObjectiveProgram(input({ objective: 'holders_first', capabilities: BUYBACK })), /Needs holder rewards/);
  none(evaluateObjectiveProgram(input({ objective: 'milestones', capabilities: NONE })), /Needs buy-and-burn or holder rewards/);
  const finished = evaluateObjectiveProgram(input({ objective: 'metronome', state: { finished: true, finishedReason: 'Done.' } })); none(finished, /Finished: Done\./); assert.equal(finished.state.finished, true);
  none(evaluateObjectiveProgram(input({ objective: 'metronome', openActions: 1 })), /still in progress/);
  none(evaluateObjectiveProgram(input({ objective: 'metronome', caps: null })), /fresh SOL\/USD price/);
  none(evaluateObjectiveProgram(input({ objective: 'metronome', treasury: SOL(0.01) })), /only its gas reserve/);
  const gated = evaluateObjectiveProgram(input({ objective: 'metronome', state: { nextDueAt: NOW + HOUR, lastNote: 'Proposal rejected: no route.' } }));
  none(gated, /Proposal rejected: no route/); assert.equal(gated.state.nextDueAt, NOW + HOUR);
  const state = evaluateObjectiveProgram(input({ objective: 'metronome' })).state;
  for (const key of ['lastRunAt', 'nextDueAt', 'lastNote', 'actions', 'lastActionAt', 'dayKey', 'daySpentLamports', 'finished', 'launchMarketCapUsd', 'milestonesHit']) assert.ok(key in state, key);
  assert.equal(state.lastRunAt, NOW); assert.equal(state.dayKey, '2026-10-10');
});

test('long game: 2% only with 7 days of samples above the 30-day average, 7 days apart, keeping 40% in SOL', () => {
  none(evaluateObjectiveProgram(input()), /0 of 7 daily volume samples/);
  none(evaluateObjectiveProgram(input({ history: history([1, 1, 1, 1, 1, 1, 1].map(() => 1000)) })), /7 of 14 daily samples for the 30-day/);
  const flat = history(Array(14).fill(1000)); none(evaluateObjectiveProgram(input({ history: flat })), /not above the 30-day average/);
  const rising = history([...Array(7).fill(1200), ...Array(7).fill(800)]);
  const proposal = only(evaluateObjectiveProgram(input({ history: rising })));
  assert.equal(proposal.kind, 'buyback_burn'); assert.equal(proposal.lamports, (BASE * 200n / 10000n).toString()); assert.equal(proposal.amountSol, 1.9998); assert.match(proposal.reason, /^Long game program: 7-day volume \(\$1,200\/day\) is above the 30-day average \(\$1,000\/day\)/);
  assert.equal(volumeTrend(rising, NOW).average30d, 1000);
  // A sample older than the 8-day window does not count toward the week; duplicates of a day count once.
  const gappy = [...history(Array(6).fill(1200)), ...Array.from({ length: 9 }, (_, index) => ({ dayKey: dayKey(NOW - (9 + index) * DAY), volume24hUsd: 800 }))]; none(evaluateObjectiveProgram(input({ history: gappy })), /6 of 7/);
  none(evaluateObjectiveProgram(input({ history: [...rising.slice(1), { dayKey: dayKey(NOW - 9 * DAY), volume24hUsd: 5000 }] })), /13 of 14/);
  none(evaluateObjectiveProgram(input({ history: rising, state: { lastActionAt: NOW - 7 * DAY + 1 } })), /no earlier than 2026-10-10 12:00 UTC/);
  only(evaluateObjectiveProgram(input({ history: rising, state: { lastActionAt: NOW - 7 * DAY } })));
  // 40% reserve: 50 SOL available against 100 SOL reserved leaves nothing above 40% of the 150 SOL treasury.
  none(evaluateObjectiveProgram(input({ history: rising, treasury: SOL(50, 100) })), /40% SOL reserve/);
  const after = recordProgramOutcome(evaluateObjectiveProgram(input({ history: rising })).state, { objective: 'long_game', proposal, accepted: true, principalLamports: proposal.lamports, now: NOW });
  assert.equal(after.actions, 1); assert.equal(after.lastActionAt, NOW); assert.equal(after.nextDueAt, NOW + 7 * DAY); assert.equal(after.daySpentLamports, proposal.lamports); assert.match(after.lastNote, /^Proposed 1\.9998 SOL/);
});

test('dip buyer: triggers at exactly the creator-set drop, spends at most 3% per UTC day, one hour apart', () => {
  none(evaluateObjectiveProgram(input({ objective: 'dip_buyer' })), /no market snapshot/);
  none(evaluateObjectiveProgram(input({ objective: 'dip_buyer', market: market({ priceChange24h: null }) })), /no 24h price change/);
  none(evaluateObjectiveProgram(input({ objective: 'dip_buyer', market: market({ priceChange24h: -20, stale: true }) })), /stale/);
  none(evaluateObjectiveProgram(input({ objective: 'dip_buyer', market: market({ priceChange24h: -14.9 }) })), /above the −15% trigger/);
  const proposal = only(evaluateObjectiveProgram(input({ objective: 'dip_buyer', market: market({ priceChange24h: -15 }) })));
  assert.equal(proposal.lamports, (BASE * 300n / 10000n).toString()); assert.match(proposal.reason, /^Dip buyer program: 24h price change -15\.0% is at or below −15%/);
  only(evaluateObjectiveProgram(input({ objective: 'dip_buyer', settings: { dropPct: 10 }, market: market({ priceChange24h: -10 }) })));
  none(evaluateObjectiveProgram(input({ objective: 'dip_buyer', settings: { dropPct: 30 }, market: market({ priceChange24h: -29 }) })), /−30% trigger/);
  const half = only(evaluateObjectiveProgram(input({ objective: 'dip_buyer', market: market({ priceChange24h: -20 }), state: { dayKey: '2026-10-10', daySpentLamports: (BASE * 150n / 10000n).toString() } })));
  assert.equal(half.lamports, (BASE * 150n / 10000n).toString(), 'the rest of today’s 3%');
  const spent = evaluateObjectiveProgram(input({ objective: 'dip_buyer', market: market({ priceChange24h: -20 }), state: { dayKey: '2026-10-10', daySpentLamports: (BASE * 300n / 10000n).toString() } }));
  none(spent, /3% dip budget is spent/); assert.equal(spent.state.nextDueAt, nextUtcDay(NOW));
  // Yesterday's spend does not count today.
  only(evaluateObjectiveProgram(input({ objective: 'dip_buyer', market: market({ priceChange24h: -20 }), state: { dayKey: '2026-10-09', daySpentLamports: (BASE * 300n / 10000n).toString() } })));
  none(evaluateObjectiveProgram(input({ objective: 'dip_buyer', market: market({ priceChange24h: -20 }), state: { lastActionAt: NOW - HOUR + 1 } })), /no earlier than/);
  only(evaluateObjectiveProgram(input({ objective: 'dip_buyer', market: market({ priceChange24h: -20 }), state: { lastActionAt: NOW - HOUR } })));
});

test('metronome: the creator-set share on the creator-set clock, and a rejected tick waits for the next one', () => {
  const first = only(evaluateObjectiveProgram(input({ objective: 'metronome' })));
  assert.equal(first.lamports, (BASE * 200n / 10000n).toString()); assert.equal(first.reason, 'Metronome program: scheduled 2% buyback (tick 1).');
  none(evaluateObjectiveProgram(input({ objective: 'metronome', settings: { sharePct: 3, intervalHours: 6 }, state: { lastActionAt: NOW - 6 * HOUR + MIN } })), /Next tick at 2026-10-10 12:01 UTC/);
  const third = only(evaluateObjectiveProgram(input({ objective: 'metronome', settings: { sharePct: 3, intervalHours: 6 }, state: { lastActionAt: NOW - 6 * HOUR, actions: 2 } })));
  assert.equal(third.lamports, (BASE * 300n / 10000n).toString()); assert.match(third.reason, /tick 3/);
  const halfShare = only(evaluateObjectiveProgram(input({ objective: 'metronome', settings: { sharePct: 1.5, intervalHours: 24 } })));
  assert.equal(halfShare.lamports, (BASE * 150n / 10000n).toString());
  const accepted = recordProgramOutcome({}, { objective: 'metronome', settings: { sharePct: 3, intervalHours: 6 }, proposal: third, accepted: true, principalLamports: third.lamports, now: NOW });
  assert.equal(accepted.nextDueAt, NOW + 6 * HOUR); assert.equal(accepted.actions, 1); assert.equal(accepted.dayActions, 1);
  const rejected = recordProgramOutcome(accepted, { objective: 'metronome', settings: { sharePct: 3, intervalHours: 6 }, proposal: third, accepted: false, reason: 'No route right now.', now: NOW + 6 * HOUR });
  assert.equal(rejected.nextDueAt, NOW + 12 * HOUR, 'the metronome keeps its clock'); assert.equal(rejected.actions, 1); assert.match(rejected.lastNote, /^Proposal rejected: No route right now\./);
  const other = recordProgramOutcome({}, { objective: 'dip_buyer', proposal: first, accepted: false, reason: 'x', now: NOW });
  assert.equal(other.nextDueAt, NOW + PROGRAM_RULES.rejectBackoffMs, 'other rules back off for an hour');
});

test('furnace: up to four burns a UTC day, two hours apart, each as large as the per-action and daily caps allow', () => {
  const first = only(evaluateObjectiveProgram(input({ objective: 'furnace' })));
  assert.equal(first.lamports, CAPS.perAction.toString()); assert.match(first.reason, /burn 1 of 4 today/);
  none(evaluateObjectiveProgram(input({ objective: 'furnace', state: { dayKey: '2026-10-10', dayActions: 2, lastActionAt: NOW - 2 * HOUR + 1 } })), /no earlier than/);
  assert.match(only(evaluateObjectiveProgram(input({ objective: 'furnace', state: { dayKey: '2026-10-10', dayActions: 2, lastActionAt: NOW - 2 * HOUR } }))).reason, /burn 3 of 4/);
  const done = evaluateObjectiveProgram(input({ objective: 'furnace', state: { dayKey: '2026-10-10', dayActions: 4, lastActionAt: NOW - 3 * HOUR } }));
  none(done, /4 burns are done/); assert.equal(done.state.nextDueAt, nextUtcDay(NOW));
  assert.match(only(evaluateObjectiveProgram(input({ objective: 'furnace', state: { dayKey: '2026-10-09', dayActions: 4, lastActionAt: NOW - 13 * HOUR } }))).reason, /burn 1 of 4/, 'a new UTC day starts over');
  const used = evaluateObjectiveProgram(input({ objective: 'furnace', spent: { hour: 0n, day: CAPS.daily } }));
  none(used, /treasury cap is used/); assert.equal(used.state.nextDueAt, nextUtcDay(NOW));
  const room = only(evaluateObjectiveProgram(input({ objective: 'furnace', spent: { hour: 0n, day: CAPS.daily - 3_000_000_000n } })));
  assert.equal(room.lamports, '3000000000', 'the last burn of the day takes what is left of the daily cap');
  const after = recordProgramOutcome({ dayKey: '2026-10-10', dayActions: 3 }, { objective: 'furnace', proposal: first, accepted: true, principalLamports: first.lamports, now: NOW });
  assert.equal(after.dayActions, 4); assert.equal(after.nextDueAt, nextUtcDay(NOW));
  assert.equal(recordProgramOutcome({ dayKey: '2026-10-10', dayActions: 1 }, { objective: 'furnace', proposal: first, accepted: true, principalLamports: first.lamports, now: NOW }).nextDueAt, NOW + 2 * HOUR);
});

test('reserve keeper and balanced book: only the SOL above the floor, monthly or every two days within the daily cap', () => {
  const keeper = only(evaluateObjectiveProgram(input({ objective: 'reserve_keeper' })));
  assert.equal(keeper.lamports, CAPS.perAction.toString(), '29.99 SOL above a 70% floor is capped per action'); assert.match(keeper.reason, /^Reserve keeper program: 29\.9900 SOL sits above the 70% SOL floor/);
  const strict = only(evaluateObjectiveProgram(input({ objective: 'reserve_keeper', settings: { floorPct: 90 } })));
  assert.equal(strict.lamports, (BASE - 90_000_000_000n).toString());
  none(evaluateObjectiveProgram(input({ objective: 'reserve_keeper', treasury: SOL(50, 50) })), /at or below the 70% floor/);
  none(evaluateObjectiveProgram(input({ objective: 'reserve_keeper', state: { lastActionAt: NOW - 30 * DAY + 1 } })), /no earlier than/);
  only(evaluateObjectiveProgram(input({ objective: 'reserve_keeper', state: { lastActionAt: NOW - 30 * DAY } })));
  const wide = { ...CAPS, perAction: 100_000_000_000n, hourly: 100_000_000_000n };
  const book = only(evaluateObjectiveProgram(input({ objective: 'balanced_book', caps: wide })));
  assert.equal(book.lamports, (BASE - 50_000_000_000n).toString()); assert.match(book.reason, /^Balanced book program: 49\.9900 SOL sits above the 50% SOL floor; buying back the excess within the daily cap/);
  assert.equal(only(evaluateObjectiveProgram(input({ objective: 'balanced_book', caps: wide, spent: { hour: 0n, day: 45_000_000_000n } }))).lamports, '5000000000', 'bounded by what is left of the daily cap');
  none(evaluateObjectiveProgram(input({ objective: 'balanced_book', treasury: SOL(40, 60) })), /at or below the 50% floor/);
  none(evaluateObjectiveProgram(input({ objective: 'balanced_book', state: { lastActionAt: NOW - 2 * DAY + 1 } })), /no earlier than/);
  assert.equal(recordProgramOutcome({}, { objective: 'balanced_book', proposal: book, accepted: true, principalLamports: book.lamports, now: NOW }).nextDueAt, NOW + 2 * DAY);
});

test('graduation run: from 85% progress to the daily cap an hour apart, and off for good once graduated', () => {
  none(evaluateObjectiveProgram(input({ objective: 'graduation_run' })), /no market snapshot/);
  none(evaluateObjectiveProgram(input({ objective: 'graduation_run', market: market({ progressPercent: 84.9 }) })), /84\.9% is below 85%/);
  none(evaluateObjectiveProgram(input({ objective: 'graduation_run', market: market({ progressPercent: null }) })), /no curve progress is available/);
  none(evaluateObjectiveProgram(input({ objective: 'graduation_run', market: market({ progressPercent: 90, stale: true }) })), /stale/);
  const proposal = only(evaluateObjectiveProgram(input({ objective: 'graduation_run', market: market({ progressPercent: 85 }) })));
  assert.equal(proposal.lamports, CAPS.perAction.toString()); assert.match(proposal.reason, /^Graduation run program: curve progress 85\.0% is at or above 85%/);
  none(evaluateObjectiveProgram(input({ objective: 'graduation_run', market: market({ progressPercent: 90 }), state: { lastActionAt: NOW - HOUR + 1 } })), /no earlier than/);
  none(evaluateObjectiveProgram(input({ objective: 'graduation_run', market: market({ progressPercent: 90 }), spent: { hour: 0n, day: CAPS.daily } })), /treasury cap is used/);
  const graduated = evaluateObjectiveProgram(input({ objective: 'graduation_run', market: market({ progressPercent: 100, graduated: true }) }));
  none(graduated, /Graduated/); assert.equal(graduated.state.finished, true); assert.match(graduated.state.finishedReason, /graduated/);
  none(evaluateObjectiveProgram(input({ objective: 'graduation_run', market: market({ progressPercent: 90 }), state: graduated.state })), /Finished/);
  assert.equal(recordProgramOutcome({}, { objective: 'graduation_run', proposal, accepted: true, principalLamports: proposal.lamports, now: NOW }).nextDueAt, NOW + HOUR);
});

test('research first: nothing for seven days after launch (model proposals included), then the long game rule', () => {
  const quiet = evaluateObjectiveProgram(input({ objective: 'research_first', createdAt: NOW - 7 * DAY + MIN, history: history([...Array(7).fill(1200), ...Array(7).fill(800)]) }));
  none(quiet, /Reading for the first 7 days; treasury actions start 2026-10-10 12:01 UTC/); assert.equal(quiet.state.nextDueAt, NOW - 7 * DAY + MIN + 7 * DAY);
  const proposal = only(evaluateObjectiveProgram(input({ objective: 'research_first', createdAt: NOW - 7 * DAY, history: history([...Array(7).fill(1200), ...Array(7).fill(800)]) })));
  assert.equal(proposal.lamports, (BASE * 200n / 10000n).toString()); assert.match(proposal.reason, /^Research first program: 7-day volume/);
  none(evaluateObjectiveProgram(input({ objective: 'research_first', createdAt: NOW - 7 * DAY })), /0 of 7 daily volume samples/);
  assert.match(modelProposalLimit({ objective: 'research_first', createdAt: NOW - 6 * DAY, now: NOW }), /Research first program blocks treasury proposals for the first 7 days after launch \(until 2026-10-11 12:00 UTC\)/);
  assert.equal(modelProposalLimit({ objective: 'research_first', createdAt: NOW - 7 * DAY, now: NOW }), null);
});

test('steady in storms: 2% inside the ±5% band, three days apart, context only outside it', () => {
  none(evaluateObjectiveProgram(input({ objective: 'steady_in_storms' })), /no market snapshot/);
  none(evaluateObjectiveProgram(input({ objective: 'steady_in_storms', market: market({ priceChange24h: null }) })), /no 24h price change/);
  none(evaluateObjectiveProgram(input({ objective: 'steady_in_storms', market: market({ priceChange24h: 5.1 }) })), /\+5\.1% is outside the ±5% calm band/);
  none(evaluateObjectiveProgram(input({ objective: 'steady_in_storms', market: market({ priceChange24h: -5.1 }) })), /outside/);
  for (const change of [5, -5, 0]) assert.equal(only(evaluateObjectiveProgram(input({ objective: 'steady_in_storms', market: market({ priceChange24h: change }) }))).lamports, (BASE * 200n / 10000n).toString(), String(change));
  none(evaluateObjectiveProgram(input({ objective: 'steady_in_storms', market: market(), state: { lastActionAt: NOW - 3 * DAY + 1 } })), /no earlier than/);
  only(evaluateObjectiveProgram(input({ objective: 'steady_in_storms', market: market(), state: { lastActionAt: NOW - 3 * DAY } })));
});

test('experimenter: 0.5% once per three days inside the rotating hour, every action labelled experiment', () => {
  const todayIndex = Math.floor(NOW / DAY), hour = (todayIndex * PROGRAM_RULES.experimentHourStep) % 24, windowStart = todayIndex * DAY + hour * HOUR;
  assert.equal(hour, 0);
  const closed = evaluateObjectiveProgram(input({ objective: 'experimenter' }));
  const tomorrow = (todayIndex + 1) * DAY + (((todayIndex + 1) * PROGRAM_RULES.experimentHourStep) % 24) * HOUR;
  none(closed, /Next experiment window: 2026-10-11 07:00 UTC/); assert.equal(closed.state.nextDueAt, tomorrow);
  const open = only(evaluateObjectiveProgram(input({ objective: 'experimenter', now: windowStart + 30 * MIN })));
  assert.equal(open.lamports, (BASE * 50n / 10000n).toString()); assert.match(open.reason, /^Experimenter program: experiment #1 — 0\.5% buyback at the rotating hour \(00:00 UTC\)/);
  assert.equal(evaluateObjectiveProgram(input({ objective: 'experimenter', now: windowStart + HOUR })).proposals.length, 0, 'the window closes after one hour');
  // Three days apart: an action 2 days ago pushes the next window past today's.
  const gapped = evaluateObjectiveProgram(input({ objective: 'experimenter', now: windowStart + 30 * MIN, state: { lastActionAt: windowStart - 2 * DAY } }));
  none(gapped, /no earlier than/); assert.ok(gapped.state.nextDueAt >= windowStart - 2 * DAY + 3 * DAY);
  const window = experimentWindow(windowStart + 30 * MIN, windowStart + 30 * MIN, 3 * DAY); assert.equal(window.open, false); assert.ok(window.next >= windowStart + 30 * MIN + 3 * DAY);
  assert.equal(recordProgramOutcome({}, { objective: 'experimenter', proposal: open, accepted: true, principalLamports: open.lamports, now: windowStart + 30 * MIN }).nextDueAt, window.next);
});

test('milestones: one reward (or burn) per 2×, 5× and 10× crossing of the launch market cap, then finished', () => {
  none(evaluateObjectiveProgram(input({ objective: 'milestones', market: market() })), /first market snapshot/);
  const launch = { launchMarketCapUsd: 10_000 };
  none(evaluateObjectiveProgram(input({ objective: 'milestones', state: launch })), /no market snapshot/);
  none(evaluateObjectiveProgram(input({ objective: 'milestones', state: launch, market: market({ marketCapUsd: null }) })), /no market cap/);
  none(evaluateObjectiveProgram(input({ objective: 'milestones', state: launch, market: market({ marketCapUsd: 19_999 }) })), /Market cap \$19,999 is 2\.00× the launch value \(\$10,000\); next milestone 2× at \$20,000/);
  const two = only(evaluateObjectiveProgram(input({ objective: 'milestones', state: launch, market: market({ marketCapUsd: 20_000 }) })));
  assert.equal(two.kind, 'holder_reward'); assert.equal(two.milestone, 2); assert.equal(two.lamports, (BASE * 500n / 10000n).toString()); assert.match(two.reason, /^Milestones program: market cap \$20,000 crossed 2× the launch value \(\$10,000\); holder reward/);
  assert.equal(only(evaluateObjectiveProgram(input({ objective: 'milestones', capabilities: BUYBACK, state: launch, market: market({ marketCapUsd: 20_000 }) }))).kind, 'buyback_burn', 'buyback when rewards are off');
  let state = recordProgramOutcome(evaluateObjectiveProgram(input({ objective: 'milestones', state: launch, market: market({ marketCapUsd: 20_000 }) })).state, { objective: 'milestones', proposal: two, accepted: true, principalLamports: two.lamports, now: NOW });
  assert.deepEqual(state.milestonesHit, [2]); assert.equal(state.nextDueAt, null); assert.equal(state.finished, false);
  none(evaluateObjectiveProgram(input({ objective: 'milestones', state, market: market({ marketCapUsd: 30_000 }) })), /next milestone 5× at \$50,000/);
  const five = only(evaluateObjectiveProgram(input({ objective: 'milestones', state, market: market({ marketCapUsd: 120_000 }) })));
  assert.equal(five.milestone, 5, 'one milestone per pass, lowest first');
  state = recordProgramOutcome(state, { objective: 'milestones', proposal: five, accepted: true, principalLamports: five.lamports, now: NOW + MIN });
  const ten = only(evaluateObjectiveProgram(input({ objective: 'milestones', state, market: market({ marketCapUsd: 120_000 }), now: NOW + 2 * MIN })));
  assert.equal(ten.milestone, 10);
  state = recordProgramOutcome(state, { objective: 'milestones', proposal: ten, accepted: true, principalLamports: ten.lamports, now: NOW + 2 * MIN });
  assert.deepEqual(state.milestonesHit, [2, 5, 10]); assert.equal(state.finished, true); assert.match(state.finishedReason, /All milestones/);
  none(evaluateObjectiveProgram(input({ objective: 'milestones', state, market: market({ marketCapUsd: 200_000 }), now: NOW + 3 * MIN })), /Finished/);
  // A rejected milestone proposal is not marked as hit.
  const rejected = recordProgramOutcome(launch, { objective: 'milestones', proposal: two, accepted: false, reason: 'deferred', now: NOW }); assert.deepEqual(rejected.milestonesHit, []);
  none(evaluateObjectiveProgram(input({ objective: 'milestones', state: launch, market: market({ marketCapUsd: 20_000, stale: true }) })), /stale/);
});

test('holders first: the treasury income since the last payout, on the creator-set day count, skipped when there is none', () => {
  none(evaluateObjectiveProgram(input({ objective: 'holders_first', capabilities: REWARDS })), /No treasury income/);
  const proposal = only(evaluateObjectiveProgram(input({ objective: 'holders_first', capabilities: REWARDS, income: '5000000000' })));
  assert.equal(proposal.kind, 'holder_reward'); assert.equal(proposal.lamports, '5000000000'); assert.match(proposal.reason, /^Holders first program: 5\.0000 SOL of treasury income since the last distribution goes to holders/);
  assert.equal(only(evaluateObjectiveProgram(input({ objective: 'holders_first', capabilities: REWARDS, income: '500000000000', caps: { ...CAPS, perAction: 1_000_000_000_000n, hourly: 1_000_000_000_000n, daily: 1_000_000_000_000n } }))).lamports, (BASE - RESERVES.holder_reward).toString(), 'never more than the treasury above the gas and network reserves');
  none(evaluateObjectiveProgram(input({ objective: 'holders_first', income: '1', state: { lastActionAt: NOW - 7 * DAY + 1 } })), /Next distribution at/);
  only(evaluateObjectiveProgram(input({ objective: 'holders_first', income: '1000000000', state: { lastActionAt: NOW - 7 * DAY } })));
  none(evaluateObjectiveProgram(input({ objective: 'holders_first', settings: { intervalDays: 3 }, income: '1000000000', state: { lastActionAt: NOW - 3 * DAY + 1 } })), /Next distribution at/);
  only(evaluateObjectiveProgram(input({ objective: 'holders_first', settings: { intervalDays: 3 }, income: '1000000000', state: { lastActionAt: NOW - 3 * DAY } })));
  assert.equal(recordProgramOutcome({}, { objective: 'holders_first', settings: { intervalDays: 3 }, proposal, accepted: true, principalLamports: proposal.lamports, now: NOW }).nextDueAt, NOW + 3 * DAY);
});

test('patience is a limiter on model proposals only: one accepted proposal per seven days', () => {
  assert.equal(modelProposalLimit({ objective: 'patience', createdAt: NOW - 30 * DAY, now: NOW, lastAcceptedAt: null }), null);
  assert.match(modelProposalLimit({ objective: 'patience', createdAt: NOW - 30 * DAY, now: NOW, lastAcceptedAt: NOW - 7 * DAY + 1 }), /Patience program allows one treasury proposal per 7 days; the last accepted proposal was on 2026-10-03 12:00 UTC/);
  assert.equal(modelProposalLimit({ objective: 'patience', createdAt: NOW - 30 * DAY, now: NOW, lastAcceptedAt: NOW - 7 * DAY }), null);
  for (const id of ['custom', 'metronome', 'long_game', 'connector']) assert.equal(modelProposalLimit({ objective: id, createdAt: NOW - DAY, now: NOW, lastAcceptedAt: NOW - MIN }), null, id);
});

test('the policy clamp mirrors the executor: per action, hourly and daily room, the network reserve and the $5 minimum', () => {
  const real = treasuryCaps({ baselineLamports: BASE, solUsdMicro: priceMicro(200) }, AGENT_POLICY_V1);
  const capped = only(evaluateObjectiveProgram(input({ objective: 'metronome', caps: real })));
  assert.equal(capped.lamports, real.perAction.toString()); assert.equal(capped.lamports, '50000000', '$10 per action at $200/SOL');
  const small = treasuryCaps({ baselineLamports: 100_000_000n - GAS, solUsdMicro: priceMicro(200) }, AGENT_POLICY_V1);
  none(evaluateObjectiveProgram(input({ objective: 'metronome', caps: small, treasury: SOL(0.1) })), /below the \$5 minimum action/);
  const hourly = boundedAmount(1_000_000_000n, { caps: CAPS, free: BASE, spent: { hour: CAPS.hourly, day: 0n }, reserve: 0n, now: NOW });
  assert.equal(hourly.ok, false); assert.equal(hourly.nextDueAt, NOW + HOUR);
  const daily = boundedAmount(1_000_000_000n, { caps: CAPS, free: BASE, spent: { hour: 0n, day: CAPS.daily }, reserve: 0n, now: NOW });
  assert.equal(daily.ok, false); assert.equal(daily.nextDueAt, nextUtcDay(NOW));
  const reserve = boundedAmount(1_000_000_000n, { caps: CAPS, free: 1_000_000_000n, spent: { hour: 0n, day: 0n }, reserve: 7_000_000n, now: NOW });
  assert.equal(reserve.amount, 993_000_000n); assert.equal(reserve.capped, true);
  assert.equal(boundedAmount(0n, { caps: CAPS, free: BASE, spent: { hour: 0n, day: 0n }, reserve: 0n, now: NOW }).ok, false);
  // Liabilities (reserved, frozen) reduce the free balance the clamp works from: 3% of 2.99 SOL would be 0.0897 SOL, but only 0.04 SOL is free.
  const tight = only(evaluateObjectiveProgram(input({ objective: 'metronome', treasury: { availableLamports: '3000000000', reservedLamports: '2950000000', frozenLamports: '0' }, settings: { sharePct: 3, intervalHours: 6 } })));
  assert.equal(tight.lamports, (3_000_000_000n - GAS - 2_950_000_000n - RESERVES.buyback_burn).toString()); assert.equal(tight.lamports, '33000000');
  assert.equal(only(evaluateObjectiveProgram(input({ objective: 'metronome', treasury: { availableLamports: '3000000000', reservedLamports: '2000000000', frozenLamports: '0' }, settings: { sharePct: 3, intervalHours: 6 } }))).lamports, '89700000', 'the rule amount when it fits');
});

test('program state is normalized, reset keeps counters and launch facts, and the public status explains why a program is off', () => {
  const messy = normalizeProgramState({ lastRunAt: 'x', actions: -1, daySpentLamports: 'abc', milestonesHit: [5, 2, 2, 'x'], finished: 'yes', launchMarketCapUsd: -3, extra: true });
  assert.deepEqual(messy, { lastRunAt: null, nextDueAt: null, lastNote: '', actions: 0, lastActionAt: null, dayKey: null, daySpentLamports: '0', dayActions: 0, finished: false, finishedReason: '', launchMarketCapUsd: null, milestonesHit: [2, 5] });
  const reset = resetProgramSchedule({ lastRunAt: NOW, nextDueAt: NOW + DAY, lastNote: 'note', actions: 4, lastActionAt: NOW - DAY, dayKey: '2026-10-10', daySpentLamports: '5', dayActions: 2, finished: true, finishedReason: 'done', launchMarketCapUsd: 1234, milestonesHit: [2] });
  assert.deepEqual(reset, { ...normalizeProgramState({}), actions: 4, lastActionAt: NOW - DAY, launchMarketCapUsd: 1234, milestonesHit: [2] });
  const status = over => programStatus({ objective: 'metronome', capabilities: BUYBACK, state: {}, now: NOW, createdAt: NOW - DAY, financialOpen: true, live: true, archived: false, pausedReason: '', ...over });
  assert.deepEqual(status(), { active: true, reason: '' });
  assert.equal(status({ archived: true }).reason, 'The agent is archived.');
  assert.match(status({ capabilities: NONE }).reason, /Needs buy-and-burn/);
  assert.equal(status({ state: { finished: true, finishedReason: 'The coin graduated.' } }).reason, 'The coin graduated.');
  assert.match(status({ live: false }).reason, /go live/);
  assert.equal(status({ pausedReason: 'Paused by the creator.' }).reason, 'Paused by the creator.');
  assert.match(status({ financialOpen: false }).reason, /closed on this platform/);
  assert.match(status({ objective: 'research_first', createdAt: NOW - DAY }).reason, /Reading for the first 7 days \(until 2026-10-16 12:00 UTC\)/);
  assert.deepEqual(status({ objective: 'research_first', createdAt: NOW - 8 * DAY }), { active: true, reason: '' });
  assert.deepEqual(status({ objective: 'patience', capabilities: BOTH }), { active: true, reason: '' });
  assert.equal(programStatus({ objective: 'custom', capabilities: BOTH, state: {}, now: NOW }), null);
  assert.equal(programStatus({ objective: 'connector', capabilities: BOTH, state: {}, now: NOW }), null);
});

// ---- migration -------------------------------------------------------------------
const MINT = 'GoatCoin1111111111111111111111111111111111', WALLET = 'AgentWa11et111111111111111111111111111111';
const agentInput = (over = {}) => ({ mint: MINT, route: 'raydium', launchId: 'launch-1', accountId: 'acct-1', wallet: WALLET, name: 'Goat', symbol: 'GOAT', policyHash: AGENT_POLICY_HASH, policyVersion: AGENT_POLICY_V1.version, capabilities: BUYBACK, model: 'openai/gpt-6-luna', mission: 'Research goats.', ...over });

test('a fresh database stores the objective, its settings and the program state; defaults read as custom with no program', async () => {
  assert.equal(AGENT_SCHEMA_VERSION, 6); assert.equal(MIGRATIONS[2].name, 'agent-objectives'); assert.equal(MIGRATIONS[3].name, 'influencer'); assert.equal(MIGRATIONS[4].name, 'influencer-feature-clip'); assert.equal(MIGRATIONS[5].name, 'agent-moderation');
  const db = await openAgentDatabase(':memory:', { now: () => NOW }), store = new AgentStore(db, { now: () => NOW });
  store.savePolicy({ hash: AGENT_POLICY_HASH, version: AGENT_POLICY_V1.version, document: AGENT_POLICY_V1, rateCard: AGENT_RATE_CARD_V1 });
  const plain = store.createAgent(agentInput());
  assert.equal(plain.objective, 'custom'); assert.deepEqual(plain.objectiveSettings, {}); assert.deepEqual(plain.programState, {});
  const metronome = store.createAgent(agentInput({ mint: 'Lemon' + MINT.slice(5), wallet: 'Lemon' + WALLET.slice(5), launchId: 'l2', objective: 'metronome', objectiveSettings: { sharePct: 3, intervalHours: 6 } }));
  assert.equal(metronome.objective, 'metronome'); assert.deepEqual(metronome.objectiveSettings, { sharePct: 3, intervalHours: 6 });
  assert.throws(() => store.createAgent(agentInput({ mint: 'Pear1' + MINT.slice(5), wallet: 'Pear1' + WALLET.slice(5), objective: 'moon_mission' })), /Unknown agent objective/);
  assert.throws(() => store.createAgent(agentInput({ mint: 'Pear1' + MINT.slice(5), wallet: 'Pear1' + WALLET.slice(5), objectiveSettings: 'x' })), /must be an object/);
  const updated = store.updateAgent(plain.id, { objective: 'dip_buyer', objectiveSettings: { dropPct: 20 }, programState: { actions: 2, lastNote: 'hi' } });
  assert.equal(updated.objective, 'dip_buyer'); assert.deepEqual(updated.objectiveSettings, { dropPct: 20 }); assert.deepEqual(updated.programState, { actions: 2, lastNote: 'hi' });
  assert.throws(() => store.updateAgent(plain.id, { objective: 'nope' }), /Unknown agent objective/);
  assert.throws(() => store.updateAgent(plain.id, { programState: [] }), /must be an object/);
  // A damaged JSON cell still reads as an object.
  db.run('UPDATE agents SET program_state = ? WHERE id = ?', '{broken', plain.id); assert.deepEqual(store.agent(plain.id).programState, {});
  // Market samples: one per agent per UTC day, newest first, pruned by day.
  assert.equal(store.recordMarketSample({ agentId: plain.id, dayKey: '2026-10-10', at: NOW, priceUsd: 0.5, marketCapUsd: 1000, volume24hUsd: 20, priceChange24h: -3, progressPercent: 50, graduated: false }), true);
  assert.equal(store.recordMarketSample({ agentId: plain.id, dayKey: '2026-10-10', at: NOW + MIN, volume24hUsd: 99 }), false, 'the first fresh snapshot of the day is kept');
  assert.equal(store.recordMarketSample({ agentId: plain.id, dayKey: '2026-10-09', at: NOW - DAY, volume24hUsd: 'bad' }), true);
  assert.throws(() => store.recordMarketSample({ agentId: plain.id, dayKey: 'today', at: NOW }), /Invalid market sample day/);
  const samples = store.marketSamples(plain.id); assert.deepEqual(samples.map(row => [row.dayKey, row.volume24hUsd, row.priceChange24h]), [['2026-10-10', 20, -3], ['2026-10-09', null, null]]);
  assert.equal(store.marketSample(plain.id, '2026-10-10').graduated, 0); assert.equal(store.marketSample(metronome.id, '2026-10-10'), null);
  assert.equal(store.pruneMarketSamples(plain.id, '2026-10-10'), 1); assert.equal(store.marketSamples(plain.id).length, 1);
  // Income since a time and the limiter clock.
  store.recordFeeReceipt({ agentId: plain.id, signature: '5'.repeat(88), allocation: 'a', venue: 'raydium', launchMint: MINT, sourceWallet: 'Creator11111111111111111111111111111111111', mint: 'So11111111111111111111111111111111111111112', amount: '1000000000', slot: 1 });
  assert.equal(store.treasuryIncomeSince(plain.id, NOW - 1), '700000000'); assert.equal(store.treasuryIncomeSince(plain.id, NOW), '0'); assert.equal(store.treasuryIncomeSince(metronome.id, 0), '0');
  assert.equal(store.lastAcceptedActionAt(plain.id), null);
  store.createAction({ agentId: plain.id, kind: 'buyback_burn', proposal: { amountSol: 1, reason: 'r' }, policyHash: AGENT_POLICY_HASH, state: 'rejected' });
  assert.equal(store.lastAcceptedActionAt(plain.id), null, 'rejected proposals do not count');
  store.createAction({ agentId: plain.id, kind: 'buyback_burn', proposal: { amountSol: 1, reason: 'r' }, policyHash: AGENT_POLICY_HASH, state: 'proposed' });
  assert.equal(store.lastAcceptedActionAt(plain.id), NOW);
  assert.equal(store.ledger.verify().ok, true);
  db.close();
});

test('a v2 database (two migrations, agents without objectives) upgrades in place; existing agents read as custom with no program; a newer schema is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-migrate-')), path = join(dir, 'agents.sqlite');
  // Build the pre-v71.27 file exactly as the first two migrations would have.
  const legacy = new DatabaseSync(path);
  legacy.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  for (const migration of MIGRATIONS.slice(0, 2)) { legacy.exec(migration.sql); legacy.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, NOW - DAY); }
  legacy.prepare('INSERT INTO agent_policies(hash, version, document, rate_card, created_at) VALUES (?, ?, ?, ?, ?)').run(AGENT_POLICY_HASH, AGENT_POLICY_V1.version, '{}', '{}', NOW - DAY);
  legacy.prepare(`INSERT INTO agents(id, chain, mint, route, launch_id, account_id, wallet, name, symbol, policy_hash, policy_version, capabilities, model, state, mission, created_at, updated_at) VALUES (?, 'solana', ?, 'raydium', 'l1', 'acct-1', ?, 'Old', 'OLD', ?, ?, 7, 'm', 'ready', 'Old mission.', ?, ?)`).run('a'.repeat(24), MINT, WALLET, AGENT_POLICY_HASH, AGENT_POLICY_V1.version, NOW - DAY, NOW - DAY);
  assert.throws(() => legacy.prepare('SELECT objective FROM agents').get(), /no such column/);
  legacy.close();
  const db = await openAgentDatabase(path, { now: () => NOW });
  assert.equal(db.version(), 6);
  assert.deepEqual(db.all('SELECT version, name FROM schema_migrations ORDER BY version').map(row => [row.version, row.name]), [[1, 'agent-core'], [2, 'platform-share-remits'], [3, 'agent-objectives'], [4, 'influencer'], [5, 'influencer-feature-clip'], [6, 'agent-moderation']]);
  const store = new AgentStore(db, { now: () => NOW }), old = store.agent('a'.repeat(24));
  assert.equal(old.objective, 'custom'); assert.deepEqual(old.objectiveSettings, {}); assert.deepEqual(old.programState, {}); assert.equal(old.mission, 'Old mission.');
  assert.equal(old.hidden, 0); assert.equal(old.hiddenReason, ''); assert.equal(old.hiddenAt, null); assert.equal(old.hiddenBy, '', 'v71.37 moderation columns read as visible on an upgraded row');
  assert.equal(store.marketSamples(old.id).length, 0);
  assert.equal(store.influencer(old.id), null, 'v71.30: agents from before the influencer have no record');
  // Re-opening applies nothing more; a database from a later release is refused with the restore hint.
  db.close();
  const again = await openAgentDatabase(path, { now: () => NOW }); assert.equal(again.version(), 6);
  again.run('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)', 7, 'future', NOW); again.close();
  await assert.rejects(openAgentDatabase(path, { now: () => NOW }), /schema 7 is newer than this release \(6\)/);
});

// ---- tools and prompt -------------------------------------------------------------------
test('the directory tools are closed read-only schemas, read public coin and agent cards only, and say so when a mint is unknown', async () => {
  for (const name of ['get_curve_coin', 'list_curve_agents']) { assert.ok(AGENT_TOOLS.includes(name)); assert.ok(DATA_TOOLS.includes(name)); assert.equal(TOOL_SCHEMAS[name].parameters.additionalProperties, false); }
  assert.equal(TOOL_SCHEMAS.get_curve_coin.parameters.properties.coinMint.maxLength, 44); assert.equal(TOOL_SCHEMAS.get_curve_coin.parameters.properties.coinMint.minLength, 32);
  assert.deepEqual(Object.keys(TOOL_SCHEMAS.list_curve_agents.parameters.properties), []);
  const snapshot = coinSnapshot({ mint: MINT, name: 'Goat', symbol: 'GOAT', platform: 'raydium', feeMode: 'agent', priceUsd: 0.001, marketCapUsd: null, fdvUsd: 1_000_000, volume24h: 50_000, priceChange24h: -12.5, liquidityUsd: 20_000, progressPercent: 42, stage: 'new', marketAt: NOW, stale: false, agent: { id: 'internal' }, creator: { username: 'x' }, curve: 'Curve111' });
  assert.deepEqual(snapshot, { mint: MINT, name: 'Goat', symbol: 'GOAT', venue: 'raydium', feeMode: 'agent', priceUsd: 0.001, marketCapUsd: 1_000_000, volume24hUsd: 50_000, priceChange24h: -12.5, liquidityUsd: 20_000, progressPercent: 42, stage: 'new', graduated: false, at: NOW, stale: false, href: '/coin?mint=' + MINT });
  const { service, store, now } = await fixture();
  const agent = store.createAgent(agentInput({ mint: MINT, accountId: 'acct-2', state: 'ready', launchState: 'live', objective: 'connector' }));
  const other = 'Lemon' + MINT.slice(5);
  const runner = service.runner;
  assert.deepEqual(await runner.executeTool(agent.id, null, 'get_curve_coin', { coinMint: other }), { note: 'The Launchpad coin directory is unavailable right now.' });
  service.discovery = { inventory: async () => new Map([[other, { coin: { mint: other, name: 'Lemon', symbol: 'LEM', platform: 'meteora', feeMode: 'creator', priceUsd: 2, marketCapUsd: 5000, volume24h: 10, priceChange24h: 1, progressPercent: 90, stage: 'graduated', marketAt: now(), stale: false, secretField: 'never' } }]]), coin: record => record.coin };
  const coin = await runner.executeTool(agent.id, null, 'get_curve_coin', { coinMint: other });
  assert.equal(coin.symbol, 'LEM'); assert.equal(coin.graduated, true); assert.equal(coin.venue, 'meteora'); assert.equal('secretField' in coin, false);
  assert.deepEqual(await runner.executeTool(agent.id, null, 'get_curve_coin', { coinMint: 'Pear1' + MINT.slice(5) }), { note: 'No coin with that mint is listed on Launchpad.' });
  assert.deepEqual(await runner.executeTool(agent.id, null, 'get_curve_coin', { coinMint: 'not-base58-0OIl-not-base58-0OIl-not-base' }), { note: 'That is not a valid Solana mint address.' });
  const directory = await runner.executeTool(agent.id, null, 'list_curve_agents', {});
  assert.equal(directory.count, 1); assert.deepEqual(Object.keys(directory.agents[0]).sort(), ['href', 'mint', 'mission', 'name', 'objective', 'objectiveName', 'state', 'symbol', 'treasurySol', 'venue']);
  assert.equal(directory.agents[0].objective, 'connector'); assert.equal(directory.agents[0].objectiveName, 'Connector'); assert.equal(directory.agents[0].mint, MINT);
  // The agent's own snapshot comes from the same directory; a coin the directory does not list has none.
  assert.equal(await runner.market(agent), null, 'the discovery stub does not list the agent coin');
  const listed = await runner.market({ ...agent, mint: other }); assert.equal(listed.venue, 'raydium', 'the agent venue, not the directory platform'); assert.equal(listed.priceChange24h, 1); assert.equal(listed.progressPercent, 90);
  service.close();
});

test('the system prompt states the objective, the platform program or limiter, and the creator numbers; the task prompt carries the program status', () => {
  const base = { name: 'Goat', symbol: 'GOAT', route: 'raydium', mission: 'Grow.', personality: '', personalityPreset: 'analyst', model: 'm', createdAt: NOW - DAY };
  const prompt = agent => systemPrompt({ agent: { ...base, ...agent }, policy: { hash: 'f'.repeat(64), version: 'v' }, capabilities: ['research'], remaining: { modelCalls: 8, toolCalls: 16, seconds: 90, usd: '$0.10' }, approvedDomains: [], rateCardVersion: 'rc' });
  assert.match(prompt({ objective: 'metronome', objectiveSettings: { sharePct: 3, intervalHours: 6 } }), /Objective: Metronome — Steady buybacks on a clock.*The platform runs this program for you: Buy back the share you set every 6, 12 or 24 hours.*You never need to propose it and cannot change it; you may explain it\. The creator set: treasury share per tick 3%, tick interval 6 h\./);
  assert.match(prompt({ objective: 'patience' }), /Limiter: The model may propose a treasury action at most once per 7 days/);
  assert.match(prompt({ objective: 'research_first' }), /Until 2026-10-16 every treasury proposal, yours included, is rejected/);
  const custom = prompt({ objective: 'custom' }); assert.match(custom, /Objective: Custom — A mission you write/); assert.doesNotMatch(custom, /platform runs this program/);
  assert.match(prompt({}), /Objective: Custom/, 'agents from before v71.27 read as custom');
  assert.match(prompt({ objective: 'connector' }), /Your updates focus on: Comparison posts and idea notes drawn from the Launchpad directory\./);
  const task = taskPrompt({ market: null, treasury: null, notes: [], feeSummary: null, recentUpdates: [], program: { objective: 'Metronome', status: 'Waiting: the treasury holds only its gas reserve.', actions: 2, nextDueAt: NOW }, now: NOW });
  assert.match(task, /Platform program status \(Metronome, run by the platform, not by you\): Waiting: the treasury holds only its gas reserve\. Program actions so far: 2\. Next check 2026-10-10T12:00:00\.000Z\./);
  assert.doesNotMatch(taskPrompt({ market: null, treasury: null, notes: [], feeSummary: null, recentUpdates: [], now: NOW }), /Platform program/);
});

// ---- service ---------------------------------------------------------------------------
const SOL_MINT = 'So11111111111111111111111111111111111111112', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', MODEL = 'openai/gpt-6-luna', UNPRICED = 'other/unpriced-model';
const wallet = () => Keypair.generate().publicKey.toBase58();
const signatureOf = seed => bs58.encode(createHash('sha512').update(seed).digest());
const rawOf = seed => { const raw = Buffer.from('tx:' + seed).toString('base64'); return { raw, rawHash: createHash('sha256').update(Buffer.from(raw, 'base64')).digest('hex') }; };
const CATALOG = [{ id: MODEL, name: 'GPT-6 Luna', pricing: { prompt: '0.0000001', completion: '0.0000005', request: '0' }, context_length: 1050000, top_provider: { max_completion_tokens: 128000 }, supported_parameters: ['tools'] }];
class FakeStore { constructor() { this.docs = new Map(); } async read(name, fallback = null) { return this.docs.has(name) ? JSON.parse(this.docs.get(name)) : fallback; } async write(name, value) { this.docs.set(name, JSON.stringify(value)); } }
function raydiumAgentLaunch({ attachment, mint, rewards, feeWallet, payer, curve, payouts = [], now }) {
  const secret = key => bs58.encode(key.secretKey);
  return { id: 'launch-' + mint.slice(0, 6), state: 'live', curve, authorizedAt: now - 3 * HOUR, createdAt: now - 4 * HOUR, feeCustody: 'relay',
    input: { route: 'raydium', network: 'mainnet-beta', feeMode: 'creator', taxBps: 0, recipient: attachment.wallet, agent: attachment, quoteMint: SOL_MINT, name: 'Granite Goat', symbol: 'GOAT', imageId: '' },
    keys: { mint: { address: mint }, wallet: { address: feeWallet.publicKey.toBase58(), secret: secret(feeWallet) }, payer: { address: payer, external: true }, rewards: { address: rewards.publicKey.toBase58(), secret: secret(rewards) } },
    review: { quoteDecimals: 9, quoteSymbol: 'SOL', price: { usd: '200', at: now } }, credits: { quote: '0', base: '0' },
    rewardsWallet: { version: 1, status: 'active', address: rewards.publicKey.toBase58(), creatorCredits: { base: '0', quote: '0', protocolQuote: '0', taxBase: '0' } },
    operations: [{ kind: 'create', state: 'confirmed', signature: signatureOf('create-' + mint), confirmedAt: now - 3 * HOUR }, ...payouts.map(row => ({ kind: 'payout', state: 'confirmed', signature: row.signature, slot: 100, confirmedAt: now - HOUR, amount: row.amount, payouts: [{ owner: attachment.wallet, amount: row.amount }] }))] };
}
class FakeChain {
  constructor(world) { this.world = world; }
  async incomingReceipt(source, { wallet: destination }) { if (!this.world.finalized.has(source.signature)) return null; return { id: source.signature + ':' + source.mint, signature: source.signature, mint: source.mint, wallet: destination, sourceWallet: source.sourceWallet, receivedAmount: source.amount, sourceDebitAmount: source.amount, transferredAmount: source.amount, slot: 120 }; }
  async solUsd() { return { usd: this.world.solUsd, at: this.world.now(), source: 'test' }; }
  async mintSummary(mint) { return { mint, program: TOKEN_PROGRAM, decimals: 6, supply: '1000000000000000', slot: 130, transferFee: null }; }
  async holderSnapshot({ mint }) { return { mint, slot: 140 + this.world.sequence, at: this.world.now(), rows: [], scanned: 0, skipped: 0, complete: true }; }
  op(kind, request, extra = {}) { const seed = 'op' + (++this.world.sequence); return { kind, mint: request.mint, wallet: request.wallet.address, inputAmount: String(request.lamports ?? request.amount), minimumOutput: extra.minimumOutput || '1', expectedOutput: extra.expectedOutput || '1', signature: signatureOf(seed), ...rawOf(seed), blockhash: 'hash', lastValidBlockHeight: 1000, preparedSlot: 160, createdAt: this.world.now(), accounting: { maxCostLamports: String(request.maxNetworkCostLamports || '5000000'), monitoredAccounts: [], ata: 'ata', program: TOKEN_PROGRAM, decimals: 6, minSolReserve: String(request.minSolReserve || '0'), networkFeeLamports: '5000', beforeSol: '0', beforeTokens: '0' }, ...extra }; }
  async prepareSettlement(request) { return this.op('acquire', { ...request, mint: USDC }, { expectedOutput: '60000000', minimumOutput: '59700000' }); }
  async prepareBuyback(request) { this.world.buybacks.push(request.lamports); return this.op('acquire', request, { expectedOutput: '5000000', minimumOutput: '4950000' }); }
  async prepareIncinerate(request) { return this.op('incinerate', request, { minimumOutput: '0', expectedOutput: '0' }); }
  async broadcast(op) { this.world.broadcast.push(op.signature); }
  async receipt(op) { const receipt = this.world.receipts.get(op.signature); if (!receipt) return null; return { signature: op.signature, slot: 200, feeLamports: '5000', inputAmount: op.inputAmount, outputAmount: '0', actualSolCostLamports: '5000', outputDecimals: 6, ...receipt }; }
  async state() { return { state: 'pending' }; }
  async close() {}
}
async function fixture({ flags = {}, model = dryRunModel(), models = [MODEL] } = {}) {
  let clock = Date.UTC(2026, 9, 2, 12, 0, 0); const now = () => clock, tick = ms => { clock += ms; };
  const dir = await mkdtemp(join(tmpdir(), 'agent-programs-'));
  const world = { now, finalized: new Set(), receipts: new Map(), broadcast: [], buybacks: [], sequence: 0, solUsd: 200 };
  const books = new Map(), accountsList = [{ id: 'acct-1', username: 'mira', role: 'admin', mfaEnabled: true, banned: false, mainWallet: null }, { id: 'acct-2', username: 'bob', role: 'user', mfaEnabled: false, banned: false, mainWallet: null }];
  const accounts = { dir, hostStore: new FakeStore(), list: async () => accountsList, get: async id => accountsList.find(a => a.id === id) || null };
  const config = { enabled: true, dryRun: false, dbPath: join(dir, 'agents.sqlite'), backupDir: '', openrouterKey: 'test-key', models, defaultModel: MODEL, browserbaseKey: '', browserbaseProject: '', browserbaseRegion: '', operatorWallet: wallet(), globalDailyUsd: 10000000n, modelConcurrency: 2, browserConcurrency: 1, domainAllowlist: ['coingecko.com'], rateCard: AGENT_RATE_CARD_V1, workerPath: '' };
  const registry = new ModelRegistry({ allowlist: models, now, catalog: CATALOG, fetcher: async () => ({ ok: true, json: async () => ({ data: CATALOG }) }) });
  const service = new AgentService({ accounts, launchpad: { book: async id => ({ launches: books.get(id) || [] }) }, discovery: null, chainFactory: async () => new FakeChain(world), config, now, registry, worker: new InlineWorker({ model }) });
  const store = await service.ensure();
  store.setSetting('flags', { intake: true, runs: true, model: true, financial: true, settlement: false, browser: false, ...flags }, 'test');
  return { service, store, world, books, now, tick };
}
const request = (over = {}) => ({ mode: AGENT_MODE, venue: 'raydium', mission: 'Research goat markets and publish honest updates.', personalityPreset: 'analyst', personality: '', model: MODEL, domains: ['coingecko.com'], buyback: true, rewards: false, capabilities: BUYBACK, objective: 'custom', objectiveSettings: {}, ...over });
async function goLive(fixtureState, attachment, { payout = '20000000000' } = {}) {
  const { service, store, world, books, now } = fixtureState, mint = wallet();
  books.set('acct-2', [...(books.get('acct-2') || []), raydiumAgentLaunch({ attachment, mint, rewards: Keypair.generate(), feeWallet: Keypair.generate(), payer: wallet(), curve: wallet(), now: now(), payouts: [{ signature: signatureOf('pay-' + mint), amount: payout }] })]);
  world.finalized.add(signatureOf('pay-' + mint)); service.launchCache = null;
  await service.process();
  const agent = store.agent(attachment.id); assert.equal(agent.launchState, 'live'); assert.equal(agent.mint, mint);
  return agent;
}

test('launching checks the objective against the launch capabilities and the live model catalog, and stores the creator numbers', async () => {
  const f = await fixture({ models: [MODEL, UNPRICED] }), { service, store } = f;
  const launch = (over, extra = {}) => service.launchTarget(request(over), { accountId: 'acct-2', venue: 'raydium', name: 'Granite Goat', symbol: 'GOAT', ...extra });
  await assert.rejects(launch({ objective: 'metronome', buyback: false, capabilities: NONE }), error => error.statusCode === 400 && /Metronome needs buy-and-burn enabled at launch/.test(error.message));
  await assert.rejects(launch({ objective: 'holders_first', capabilities: BUYBACK }), /Holders first needs holder rewards enabled at launch/);
  await assert.rejects(launch({ objective: 'milestones', capabilities: NONE }), /Milestones needs buy-and-burn or holder rewards enabled at launch/);
  await assert.rejects(launch({ objective: 'moon' }), /Choose an objective/);
  await assert.rejects(launch({ objective: 'metronome', objectiveSettings: { sharePct: 5 } }), error => error.statusCode === 400 && /Treasury share per tick must be between 1 and 3 %/.test(error.message));
  await assert.rejects(launch({ objective: 'metronome', objectiveSettings: { intervalHours: 7 } }), /Tick interval must be one of 6, 12, 24 h/);
  await assert.rejects(launch({ model: UNPRICED }), error => error.statusCode === 400 && error.message === 'That model is not available right now. Choose another from the list.');
  const voice = await launch({ objective: 'connector', capabilities: NONE, buyback: false }); assert.equal(store.agent(voice.id).objective, 'connector');
  const metronome = await launch({ objective: 'metronome', objectiveSettings: { sharePct: '3', intervalHours: 6 } });
  const agent = store.agent(metronome.id); assert.equal(agent.objective, 'metronome'); assert.deepEqual(agent.objectiveSettings, { sharePct: 3, intervalHours: 6 }); assert.deepEqual(agent.programState, {});
  assert.deepEqual(Object.keys(metronome).sort(), ['capabilities', 'id', 'mode', 'model', 'policyHash', 'policyVersion', 'version', 'wallet'], 'the attachment keeps its hashed shape');
  const defaults = await launch({ objective: 'metronome', mission: 'other' }); assert.deepEqual(store.agent(defaults.id).objectiveSettings, { sharePct: 2, intervalHours: 12 });
  assert.notEqual(defaults.id, metronome.id);
  const legacy = await launch({ objective: undefined, objectiveSettings: undefined, mission: 'legacy client' }); assert.equal(store.agent(legacy.id).objective, 'custom');
  service.close();
});

test('the metronome program proposes through the executor with program origin, is executed, and the views, revise and creator surface carry the objective', async () => {
  const f = await fixture(), { service, store, world, now, tick } = f;
  const attachment = await service.launchTarget(request({ objective: 'metronome', objectiveSettings: { sharePct: 2, intervalHours: 12 } }), { accountId: 'acct-2', venue: 'raydium' });
  const snapshot = { priceUsd: 0.001, marketCapUsd: 12_000, volume24hUsd: 900, priceChange24h: -4, progressPercent: 30, graduated: false, stale: false, at: now(), venue: 'raydium' };
  service.runner.market = async () => snapshot;
  const agent = await goLive(f, attachment);
  // One pass: the program sampled the day, recorded the launch market cap, proposed 2% (capped to $10 per action) and the executor journaled the buy.
  const live = store.agent(agent.id), state = live.programState;
  assert.equal(store.marketSample(agent.id, dayKey(now()))?.volume24hUsd, 900); assert.equal(state.launchMarketCapUsd, 12_000);
  assert.equal(state.actions, 1); assert.equal(state.lastActionAt, now()); assert.equal(state.nextDueAt, now() + 12 * HOUR); assert.match(state.lastNote, /^Proposed 0\.0500 SOL: Metronome program: scheduled 2% buyback \(tick 1\)\./);
  const actions = store.actions(agent.id); assert.equal(actions.length, 1);
  const action = actions[0]; assert.equal(action.kind, 'buyback_burn'); assert.equal(action.runId, null); assert.equal(action.proposal.origin, 'program'); assert.equal(action.evaluation.principal, '50000000'); assert.ok(['submitted', 'signed'].includes(action.state), action.state);
  assert.deepEqual(world.buybacks, ['50000000']);
  const events = store.events(agent.id, { limit: 20 }), proposed = events.find(event => event.kind === 'action' && /proposed/.test(event.title));
  assert.equal(proposed.title, 'Program buyback proposed: 0.05 SOL'); assert.match(proposed.body, /^Metronome program: scheduled 2% buyback \(tick 1\)\. \(requested 0\.05 SOL\)\. Queued/, 'the program asks for what the caps allow, so the executor never has to cap it'); assert.equal(proposed.data.origin, 'program'); assert.equal(proposed.data.objective, 'metronome'); assert.equal(proposed.runId, null);
  // Public views.
  const detail = service.views.detail(agent.mint);
  assert.equal(detail.objective, 'metronome'); assert.equal(detail.objectiveName, 'Metronome'); assert.equal(detail.objectiveSummary, objectiveById('metronome').summary); assert.deepEqual(detail.objectiveSettings, { sharePct: 2, intervalHours: 12 });
  assert.deepEqual(Object.keys(detail.program).sort(), ['actions', 'active', 'finished', 'finishedReason', 'kind', 'lastActionAt', 'lastNote', 'lastRunAt', 'launchMarketCapUsd', 'milestonesHit', 'nextDueAt', 'reason', 'rule', 'spends']);
  assert.equal(detail.program.active, true); assert.equal(detail.program.rule, objectiveById('metronome').program.rule); assert.equal(detail.program.actions, 1); assert.equal(detail.program.kind, 'program'); assert.equal(detail.program.spends, true);
  const treasury = service.views.treasury(agent.mint); assert.equal(treasury.actions[0].origin, 'program');
  const card = service.views.list().agents.find(row => row.mint === agent.mint); assert.equal(card.objective, 'metronome'); assert.equal(card.objectiveName, 'Metronome');
  const catalog = service.views.catalog(); assert.equal(catalog.objectives, AGENT_OBJECTIVES); assert.equal(catalog.objectiveGroups, AGENT_OBJECTIVE_GROUPS); assert.equal(catalog.objectives.length, 21); assert.equal(catalog.tools.length, 16); assert.ok(catalog.tools.includes('post_to_x')); assert.equal(catalog.influencer.open, false); assert.equal(catalog.influencer.limits.dailyPostsMax, 12);
  assert.ok(!JSON.stringify(detail).includes('secret'));
  // The next pass is gated by the tick clock while the action is open; a creator pause switches the program off with a reason.
  tick(MIN); await service.process();
  assert.equal(store.actions(agent.id).length, 1); assert.match(store.agent(agent.id).programState.lastNote, /^Proposed 0\.0500 SOL/);
  const session = { account: { id: 'acct-2', authType: 'password' } };
  await service.setCreatorPause(session, { mint: agent.mint, paused: true });
  tick(MIN); await service.process();
  assert.equal(service.views.detail(agent.mint).program.active, false); assert.equal(service.views.detail(agent.mint).program.reason, 'Paused by the creator.'); assert.equal(store.agent(agent.id).programState.lastNote, 'Waiting: paused by the creator.');
  await service.setCreatorPause(session, { mint: agent.mint, paused: false });
  // Revise: the objective may change to one the launch capabilities satisfy; the schedule starts over, counters stay.
  await assert.rejects(service.revise(session, { mint: agent.mint, objective: 'holders_first' }), error => error.statusCode === 400 && /Holders first needs holder rewards enabled at launch/.test(error.message));
  await assert.rejects(service.revise(session, { mint: agent.mint, objective: 'metronome', objectiveSettings: { sharePct: 9 } }), /between 1 and 3/);
  const unchanged = await service.revise(session, { mint: agent.mint, objective: 'metronome', objectiveSettings: { sharePct: 2, intervalHours: 12 } }); assert.equal(unchanged.revision, store.agent(agent.id).revision);
  const revised = await service.revise(session, { mint: agent.mint, objective: 'steady_in_storms', objectiveSettings: { sharePct: 3 } });
  assert.equal(revised.objective, 'steady_in_storms'); assert.deepEqual(revised.objectiveSettings, {}, 'settings of the previous objective are dropped'); assert.deepEqual(revised.capabilities, ['research', 'browser', 'buyback']);
  const after = store.agent(agent.id); assert.equal(after.objective, 'steady_in_storms'); assert.equal(after.programState.nextDueAt, null); assert.equal(after.programState.actions, 1); assert.equal(after.programState.lastActionAt, now() - 2 * MIN); assert.equal(after.programState.launchMarketCapUsd, 12_000); assert.equal(after.programState.lastNote, '');
  const revision = store.events(agent.id, { limit: 5 }).find(event => event.kind === 'revision'); assert.match(revision.body, /Objective changed to Steady in storms\./);
  const settings = await service.revise(session, { mint: agent.mint, objective: 'metronome', objectiveSettings: { sharePct: 1, intervalHours: 24 } }); assert.deepEqual(settings.objectiveSettings, { sharePct: 1, intervalHours: 24 });
  const tweak = await service.revise(session, { mint: agent.mint, objectiveSettings: { sharePct: 1.5 } }); assert.deepEqual(tweak.objectiveSettings, { sharePct: 1.5, intervalHours: 24 });
  assert.match(store.events(agent.id, { limit: 1 })[0].body, /Program settings updated\./);
  assert.equal(store.ledger.verify().ok, true);
  service.close();
});

test('the market sampler keeps one snapshot per UTC day for every live agent and skips stale ones; closed treasury actions leave a waiting note', async () => {
  const f = await fixture({ flags: { financial: false } }), { service, store, now, tick } = f;
  const attachment = await service.launchTarget(request({ objective: 'long_game' }), { accountId: 'acct-2', venue: 'raydium' });
  let stale = true; service.runner.market = async () => ({ priceUsd: 1, marketCapUsd: 500, volume24hUsd: 10, priceChange24h: 0, progressPercent: 10, graduated: false, stale, at: now() });
  const agent = await goLive(f, attachment);
  assert.equal(store.marketSample(agent.id, dayKey(now())), null, 'a stale snapshot is not evidence');
  assert.equal(store.agent(agent.id).programState.lastNote, 'Waiting: treasury actions are closed on this platform.'); assert.equal(service.views.detail(agent.mint).program.active, false); assert.match(service.views.detail(agent.mint).program.reason, /closed on this platform/);
  stale = false; tick(MIN); await service.process();
  assert.equal(store.marketSample(agent.id, dayKey(now())).volume24hUsd, 10); assert.equal(store.agent(agent.id).programState.launchMarketCapUsd, 500);
  tick(MIN); await service.process(); assert.equal(store.marketSamples(agent.id).length, 1);
  tick(DAY); await service.process(); assert.equal(store.marketSamples(agent.id).length, 2);
  store.setSetting('flags', { ...service.flags(), financial: true }, 'test'); tick(MIN); await service.process();
  assert.match(store.agent(agent.id).programState.lastNote, /Waiting: 2 of 7 daily volume samples collected\./); assert.equal(store.actions(agent.id).length, 0);
  // Direct driver call with a custom-objective agent: evidence is still collected, nothing is proposed, nothing is written each pass.
  const custom = await service.launchTarget(request({ objective: 'custom', mission: 'plain' }), { accountId: 'acct-2', venue: 'raydium' });
  const plain = await goLive(f, custom);
  assert.equal(store.marketSample(plain.id, dayKey(now())).marketCapUsd, 500); assert.equal(store.agent(plain.id).programState.launchMarketCapUsd, 500); assert.equal(store.actions(plain.id).length, 0);
  const before = store.agent(plain.id).updatedAt; tick(MIN); await runObjectivePrograms(service); assert.equal(store.agent(plain.id).updatedAt, before, 'no heartbeat writes for agents without a program');
  service.close();
});

test('patience rejects a second model proposal within seven days with a clear reason; the program itself never spends', async () => {
  const proposer = () => { let step = 0; return async () => { step++; if (step === 1) return { id: 'p-' + Math.random(), message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'propose_buyback_burn', arguments: JSON.stringify({ amountSol: 0.05, reason: 'Weekly buyback per the patience rule.' }) } }] }, usage: { promptTokens: 1000, completionTokens: 50, costUsd: 300n } }; return { id: 'p-end-' + Math.random(), message: { role: 'assistant', content: 'Proposed.' }, usage: { promptTokens: 1000, completionTokens: 20, costUsd: 300n } }; }; };
  const f = await fixture({ model: proposer() }), { service, store, tick } = f;
  const attachment = await service.launchTarget(request({ objective: 'patience', rewards: true, capabilities: BOTH }), { accountId: 'acct-2', venue: 'raydium' });
  const agent = await goLive(f, attachment);
  store.ledger.post({ kind: 'test-fund', sourceKey: 'test:fund', agentId: agent.id, entries: [{ owner: 'external:provider', asset: 'USD', bucket: 'main', delta: -5000000n }, { owner: 'agent:' + agent.id, asset: 'USD', bucket: 'operating_backed', delta: 5000000n }] });
  service.refreshStates(); assert.equal(store.agent(agent.id).state, 'ready');
  await service.process(); await service.runner.drain(); await service.process();
  let actions = store.actions(agent.id); assert.equal(actions.length, 1); assert.equal(actions[0].proposal.origin, 'model'); assert.equal(actions[0].evaluation.ok, true);
  assert.equal(store.agent(agent.id).programState.lastNote, '', 'a limiter has no program state of its own');
  assert.equal(service.views.detail(agent.mint).program.kind, 'limiter'); assert.equal(service.views.detail(agent.mint).program.active, true);
  // Finalize the first action so the second proposal is judged by the limiter, not by the open-action rule.
  const buy = store.legs(actions[0].id)[0]; f.world.receipts.set(buy.signature, { state: 'confirmed', outputAmount: '4990000', actualSolCostLamports: '7000' });
  tick(MIN); await service.process();
  const burn = store.legs(actions[0].id)[1]; f.world.receipts.set(burn.signature, { state: 'confirmed', actualSolCostLamports: '5000', outputAmount: '4990000' });
  tick(MIN); await service.process(); assert.equal(store.action(actions[0].id).state, 'finalized');
  service.runner.worker = new InlineWorker({ model: proposer() });
  tick(31 * MIN); await service.process(); await service.runner.drain();
  actions = store.actions(agent.id); assert.equal(actions.length, 2);
  const second = actions.find(action => action.id !== store.actions(agent.id, { limit: 10 }).at(-1).id);
  assert.equal(second.state, 'rejected'); assert.match(second.evaluation.reason, /^The Patience program allows one treasury proposal per 7 days; the last accepted proposal was on 2026-10-02 12:00 UTC and the next is allowed from 2026-10-09 12:00 UTC\./);
  assert.ok(store.events(agent.id, { limit: 10 }).some(event => event.title === 'Buyback proposal rejected' && /Patience program/.test(event.body)));
  // A week later the model may propose again.
  service.runner.worker = new InlineWorker({ model: proposer() });
  tick(7 * DAY); await service.process(); await service.runner.drain();
  assert.equal(store.actions(agent.id).filter(action => action.state !== 'rejected').length, 2);
  service.close();
});
