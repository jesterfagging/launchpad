// Objective programs of the AI Agent core (v71.27). An objective's `program`
// descriptor in the shared catalogue is a fixed rule the platform runs for the
// agent; this module turns that descriptor plus the agent's evidence (treasury
// balances, policy caps, the market snapshot, one market sample per UTC day and
// fee income) into at most one proposal per scheduler pass. Everything that
// decides is pure and integer-based so every rule is unit-testable with a fixed
// clock; the driver at the bottom only gathers inputs, hands proposals to the
// deterministic executor (the same path the model's proposals take, so every
// policy cap, reservation and reconciliation step still applies) and stores the
// resulting program state. Nothing here signs, spends or calls a provider.
import { AGENT_POLICY_V1, objectiveById, objectiveMissingCapabilities, hasCapability } from '../../public/agent-catalog.mjs';
import { treasuryCaps, priceMicro, freshPrice, dayKey } from './policy.mjs';

const HOUR = 3600000, DAY = 86400000;
/** Rule constants that complement the catalogue descriptors (gaps the descriptors leave implicit, evidence minimums, back-offs). */
export const PROGRAM_RULES = Object.freeze({
  rejectBackoffMs: HOUR, // a rejected program proposal is not retried for an hour (the metronome keeps its own clock)
  volumeWindowDays: 7, volumeWindowSlackDays: 1, baselineWindowDays: 30, baselineMinimumSamples: 14, // long game: 7 daily samples in the last 8 days, ≥14 in the last 31
  gaps: Object.freeze({ dip_buyer: HOUR, furnace: 2 * HOUR, graduation_run: HOUR }), // minimum spacing between program actions where the catalogue states none
  experimentHourStep: 7, // experimenter: the hour of day rotates by 7 each UTC day
  pruneDays: 45,
});
const min = (...values) => values.reduce((a, b) => (a < b ? a : b));
const big = value => { try { const n = BigInt(value ?? 0); return n < 0n ? 0n : n; } catch { return 0n; } };
const clip = (value, max) => { const text = String(value ?? ''); return text.length > max ? text.slice(0, max - 1) + '…' : text; };
const sol = lamports => (Number(big(lamports)) / 1e9).toFixed(4);
const usd = value => { const n = Number(value); if (!Number.isFinite(n)) return '$?'; return '$' + (n >= 1000 ? Math.round(n).toString() : n.toFixed(2)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
const pct = value => `${value > 0 ? '+' : ''}${Number(value).toFixed(1)}%`;
const when = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const days = ms => Math.round(ms / DAY);
const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
export const nextUtcDay = now => { const date = new Date(now); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1); };
const dayIndex = key => Math.floor(Date.parse(key + 'T00:00:00Z') / DAY);
const capabilityLabel = name => (name === 'buyback' ? 'buy-and-burn' : name === 'rewards' ? 'holder rewards' : name);
const missingLabel = missing => (missing.length > 1 ? 'buy-and-burn or holder rewards' : capabilityLabel(missing[0]));
/** One numeric field of the market snapshot, or the reason it cannot be read (no snapshot, stale, missing). */
const marketValue = (market, key, label) => { if (!market) return { note: 'Waiting: no market snapshot is available for this coin yet.' }; if (market.stale === true) return { note: 'Waiting: the market snapshot is stale.' }; const value = number(market[key]); return value === null ? { note: `Waiting: no ${label} is available for this coin yet.` } : { value }; };

// ---- program state --------------------------------------------------------------
/** The stored shape (the UI depends on these keys; new keys are only ever added). */
export const defaultProgramState = () => ({ lastRunAt: null, nextDueAt: null, lastNote: '', actions: 0, lastActionAt: null, dayKey: null, daySpentLamports: '0', dayActions: 0, finished: false, finishedReason: '', launchMarketCapUsd: null, milestonesHit: [] });
export function normalizeProgramState(raw) {
  const out = defaultProgramState(); if (!raw || typeof raw !== 'object') return out;
  const time = value => (Number.isSafeInteger(value) && value > 0 ? value : null);
  out.lastRunAt = time(raw.lastRunAt); out.nextDueAt = time(raw.nextDueAt); out.lastActionAt = time(raw.lastActionAt);
  out.lastNote = clip(typeof raw.lastNote === 'string' ? raw.lastNote : '', 240);
  out.actions = Number.isSafeInteger(raw.actions) && raw.actions >= 0 ? raw.actions : 0; out.dayActions = Number.isSafeInteger(raw.dayActions) && raw.dayActions >= 0 ? raw.dayActions : 0;
  out.dayKey = typeof raw.dayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.dayKey) ? raw.dayKey : null; out.daySpentLamports = big(/^\d+$/.test(String(raw.daySpentLamports ?? '')) ? raw.daySpentLamports : 0).toString();
  out.finished = raw.finished === true; out.finishedReason = clip(typeof raw.finishedReason === 'string' ? raw.finishedReason : '', 200);
  out.launchMarketCapUsd = number(raw.launchMarketCapUsd) > 0 ? raw.launchMarketCapUsd : null;
  out.milestonesHit = Array.isArray(raw.milestonesHit) ? [...new Set(raw.milestonesHit.filter(value => Number.isFinite(value) && value > 1))].sort((a, b) => a - b) : [];
  return out;
}
/** After an objective change: counters and launch facts stay, every schedule field starts over so the new program computes its first due time fresh. */
export function resetProgramSchedule(raw) { const state = normalizeProgramState(raw); return { ...defaultProgramState(), actions: state.actions, lastActionAt: state.lastActionAt, launchMarketCapUsd: state.launchMarketCapUsd, milestonesHit: state.milestonesHit }; }
/** The descriptor a program is judged by: Research first hands over to the Long game rule after its quiet period. */
export function effectiveRule(objective) { const program = objective?.program; if (!program) return null; return program.then ? { id: program.then, rule: objectiveById(program.then)?.program || null } : { id: objective.id, rule: program }; }
export function programNeedsMarket(objective) { const found = effectiveRule(objective); const rule = found?.rule; return !!rule && (String(rule.condition || '').startsWith('priceChange') || rule.condition === 'curveProgressAtLeast' || Array.isArray(rule.multiples) || rule.stopWhenGraduated === true); }
/** Creator-set number for a rule, falling back to the catalogue default. */
export function settingValue(objective, key, settings) { const field = objective?.settings?.find(item => item.key === key); const given = settings && typeof settings === 'object' ? Number(settings[key]) : NaN; return Number.isFinite(given) ? given : field ? field.value : null; }

// ---- evidence ---------------------------------------------------------------------
/** 7-day volume against the 30-day average from daily samples ({dayKey, volume24hUsd}); not enough history is a condition that is not met. */
export function volumeTrend(history, now) {
  const today = Math.floor(now / DAY), rows = (Array.isArray(history) ? history : []).filter(row => row && typeof row.dayKey === 'string' && number(row.volume24hUsd) !== null && number(row.volume24hUsd) >= 0).map(row => ({ age: today - dayIndex(row.dayKey), volume: row.volume24hUsd })).filter(row => Number.isFinite(row.age) && row.age >= 0).sort((a, b) => a.age - b.age);
  const unique = []; const seen = new Set(); for (const row of rows) { if (seen.has(row.age)) continue; seen.add(row.age); unique.push(row); }
  const recent = unique.filter(row => row.age <= PROGRAM_RULES.volumeWindowDays + PROGRAM_RULES.volumeWindowSlackDays).slice(0, PROGRAM_RULES.volumeWindowDays), baseline = unique.filter(row => row.age <= PROGRAM_RULES.baselineWindowDays + PROGRAM_RULES.volumeWindowSlackDays);
  if (recent.length < PROGRAM_RULES.volumeWindowDays) return { ok: false, note: `Waiting: ${recent.length} of ${PROGRAM_RULES.volumeWindowDays} daily volume samples collected.` };
  if (baseline.length < PROGRAM_RULES.baselineMinimumSamples) return { ok: false, note: `Waiting: ${baseline.length} of ${PROGRAM_RULES.baselineMinimumSamples} daily samples for the 30-day volume baseline.` };
  const average = list => list.reduce((sum, row) => sum + row.volume, 0) / list.length;
  return { ok: true, average7d: average(recent), average30d: average(baseline), samples: baseline.length };
}
/** Experimenter: one window per UTC day at hour (dayIndex * 7) % 24; returns whether it is open now and the next start that respects the gap. */
export function experimentWindow(now, lastActionAt, gapMs) {
  const earliest = lastActionAt ? lastActionAt + gapMs : 0, today = Math.floor(now / DAY);
  for (let day = today; day < today + 60; day++) {
    const hour = (day * PROGRAM_RULES.experimentHourStep) % 24, start = day * DAY + hour * HOUR, end = start + HOUR, from = Math.max(start, earliest);
    if (from >= end) continue;
    if (from <= now && now < end) return { open: true, hour, start, next: start };
    if (from > now) return { open: false, hour, start, next: from };
  }
  return { open: false, hour: null, start: null, next: null };
}
/** Policy clamp mirrored from the executor so the program only proposes what can pass: per action, hourly and daily room, free balance after the network reserve, minimum principal. */
export function boundedAmount(want, { caps, free, spent, reserve, now }) {
  if (want <= 0n) return { ok: false, note: 'Nothing to spend under this rule right now.' };
  const hourRoom = caps.hourly - big(spent.hour), dayRoom = caps.daily - big(spent.day);
  if (dayRoom <= 0n) return { ok: false, note: 'Waiting: the daily treasury cap is used; it resets at 00:00 UTC.', nextDueAt: nextUtcDay(now) };
  if (hourRoom <= 0n) return { ok: false, note: 'Waiting: the hourly treasury limit is used.', nextDueAt: now + HOUR };
  let amount = min(want, caps.perAction, hourRoom, dayRoom);
  if (amount + reserve > free) amount = free - reserve;
  if (amount < caps.minimumPrincipal) return { ok: false, note: `Waiting: the permitted amount (${sol(amount > 0n ? amount : 0n)} SOL) is below the $5 minimum action; the treasury needs to grow first.` };
  return { ok: true, amount, capped: amount < want };
}

// ---- the rules -------------------------------------------------------------------
/**
 * Pure evaluation of one objective program for one pass.
 * Input: objective id, normalized settings, stored state, `now`, the agent's createdAt and capability mask,
 * treasury lamports ({availableLamports, reservedLamports, frozenLamports}), policy caps (null when no fresh
 * SOL price), spent {hour, day} lamports, network reserves per kind, the market snapshot, daily samples, fee
 * income since the last payout (lamports) and the number of open actions.
 * Output: { proposals: [{ kind, amountSol, lamports, reason, milestone? }], state, note }.
 */
export function evaluateObjectiveProgram(input) {
  const { objective: id, settings = {}, now, createdAt = null, capabilities = 0, treasury = {}, caps = null, spent = { hour: 0n, day: 0n }, reserves = {}, market = null, history = [], income = '0', openActions = 0 } = input;
  const objective = objectiveById(id); let state = { ...normalizeProgramState(input.state), lastRunAt: now };
  const skip = (note, nextDueAt = null, extra = {}) => { const text = clip(note, 240); return { proposals: [], state: { ...state, ...extra, lastNote: text, nextDueAt: nextDueAt ?? null }, note: text }; };
  if (!objective || !objective.program) return skip('No program for this objective.');
  const program = objective.program;
  if (program.action === 'limiter') return skip(`Limiter only: the model may propose a treasury action at most once per ${days(program.minGapMs)} days.`);
  const missing = objectiveMissingCapabilities(id, capabilities); if (missing.length) return skip(`Needs ${missingLabel(missing)}, which this agent launched without.`);
  if (state.finished) return skip(`Finished: ${state.finishedReason || 'the program is complete.'}`);
  const today = dayKey(now); if (state.dayKey !== today) state = { ...state, dayKey: today, daySpentLamports: '0', dayActions: 0 };
  // Research first: a quiet period, then the Long game rule.
  if (program.quietMs) { const until = (createdAt || now) + program.quietMs; if (now < until) return skip(`Reading for the first ${days(program.quietMs)} days; treasury actions start ${when(until)}.`, until); }
  const { id: ruleId, rule } = effectiveRule(objective); if (!rule) return skip('No program for this objective.');
  const prefix = `${objective.name} program`;
  const gap = rule.minGapMs || PROGRAM_RULES.gaps[ruleId] || 0;
  if (gap && state.lastActionAt && now - state.lastActionAt < gap) { const due = state.lastActionAt + gap; return skip(`Next ${rule.action === 'rewards' ? 'distribution' : 'buyback'} no earlier than ${when(due)}.`, due); }
  if (state.nextDueAt && now < state.nextDueAt) return skip(state.lastNote || `Next check at ${when(state.nextDueAt)}.`, state.nextDueAt);
  if (openActions > 0) return skip('Waiting: a treasury action is still in progress.');
  const gas = BigInt(AGENT_POLICY_V1.treasury.gasReserveLamports), available = big(treasury.availableLamports), reserved = big(treasury.reservedLamports), frozen = big(treasury.frozenLamports);
  const total = available + reserved + frozen, base = available - gas, free = base - reserved - frozen;
  if (base <= 0n) return skip('Waiting: the treasury holds only its gas reserve.');
  if (!caps) return skip('Waiting: a fresh SOL/USD price is needed for treasury actions.');
  const share = bps => base * BigInt(bps) / 10000n, dayRoom = caps.daily - big(spent.day);
  let kind = rule.action === 'rewards' ? 'holder_reward' : rule.action === 'rewardsOrBuyback' ? (hasCapability(capabilities, 'rewards') ? 'holder_reward' : 'buyback_burn') : 'buyback_burn';
  let want = 0n, reason = '', milestone = null;
  switch (ruleId) {
    case 'long_game': {
      const trend = volumeTrend(history, now); if (!trend.ok) return skip(trend.note);
      if (!(trend.average7d > trend.average30d)) return skip(`7-day volume (${usd(trend.average7d)}/day) is not above the 30-day average (${usd(trend.average30d)}/day).`);
      const floor = total * BigInt(rule.reserveBps) / 10000n, room = base - floor; if (room <= 0n) return skip(`The ${rule.reserveBps / 100}% SOL reserve (${sol(floor)} SOL) leaves nothing to spend.`);
      want = min(share(rule.maxTreasuryBps), room); reason = `${prefix}: 7-day volume (${usd(trend.average7d)}/day) is above the 30-day average (${usd(trend.average30d)}/day); ${rule.maxTreasuryBps / 100}% buyback, keeping ${rule.reserveBps / 100}% in SOL.`; break;
    }
    case 'dip_buyer': {
      const read = marketValue(market, 'priceChange24h', '24h price change'); if (read.note) return skip(read.note); const change = read.value;
      const drop = settingValue(objective, rule.settingKey, settings); if (!(change <= -drop)) return skip(`24h change ${pct(change)} is above the −${drop}% trigger.`);
      const room = share(rule.maxTreasuryBpsPerDay) - big(state.daySpentLamports); if (room <= 0n) return skip(`Today's ${rule.maxTreasuryBpsPerDay / 100}% dip budget is spent; it resets at 00:00 UTC.`, nextUtcDay(now));
      want = room; reason = `${prefix}: 24h price change ${pct(change)} is at or below −${drop}%; buyback within today's ${rule.maxTreasuryBpsPerDay / 100}% budget.`; break;
    }
    case 'metronome': {
      const interval = settingValue(objective, rule.intervalKey, settings) * HOUR, sharePct = settingValue(objective, rule.settingKey, settings);
      if (state.lastActionAt && now - state.lastActionAt < interval) return skip(`Next tick at ${when(state.lastActionAt + interval)}.`, state.lastActionAt + interval);
      want = share(Math.round(sharePct * 100)); reason = `${prefix}: scheduled ${sharePct}% buyback (tick ${state.actions + 1}).`; break;
    }
    case 'furnace': {
      if (state.dayActions >= rule.splits) return skip(`Today's ${rule.splits} burns are done; the next UTC day starts ${when(nextUtcDay(now))}.`, nextUtcDay(now));
      if (dayRoom <= 0n) return skip('Today’s treasury cap is used; the furnace resumes at 00:00 UTC.', nextUtcDay(now));
      want = min(caps.perAction, dayRoom); reason = `${prefix}: burn ${state.dayActions + 1} of ${rule.splits} today, as far as the daily cap allows.`; break;
    }
    case 'reserve_keeper': case 'balanced_book': {
      const floorBps = rule.floorBps ?? Math.round(settingValue(objective, rule.settingKey, settings) * 100), floor = total * BigInt(floorBps) / 10000n, excess = base - floor;
      if (excess <= 0n) return skip(`SOL after the gas reserve (${sol(base)} SOL) is at or below the ${floorBps / 100}% floor (${sol(floor)} SOL).`);
      if (rule.dailyCap && dayRoom <= 0n) return skip('Today’s treasury cap is used; it resets at 00:00 UTC.', nextUtcDay(now));
      want = rule.dailyCap ? min(excess, dayRoom) : excess; reason = `${prefix}: ${sol(excess)} SOL sits above the ${floorBps / 100}% SOL floor; buying back the excess${rule.dailyCap ? ' within the daily cap' : ''}.`; break;
    }
    case 'graduation_run': {
      if (market?.graduated === true) return skip('Graduated: the program is complete and will not propose again.', null, { finished: true, finishedReason: 'The coin graduated; the Graduation run is complete.' });
      const read = marketValue(market, 'progressPercent', 'curve progress'); if (read.note) return skip(read.note); const progress = read.value;
      if (progress < rule.threshold) return skip(`Launchpad progress ${progress.toFixed(1)}% is below ${rule.threshold}%.`);
      if (dayRoom <= 0n) return skip('Today’s treasury cap is used; it resets at 00:00 UTC.', nextUtcDay(now));
      want = min(caps.perAction, dayRoom); reason = `${prefix}: curve progress ${progress.toFixed(1)}% is at or above ${rule.threshold}%; buyback toward graduation within the daily cap.`; break;
    }
    case 'steady_in_storms': {
      const read = marketValue(market, 'priceChange24h', '24h price change'); if (read.note) return skip(read.note); const change = read.value;
      if (Math.abs(change) > rule.band) return skip(`24h change ${pct(change)} is outside the ±${rule.band}% calm band.`);
      want = share(rule.maxTreasuryBps); reason = `${prefix}: 24h change ${pct(change)} is within ±${rule.band}%; ${rule.maxTreasuryBps / 100}% buyback in calm weather.`; break;
    }
    case 'experimenter': {
      const window = experimentWindow(now, state.lastActionAt, gap); if (!window.open) return skip(window.next ? `Next experiment window: ${when(window.next)}.` : 'No experiment window is scheduled.', window.next);
      want = share(rule.maxTreasuryBps); reason = `${prefix}: ${rule.label} #${state.actions + 1} — ${rule.maxTreasuryBps / 100}% buyback at the rotating hour (${String(window.hour).padStart(2, '0')}:00 UTC).`; break;
    }
    case 'milestones': {
      const launch = number(state.launchMarketCapUsd); if (!launch) return skip('Waiting for the first market snapshot to set the launch market cap.');
      const read = marketValue(market, 'marketCapUsd', 'market cap'); if (read.note) return skip(read.note); const cap = read.value;
      const pending = rule.multiples.filter(multiple => !state.milestonesHit.includes(multiple)).sort((a, b) => a - b);
      if (!pending.length) return skip('All milestones were marked.', null, { finished: true, finishedReason: `All milestones (${rule.multiples.map(m => m + '×').join(', ')}) were marked.` });
      if (cap < pending[0] * launch) return skip(`Market cap ${usd(cap)} is ${(cap / launch).toFixed(2)}× the launch value (${usd(launch)}); next milestone ${pending[0]}× at ${usd(pending[0] * launch)}.`);
      milestone = pending[0]; want = share(rule.maxTreasuryBps); reason = `${prefix}: market cap ${usd(cap)} crossed ${milestone}× the launch value (${usd(launch)}); ${kind === 'holder_reward' ? 'holder reward' : 'buyback'} of up to ${rule.maxTreasuryBps / 100}% of the treasury.`; break;
    }
    case 'holders_first': {
      const interval = settingValue(objective, rule.intervalKey, settings) * DAY;
      if (state.lastActionAt && now - state.lastActionAt < interval) return skip(`Next distribution at ${when(state.lastActionAt + interval)}.`, state.lastActionAt + interval);
      const earned = big(income); if (earned <= 0n) return skip('No treasury income since the last distribution; nothing to share yet.');
      want = min(earned, base); reason = `${prefix}: ${sol(want)} SOL of treasury income since the last distribution goes to holders.`; break;
    }
    default: return skip('No program for this objective.');
  }
  const bounded = boundedAmount(want, { caps, free, spent, reserve: big(reserves[kind]), now });
  if (!bounded.ok) return skip(bounded.note, bounded.nextDueAt ?? null);
  const proposal = { kind, lamports: bounded.amount.toString(), amountSol: Number(bounded.amount) / 1e9, reason: clip(reason, 280), ...(milestone ? { milestone } : {}) };
  const note = clip(`Proposing ${sol(bounded.amount)} SOL: ${reason}`, 240);
  return { proposals: [proposal], state: { ...state, lastNote: note, nextDueAt: null }, note };
}
/** Program-state bookkeeping after the executor answered a program proposal (pure). */
export function recordProgramOutcome(state, { objective: id, settings = {}, proposal, accepted, principalLamports = '0', reason = '', now }) {
  const objective = objectiveById(id), found = effectiveRule(objective), rule = found?.rule || null;
  let next = { ...normalizeProgramState(state), lastRunAt: now }; const today = dayKey(now);
  if (next.dayKey !== today) next = { ...next, dayKey: today, daySpentLamports: '0', dayActions: 0 };
  if (!accepted) { next.lastNote = clip(`Proposal rejected: ${reason || 'the executor declined it.'} Next attempt ${when(now + PROGRAM_RULES.rejectBackoffMs)}.`, 240); next.nextDueAt = found?.id === 'metronome' ? now + settingValue(objective, rule.intervalKey, settings) * HOUR : now + PROGRAM_RULES.rejectBackoffMs; return next; }
  const principal = big(principalLamports);
  next.actions += 1; next.dayActions += 1; next.lastActionAt = now; next.daySpentLamports = (big(next.daySpentLamports) + principal).toString();
  if (proposal?.milestone && rule?.multiples) { next.milestonesHit = [...new Set([...next.milestonesHit, proposal.milestone])].sort((a, b) => a - b); if (rule.multiples.every(multiple => next.milestonesHit.includes(multiple))) { next.finished = true; next.finishedReason = `All milestones (${rule.multiples.map(m => m + '×').join(', ')}) were marked.`; } }
  next.nextDueAt = rule ? nextDueAfterAction(found.id, objective, rule, settings, next, now) : null;
  next.lastNote = clip(`Proposed ${sol(principal)} SOL: ${proposal?.reason || ''}`, 240);
  return next;
}
function nextDueAfterAction(ruleId, objective, rule, settings, state, now) {
  switch (ruleId) {
    case 'metronome': return now + settingValue(objective, rule.intervalKey, settings) * HOUR;
    case 'holders_first': return now + settingValue(objective, rule.intervalKey, settings) * DAY;
    case 'furnace': return state.dayActions >= rule.splits ? nextUtcDay(now) : now + PROGRAM_RULES.gaps.furnace;
    case 'graduation_run': return now + PROGRAM_RULES.gaps.graduation_run;
    case 'dip_buyer': return now + PROGRAM_RULES.gaps.dip_buyer;
    case 'experimenter': return experimentWindow(now, now, rule.minGapMs).next;
    case 'milestones': return null;
    default: return rule.minGapMs ? now + rule.minGapMs : null;
  }
}
/** Model proposals a program forbids right now (Research first quiet period, Patience limiter); null when allowed. */
export function modelProposalLimit({ objective: id, createdAt = 0, now, lastAcceptedAt = null }) {
  const objective = objectiveById(id), program = objective?.program; if (!program) return null;
  if (program.quietMs && now - (createdAt || 0) < program.quietMs) return `The ${objective.name} program blocks treasury proposals for the first ${days(program.quietMs)} days after launch (until ${when((createdAt || 0) + program.quietMs)}).`;
  if (program.action === 'limiter' && lastAcceptedAt && now - lastAcceptedAt < program.minGapMs) return `The ${objective.name} program allows one treasury proposal per ${days(program.minGapMs)} days; the last accepted proposal was on ${when(lastAcceptedAt)} and the next is allowed from ${when(lastAcceptedAt + program.minGapMs)}.`;
  return null;
}
/** Whether the platform is running the program right now, with the reason when it is not (public). */
export function programStatus({ objective: id, capabilities, state, now, createdAt = 0, financialOpen = true, live = true, archived = false, pausedReason = '' }) {
  const objective = objectiveById(id), program = objective?.program; if (!program) return null;
  const current = normalizeProgramState(state), missing = objectiveMissingCapabilities(id, capabilities);
  const off = reason => ({ active: false, reason });
  if (archived) return off('The agent is archived.');
  if (missing.length) return off(`Needs ${missingLabel(missing)}, which this agent launched without.`);
  if (current.finished) return off(current.finishedReason || 'The program finished.');
  if (!live) return off('Waiting for the coin launch to go live.');
  if (pausedReason) return off(pausedReason);
  if (!financialOpen) return off('Treasury actions are closed on this platform right now.');
  if (program.quietMs && now - (createdAt || 0) < program.quietMs) return off(`Reading for the first ${days(program.quietMs)} days (until ${when((createdAt || 0) + program.quietMs)}); no treasury action before then.`);
  return { active: true, reason: '' };
}

// ---- driver -----------------------------------------------------------------------
/**
 * One scheduler pass over every live agent: records the day's market sample and the launch market cap
 * for all of them, then evaluates the program of each agent whose objective has one and whose launch
 * capabilities satisfy it. Proposals go through `service.executor.propose` only; the chain is never touched here
 * (the executor's tick, which calls this, builds and signs from the saved proposals).
 */
export async function runObjectivePrograms(service, _chain = null) {
  const store = service.store(), now = service.now(), today = dayKey(now), effective = service.effective();
  const ledgerBlocked = store.openAlerts().some(alert => alert.scope === 'global' && alert.code === 'ledger');
  const price = service.lastSolUsd, fresh = !!price && freshPrice(price, now), gas = BigInt(AGENT_POLICY_V1.treasury.gasReserveLamports);
  for (const agent of store.allAgents({ includeArchived: false })) {
    if (service.closed) return;
    if (!agent.mint || agent.launchState !== 'live') continue;
    const objective = objectiveById(agent.objective || 'custom'), state = normalizeProgramState(agent.programState);
    const program = objective?.program && objective.program.action !== 'limiter' && !objectiveMissingCapabilities(objective.id, agent.capabilities).length ? objective.program : null;
    // Daily evidence for every live agent (programs chosen later need it too): one sample per UTC day and, from the
    // first daily snapshot that carries one, the launch market cap. Only programs that read the live market fetch it every pass.
    const sampled = !!store.marketSample(agent.id, today); let market = null;
    if (!sampled || (program && programNeedsMarket(objective))) { try { market = await service.runner.market(agent); } catch { market = null; } }
    if (market && market.stale !== true) {
      if (!sampled) { store.recordMarketSample({ agentId: agent.id, dayKey: today, at: now, priceUsd: market.priceUsd, marketCapUsd: market.marketCapUsd, volume24hUsd: market.volume24hUsd, priceChange24h: market.priceChange24h, progressPercent: market.progressPercent, graduated: market.graduated === true }); store.pruneMarketSamples(agent.id, dayKey(now - PROGRAM_RULES.pruneDays * DAY)); }
      if (state.launchMarketCapUsd === null && number(market.marketCapUsd) > 0) state.launchMarketCapUsd = market.marketCapUsd;
    }
    let next = state;
    if (program) {
      const paused = agent.integrityPaused ? 'Waiting: paused for an integrity check.' : agent.adminPaused ? 'Waiting: paused by the platform.' : agent.creatorPaused ? 'Waiting: paused by the creator.' : '';
      if (paused || !effective.financialOpen || ledgerBlocked) next = { ...state, lastRunAt: now, lastNote: paused || (!effective.financialOpen ? 'Waiting: treasury actions are closed on this platform.' : 'Waiting: the ledger audit must pass before new treasury actions.') };
      else {
        const balances = store.agentBalances(agent.id), available = BigInt(balances.sol.treasuryAvailable), liabilities = BigInt(balances.sol.treasuryReserved) + BigInt(balances.sol.rewardFrozen);
        let caps = null;
        if (fresh) { let baseline = agent.treasuryDayKey === today ? BigInt(agent.treasuryDayBaseline || '0') : available + liabilities - gas; if (baseline < 0n) baseline = 0n; try { caps = treasuryCaps({ baselineLamports: baseline, solUsdMicro: priceMicro(price.usd) }, AGENT_POLICY_V1); } catch { caps = null; } }
        const result = evaluateObjectiveProgram({ objective: objective.id, settings: agent.objectiveSettings || {}, state, now, createdAt: agent.createdAt, capabilities: agent.capabilities, treasury: { availableLamports: balances.sol.treasuryAvailable, reservedLamports: balances.sol.treasuryReserved, frozenLamports: balances.sol.rewardFrozen }, caps, spent: service.executor.spent(agent.id), reserves: { buyback_burn: service.executor.reserveFor('buyback_burn'), holder_reward: service.executor.reserveFor('holder_reward') }, market, history: store.marketSamples(agent.id, { limit: PROGRAM_RULES.baselineWindowDays + 2 }).map(sample => ({ dayKey: sample.dayKey, at: sample.at, volume24hUsd: sample.volume24hUsd, marketCapUsd: sample.marketCapUsd })), income: store.treasuryIncomeSince(agent.id, state.lastActionAt ?? agent.createdAt), openActions: store.openActions(agent.id).length });
        next = result.state;
        for (const proposal of result.proposals) {
          const outcome = service.executor.propose(agent, null, proposal.kind, { amountSol: proposal.amountSol, reason: proposal.reason }, { origin: 'program', objective: objective.id });
          const principal = outcome.accepted ? store.action(outcome.actionId)?.evaluation?.principal || proposal.lamports : '0';
          next = recordProgramOutcome(next, { objective: objective.id, settings: agent.objectiveSettings || {}, proposal, accepted: outcome.accepted === true, principalLamports: principal, reason: outcome.reason || '', now });
          service.emit(agent.id, { kind: 'action', title: outcome.accepted ? 'Program proposal queued' : 'Program proposal rejected' });
        }
      }
    }
    // Persist when anything but the heartbeat changed, and the heartbeat itself every five minutes.
    const stored = agent.programState && typeof agent.programState === 'object' ? agent.programState : {}, strip = value => JSON.stringify({ ...value, lastRunAt: null });
    if (strip(stored) !== strip(next) || (program && (!stored.lastRunAt || now - stored.lastRunAt >= 5 * 60000))) store.updateAgent(agent.id, { programState: next });
  }
}
