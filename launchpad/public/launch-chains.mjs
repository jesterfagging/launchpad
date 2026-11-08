// The launch page's first choice: the chain a coin lives on. Solana carries the Pump.fun, Raydium and Meteora venues;
// Robinhood Chain carries the launchpad's own launch contracts. A chain added with `revealed: false` stays out of the
// list and cannot be selected, even from a URL, until its venues ship. Browser-safe: no Node imports.
export const LAUNCH_CHAINS = Object.freeze([
  Object.freeze({ id: 'solana', name: 'Solana', tagline: 'Pump.fun · Raydium · Meteora', logo: '/solana-chain.svg', available: true, revealed: true, param: 'solana' }),
  Object.freeze({ id: 'robinhood', name: 'Robinhood', tagline: 'Uniswap v4 pool · liquidity locked', logo: '/robinhood-chain.svg', available: true, revealed: true, param: 'robinhood' }),
]);
export const DEFAULT_LAUNCH_CHAIN = 'solana';
/** The chains the page lists: revealed ones only. */
export const listedLaunchChains = (chains = LAUNCH_CHAINS) => chains.filter(c => c.revealed !== false);
export const launchChainById = id => LAUNCH_CHAINS.find(c => c.id === id) || null;
const selectable = chain => !!chain && chain.available === true && chain.revealed !== false;
/** The chain a page should open on: the URL's `chain`, then the remembered choice, then Solana; never a chain that is not available or not revealed. */
export function initialLaunchChain({ search = '', remembered = '' } = {}) {
  let fromUrl = '';
  try { fromUrl = new URLSearchParams(search).get('chain') || ''; } catch { fromUrl = ''; }
  for (const candidate of [fromUrl, remembered]) { const chain = launchChainById(String(candidate || '').toLowerCase()); if (selectable(chain)) return chain.id; }
  return DEFAULT_LAUNCH_CHAIN;
}

/**
 * Renders the chain segments into `root` and keeps them in step with the choice. `onChange(id)` fires on a real
 * change only. Only revealed chains are rendered; an unavailable revealed chain renders disabled with its tagline;
 * `hidden` chains are left out as well.
 */
export function createChainSelect({ document, root, chains = LAUNCH_CHAINS, value = DEFAULT_LAUNCH_CHAIN, onChange = () => {}, hidden = [] } = {}) {
  let current = selectable(launchChainById(value)) ? value : DEFAULT_LAUNCH_CHAIN;
  const buttons = new Map();
  root.replaceChildren();
  for (const chain of listedLaunchChains(chains)) {
    if (hidden.includes(chain.id)) continue;
    const button = document.createElement('button'); button.type = 'button'; button.dataset.launchChain = chain.id; button.disabled = !chain.available;
    if (!chain.available) button.title = chain.name + ' launches are coming soon.';
    const img = document.createElement('img'); img.src = chain.logo; img.width = 18; img.height = 18; img.alt = ''; img.loading = 'lazy';
    const copy = document.createElement('span'); copy.className = 'launch-venue-copy'; copy.dataset.launchTagline = chain.tagline;
    const name = document.createElement('span'); name.className = 'launch-venue-name'; name.textContent = chain.name; copy.append(name);
    if (!chain.available) { const soon = document.createElement('span'); soon.className = 'launch-chain-soon'; soon.textContent = 'Soon'; copy.append(soon); }
    button.append(img, copy);
    button.addEventListener('click', () => { if (!chain.available || chain.id === current) return; current = chain.id; sync(); onChange(current); });
    root.append(button); buttons.set(chain.id, button);
  }
  root.dataset.launchChainCount = String(buttons.size);
  function sync() { for (const [id, button] of buttons) button.setAttribute('aria-pressed', String(id === current)); }
  sync();
  return {
    get value() { return current; },
    set(id, { silent = false } = {}) { const chain = launchChainById(id); if (!selectable(chain) || chain.id === current) return false; current = chain.id; sync(); if (!silent) onChange(current); return true; },
    disable(disabled) { for (const [id, button] of buttons) button.disabled = disabled || !launchChainById(id).available; },
  };
}
