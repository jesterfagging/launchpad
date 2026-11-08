// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
// Used by the worker to drive one remote Browserbase page: navigate, read
// text, follow links, scroll and capture screenshots. Every network request
// the page makes is intercepted and checked against the egress policy; the
// model never supplies scripts (the only evaluated code is the fixed reader
// below), inputs, downloads or dialogs are refused.
import { requestDecision } from './egress.mjs';

const fail = (message, code = 'AGENT_BROWSER') => { throw Object.assign(Error(message), { code }); };
const READER = `(() => {
  const clip = (s, n) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const links = [...document.querySelectorAll('a[href]')].map(a => ({ text: clip(a.textContent, 80), href: a.href })).filter(l => /^https:\\/\\//i.test(l.href) && l.text).slice(0, 200);
  const body = document.body ? document.body.innerText : '';
  return JSON.stringify({ title: clip(document.title, 200), url: location.href, text: (body || '').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').slice(0, 60000), links, height: document.documentElement.scrollHeight, scrollY: window.scrollY, viewport: window.innerHeight });
})()`;

export class CdpClient {
  constructor(url, { timeoutMs = 15000, WebSocketImpl = globalThis.WebSocket } = {}) { this.url = url; this.timeoutMs = timeoutMs; this.WebSocketImpl = WebSocketImpl; this.next = 1; this.pending = new Map(); this.listeners = new Map(); this.closed = false; }
  async connect() {
    if (!this.WebSocketImpl) fail('WebSocket is unavailable in this runtime.');
    const ws = new this.WebSocketImpl(this.url); this.ws = ws;
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('The browser connection timed out.')), this.timeoutMs); ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true }); ws.addEventListener('error', () => { clearTimeout(timer); reject(Error('The browser connection failed.')); }, { once: true }); });
    ws.addEventListener('message', event => this.receive(typeof event.data === 'string' ? event.data : String(event.data)));
    ws.addEventListener('close', () => { this.closed = true; for (const [, item] of this.pending) item.reject(Error('The browser connection closed.')); this.pending.clear(); });
    return this;
  }
  receive(text) {
    let message; try { message = JSON.parse(text); } catch { return; }
    if (message.id && this.pending.has(message.id)) { const item = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(item.timer); if (message.error) item.reject(Object.assign(Error(message.error.message || 'CDP error'), { code: 'AGENT_BROWSER_CDP', cdp: message.error })); else item.resolve(message.result || {}); return; }
    if (message.method) for (const listener of this.listeners.get(message.method) || []) { try { listener(message.params || {}, message.sessionId); } catch { /* Listener failures never break the protocol loop. */ } }
  }
  send(method, params = {}, sessionId = undefined, timeoutMs = this.timeoutMs) {
    if (this.closed || !this.ws) return Promise.reject(Error('The browser connection is closed.'));
    const id = this.next++;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(Error(`${method} timed out.`), { code: 'AGENT_BROWSER_TIMEOUT' })); }, timeoutMs); this.pending.set(id, { resolve, reject, timer }); this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
  }
  on(method, listener) { (this.listeners.get(method) || this.listeners.set(method, []).get(method)).push(listener); }
  close() { this.closed = true; try { this.ws?.close(); } catch { /* Already closed. */ } }
}

/** One isolated page with read-only, policy-filtered navigation. */
export class ReadOnlyPage {
  constructor(client, { allowlist, log = () => {} }) { this.client = client; this.allowlist = allowlist; this.log = log; this.sessionId = null; this.targetId = null; this.blocked = []; this.lastPage = null; this.chunkIndex = 0; }
  async open() {
    const { targetId } = await this.client.send('Target.createTarget', { url: 'about:blank' }); this.targetId = targetId;
    const { sessionId } = await this.client.send('Target.attachToTarget', { targetId, flatten: true }); this.sessionId = sessionId;
    const send = (method, params) => this.client.send(method, params, sessionId);
    await send('Page.enable'); await send('Network.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }).catch(() => {});
    await send('Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    await send('Network.setCookies', { cookies: [] }).catch(() => {});
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    this.client.on('Fetch.requestPaused', (params, sid) => { if (sid !== sessionId) return; this.intercept(params).catch(() => {}); });
    this.client.on('Page.javascriptDialogOpening', (params, sid) => { if (sid === sessionId) send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {}); });
    this.client.on('Target.targetCreated', params => { if (params.targetInfo?.type === 'page' && params.targetInfo.targetId !== targetId && params.targetInfo.openerId === targetId) this.client.send('Target.closeTarget', { targetId: params.targetInfo.targetId }).catch(() => {}); });
    await this.client.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
    return this;
  }
  async intercept({ requestId, request, resourceType }) {
    const decision = requestDecision({ url: request.url, method: request.method, resourceType, isNavigation: resourceType === 'Document' }, { allowlist: this.allowlist });
    if (decision.allow) { await this.client.send('Fetch.continueRequest', { requestId }, this.sessionId); return; }
    this.blocked.push({ url: String(request.url).slice(0, 200), reason: decision.reason }); if (this.blocked.length > 200) this.blocked.shift();
    await this.client.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, this.sessionId);
  }
  async navigate(url, { timeoutMs = 12000 } = {}) {
    const send = (method, params, timeout) => this.client.send(method, params, this.sessionId, timeout);
    const loaded = new Promise(resolve => { const listener = (params, sid) => { if (sid === this.sessionId) resolve(true); }; this.client.on('Page.loadEventFired', listener); setTimeout(() => resolve(false), timeoutMs); });
    const result = await send('Page.navigate', { url, transitionType: 'typed' }, timeoutMs);
    if (result.errorText) fail(`The page could not be loaded (${result.errorText}).`);
    await loaded; await new Promise(resolve => setTimeout(resolve, 400));
    this.chunkIndex = 0; return this.read();
  }
  async read() {
    const { result } = await this.client.send('Runtime.evaluate', { expression: READER, returnByValue: true }, this.sessionId);
    let page; try { page = JSON.parse(result?.value || '{}'); } catch { fail('The page could not be read.'); }
    this.lastPage = page; return page;
  }
  async scroll() { await this.client.send('Runtime.evaluate', { expression: 'window.scrollBy(0, Math.floor(window.innerHeight * 0.9)); window.scrollY', returnByValue: true }, this.sessionId); await new Promise(resolve => setTimeout(resolve, 300)); return this.read(); }
  async screenshot() { const { data } = await this.client.send('Page.captureScreenshot', { format: 'jpeg', quality: 45, captureBeyondViewport: false }, this.sessionId, 8000); return Buffer.from(data, 'base64'); }
  async close() { try { if (this.targetId) await this.client.send('Target.closeTarget', { targetId: this.targetId }); } catch { /* The provider session is released regardless. */ } }
}
