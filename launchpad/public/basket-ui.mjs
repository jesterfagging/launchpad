// Reward baskets (Launchpad v71.33; Pump.fun from v71.35): the launch-page step where a Meteora or Pump.fun holder-rewards
// launch adds up to two more reward assets next to its pair asset, and the read-only pieces the coin page shows. The step
// mounts into #launch-basket (shipped hidden in launchpad.html) and keeps its choice in one hidden input, `basketExtras`
// (comma-separated mints), which the launch page reads through extras() and sends as `basket: [mint, mint]` inside the
// launch request. Assets come from the venue's verified pair list (Meteora's own; the verified catalogue for Pump.fun); the
// server checks every mint again and proves a swap route. `venue` names the venue in the step's sentences.
import { BASKET_LIMITS, basketLaunchRequest, describeBasket, BASKET_RULES } from './basket-catalog.mjs';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const text = (value, max = 80) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, max) : '';
/** The extra mints a form holds (the hidden `basketExtras` input), base58 only, in order, deduplicated. */
export function basketExtrasOf(form) {
  let node = null; try { node = form?.elements?.namedItem?.('basketExtras') ?? null; } catch { node = null; }
  const raw = node == null ? '' : String(node.value ?? '');
  return [...new Set(raw.split(',').map(s => s.trim()).filter(s => BASE58.test(s)))].slice(0, BASKET_LIMITS.maxExtras);
}
/** '' when the choice can launch, else one sentence (the shared catalogue's complaint, or an asset the host no longer offers). */
export function basketProblem(extras, { quoteMint = '', assets = [], enabled = true, venue = 'Meteora' } = {}) {
  if (!extras.length) return '';
  const where = text(venue, 24) || 'Meteora';
  if (!enabled) return `Reward baskets are for ${where} launches with holder rewards. Choose Holders on ${where}, or remove the basket.`;
  try { basketLaunchRequest(extras, { quoteMint }); } catch (error) { return text(error?.message, 300) || 'Check the reward basket.'; }
  for (const mint of extras) { const asset = assets.find(a => a?.mint === mint); if (!asset || asset.launchReady !== true) return `${asset?.symbol || 'An asset'} in your basket is not available for ${where} launches right now. Remove it or choose another.`; }
  return '';
}
/** The preview-card line: "SOL + USDC + TSLAx · equal shares" ('' without extras). */
export function basketSummary(extras, { main = null, assets = [] } = {}) {
  if (!extras.length) return '';
  const symbol = mint => text(assets.find(a => a?.mint === mint)?.symbol, 24) || mint.slice(0, 4) + '…';
  return [text(main?.symbol, 24) || 'Pair asset', ...extras.map(symbol)].join(' + ') + ' · equal shares';
}
/**
 * The "Reward basket (optional)" block. `root` is the #launch-basket container; `form` the launch form; `assets()` the current
 * Meteora pair list; `main()` the chosen pair asset; `enabled()` whether a basket may be chosen now (Meteora, Holders, host
 * offers baskets); `onChange()` is called after every change so the launch page re-syncs. sync() re-renders and returns the
 * preview line; extras() and problem() are what the launch page reads.
 */
export function createBasketStep({ document, form, root, assets = () => [], main = () => null, enabled = () => false, venue = () => 'Meteora', onChange = () => {} } = {}) {
  const where = () => text(typeof venue === 'function' ? venue() : venue, 24) || 'Meteora';
  const el = (tag, content, cls) => { const node = document.createElement(tag); if (content != null) node.textContent = String(content); if (cls) node.className = cls; return node; };
  const EventType = document.defaultView?.Event || globalThis.Event;
  root.replaceChildren(); root.classList.add('launch-basket');
  const block = el('fieldset', null, 'launch-basket-block'), legend = el('legend');
  legend.append(el('span', 'Reward basket (optional)', 'launch-basket-title'), el('span', 'Pay holders in up to ' + BASKET_LIMITS.maxAssets + ' assets: your pair asset plus up to ' + BASKET_LIMITS.maxExtras + ' more.', 'launch-basket-hint'));
  const intro = el('p', 'Every hourly reward round is split equally across the basket. The extra shares are converted at market by Launchpad (route costs come out of that share), then every eligible holder is airdropped every asset. The coin itself still trades against your pair asset only.', 'help launch-basket-intro'); intro.id = 'launch-basket-intro';
  const status = el('p', '', 'help launch-basket-status'); status.id = 'launch-basket-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const chips = el('div', null, 'launch-basket-chips'); chips.id = 'launch-basket-chips'; chips.setAttribute('aria-label', 'Basket assets');
  const hidden = el('input'); hidden.type = 'hidden'; hidden.setAttribute('name', 'basketExtras'); hidden.name = 'basketExtras'; hidden.id = 'launch-basket-extras'; hidden.value = '';
  const actions = el('div', null, 'launch-basket-actions'), add = el('button', 'Add an asset', 'small-button'); add.type = 'button'; add.id = 'launch-basket-add'; actions.append(add);
  const picker = el('div', null, 'launch-basket-picker'); picker.id = 'launch-basket-picker'; picker.hidden = true;
  const search = el('input'); search.type = 'search'; search.id = 'launch-basket-search'; search.setAttribute('placeholder', 'Search verified assets'); search.setAttribute('autocomplete', 'off'); search.setAttribute('aria-label', 'Search assets for the basket');
  const list = el('div', null, 'launch-basket-list'); list.id = 'launch-basket-list'; list.setAttribute('role', 'listbox');
  picker.append(search, list);
  const error = el('p', '', 'launch-agent-setting-error launch-basket-error'); error.id = 'launch-basket-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  const rules = el('details', null, 'launch-basket-rules'), rulesList = el('ul'); rules.id = 'launch-basket-rules'; rules.append(el('summary', 'How reward baskets work'), rulesList); for (const rule of BASKET_RULES) rulesList.append(el('li', rule));
  block.append(legend, intro, status, chips, hidden, actions, picker, error, rules); root.append(block);
  let disposed = false, open = false, version = '', needle = '';
  const bump = () => { try { hidden.dispatchEvent(new EventType('change', { bubbles: true })); } catch { /* no listeners */ } onChange(); };
  const extras = () => basketExtrasOf(form);
  const setExtras = next => { hidden.value = [...new Set(next)].slice(0, BASKET_LIMITS.maxExtras).join(','); version = ''; bump(); };
  function renderChips(current, rows, pair) {
    chips.replaceChildren();
    const pairChip = el('span', null, 'launch-basket-chip is-pair'); pairChip.append(el('strong', text(pair?.symbol, 24) || 'Pair asset'), el('small', 'pair asset')); chips.append(pairChip);
    for (const mint of current) {
      const asset = rows.find(a => a?.mint === mint), chip = el('span', null, 'launch-basket-chip'); chip.dataset.mint = mint;
      chip.append(el('strong', text(asset?.symbol, 24) || mint.slice(0, 4) + '…' + mint.slice(-4)), el('small', text(asset?.name, 40) || (asset ? '' : 'not in the current pair list')));
      const remove = el('button', '×', 'launch-basket-remove'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove ' + (text(asset?.symbol, 24) || 'this asset') + ' from the basket'); remove.onclick = () => setExtras(extras().filter(m => m !== mint));
      chip.append(remove); chips.append(chip);
    }
  }
  function renderList(current, rows, pair) {
    list.replaceChildren();
    const candidates = rows.filter(a => a && BASE58.test(String(a.mint)) && a.launchReady === true && a.mint !== pair?.mint && !current.includes(a.mint)).filter(a => !needle || `${a.symbol} ${a.name} ${a.mint}`.toLowerCase().includes(needle)).slice(0, 24);
    if (!candidates.length) { list.append(el('p', rows.length ? 'No matching verified asset.' : 'Verified ' + where() + ' assets are still loading.', 'help launch-basket-empty')); return; }
    for (const asset of candidates) {
      const button = el('button', null, 'launch-basket-option'); button.type = 'button'; button.setAttribute('role', 'option'); button.dataset.mint = asset.mint;
      button.append(el('strong', text(asset.symbol, 24)), el('small', text(asset.name, 48)));
      button.onclick = () => { if (extras().length >= BASKET_LIMITS.maxExtras) return; setExtras([...extras(), asset.mint]); open = extras().length < BASKET_LIMITS.maxExtras; render(); };
      list.append(button);
    }
  }
  function render() {
    if (disposed) return;
    const on = enabled() === true, rows = Array.isArray(assets()) ? assets() : [], pair = main() || null, current = extras();
    // The pair asset can never be an extra: choosing it as the pair drops it from the basket.
    if (pair?.mint && current.includes(pair.mint)) { setExtras(current.filter(m => m !== pair.mint)); return; }
    const problem = basketProblem(current, { quoteMint: pair?.mint || '', assets: rows, enabled: on, venue: where() });
    const key = JSON.stringify([on, current, rows.map(a => [a?.mint, a?.symbol, a?.launchReady]), pair?.mint, pair?.symbol, open, needle, problem, where()]);
    if (key === version) return; version = key;
    root.hidden = !on && !current.length;
    status.textContent = on ? (current.length ? current.length + (current.length === 1 ? ' extra asset' : ' extra assets') + ' in the basket · ' + describeBasket([pair?.symbol || 'pair asset', ...current.map(m => text(rows.find(a => a?.mint === m)?.symbol, 24) || m.slice(0, 4) + '…')]) : 'No extra assets yet. Holders are paid in ' + (text(pair?.symbol, 24) || 'the pair asset') + ' only.') : (current.length ? 'The basket applies to ' + where() + ' launches with holder rewards only.' : '');
    renderChips(current, rows, pair);
    add.hidden = !on || current.length >= BASKET_LIMITS.maxExtras; add.textContent = open ? 'Close' : current.length ? 'Add another asset' : 'Add an asset';
    picker.hidden = !on || !open || current.length >= BASKET_LIMITS.maxExtras; if (!picker.hidden) renderList(current, rows, pair);
    error.textContent = problem; error.hidden = !problem; hidden.setAttribute('aria-invalid', String(!!problem));
  }
  add.onclick = () => { open = !open; if (open) { search.value = ''; needle = ''; } render(); if (open) { try { search.focus(); } catch { /* not focusable here */ } } };
  search.addEventListener('input', () => { needle = String(search.value || '').trim().toLowerCase(); version = ''; render(); });
  render();
  return {
    extras, problem: () => basketProblem(extras(), { quoteMint: main()?.mint || '', assets: Array.isArray(assets()) ? assets() : [], enabled: enabled() === true, venue: where() }),
    /** Re-renders what changed and returns the preview-card line ('' without extras). */
    sync() { render(); return basketSummary(extras(), { main: main(), assets: Array.isArray(assets()) ? assets() : [] }); },
    summary: () => basketSummary(extras(), { main: main(), assets: Array.isArray(assets()) ? assets() : [] }),
    clear() { if (extras().length) setExtras([]); open = false; render(); },
    render, get open() { return open; },
    destroy() { if (disposed) return; disposed = true; root.replaceChildren(); },
  };
}
/** The coin page's description of a basket launch's rewards: "Rewards are paid in SOL, USDC and TSLAx (equal shares; the extra shares are converted at market each round), weighted by eligible token balances." */
export function basketRewardSentence(basket) {
  const assets = Array.isArray(basket?.assets) ? basket.assets : [];
  if (assets.length < 2) return '';
  return 'Rewards are paid in ' + describeBasket(assets.map(a => text(a.symbol, 24))) + ' (equal shares; the extra shares are converted at market each round), weighted by eligible token balances.';
}
