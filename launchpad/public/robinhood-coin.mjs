// The coin page for a Robinhood Chain coin (v71.41, pool-native): identity, the pool's live numbers from the venue
// service, the trade box (buy and sell through Launchpad's swap router into the coin's Uniswap v4 pool from a connected
// EVM wallet, with the pool maths quoting locally), links to the other places the coin trades, the price chart, the
// creator's claim from the fee escrow, holder rewards and the option, recent trades and the explorer links. Every
// transaction is the wallet's own prompt; the page holds no key. Reads of balances and allowances go through the
// wallet's provider.
import { ROBINHOOD_NATIVE, ROBINHOOD_MODE_LABELS, ROBINHOOD_MODE_SUMMARIES, ROBINHOOD_VENUE_STATES, ROBINHOOD_FEE_LINK, ROBINHOOD_FEES, robinhoodTradeLinks, robinhoodFeesFor, bpsText } from './robinhood-launch-catalog.mjs';
import { quoteBuy, quoteSell, curvePrice, unitsToUsd } from './robinhood-curve-math.mjs';
import { quoteSwap } from './robinhood-pool-math.mjs';
import { formatUnits, parseAmount, tokensText } from './robinhood-launch-ui.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Function selectors of the contracts the page calls (keccak-256 of the signatures, fixed at build time): the swap
// router's buy(address,uint256,uint256,address,uint256) and sell(address,uint256,uint256,address,uint256), the escrow's claims, ERC-20.
export const SELECTORS = Object.freeze({ buy: '0xc2019d42', sell: '0x883c18b3', claimAll: '0x77329f35', claimAllToken: '0xdd6808fe', escrowBalanceOf: '0x70a08231', escrowBalanceOfToken: '0xf59e38b7', approve: '0x095ea7b3', balanceOf: '0x70a08231', allowance: '0xdd62ed3e' });
/** How long a swap sent from the page stays valid (the router refuses it afterwards). */
const SWAP_DEADLINE_MS = 10 * 60 * 1000;
const MAX_UINT = (1n << 256n) - 1n;
const lower = v => String(v || '').toLowerCase();
const word = value => (typeof value === 'bigint' ? value : BigInt(value)).toString(16).padStart(64, '0');
const addressWord = value => lower(value).slice(2).padStart(64, '0');
export const encode = (selector, ...words) => selector + words.join('');
export const money = (value, digits = 2) => '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const short = value => /^0x[0-9a-fA-F]{40}$/.test(value || '') ? value.slice(0, 6) + '…' + value.slice(-4) : /^0x[0-9a-fA-F]{64}$/.test(value || '') ? value.slice(0, 8) + '…' + value.slice(-6) : String(value || '');
const big = value => typeof value === 'bigint' ? value : BigInt(String(value ?? '0'));
const whenText = at => { const n = Number(at); if (!Number.isFinite(n) || n <= 0) return ''; const d = new Date(n); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }); };
/** A short price: fewer digits for a big number, more for a tiny one. */
export function priceText(value) { const n = Number(value); if (!Number.isFinite(n) || n <= 0) return '—'; if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 }); const digits = Math.min(12, Math.max(4, -Math.floor(Math.log10(n)) + 3)); return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits }); }

/**
 * @param {object} options  document, window, request(path) → JSON (GET), wallet (public/evm-wallet.mjs, lazily made),
 *   token (the coin's address), session, clock, setTimer / clearTimer, connectWallet() → opens the page's picker.
 */
export function createRobinhoodCoinPage({ document, window = document.defaultView, request, walletFactory, token, clock = Date.now, setTimer = (fn, ms) => window.setTimeout(fn, ms), clearTimer = id => window.clearTimeout(id), onCoin = () => {} } = {}) {
  const main = document.querySelector('main'), $ = id => main.querySelector('[id="' + id + '"]');
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text != null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  // `allowance` is the pair token's allowance for the curve (an ERC-20 pair's buy), `tokenAllowance` the coin's (a sell).
  const noBalances = () => ({ eth: null, pair: null, token: null, allowance: null, tokenAllowance: null });
  let coin = null, disposed = false, timer = null, wallet = null, walletUnsubscribe = null, side = 'buy', busy = false, note = '', noteBad = false, balances = noBalances(), owedLive = null, session = null, activity = 'trades';
  const chainState = () => coin ? { virtualQuote: big(coin.curve.virtualQuote), virtualToken: big(coin.curve.virtualToken), realQuote: big(coin.curve.realQuote), sold: big(coin.curve.sold), sellSupply: big(coin.curve.sellSupply), graduationQuote: big(coin.curve.graduationQuote), tradeFeeBps: coin.curve.tradeFeeBps, creatorTaxBps: coin.curve.creatorTaxBps, graduated: coin.curve.graduated } : null;
  /** The spender the wallet approves: Launchpad's swap router (the pool itself never holds an allowance). */
  const spender = () => coin?.routerAddress || coin?.contracts?.router || '';
  const native = () => !!coin && lower(coin.pair.address) === ROBINHOOD_NATIVE;
  const pairDecimals = () => coin?.pair?.decimals ?? 18;
  const explorer = (kind, value) => coin?.explorerBase ? `${coin.explorerBase}/${kind}/${value}` : '#';
  const graduated = () => !!coin && (coin.venueState === 'graduated' || coin.curve?.graduated === true || coin.pool?.graduated === true);
  /**
   * The coin's fee shape (v71.41, the server's `feeShape`; the catalogue's numbers for its tax stand in for an older
   * view): both stages' totals, the platform's and the option's parts, and which stage trades now.
   */
  function feeShape() {
    const f = coin?.feeShape && Number.isFinite(Number(coin.feeShape.curveTotalBps)) ? coin.feeShape : robinhoodFeesFor(Number(coin?.taxBps) || 0);
    return { ...f, stage: f.stage === 'pool' || graduated() ? 'pool' : 'curve' };
  }
  /** The fee rows of the details list: the trading fee by stage, the creator fee or the holder tax, Launchpad's part. */
  function feeRows() {
    const f = feeShape(), pool = f.stage === 'pool', now = bps => `${bpsText(bps)}${pool ? ' (now)' : ''}`;
    const rows = [['Trading fee', `${bpsText(f.curveTotalBps)} on the curve${pool ? '' : ' (now)'} · ${now(f.poolTotalBps)} after graduation`]];
    if (f.taxBps > 0) rows.push(['Holder tax', `${bpsText(f.taxBps)} of every swap · 95% to the holders, 5% to Launchpad · no creator fee`]);
    else rows.push(['Creator fee', `${bpsText(ROBINHOOD_FEES.curveCreatorBps)} on the curve · ${bpsText(ROBINHOOD_FEES.poolCreatorBps)} after graduation`]);
    rows.push(['Launchpad’s fee', `${bpsText(ROBINHOOD_FEES.curveProtocolBps)} on the curve · ${bpsText(ROBINHOOD_FEES.poolProtocolBps)} after graduation`]);
    return rows;
  }
  function link(text, href, cls = '') { const a = el('a', text, cls); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; }
  function error(text = '', { missing = false } = {}) { const notice = $('coin-error'); if (!notice) return; notice.textContent = text; notice.hidden = !text; notice.classList.toggle('is-missing', !!(text && missing)); if (text && missing) { const back = el('a', 'Explore coins', 'small-button coin-notice-action'); back.href = '/'; notice.append(back); } }
  // ---- wallet reads through the provider -------------------------------------------------------------------------
  async function call(to, data) { if (!wallet?.connected) return null; try { const hex = await wallet.request('eth_call', [{ to, data }, 'latest']); return typeof hex === 'string' && hex.length >= 66 ? BigInt(hex.slice(0, 66)) : null; } catch { return null; } }
  const allowanceOf = (tokenAddress, owner) => call(tokenAddress, encode(SELECTORS.allowance, addressWord(owner), addressWord(spender())));
  async function readBalances() {
    if (!wallet?.connected || !coin) { balances = noBalances(); owedLive = null; return; }
    const me = wallet.state().address;
    const [eth, pair, tok, allowance, tokenAllowance] = await Promise.all([wallet.balance(me), native() ? Promise.resolve(null) : call(coin.pair.address, encode(SELECTORS.balanceOf, addressWord(me))), call(coin.token, encode(SELECTORS.balanceOf, addressWord(me))), native() ? Promise.resolve(null) : allowanceOf(coin.pair.address, me), allowanceOf(coin.token, me)]);
    balances = { eth, pair, token: tok, allowance, tokenAllowance };
    if (coin.recipients?.creatorClaims && lower(coin.recipients.creatorFeeRecipient) === lower(me)) owedLive = await call(coin.contracts.escrow, native() ? encode(SELECTORS.escrowBalanceOf, addressWord(me)) : encode(SELECTORS.escrowBalanceOfToken, addressWord(me), addressWord(coin.pair.address)));
    render();
  }
  async function ensureWallet() { if (wallet) return wallet; wallet = await walletFactory(); walletUnsubscribe = wallet.onChange(() => { if (!disposed) { void readBalances(); render(); } }); void wallet.resume?.(); return wallet; }
  // ---- data ----------------------------------------------------------------------------------------------------------
  async function load({ manual = false } = {}) {
    if (disposed) return;
    try {
      const fresh = await request('/coin?mint=' + encodeURIComponent(token));
      if (disposed) return; if (!fresh || lower(fresh.token) !== lower(token)) throw Object.assign(Error('This Robinhood Chain coin was not found.'), { status: 404 });
      coin = fresh; error(''); onCoin(coin); render(); if (wallet?.connected) void readBalances();
    } catch (e) { if (disposed) return; if (!coin) { error(e?.status === 404 ? 'This Robinhood Chain coin was not found.' : 'Market information is temporarily unavailable. Try again in a moment.', { missing: e?.status === 404 }); $('coin-loading').hidden = true; } else if (manual) { note = 'Could not refresh: ' + String(e?.message || '').slice(0, 160); noteBad = true; render(); } }
    finally { schedule(); }
  }
  function schedule() { if (timer) clearTimer(timer); timer = setTimer(() => { timer = null; void load(); }, document.hidden ? 60000 : 15000); }
  // ---- rendering -----------------------------------------------------------------------------------------------------
  function renderIdentity() {
    document.title = `${coin.symbol || coin.name || 'Coin'} — Launchpad`;
    const network = main.querySelector('.coin-network'); if (network) network.textContent = 'Robinhood Chain';
    $('coin-name').textContent = coin.name || 'Unnamed coin';
    const pairBadge = el('span', null, 'coin-pair-badge'); pairBadge.id = 'coin-pair'; pairBadge.append(el('span', 'Paired with '), el('strong', coin.pair.symbol));
    $('coin-symbol').replaceChildren(el('span', '$' + (coin.symbol || 'TOKEN')), pairBadge);
    const avatar = $('coin-avatar'); avatar.replaceChildren(el('span', String(coin.symbol || 'COIN').slice(0, 7))); if (/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(coin.image || '')) { const img = el('img'); img.src = coin.image; img.alt = ''; avatar.append(img); avatar.firstElementChild.hidden = true; }
    const stage = $('coin-stage'); stage.textContent = ROBINHOOD_VENUE_STATES[coin.venueState] || (coin.curve.graduated ? 'Graduated' : 'On the curve'); stage.dataset.stage = coin.venueState === 'graduated' ? 'graduated' : 'curve';
    const address = $('coin-address'); address.textContent = short(coin.token); address.title = coin.token; address.href = explorer('address', coin.token);
    const copy = $('coin-copy'); if (copy && !copy.dataset.rh) { copy.dataset.rh = '1'; copy.addEventListener('click', () => { try { window.navigator.clipboard?.writeText(coin.token); copy.textContent = 'Copied'; setTimer(() => { copy.textContent = 'Copy'; }, 1500); } catch { /* clipboard is optional */ } }); }
    for (const id of ['coin-chart-controls', 'coin-intervals', 'coin-dex']) { const node = $(id); if (node) node.hidden = true; }
    const source = $('coin-chart-source'); if (source) source.textContent = 'Uniswap v4 pool · Robinhood Chain';
    const details = $('coin-details'); details.replaceChildren();
    const done = graduated(), shape = feeShape();
    const rows = [['Paired with', coin.pair.symbol + (coin.pair.usd ? ' · ' + money(coin.pair.usd) : '')], ['Start', coin.tier ? `${coin.tier.label} → ${money(coin.tier.graduationUsd, 0)} graduation` : '—'], ['Rewards', coin.modeLabel || coin.mode], ...feeRows(),
      ['Liquidity', done ? `The raise and the unsold supply, in the ${bpsText(shape.poolTotalBps)} graduation pool, locked for good in Launchpad’s locker` : `The curve and the unsold supply, locked in Launchpad’s locker; at graduation they move into the ${bpsText(shape.poolTotalBps)} pool, locked for good`],
      ['Transfer rules', coin.rules?.length ? coin.rules.length + ' rule' + (coin.rules.length === 1 ? '' : 's') + (done ? ' (off since graduation)' : ' until graduation') : 'None'], ['Live since', whenText(coin.liveAt) || '—']];
    for (const [label, value] of rows) { const row = el('div'); row.append(el('dt', label), el('dd', value)); details.append(row); }
    // The pool trading now (the graduation pool once graduated) and, after graduation, the retired curve pool.
    const poolRow = (label, id, cls) => { if (!/^0x[0-9a-fA-F]{64}$/.test(id || '')) return; const row = el('div', null, cls), value = el('dd'); value.append(link(short(id) + ' ↗', coin.explorer?.pool || explorer('address', coin.contracts?.poolManager || ''))); value.title = id; row.append(el('dt', label), value); details.append(row); };
    const curvePoolId = coin.pool?.curvePoolId || shape.curvePoolId || null;
    poolRow(done ? 'Graduation pool' : 'Uniswap v4 pool', coin.pool?.id || coin.poolId, 'coin-pool-row');
    if (done && curvePoolId && lower(curvePoolId) !== lower(coin.pool?.id || coin.poolId)) poolRow('Launchpad pool (retired)', curvePoolId, 'coin-pool-row is-retired');
    if (ADDRESS.test(coin.contracts?.locker || '')) { const row = el('div'), value = el('dd'); value.append(link(short(coin.contracts.locker) + ' ↗', explorer('address', coin.contracts.locker))); row.append(el('dt', 'Liquidity locker'), value); details.append(row); }
    const description = $('coin-description'); description.textContent = coin.description || ''; description.hidden = !coin.description; if ($('coin-description-section')) $('coin-description-section').hidden = !coin.description;
    const socials = $('coin-socials'); socials.replaceChildren(); for (const [key, label] of [['website', 'Website'], ['twitter', 'X'], ['telegram', 'Telegram']]) { const url = coin.links?.[key]; if (/^https:\/\//.test(url || '')) socials.append(link(label + ' ↗', url)); }
    socials.append(link('Token on the explorer ↗', explorer('address', coin.token)));
    // Where else the coin trades, from its first block (a plain Uniswap v4 pool: terminals and wallets list it on their own).
    const elsewhere = $('coin-trade-links'); if (elsewhere) { elsewhere.replaceChildren(); const links = Array.isArray(coin.tradeLinks) && coin.tradeLinks.length ? coin.tradeLinks : robinhoodTradeLinks(coin.token); elsewhere.append(el('span', 'Also trades on', 'coin-trade-links-label')); for (const t of links) if (/^https:\/\//.test(t.url || '')) elsewhere.append(link(t.label + ' ↗', t.url, 'coin-trade-link')); elsewhere.hidden = !links.length; }
    $('coin-loading').hidden = true; $('coin-content').hidden = false;
  }
  function renderMarket() {
    const state = chainState(), decimals = pairDecimals(), price = curvePrice(state), usd = coin.pair.usd ? unitsToUsd(price, coin.pair.usd, decimals) : null;
    const supply = big(coin.totalSupply || '1000000000000000000000000000'), fdv = price * supply / 10n ** 18n, fdvUsd = coin.pair.usd ? unitsToUsd(fdv, coin.pair.usd, decimals) : null;
    $('coin-cap-label').textContent = 'Market cap'; $('coin-cap').textContent = fdvUsd !== null ? money(fdvUsd, 0) : formatUnits(fdv, decimals, 4) + ' ' + coin.pair.symbol;
    $('coin-cap-source').textContent = coin.curve.at ? 'Pool state read ' + whenText(coin.curve.at) : 'Pool state'; const change = $('coin-cap-change'); if (change) change.hidden = true;
    $('coin-price-label').textContent = 'Price'; $('coin-price').textContent = usd !== null ? '$' + priceText(usd) : priceText(Number(formatUnits(price, decimals, 12).replace(/,/g, '')));
    $('coin-price-quote').textContent = usd !== null ? formatUnits(price, decimals, 10).replace(/,/g, '') + ' ' + coin.pair.symbol : '';
    const stats = $('coin-stats'); stats.replaceChildren();
    const raised = state.realQuote, target = state.graduationQuote;
    const items = [['Raised', formatUnits(raised, decimals, native() ? 4 : 2) + ' ' + coin.pair.symbol + (coin.pair.usd ? ' · ' + money(unitsToUsd(raised, coin.pair.usd, decimals), 0) : '')], ['Graduates at', formatUnits(target, decimals, native() ? 4 : 2) + ' ' + coin.pair.symbol + (coin.tier ? ' · ' + money(coin.tier.graduationUsd, 0) : '')], ['Sold on the curve', tokensText(formatUnits(state.sold, 18, 0)) + ' of ' + tokensText(formatUnits(state.sellSupply, 18, 0))], ['Holders', String(coin.holders ?? '—')], ['Trades', String(coin.trades?.length ?? 0) + (coin.trades?.length >= 30 ? '+' : '')]];
    for (const [label, value] of items) { const row = el('div'); row.append(el('span', label), el('strong', value)); stats.append(row); }
    const wrap = $('coin-progress-wrap'); if (wrap) { const pct = Number(coin.curve.progressBps || 0) / 100; wrap.hidden = coin.venueState === 'graduated'; $('coin-progress-label').textContent = pct.toFixed(1) + '%'; $('coin-progress').value = pct; }
    const marketNote = $('coin-market-note'); if (marketNote) marketNote.textContent = graduated() ? `Graduated: the curve sold out, its raise and the unsold supply moved into the ${bpsText(feeShape().poolTotalBps)} graduation pool (locked for good) and the transfer rules are off; the coin keeps trading here and everywhere else.` : 'Prices come from the pool state Launchpad reads every minute; the trade box quotes your trade from the pool’s own numbers.';
    renderChart();
  }
  /** The price chart: every trade's price after it (the service keeps the last few hundred), as one SVG line. */
  function renderChart() {
    const chart = $('coin-chart'); if (!chart) return;
    const rows = (coin.priceHistory || []).filter(r => r && Number(r.price) > 0), decimals = pairDecimals(), usd = coin.pair.usd ? Number(coin.pair.usd) : null;
    const points = rows.map(r => ({ at: Number(r.at) || 0, value: usd ? unitsToUsd(r.price, coin.pair.usd, decimals) : Number(formatUnits(r.price, decimals, 12).replace(/,/g, '')) })).filter(p => Number.isFinite(p.value) && p.value > 0);
    const key = points.length + ':' + (points.at(-1)?.at || 0) + ':' + (points.at(-1)?.value || 0);
    if (chart.dataset.rhChart === key) return; chart.dataset.rhChart = key; chart.replaceChildren();
    if (points.length < 2) { const empty = el('div', null, 'coin-chart-empty'); empty.append(el('span', '⌁'), el('h3', 'Trading in its Uniswap v4 pool'), el('p', points.length ? 'The chart draws from the second trade on.' : 'The chart draws as trades come in; the pool’s live numbers are on the right.')); chart.append(empty); return; }
    const W = 640, H = 220, PAD = 12, min = Math.min(...points.map(p => p.value)), max = Math.max(...points.map(p => p.value)), span = max - min || max || 1;
    const x = i => PAD + (W - 2 * PAD) * (points.length === 1 ? 0 : i / (points.length - 1)), y = v => H - PAD - (H - 2 * PAD) * ((v - min) / span);
    const d = points.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.value).toFixed(1)).join(' ');
    const svgNs = 'http://www.w3.org/2000/svg', svg = document.createElementNS(svgNs, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'coin-price-chart'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Price from ${usd ? '$' + priceText(points[0].value) : priceText(points[0].value)} to ${usd ? '$' + priceText(points.at(-1).value) : priceText(points.at(-1).value)} over ${points.length} trades`);
    const area = document.createElementNS(svgNs, 'path'); area.setAttribute('d', d + ` L${x(points.length - 1).toFixed(1)} ${H - PAD} L${x(0).toFixed(1)} ${H - PAD} Z`); area.setAttribute('class', 'coin-price-chart-area');
    const line = document.createElementNS(svgNs, 'path'); line.setAttribute('d', d); line.setAttribute('class', 'coin-price-chart-line'); line.setAttribute('fill', 'none');
    svg.append(area, line); chart.append(svg);
    const legend = el('div', null, 'coin-price-chart-legend'); legend.append(el('span', (usd ? '$' : '') + priceText(points[0].value) + (usd ? '' : ' ' + coin.pair.symbol) + ' · ' + whenText(points[0].at)), el('span', (usd ? '$' : '') + priceText(points.at(-1).value) + (usd ? '' : ' ' + coin.pair.symbol) + ' · ' + whenText(points.at(-1).at))); chart.append(legend);
  }
  function renderActivity() {
    const table = $('coin-activity-table'), note = $('coin-activity-note'); if (!table) return;
    const thead = table.querySelector('thead'), tbody = table.querySelector('tbody'); thead.replaceChildren(); tbody.replaceChildren();
    if (activity === 'trades') {
      const head = el('tr'); for (const h of ['When', 'Side', coin.pair.symbol, 'Tokens', 'Wallet', 'Tx']) head.append(el('th', h)); thead.append(head);
      for (const t of coin.trades || []) { const row = el('tr'); row.dataset.side = t.side; const tx = el('td'); tx.append(link(short(t.tx) + ' ↗', explorer('tx', t.tx))); row.append(el('td', whenText(t.at)), el('td', t.side === 'buy' ? 'Buy' : 'Sell'), el('td', String(t.quote).replace(/(\.\d{6})\d+$/, '$1')), el('td', tokensText(t.tokens)), el('td', short(t.wallet)), tx); tbody.append(row); }
      note.textContent = coin.trades?.length ? `Last ${coin.trades.length} pool trades, from every venue that routes to the pool.` : 'No trades yet.';
    } else { const head = el('tr'); head.append(el('th', 'Holders')); thead.append(head); const row = el('tr'); row.append(el('td', `${coin.holders ?? 0} wallets hold ${coin.symbol} (indexed from the coin’s transfers; the holder list follows in the next release).`)); tbody.append(row); note.textContent = ''; }
  }
  function renderRewards() {
    const section = $('coin-rewards'); if (!section) return;
    const hr = coin.holderRewards, option = coin.option;
    section.hidden = !hr && !option;
    if (section.hidden) return;
    $('coin-rewards-title').textContent = hr ? 'Holder rewards' : option ? ROBINHOOD_MODE_LABELS[coin.mode] + ' option' : 'Rewards';
    $('coin-rewards-mode').textContent = coin.modeLabel || coin.mode; $('coin-rewards-state').textContent = option?.state?.phase ? 'Phase: ' + option.state.phase : hr ? 'Paid in ' + hr.symbol : '';
    $('coin-rewards-description').textContent = option?.description || ROBINHOOD_MODE_SUMMARIES[coin.mode] || '';
    const primary = $('coin-rewards-primary'); primary.replaceChildren();
    const stat = (label, value) => { const row = el('div'), line = el('div', null, 'coin-reward-value-row'); line.append(el('span', label), el('strong', value)); row.append(line); primary.append(row); };
    if (hr) { stat('Waiting to be paid', hr.held + ' ' + hr.symbol); stat('Pays out at about', money(hr.thresholdUsd, 0)); stat('Paid to holders so far', (coin.fees?.paidToHolders || '0') + ' ' + hr.symbol); }
    if (option?.state) { const s = option.state; const facts = coin.mode === 'earned' ? [['Baseline market cap', s.baseline ? s.baseline + ' ' + coin.pair.symbol : 'Recorded a day after launch'], ['Floor', s.floor ? s.floor + ' ' + coin.pair.symbol : '—'], ['Probation ends', whenText(s.probationEndsAt) || '—']] : coin.mode === 'insured' ? [['Refund pot', s.pot + ' ' + coin.pair.symbol], ['Paid from the pot', s.potPaid + ' ' + coin.pair.symbol], ['Graduation deadline', whenText(s.deadlineAt) || '—']] : coin.mode === 'diamond_hands' ? [['Payouts', String(s.payouts)], ['Wallets paid', String(s.paidWallets)], ['Skipped for selling', String(s.skippedWallets)]] : []; for (const [label, value] of facts) stat(label, value); }
    const secondary = $('coin-rewards-secondary'); secondary.replaceChildren();
    for (const c of hr?.cycles || []) { const row = el('div'); row.append(el('span', `${whenText(c.at)} · ${c.recipients} holders${c.skipped ? ', ' + c.skipped + ' skipped' : ''}`), el('strong', `${c.paid} ${c.asset} · ${c.state}`)); secondary.append(row); }
    $('coin-rewards-schedule').textContent = hr ? 'Top 100 holders by minimum balance over the last hour; Launchpad pays from the coin’s fee wallet through LaunchPayouts.' : '';
    $('coin-rewards-latest').textContent = ''; $('coin-rewards-note').textContent = '';
    const refresh = $('coin-rewards-refresh'); if (refresh && !refresh.dataset.rh) { refresh.dataset.rh = '1'; refresh.addEventListener('click', () => void load({ manual: true })); }
  }
  // ---- the trade box and the creator's claim -------------------------------------------------------------------------
  let tradeRoot = null, amountInput = null, slippageInput = null;
  function buildTrade() {
    tradeRoot = $('coin-trade'); if (!tradeRoot || tradeRoot.dataset.rh) return; tradeRoot.dataset.rh = '1'; tradeRoot.hidden = false; tradeRoot.className = 'coin-trade-panel rh-trade';
    tradeRoot.innerHTML = '<div class="ct-heading"><h2>Trade</h2><span data-rh-pair></span></div><div class="ct-side" role="group" aria-label="Trade direction"><button type="button" data-rh-side="buy" aria-pressed="true">Buy</button><button type="button" data-rh-side="sell" aria-pressed="false">Sell</button></div>'
      + '<div class="ct-wallet"><div><span>EVM wallet</span><strong data-rh-wallet>Connect a wallet to trade</strong></div><button type="button" class="text-button" data-rh-connect>Connect wallet</button></div>'
      + '<div data-rh-form hidden><label class="ct-amount-label"><span data-rh-input-label>Buy with</span><span data-rh-balance>Balance —</span><span class="ct-amount"><input data-rh-amount type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-label="Trade amount"><strong data-rh-input-symbol></strong></span></label>'
      + '<div class="ct-presets" data-rh-presets><button type="button" data-rh-percent="25">25%</button><button type="button" data-rh-percent="50">50%</button><button type="button" data-rh-percent="100" data-rh-max title="Your whole balance">MAX</button></div>'
      + '<div class="ct-options"><label>Slippage <span class="ct-slippage-input"><input data-rh-slippage type="text" inputmode="decimal" autocomplete="off" value="1" maxlength="6" aria-label="Maximum slippage percent"><span>%</span></span></label><button type="button" class="text-button" data-rh-refresh>Refresh balance</button></div>'
      + '<p class="ct-note" data-rh-quote></p><button type="button" class="ct-action" data-rh-action>Buy</button></div><p class="ct-note" data-rh-gate></p><p class="ct-note" data-rh-note role="status"></p><div data-rh-claim hidden></div>';
    amountInput = tradeRoot.querySelector('[data-rh-amount]'); slippageInput = tradeRoot.querySelector('[data-rh-slippage]');
    for (const b of tradeRoot.querySelectorAll('[data-rh-side]')) b.addEventListener('click', () => { side = b.dataset.rhSide; amountInput.value = ''; render(); });
    tradeRoot.querySelector('[data-rh-connect]').addEventListener('click', () => run(async () => { const w = await ensureWallet(); if (w.connected) { w.disconnect(); return; } await connect(w); }));
    tradeRoot.querySelector('[data-rh-refresh]').addEventListener('click', () => { void readBalances(); });
    for (const b of tradeRoot.querySelectorAll('[data-rh-percent]')) b.addEventListener('click', () => fillPercent(Number(b.dataset.rhPercent)));
    amountInput.addEventListener('input', () => render()); slippageInput.addEventListener('input', () => render());
    tradeRoot.querySelector('[data-rh-action]').addEventListener('click', () => run(trade));
  }
  async function connect(w) { try { await w.connect(); } catch (e) { if (e?.code === 'EVM_WALLET_CHOOSE' && e.wallets?.length) { const first = e.wallets[0]; await w.connect(first.uuid); } else throw e; } await w.ensureChain().catch(() => {}); await readBalances(); }
  function slippageBps() { const n = Number(slippageInput?.value || '1'); if (!Number.isFinite(n) || n < 0 || n > 100) throw Error('Slippage is 0% to 100%.'); return BigInt(Math.round(n * 100)); }
  /** The local quote for what is typed: the curve's own maths over the last read state (the chain's answer may differ slightly). */
  function localQuote() {
    const state = chainState(); if (!state || !amountInput) return null;
    const text = amountInput.value.trim(); if (!text) return null;
    const pool = coin.pool && coin.pool.sqrtPriceX96 ? coin.pool : null;
    if (side === 'buy') {
      const amount = parseAmount(text, pairDecimals()); if (amount <= 0n) return null;
      if (pool) { const q = quoteSwap(pool, { buy: true, amountIn: amount }); return { kind: 'buy', amount, tokensOut: q.amountOut, fee: q.fee, refund: amount - q.amountUsed, limited: q.priceLimited }; }
      const q = quoteBuy(state, amount); return { kind: 'buy', amount, tokensOut: q.tokensOut, fee: q.fee + q.tax, refund: q.refund };
    }
    const amount = parseAmount(text, 18); if (amount <= 0n) return null;
    if (pool) { const q = quoteSwap(pool, { buy: false, amountIn: amount }); return { kind: 'sell', amount, quoteOut: q.amountOut, fee: q.fee, feeInCoins: true, limited: q.priceLimited, used: q.amountUsed }; }
    const q = quoteSell(state, amount); return { kind: 'sell', amount, quoteOut: q.quoteOut, fee: q.fee + q.tax };
  }
  /** Wei of ETH the MAX button leaves in the wallet for gas (the chain's gas is cheap; a few hundred transactions' worth). */
  const GAS_RESERVE_WEI = 500000000000000n;
  /** The largest amount the wallet can trade on the chosen side: every token for a sell, the pair balance for a buy (ETH keeps the gas reserve). */
  function maxAmount() {
    if (side === 'sell') return balances.token === null ? null : balances.token;
    if (!native()) return balances.pair === null ? null : balances.pair;
    if (balances.eth === null) return null;
    return balances.eth > GAS_RESERVE_WEI ? balances.eth - GAS_RESERVE_WEI : 0n;
  }
  /** Full-precision text of a raw amount for the amount input (parseAmount reads it back to the same wei). */
  const exactText = (raw, decimals) => { const scale = 10n ** BigInt(decimals), whole = raw / scale, fraction = (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, ''); return whole.toString() + (fraction ? '.' + fraction : ''); };
  /** 25% / 50% / MAX: the share of the tradable balance, written exactly (MAX is every unit). */
  function fillPercent(percent) {
    if (busy) return;
    const max = maxAmount(); if (max === null) { note = 'Read the balance first (Refresh balance).'; noteBad = true; render(); return; }
    const pct = BigInt(Math.max(1, Math.min(100, Math.round(Number(percent) || 100))));
    const raw = pct === 100n ? max : max * pct / 100n;
    amountInput.value = exactText(raw, side === 'sell' ? 18 : pairDecimals()); note = ''; noteBad = false; render();
  }
  /** The wallet module's receipt wait, or the same poll through the provider for a wallet without one. */
  async function waitForReceipt(w, hash) {
    if (typeof w.waitForReceipt === 'function') return w.waitForReceipt(hash);
    const started = clock();
    for (;;) {
      let receipt = null; try { receipt = await w.request('eth_getTransactionReceipt', [hash]); } catch { receipt = null; }
      if (receipt && typeof receipt === 'object' && receipt.blockNumber) { if (receipt.status === '0x0') throw Error('The transaction failed on the chain.'); return receipt; }
      if (clock() - started >= 180000) throw Error('The transaction was not confirmed in time. Check it in your wallet and try again.');
      await new Promise(resolve => setTimer(resolve, 1500));
    }
  }
  /**
   * The router pulls the sold asset with `transferFrom` straight into the pool, so the wallet approves the router once
   * (for the maximum) when the known allowance is short, and the trade waits for that approval to confirm — a trade sent
   * on top of a pending approval reverts in the wallet's simulation.
   */
  async function approveForCurve(w, tokenAddress, symbol, key, needed) {
    const me = w.state().address;
    if (!ADDRESS.test(spender())) throw Error('The swap router is not configured on this host.');
    let allowance = balances[key]; if (allowance === null || allowance === undefined) allowance = await allowanceOf(tokenAddress, me);
    if (allowance !== null && allowance >= needed) return false;
    note = `Step 1 of 2 · approve ${symbol} for Launchpad’s swap router in your wallet (once per coin)…`; render();
    const hash = await w.sendTransaction({ to: tokenAddress, data: encode(SELECTORS.approve, addressWord(spender()), word(MAX_UINT)) });
    note = `Approval sent (${short(hash)}) · waiting for it to confirm…`; render();
    await waitForReceipt(w, hash);
    const after = await allowanceOf(tokenAddress, me);
    if (after !== null && after < needed) throw Error(`The approval confirmed but the router may spend only ${formatUnits(after, key === 'tokenAllowance' ? 18 : pairDecimals(), 6)} ${symbol}. Approve again.`);
    balances = { ...balances, [key]: after ?? MAX_UINT };
    return true;
  }
  async function trade() {
    const w = await ensureWallet(); if (!w.connected) { await connect(w); if (!w.connected) throw Error('Connect an EVM wallet to trade.'); }
    const q = localQuote(); if (!q) throw Error('Enter an amount.');
    if (!ADDRESS.test(spender())) throw Error('The swap router is not configured on this host.');
    const bps = slippageBps(), me = w.state().address, deadline = BigInt(Math.floor((clock() + SWAP_DEADLINE_MS) / 1000));
    await w.ensureChain();
    if (q.kind === 'buy') {
      let approved = false;
      if (!native()) {
        if (balances.pair !== null && balances.pair < q.amount) throw Error(`Your wallet holds ${formatUnits(balances.pair, pairDecimals())} ${coin.pair.symbol}.`);
        approved = await approveForCurve(w, coin.pair.address, coin.pair.symbol, 'allowance', q.amount);
      } else if (balances.eth !== null && balances.eth < q.amount) throw Error(`Your wallet holds ${formatUnits(balances.eth, 18, 5)} ETH.`);
      const minOut = q.tokensOut * (10000n - bps) / 10000n;
      note = (approved ? 'Step 2 of 2 · c' : 'C') + 'onfirm the buy in your wallet…'; render();
      const hash = await w.sendTransaction({ to: spender(), value: native() ? q.amount : 0n, data: encode(SELECTORS.buy, addressWord(coin.token), word(q.amount), word(minOut), addressWord(me), word(deadline)) });
      note = 'Buy sent: ' + short(hash) + '. The pool updates within a minute.'; noteBad = false; amountInput.value = '';
    } else {
      if (balances.token !== null && balances.token < q.amount) throw Error(`You hold ${tokensText(formatUnits(balances.token, 18, 2))} ${coin.symbol}.`);
      const approved = await approveForCurve(w, coin.token, coin.symbol, 'tokenAllowance', q.amount);
      const minOut = q.quoteOut * (10000n - bps) / 10000n;
      note = (approved ? 'Step 2 of 2 · c' : 'C') + 'onfirm the sell in your wallet…'; render();
      const hash = await w.sendTransaction({ to: spender(), data: encode(SELECTORS.sell, addressWord(coin.token), word(q.amount), word(minOut), addressWord(me), word(deadline)) });
      note = 'Sell sent: ' + short(hash) + '. The pool updates within a minute.'; noteBad = false; amountInput.value = '';
    }
    setTimer(() => { void load(); void readBalances(); }, 6000);
  }
  async function claim() {
    const w = await ensureWallet(); if (!w.connected) { await connect(w); }
    const me = w.state().address; if (lower(me) !== lower(coin.recipients.creatorFeeRecipient)) throw Error('Connect the creator wallet ' + short(coin.recipients.creatorFeeRecipient) + ' to claim.');
    await w.ensureChain(); note = 'Confirm the claim in your wallet…'; render();
    const hash = await w.sendTransaction({ to: coin.contracts.escrow, data: native() ? encode(SELECTORS.claimAll, addressWord(me)) : encode(SELECTORS.claimAllToken, addressWord(coin.pair.address), addressWord(me)) });
    note = 'Claim sent: ' + short(hash) + '.'; noteBad = false; setTimer(() => { void load(); void readBalances(); }, 6000);
  }
  async function run(fn) { if (busy) return; busy = true; noteBad = false; render(); try { await fn(); } catch (e) { note = String(e?.message || 'The wallet did not complete the request.').replace(/(?:https?|wss?):\/\/\S+/g, '').slice(0, 240); noteBad = true; } finally { busy = false; render(); } }
  function renderTrade() {
    if (!tradeRoot) return; const w = wallet?.state() || { address: '' }, connected = !!w.address, form = tradeRoot.querySelector('[data-rh-form]');
    tradeRoot.querySelector('[data-rh-pair]').textContent = `${coin.symbol} / ${coin.pair.symbol}`;
    for (const b of tradeRoot.querySelectorAll('[data-rh-side]')) b.setAttribute('aria-pressed', String(b.dataset.rhSide === side));
    const linked = String(session?.account?.evmWallet || ''), linkedNote = connected && /^0x[0-9a-fA-F]{40}$/.test(linked) ? (lower(linked) === lower(w.address) ? ' · linked to your account ✓' : ' · not your account’s linked wallet (' + short(linked) + ')') : '';
    tradeRoot.querySelector('[data-rh-wallet]').textContent = connected ? short(w.address) + (w.wallet ? ' · ' + w.wallet : '') + (wallet.onChain ? '' : ' · not on Robinhood Chain') + linkedNote : /^0x[0-9a-fA-F]{40}$/.test(linked) ? 'Connect your linked wallet ' + short(linked) + ' (or any EVM wallet) to trade' : 'Connect a wallet to trade';
    tradeRoot.querySelector('[data-rh-connect]').textContent = connected ? 'Disconnect' : 'Connect wallet';
    form.hidden = !connected;
    tradeRoot.querySelector('[data-rh-gate]').textContent = connected ? '' : 'Connect MetaMask, Rabby or another EVM wallet on Robinhood Chain to trade here — or trade the same pool on Uniswap, GMGN or DexScreener.';
    if (connected) {
      tradeRoot.querySelector('[data-rh-input-label]').textContent = side === 'buy' ? 'Buy with' : 'Sell'; tradeRoot.querySelector('[data-rh-input-symbol]').textContent = side === 'buy' ? coin.pair.symbol : coin.symbol;
      const balance = side === 'buy' ? (native() ? balances.eth : balances.pair) : balances.token;
      tradeRoot.querySelector('[data-rh-balance]').textContent = balance === null ? 'Balance —' : 'Balance ' + (side === 'buy' ? formatUnits(balance, pairDecimals(), native() ? 5 : 2) + ' ' + coin.pair.symbol : tokensText(formatUnits(balance, 18, 2)) + ' ' + coin.symbol);
      const presetsOff = busy || maxAmount() === null;
      for (const b of tradeRoot.querySelectorAll('[data-rh-percent]')) { b.disabled = presetsOff; if (b.dataset.rhMax !== undefined) b.title = side === 'buy' && native() ? 'Your ETH balance, keeping a little for gas' : 'Your whole balance'; }
      let quoteText = '';
      try { const q = localQuote(); if (q) quoteText = q.kind === 'buy' ? `About ${tokensText(formatUnits(q.tokensOut, 18, 0))} ${coin.symbol}${q.refund > 0n ? ` · ${formatUnits(q.refund, pairDecimals(), 6)} ${coin.pair.symbol} refunded (the pool’s liquidity ends there)` : ''} · pool fee ${formatUnits(q.fee, pairDecimals(), 6)} ${coin.pair.symbol}` : `About ${formatUnits(q.quoteOut, pairDecimals(), 6)} ${coin.pair.symbol}${q.limited ? ` for ${tokensText(formatUnits(q.used, 18, 0))} ${coin.symbol} (the pool’s liquidity ends there; the rest stays yours)` : ''} · pool fee ${q.feeInCoins ? tokensText(formatUnits(q.fee, 18, 2)) + ' ' + coin.symbol : formatUnits(q.fee, pairDecimals(), 6) + ' ' + coin.pair.symbol}`; } catch (e) { quoteText = String(e?.message || ''); }
      tradeRoot.querySelector('[data-rh-quote]').textContent = quoteText;
      const action = tradeRoot.querySelector('[data-rh-action]'); action.textContent = busy ? 'Please wait…' : side === 'buy' ? `Buy ${coin.symbol}` : `Sell ${coin.symbol}`; action.disabled = busy;
    }
    const noteNode = tradeRoot.querySelector('[data-rh-note]'); noteNode.textContent = note; noteNode.hidden = !note; noteNode.classList.toggle('negative', noteBad);
    const claimRoot = tradeRoot.querySelector('[data-rh-claim]'); claimRoot.replaceChildren();
    const r = coin.recipients, owed = owedLive ?? (r?.owed != null ? big(r.owed) : null), mine = connected && r?.creatorClaims && lower(r.creatorFeeRecipient) === lower(w.address);
    claimRoot.hidden = !r?.creatorClaims;
    if (r?.creatorClaims) {
      const box = el('div', null, 'rh-claim-box'); box.append(el('h3', 'Creator fees'), el('p', `Your creator fee (${bpsText(ROBINHOOD_FEES.curveCreatorBps)} of every swap on the curve, ${bpsText(ROBINHOOD_FEES.poolCreatorBps)} after graduation) accrues in Launchpad’s fee escrow under ${short(r.creatorFeeRecipient)}${owed !== null ? ': ' + formatUnits(owed, pairDecimals(), native() ? 6 : 2) + ' ' + coin.pair.symbol + ' claimable' : ''}.`, 'ct-note'));
      if (mine) { const b = el('button', busy ? 'Please wait…' : 'Claim to my wallet', 'ct-action'); b.type = 'button'; b.disabled = busy || owed === 0n; b.addEventListener('click', () => run(claim)); box.append(b); }
      claimRoot.append(box);
    }
  }
  function render() { if (disposed || !coin) return; renderIdentity(); renderMarket(); renderActivity(); renderRewards(); buildTrade(); renderTrade(); }
  // ---- wiring ---------------------------------------------------------------------------------------------------------
  const refresh = $('coin-refresh'); if (refresh) refresh.addEventListener('click', () => void load({ manual: true }));
  const activityRefresh = $('coin-activity-refresh'); if (activityRefresh) activityRefresh.addEventListener('click', () => void load({ manual: true }));
  for (const b of main.querySelectorAll('[data-activity]')) b.addEventListener('click', () => { activity = b.dataset.activity; for (const x of main.querySelectorAll('[data-activity]')) x.setAttribute('aria-pressed', String(x === b)); render(); });
  const onVisibility = () => { if (!document.hidden) void load(); }; document.addEventListener('visibilitychange', onVisibility);
  void load(); void ensureWallet().catch(() => {});
  return Object.freeze({
    setSession(value) { session = value; render(); }, refresh: () => load({ manual: true }), get coin() { return coin; },
    destroy() { disposed = true; if (timer) clearTimer(timer); walletUnsubscribe?.(); document.removeEventListener('visibilitychange', onVisibility); },
  });
}
