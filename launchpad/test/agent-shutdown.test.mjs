// Shutdown must never wait on the network or on a stuck worker: a scheduler
// pass in flight is abandoned after a short grace period and a running job
// is cancelled, so systemd's stop
// completes even when an RPC or launch-book read hangs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentService } from '../src/agent/service.mjs';
import { AgentRunner } from '../src/agent/runner.mjs';
import { ModelRegistry } from '../src/agent/openrouter.mjs';
import { AGENT_RATE_CARD_V1 } from '../public/agent-catalog.mjs';

const MODEL = 'openai/gpt-6-luna';
const CATALOG = [{ id: MODEL, name: 'GPT-6 Luna', pricing: { prompt: '0.0000001', completion: '0.0000005', request: '0' }, context_length: 1050000, top_provider: { max_completion_tokens: 128000 }, supported_parameters: ['tools'] }];
const admin = { id: 'acct-1', username: 'owner', role: 'admin', mfaEnabled: true, banned: false, mainWallet: null };

async function service({ book }) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-shutdown-'));
  const accounts = { dir, hostStore: { read: async () => null, write: async () => {} }, list: async () => [admin], get: async id => id === admin.id ? admin : null };
  const config = { enabled: true, dryRun: false, dbPath: join(dir, 'agents.sqlite'), backupDir: '', openrouterKey: 'k', models: [MODEL], defaultModel: MODEL, browserbaseKey: '', browserbaseProject: '', browserbaseRegion: '', operatorWallet: '', globalDailyUsd: 10000000n, modelConcurrency: 2, browserConcurrency: 1, domainAllowlist: [], rateCard: AGENT_RATE_CARD_V1, workerPath: '' };
  const registry = new ModelRegistry({ allowlist: [MODEL], catalog: CATALOG, fetcher: async () => ({ ok: true, json: async () => ({ data: CATALOG }) }) });
  return new AgentService({ accounts, launchpad: { book }, discovery: null, chainFactory: async () => { throw Error('no rpc'); }, config, registry, worker: { run: () => new Promise(() => {}), cancel() {}, async close() { this.closed = true; }, status: () => ({ kind: 'stuck', ready: true }) } });
}

// The grace timers are unref'd (a stuck shutdown must never keep the process alive), so the tests hold the loop open themselves.
const keepAlive = () => { const t = setInterval(() => {}, 1000); return () => clearInterval(t); };

test('close() returns within the grace period while a pass is stuck on a launch-book read', async () => {
  const release = keepAlive(); let reads = 0;
  const svc = await service({ book: async () => { reads++; return new Promise(() => {}); } });
  await svc.ensure();
  const pass = svc.kick(); await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(reads, 1, 'the pass is waiting on the book');
  const started = Date.now(); await svc.close(); const elapsed = Date.now() - started;
  assert.ok(elapsed >= 4500 && elapsed < 9000, `close took ${elapsed} ms`);
  assert.equal(svc.closed, true);
  await Promise.race([pass, new Promise(resolve => setTimeout(resolve, 10))]); release();
});

test('a healthy pass lets close() finish immediately and the next kick is a no-op', async () => {
  const release = keepAlive(); const svc = await service({ book: async () => ({ launches: [] }) });
  await svc.ensure(); await svc.kick();
  const started = Date.now(); await svc.close();
  assert.ok(Date.now() - started < 1000);
  assert.equal(svc.kick(), null); release();
});

test('the runner cancels in-flight jobs, bounds the drain and kills the worker', async () => {
  const release = keepAlive(); const cancelled = []; let killed = false;
  const worker = { run: () => new Promise(() => {}), cancel: id => cancelled.push(id), async close() { killed = true; }, status: () => ({ kind: 'stuck', ready: true }) };
  const runner = new AgentRunner({ service: { config: {}, now: Date.now }, worker });
  runner.active.set('run-1', { promise: new Promise(() => {}), reservedUsd: '20000', agentId: 'a', startedAt: Date.now() });
  const started = Date.now(); await runner.close(); const elapsed = Date.now() - started;
  assert.deepEqual(cancelled, ['run-1']); assert.equal(killed, true);
  assert.ok(elapsed >= 9000 && elapsed < 14000, `runner close took ${elapsed} ms`); release();
});
