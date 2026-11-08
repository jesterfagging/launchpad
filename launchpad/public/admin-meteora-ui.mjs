const BASE = '/api/admin/meteora';
const sol = value => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > 18446744073709551615n) return '—';
  const raw = BigInt(value), fraction = (raw % 1000000000n).toString().padStart(9, '0').replace(/0+$/, '');
  return String(raw / 1000000000n) + (fraction ? '.' + fraction : '') + ' SOL';
};

export function createAdminMeteora({ document, api, getAccount, isActive = () => true }) {
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const element = el('section', undefined, 'admin-card admin-pump-public admin-meteora'); element.id = 'admin-meteora';
  const note = el('p', '', 'help'); note.setAttribute('role', 'status');
  note.id = 'admin-meteora-status';
  const facts = el('dl', undefined, 'pump-operation-facts'), blockers = el('ul', undefined, 'help');
  facts.id = 'admin-meteora-facts'; blockers.id = 'admin-meteora-blockers';
  const actions = el('div', undefined, 'admin-inline-actions');
  const setup = el('button', 'Set up Meteora', 'small-button'), enable = el('button', 'Open Meteora launches', 'small-button'), pause = el('button', 'Pause new launches', 'small-button'), refresh = el('button', 'Refresh', 'text-button'), copy = el('button', 'Copy gas wallet', 'text-button');
  [setup, enable, pause, refresh, copy].forEach((button, index) => { button.id = ['admin-meteora-setup','admin-meteora-enable','admin-meteora-pause','admin-meteora-refresh','admin-meteora-copy'][index]; });
  for (const button of [setup, enable, pause, refresh, copy]) { button.type = 'button'; actions.append(button); }
  // Opening or pausing public launches takes effect at once for every creator, so it asks for a confirming click.
  const review = el('div', undefined, 'admin-pump-deployment-review'), reviewText = el('p'), confirm = el('button', '', 'small-button'), cancel = el('button', 'Cancel', 'text-button');
  review.id = 'admin-meteora-review'; confirm.id = 'admin-meteora-confirm'; cancel.id = 'admin-meteora-cancel'; confirm.type = cancel.type = 'button'; review.hidden = true; review.setAttribute('role', 'group'); review.setAttribute('aria-label', 'Confirm the Meteora launch change'); review.append(reviewText, confirm, cancel);
  element.append(el('p', 'METEORA / NATIVE LAUNCHES', 'eyebrow'), el('h2', 'Meteora launches'), el('p', 'Native Meteora DBC bonding pools graduate into DAMM v2 with permanently locked liquidity. No Launchpad graduation fee. Creator fees can be redirected once, or used for holder rewards.', 'help'), facts, blockers, actions, review, note);
  let data = null, busy = false, generation = 0, disposed = false, owner = '', fresh = false, asked = null;
  const identity = () => String(getAccount()?.id || '');
  // The page supplies getAccount only while the server-granted owner capability
  // remains current. Do not infer ownership from an arbitrary username/wallet.
  const permitted = () => { const account = getAccount(); return !disposed && !!identity() && account?.role === 'admin' && account.mfaEnabled === true && !account.banned; };
  const allowed = () => permitted() && isActive() && !document.hidden;
  const current = (version, accountId) => allowed() && version === generation && identity() === accountId;
  const gasAddress = () => { const value = data?.relayerAddress || data?.relayer?.address || (typeof data?.relayer === 'string' ? data.relayer : '') || data?.gasWallet || data?.authority || ''; return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) ? value : ''; };
  const pairCount = () => { const value = data?.pairSummary?.available ?? data?.pairSummary?.ready; return Number.isSafeInteger(value) && value >= 0 ? value : null; };
  const canEnable = () => fresh && data?.configured === true && data?.canEnable === true && data?.pairSummary?.complete === true && pairCount() > 0;
  function render() {
    element.hidden = !allowed() || !owner || owner !== identity();
    facts.replaceChildren();
    if (element.hidden) { asked = null; review.hidden = true; blockers.replaceChildren(); for (const button of [setup,enable,pause,copy]) button.disabled = true; return; }
    const configured = data?.configured === true, enabled = data?.publicEnabled === true || data?.launchesEnabled === true;
    const pairs = data?.pairSummary;
    for (const [label, value] of [
      ['Public launches', data?.publicEnabled === true ? 'Open' : enabled ? 'Enabled; waiting for checks' : 'Closed'],
      ['Setup', configured ? 'Configured' : 'Not configured'],
      ['Graduation fee', '0%'],
      ['Trading fee', '1.88% total: approximately 1.00768% Launchpad, 0.49632% creator or holders, 0.376% Meteora'],
      ['Liquidity', '100% permanently locked; position fees remain claimable'],
      ['Gas wallet', gasAddress() || 'Created during setup'],
      ['Gas balance', sol(data?.relayerBalanceLamports ?? data?.balanceLamports ?? data?.authorityBalanceLamports)],
      ['Minimum gas reserve', sol(data?.minimumBalanceLamports)],
      ['Protocol treasury', data?.treasury || 'Uses the configured Launchpad protocol fee wallet'],
      ...(pairs ? [['Available pairs', pairCount() === null ? '—' : String(pairCount())], ['Pair verification', pairs.complete === true ? 'Full catalogue checked' : 'Checking the full catalogue']] : []),
    ]) { const row = el('div'); row.append(el('dt', label), el('dd', value)); facts.append(row); }
    blockers.replaceChildren(...(Array.isArray(data?.blockers) ? data.blockers : []).filter(value => typeof value === 'string').slice(0,20).map(value => el('li', value.slice(0,500)))); blockers.hidden = !blockers.children.length;
    setup.hidden = configured; enable.hidden = enabled; pause.hidden = !enabled; copy.hidden = !gasAddress();
    for (const button of [setup, enable, pause, refresh, copy]) button.disabled = busy;
    setup.disabled = busy || !fresh || configured; enable.disabled = busy || !canEnable(); pause.disabled = busy || !enabled;
    if (asked && (asked.enabled ? enabled : !enabled)) asked = null;
    review.hidden = !asked; confirm.disabled = cancel.disabled = busy;
    if (asked) { reviewText.textContent = asked.enabled ? 'Open Meteora to new public launches now? Every creator can launch on Meteora as soon as you confirm.' : 'Pause new Meteora launches now? Existing launches keep trading and graduating.'; confirm.textContent = asked.enabled ? 'Confirm: open Meteora launches' : 'Confirm: pause new launches'; }
  }
  async function load() {
    if (!permitted()) { clear(); return; }
    if (owner && owner !== identity()) clear();
    if (!allowed() || busy) return; const version = generation, accountId = identity(); owner = accountId; busy = true; fresh = false; asked = null; render();
    try {
      const next = await api(BASE + '/status');
      if (!current(version, accountId)) return;
      if (!next || typeof next !== 'object' || typeof next.configured !== 'boolean' || typeof next.publicEnabled !== 'boolean') throw Error('Invalid status.');
      data = next; fresh = true; note.textContent = next.publicEnabled ? 'Meteora is open for new launches.' : next.launchesEnabled ? 'Meteora is enabled and waiting for its checks to pass. You can pause new launches below.' : 'Complete the checks above before opening public launches.';
    } catch { if (current(version, accountId)) { fresh = false; note.textContent = 'Meteora status could not be verified. Refresh before opening launches.'; } }
    finally { if (generation === version) { busy = false; if (!permitted() || identity() !== accountId) clear(); else render(); } }
  }
  async function action(path, input) {
    if (!allowed() || owner !== identity() || busy || path === '/setup' && (!fresh || data?.configured) || path === '/configure' && (input.enabled ? !canEnable() : data?.publicEnabled !== true && data?.launchesEnabled !== true)) return;
    const version = generation, accountId = identity(); busy = true; fresh = false; render();
    try { await api(BASE + path, input); if (!current(version, accountId)) return; note.textContent = 'Saved. Checking readiness…'; }
    catch (error) { if (current(version, accountId)) note.textContent = error?.known ? error.message : 'Meteora settings could not be saved. Refresh their current status before trying again.'; return; }
    finally { if (generation === version) { busy = false; if (!permitted() || identity() !== accountId) clear(); else render(); } }
    if (!current(version, accountId)) return;
    await load();
  }
  function ask(enabled) {
    if (!allowed() || owner !== identity() || busy || (enabled ? !canEnable() : data?.publicEnabled !== true && data?.launchesEnabled !== true)) return;
    asked = { enabled }; render(); confirm.focus?.();
  }
  setup.onclick = () => action('/setup', {}); enable.onclick = () => ask(true); pause.onclick = () => ask(false); refresh.onclick = load;
  confirm.onclick = () => { if (!asked) return; const { enabled } = asked; asked = null; return action('/configure', { enabled }); };
  cancel.onclick = () => { const was = asked; asked = null; render(); (was?.enabled ? enable : pause).focus?.(); };
  copy.onclick = async () => { if (!allowed() || busy || owner !== identity() || !gasAddress()) return; const version = generation, accountId = identity(); try { await document.defaultView.navigator.clipboard.writeText(gasAddress()); if (current(version, accountId)) note.textContent = 'Gas wallet address copied.'; } catch { if (current(version, accountId)) note.textContent = 'Select and copy the gas wallet address shown above.'; } };
  function clear() { generation++; data = null; busy = false; fresh = false; owner = ''; asked = null; review.hidden = true; note.textContent = ''; facts.replaceChildren(); blockers.replaceChildren(); element.hidden = true; for (const button of [setup,enable,pause,copy]) button.disabled = true; }
  clear();
  return { element, load, clear, pause() { generation++; busy = false; fresh = false; asked = null; render(); }, destroy() { disposed = true; clear(); element.replaceChildren(); } };
}
