import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireProcessLock } from '../src/process-lock.mjs';
import { createServer } from 'node:http';
import { config as runConfig } from './fixtures.mjs';

test('Android process lock refuses concurrent engines and releases only its own lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'launchpad-lock-'));
  try {
    const path = join(root, 'process.lock');
    const release = await acquireProcessLock(path, 0);
    await assert.rejects(acquireProcessLock(path, 0), /previous engine/);
    await release(); await assert.rejects(access(path));
    await writeFile(path, JSON.stringify({ pid: 2147483647, nonce: 'dead-child' }));
    const recovered = await acquireProcessLock(path, 0);
    await writeFile(path, JSON.stringify({ pid: process.pid, nonce: 'replacement' }));
    await recovered(); assert.match(await readFile(path, 'utf8'), /replacement/);
    await writeFile(path, JSON.stringify({ pid: process.pid, start: 'a-previous-process', nonce: 'reused-pid' }));
    let currentStart=null;
    try{const stat=await readFile(`/proc/${process.pid}/stat`,'utf8');currentStart=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];}catch{}
    if(currentStart){
      const reused = await acquireProcessLock(path, 0);
      await reused(); await assert.rejects(access(path));
    }else{
      // Restricted runtimes and non-procfs hosts cannot prove PID reuse. The
      // production lock must remain held rather than guessing it is stale.
      await assert.rejects(acquireProcessLock(path, 0), /previous engine/);
      assert.match(await readFile(path,'utf8'), /reused-pid/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('embedded engine starts stopped, protects localhost, drains on parent-pipe close and restarts', { timeout: 25000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'launchpad-android-'));
  const config = { accessToken: 'b'.repeat(64), controlToken: 'c'.repeat(64), dataRoot: join(root, 'data'), readyFile: join(root, 'ready.json') };
  const file = join(root, 'bootstrap.json'); await writeFile(file, JSON.stringify(config));
  const allocation = { id: 'persisted-allocation', wallet: '11111111111111111111111111111111', kind: 'market', tokens: { So11111111111111111111111111111111111111112: '1000000000' }, decimals: { So11111111111111111111111111111111111111112: 9 } };
  await mkdir(config.dataRoot);
  await writeFile(join(config.dataRoot, 'portfolio-live.json'), JSON.stringify({ version: 1, lots: [allocation], pending: [], events: [], seen: [], trades: 0 }));
  let child;
  try {
    for (let run = 0; run < 2; run++) {
      await rm(config.readyFile, { force: true });
      child = spawn(process.execPath, [process.env.LAUNCHPAD_ANDROID_ENTRY || 'src/android.mjs', file], { stdio: ['pipe', 'ignore', 'pipe'] });
      let errors = ''; child.stderr.on('data', bytes => { errors += bytes; });
      let ready;
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw Error('Embedded child exited: ' + errors);
        try { ready = JSON.parse(await readFile(config.readyFile, 'utf8')); break; } catch { await delay(50); }
      }
      assert.ok(ready, 'embedded service must become ready');
      const base = `http://127.0.0.1:${ready.port}`;
      assert.equal((await fetch(base + '/api/session')).status, 403);
      const headers = { 'x-app-token': config.accessToken, 'x-control-token': config.controlToken };
      assert.equal((await (await fetch(base + '/api/session', { headers })).json()).portfolio, true);
      const portfolio = await (await fetch(base + '/api/portfolio/status?mode=live', { headers })).json();
      assert.equal(portfolio.state, 'stopped'); assert.equal(portfolio.mode, 'live'); assert.deepEqual(portfolio.pending, []);
      assert.equal(portfolio.positions[0].id, allocation.id); assert.equal(portfolio.positions[0].balances[0].amount, '1');
      assert.deepEqual(await (await fetch(base + '/api/runtime/status', { headers })).json(), { state: 'stopped', mode: 'live', kind: 'copy', streamConnected: false });
      const status = await (await fetch(base + '/api/status', { headers })).json();
      assert.equal(status.state, 'stopped'); assert.equal(status.mode, 'live'); assert.equal(status.metrics.submitted, 0);
      // Exercise a real fetch failure inside the packaged engine, including its
      // dependency error formatting. A failed start must leave controls usable.
      const unused = createServer(); await new Promise(r => unused.listen(0, '127.0.0.1', r));
      const port = unused.address().port; await new Promise(r => unused.close(r));
      const request = { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(runConfig({ mode: 'live', rpcUrl: `http://127.0.0.1:${port}`, streamMode: 'logs' })) };
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(base + '/api/start', request), failed = await response.json();
        assert.equal(response.status, 400); assert.equal(failed.status.state, 'stopped');
        assert.match(failed.status.startupError, /ECONNREFUSED/); assert.equal(failed.status.metrics.submitted, 0);
        const stopped = await (await fetch(base + '/api/stop', { ...request, body: '{}' })).json();
        assert.equal(stopped.state, 'stopped');
      }
      for (const kind of ['market', 'liquidity']) {
        const config = runConfig({ mode: 'live', rpcUrl: `http://127.0.0.1:${port}`, streamMode: 'logs' });
        config.leads = '';
        config.strategy = { baseMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', budgetSol: '1' };
        const response = await fetch(base + '/api/portfolio/start', { ...request, body: JSON.stringify({ kind, config }) });
        const failed = await response.json();
        assert.equal(response.status, 400); assert.equal(failed.status.state, 'stopped');
        assert.match(failed.status.startupError, /ECONNREFUSED/);
        const stopped = await (await fetch(base + '/api/runtime/stop', { ...request, body: '{}' })).json();
        assert.equal(stopped.state, 'stopped');
      }
      const exited = once(child, 'exit'); child.stdin.end();
      assert.equal((await exited)[0], 0);
      assert.equal(JSON.parse(await readFile(join(config.dataRoot, 'live.json'), 'utf8')).pending.length, 0);
      for (const name of ['portfolio-live.json', 'portfolio-paper.json']) assert.deepEqual(JSON.parse(await readFile(join(config.dataRoot, name), 'utf8')).pending, []);
      await assert.rejects(access(join(config.dataRoot, 'process.lock')));
    }
  } finally { if (child?.exitCode === null) child.kill(); await rm(root, { recursive: true, force: true }); }
});
