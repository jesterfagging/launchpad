import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

// Only these fixed labels may reach the admin response. Never retain request
// paths, query strings, account identities, provider URLs or error messages.
const routeGroups = new Map([
  ['/healthz', 'liveness'], ['/readyz', 'readiness'], ['/api/session', 'session'],
  ['/api/wallet/challenge', 'walletChallenge'], ['/api/wallet/verify', 'walletVerify'],
  ['/api/account/login', 'passwordLogin'], ['/api/account/register', 'passwordRegister'],
  ...['prepare', 'estimate', 'create'].flatMap(action => [
    [`/api/launchpad/${action}`, `raydium${action[0].toUpperCase()}${action.slice(1)}`],
    [`/api/admin/launchpad/${action}`, `raydium${action[0].toUpperCase()}${action.slice(1)}`],
  ]),
  ...['pump', 'meteora'].flatMap(venue => ['status', 'pairs', 'prepare', 'submit', 'reconcile'].map(action =>
    [`/api/launchpad/${venue}/${action}`, `${venue}${action === 'pairs' ? 'Status' : action[0].toUpperCase() + action.slice(1)}`])),
  ...['status', 'pairs', 'prepare', 'submit', 'reconcile'].map(action =>
    [`/api/launchpad/damm-pump/${action}`, `dammPump${action === 'pairs' ? 'Status' : action[0].toUpperCase() + action.slice(1)}`]),
  ['/api/launchpad/meteora/confirm', 'meteoraReconcile'],
]);
// v71.37: the failed-request count gets a breakdown the admin can act on — by status (fixed codes; anything else folds into
// other4xx/other5xx) and by area (a fixed label from the path prefix; the path itself is never kept).
const statusLabels = new Set([0, 400, 401, 403, 404, 405, 408, 409, 410, 413, 415, 422, 429, 500, 502, 503, 504]);
const statusLabel = status => statusLabels.has(status) ? String(status) : status >= 500 ? 'other5xx' : 'other4xx';
export function requestArea(path) {
  if (typeof path !== 'string' || !path) return 'other';
  if (path === '/healthz' || path === '/readyz') return 'probes';
  if (path === '/api/session' || path.startsWith('/api/account/') || path.startsWith('/api/wallet/')) return 'account';
  if (path.startsWith('/api/admin/')) return 'admin';
  if (path.startsWith('/api/explore/')) return 'explore';
  if (path.startsWith('/api/launchpad/agents')) return 'agents';
  if (path.startsWith('/api/launchpad/')) return 'launchpad';
  if (path.startsWith('/api/')) return 'otherApi';
  return 'pages';
}
const latency = durations => {
  const values = [...durations].sort((a, b) => a - b);
  return { sampleSize: values.length, p95Ms: values.length ? Math.round(values[Math.min(values.length - 1, Math.floor(values.length * .95))]) : 0 };
};

// Bounded, credential-free counters. An HTTP 200 with missing market data is
// recorded separately so availability problems do not disappear from monitoring.
export class HostHealth {
  constructor() {
    this.startedAt = Date.now(); this.active = 0; this.total = 0; this.errors = 0;
    this.durations = []; this.cursor = 0; this.data = new Map(); this.routes = new Map(); this.failedByStatus = new Map(); this.areas = new Map();
    this.loop = monitorEventLoopDelay({ resolution: 20 }); this.loop.enable();
  }
  begin() {
    const start = performance.now(); this.active++; let ended = false;
    return (status, path = '') => {
      if (ended) return; ended = true; this.active--; this.total++;
      const failed = status >= 400 || status === 0;
      if (failed) { this.errors++; const label = statusLabel(status); this.failedByStatus.set(label, (this.failedByStatus.get(label) || 0) + 1); }
      const area = requestArea(path), areaRow = this.areas.get(area) || { completed: 0, failed: 0 };
      areaRow.completed++; if (failed) areaRow.failed++; this.areas.set(area, areaRow);
      const elapsed = performance.now() - start;
      this.durations[this.cursor++ % 1024] = elapsed;
      const group = routeGroups.get(path);
      if (group) {
        const row = this.routes.get(group) || { completed: 0, failed: 0, rateLimited: 0, unavailable: 0, durations: [] };
        row.durations[row.completed++ % 256] = elapsed;
        if (status >= 400 || status === 0) row.failed++;
        if (status === 429) row.rateLimited++;
        if (status === 503) row.unavailable++;
        this.routes.set(group, row);
      }
    };
  }
  observe(path, status, value) {
    const kind = ({ '/api/explore/market': 'market', '/api/explore/holders': 'holders', '/api/explore/trades': 'trades' })[path];
    if (!kind || status !== 200) return;
    const row = this.data.get(kind) || { responses: 0, unavailable: 0, stale: 0 };
    row.responses++;
    if (kind === 'market' ? !value?.native : value?.available !== true) row.unavailable++;
    if (value?.stale || value?.native?.stale || value?.coin?.stale) row.stale++;
    this.data.set(kind, row);
  }
  snapshot() {
    return {
      startedAt: this.startedAt, uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      requests: { active: this.active, completed: this.total, failed: this.errors, ...latency(this.durations) },
      routes: Object.fromEntries([...this.routes].map(([key, { durations, ...counts }]) => [key, { ...counts, ...latency(durations) }])),
      failures: { byStatus: Object.fromEntries([...this.failedByStatus].sort((a, b) => b[1] - a[1])), byArea: Object.fromEntries([...this.areas].map(([key, row]) => [key, { ...row }])) },
      eventLoop: { p95Ms: Math.round(this.loop.percentile(95) / 1e6), maxMs: Math.round(this.loop.max / 1e6) },
      memory: { rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed },
      services: { tradeRecovery: this.tradeRecovery || 'not_started' },
      data: Object.fromEntries([...this.data].map(([key, row]) => [key, { ...row }])),
    };
  }
  close() { this.loop.disable(); }
}
