const address = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,79})$/.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const shorten = value => value.slice(0, 6) + '…' + value.slice(-6);
const usd = value => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);

export function earningsWallet(session) {
  if (!session?.authenticated) return null;
  const bound = session.account?.authType === 'wallet' ? session.account.mainWallet : session.account?.signInWallet || session.account?.mainWallet;
  const wallet = session.authMethod === 'wallet' ? session.walletAddress : bound;
  return address(wallet) ? wallet : null;
}

export function earningsAmount(units, decimals) {
  if (!uint(units) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return '—';
  const digits = units.padStart(decimals + 1, '0'), whole = decimals ? digits.slice(0, -decimals) : digits;
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, '') : '';
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
}

function section(value) {
  if (!value || !Array.isArray(value.quoteTotals) || value.quoteTotals.length > 1000 || !Number.isSafeInteger(value.paymentCount) || value.paymentCount < 0 || typeof value.historyComplete !== 'boolean' || typeof value.valuationComplete !== 'boolean') return null;
  const assets = [], seen = new Set();
  for (const row of value.quoteTotals) {
    if (!row || !address(row.mint) || seen.has(row.mint) || !uint(row.amountUnits) || !Number.isInteger(row.decimals) || row.decimals < 0 || row.decimals > 18) return null;
    seen.add(row.mint);
    assets.push({ mint: row.mint, symbol: typeof row.symbol === 'string' && row.symbol.trim() ? row.symbol.trim().slice(0, 24) : shorten(row.mint), amountUnits: row.amountUnits, decimals: row.decimals });
  }
  return { assets, paymentCount: value.paymentCount, historyComplete: value.historyComplete, valuationComplete: value.valuationComplete, usdEstimate: finite(value.usdEstimate) ? value.usdEstimate : null, observedUsdEstimate: finite(value.observedUsdEstimate) ? value.observedUsdEstimate : null, lastPaymentAt: timestamp(value.lastPaymentAt) ? value.lastPaymentAt : null };
}

export function createPersonalEarnings({ document, root, api, clock = Date.now, visible = () => true } = {}) {
  let identity = '', wallet = null, revision = 0, disposed = false, loading = false, nextRead = 0, snapshot = null, error = '';
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
  const title = el('div', null, 'personal-earnings-heading'), heading = el('h2', 'Your rewards'), state = el('p', '', 'personal-earnings-status');
  state.setAttribute('role', 'status'); title.append(heading, state);
  const cards = el('div', null, 'personal-earnings-grid'), note = el('p', '', 'personal-earnings-scope');
  root.append(title, cards, note); root.hidden = true;

  function card(key, label, data) {
    const node = el('article', null, 'personal-earnings-card'); node.dataset.earnings = key; node.dataset.motionReveal = ''; if (key === 'creator') node.dataset.motionGlow = 'soft';
    const name = el('h3', label), amount = el('strong', '—', 'personal-earnings-value'), caption = el('p', 'Loading confirmed payouts…', 'personal-earnings-caption');
    node.append(name, amount, caption);
    if (!data) { if (error) caption.textContent = 'Payout totals are temporarily unavailable.'; return node; }
    const priced = data.historyComplete && data.valuationComplete && data.usdEstimate !== null;
    const partial = !data.historyComplete;
    if (priced) { amount.textContent = usd(data.usdEstimate); caption.textContent = 'Estimated current value · all recorded payouts'; }
    else if (data.assets.length === 1) { amount.textContent = earningsAmount(data.assets[0].amountUnits, data.assets[0].decimals) + ' ' + data.assets[0].symbol; caption.textContent = partial ? 'Recorded payments' : 'Confirmed payouts'; }
    else if (data.assets.length) { amount.textContent = data.assets.length.toLocaleString() + ' assets'; caption.textContent = partial ? 'Recorded payments by asset' : 'Confirmed payouts by asset'; }
    else { amount.textContent = data.historyComplete ? 'No payouts yet' : '—'; caption.textContent = partial ? 'Earlier payout history is incomplete' : 'No confirmed payments recorded'; }
    if (!priced && data.observedUsdEstimate !== null && data.assets.length) caption.textContent += ' · Priced subtotal ≈ ' + usd(data.observedUsdEstimate);
    const native = el('ul', null, 'personal-earnings-assets');
    for (const row of data.assets) { const item = el('li'), label = el('span', row.symbol), value = el('span', earningsAmount(row.amountUnits, row.decimals)); label.title = row.mint; item.append(label, value); native.append(item); }
    if (data.assets.length > 3) { const details = el('details', null, 'personal-earnings-breakdown'); details.append(el('summary', 'View ' + data.assets.length.toLocaleString() + ' assets'), native); node.append(details); }
    else if (data.assets.length && (priced || data.assets.length > 1)) node.append(native);
    const history = el('p', null, 'personal-earnings-history');
    history.textContent = data.paymentCount.toLocaleString() + (data.paymentCount === 1 ? ' confirmed payment' : ' confirmed payments') + (data.lastPaymentAt ? ' · Last ' + new Date(data.lastPaymentAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
    node.append(history);
    if (partial) node.append(el('p', 'Some earlier payments may be unavailable.', 'personal-earnings-note'));
    if (data.assets.length && !data.valuationComplete) node.append(el('p', 'USD pricing is incomplete. Token amounts remain available.', 'personal-earnings-note'));
    return node;
  }

  function render() {
    root.hidden = disposed || !identity || !visible();
    if (root.hidden) return;
    cards.replaceChildren(card('creator', 'Creator rewards received', snapshot?.creator), card('holders', 'Holder rewards received', snapshot?.holders));
    if (!wallet || snapshot?.requiresWalletSignIn) {
      for (const caption of cards.querySelectorAll('.personal-earnings-caption')) caption.textContent = 'Connect your receiving wallet to see its payouts.';
      state.textContent = 'Wallet required'; note.textContent = 'Only payouts to your verified account wallet appear here.'; return;
    }
    state.textContent = error || (snapshot?.stale ? 'Update delayed' : snapshot?.updatedAt ? 'Updated ' + new Date(snapshot.updatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'Loading…');
    note.textContent = 'Private to you · ' + shorten(wallet) + '. Confirmed Launchpad payouts, including assigned creator fees. USD estimates use current prices.';
  }

  function clear() { revision++; identity = ''; wallet = null; loading = false; nextRead = 0; snapshot = null; error = ''; cards.replaceChildren(); state.textContent = ''; note.textContent = ''; root.hidden = true; }
  function setSession(session) {
    const nextWallet = earningsWallet(session), nextIdentity = session?.authenticated ? JSON.stringify([session.account?.id || session.account?.username || 'authenticated', session.authMethod || '', nextWallet]) : '';
    if (nextIdentity !== identity) { clear(); identity = nextIdentity; wallet = nextWallet; }
    render();
  }
  async function load() {
    if (disposed || !identity || !visible() || document.hidden || loading || clock() < nextRead) return;
    if (!wallet) { render(); return; }
    const generation = revision; loading = true; nextRead = clock() + 60000;
    try {
      const data = await api('/api/launchpad/earnings');
      if (disposed || !identity || generation !== revision) return;
      if (data?.scope !== 'confirmed_curve_payments') throw Error('Payout snapshot unavailable.');
      if (data.wallet === null && data.requiresWalletSignIn === true) { snapshot = { requiresWalletSignIn: true }; error = ''; return; }
      if (data.wallet !== wallet || data.requiresWalletSignIn === true) throw Object.assign(Error('Payout account changed.'), { statusCode: 403 });
      const creator = section(data.creator), holders = section(data.holders);
      if (!creator || !holders) throw Error('Payout snapshot unavailable.');
      snapshot = { creator, holders, updatedAt: timestamp(data.updatedAt) ? data.updatedAt : null, stale: data.stale === true }; error = '';
      nextRead = clock() + Math.max(60000, Math.min(300000, Number(data.refreshMs) || 60000));
    } catch (cause) {
      if (disposed || !identity || generation !== revision) return;
      if ([401, 403].includes(cause.statusCode)) { snapshot = null; cards.replaceChildren(); }
      error = snapshot ? 'Update delayed · showing saved payouts' : 'Rewards temporarily unavailable';
      nextRead = clock() + Math.max(60000, Math.min(300000, Number(cause.retryAfterMs) || 60000));
    } finally { if (generation === revision) { loading = false; render(); } }
  }
  function destroy() { disposed = true; clear(); }
  return { setSession, load, clear, destroy };
}
