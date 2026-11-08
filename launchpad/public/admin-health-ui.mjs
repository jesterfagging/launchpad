const routeLabels = [
  ['liveness', 'Server liveness'], ['readiness', 'Account storage readiness'], ['session', 'Session checks'],
  ['walletChallenge', 'Wallet sign-in challenge'], ['walletVerify', 'Wallet sign-in verification'],
  ['passwordLogin', 'Password sign-in'], ['passwordRegister', 'Password registration'],
  ['raydiumEstimate', 'Raydium estimate'], ['raydiumPrepare', 'Raydium launch review'], ['raydiumCreate', 'Raydium launch creation'],
  ['pumpStatus', 'Pump status and pairs'], ['pumpPrepare', 'Pump preparation'], ['pumpSubmit', 'Pump submission'], ['pumpReconcile', 'Pump confirmation'],
  ['meteoraStatus', 'Meteora status and pairs'], ['meteoraPrepare', 'Meteora preparation'], ['meteoraSubmit', 'Meteora submission'], ['meteoraReconcile', 'Meteora confirmation'],
  ['dammPumpStatus', 'PumpSwap status and pairs'], ['dammPumpPrepare', 'PumpSwap preparation'], ['dammPumpSubmit', 'PumpSwap submission'], ['dammPumpReconcile', 'PumpSwap confirmation'],
];
// Service states reported by src/host-health.mjs and src/account-app.mjs.
const SERVICE_STATES = { not_started: 'Not started', starting: 'Starting', running: 'Running', degraded: 'Degraded', unavailable: 'Unavailable' };
const serviceState = value => typeof value === 'string' && value ? SERVICE_STATES[value] || value[0].toUpperCase() + value.slice(1).replace(/_/g, ' ') : 'Unknown';
const FRESH_MS = 30000;
// v71.37: what the failed-request count is made of. Fixed labels from src/host-health.mjs; anything unknown is shown as its key.
const STATUS_TEXT = { 0: 'client disconnected before the reply', 400: '400 bad request', 401: '401 sign-in needed', 403: '403 refused', 404: '404 not found', 405: '405 method', 408: '408 timed out', 409: '409 conflict', 410: '410 gone', 413: '413 too large', 415: '415 media type', 422: '422 unprocessable', 429: '429 rate limited', 500: '500 server error', 502: '502 bad gateway', 503: '503 unavailable', 504: '504 upstream timeout', other4xx: 'other 4xx', other5xx: 'other 5xx' };
const AREA_TEXT = { pages: 'pages and files', explore: 'coin data (explore)', launchpad: 'launch and rewards', agents: 'agents', account: 'session and sign-in', admin: 'administration', probes: 'liveness probes', otherApi: 'other API', other: 'unlabelled' };
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
function failureLines(failures) {
  const byStatus = Object.entries(failures?.byStatus || {}).map(([key, value]) => [key, count(value)]).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1]);
  const byArea = Object.entries(failures?.byArea || {}).map(([key, row]) => [key, count(row?.failed), count(row?.completed)]).filter(([, failed]) => failed > 0).sort((a, b) => b[1] - a[1]);
  const lines = [];
  if (byStatus.length) lines.push('Failed by status: ' + byStatus.map(([key, value]) => `${value.toLocaleString()} × ${STATUS_TEXT[key] || String(key).slice(0, 12)}`).join(' · ') + '.');
  if (byArea.length) lines.push('Failed by area: ' + byArea.map(([key, failed, completed]) => `${AREA_TEXT[key] || String(key).slice(0, 16)} ${failed.toLocaleString()} of ${completed.toLocaleString()}`).join(' · ') + '.');
  return lines;
}

export function createAdminHealth({ document, api, getAccount, isActive = () => true, setTimer = setInterval, clearTimer = clearInterval, clock = Date.now }) {
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const element = el('section', undefined, 'admin-card'); element.id = 'admin-health';
  const heading = el('div', undefined, 'admin-card-heading'), title = el('div'), refresh = el('button', 'Refresh', 'text-button'); refresh.type = 'button';
  title.append(el('p', 'PLATFORM / HEALTH', 'eyebrow'), el('h2', 'Platform health'), el('p', 'Server load and data availability since the last restart.'));
  heading.append(title, refresh);
  const summary = el('div', undefined, 'admin-overview'), data = el('div'), note = el('p', '', 'admin-muted');
  element.append(heading, summary, data, note);
  let busy = false, closed = false, revision = 0, loadedAt = 0;
  const permitted = () => !closed && getAccount()?.role === 'admin';
  function clear() { revision++; busy = false; loadedAt = 0; refresh.disabled = false; summary.replaceChildren(); data.replaceChildren(); note.textContent = ''; }
  async function load() {
    if (!permitted()) { clear(); return; }
    if (!isActive() || document.hidden || busy) return; busy = true; refresh.disabled = true; const generation = revision;
    try {
      const value = await api('/api/admin/health');
      if (!permitted() || generation !== revision) return;
      const metrics = [['Active requests', value.requests.active], ['Failed requests', value.requests.failed ?? 0], ['Recent response p95', `${value.requests.p95Ms} ms`], ['Event loop p95', `${value.eventLoop?.p95Ms ?? 0} ms`], ['Event loop maximum', `${value.eventLoop?.maxMs ?? 0} ms`], ['Process memory', `${Math.round(value.memory.rssBytes / 1048576)} MiB`], ['Trade recovery', serviceState(value.services?.tradeRecovery)]];
      summary.replaceChildren(...metrics.map(([label, value]) => { const item = el('div'); item.append(el('span', label), el('strong', String(value))); return item; }));
      data.replaceChildren();
      for (const line of failureLines(value.failures)) data.append(el('p', line, 'admin-muted admin-health-failures'));
      for (const [kind, label] of [['market', 'Market snapshots'], ['holders', 'Holder lists'], ['trades', 'Trade history']]) {
        const row = value.data?.[kind] || { responses: 0, unavailable: 0, stale: 0 };
        data.append(el('p', `${label}: ${row.responses.toLocaleString()} responses · ${row.unavailable.toLocaleString()} unavailable · ${row.stale.toLocaleString()} marked stale`, 'admin-muted'));
      }
      const observedRoutes = routeLabels.filter(([key]) => value.routes?.[key]);
      if (observedRoutes.length) {
        const wrap = el('div', undefined, 'admin-revenue-table-wrap'), table = el('table', undefined, 'admin-revenue-table'), head = el('thead'), headers = el('tr'), body = el('tbody');
        for (const [index, label] of ['Request group', 'Requests', 'Failed', '429 limits', '503 unavailable', 'Response p95'].entries()) headers.append(el('th', label, index ? 'num' : undefined));
        head.append(headers); table.append(head, body);
        for (const [key, label] of observedRoutes) {
          const row = value.routes[key], line = el('tr');
          for (const [index, cell] of [label, row.completed, row.failed, row.rateLimited, row.unavailable, `${row.p95Ms} ms`].entries()) line.append(el('td', String(cell), index ? 'num' : undefined));
          body.append(line);
        }
        wrap.append(table); data.append(el('h3', 'Sign-in and launch requests'), wrap);
      }
      const cap = value.capacity;
      loadedAt = clock();
      note.textContent = `Configured capacity: ${cap.rpcRequestsPerSecond} RPC requests/s · ${cap.sendRequestsPerSecond} submissions/s · ${cap.jupiterRequestsPerSecond} routing requests/s. These are server settings, not a measurement of your provider plan. Counts and event loop delay cover this server process since restart. Response p95 uses the latest 1,024 responses overall and 256 per request group. Failed requests include client disconnects (a 404 is usually a wrong link or a bot probing paths, a disconnect a reader that gave up); 429 and 503 counts are included in failures. Unavailable and stale counts can overlap. Updated ${new Date().toLocaleTimeString()}.`;
    } catch (error) { if (permitted() && generation === revision) note.textContent = error.message || 'Health data is temporarily unavailable.'; }
    finally { if (generation === revision) { busy = false; refresh.disabled = false; } }
  }
  // Opening the page again reuses a reading younger than the 30-second refresh; the timer keeps it current.
  function show() { if (permitted() && loadedAt && clock() - loadedAt < FRESH_MS) return; return load(); }
  refresh.onclick = load;
  const timer = setTimer(() => { if (isActive() && !document.hidden) void load(); }, 30000);
  return { element, load, show, clear, destroy() { closed = true; clear(); clearTimer(timer); } };
}
