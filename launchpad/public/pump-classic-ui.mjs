// Pump.fun launch flow for the launch page: quote → one wallet-signed funding
// transfer → Launchpad creates the coin on Pump.fun and delivers the dev buy →
// unused funding is refunded. The server owns every key and every chain step;
// this module only shows the reviewed quote, asks the wallet to sign the exact
// prepared transfer and follows the saved launch until it settles.
import { PUMP_CLASSIC_STATES, PUMP_CLASSIC_FEE_LINK } from './pump-classic-catalog.mjs';

const ID = /^[a-f0-9]{24}$/, ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,100}$/;
const ACTIVE = new Set(['awaiting_funding', 'funding_pending', 'funded', 'creating', 'refunding']);
const DONE = new Set(['created', 'failed', 'refunded', 'cancelled', 'expired']);
const STEPS = Object.freeze([['quote', 'Review'], ['fund', 'Fund'], ['create', 'Create'], ['live', 'Live']]);
const stepOf = state => state === 'awaiting_funding' ? 'quote' : state === 'funding_pending' ? 'fund' : ['funded', 'creating', 'failed', 'refunding', 'refunded'].includes(state) ? 'create' : state === 'created' ? 'live' : 'quote';
const MESSAGES = Object.freeze({
  funding_pending: 'Waiting for your funding transfer to finalize. Nothing else needs your approval.',
  funded: 'Funding finalized. Launchpad is creating your coin on Pump.fun.',
  creating: 'Creating your coin, fee sharing and dev buy in one transaction…',
  created: 'Your coin is live on Pump.fun.',
  refunding: 'The launch did not complete. Returning your funding…',
  refunded: 'Your funding was refunded.',
  expired: 'This quote expired before funding. Start over for a fresh quote.',
  cancelled: 'This quote was cancelled. Nothing was funded.',
});
// What happened to the funding of a failed launch (its refund dimension).
const REFUND_NOTES = Object.freeze({
  pending: ' Your funding is being refunded automatically.', released: ' Your funding is being refunded automatically.',
  complete: ' Your unused funding was refunded.', not_needed: ' Nothing was left to refund.',
});
const refunding = launch => launch?.state === 'failed' && ['pending', 'released'].includes(launch.dimensions?.refund);
/** Plain SOL text to lamports (string), at most 9 decimals. */
export function solToLamports(value) {
  const text = String(value ?? '').trim() || '0';
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,9})?$/.test(text)) throw Error('Enter a SOL amount with up to 9 decimals.');
  const [whole, fraction = ''] = text.split('.'); return (BigInt(whole) * 1000000000n + BigInt((fraction + '000000000').slice(0, 9))).toString();
}
const tokens = raw => { try { return (BigInt(raw) / 1000000n).toLocaleString('en-US'); } catch { return '—'; } };
const short = address => address.slice(0, 5) + '…' + address.slice(-4);
const percent = bps => (Number(bps) / 100).toFixed(2).replace(/\.?0+$/, '') + '%';
/** The pair symbol of a launch view ('SOL' for SOL coins). */
const pairSymbol = launch => typeof launch?.pair?.symbol === 'string' && launch.pair.symbol ? launch.pair.symbol : 'SOL';
const onPair = launch => !!launch?.pair?.mint && launch.pair.mint !== 'So11111111111111111111111111111111111111112';
/** Total funding text: SOL, plus the dev-buy amount of the pair asset on another pair. */
const fundingText = (launch, q) => q.totalSol + ' SOL' + (onPair(launch) && q.pairAmountRaw && q.pairAmountRaw !== '0' ? ' + ' + q.pairAmount + ' ' + pairSymbol(launch) : '');

/**
 * @param {object} options
 * @param {(path: string, body?: object) => Promise<any>} options.request  /api/launchpad/pump-classic client (GET when body is undefined)
 * @param {{ state(): { address: string }, sign(input: { wallet: string, transaction: string }): Promise<string> }} options.wallet
 * @param {() => object} options.getInput  launch details from the page; throws a readable error when incomplete
 * @param {(busy: boolean) => void} [options.onBusy]  a request (quote, funding, start over) starts or ends
 * @param {(launch: object|null) => void} [options.onUpdate]  a launch was quoted, changed state, was cancelled or was opened (the page reloads its list)
 * @param {() => void} [options.connectWallet]  opens the page's wallet chooser when a step needs a signature and no wallet is connected
 */
export function createPumpClassicLaunch({ document, window = document.defaultView, root, request, wallet, getInput, context = () => ({ active: true }), onChange = () => {}, onBusy = () => {}, onLive = () => {}, onUpdate = () => {}, connectWallet = null, coinLink = launch => launch.coinUrl || '/coin?mint=' + encodeURIComponent(launch.mint), clock = Date.now, setTimer = (fn, ms) => window.setTimeout(fn, ms), clearTimer = id => window.clearTimeout(id) }) {
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined && text !== null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  root.classList.add('pump-classic-operation');
  const track = el('ol', null, 'launch-flow-track pump-classic-track'); track.setAttribute('aria-label', 'Launch progress');
  for (const [key, label] of STEPS) { const item = el('li'); item.dataset.flowStep = key; item.append(el('span', null, 'launch-flow-dot'), document.createTextNode(label)); track.append(item); }
  const facts = el('dl', null, 'pump-classic-facts'), disclosure = el('ul', null, 'pump-classic-disclosure'), notice = el('p', '', 'help pump-classic-status'), links = el('div', null, 'pump-classic-links'), actions = el('div', null, 'pump-classic-actions');
  notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  // Programmatic focus targets for when the focused button hides itself (Review after a quote, Fund after funding).
  for (const target of [notice, facts]) target.tabIndex = -1;
  const review = el('button', 'Review launch', 'primary'), fund = el('button', 'Fund and launch', 'primary'), retry = el('button', 'Retry submission', 'small-button'), cancel = el('button', 'Start over', 'small-button'), coin = el('a', 'Open coin →', 'primary');
  for (const b of [review, fund, retry, cancel]) b.type = 'button';
  actions.append(review, fund, retry, cancel, coin); root.replaceChildren(track, facts, disclosure, notice, links, actions);
  let launch = null, busy = false, message = '', negative = false, pendingSubmit = null, pollTimer = null, tickTimer = null, disposed = false, requestKey = '', announced = '', refocus = false;
  const active = () => !disposed && context().active === true;
  const say = (text, bad = false) => { message = text; negative = bad; render(); };
  const valid = value => !!value && ID.test(value.id || '') && typeof value.state === 'string' && ADDRESS.test(value.mint || '');
  const quoteExpired = () => launch?.state === 'awaiting_funding' && Number.isFinite(launch.quote?.expiresAt) && launch.quote.expiresAt <= clock();
  function newRequestKey() { const bytes = new Uint8Array(16); (window.crypto || globalThis.crypto).getRandomValues(bytes); requestKey = [...bytes].map(b => b.toString(16).padStart(2, '0')).join(''); }
  newRequestKey();
  function row(label, value, cls) { const item = el('div', null, cls); item.append(el('dt', label), el('dd', value)); facts.append(item); }
  function link(text, href) { const a = el('a', text, 'small-button'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; links.append(a); }
  function render() {
    if (disposed) return;
    // A focused control that this render removes, hides or disables hands focus on instead of dropping it to <body>.
    const focused = document.activeElement && root.contains(document.activeElement) ? document.activeElement : null, linkKey = a => a.getAttribute('href') + '\n' + a.textContent, focusedLink = focused?.tagName === 'A' ? linkKey(focused) : null;
    root.hidden = !active(); facts.replaceChildren(); disclosure.replaceChildren(); links.replaceChildren();
    const state = launch?.state || 'quote', current = launch ? stepOf(state) : 'quote', order = STEPS.map(s => s[0]), expired = quoteExpired();
    track.hidden = !launch;
    track.dataset.flow = current; track.dataset.state = state === 'created' ? 'live' : expired || ['failed', 'expired', 'refunded', 'refunding'].includes(state) ? 'error' : launch && state !== 'awaiting_funding' && !DONE.has(state) ? 'confirming' : 'idle';
    for (const item of track.querySelectorAll('[data-flow-step]')) { const index = order.indexOf(item.dataset.flowStep), at = order.indexOf(current); item.classList.toggle('is-done', state === 'created' || index < at); if (state !== 'created' && index === at) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current'); }
    if (launch) {
      const q = launch.quote || null;
      row('Coin', [launch.name, launch.symbol ? '$' + launch.symbol : ''].filter(Boolean).join(' · '));
      row('Launch option', launch.modeLabel || launch.mode);
      if (onPair(launch)) row('Pair', pairSymbol(launch));
      if (Number(launch.creatorFeeBps) > 0) row('Creator fee (your choice)', percent(launch.creatorFeeBps));
      if (q) {
        const devBuy = q.devBuy ?? q.devBuySol, devBuyRaw = q.devBuyRaw ?? (q.devBuySol === '0' ? '0' : '1');
        // A dev buy on another pair paid in SOL: Launchpad buys the pair asset after funding (at least the route's minimum).
        if (onPair(launch) && q.devBuyPaidIn === 'SOL') {
          row('Dev buy', q.devBuySol === '0' ? 'None' : q.devBuySol + ' SOL');
          if (q.devBuySol !== '0') row('Converted to', q.pairBought ? q.pairBought + ' ' + pairSymbol(launch) : 'at least ' + q.pairMinimum + ' ' + pairSymbol(launch) + (q.pairExpected && q.pairExpected !== q.pairMinimum ? ' (about ' + q.pairExpected + ')' : ''));
          if (q.devBuySol !== '0') row('Tokens you receive', q.minimumTokens && q.minimumTokens !== q.expectedTokens ? '~' + tokens(q.expectedTokens) + ' (at least ' + tokens(q.minimumTokens) + ')' : '~' + tokens(q.expectedTokens));
        } else { row(state === 'created' ? 'Dev buy' : 'Dev buy (maximum)', devBuyRaw === '0' && state === 'created' ? 'None' : devBuy + ' ' + (q.devBuySymbol || pairSymbol(launch))); if (devBuyRaw !== '0') row('Tokens you receive', '~' + tokens(q.expectedTokens)); }
        row('Launch costs', q.estimatedSetupSol ? 'about ' + q.estimatedSetupSol + ' SOL (up to ' + q.setupBudgetSol + '; the rest comes back after launch)' : q.setupBudgetSol + ' SOL (unused part refunded)');
        if (q.conversionBudgetSol) row('Conversion costs', 'up to ' + q.conversionBudgetSol + ' SOL (unused part refunded)');
        row('Operating reserve', q.operatingReserveSol + ' SOL');
        if (q.seedSol !== '0') row('Strategy seed capital', q.seedSol + ' SOL');
        if (launch.developerWallet) row('Tokens delivered to', short(launch.developerWallet));
        if (state === 'awaiting_funding' && Number.isFinite(q.expiresAt)) { const left = Math.max(0, Math.round((q.expiresAt - clock()) / 1000)); row('Quote valid for', left > 0 ? Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') : 'expired'); }
      }
      if (state !== 'awaiting_funding') { row('Status', launch.stateLabel || PUMP_CLASSIC_STATES[state] || state); if (launch.reason) row('Details', launch.reason); if (state === 'created' && launch.devTokens && launch.devTokens !== '0') row(launch.dimensions?.delivery === 'pending' ? 'Dev-buy tokens (being delivered)' : 'Dev-buy tokens delivered', tokens(launch.devTokens)); if (launch.refundedPair && launch.refundedPair !== '0') row('Refunded', launch.refundedPair + ' ' + pairSymbol(launch)); if (launch.refundedSol && launch.refundedSol !== '0') row(launch.refundedPair && launch.refundedPair !== '0' ? 'Refunded SOL' : 'Refunded', launch.refundedSol + ' SOL'); }
      if (q) row(state === 'awaiting_funding' ? 'Total from your wallet' : 'Funded from your wallet', fundingText(launch, q), 'is-total');
    }
    // The platform share is stated only in the docs: the line that names it links there.
    let linked = false;
    for (const line of launch?.disclosure || []) {
      const item = el('li'), at = String(line).indexOf('Fees & revenue');
      if (at < 0) item.textContent = line;
      else { const a = el('a', 'Fees & revenue'); a.href = launch.feeLink || PUMP_CLASSIC_FEE_LINK; a.target = '_blank'; a.rel = 'noopener'; item.append(document.createTextNode(line.slice(0, at)), a, document.createTextNode(line.slice(at + 'Fees & revenue'.length))); linked = true; }
      disclosure.append(item);
    }
    if (launch?.disclosure?.length && !linked) { const item = el('li'), a = el('a', 'Fees & revenue'); a.href = launch.feeLink || PUMP_CLASSIC_FEE_LINK; a.target = '_blank'; a.rel = 'noopener'; item.append(document.createTextNode('Platform shares: see '), a, document.createTextNode(' in the docs.')); disclosure.append(item); }
    disclosure.hidden = !launch || state !== 'awaiting_funding';
    if (SIGNATURE.test(launch?.signatures?.funding || '')) link('Funding transaction ↗', 'https://solscan.io/tx/' + launch.signatures.funding);
    if (SIGNATURE.test(launch?.signatures?.create || '')) link('Creation transaction ↗', 'https://solscan.io/tx/' + launch.signatures.create);
    if (SIGNATURE.test(launch?.signatures?.pairRefund || '')) link(pairSymbol(launch) + ' refund transaction ↗', 'https://solscan.io/tx/' + launch.signatures.pairRefund);
    if (SIGNATURE.test(launch?.signatures?.refund || '')) link('Refund transaction ↗', 'https://solscan.io/tx/' + launch.signatures.refund);
    if (state === 'created' && /^https:\/\/pump\.fun\//.test(launch.pumpUrl || '')) link('View on Pump.fun ↗', launch.pumpUrl);
    links.hidden = !links.childElementCount;
    // An expired quote says so, replacing the review prompt it was quoted with.
    const shown = expired ? MESSAGES.expired : message;
    notice.textContent = shown; notice.hidden = !shown; notice.classList.toggle('negative', negative || expired);
    review.hidden = !!launch; review.disabled = busy;
    fund.hidden = !launch || state !== 'awaiting_funding' || !!pendingSubmit || launch.canFund === false || expired; fund.disabled = busy;
    retry.hidden = !pendingSubmit; retry.disabled = busy;
    cancel.hidden = !launch || !!pendingSubmit || !(state === 'awaiting_funding' || DONE.has(state) && state !== 'created'); cancel.disabled = busy;
    coin.hidden = state !== 'created'; if (!coin.hidden) coin.href = coinLink(launch); else coin.removeAttribute('href');
    root.setAttribute('aria-busy', String(busy));
    // When nothing could take focus yet (Review disabled before its status shows), a later render hands it on,
    // unless the person has moved focus somewhere else meanwhile.
    const holder = document.activeElement, stranded = target => !target || target === document.body || root.contains(target) && (target.disabled || target.hidden || !!target.closest('[hidden]'));
    if (refocus && (root.hidden || !stranded(holder))) refocus = false;
    if (focused && (!focused.isConnected || focused.hidden || focused.disabled || focused.closest('[hidden]')) || refocus) {
      // Never onto Fund: one stray key press must not start a wallet approval.
      const same = focusedLink && [...root.querySelectorAll('a')].find(a => linkKey(a) === focusedLink && !a.closest('[hidden]'));
      const next = same || [review, notice, cancel, retry].find(target => !target.hidden && !target.disabled) || (facts.childElementCount ? facts : null);
      if (next && !root.hidden) { try { next.focus({ preventScroll: !!same }); } catch {} refocus = false; } else refocus = !root.hidden;
    }
  }
  function accept(next) {
    if (!valid(next)) throw Error('The launch response could not be verified.');
    if (launch && next.id !== launch.id) throw Error('The launch response belongs to another launch.');
    const previous = launch?.state || '', changed = previous !== next.state || launch?.dimensions?.refund !== next.dimensions?.refund; launch = next; if (next.state === 'created' && announced !== next.id) { announced = next.id; try { document.dispatchEvent(new window.CustomEvent('curve-celebrate', { detail: { target: track } })); } catch {} Promise.resolve().then(() => onLive(next)).catch(() => {}); }
    if (changed) Promise.resolve().then(() => onUpdate(next)).catch(() => {});
    if (next.state === 'failed') { message = (next.reason || 'The launch did not complete.') + (REFUND_NOTES[next.dimensions?.refund] || ''); negative = true; }
    else if (next.state === 'awaiting_funding' && next.reason && previous && previous !== 'awaiting_funding') { message = next.reason + ' Fund it again or start over.'; negative = true; }
    else if (MESSAGES[next.state] && next.state !== 'awaiting_funding') { message = MESSAGES[next.state]; negative = ['expired'].includes(next.state); }
    schedule(); onChange(); render();
  }
  function schedule() {
    clearTimer(pollTimer); clearTimer(tickTimer);
    if (disposed || !launch) return;
    // The countdown only redraws; an expired quote is never funded (the server refuses it as well).
    if (launch.state === 'awaiting_funding') { if (!quoteExpired()) tickTimer = setTimer(() => { render(); schedule(); }, 1000); return; }
    // A coin on another pair is followed until its separately delivered dev-buy tokens arrive.
    if (ACTIVE.has(launch.state) || refunding(launch) || launch.state === 'created' && launch.dimensions?.delivery === 'pending') pollTimer = setTimer(poll, 4000);
  }
  async function poll() {
    if (disposed || !launch) return;
    // A hidden tab waits; the launch is read again within seconds of coming back.
    if (document.hidden) { pollTimer = setTimer(poll, 4000); return; }
    const id = launch.id;
    try { const next = await request('/launch?launchId=' + encodeURIComponent(id)); if (disposed || launch?.id !== id) return; accept(next); }
    catch (error) { if (!disposed && !error?.cancelled && launch?.id === id) { message = 'Checking the launch status… ' + (error.message || ''); negative = false; render(); clearTimer(pollTimer); pollTimer = setTimer(poll, 8000); } }
  }
  // onBusy lets the page lock the inputs a request was made from while it runs (without re-reading them).
  async function act(fn) { if (busy || disposed) return; busy = true; render(); try { onBusy(true); } catch {} try { await fn(); } catch (error) { if (!error?.cancelled) say(error.message || 'Something went wrong.', true); } finally { busy = false; try { onBusy(false); } catch {} onChange(); render(); } }
  async function quote() {
    await act(async () => {
      const input = getInput(), address = wallet.state().address; if (!address) { connectWallet?.(); throw Error('Connect the wallet you will fund this launch from.'); }
      say('Preparing your quote…');
      accept(await request('/quote', { ...input, requestKey, wallet: address }));
      say('Review the quote. Funding is one transfer from your wallet; Launchpad does the rest.');
    });
  }
  async function submit(prepared, signed) {
    pendingSubmit = { launchId: launch.id, operationId: prepared.operationId, signed };
    try { accept(await request('/fund/submit', { launchId: launch.id, operationId: prepared.operationId, signedTransaction: signed })); pendingSubmit = null; say('Funding submitted. Launchpad creates the coin once it finalizes.'); }
    catch (error) {
      // A definite refusal means these bytes were never broadcast: drop them and show the saved launch.
      if (error?.code === 'WALLET_TRANSACTION_REJECTED' || [400, 404, 409].includes(error?.status)) { pendingSubmit = null; try { accept(await request('/launch?launchId=' + encodeURIComponent(launch.id))); } catch {} throw error; }
      throw Object.assign(Error((error.message || 'The submission response was interrupted.') + ' Retry the same signed submission; nothing new will be signed.'), { cause: error });
    }
  }
  async function fundLaunch() {
    await act(async () => {
      if (!launch || launch.state !== 'awaiting_funding') throw Error('This launch is not waiting for funding.');
      if (quoteExpired()) throw Error(MESSAGES.expired);
      // Viewing a saved quote needs no wallet; funding it does.
      if (!wallet.state().address) { connectWallet?.(); throw Error('Connect the wallet this launch was quoted for (' + short(String(launch.developerWallet || '')) + ') to fund it.'); }
      say('Preparing the funding transfer…');
      const prepared = await request('/fund/prepare', { launchId: launch.id });
      if (!prepared?.transaction || !prepared.operationId) throw Error('The funding transfer could not be prepared. Try again.');
      if (prepared.wallet !== launch.developerWallet || prepared.wallet !== wallet.state().address) throw Error('Connect the wallet this launch was quoted for: ' + short(String(prepared.wallet || launch.developerWallet || '')));
      const pairRaw = onPair(launch) ? String(launch.quote?.pairAmountRaw || '0') : '0';
      if (prepared.amountLamports !== launch.quote?.totalLamports || String(prepared.pairAmountRaw || '0') !== pairRaw || (pairRaw !== '0' && prepared.pairMint !== launch.pair.mint)) throw Error('The prepared transfer does not match the reviewed total. Nothing was signed.');
      say('Approve the ' + prepared.amountSol + ' SOL' + (pairRaw !== '0' ? ' and ' + prepared.pairAmount + ' ' + pairSymbol(launch) : '') + ' funding transfer in your wallet.');
      let signed; try { signed = await wallet.sign({ wallet: prepared.wallet, transaction: prepared.transaction }); }
      catch (error) { throw Object.assign(Error((error?.message || 'Wallet approval was cancelled.') + ' Nothing was submitted.'), { cause: error }); }
      say('Submitting your signed transfer once…');
      await submit(prepared, signed);
    });
  }
  async function retrySubmit() {
    await act(async () => {
      if (!pendingSubmit) return; const saved = pendingSubmit;
      try { accept(await request('/fund/submit', { launchId: saved.launchId, operationId: saved.operationId, signedTransaction: saved.signed })); pendingSubmit = null; say('Funding submitted. Launchpad creates the coin once it finalizes.'); }
      catch (error) { if (error?.code === 'WALLET_TRANSACTION_REJECTED' || [400, 404, 409].includes(error?.status)) { pendingSubmit = null; try { accept(await request('/launch?launchId=' + encodeURIComponent(saved.launchId))); } catch {} } throw error; }
    });
  }
  async function startOver() {
    await act(async () => {
      if (pendingSubmit) throw Error('A signed funding transfer is waiting to be submitted. Retry it first.');
      let cancelled = false;
      if (launch?.state === 'awaiting_funding') {
        try { await request('/cancel', { launchId: launch.id }); cancelled = true; }
        catch (error) {
          if (error?.status !== 409) throw error;
          // Already funded: the launch continues and must stay visible.
          const latest = await request('/launch?launchId=' + encodeURIComponent(launch.id)); accept(latest);
          if (!DONE.has(latest.state) && latest.state !== 'awaiting_funding') { say('This launch was already funded, so it continues. Launchpad creates the coin or refunds you automatically.'); return; }
        }
      }
      launch = null; pendingSubmit = null; newRequestKey(); clearTimer(pollTimer); clearTimer(tickTimer); message = ''; negative = false;
      if (cancelled) Promise.resolve().then(() => onUpdate(null)).catch(() => {});
    });
  }
  /** Shows one saved launch of this account (any state, finished ones included) by its id. */
  async function open(id) {
    if (!ID.test(String(id || ''))) throw Error('This launch link is not valid.');
    if (busy || pendingSubmit) { if (launch?.id === id) return launch; throw Error('Finish the current funding step before opening another launch.'); }
    const next = await request('/launch?launchId=' + encodeURIComponent(id));
    if (disposed) return null;
    if (!valid(next) || next.id !== id) throw Error('The launch response could not be verified.');
    if (busy || pendingSubmit) { if (launch?.id === id) return launch; throw Error('Finish the current funding step before opening another launch.'); }
    // A coin that was already live when opened is shown, not celebrated again.
    if (launch?.id !== id) { if (next.state === 'created') announced = id; launch = null; newRequestKey(); clearTimer(pollTimer); clearTimer(tickTimer); }
    message = ''; negative = false; accept(next);
    if (next.state === 'awaiting_funding' && !quoteExpired()) { message = next.canFund === false ? '' : 'Your saved quote is still valid. Fund it or start over.'; negative = false; render(); }
    return launch;
  }
  /** Resumes the most recent unfinished launch for this account, if any. */
  async function restore() {
    if (launch || busy) return launch;
    const result = await request('/launches'); if (disposed || launch) return launch;
    const open = (result?.launches || []).find(row => valid(row) && ACTIVE.has(row.state) && (row.state !== 'awaiting_funding' || row.canFund));
    if (open) { accept(open); message = open.state === 'awaiting_funding' ? 'Your saved quote is still valid. Fund it or start over.' : MESSAGES[open.state] || 'Resuming your saved launch.'; negative = false; render(); }
    return open || null;
  }
  review.onclick = quote; fund.onclick = fundLaunch; retry.onclick = retrySubmit; cancel.onclick = startOver;
  render();
  return {
    render, quote, fund: fundLaunch, restore, startOver, open,
    reset() { if (busy || pendingSubmit) return false; launch = null; newRequestKey(); clearTimer(pollTimer); clearTimer(tickTimer); message = ''; negative = false; render(); return true; },
    destroy() { disposed = true; clearTimer(pollTimer); clearTimer(tickTimer); root.replaceChildren(); },
    get busy() { return busy; }, get launch() { return launch; }, get signedPending() { return !!pendingSubmit; },
    get locked() { return !!launch && !DONE.has(launch.state); }, get done() { return !!launch && DONE.has(launch.state); },
  };
}
