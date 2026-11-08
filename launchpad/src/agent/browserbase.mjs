// Browserbase adapter: one ephemeral session per run, released on completion
// or failure, with orphan cleanup for restarts. The connect URL is never
// stored in the database, never logged and never sent to a browser; viewers
// get server-produced screenshots instead ("Live screenshots").
import { CdpClient, ReadOnlyPage } from './cdp.mjs';
import { screenUrl, resolvePublic } from './egress.mjs';
import { AGENT_POLICY_V1 } from '../../public/agent-catalog.mjs';

export const BROWSERBASE_API = 'https://api.browserbase.com/v1';
const fail = (message, code = 'AGENT_BROWSER') => { throw Object.assign(Error(message), { code }); };
const headers = apiKey => ({ 'x-bb-api-key': apiKey, 'content-type': 'application/json' });

export async function createSession({ apiKey, projectId, region = '', timeoutSeconds = 120, fetcher = globalThis.fetch?.bind(globalThis) }) {
  if (!apiKey || !projectId) fail('Browserbase is not configured.', 'AGENT_PROVIDER_MISSING');
  const body = { projectId, timeout: Math.max(60, Math.min(21600, timeoutSeconds | 0)), keepAlive: false, browserSettings: { blockAds: true, viewport: { width: 1280, height: 800 }, solveCaptchas: false, recordSession: false, logSession: false }, ...(region ? { region } : {}) };
  const response = await fetcher(BROWSERBASE_API + '/sessions', { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const text = await response.text(); let json; try { json = JSON.parse(text); } catch { fail(`Browserbase returned a non-JSON response (HTTP ${response.status}).`); }
  if (!response.ok) fail(`Browserbase error ${response.status}: ${String(json.message || json.error || text).slice(0, 200)}`, response.status === 429 ? 'AGENT_PROVIDER_RATE_LIMITED' : 'AGENT_PROVIDER_ERROR');
  if (typeof json.id !== 'string' || typeof json.connectUrl !== 'string' || !/^wss:\/\//.test(json.connectUrl)) fail('Browserbase returned an invalid session.');
  return { id: json.id, connectUrl: json.connectUrl, expiresAt: json.expiresAt || null, status: json.status || 'RUNNING' };
}
export async function releaseSession({ apiKey, id, fetcher = globalThis.fetch?.bind(globalThis) }) {
  const response = await fetcher(`${BROWSERBASE_API}/sessions/${encodeURIComponent(id)}`, { method: 'POST', headers: headers(apiKey), body: JSON.stringify({ projectId: undefined, status: 'REQUEST_RELEASE' }), signal: AbortSignal.timeout(15000) });
  return response.ok || response.status === 404 || response.status === 409;
}
export async function listRunningSessions({ apiKey, fetcher = globalThis.fetch?.bind(globalThis) }) {
  const response = await fetcher(BROWSERBASE_API + '/sessions?status=RUNNING', { headers: headers(apiKey), signal: AbortSignal.timeout(15000) });
  if (!response.ok) fail(`Browserbase session listing returned HTTP ${response.status}.`);
  const body = await response.json(); return (Array.isArray(body) ? body : body?.sessions || []).map(row => ({ id: row.id, createdAt: row.createdAt, status: row.status }));
}

/** A bounded, read-only browsing session for one run. */
export class BrowserSession {
  constructor({ apiKey, projectId, region = '', allowlist, onScreenshot = null, now = Date.now, fetcher, WebSocketImpl, lookup }) {
    Object.assign(this, { apiKey, projectId, region, allowlist, onScreenshot, now, fetcher, WebSocketImpl, lookup });
    this.actions = 0; this.startedAt = 0; this.session = null; this.client = null; this.page = null; this.closed = false; this.timer = null; this.links = [];
  }
  get seconds() { return this.startedAt ? Math.ceil((this.now() - this.startedAt) / 1000) : 0; }
  budget() { if (this.actions >= AGENT_POLICY_V1.run.browserMaxActions) fail('The browser action budget for this run is used up.', 'AGENT_BUDGET'); if (this.startedAt && this.seconds >= AGENT_POLICY_V1.run.browserMaxSeconds) fail('The browser time budget for this run is used up.', 'AGENT_BUDGET'); }
  async start() {
    if (this.session) return;
    this.session = await createSession({ apiKey: this.apiKey, projectId: this.projectId, region: this.region, timeoutSeconds: 120, fetcher: this.fetcher });
    this.startedAt = this.now();
    try {
      this.client = await new CdpClient(this.session.connectUrl, { WebSocketImpl: this.WebSocketImpl }).connect();
      this.page = await new ReadOnlyPage(this.client, { allowlist: this.allowlist }).open();
      if (this.onScreenshot) { const tick = async () => { if (this.closed) return; try { const bytes = await this.page.screenshot(); await this.onScreenshot({ bytes, url: this.page.lastPage?.url || '' }); } catch { /* Screenshots are best effort. */ } }; this.timer = setInterval(tick, AGENT_POLICY_V1.browser.screenshotSeconds * 1000); }
    } catch (error) { await this.close(); throw error; }
    setTimeout(() => { this.close().catch(() => {}); }, AGENT_POLICY_V1.run.browserMaxSeconds * 1000 + 5000).unref?.();
  }
  describe(page, { chunk = 0 } = {}) {
    const text = String(page.text || ''), size = 6000, start = chunk * size, slice = text.slice(start, start + size);
    this.links = (page.links || []).slice(0, 60);
    return { title: page.title, url: page.url, text: slice, more: text.length > start + size, links: this.links.map((link, index) => ({ n: index + 1, text: link.text, host: (() => { try { return new URL(link.href).host; } catch { return ''; } })() })), blocked: this.page?.blocked.length || 0 };
  }
  async open(url) {
    this.budget();
    const screened = screenUrl(url, this.allowlist); if (!screened.ok) fail(screened.reason, 'AGENT_EGRESS');
    const resolved = await resolvePublic(screened.host, { lookup: this.lookup }); if (!resolved.ok) fail(resolved.reason, 'AGENT_EGRESS');
    await this.start(); this.budget(); this.actions++;
    const page = await this.page.navigate(screened.url); this.chunk = 0; return this.describe(page);
  }
  async read() { if (!this.page?.lastPage) fail('Open a page first.'); this.budget(); this.actions++; this.chunk = (this.chunk || 0) + 1; return this.describe(this.page.lastPage, { chunk: this.chunk }); }
  async follow(n) { if (!this.page?.lastPage) fail('Open a page first.'); const link = this.links[n - 1]; if (!link) fail('No such link number in the last listing.'); return this.open(link.href); }
  async scroll() { if (!this.page?.lastPage) fail('Open a page first.'); this.budget(); this.actions++; const page = await this.page.scroll(); this.chunk = 0; return this.describe(page); }
  async close() {
    if (this.closed) return; this.closed = true; clearInterval(this.timer);
    try { await this.page?.close(); } catch { /* Released below. */ }
    this.client?.close();
    if (this.session) { try { await releaseSession({ apiKey: this.apiKey, id: this.session.id, fetcher: this.fetcher }); } catch { /* Orphan cleanup releases it later. */ } }
  }
}
