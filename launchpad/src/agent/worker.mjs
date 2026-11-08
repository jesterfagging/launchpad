// AI Agent worker process. Spawned by the agent core with a minimal
// environment: provider credentials only (no master key, no database, no
// signing material, no application .env). It speaks JSON lines over stdio:
//   core -> worker: {type:'run', job} | {type:'tool-result', id, seq, result|error} | {type:'cancel', id}
//   worker -> core: {type:'ready'} | {type:'tool', id, seq, name, args} | {type:'usage', id, event}
//                   | {type:'event', id, event} | {type:'screenshot', id, url, bytes} | {type:'done', id, fence, result}
// Data tools and financial proposals are executed by the core; the worker
// only relays them. Browser sessions live here and are closed when a run ends.
import { createInterface } from 'node:readline';
import { runAgentLoop, dryRunModel } from './loop.mjs';
import { chatCompletion } from './openrouter.mjs';
import { BrowserSession } from './browserbase.mjs';

export class WorkerHost {
  constructor({ env = process.env, write, fetcher = globalThis.fetch?.bind(globalThis), WebSocketImpl = globalThis.WebSocket } = {}) {
    this.env = env; this.write = write; this.fetcher = fetcher; this.WebSocketImpl = WebSocketImpl; this.runs = new Map(); this.waiting = new Map(); this.seq = 0;
    this.dryRun = env.AGENT_DRY_RUN === '1';
  }
  emit(message) { this.write(JSON.stringify(message) + '\n'); }
  async handle(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'run') return this.start(message.job);
    if (message.type === 'tool-result') { const waiter = this.waiting.get(message.seq); if (waiter) { this.waiting.delete(message.seq); if (message.error) waiter.reject(Object.assign(Error(message.error), { code: message.code || 'AGENT_TOOL' })); else waiter.resolve(message.result); } return; }
    if (message.type === 'cancel') { const run = this.runs.get(message.id); if (run) run.cancel(); }
  }
  callTool(id, name, args) {
    const seq = ++this.seq;
    return new Promise((resolve, reject) => { this.waiting.set(seq, { resolve, reject }); const timer = setTimeout(() => { if (this.waiting.has(seq)) { this.waiting.delete(seq); reject(Object.assign(Error('The platform did not answer the tool call in time.'), { code: 'AGENT_TOOL_TIMEOUT' })); } }, 20000); timer.unref?.(); this.emit({ type: 'tool', id, seq, name, args }); });
  }
  async start(job) {
    if (this.runs.has(job.id)) return;
    const state = { cancelled: false, cancel: () => { state.cancelled = true; state.controller?.abort(); } };
    this.runs.set(job.id, state);
    const apiKey = this.env.OPENROUTER_KEY || '';
    const model = this.dryRun || job.dryRun ? dryRunModel() : async ({ messages, tools, maxTokens, signal }) => chatCompletion({ apiKey, model: job.agent.model, messages, tools, maxTokens, signal, fetcher: this.fetcher });
    const browserFactory = this.dryRun || job.dryRun ? null : (this.env.BROWSERBASE_KEY && this.env.BROWSERBASE_PROJECT ? () => new BrowserSession({ apiKey: this.env.BROWSERBASE_KEY, projectId: this.env.BROWSERBASE_PROJECT, region: this.env.BROWSERBASE_REGION || '', allowlist: job.approvedDomains, fetcher: this.fetcher, WebSocketImpl: this.WebSocketImpl, onScreenshot: async ({ bytes, url }) => this.emit({ type: 'screenshot', id: job.id, url, bytes: bytes.toString('base64') }) }) : null);
    let result;
    try {
      result = await runAgentLoop({ job, model, browserFactory, callTool: (name, args) => this.callTool(job.id, name, args), onUsage: async event => this.emit({ type: 'usage', id: job.id, event }), onEvent: async event => this.emit({ type: 'event', id: job.id, event }) });
    } catch (error) { result = { summary: '', error: String(error?.message || 'Worker failure').slice(0, 300), errorCode: 'worker-error', usage: { spentUsd: '0', disputedUsd: '0', modelCalls: 0, toolCalls: 0, browserActions: 0, browserSeconds: 0, providerRequests: [] }, tools: [] }; }
    finally { this.runs.delete(job.id); }
    this.emit({ type: 'done', id: job.id, fence: job.fence, result });
  }
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const host = new WorkerHost({ write: text => process.stdout.write(text) });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => { let message; try { message = JSON.parse(line); } catch { return; } host.handle(message).catch(error => host.emit({ type: 'log', level: 'error', message: String(error?.message || error).slice(0, 300) })); });
  lines.on('close', () => process.exit(0));
  process.on('uncaughtException', error => { host.emit({ type: 'log', level: 'error', message: String(error?.message || error).slice(0, 300) }); });
  host.emit({ type: 'ready', dryRun: host.dryRun, model: !!process.env.OPENROUTER_KEY, browser: !!(process.env.BROWSERBASE_KEY && process.env.BROWSERBASE_PROJECT) });
}
