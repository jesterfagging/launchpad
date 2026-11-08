const AMMS = Object.freeze({
  'pump-classic': { name: 'PumpSwap', icon: '/pair-origin-pump.png' },
  'damm-pump': { name: 'PumpSwap', icon: '/pair-origin-pump.png' },
  pumpswap: { name: 'PumpSwap', icon: '/pair-origin-pump.png' },
  meteora: { name: 'Meteora DAMM v2', icon: '/quote-logos/METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL.webp' },
  raydium: { name: 'Raydium', icon: '/quote-logos/4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R.png' },
  // Robinhood Chain coins (v71.41) are Uniswap v4 pools from their first block.
  robinhood: { name: 'Uniswap v4 · Robinhood Chain', icon: '/robinhood-chain.svg' },
});

/** Public launch-route metadata identifies the destination, never a ticker or mint suffix. */
export function launchAmm(coin) {
  if (!coin) return null;
  // Older Launchpad discovery responses predate this field and contain only Raydium launches.
  const mode = coin.launchMode ?? coin.platform ?? coin.venue ?? 'raydium';
  return Object.hasOwn(AMMS, mode) ? mode : null;
}

export function createLaunchAmmBadge(document, coin, {visibleLabel = false} = {}) {
  const mode = launchAmm(coin), amm = AMMS[mode];
  if (!amm) return null;
  if (document.head && !document.getElementById('curve-amm-branding-styles')) {
    const styles = document.createElement('link');
    styles.id = 'curve-amm-branding-styles';styles.rel = 'stylesheet';styles.href = '/amm-branding.css?v=64';
    document.head.append(styles);
  }
  const graduated = coin.stage === 'graduated' || coin.curveStatus === 'migrated';
  const label = mode==='pump-classic'?(graduated?'Graduated to PumpSwap':'Pump.fun → PumpSwap'):mode==='damm-pump'?(graduated?'Graduated to PumpSwap':'PumpSwap'):mode==='meteora'?(graduated?'Meteora DAMM v2':'Meteora DBC → DAMM v2'):mode==='robinhood'?(graduated?'Graduated · Uniswap v4 on Robinhood Chain':'Uniswap v4 pool on Robinhood Chain'):`${graduated ? 'Graduated to' : 'Graduates to'} ${amm.name}`;
  const badge = document.createElement('span'), icon = document.createElement('img');
  badge.className = 'launch-amm-badge' + (visibleLabel ? ' is-labeled' : '');badge.dataset.amm = mode;badge.title = label;
  badge.setAttribute('role', 'img');badge.setAttribute('aria-label', label);
  icon.src = amm.icon;icon.alt = '';icon.width = icon.height = 16;icon.decoding = 'async';
  icon.onerror = () => { icon.remove();if (!visibleLabel) badge.textContent = amm.name;badge.dataset.state = 'fallback'; };
  badge.append(icon);
  if (visibleLabel) { const text = document.createElement('span');text.textContent = label;text.setAttribute('aria-hidden', 'true');badge.append(text); }
  return badge;
}
