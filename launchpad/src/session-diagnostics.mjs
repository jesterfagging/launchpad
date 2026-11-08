import { journalName } from './run-journals.mjs';
import { secretFields } from './account-secrets.mjs';

export const monitorAllowed = session => !!(session?.account?.role === 'admin' && session.account.mfaEnabled && (session.mfaVerified === true || session.walletVerified === true));
const kinds = ['copy', 'sniper', 'liquidity', 'market'];
const deny = message => { throw Object.assign(Error(message), { statusCode: 400 }); };

// Monitor permissions apply to HTTP responses and SSE, not just the page.
export function publicStatus(value, allowed) {
  if (allowed || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => publicStatus(item, false));
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['metrics', 'rpc', 'timing', 'tradeTiming', 'lastExecution'].includes(key)).map(([key, item]) => [key,
    key === 'stream' && item ? Object.fromEntries(['mode', 'commitment', 'fastPumpLogs'].filter(k => k in item).map(k => [k, item[k]])) : publicStatus(item, false)]));
}

function memoryView(manager, id, chain, kind) {
  const lane = chain === 'solana' ? manager?.runtimes?.get(id)?.lanes?.get(kind) : manager?.runs?.get(id)?.workers?.get(kind);
  if (!lane) return null;
  const raw = lane.status(), view = raw.views?.[['copy', 'sniper'].includes(kind) ? 'copy' : 'portfolioLive'];
  return view ? { ...view, state: raw.state, runId: raw.runId, startupError: raw.startupError, metrics: view.metrics || raw.metrics } : raw;
}

const metricNames = new Set(['signals','detected','submitted','confirmed','fills','skipped','detectionToSendMs','confirmationMs','lastExecution','executions',
  'requests','rateLimits','configuredRequestsPerSecond','effectiveRequestsPerSecond','cooldownMs','queued','head','block','backlogBlocks','rangeBlocks','matchedTransactions','lastScanAt','mode','cursor','backlog','scanMs','logQueries',
  'source','fallbackReason','signalAt','receivedAt','detectedAt','startedAt','acceptedAt','confirmedAt','queueMs','decodeMs','routeMs','approvalMs','prepareMs',
  'checksMs','simulationMs','signatureMs','journalMs','rpcAckMs','receiptMs','leadBlockToReceiptMs','signalAgeMs','elapsedMs','maxSignalAgeMs',
  'notificationToSignalMs','confirmationWaitMs','transactionFetchMs','signalToOrderMs','balanceMs','packMs','relayAckMs','side','wallet','signature','token']);
const eventNames = ['id','at','level','message','wallet','lead','token','mint','quote','signature','operation','side','runId','timing','stream'];
const rowNames = ['id','wallet','label','mint','token','quote','remaining','amount','liquidity','decimals','tokenDecimals','quoteDecimals','tokenSymbol','quoteSymbol','side','state','signature','createdAt','attempted','runId'];
function redactFactory(settings = []) {
  const secrets = new Set();
  for (const saved of settings) {
    for (const key of secretFields) if (typeof saved?.[key] === 'string' && saved[key].length > 3) secrets.add(saved[key]);
    for (const row of saved?.wallets || []) if (row.privateKey) secrets.add(row.privateKey);
    for (const key of secretFields.filter(k => /Url$/.test(k))) if (saved?.[key]) try {
      const u = new URL(saved[key]); for (const value of u.searchParams.values()) if (value.length > 3) secrets.add(value);
      for (const value of u.pathname.split('/')) if (value.length > 12) secrets.add(decodeURIComponent(value));
      if (u.password) secrets.add(decodeURIComponent(u.password));
    } catch {}
  }
  return text => {
    let value = String(text);
    for (const secret of secrets) value = value.split(secret).join('[redacted]');
    return value.replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, '[provider]')
      .replace(/\b(?:api[-_ ]?key|private[-_ ]?key|authorization|secret)\s*[=:]\s*[^\s,;]+/gi, '[credential redacted]').slice(0,6000);
  };
}
function safeObject(value, names, redact, depth = 0) {
  if (depth > 5) return null;
  if (typeof value === 'string') return redact(value);
  if (typeof value === 'bigint') return String(value);
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, 100).map(v => safeObject(v, names, redact, depth + 1));
  if (typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).filter(([k]) => names.has(k)).map(([k,v]) => [k,safeObject(v, names, redact, depth + 1)]));
}

export class SessionDiagnostics {
  constructor(accounts, solana, robinhood) { Object.assign(this, { accounts, solana, robinhood }); this.overviews = new Map(); }
  async overview(id, chain) {
    if (!['solana','robinhood'].includes(chain)) deny('Choose a chain.');
    const key = `${id}:${chain}`, old = this.overviews.get(key);
    if (old && old.until > Date.now()) return old.promise;
    const promise = Promise.all(kinds.map(kind => this.detail(id, chain, kind))).then(sessions => ({ chain, at: Date.now(), sessions }));
    this.overviews.set(key, { until: Date.now() + 5000, promise });
    while (this.overviews.size > 1000) this.overviews.delete(this.overviews.keys().next().value);
    promise.catch(() => { if (this.overviews.get(key)?.promise === promise) this.overviews.delete(key); });
    return promise;
  }
  async list({ search = '', page = 0 } = {}) {
    page = Number(page); if (!Number.isInteger(page) || page < 0) deny('Invalid page.');
    const users = (await this.accounts.list()).filter(a => a.username.toLowerCase().includes(String(search).slice(0, 64).toLowerCase())).sort((a,b) => a.username.localeCompare(b.username));
    return { page, pageSize: 50, total: users.length, users: users.slice(page * 50, (page + 1) * 50).map(a => ({ id: a.id, username: a.username,
      sessions: ['solana','robinhood'].flatMap(chain => kinds.map(kind => { const value = memoryView(this[chain], a.id, chain, kind); return { chain, kind, state: value?.state || 'stopped', runId: value?.runId || null }; })) })) };
  }
  async detail(id, chain, kind) {
    if (!['solana', 'robinhood'].includes(chain) || !kinds.includes(kind)) deny('Choose a chain and tool.');
    const account = await this.accounts.get(id);
    if (!account) throw Object.assign(Error('Account not found.'), { statusCode: 404 });
    const manager = this[chain]; if (!manager) throw Object.assign(Error('This chain is unavailable on this host.'), { statusCode: 503 });
    const store = chain === 'solana' ? this.accounts.storeFor(id) : manager.storeFor(id);
    // Read journals directly. Opening diagnostics must never start an engine,
    // refresh inventory or spend the user's RPC allowance.
    const [ledger, saved] = await Promise.all([store.read(journalName(kind, 'live'), {}), chain === 'solana'
      ? this.accounts.storeFor(id).read('settings', {}) : this.accounts.storeFor(id).read('robinhood-account', {})]);
    const memory = memoryView(manager, id, chain, kind), state = memory?.state || 'stopped';
    const config = chain === 'solana' ? manager.runtimes?.get(id)?.lanes?.get(kind)?.runConfig : null;
    const redact = redactFactory([chain === 'solana' ? saved : saved.settings, config]);
    const events = [...(ledger.events || []), ...(memory?.events || [])];
    const unique = [...new Map(events.map(e => [e.id || `${e.at}:${e.level}:${e.message}`, e])).values()].sort((a,b) => b.at - a.at).slice(0, 2000);
    const safeEvents = unique.map(e => Object.fromEntries(eventNames.filter(k => Object.hasOwn(e,k)).map(k => [k, ['timing','stream'].includes(k) ? safeObject(e[k],metricNames,redact) : safeObject(e[k],new Set(),redact)])));
    return { version: 1, exportedAt: Date.now(), account: { id, username: account.username }, chain, kind, state, runId: memory?.runId || null,
      startupError: memory?.startupError ? redact(memory.startupError) : null,
      metrics: safeObject(memory?.metrics || {},metricNames,redact), rpc: safeObject(memory?.rpc || {},metricNames,redact), stream: safeObject(memory?.stream || {},metricNames,redact),
      positions: (memory?.positions || ledger.lots || []).slice(0, 500).map(row => safeObject(row,new Set(rowNames),redact)),
      pending: (memory?.pending || ledger.pending || []).slice(0, 100).map(row => safeObject(row,new Set(rowNames),redact)),
      events: safeEvents, retention: 'Recent retained activity for this tool, including earlier runs still in its journal. This is not an unlimited history archive.' };
  }
}
