const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const decimal = value => typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? Number(value) : typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : NaN;
const dollars = value => { const n = decimal(value); return Number.isFinite(n) ? USD.format(n) : 'Unavailable'; };

// Convert entered decimals to integer units without floating-point multiplication.
export function parsePumpTestDecimal(value, places, { min = 0n, max = 10000n } = {}) {
  const raw = String(value ?? '').trim();
  if (!new RegExp('^(?:0|[1-9]\\d*)(?:\\.\\d{1,' + places + '})?$').test(raw) || raw.length > 30) return null;
  const [whole, fraction = ''] = raw.split('.');
  const units = BigInt(whole) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, '0'));
  return units < min || units > max ? null : units.toString();
}

export function createAdminPumpTest({ document, api, getAccount, isActive = () => true }) {
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; };
  const element = el('section', undefined, 'admin-card admin-pump-test'); element.id = 'admin-pump-test';
  const heading = el('div', undefined, 'admin-card-heading'), titles = el('div'), refresh = el('button', 'Refresh status', 'text-button'); refresh.type = 'button'; refresh.id = 'admin-pump-test-refresh';
  titles.append(el('p', 'PRIVATE / RESEARCH', 'eyebrow'), el('h2', 'PumpSwap Lab'), el('p', 'Compare private curve presets before any funded launch.'));
  heading.append(titles, refresh);
  const banner = el('p', 'Simulation only • no funds moved', 'admin-pump-test-banner');
  const limits = el('p', 'SOL quote · 100% LP burn target · No creator fees or transfer taxes', 'admin-muted');
  const state = el('p', '', 'admin-muted'); state.id = 'admin-pump-test-status'; state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite');
  const form = el('form', undefined, 'admin-pump-test-form'); form.id = 'admin-pump-test-form'; form.noValidate = true;
  const presetLabel = el('label', 'Launchpad preset', 'admin-pump-test-preset'), preset = el('select'); preset.id = 'admin-pump-test-preset';
  for (const [value, label] of [['standard', 'Standard · $20,000 start → $50,000 graduation'], ['micro-test', 'Private micro test · $100 start → $500 graduation']]) { const option = el('option', label); option.value = value; preset.append(option); }
  presetLabel.append(preset, el('small', 'Both presets are private simulations. This does not change public launch settings.', 'admin-muted')); form.append(presetLabel);
  function field(id, title, description, placeholder, value = '') {
    const label = el('label', title), input = el('input'); input.id = id; input.type = 'text'; input.inputMode = 'decimal'; input.autocomplete = 'off'; input.spellcheck = false; input.required = true; input.maxLength = 24; input.placeholder = placeholder; input.value = value;
    const help = el('small', description, 'admin-muted'); help.id = id + '-help'; input.setAttribute('aria-describedby', help.id); label.append(input, help); form.append(label); return input;
  }
  const graduation = field('admin-pump-test-graduation-fee', 'Graduation fee (%)', 'Fixed at 28.85% of collected quote funds for this private proposal.', '28.85', '28.85'); graduation.readOnly = true;
  const trading = field('admin-pump-test-trade-fee', 'Bonding trading fee (%)', '0–3%. Preview only; does not change live fees.', '1.00', '1.00');
  const price = field('admin-pump-test-sol-usd', 'SOL price (USD)', 'Enter a price assumption. This is not a live price feed.', 'Enter USD per SOL');
  const submit = el('button', 'Preview allocation', 'small-button'); submit.id = 'admin-pump-test-preview'; submit.type = 'submit';
  const actions = el('div', undefined, 'admin-pump-test-actions'); actions.append(submit); form.append(actions);
  const results = el('div', undefined, 'admin-pump-test-results'); results.id = 'admin-pump-test-results'; results.setAttribute('aria-live', 'polite');
  const checks = el('div', undefined, 'admin-pump-test-checks'); checks.id = 'admin-pump-test-checks';
  element.append(heading, banner, limits, form, state, results, checks);
  let disposed = false, revision = 0, busy = false, owner = '', ready = false;
  const identity = () => String(getAccount()?.id || '');
  const permitted = () => { const account = getAccount(); return !disposed && !!identity() && account?.role === 'admin' && account?.mfaEnabled === true && !account?.banned; };
  const current = (generation, accountId) => permitted() && revision === generation && identity() === accountId && isActive();
  const controls = () => { submit.disabled = !ready || busy; refresh.disabled = busy; form.setAttribute('aria-busy', String(busy)); };
  function clear() {
    revision++; busy = false; ready = false; owner = ''; element.hidden = true;
    preset.value = 'standard'; graduation.value = '28.85'; trading.value = '1.00'; price.value = ''; results.replaceChildren(); checks.replaceChildren(); state.textContent = ''; state.classList.remove('negative'); controls();
  }
  function pause() { revision++; busy = false; results.replaceChildren(); state.textContent = ''; controls(); }
  function status(text, negative = false) { state.textContent = text; state.classList.toggle('negative', negative); }
  function renderChecks(data) {
    checks.replaceChildren(el('h3', 'Verification status'));
    const rows = el('dl', undefined, 'admin-pump-test-verification');
    const verification = data?.verification || {};
    const labels = [['model', 'Allocation model'], ['custody', 'Bonding custody'], ['migration', 'Pool migration'], ['lpBurn', 'LP burn'], ['poolCompatibility', 'PumpSwap compatibility'], ['independentAudit', 'Independent audit']];
    const states = { passed: 'Local checks passed', tested: 'Local checks passed', pending: 'Not yet verified', 'not-tested': 'Not yet verified', 'not-implemented': 'Not implemented', blocked: 'Blocked', failed: 'Checks failed' };
    for (const [key, label] of labels) { const value = verification[key]; rows.append(el('dt', label), el('dd', states[typeof value === 'string' ? value : value?.status] || 'Not yet verified')); }
    checks.append(rows, el('p', 'Local checks do not establish production safety or an independent audit.', 'admin-muted'));
    if (Array.isArray(data?.blockers) && data.blockers.length) {
      const list = el('ul', undefined, 'admin-pump-test-blockers');
      for (const item of data.blockers.slice(0, 8)) { const text = typeof item === 'string' ? item : typeof item?.message === 'string' ? item.message : ''; if (text) list.append(el('li', text.slice(0, 500))); }
      if (list.children.length) checks.append(el('h3', 'Before funded testing'), list);
    }
  }
  async function load() {
    if (!permitted()) { clear(); return; }
    if (owner && owner !== identity()) clear();
    if (!isActive() || document.hidden || busy) return;
    busy = true; ready = false; element.hidden = false; owner = identity(); const accountId = owner, generation = revision; controls(); status('Checking the private lab…');
    try {
      const data = await api('/api/admin/pump-test');
      if (!current(generation, accountId)) return;
      renderChecks(data);
      ready = data?.mode === 'local-test' && data?.network === 'none' && data?.fundedLaunchEnabled === false && data?.publicLaunchEnabled === false;
      status(ready ? 'Private model available. Funded launches are disabled.' : 'This lab is unavailable. Funded launches remain disabled.', !ready);
    } catch { if (current(generation, accountId)) { results.replaceChildren(); checks.replaceChildren(); status('The private lab could not load. Refresh status to try again.', true); } }
    finally { if (generation === revision) { if (!permitted() || identity() !== accountId) clear(); else { busy = false; controls(); } } }
  }
  function renderEstimate(data, input) {
    const estimate = data?.estimate || {};
    if (!['quoteCollectedUsd', 'graduationFeeUsd', 'lpQuoteUsd', 'lpTokenValueUsd', 'lpTotalUsd', 'poolOpeningFdvUsd'].every(key => Number.isFinite(decimal(estimate[key])))) throw Error('Incomplete estimate.');
    results.replaceChildren(el('h3', 'Graduation estimate'));
    const grid = el('div', undefined, 'admin-pump-test-metrics');
    for (const [label, key] of [['Quote funds collected', 'quoteCollectedUsd'], ['Graduation revenue', 'graduationFeeUsd'], ['Quote assets in LP', 'lpQuoteUsd'], ['Launched tokens in LP — USD value', 'lpTokenValueUsd'], ['Total LP', 'lpTotalUsd'], ['Pool opening FDV', 'poolOpeningFdvUsd']]) { const card = el('div'); card.append(el('span', label), el('strong', dollars(estimate[key]))); grid.append(card); }
    results.append(grid);
    const targets = input.preset === 'micro-test' ? '$100 start → $500 graduation' : '$20,000 start → $50,000 graduation';
    const assumptions = el('p', `${targets}. Assumptions: graduation fee ${Number(input.graduationFeeBps) / 100}% of quote funds; bonding fee ${Number(input.tradeFeeBps) / 100}%; SOL ${dollars(Number(input.solUsdMicros) / 1e6)}.`, 'admin-muted');
    results.append(assumptions, el('p', 'Estimates exclude network and pool setup costs. The launched-token value uses the modeled opening price. No pool or burn transaction has been submitted.', 'admin-muted'));
  }
  async function preview(event) {
    event?.preventDefault();
    if (!permitted() || (owner && identity() !== owner)) { clear(); return; }
    if (!isActive() || !ready || busy) return;
    results.replaceChildren();
    if (!['standard', 'micro-test'].includes(preset.value)) { status('Choose a private curve preset.', true); return; }
    const graduationFeeBps = parsePumpTestDecimal(graduation.value, 2, { max: 3000n }), tradeFeeBps = parsePumpTestDecimal(trading.value, 2, { max: 300n }), solUsdMicros = parsePumpTestDecimal(price.value, 6, { min: 1n, max: 1000000000000n });
    if (graduationFeeBps !== '2885') { status('The private proposal uses a fixed 28.85% graduation fee. Reload the page to restore the form.', true); return; }
    if (tradeFeeBps === null) { status('Enter a bonding fee from 0% to 3%, using at most two decimal places.', true); return; }
    if (solUsdMicros === null) { status('Enter a positive SOL price up to $1,000,000, using at most six decimal places.', true); return; }
    const input = { preset: preset.value, graduationFeeBps, tradeFeeBps, solUsdMicros }, generation = revision, accountId = owner;
    busy = true; controls(); status('Calculating the local preview…');
    try { const data = await api('/api/admin/pump-test/preview', input); if (current(generation, accountId)) { renderEstimate(data, input); status('Preview complete. No funds moved and no settings changed.'); } }
    catch { if (current(generation, accountId)) status('The preview could not be calculated. Check the inputs or refresh status and try again.', true); }
    finally { if (generation === revision) { if (!permitted() || identity() !== accountId) clear(); else { busy = false; controls(); } } }
  }
  // Editing while a preview is pending invalidates it instead of showing stale assumptions.
  function inputChanged() { results.replaceChildren(); if (busy && !ready) return; revision++; busy = false; status(''); controls(); }
  graduation.oninput = trading.oninput = price.oninput = inputChanged;
  preset.onchange = inputChanged;
  refresh.onclick = load; form.onsubmit = preview;
  function accountUpdated() { if (!permitted() || owner && owner !== identity()) clear(); }
  document.addEventListener('curve-account-updated', accountUpdated);
  clear();
  return { element, load, clear, pause, destroy() { clear(); disposed = true; document.removeEventListener('curve-account-updated', accountUpdated); } };
}
