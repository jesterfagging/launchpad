// The Robinhood Chain launch (v71.39): the market block on the launch page (pair, start, rewards, the fee shape — the
// flat creator fee or the holder tax — and the first buy) and the launch flow in its dialog (quote → review → connect
// an EVM wallet → fund from it → the worker creates the coin → live). The page supplies the coin's details, the
// transfer rules and the API; this module never sees a key — every transfer is the wallet's own prompt. Browser-safe:
// no Node imports.
import { ROBINHOOD_MODES, ROBINHOOD_OPTION_MODES, ROBINHOOD_MODE_LABELS, ROBINHOOD_MODE_SUMMARIES, ROBINHOOD_TIERS, ROBINHOOD_DEFAULT_TIER, ROBINHOOD_LIMITS, ROBINHOOD_FEES, ROBINHOOD_FEE_LINK, ROBINHOOD_STATES, ROBINHOOD_NATIVE, ROBINHOOD_PAIR_KINDS, robinhoodTier, robinhoodTaxed, robinhoodFeesFor, bpsText } from './robinhood-launch-catalog.mjs';
import { PUMP_OPTIONS, pumpOptionRequest, describePumpOption } from './pump-option-catalog.mjs';
import { curveForTargets, plannedSupply, tierTargetsInPair, parsePrice } from './robinhood-curve-math.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/, HASH = /^0x[0-9a-fA-F]{64}$/, ID = /^[a-f0-9]{24}$/;
const TOTAL_SUPPLY = 10n ** 27n;
const PENDING = new Set(['awaiting_funding', 'funding_pending', 'funded', 'creating']);
const DONE = new Set(['created', 'failed', 'refunding', 'refunded', 'cancelled', 'expired']);
const STEPS = [['quote', 'Review'], ['fund', 'Fund'], ['create', 'Create coin'], ['live', 'Live']];
const stepOf = state => state === 'awaiting_funding' ? 'fund' : state === 'funding_pending' || state === 'funded' || state === 'creating' ? 'create' : state === 'created' ? 'live' : 'fund';
const money = (value, digits = 0) => '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const short = value => ADDRESS.test(value || '') ? value.slice(0, 6) + '…' + value.slice(-4) : String(value || '');
const trimZeros = text => String(text).includes('.') ? String(text).replace(/\.?0+$/, '') : String(text);
/** Raw units as a readable amount (grouped, trimmed to `places` decimals). */
export function formatUnits(raw, decimals, places = 6) {
  let value = BigInt(String(raw ?? '0')); const negative = value < 0n; if (negative) value = -value;
  const scale = 10n ** BigInt(decimals), whole = value / scale, fraction = (value % scale).toString().padStart(decimals, '0').slice(0, places).replace(/0+$/, '');
  return (negative ? '-' : '') + whole.toLocaleString('en-US') + (fraction ? '.' + fraction : '');
}
export const tokensText = text => { const n = Number(String(text).replace(/,/g, '')); return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : 2 }) : String(text); };
/** A typed amount (whole units, up to `decimals` places) to raw units; throws on anything else. */
export function parseAmount(text, decimals) {
  const value = String(text ?? '').trim().replace(/,/g, '');
  if (value === '' || value === '.') return 0n;
  if (!/^(?:\d+)?(?:\.\d*)?$/.test(value)) throw Error('Enter a plain number.');
  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw Error(`Use at most ${decimals} decimal places.`);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals));
}
/**
 * The server's expected-token estimate for a first buy on a fresh curve (LaunchFactory maths mirrored): the curve
 * pool's whole fee (`tradeFeeBps`, 1.75% for a creator-shape coin; `creatorTaxBps` is the older name for the same
 * deduction, kept for callers that still pass the two parts) comes off the buy, the rest moves the curve.
 */
export function expectedTokens({ virtualQuote, graduationQuote, devBuy, creatorTaxBps = 0, tradeFeeBps = ROBINHOOD_FEES.curveProtocolBps + ROBINHOOD_FEES.curveCreatorBps }) {
  const supply = plannedSupply(TOTAL_SUPPLY, virtualQuote, graduationQuote), net = devBuy - devBuy * BigInt(tradeFeeBps + creatorTaxBps) / 10000n;
  const k = virtualQuote * supply.virtualToken, after = k / (virtualQuote + net), out = supply.virtualToken - after;
  return { tokens: out > supply.sellSupply ? supply.sellSupply : out, supply };
}
/** The holder-tax choices a Holders / Diamond Hands coin offers (whole percents between the policy's bounds). */
export const ROBINHOOD_TAX_CHOICES = Object.freeze(Array.from({ length: Math.floor((ROBINHOOD_LIMITS.maxTaxBps - ROBINHOOD_LIMITS.minTaxBps) / 100) + 1 }, (_, i) => ROBINHOOD_LIMITS.minTaxBps + i * 100));
/** The fee lines of a launch's shape, for the launch page and the review: both stages, who gets what. */
export function robinhoodFeeLines(mode, taxBps = 0) {
  const f = ROBINHOOD_FEES, fees = robinhoodFeesFor(robinhoodTaxed(mode) ? taxBps : 0);
  if (fees.taxBps > 0) return {
    curve: `${bpsText(fees.curveTotalBps)} per swap on the curve: ${bpsText(f.curveProtocolBps)} Launchpad + ${bpsText(fees.taxBps)} holder tax`,
    pool: `${bpsText(fees.poolTotalBps)} after graduation: ${bpsText(f.poolProtocolBps + f.poolCreatorBps)} pool fee + ${bpsText(fees.taxBps)} holder tax`,
    who: `The tax replaces the creator fee: 95% of it funds the holder rewards, 5% is Launchpad’s. It is written on the coin at launch and cannot change.`,
  };
  const recipient = mode === 'earned' ? 'is held in Launchpad’s escrow for this coin and released as Earned describes' : mode === 'insured' ? 'goes to this coin’s Launchpad wallet: the coverage share builds the refund pot, the rest is paid to you' : 'accrues under your wallet on chain; claim it from the coin page whenever you like';
  return {
    curve: `${bpsText(fees.curveTotalBps)} per swap on the curve: ${bpsText(f.curveProtocolBps)} Launchpad + ${bpsText(f.curveCreatorBps)} creator fee`,
    pool: `${bpsText(fees.poolTotalBps)} after graduation: ${bpsText(f.poolProtocolBps)} Launchpad + ${bpsText(f.poolCreatorBps)} creator fee`,
    who: `The creator fee is fixed and ${recipient}.`,
  };
}
export const robinhoodErrorText = (error, fallback = 'Something went wrong. Try again.') => { const text = String(error?.message || '').replace(/(?:https?|wss?):\/\/\S+/g, '[link]').trim(); return text ? text.slice(0, 300) : fallback; };

/**
 * The market block: pairs (ETH, USDG, then every approved stock and ETF, searchable), the start tier, the rewards
 * option with its settings, the fee shape (the holder tax for Holders / Diamond Hands) and the first buy. `request(path)`
 * reads the venue API (`/status`, `/pairs`).
 */
export function createRobinhoodMarket({ document, root, request, onChange = () => {}, clock = Date.now, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = id => clearTimeout(id) } = {}) {
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined && text !== null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  root.classList.add('rh-market');
  let status = null, pairs = [], pairsAt = 0, pairsError = '', pair = null, tier = ROBINHOOD_DEFAULT_TIER, mode = 'creator', tax = ROBINHOOD_LIMITS.defaultTaxBps, search = '', active = true, disposed = false, refreshTimer = null, loading = null;
  const optionFields = new Map();
  // --- availability line ---
  // The availability line speaks only when the venue is not available (checking, closed, blocked); when it is, the block
  // starts with the choices themselves (v71.42: no venue sentence on the form — the docs describe the pool).
  const availability = el('p', 'Checking Robinhood Chain availability…', 'help rh-availability'); availability.setAttribute('role', 'status');
  const availabilityDivider = el('div', null, 'launch-divider');
  // --- pair: ETH | USDG | Custom ⌄, the Custom segment opening the catalogue (the Solana layout) ---
  const pairBlock = el('div', null, 'rh-field rh-pairs'), pairTitle = el('h3', 'Pair asset'); pairTitle.id = 'rh-pair-label';
  const pairSegments = el('div', null, 'launch-segments launch-pairs rh-pair-segments'); pairSegments.setAttribute('role', 'group'); pairSegments.setAttribute('aria-labelledby', 'rh-pair-label');
  const segment = (key, label) => { const b = el('button'); b.type = 'button'; b.dataset.rhPair = key; b.setAttribute('aria-pressed', 'false'); b.append(el('span', label, 'rh-pair-segment-label')); pairSegments.append(b); return b; };
  const ethSegment = segment('eth', 'ETH'), usdgSegment = segment('usdg', 'USDG'), customSegment = segment('custom', 'Custom'); customSegment.setAttribute('aria-haspopup', 'dialog'); customSegment.append(el('span', '⌄', 'rh-pair-caret'));
  const pairNote = el('p', '', 'help rh-pair-note'); pairNote.setAttribute('role', 'status');
  pairBlock.append(pairTitle, pairSegments, pairNote);
  // The catalogue dialog: search (a name, a ticker or a token address), categories, every launchable pair, and the
  // Custom check — any token address is looked up on the chain and answered (available, not open yet, compatible
  // and requested from the operator, or why not).
  const dialog = el('dialog', null, 'launch-asset-dialog rh-pair-dialog'); dialog.setAttribute('aria-labelledby', 'rh-pair-dialog-title'); dialog.setAttribute('data-navigation-free', '');
  const heading = el('div', null, 'card-heading'), headingCopy = el('div'), dialogTitle = el('h2', 'Choose a pair'); dialogTitle.id = 'rh-pair-dialog-title';
  const dialogDescription = el('p', 'ETH, USDG, tokenised stocks and ETFs, and the tokens Launchpad added. Paste any Robinhood Chain token address to check it.', 'help');
  headingCopy.append(dialogTitle, dialogDescription); const closeButton = el('button', '✕', 'small-button'); closeButton.type = 'button'; closeButton.setAttribute('aria-label', 'Close pair picker'); heading.append(headingCopy, closeButton);
  const countLine = el('p', 'Checking available pairs…', 'help launch-asset-count'); countLine.setAttribute('role', 'status');
  const searchWrap = el('div', null, 'launch-asset-search-wrap rh-pair-search'), searchInput = el('input'); searchInput.type = 'search'; searchInput.placeholder = 'Search name, ticker or token address…'; searchInput.autocomplete = 'off'; searchInput.setAttribute('aria-label', 'Search pair assets'); searchWrap.append(searchInput);
  const filters = el('div', null, 'launch-asset-filters'); filters.setAttribute('aria-label', 'Pair category');
  const CATEGORIES = [['all', 'All assets'], ['stocks', 'Stocks & ETFs'], ['crypto', 'Crypto'], ['custom', 'Launchpad-added']];
  for (const [key, label] of CATEGORIES) { const b = el('button', label); b.type = 'button'; b.dataset.rhCategory = key; b.setAttribute('aria-pressed', String(key === 'all')); b.addEventListener('click', () => { category = key; renderPairs(); }); filters.append(b); }
  const catalogueNote = el('p', '', 'help rh-pair-catalogue-note'), results = el('div', null, 'rh-pair-results'); results.setAttribute('role', 'listbox'); results.setAttribute('aria-labelledby', 'rh-pair-dialog-title');
  dialog.append(heading, countLine, searchWrap, filters, catalogueNote, results);
  (document.body || document.documentElement).append(dialog);
  const openDialog = () => { if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); } else dialog.setAttribute('open', ''); renderPairs(); try { searchInput.focus(); } catch { /* focus is best effort */ } void refresh(); };
  const closeDialog = () => { if (typeof dialog.close === 'function' && dialog.open) dialog.close(); else dialog.removeAttribute('open'); };
  closeButton.addEventListener('click', closeDialog);
  customSegment.addEventListener('click', openDialog);
  ethSegment.addEventListener('click', () => { const next = nativePair(); if (next) { pair = next; changed(); } });
  usdgSegment.addEventListener('click', () => { const next = stablePair(); if (next) { pair = next; changed(); } });
  // --- tier ---
  const tierBlock = el('div', null, 'rh-field rh-tiers'), tierTitle = el('h3', 'Starting market cap'); tierTitle.id = 'rh-tier-label';
  const tierSegments = el('div', null, 'launch-segments rh-tier-segments'); tierSegments.setAttribute('role', 'group'); tierSegments.setAttribute('aria-labelledby', 'rh-tier-label');
  for (const t of ROBINHOOD_TIERS) { const b = el('button', t.label); b.type = 'button'; b.dataset.tier = t.id; b.addEventListener('click', () => { if (tier !== t.id) { tier = t.id; changed(); } }); tierSegments.append(b); }
  const tierNote = el('p', '', 'help rh-tier-note');
  tierBlock.append(tierTitle, tierSegments, tierNote);
  // --- rewards ---
  const modeBlock = el('fieldset', null, 'launch-fees rh-modes'), modeLegend = el('legend', 'Choose rewards'), modeSegments = el('div', null, 'launch-segments rh-mode-segments'); modeSegments.setAttribute('role', 'group');
  // The five options a Robinhood coin can take now; Gotchi, AI Agent, Market Maker and LP Manager (ROBINHOOD_LATER_MODES)
  // are not shown until they exist on this chain (v71.42: no "Soon" buttons for the soft launch).
  for (const id of ROBINHOOD_MODES) {
    const b = el('button', ROBINHOOD_MODE_LABELS[id] || id); b.type = 'button'; b.dataset.mode = id;
    b.addEventListener('click', () => { if (mode !== id) { mode = id; changed(); } });
    modeSegments.append(b);
  }
  const modeNote = el('p', '', 'help rh-mode-note'), optionWrap = el('div', null, 'launch-pump-option-wrap rh-option-wrap');
  for (const id of ROBINHOOD_OPTION_MODES) {
    const item = PUMP_OPTIONS[id], fields = new Map(), set = el('fieldset', null, 'launch-pump-option'); set.dataset.pumpOption = id; set.hidden = true; set.append(el('legend', item.name + ' settings'));
    for (const f of item.settings) {
      const inputId = 'rh-' + id.replace(/_/g, '-') + '-' + f.key.toLowerCase(), label = el('label', f.label); label.htmlFor = inputId;
      let input;
      if (f.options) { input = el('select'); f.options.forEach((value, i) => { const option = el('option', f.labels?.[i] || String(value)); option.value = String(value); input.append(option); }); input.value = String(f.value); }
      else { input = el('input'); input.type = 'number'; input.inputMode = 'decimal'; input.min = String(f.min); input.max = String(f.max); input.step = String(f.step); input.value = String(f.value); }
      input.id = inputId; input.dataset.key = f.key; fields.set(f.key, input);
      const row = el('div', null, f.options ? 'launch-pump-option-choice' : 'launch-sol-input'); row.append(input); if (!f.options && f.unit) row.append(el('span', f.unit));
      const hint = el('p', f.hint || '', 'help'); hint.id = inputId + '-hint'; if (!f.hint) hint.hidden = true; input.setAttribute('aria-describedby', hint.id);
      set.append(label, row, hint);
    }
    const help = el('p', '', 'help launch-pump-option-help'); help.setAttribute('role', 'status'); set.append(help); optionWrap.append(set); optionFields.set(id, fields);
  }
  modeBlock.append(modeLegend, modeSegments, modeNote, optionWrap);
  // --- the fee shape (v71.41, Raydium's numbers) and the first buy ---
  // A Creator / Earned / Insured coin carries the flat creator fee (0.5% on the curve, 0.25% after graduation): nothing
  // to choose, the lines say who gets what. A Holders / Diamond Hands coin carries a holder tax of 1–3% instead (2%
  // unless chosen), 95% of it for the holders; the segments pick it.
  const feeBlock = el('div', null, 'rh-field rh-fee'), feeTitle = el('h3', 'Fees'); feeTitle.id = 'rh-fee-label';
  const taxSegments = el('div', null, 'launch-segments rh-tax-segments'); taxSegments.setAttribute('role', 'group'); taxSegments.setAttribute('aria-labelledby', 'rh-fee-label');
  for (const bps of ROBINHOOD_TAX_CHOICES) { const b = el('button', bpsText(bps)); b.type = 'button'; b.dataset.tax = String(bps); b.addEventListener('click', () => { if (tax !== bps) { tax = bps; changed(); } }); taxSegments.append(b); }
  const feeLines = el('ul', null, 'rh-fee-lines'), feeCurveLine = el('li'), feePoolLine = el('li'); feeLines.append(feeCurveLine, feePoolLine);
  const feeHelp = el('p', '', 'help rh-fee-help'); feeHelp.id = 'rh-fee-help'; const feeWho = document.createTextNode('');
  const feeLink = el('a', 'Fees & revenue'); feeLink.href = ROBINHOOD_FEE_LINK; feeLink.target = '_blank'; feeLink.rel = 'noopener'; feeHelp.append(feeWho, document.createTextNode(' See '), feeLink, document.createTextNode('.'));
  feeBlock.append(feeTitle, taxSegments, feeLines, feeHelp);
  const buyBlock = el('div', null, 'rh-field rh-buy'), buyLabel = el('label', 'First buy'); buyLabel.htmlFor = 'rh-dev-buy'; buyLabel.append(el('span', 'optional', 'optional'));
  const buyRow = el('div', null, 'launch-sol-input'), buyInput = el('input'); buyInput.id = 'rh-dev-buy'; buyInput.type = 'text'; buyInput.inputMode = 'decimal'; buyInput.autocomplete = 'off'; buyInput.placeholder = '0.00'; buyInput.value = '0'; buyInput.setAttribute('aria-describedby', 'rh-dev-buy-help'); const buyUnit = el('span', 'ETH'); buyRow.append(buyInput, buyUnit);
  const buyHelp = el('p', 'Bought in the transaction that creates the coin, at the starting price. The tokens go to the wallet you fund from.', 'help'); buyHelp.id = 'rh-dev-buy-help';
  const buyEstimate = el('p', '', 'help rh-buy-estimate'); buyEstimate.setAttribute('role', 'status');
  buyBlock.append(buyLabel, buyRow, buyHelp, buyEstimate);
  const summary = el('p', '', 'rh-summary'); summary.setAttribute('role', 'status');
  const grid = el('div', null, 'launch-market-grid rh-grid'); grid.append(pairBlock, tierBlock);
  const grid2 = el('div', null, 'launch-market-grid rh-grid'); grid2.append(feeBlock, buyBlock);
  root.replaceChildren(availability, availabilityDivider, grid, el('div', null, 'launch-divider'), modeBlock, el('div', null, 'launch-divider'), grid2, summary);
  for (const type of ['input', 'change']) { optionWrap.addEventListener(type, () => changed()); buyInput.addEventListener(type, () => changed()); }
  searchInput.addEventListener('input', () => { search = searchInput.value.trim().toLowerCase(); renderPairs(); });
  function changed() { render(); onChange(); }
  // --- data ---
  const nativePair = () => pairs.find(p => p.native) || null, stablePair = () => pairs.find(p => p.kind === 'stable') || null;
  let category = 'all', checks = new Map(), checking = '';
  /** The Custom check of a pasted token address (cached per address while the block lives). */
  async function checkAddress(address) {
    const key = address.toLowerCase(); if (checks.has(key) && checks.get(key).pending) return;
    checks.set(key, { pending: true }); checking = key; renderPairs();
    try { const result = await request('/pair-check?address=' + encodeURIComponent(address)); if (disposed) return; checks.set(key, { ...result, pending: false, at: clock() }); }
    catch (error) { if (disposed) return; checks.set(key, { pending: false, status: 'error', available: false, reason: robinhoodErrorText(error, 'The token could not be checked right now.'), at: clock() }); }
    finally { if (checking === key) checking = ''; }
    renderPairs();
  }
  function applyPairs(result) {
    const rows = Array.isArray(result?.pairs) ? result.pairs.filter(p => p && ADDRESS.test(p.address || '') && typeof p.symbol === 'string') : [];
    const order = p => p.native ? 0 : p.kind === 'stable' ? 1 : p.kind === 'etf' ? 3 : 2;
    pairs = rows.map(p => ({ ...p, native: p.native === true || String(p.address).toLowerCase() === ROBINHOOD_NATIVE })).sort((a, b) => order(a) - order(b) || String(a.symbol).localeCompare(String(b.symbol)));
    pairsAt = clock(); pairsError = ''; pairsNotice = result?.notice || '';
    if (!pair || !pairs.some(p => p.address.toLowerCase() === pair.address.toLowerCase())) pair = nativePair() || pairs[0] || null; else pair = pairs.find(p => p.address.toLowerCase() === pair.address.toLowerCase());
  }
  let pairsNotice = '';
  async function refresh({ force = false } = {}) {
    if (disposed) return; if (loading) return loading;
    if (!force && pairsAt > 0 && clock() - pairsAt < 60000) return;
    loading = (async () => {
      try { const [s, p] = await Promise.all([request('/status'), request('/pairs')]); if (disposed) return; status = s; applyPairs(p); }
      catch (error) { if (disposed) return; pairsError = robinhoodErrorText(error, 'The pair list could not be loaded.'); if (!status) status = { available: false, reason: pairsError }; }
      finally { loading = null; render(); onChange(); }
    })();
    return loading;
  }
  function schedule() { if (refreshTimer) clearTimer(refreshTimer); refreshTimer = setTimer(() => { refreshTimer = null; if (active && !disposed) { void refresh({ force: true }).then(schedule); } }, 120000); }
  // --- state readers ---
  const allowed = () => status?.available === true && status.intakeOpen === true;
  const reason = () => status?.reason || (status ? 'Robinhood launches are not available right now.' : 'Checking Robinhood Chain availability…');
  function price() { const usd = pair?.usd; return usd && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(usd)) && parsePrice(String(usd)) > 0n ? String(usd) : null; }
  /** The holder tax the quote carries: the chosen one for Holders / Diamond Hands, 0 for the creator shape. */
  function taxBps() { return robinhoodTaxed(mode) ? tax : 0; }
  const fees = () => robinhoodFeesFor(taxBps());
  function devBuyRaw() { if (!pair) return 0n; return parseAmount(buyInput.value, pair.decimals); }
  function optionRaw(id) { const fields = optionFields.get(id), out = {}; for (const [key, input] of fields || []) out[key] = input.value; return out; }
  function option() { return ROBINHOOD_OPTION_MODES.includes(mode) ? pumpOptionRequest(mode, { settings: optionRaw(mode) }) : null; }
  /** The curve a quote would be given now (null without a live price). */
  function numbers() {
    const usd = price(); if (!usd || !pair) return null;
    const t = robinhoodTier(tier), targets = tierTargetsInPair(t, usd, pair.decimals), curve = curveForTargets(targets.startFdv, targets.graduationFdv);
    return { tier: t, usd, ...curve, raiseUsd: Number(curve.graduationQuote * parsePrice(usd) / 10n ** BigInt(pair.decimals)) / 1e8 };
  }
  // --- render ---
  const inCategory = p => category === 'all' || (category === 'stocks' ? p.kind === 'stock' || p.kind === 'etf' : category === 'crypto' ? p.kind === 'native' || p.kind === 'stable' : p.kind === 'custom');
  const selectedIs = p => !!pair && !!p && p.address.toLowerCase() === pair.address.toLowerCase();
  /**
   * The circular badge of a pair, as Solana's quote picker shows them: the pair's logo served by this host
   * (`/robinhood-pairs/logo/<address>`), falling back to a two-letter lettermark when there is none or it fails to load.
   */
  function pairBadge(p, size) {
    const badge = el('span', null, 'rh-pair-badge'); badge.dataset.pair = String(p.address || '').toLowerCase();
    const mark = el('span', p.native || /^ETH$/i.test(p.symbol || '') ? 'Ξ' : (p.symbol || '?').slice(0, 2), 'rh-pair-mark'); badge.append(mark);
    if (typeof p.logo === 'string' && /^(?:\/robinhood-pairs\/logo\/0x[0-9a-fA-F]{40}(?:\?v=\d+)?|https:\/\/[^\s"']+)$/.test(p.logo)) {
      const img = el('img'); img.src = p.logo; img.width = size; img.height = size; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
      img.addEventListener('error', () => { img.remove(); mark.hidden = false; }); mark.hidden = true; badge.append(img);
    }
    return badge;
  }
  function pairRow(p, { status = '', reason = '', disabled = false, onPick = null } = {}) {
    const b = el('button', null, 'launch-asset-option rh-pair' + (p.native ? ' is-native' : '')); b.type = 'button'; b.dataset.pairAddress = p.address; b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(selectedIs(p))); b.disabled = disabled;
    b.append(pairBadge(p, 26));
    const copy = el('span', null, 'rh-pair-copy'); copy.append(el('strong', p.symbol), el('small', [p.name || '', ROBINHOOD_PAIR_KINDS[p.kind] || ''].filter(Boolean).join(' · ')));
    if (p.kind === 'custom' || p.address.toLowerCase() !== ROBINHOOD_NATIVE) { const identity = el('small', short(p.address), 'launch-asset-mint'); identity.title = p.address; copy.append(identity); }
    if (reason) copy.append(el('small', reason, 'launch-asset-reason'));
    const side = el('span', null, 'rh-pair-side'); side.append(el('small', p.halted ? 'Halted' : p.usd ? money(p.usd, Number(p.usd) >= 100 ? 0 : 2) : ''), el('small', status || (selectedIs(p) ? 'Selected' : p.halted ? 'Halted' : 'Available')));
    b.append(copy, side); if (p.halted) b.classList.add('is-halted');
    if (onPick) b.addEventListener('click', onPick);
    return b;
  }
  function renderPairs() {
    // the segments
    const eth = nativePair(), usdg = stablePair(), custom = pair && !pair.native && pair.kind !== 'stable' ? pair : null;
    ethSegment.disabled = !eth; usdgSegment.disabled = !usdg; customSegment.disabled = false;
    ethSegment.setAttribute('aria-pressed', String(!!pair?.native)); usdgSegment.setAttribute('aria-pressed', String(!!pair && pair.kind === 'stable')); customSegment.setAttribute('aria-pressed', String(!!custom));
    customSegment.querySelector('.rh-pair-segment-label').textContent = custom ? custom.symbol : 'Custom';
    const existingBadge = customSegment.querySelector('.rh-pair-badge'); if (custom) { if (existingBadge?.dataset.pair !== custom.address.toLowerCase()) { const badge = pairBadge(custom, 22); existingBadge ? existingBadge.replaceWith(badge) : customSegment.prepend(badge); } } else existingBadge?.remove();
    // the dialog
    for (const b of filters.querySelectorAll('[data-rh-category]')) { const key = b.dataset.rhCategory; b.setAttribute('aria-pressed', String(key === category)); b.hidden = key !== 'all' && !pairs.some(p => inCategory({ ...p, kind: p.kind }) && (key === 'all' || (key === 'stocks' ? p.kind === 'stock' || p.kind === 'etf' : key === 'crypto' ? p.kind === 'native' || p.kind === 'stable' : p.kind === 'custom'))); }
    if (category !== 'all' && filters.querySelector(`[data-rh-category="${category}"]`)?.hidden) category = 'all';
    countLine.textContent = pairsError && !pairs.length ? 'Pair list unavailable.' : pairs.length ? `Robinhood Chain · ${pairs.length} ${pairs.length === 1 ? 'pair' : 'pairs'} available · Includes ETH${usdg ? ' and USDG' : ''}` : 'Checking available pairs…';
    catalogueNote.textContent = pairsNotice || (status?.pairsOpen === false ? 'Stock, ETF and Launchpad-added pairs open soon. ETH and USDG are available now.' : 'Availability is checked before launch. Paste a token address to check any other token.');
    results.replaceChildren();
    const rows = pairs.filter(p => inCategory(p) && (!search || `${p.symbol} ${p.name || ''} ${p.address}`.toLowerCase().includes(search))).sort((a, b) => Number(!!a.halted) - Number(!!b.halted));
    for (const p of rows) results.append(pairRow(p, { onPick: () => { if (p.halted) return; pair = p; changed(); closeDialog(); } }));
    // the Custom check: a pasted address that is not in the list
    const typed = searchInput.value.trim();
    if (ADDRESS.test(typed) && !pairs.some(p => p.address.toLowerCase() === typed.toLowerCase())) {
      const check = checks.get(typed.toLowerCase());
      if (!check) { const b = el('button', null, 'launch-asset-option rh-pair rh-pair-check'); b.type = 'button'; b.append(el('span', '?', 'rh-pair-mark'), (() => { const c = el('span', null, 'rh-pair-copy'); c.append(el('strong', 'Check this token'), el('small', short(typed) + ' · reads the token on Robinhood Chain and tells you whether it can be a pair')); return c; })()); b.addEventListener('click', () => { void checkAddress(typed); }); results.append(b); }
      else if (check.pending) results.append(el('p', `Checking ${short(typed)} on Robinhood Chain…`, 'help rh-pair-checking'));
      else {
        const p = { address: check.address || typed, symbol: check.symbol || short(typed), name: check.name || '', decimals: check.decimals ?? 18, kind: check.kind || 'custom', logo: check.logo || null, usd: check.usd || null, halted: !!check.halted, native: false };
        const label = check.status === 'available' ? 'Available' : check.status === 'halted' ? 'Halted' : check.status === 'not_open' ? 'Not open yet' : check.status === 'not_offered' ? 'Not offered' : check.status === 'not_approved' ? 'Not approved yet' : check.status === 'unlisted' ? (check.compatible ? 'Compatible · requested' : 'No price') : check.status === 'invalid' ? 'Not a pair' : 'Check failed';
        results.append(pairRow(p, { status: label, reason: check.reason || '', disabled: !check.available, onPick: check.available ? () => { pairs = pairs.some(x => x.address.toLowerCase() === p.address.toLowerCase()) ? pairs : [...pairs, p]; pair = p; changed(); closeDialog(); } : null }));
      }
    }
    if (!results.childElementCount) results.append(el('p', pairsError && !pairs.length ? pairsError : !pairs.length ? 'Checking available pairs…' : search ? 'No matching pair. Try a name, a ticker, or paste a token address to check it.' : 'No pairs in this category yet.', 'help'));
  }
  function render() {
    if (disposed) return;
    availability.textContent = allowed() ? '' : reason();
    availability.hidden = availabilityDivider.hidden = allowed();
    availability.classList.toggle('negative', !!status && !allowed());
    renderPairs();
    const n = (() => { try { return numbers(); } catch { return null; } })();
    pairNote.textContent = pairsError ? pairsError : pair ? (pair.native ? 'Your coin trades against ETH.' : `Your coin trades against ${pair.symbol}${pair.usd ? ' (' + money(pair.usd, 2) + ')' : ''}. Dollar values move with ${pair.symbol}.`) + (pairsNotice ? ' ' + pairsNotice : '') : pairsNotice || '';
    for (const b of tierSegments.querySelectorAll('[data-tier]')) b.setAttribute('aria-pressed', String(b.dataset.tier === tier));
    const t = robinhoodTier(tier);
    tierNote.textContent = t ? t.summary + (n ? ` Graduates after about ${formatUnits(n.graduationQuote, pair.decimals, pair.native ? 4 : 2)} ${pair.symbol} (${money(n.raiseUsd)}) is raised.` : '') : '';
    for (const b of modeSegments.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    modeNote.textContent = ROBINHOOD_MODE_SUMMARIES[mode] || '';
    optionWrap.hidden = !ROBINHOOD_OPTION_MODES.includes(mode);
    for (const set of optionWrap.querySelectorAll('[data-pump-option]')) {
      const on = set.dataset.pumpOption === mode; set.hidden = !on; if (!on) continue;
      const help = set.querySelector('.launch-pump-option-help');
      try { help.textContent = describePumpOption(mode, optionRaw(mode)); help.classList.remove('negative'); } catch (error) { help.textContent = robinhoodErrorText(error); help.classList.add('negative'); }
    }
    // The fee shape: the tax segments for a holder-reward coin, the fixed lines otherwise.
    const taxed = robinhoodTaxed(mode), shape = fees(), lines = robinhoodFeeLines(mode, tax);
    feeTitle.textContent = taxed ? 'Holder tax' : 'Fees';
    taxSegments.hidden = !taxed; for (const b of taxSegments.querySelectorAll('[data-tax]')) b.setAttribute('aria-pressed', String(taxed && Number(b.dataset.tax) === tax));
    feeCurveLine.textContent = lines.curve; feePoolLine.textContent = lines.pool; feeWho.textContent = lines.who;
    feeBlock.dataset.shape = taxed ? 'tax' : 'creator';
    buyUnit.textContent = pair?.symbol || 'ETH';
    let estimate = '';
    try {
      const raw = devBuyRaw();
      if (raw > 0n && n) { const { tokens } = expectedTokens({ virtualQuote: n.virtualQuote, graduationQuote: n.graduationQuote, devBuy: raw, tradeFeeBps: shape.curveTotalBps }); estimate = `About ${formatUnits(tokens, 18, 0)} ${'tokens'} (${(Number(tokens * 10000n / TOTAL_SUPPLY) / 100).toFixed(2)}% of the supply) at today’s price, after the ${bpsText(shape.curveTotalBps)} fee.`; }
      else if (raw > 0n) estimate = 'A live pair price is needed to estimate the tokens.';
    } catch (error) { estimate = robinhoodErrorText(error); }
    buyEstimate.textContent = estimate; buyEstimate.classList.toggle('negative', /^(Enter|Use|The)/.test(estimate));
    summary.textContent = pair && t ? `${ROBINHOOD_MODE_LABELS[mode]} · ${t.label} → ${money(t.graduationUsd)} graduation · pair ${pair.symbol} · ${bpsText(shape.curveTotalBps)} on the curve, ${bpsText(shape.poolTotalBps)} after` + (status?.launchFeeEth ? ` · launch fee ${trimZeros(status.launchFeeEth)} ETH` : '') : '';
  }
  /** The market part of a quote request; throws the first problem in the words the person needs. */
  function input() {
    if (!allowed()) throw Error(reason());
    if (!pair) throw Error(pairsError || 'Choose a pair asset.');
    if (pair.halted) throw Error(`${pair.symbol} trading is halted right now. Choose another pair or try later.`);
    const raw = devBuyRaw(), opt = option();
    return { tier, pairToken: pair.native ? 'eth' : pair.address, mode, taxBps: taxBps(), devBuy: formatUnits(raw, pair.decimals, pair.decimals).replace(/,/g, ''), option: opt ? opt.settings : undefined };
  }
  function problem() { try { input(); return ''; } catch (error) { return robinhoodErrorText(error); } }
  render();
  return Object.freeze({
    refresh, input, problem, render,
    get status() { return status; }, get pair() { return pair; }, get tier() { return tier; }, get mode() { return mode; }, get pairs() { return pairs; }, get taxBps() { return taxBps(); }, get fees() { return fees(); },
    /** The proposed fees in one line, for the page's preview card: "1.75% on the curve · 0.5% after graduation". */
    get feeText() { const f = fees(); return `${bpsText(f.curveTotalBps)} on the curve · ${bpsText(f.poolTotalBps)} after graduation`; },
    allowed, reason, numbers,
    setActive(value) { active = !!value; if (active) { void refresh(); schedule(); } else if (refreshTimer) { clearTimer(refreshTimer); refreshTimer = null; } },
    setPair(address) { const next = pairs.find(p => p.address.toLowerCase() === String(address).toLowerCase()); if (next) { pair = next; changed(); return true; } return false; },
    setTier(id) { if (robinhoodTier(id) && tier !== id) { tier = id; changed(); } },
    setMode(id) { if (ROBINHOOD_MODES.includes(id) && mode !== id) { mode = id; changed(); } },
    setTax(bps) { const value = Number(bps); if (ROBINHOOD_TAX_CHOICES.includes(value) && tax !== value) { tax = value; changed(); } },
    openPicker: openDialog, closePicker: closeDialog, get picker() { return dialog; }, checkAddress,
    dispose() { disposed = true; if (refreshTimer) clearTimer(refreshTimer); closeDialog(); dialog.remove(); },
  });
}

/**
 * The launch flow (in the launch dialog): quote → fund from the connected EVM wallet → the worker's progress → live.
 * `request(path, { method, body })` calls the venue API; `getInput()` returns the quote body (details, market and
 * rules) or throws; `wallet` is the EVM wallet (public/evm-wallet.mjs); `connectWallet()` opens the page's wallet
 * picker when the wallet needs choosing.
 */
export function createRobinhoodLaunch({ document, window = document.defaultView, root, request, wallet, getInput, context = () => ({ active: true }), onChange = () => {}, onLive = () => {}, connectWallet = null, linkedWallet = () => '', coinLink = launch => launch.coinUrl || '/coin?mint=' + encodeURIComponent(launch.token || '') + '&chain=robinhood', clock = Date.now, setTimer = (fn, ms) => window.setTimeout(fn, ms), clearTimer = id => window.clearTimeout(id) }) {
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined && text !== null) node.textContent = String(text); if (cls) node.className = cls; return node; };
  root.classList.add('pump-classic-operation', 'rh-operation');
  const track = el('ol', null, 'launch-flow-track pump-classic-track'); track.setAttribute('aria-label', 'Launch progress');
  for (const [key, label] of STEPS) { const item = el('li'); item.dataset.flowStep = key; item.append(el('span', null, 'launch-flow-dot'), document.createTextNode(label)); track.append(item); }
  const facts = el('dl', null, 'pump-classic-facts'), disclosure = el('ul', null, 'pump-classic-disclosure'), notice = el('p', '', 'help pump-classic-status'), walletLine = el('p', '', 'help rh-wallet-line'), links = el('div', null, 'pump-classic-links'), actions = el('div', null, 'pump-classic-actions'), resume = el('div', null, 'rh-resume');
  notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); for (const target of [notice, facts]) target.tabIndex = -1;
  const review = el('button', 'Review launch', 'primary'), connect = el('button', 'Connect EVM wallet', 'primary'), fund = el('button', 'Fund and launch', 'primary'), retry = el('button', 'Retry submission', 'small-button'), cancel = el('button', 'Start over', 'small-button'), coin = el('a', 'Open coin →', 'primary');
  for (const b of [review, connect, fund, retry, cancel]) b.type = 'button';
  actions.append(review, connect, fund, retry, cancel, coin); root.replaceChildren(resume, track, facts, disclosure, walletLine, notice, links, actions);
  let launch = null, busy = false, message = '', negative = false, pendingSubmit = null, pollTimer = null, tickTimer = null, disposed = false, requestKey = '', pending = [];
  const active = () => !disposed && context().active === true;
  const say = (text, bad = false) => { message = text; negative = bad; render(); };
  const valid = value => !!value && ID.test(value.id || '') && typeof value.state === 'string';
  const quoteExpired = () => launch?.state === 'awaiting_funding' && Number.isFinite(launch.quote?.expiresAt) && launch.quote.expiresAt <= clock();
  function newRequestKey() { const bytes = new Uint8Array(16); (window.crypto || globalThis.crypto).getRandomValues(bytes); requestKey = [...bytes].map(b => b.toString(16).padStart(2, '0')).join(''); }
  newRequestKey();
  const unsubscribe = wallet?.onChange ? wallet.onChange(() => render()) : () => {};
  function row(label, value, cls) { const item = el('div', null, cls); item.append(el('dt', label), el('dd', value)); facts.append(item); }
  function link(text, href) { if (!href) return; const a = el('a', text, 'small-button'); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; links.append(a); }
  function render() {
    if (disposed) return;
    const focused = document.activeElement && root.contains(document.activeElement) ? document.activeElement : null;
    root.hidden = !active(); facts.replaceChildren(); disclosure.replaceChildren(); links.replaceChildren(); resume.replaceChildren();
    const state = launch?.state || 'quote', current = launch ? stepOf(state) : 'quote', order = STEPS.map(s => s[0]), expired = quoteExpired(), w = wallet?.state?.() || { address: '' };
    track.hidden = !launch; track.dataset.flow = current;
    track.dataset.state = state === 'created' ? 'live' : expired || ['failed', 'expired', 'refunded', 'refunding', 'cancelled'].includes(state) ? 'error' : launch && state !== 'awaiting_funding' && !DONE.has(state) ? 'confirming' : 'idle';
    for (const item of track.querySelectorAll('[data-flow-step]')) { const index = order.indexOf(item.dataset.flowStep), at = order.indexOf(current); item.classList.toggle('is-done', state === 'created' || index < at); if (state !== 'created' && index === at) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current'); }
    if (!launch && pending.length) {
      resume.append(el('p', 'You have a Robinhood launch in progress:', 'help'));
      for (const l of pending) { const b = el('button', `${l.name} · $${l.symbol} · ${l.stateLabel || ROBINHOOD_STATES[l.state] || l.state}`, 'small-button'); b.type = 'button'; b.addEventListener('click', () => { void open(l.id); }); resume.append(b); }
    }
    if (launch) {
      const q = launch.quote || null, pairSymbol = launch.pair?.symbol || 'ETH';
      row('Coin', [launch.name, launch.symbol ? '$' + launch.symbol : ''].filter(Boolean).join(' · '));
      row('Chain', 'Robinhood Chain'); row('Pair', pairSymbol); if (launch.tier) row('Start', `${launch.tier.label} → ${money(launch.tier.graduationUsd)} graduation`);
      row('Rewards', launch.modeLabel || launch.mode); if (launch.option?.description) row('Option rules', launch.option.description);
      // The fee shape the coin carries (the server's `fees` view; the catalogue's numbers stand in for an older view).
      const shape = launch.fees && Number.isFinite(Number(launch.fees.curveTotalBps)) ? launch.fees : robinhoodFeesFor(Number(launch.taxBps) || 0);
      if (shape.taxBps > 0) row('Holder tax', `${bpsText(shape.taxBps)} · 95% to the holders, 5% to Launchpad`);
      row('Trading fee', `${bpsText(shape.curveTotalBps)} on the curve · ${bpsText(shape.poolTotalBps)} after graduation`);
      if (Number(launch.rules) > 0) row('Transfer rules', String(launch.rules));
      if (q) {
        const devBuy = Number(String(q.devBuy || '0').replace(/,/g, '')) > 0;
        row(state === 'created' ? 'First buy' : 'First buy', devBuy ? trimZeros(q.devBuy) + ' ' + (q.devBuySymbol || pairSymbol) : 'None');
        if (devBuy) row('Tokens you receive', state === 'created' && launch.devTokens && launch.devTokens !== '0' ? tokensText(launch.devTokens) : '~' + tokensText(q.expectedTokens));
        row('Launch fee', trimZeros(q.launchFeeEth) + ' ETH');
        row('Gas budget', 'up to ' + trimZeros(q.gasBudgetEth) + ' ETH (the unused part comes back)'); if (Number(q.feeWalletGasEth) > 0) row('Option wallet gas', trimZeros(q.feeWalletGasEth) + ' ETH');
        if (launch.developerWallet) row('Funded from · tokens to', short(launch.developerWallet));
        if (state === 'awaiting_funding' && Number.isFinite(q.expiresAt)) { const left = Math.max(0, Math.round((q.expiresAt - clock()) / 1000)); row('Quote valid for', left > 0 ? Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') : 'expired'); }
        const pairLeg = launch.fundingTransactions?.find(t => t.purpose === 'pair');
        row(state === 'awaiting_funding' ? 'Total from your wallet' : 'Funded from your wallet', trimZeros(q.totalEth) + ' ETH' + (pairLeg ? ' + ' + trimZeros(q.devBuy) + ' ' + pairSymbol : ''), 'is-total');
      }
      if (state !== 'awaiting_funding') { row('Status', launch.stateLabel || ROBINHOOD_STATES[state] || state); if (launch.reason) row('Details', launch.reason); if (launch.refundedEth && launch.refundedEth !== '0') row('Refunded', trimZeros(launch.refundedEth) + ' ETH'); }
    }
    for (const line of launch?.disclosure || []) {
      const item = el('li'), at = String(line).indexOf('Fees & revenue');
      if (at < 0) item.textContent = line; else { const a = el('a', 'Fees & revenue'); a.href = launch.feeLink || ROBINHOOD_FEE_LINK; a.target = '_blank'; a.rel = 'noopener'; item.append(document.createTextNode(line.slice(0, at)), a, document.createTextNode(line.slice(at + 14))); }
      disclosure.append(item);
    }
    disclosure.hidden = !launch || state !== 'awaiting_funding';
    link('Funding transaction ↗', launch?.explorer?.funding); link('Creation transaction ↗', launch?.explorer?.create); link('Refund transaction ↗', launch?.explorer?.refund); if (state === 'created') link('Coin on the explorer ↗', launch.explorer?.token);
    links.hidden = !links.childElementCount;
    // The wallet comes first: the quote is made for its address (the coin's creator; the first buy's tokens go there).
    const needWallet = !launch || state === 'awaiting_funding' && !expired && !pendingSubmit;
    // The account's linked EVM wallet (Edit profile) comes first: it is named when nothing is connected, confirmed when
    // it is the connected one, and a different connected wallet is pointed out (either may fund; the coin follows the wallet).
    const linkedAddress = (() => { try { const v = linkedWallet(); return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : ''; } catch { return ''; } })();
    const linkedNote = !w.address ? '' : linkedAddress && w.address.toLowerCase() === linkedAddress.toLowerCase() ? ' · linked to your account ✓' : linkedAddress ? ` — not the wallet linked to your account (${short(linkedAddress)}); you can still launch from it, and the coin, its tokens and its fees follow the wallet you fund from.` : '';
    walletLine.hidden = !needWallet; if (needWallet) walletLine.textContent = w.address ? `Your wallet: ${short(w.address)}${w.wallet ? ' (' + w.wallet + ')' : ''}${wallet.onChain ? ' · Robinhood Chain' : ' · switches to Robinhood Chain when you fund'}` + (launch?.developerWallet && w.address.toLowerCase() !== launch.developerWallet.toLowerCase() ? ` — this quote was made for ${short(launch.developerWallet)}; fund from that wallet, or start over.` : linkedNote) : linkedAddress ? `Connect the EVM wallet linked to your account (${short(linkedAddress)}), or any EVM wallet you will fund from. It becomes the coin’s creator wallet.` : 'Connect the EVM wallet you will fund from (MetaMask, Rabby or another EVM wallet). It becomes the coin’s creator wallet.';
    const shown = expired ? 'This quote expired. Start over for a fresh quote.' : message;
    notice.textContent = shown; notice.hidden = !shown; notice.classList.toggle('negative', negative || expired);
    review.hidden = !!launch || !w.address; review.disabled = busy;
    connect.hidden = !needWallet || !!w.address; connect.disabled = busy || !!w.connecting;
    const wrongWallet = !!launch?.developerWallet && !!w.address && w.address.toLowerCase() !== launch.developerWallet.toLowerCase();
    fund.hidden = !launch || !needWallet || !w.address || launch.canFund === false || wrongWallet; fund.disabled = busy;
    retry.hidden = !pendingSubmit; retry.disabled = busy;
    cancel.hidden = !launch || !!pendingSubmit || !(state === 'awaiting_funding' || DONE.has(state) && state !== 'created'); cancel.disabled = busy;
    cancel.textContent = state === 'awaiting_funding' && !expired ? 'Cancel this quote' : 'Start over';
    coin.hidden = state !== 'created'; if (!coin.hidden) coin.href = coinLink(launch); else coin.removeAttribute('href');
    root.setAttribute('aria-busy', String(busy));
    if (focused && (!focused.isConnected || focused.hidden || focused.disabled || focused.closest('[hidden]'))) { const next = [review, connect, notice, cancel, retry].find(t => !t.hidden && !t.disabled) || (facts.childElementCount ? facts : null); if (next && !root.hidden) { try { next.focus(); } catch { /* focus is best effort */ } } }
    onChange(snapshot());
  }
  function snapshot() { return { launch, busy, pending: pendingSubmit ? true : false, locked: !!launch && PENDING.has(launch.state) }; }
  function setLaunch(value) { if (!valid(value)) throw Error('The server returned an invalid launch.'); launch = value; if (launch.state === 'created') { onLive(launch); } }
  function stopPolling() { if (pollTimer) { clearTimer(pollTimer); pollTimer = null; } if (tickTimer) { clearTimer(tickTimer); tickTimer = null; } }
  function poll(delay = 4000) {
    stopPolling();
    if (!launch || !PENDING.has(launch.state)) return;
    pollTimer = setTimer(async () => { pollTimer = null; if (disposed || !launch) return; try { const fresh = await request('/launch?launchId=' + encodeURIComponent(launch.id)); if (disposed || !launch || fresh?.id !== launch.id) return; setLaunch(fresh); render(); } catch { /* the next tick tries again */ } poll(launch && launch.state === 'awaiting_funding' ? 15000 : 4000); }, delay);
    if (launch.state === 'awaiting_funding') tickTimer = setTimer(() => { tickTimer = null; render(); if (launch?.state === 'awaiting_funding') poll(pollTimer ? 4000 : 4000); }, 1000);
  }
  async function loadPending() { try { const mine = await request('/launches'); pending = Array.isArray(mine?.launches) ? mine.launches.filter(l => PENDING.has(l.state)) : []; } catch { pending = []; } }
  async function run(fn) { if (busy) return; busy = true; render(); try { await fn(); } catch (error) { say(robinhoodErrorText(error), true); } finally { busy = false; render(); } }
  review.addEventListener('click', () => run(async () => {
    const address = wallet.state().address; if (!address) throw Error('Connect the EVM wallet you will fund from.');
    const input = { ...getInput({ wallet: address }), wallet: address };
    say('Preparing your quote…');
    const quoted = await request('/quote', { method: 'POST', body: { ...input, requestKey: 'rh-' + requestKey } });
    setLaunch(quoted); say(quoted.state === 'awaiting_funding' ? 'Review the quote, connect the wallet you will fund from, then fund and launch.' : '');
    poll(15000);
  }));
  connect.addEventListener('click', () => run(async () => {
    say('');
    if (typeof connectWallet === 'function') await connectWallet(); else await wallet.connect();
    if (!wallet.state().address) throw Error('Connect an EVM wallet to fund the launch.');
    await wallet.ensureChain().catch(() => {});
  }));
  async function submit(hashes) {
    const sent = await request('/fund/submit', { method: 'POST', body: { launchId: launch.id, txHashes: hashes } });
    setLaunch(sent); pendingSubmit = null; say('Funding sent. Launchpad confirms it and creates your coin; this takes a minute or two.'); poll(3000);
  }
  fund.addEventListener('click', () => run(async () => {
    if (!launch || launch.state !== 'awaiting_funding') return;
    if (quoteExpired()) throw Error('This quote expired. Start over for a fresh quote.');
    if (!wallet.state().address) throw Error('Connect the EVM wallet you will fund from.');
    say('Checking the quote…');
    const prepared = await request('/fund/prepare', { method: 'POST', body: { launchId: launch.id } });
    const transactions = Array.isArray(prepared?.transactions) ? prepared.transactions : [];
    if (!transactions.length) throw Error('Nothing to fund.');
    await wallet.ensureChain();
    const hashes = [];
    for (const [index, tx] of transactions.entries()) {
      say(transactions.length > 1 ? `Approve transfer ${index + 1} of ${transactions.length} in your wallet: ${tx.label || ''}` : `Approve the transfer in your wallet: ${tx.label || ''}`);
      const hash = await wallet.sendTransaction({ to: tx.to, value: tx.value, data: tx.data || '0x' });
      if (!HASH.test(hash)) throw Error('The wallet did not return a transaction hash.');
      hashes.push(hash);
    }
    pendingSubmit = hashes;
    try { await submit(hashes); } catch (error) { say('Your transfer was sent but Launchpad could not record it: ' + robinhoodErrorText(error) + ' Retry the submission; nothing is sent twice.', true); }
  }));
  retry.addEventListener('click', () => run(async () => { if (pendingSubmit) await submit(pendingSubmit); }));
  cancel.addEventListener('click', () => run(async () => {
    if (launch && launch.state === 'awaiting_funding' && !quoteExpired()) { const cancelled = await request('/cancel', { method: 'POST', body: { launchId: launch.id } }); setLaunch(cancelled); }
    stopPolling(); launch = null; pendingSubmit = null; newRequestKey(); say(''); await loadPending();
  }));
  async function open(id) { await run(async () => { say('Loading…'); const fresh = await request('/launch?launchId=' + encodeURIComponent(id)); setLaunch(fresh); say(''); poll(2000); }); }
  render();
  return Object.freeze({
    render, open, snapshot,
    get launch() { return launch; }, get busy() { return busy; }, get locked() { return !!launch && PENDING.has(launch.state); },
    /** Prepares the dialog: lists pending launches to resume, keeps a loaded one. */
    async start() { if (!launch) await loadPending(); render(); if (launch) poll(1000); },
    stop() { stopPolling(); },
    reset() { stopPolling(); launch = null; pendingSubmit = null; message = ''; negative = false; newRequestKey(); render(); },
    dispose() { disposed = true; stopPolling(); unsubscribe(); },
  });
}
