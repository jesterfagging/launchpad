// Robinhood launch venue: Launchpad-run holder rewards and the option modes, the Pump.fun Classic rules ported to the
// EVM venue. Holder snapshots come from the coin's own Transfer-log index (complete by construction), the window and
// allocation maths are the shared ones (src/agent/holders.mjs), payouts go through the LaunchPayouts contract in the
// coin's pair asset (ETH by value, an ERC-20 by allowance), Diamond Hands keeps streaks, Earned records a daily market
// cap against its baseline, Insured builds its pot from every claim.
import { rewardWindow, minimumBalances, topHolders, allocateRewards } from '../agent/holders.mjs';
import { diamondMultiplierBps, earnedFloor, insuredPotShare } from '../../public/pump-option-catalog.mjs';
import { ROBINHOOD_HOLDER_MODES, ROBINHOOD_OPTION_MODES, ROBINHOOD_NATIVE } from '../../public/robinhood-launch-catalog.mjs';
import { plannedSupply, unitsToUsd, parsePrice } from '../../public/robinhood-curve-math.mjs';
import { poolPrice } from '../../public/robinhood-pool-math.mjs';
import { ROBINHOOD_LAUNCH_POLICY, ledgerRole } from './policy.mjs';
import { launchKeys } from './keys.mjs';
import { newId } from './store.mjs';
import { formatUnits } from '../evm/hex.mjs';

const big = value => typeof value === 'bigint' ? value : BigInt(String(value ?? '0'));
const max0 = value => value > 0n ? value : 0n;
const lower = value => String(value || '').toLowerCase();
const MINUTE = 60000;
// The shared holder maths (src/agent/holders.mjs) counts in 64-bit integers, Solana's scale. Coin balances here carry
// 18 decimals, so a snapshot keeps them in millionths of a token (a 1 B supply is 1e15, well inside the range; the
// weights stay proportional), and a pot is allocated in the smallest unit that keeps it in range, the rest staying held.
const SAMPLE_UNIT = 10n ** 12n;
const U64_SAFE = 2n ** 62n;
export const sampleAmount = balance => String(big(balance) / SAMPLE_UNIT);
export function allocationUnit(amount) { let unit = 1n; while (big(amount) / unit > U64_SAFE) unit *= 1000n; return unit; }
const MAX_UINT = (1n << 256n) - 1n;
const amountText = (raw, decimals) => formatUnits(big(raw), decimals);

/** Coins whose holders are sampled: Holders, Diamond Hands and every option coin (their holders may be paid later). */
export const samplesHolders = launch => launch.state === 'created' && !!launch.fee_wallet && (ROBINHOOD_HOLDER_MODES.includes(launch.mode) || ROBINHOOD_OPTION_MODES.includes(launch.mode));
/** Coins paying holders now: Holders and Diamond Hands always; a failed Earned coin; an Insured coin owing its pot. */
export function holderPayoutActive(launch) {
  if (launch.state !== 'created' || !launch.fee_wallet) return false;
  if (ROBINHOOD_HOLDER_MODES.includes(launch.mode)) return true;
  const phase = launch.option?.state?.phase;
  if (launch.mode === 'earned') return phase === 'failed';
  if (launch.mode === 'insured') return phase === 'holders' || phase === 'bonus';
  return false;
}

/** An Insured coin keeps the coverage share of every claim as its refund pot (while the pot is still live). */
export function insuredCredit(service, launch, amount) {
  service.updateOption(launch, state => {
    if (!['active', 'holders'].includes(state.phase)) return false;
    const share = insuredPotShare(amount, launch.option.settings);
    state.pot = String(big(state.pot || '0') + share); state.potCredited = String(big(state.potCredited || '0') + share);
  });
}

/** The pair's USD price, or null when it cannot be read (the trigger then waits). */
async function pairPrice(service, launch) {
  try { const book = await service.pairBook(); return await book.priceUsd(launch.pair_token); } catch { return null; }
}
const minimumUnits = (usd, price, decimals) => { const p = parsePrice(price.usd); return p > 0n ? BigInt(Math.round(usd * 1e8)) * 10n ** BigInt(decimals) / p : 0n; };

/** The pending admin request for a payout, if any. */
function payoutRequest(service, launch) { try { return JSON.parse(service.store().cursor(launch.id, 'holder-payout-request') || 'null'); } catch { return null; } }
function clearRequest(service, launch) { service.store().setCursor(launch.id, 'holder-payout-request', 'null'); }
function noteLast(service, launch, outcome) { service.store().setCursor(launch.id, 'holder-payout-last', JSON.stringify({ at: service.now(), ...outcome })); }

export async function holdersPass(service, chain) {
  const store = service.store(), flags = service.effective(), policy = ROBINHOOD_LAUNCH_POLICY.holders;
  for (const launch of store.liveLaunches(service.config.addresses.poolManager).filter(samplesHolders)) {
    if (service.closed) return;
    try {
      const cycle = store.openRewardCycle(launch.id);
      if (cycle) { await payCycle(service, chain, launch, cycle); continue; }
      if (!flags.holders) continue;
      if (!service.throttle('sample:' + launch.id, policy.sampleIntervalMinutes * MINUTE - 15000)) {
        const exclude = new Set(service.curveWallets(launch));
        const rows = store.holders(launch.id, { limit: 5000 }).filter(h => !exclude.has(lower(h.owner))).map(h => ({ owner: lower(h.owner), amount: sampleAmount(h.balance) })).filter(h => h.amount !== '0');
        store.addHolderSample(launch.id, Number(store.cursor(launch.id, 'transfers') || 0), service.now(), rows);
        store.pruneHolderSamples(launch.id, service.now() - 3 * policy.windowMinutes * MINUTE);
      }
      if (!holderPayoutActive(launch)) continue;
      if (service.backoff('payout:' + launch.id)) continue;
      const request = payoutRequest(service, launch), due = duePayout(service, launch);
      const trigger = request ? { source: 'admin', request } : due ? { source: due } : await autoPayout(service, launch);
      if (!trigger) continue;
      await freezePayout(service, launch, trigger);
    } catch (error) { service.retryLater('payout:' + launch.id, error, { base: 60000 }); }
  }
}

/** Insured: a refund (deadline passed) or a graduation bonus pays the pot at once. */
function duePayout(service, launch) {
  const due = launch.option?.state?.refundDue; if (launch.mode !== 'insured' || !due) return null;
  return due === 'bonus' ? 'bonus' : 'insurance';
}

/** The automatic trigger: the held rewards are worth the threshold, and the last cycle is at least an interval old. */
async function autoPayout(service, launch) {
  const store = service.store(), policy = ROBINHOOD_LAUNCH_POLICY.holders;
  if (service.now() - Number(store.cursor(launch.id, 'reward-cycle-at') || 0) < policy.cycleIntervalMs || service.throttle('payout-check:' + launch.id, 5 * MINUTE)) return null;
  const held = service.payoutHeld(launch); if (held <= 0n) return null;
  const price = await pairPrice(service, launch); if (!price) return null;
  const usd = unitsToUsd(held, price.usd, launch.pair_decimals);
  if (!Number.isFinite(usd) || usd < service.payoutThresholdUsd()) return null;
  store.addEvent({ launchId: launch.id, kind: 'rewards', title: 'Holder payout started', body: `The holders’ share reached about $${usd.toFixed(2)} (${amountText(held, launch.pair_decimals)} ${launch.pair_symbol}).`, isPublic: false });
  return { source: 'auto', valueUsd: Math.round(usd * 100) / 100 };
}

/** Top holders by minimum balance over the reward window, or why the window is not ready. */
export function payoutWindow(service, launch) {
  const store = service.store(), policy = ROBINHOOD_LAUNCH_POLICY.holders;
  const samples = store.holderSamples(launch.id, service.now() - 2 * policy.windowMinutes * MINUTE).map(row => ({ at: row.at, slot: row.block, complete: true, rows: row.balances }));
  const window = rewardWindow(samples, { now: service.now(), windowMs: policy.windowMinutes * MINUTE, maxGapMs: policy.sampleIntervalMinutes * MINUTE + 60000 });
  if (!window.ok) return { ok: false, reason: `Waiting for an hour of holder snapshots: ${window.reason}` };
  return { ok: true, window, list: topHolders(minimumBalances(window.samples), { limit: policy.topHolders, exclude: new Set(service.curveWallets(launch)) }) };
}

/** Diamond Hands: a wallet whose minimum fell below the balance recorded at its last payout is skipped and reset; the rest grow a streak. */
export function diamondSelection(service, launch, list) {
  const store = service.store(), settings = launch.option?.settings || {}, streaks = store.streaks(launch.id), kept = [], updates = [], resets = [];
  for (const h of list) {
    const prior = streaks.get(lower(h.owner)), weight = big(h.weight);
    if (prior && weight < prior.balance) { resets.push({ owner: h.owner, streak: 0, balance: weight, had: prior.streak }); continue; }
    const streak = (prior?.streak || 0) + 1, multiplierBps = diamondMultiplierBps(streak, settings);
    kept.push({ owner: h.owner, weight: weight * BigInt(multiplierBps) / 10000n, streak, multiplierBps });
    updates.push({ owner: h.owner, streak, balance: weight });
  }
  if (resets.length) store.setStreaks(launch.id, resets);
  return { list: kept, updates, skipped: resets };
}

/** Drops holders whose share falls below the minimum and reallocates among the rest (bounded). Amounts come back in
 * the pair's smallest unit; what the allocation unit cannot split stays held for the next cycle. */
export function allocatePayouts(amount, list, minimum) {
  const unit = allocationUnit(amount), budget = big(amount) / unit, floor = (big(minimum) + unit - 1n) / unit;
  let holders = list, payouts = allocateRewards(budget, holders);
  for (let i = 0; i < 8 && payouts.some(p => p.lamports < floor); i++) { holders = holders.filter((h, index) => payouts[index].lamports >= floor); payouts = allocateRewards(budget, holders); }
  return payouts.filter(p => p.lamports > 0n && p.lamports >= floor).map(p => ({ ...p, lamports: p.lamports * unit }));
}

/** Freezes a reward cycle from the window, the held rewards and the option's rules. */
async function freezePayout(service, launch, trigger) {
  const store = service.store(), role = ledgerRole(launch.mode) || 'rewards', policy = ROBINHOOD_LAUNCH_POLICY.holders;
  const finish = outcome => { if (trigger.source === 'admin') clearRequest(service, launch); if (trigger.source === 'insurance' || trigger.source === 'bonus') service.updateOption(launch, state => { state.refundDue = null; }); noteLast(service, launch, { source: trigger.source, ...outcome }); };
  let amount = service.payoutHeld(launch);
  if (launch.mode === 'insured') { const state = launch.option?.state || {}; const pot = max0(big(state.pot || '0') - big(state.potPaid || '0')); amount = amount < pot ? amount : pot; }
  if (launch.pair_kind === 'native') amount -= 2n * BigInt(ROBINHOOD_LAUNCH_POLICY.reserves.keepWei); // the fee wallet keeps its gas
  const price = await pairPrice(service, launch);
  const minimum = price ? minimumUnits(policy.minimumPayoutUsd, price, launch.pair_decimals) : 0n;
  if (amount <= 0n || amount < minimum) { finish({ state: 'completed', reason: 'No holder rewards were waiting to be paid.' }); return; }
  const window = payoutWindow(service, launch);
  if (!window.ok) { if (trigger.source === 'admin') store.setCursor(launch.id, 'holder-payout-request', JSON.stringify({ ...trigger.request, waiting: window.reason })); return; }
  const diamond = launch.mode === 'diamond_hands' ? diamondSelection(service, launch, window.list) : null, list = diamond ? diamond.list : window.list;
  const payouts = allocatePayouts(amount, list, minimum);
  if (!payouts.length) { finish({ state: 'completed', reason: diamond?.skipped.length && !list.length ? 'Every top holder sold since the last payout; nothing is paid this round.' : 'No holder qualifies for a payout yet.' }); if (diamond) service.updateOption(launch, state => { state.skippedWallets = (state.skippedWallets || 0) + diamond.skipped.length; }); return; }
  const total = payouts.reduce((sum, p) => sum + p.lamports, 0n);
  const rows = payouts.map(p => { const h = diamond ? diamond.list.find(x => x.owner === p.owner) : null; return { owner: p.owner, weight: p.weight, amount: p.lamports.toString(), ...(h ? { streak: h.streak, multiplierBps: h.multiplierBps } : {}) }; });
  store.transaction(() => {
    store.insertRewardCycle({ id: newId('rc'), launchId: launch.id, asset: launch.pair_token, amount: total, payouts: rows, windowFrom: window.window.from, windowTo: window.window.to });
    store.adjust(launch.id, role, launch.pair_token, { debit: total });
    if (diamond) { store.setStreaks(launch.id, diamond.updates.filter(u => rows.some(r => r.owner === u.owner))); service.updateOption(launch, state => { state.skippedWallets = (state.skippedWallets || 0) + diamond.skipped.length; }); }
    if (trigger.source === 'admin') clearRequest(service, launch);
    if (trigger.source === 'insurance' || trigger.source === 'bonus') service.updateOption(launch, state => { state.refundDue = null; });
  });
  store.addEvent({ launchId: launch.id, kind: 'rewards', title: trigger.source === 'bonus' ? 'Graduation bonus frozen' : trigger.source === 'insurance' ? 'Holder refund frozen' : 'Holder payout frozen', body: `${amountText(total, launch.pair_decimals)} ${launch.pair_symbol} to ${rows.length} holders${diamond?.skipped.length ? `; ${diamond.skipped.length} skipped for selling` : ''}.` });
  noteLast(service, launch, { source: trigger.source, state: 'frozen', recipients: rows.length, amount: total.toString() });
}

/** Sends the next batch of a frozen cycle through the payouts contract (one batch in flight per coin). */
async function payCycle(service, chain, launch, cycle) {
  const store = service.store(), policy = ROBINHOOD_LAUNCH_POLICY.holders;
  if (service.openOp(launch.id, ['payout', 'approve-payouts'])) return;
  if (cycle.state === 'paying') { store.updateRewardCycle(cycle.id, { state: 'frozen' }); return; }
  const batch = cycle.payouts.slice(cycle.next_index, cycle.next_index + policy.batchSize);
  if (!batch.length) { store.updateRewardCycle(cycle.id, { state: 'complete' }); store.setCursor(launch.id, 'reward-cycle-at', service.now()); return; }
  const keys = await launchKeys(service.accounts.hostStore, launch), native = launch.pair_kind === 'native' || lower(launch.pair_token) === ROBINHOOD_NATIVE;
  if (!await service.hasGas(chain, launch, keys.fee)) return;
  const total = batch.reduce((sum, p) => sum + big(p.amount), 0n), to = batch.map(p => p.owner), amounts = batch.map(p => big(p.amount));
  if (!native) {
    const allowance = await chain.allowance(launch.pair_token, launch.fee_wallet, service.config.addresses.payouts);
    if (allowance < total) { await service.send(chain, { key: keys.fee, launchId: launch.id, kind: 'approve-payouts', to: launch.pair_token, data: chain.approveData(service.config.addresses.payouts, MAX_UINT) }); return; }
  }
  const expected = { cycleId: cycle.id, nextIndex: cycle.next_index + batch.length, batch: batch.map(p => ({ owner: p.owner, amount: p.amount })), role: ledgerRole(launch.mode) || 'rewards', total: total.toString() };
  const op = native
    ? await service.send(chain, { key: keys.fee, launchId: launch.id, kind: 'payout', to: service.config.addresses.payouts, data: chain.payEthData(to, amounts), value: total, expected })
    : await service.send(chain, { key: keys.fee, launchId: launch.id, kind: 'payout', to: service.config.addresses.payouts, data: chain.payTokenData(launch.pair_token, to, amounts), expected });
  store.updateRewardCycle(cycle.id, { state: 'paying' });
  service.log('robinhood-launch-payout-sent', { launch: launch.id, cycle: cycle.id, recipients: batch.length, hash: op.hash });
}

/** Earned's daily record and Insured's deadline. */
export async function optionsPass(service) {
  const store = service.store();
  for (const launch of store.liveLaunches(service.config.addresses.poolManager).filter(l => l.option && ['earned', 'insured'].includes(l.mode))) {
    if (service.closed) return;
    const state = launch.option.state || {};
    try {
      if (launch.mode === 'earned' && state.phase === 'probation' && service.now() >= Number(state.nextCheckAt || 0)) {
        const marketCap = marketCapOf(service, launch); if (marketCap === null) continue;
        earnedCheck(service, launch, marketCap);
      } else if (launch.mode === 'insured' && state.phase === 'active' && service.now() >= Number(state.deadlineAt || 0) && !service.throttle('option:' + launch.id, 3600000)) {
        insuredDeadlinePassed(service, launch);
      }
    } catch (error) { service.retryLater('option:' + launch.id, error, { base: 300000 }); }
  }
}

/** The coin's market cap in the pair asset from the last pool reading: the pool's price × the whole supply. */
export function marketCapOf(service, launch) {
  const store = service.store();
  let pool = null; try { pool = JSON.parse(store.cursor(launch.id, 'pool-state') || 'null'); } catch { pool = null; }
  if (!pool) return null;
  const supply = plannedSupply(ROBINHOOD_LAUNCH_POLICY.config.totalSupply, big(launch.virtual_quote), big(launch.graduation_quote));
  return poolPrice(pool.sqrtPriceX96, pool.tokenIs0) * supply.supply / 10n ** 18n;
}

export function earnedCheck(service, launch, marketCap) {
  const store = service.store(), settings = launch.option.settings; let outcome = null;
  service.updateOption(launch, state => {
    if (state.phase !== 'probation') return false;
    const at = service.now(), check = { at, marketCap: marketCap.toString(), ok: true };
    if (!state.baseline) { state.baseline = marketCap.toString(); state.floor = earnedFloor(marketCap, settings).toString(); outcome = 'baseline'; }
    else if (marketCap < big(state.floor)) { check.ok = false; state.phase = 'failed'; state.decidedAt = at; outcome = 'failed'; }
    else if (at >= Number(state.probationEndsAt)) { state.phase = 'earned'; state.decidedAt = at; outcome = 'earned'; }
    else outcome = 'ok';
    state.latest = { at, marketCap: marketCap.toString() }; state.checks = [...(state.checks || []), check].slice(-30);
    state.nextCheckAt = at + 86400000;
  });
  if (!outcome) return;
  const body = `Market cap ${amountText(marketCap, launch.pair_decimals)} ${launch.pair_symbol}`;
  if (outcome === 'baseline') store.addEvent({ launchId: launch.id, kind: 'option', title: 'Baseline recorded', body: `${body}. The floor is ${settings.floorPercent}% of it: ${amountText(earnedFloor(marketCap, settings), launch.pair_decimals)} ${launch.pair_symbol}.` });
  else if (outcome === 'failed') store.addEvent({ launchId: launch.id, kind: 'option', title: 'Probation failed', body: `${body}, below the floor. The escrow and every later creator fee now pay holders.` });
  else if (outcome === 'earned') store.addEvent({ launchId: launch.id, kind: 'option', title: 'Probation passed', body: `${body}. The escrow is released to the creator, who now receives every creator fee.` });
  else store.addEvent({ launchId: launch.id, kind: 'option', title: 'Daily record above the floor', body: body + '.', isPublic: false });
}

export function insuredDeadlinePassed(service, launch) {
  const store = service.store(); let pot = null;
  service.updateOption(launch, state => { if (state.phase !== 'active') return false; state.phase = 'holders'; state.refundDue = 'refund'; state.decidedAt = service.now(); pot = big(state.pot || '0'); });
  if (pot === null) return;
  store.addEvent({ launchId: launch.id, kind: 'option', title: 'Graduation deadline missed', body: `The refund pot (${amountText(pot, launch.pair_decimals)} ${launch.pair_symbol}) is paid to holders, and the coverage share of every later creator fee goes to holders too.` });
}

export function cycleView(service, launch, c) {
  return { state: c.state, asset: launch.pair_symbol, amount: amountText(c.amount, launch.pair_decimals), paid: amountText(c.paid, launch.pair_decimals), recipients: c.payouts.length, skipped: Number(c.skipped || 0), at: c.created_at };
}
export function payoutView(service, launch) {
  if (!holderPayoutActive(launch)) return null;
  const store = service.store(), request = payoutRequest(service, launch);
  let last = null; try { last = JSON.parse(store.cursor(launch.id, 'holder-payout-last') || 'null'); } catch { last = null; }
  return { asset: launch.pair_symbol, thresholdUsd: service.payoutThresholdUsd(), held: amountText(service.payoutHeld(launch), launch.pair_decimals), open: request ? { source: 'admin', at: request.at, waiting: request.waiting || '' } : store.openRewardCycle(launch.id) ? { source: 'cycle', at: store.openRewardCycle(launch.id).created_at } : null, last };
}
