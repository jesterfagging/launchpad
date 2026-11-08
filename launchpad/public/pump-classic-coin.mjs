// Pump.fun coins on the coin page. Launchpad created these coins but does not route
// their trades, so the trade card links to Pump.fun. The panel shows what Launchpad
// verified onchain for the coin: its locked fee-sharing recipients, distributed
// creator fees, holder reward cycles and the managed strategy, if any. Platform
// share percentages are documented only in /docs#revenue. Launchpad's internal
// activity (funding, refunds, account closures) is not shown publicly.
import { PUMP_CLASSIC_FEE_LINK, PUMP_CLASSIC_MODE_SUMMARIES } from './pump-classic-catalog.mjs';

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, SOL_TEXT = /^-?\d{1,12}(\.\d{1,9})?$/;
export const isPumpClassicCoin = coin => coin?.platform === 'pump-classic';
const PAID_TO = Object.freeze({ developer: 'Paid to the creator wallet', rewards: 'Paid to holder rewards', gotchi: 'Paid to the Gotchi pot', agent: 'Paid to the AI agent', strategy: 'Paid to the strategy wallet', escrow: 'Paid into the creator escrow', insured: 'Paid to the creator share and refund pot' });
const OPTION_PHASES = Object.freeze({ active: 'active', probation: 'probation', earned: 'earned', failed: 'failed', holders: 'holders', bonus: 'bonus', released: 'released', pending: 'pending' });
const daysText = n => Number.isSafeInteger(n) ? (n === 1 ? '1 day' : n + ' days') : '—';
const short = value => value.slice(0, 5) + '…' + value.slice(-4);
const solText = value => SOL_TEXT.test(String(value ?? '')) ? String(value) + ' SOL' : '—';
const AMOUNT_TEXT = /^-?\d{1,20}(\.\d{1,12})?$/, SYMBOL = /^[\p{L}\p{N}._$+\/…-]{1,24}$/u;
/** An amount in the coin's pair asset (SOL for SOL coins); the symbol comes from the server's verified pair. */
const pairText = (value, symbol) => AMOUNT_TEXT.test(String(value ?? '')) ? String(value) + ' ' + (SYMBOL.test(String(symbol || '')) ? symbol : 'SOL') : '—';
const percent = bps => (Number(bps) / 100).toFixed(2).replace(/\.?0+$/, '') + '%';
const when = value => Number.isSafeInteger(value) && value > 0 ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

/** Trade card for a Pump.fun coin: an outbound link, never a Launchpad-signed trade. */
export function createPumpClassicTrade({ document, root }) {
  let coin = null; root.classList.add('coin-trade-panel');
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
  function render() {
    root.hidden = !coin?.mint; if (!coin?.mint) { root.replaceChildren(); return; }
    const heading = el('div', null, 'ct-heading'), link = el('a', 'Trade on Pump.fun ↗', 'ct-action pc-trade-link');
    heading.append(el('h2', 'Trade'), el('span', coin.stage === 'graduated' ? 'PumpSwap' : 'Pump.fun bonding curve'));
    link.href = 'https://pump.fun/coin/' + encodeURIComponent(coin.mint); link.target = '_blank'; link.rel = 'noopener noreferrer';
    root.replaceChildren(heading, el('p', coin.stage === 'graduated' ? 'This coin graduated to PumpSwap. Trade it on Pump.fun or any Solana wallet that routes PumpSwap.' : 'This coin trades on Pump.fun’s bonding curve and moves to PumpSwap at graduation. Launchpad does not route or sign these trades.', 'ct-note'), link);
  }
  return { setCoin(next) { coin = next; render(); }, setSession() {}, refresh() {}, checkSaved() {}, canLeave: () => true, destroy() { coin = null; root.replaceChildren(); } };
}

/**
 * Coin panel for a Pump.fun coin. `api(path)` returns parsed JSON or throws;
 * the data comes from GET /api/launchpad/pump-classic/coin?mint=…
 */
export function createPumpClassicPanel({ document, root, api, mint, clock = Date.now }) {
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (cls) node.className = cls; return node; };
  const link = (text, href) => { const a = el('a', text); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; };
  root.classList.add('pump-classic-coin');
  let data = null, busy = false, error = '', nextAt = 0, disposed = false;
  function facts(rows) { const list = el('dl', null, 'pc-facts'); for (const [label, value] of rows) { const row = el('div'), dd = el('dd'); if (value instanceof Object && value.nodeType) dd.append(value); else dd.textContent = value; row.append(el('dt', label), dd); list.append(row); } return list; }
  function address(value) { if (!ADDRESS.test(value || '')) return '—'; return link(short(value) + ' ↗', 'https://solscan.io/account/' + value); }
  /** The launch option's rules and where its lifecycle stands (v71.35), from the server's verified view. */
  function optionSection(option, pair) {
    const box = el('div', null, 'pc-section pc-option'), phase = OPTION_PHASES[option.phase] || 'pending';
    box.dataset.option = String(option.kind || ''); box.dataset.phase = phase;
    const head = el('div', null, 'pc-option-head'); head.append(el('h3', String(option.label || 'Launch option')));
    const status = el('span', String(option.phaseLabel || phase), 'pc-status'); status.dataset.status = phase; head.append(status); box.append(head);
    if (option.description) box.append(el('p', String(option.description), 'pc-note'));
    if (option.kind === 'diamond_hands') {
      const cap = Number.isSafeInteger(option.capStreak) ? option.capStreak : null;
      box.append(facts([['Payouts so far', String(Number(option.payouts) || 0)], ['Wallets on a streak', String(Number(option.holding) || 0)], ...(option.lastPayout ? [['Last payout', `${when(option.lastPayout.at)} · ${Number(option.lastPayout.paid) || 0} paid · ${Number(option.lastPayout.skipped) || 0} skipped for selling`]] : []), ...(cap ? [['Full bonus from streak', String(cap)]] : [])]));
      if (Array.isArray(option.streaks) && option.streaks.length) {
        const list = facts(option.streaks.filter(s => ADDRESS.test(s.owner || '')).map(s => [address(s.owner), `streak ${Number(s.streak) || 0} · ${(Number(s.multiplierBps) / 100 || 100).toFixed(0)}% share weight`])); list.classList.add('pc-timeline'); box.append(el('h4', 'Longest streaks'), list);
      }
      box.append(el('p', 'Streaks are counted from the coin’s payouts: holding through a payout without the wallet’s balance dropping adds one; any drop resets it.', 'pc-fine'));
    } else if (option.kind === 'earned') {
      box.append(facts([['Escrow waiting', solText(option.escrowSol)], ['Released to the creator', solText(option.releasedSol)], ['Paid to holders', solText(option.paidToHoldersSol)], ['Baseline market cap', option.baselineSol ? solText(option.baselineSol) : 'Recorded a day after launch'], ['Floor', option.floorSol ? solText(option.floorSol) : '—'], ['Latest record', option.latestSol ? `${solText(option.latestSol)} · ${when(option.latestAt)}` : '—'], ...(phase === 'probation' ? [['Probation ends', `${when(option.probationEndsAt)} · ${daysText(option.daysLeft)} left`], ['Next record', when(option.nextCheckAt)]] : [['Decided', when(option.decidedAt)]])]));
      if (Array.isArray(option.checks) && option.checks.length) { const list = facts(option.checks.map(c => [when(c.at), `${solText(c.marketCapSol)} · ${c.ok === false ? 'below the floor' : 'above the floor'}`])); list.classList.add('pc-timeline'); box.append(el('h4', 'Daily records'), list); }
      box.append(el('p', 'Market caps are read from the coin’s curve or pool in SOL. Nothing in the escrow can be released before the probation ends, and nothing here promises price or payout.', 'pc-fine'));
    } else if (option.kind === 'insured') {
      box.append(facts([['Refund pot', solText(option.potSol)], ['Coverage', `${Number(option.settings?.coveragePercent) || 0}% of the creator’s fee share`], ['Graduation deadline', `${when(option.deadlineAt)}${phase === 'active' ? ' · ' + daysText(option.daysLeft) + ' left' : ''}`], ['If it graduates in time', option.target === 'holders' ? 'The pot is paid to holders as a bonus' : 'The pot is released to the creator'], ['Paid to holders from the pot', solText(option.potPaidSol)], ['Released to the creator', solText(option.potReleasedSol)], ['Creator share paid', solText(option.creatorPaidSol)], ...(phase !== 'active' ? [['Decided', when(option.decidedAt)]] : [])]));
      box.append(el('p', 'The pot and the creator’s share are held in one Launchpad wallet for the coin; the pot is never swept to the creator before a graduation in time. Refunds and bonuses are paid like holder rewards.', 'pc-fine'));
    }
    return box;
  }
  function render() {
    if (disposed) return;
    const children = [];
    const heading = el('div', null, 'pc-heading'), title = el('h2', 'Pump.fun'); heading.append(title);
    if (data) heading.append(el('span', data.modeLabel || data.mode, 'pc-mode'));
    children.push(heading);
    if (!data) { children.push(el('p', error || 'Loading this coin’s Pump.fun details…', error ? 'pc-note negative' : 'pc-note')); root.replaceChildren(...children); root.hidden = false; return; }
    if (PUMP_CLASSIC_MODE_SUMMARIES[data.mode]) children.push(el('p', PUMP_CLASSIC_MODE_SUMMARIES[data.mode], 'pc-note'));
    const venue = data.venue === 'amm' ? 'PumpSwap (graduated)' : data.venue === 'migrating' ? 'Graduating to PumpSwap' : 'Pump.fun bonding curve';
    const pair = data.pair?.symbol && SYMBOL.test(data.pair.symbol) ? data.pair.symbol : 'SOL', onPair = pair !== 'SOL' || (data.pair?.mint && data.pair.mint !== 'So11111111111111111111111111111111111111112');
    children.push(facts([['Market', venue], ['Paired with', pair], ...(Number(data.creatorFeeBps) > 0 ? [['Creator fee', percent(data.creatorFeeBps) + ' · chosen at launch']] : []), ['Live since', when(data.liveAt)], ['Creator-fee sharing', data.feeState === 'verified' ? 'Locked at creation · verified' : data.feeState === 'mismatch' ? 'Does not match the recorded recipients' : 'Checking onchain'], ['Trade', link('pump.fun ↗', /^https:\/\/pump\.fun\//.test(data.pumpUrl || '') ? data.pumpUrl : 'https://pump.fun/coin/' + mint)]]));
    // Recipients of the coin's native fee sharing, exactly as verified onchain.
    const recipients = el('div', null, 'pc-section'); recipients.append(el('h3', 'Creator-fee recipients'));
    recipients.append(facts((data.recipients || []).map(r => [r.label, address(r.address)])));
    const shares = el('p', null, 'pc-fine'), docs = link('Fees & revenue', PUMP_CLASSIC_FEE_LINK); docs.target = '_blank'; shares.append(document.createTextNode('Shares are set once at creation and cannot be changed. See '), docs, document.createTextNode(' in the docs.'));
    const fees = data.fees || {}, distributed = fees.distributed ?? fees.distributedSol, recipient = fees.recipient ?? fees.recipientSol, unit = SYMBOL.test(String(fees.symbol || '')) ? fees.symbol : pair, holders = data.mode === 'holders' || data.mode === 'diamond_hands' || (Array.isArray(data.rewards) && !!data.holderRewards);
    recipients.append(facts([['Creator fees distributed', pairText(distributed, unit)], [PAID_TO[(data.recipients || [])[1]?.role] || 'Paid to the recipient', pairText(recipient, unit)],
      ...(holders && fees.paidToHolders != null ? [['Paid out to holders', pairText(fees.paidToHolders, unit)]] : []), ...(onPair && !holders && fees.convertedSol != null ? [['Converted to SOL by Launchpad', solText(fees.convertedSol)]] : [])]), shares);
    if (onPair) recipients.append(el('p', holders ? `Creator fees are paid in ${unit}, and Launchpad pays holder rewards in ${unit}. It sells only a small part for holders’ new ${unit} accounts and network fees.` : `Creator fees are paid in ${unit}. Launchpad converts the shares it holds to SOL before paying them out${data.mode === 'creator' ? '; the creator’s share is paid in ' + unit + ' directly' : ''}.`, 'pc-fine'));
    children.push(recipients);
    if (data.strategy) {
      const s = data.strategy, box = el('div', null, 'pc-section'); box.append(el('h3', s.label || 'Strategy'));
      const status = el('span', s.statusLabel || s.status, 'pc-status'); status.dataset.status = s.status || '';
      box.append(facts([['Status', status], ['Bot wallet', address(s.wallet)], ['SOL', solText(s.cashSol)], ['Contributed capital', solText(s.contributedSol)], ['Value', solText(s.equitySol)], ['Result', solText(s.resultSol)], ['Network fees spent', solText(s.feesSpentSol)], ['Last action', when(s.lastActionAt)]]));
      if (s.pauseReason) box.append(el('p', s.pauseReason, 'pc-note'));
      box.append(el('p', 'The bot trades from its own Launchpad-managed wallet, never the wallet that created the coin. Nothing here promises price support, volume or profit.', 'pc-fine'));
      children.push(box);
    }
    if (data.option && typeof data.option === 'object') children.push(optionSection(data.option, pair));
    if (Array.isArray(data.rewards)) {
      const box = el('div', null, 'pc-section'), info = data.holderRewards || {}, asset = SYMBOL.test(String(info.asset || '')) ? info.asset : pair;
      const threshold = Number.isFinite(Number(info.thresholdUsd)) && Number(info.thresholdUsd) > 0 ? '$' + Number(info.thresholdUsd).toLocaleString('en-US') : 'about $100', top = Number.isSafeInteger(info.topHolders) && info.topHolders > 0 ? info.topHolders : 100;
      const title = data.mode === 'earned' ? 'Escrow paid to holders' : data.mode === 'insured' ? 'Refund pot paid to holders' : 'Holder rewards';
      // Reward baskets (v71.35): the assets, each extra asset's distributed and waiting amounts, and where the round stands.
      const basket = data.basket && typeof data.basket === 'object' && Array.isArray(data.basket.assets) && data.basket.assets.length > 1 ? data.basket : null;
      const names = basket ? basket.assets.map(a => SYMBOL.test(String(a?.symbol || '')) ? a.symbol : '').filter(Boolean) : [];
      const paidIn = basket && names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} (equal shares; the extra shares are bought at market from the rewards wallet each round)` : asset;
      box.append(el('h3', title), el('p', data.mode === 'diamond_hands' ? `Paid in ${asset} to the top ${top} holders by minimum balance over the last hour, whenever the holders’ share reaches ${threshold}; a wallet that sold since its last payout is skipped.` : `Paid in ${paidIn} to the top ${top} holders by minimum balance over the last hour, whenever the holders’ share reaches ${threshold}.`, 'pc-note'));
      if (basket) {
        const rows = basket.assets.slice(1).filter(a => SYMBOL.test(String(a?.symbol || ''))).map(a => [a.symbol, `${pairText(a.distributed ?? '0', a.symbol)} paid out · ${pairText(a.pending ?? '0', a.symbol)} waiting${Number.isSafeInteger(a.payments) && a.payments > 0 ? ` · ${a.payments} round${a.payments === 1 ? '' : 's'}` : ''}`]);
        if (rows.length) { const table = facts(rows); table.classList.add('pc-basket'); box.append(table); }
        const stage = { convert: 'A reward round is in progress: buying the basket assets.', pay: 'A reward round is in progress: paying holders asset by asset.', collect: 'A reward round is starting: collecting this coin’s creator fees.' }[String(basket.stage || '')];
        if (stage) box.append(el('p', stage, 'pc-note'));
      }
      const label = { frozen: 'scheduled', paying: 'paying', complete: 'paid' };
      // Reward cycles read as a timeline (coin.css styles .pc-timeline).
      if (data.rewards.length) { const cycles = facts(data.rewards.map(c => { const unitText = SYMBOL.test(String(c.asset || '')) ? c.asset : 'SOL'; return [when(c.at), `${pairText(c.paid ?? c.paidSol, unitText)} of ${pairText(c.amount ?? c.amountSol, unitText)} · ${Number(c.recipients) || 0} holders · ${label[c.state] || 'checking'}`]; })); cycles.classList.add('pc-timeline'); box.append(cycles); }
      children.push(box);
    }
    root.replaceChildren(...children); root.hidden = false;
  }
  async function refresh(force = false) {
    if (disposed || busy || (!force && clock() < nextAt)) return;
    busy = true;
    try { const next = await api('/api/launchpad/pump-classic/coin?mint=' + encodeURIComponent(mint)); if (disposed) return; if (next?.mint !== mint) throw Error('The coin details could not be verified.'); data = next; error = ''; nextAt = clock() + 30000; }
    catch (e) { if (!disposed) { error = e?.status === 404 ? 'Pump.fun details are not available for this coin.' : 'Pump.fun details are temporarily unavailable.'; nextAt = clock() + 15000; } }
    finally { busy = false; render(); }
  }
  render();
  return { refresh, render, destroy() { disposed = true; root.replaceChildren(); }, get data() { return data; } };
}
