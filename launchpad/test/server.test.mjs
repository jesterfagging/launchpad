import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

test('native status and Stop cover the active portfolio strategy and retain access checks', async () => {
  const engine = { state: 'stopped', status() { return { state: this.state, mode: 'paper' }; }, stop() { this.state = 'stopped'; return this.status(); } };
  const portfolio = { state: 'running', kind: 'liquidity', status() { return { state: this.state, mode: 'live', kind: this.kind }; }, stop() { if (this.state !== 'stopped') this.state = 'stopping'; return this.status(); } };
  const headers = { 'x-app-token': 'b'.repeat(64), 'x-control-token': 'a'.repeat(64), 'content-type': 'application/json' };
  const server = createApp(engine, headers['x-control-token'], { accessToken: headers['x-app-token'], portfolio });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/runtime/status')).status, 403);
    assert.equal((await fetch(base + '/api/runtime/stop', { method: 'POST', headers: { 'x-app-token': headers['x-app-token'] }, body: '{"mode":"live"}' })).status, 403);
    for (const kind of ['liquidity', 'market']) {
      portfolio.kind = kind; portfolio.state = 'running';
      assert.deepEqual(await (await fetch(base + '/api/runtime/status', { headers })).json(), { state: 'running', mode: 'live', kind, streamConnected: false });
      const stop = await (await fetch(base + '/api/runtime/stop', { method: 'POST', headers, body: '{"mode":"live"}' })).json();
      assert.equal(stop.state, 'stopping'); assert.equal(stop.kind, kind);
    }
    portfolio.state = 'stopped'; engine.state = 'running';
    assert.equal((await (await fetch(base + '/api/runtime/status', { headers })).json()).kind, 'copy');
    assert.equal((await (await fetch(base + '/api/runtime/stop', { method: 'POST', headers, body: '{"mode":"live"}' })).json()).state, 'stopped');
    assert.equal(engine.state, 'stopped');
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('authenticated UI updates push changed positions immediately and release listeners on disconnect',async()=>{
  const engine=new EventEmitter();let positions=[{id:'lot',remaining:'100'}];
  engine.status=()=>({state:'running',positions});
  const server=createApp(engine,'a'.repeat(64));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`,abort=new AbortController();
  try {
    assert.equal((await fetch(base+'/api/events')).status,403);
    const response=await fetch(base+'/api/events',{headers:{'x-control-token':'a'.repeat(64)},signal:abort.signal});
    assert.match(response.headers.get('content-type'),/text\/event-stream/);
    const reader=response.body.getReader(),decode=b=>JSON.parse(new TextDecoder().decode(b).trim().slice(6));
    assert.equal(decode((await reader.read()).value).positions.length,1);
    positions=[];engine.emit('change');
    assert.deepEqual(decode((await reader.read()).value).positions,[]);
    abort.abort();await reader.cancel().catch(()=>{});
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
  for (let i=0;i<50 && engine.listenerCount('change');i++) await delay(5);
  assert.equal(engine.listenerCount('change'),0);
});

test('a failed Start returns the stopped status immediately and the Stop endpoint remains usable', async () => {
  const status = {state:'stopped',startupError:'RPC getGenesisHash: DNS lookup failed. (ENOTFOUND)'};
  const engine = {status:()=>status,start:async()=>{throw Error(status.startupError);},stop:()=>status};
  const server=createApp(engine,'a'.repeat(64));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`, request={method:'POST',headers:{'x-control-token':'a'.repeat(64),'content-type':'application/json'},body:'{"mode":"live"}'};
  try {
    const response=await fetch(base+'/api/start',request);assert.equal(response.status,400);
    const body=await response.json();assert.deepEqual(body.status,status);
    assert.deepEqual(await (await fetch(base+'/api/stop',request)).json(),status);
  } finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('local server rejects unauthenticated controls, cross-origin posts and rebinding hosts',async()=>{
  let starts=0;const engine={status:()=>({state:'stopped'}),start:async()=>{starts++;return{state:'running'};},stop:()=>({state:'stopped'})};
  const server=createApp(engine,'a'.repeat(64));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    assert.equal((await fetch(base+'/')).status,200);
    assert.equal((await fetch(base+'/api/status')).status,403);
    const rebindingStatus=await new Promise((resolve,reject)=>{const req=http.get(base+'/api/session',{headers:{Host:'attacker.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
    assert.equal(rebindingStatus,403);
    const token=(await (await fetch(base+'/api/session')).json()).token;
    const headers={'x-control-token':token,'content-type':'application/json'};
    assert.equal((await fetch(base+'/api/start',{method:'POST',headers:{...headers,origin:'https://attacker.example'},body:'{"mode":"live"}'})).status,403);
    assert.equal((await fetch(base+'/api/start',{method:'POST',headers:{...headers,origin:base},body:'{"mode":"live"}'})).status,200);
    assert.equal(starts,1);assert.equal((await fetch(base+'/data/live.json')).status,404);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});

test('Android session, static UI and controls require the private app capability', async () => {
  let starts = 0;
  const engine = { status: () => ({ state: 'stopped' }), start: async () => { starts++; return { state: 'running' }; }, stop: () => ({ state: 'stopped' }) };
  const access = 'b'.repeat(64), control = 'a'.repeat(64);
  const server = createApp(engine, control, { accessToken: access });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/', '/app.js', '/api/session', '/api/status']) assert.equal((await fetch(base + path)).status, 403);
    assert.equal((await fetch(base + '/api/session', { headers: { 'x-app-token': 'x'.repeat(64) } })).status, 403);
    const cookie = { cookie: `unrelated=1; launchpad-access=${access}; second=2` };
    assert.deepEqual(await (await fetch(base + '/api/session', { headers: cookie })).json(), { token: control });
    assert.equal((await fetch(base + '/', { headers: cookie })).status, 200);
    assert.equal((await fetch(base + '/api/status', { headers: cookie })).status, 403);
    assert.equal((await fetch(base + '/api/status', { headers: { 'x-app-token': access, 'x-control-token': control } })).status, 200);
    const request = { method: 'POST', body: '{"mode":"live"}', headers: { ...cookie, 'content-type': 'application/json', 'x-control-token': control } };
    assert.equal((await fetch(base + '/api/start', request)).status, 200);
    assert.equal(starts, 1);
    assert.equal((await fetch(base + '/api/start', { ...request, headers: { ...request.headers, origin: 'https://untrusted.example' } })).status, 403);
    assert.equal(starts, 1);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});

test('local and Android API refuse stale Paper execution before calling an engine', async t => {
  let calls = 0;
  const engine = { state: 'stopped', start: async () => calls++, manualTrade: async () => calls++ };
  const portfolio = { state: 'stopped', start: async () => calls++, withdraw: async () => calls++ };
  const server = createApp(engine, 'live-only-test', { portfolio });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const mode of ['paper', undefined]) {
    const config = { mode, wallets: [] };
    for (const [path, body] of [
      ['/api/start', config], ['/api/manual-trade', { config }], ['/api/wallets', config],
      ...['market', 'liquidity'].map(kind => ['/api/portfolio/start', { config, kind }]),
      ['/api/portfolio/withdraw', { config }],
    ]) {
      const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-control-token': 'live-only-test' }, body: JSON.stringify(body) });
      assert.equal(response.status, 400, path); assert.match((await response.json()).error, /Paper trading has been removed/);
    }
  }
  assert.equal(calls, 0);
});

test('manual fallback API retains local authorization and refuses selected allocated wallets', async () => {
  const wallet = 'selected-wallet'; let calls = 0;
  const engine = { state: 'stopped', status: () => ({ state: 'stopped', mode: 'live' }), async manualTrade(config, trade) { calls++; return { state: 'stopped', manualResult: { id: trade.id } }; } };
  const portfolio = { state: 'stopped', ledgers: { live: { data: { lots: [{ wallet }], pending: [] } } } };
  const server = createApp(engine, 'a'.repeat(64), { portfolio }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`, request = { method: 'POST', headers: { 'content-type': 'application/json', 'x-control-token': 'a'.repeat(64) }, body: JSON.stringify({ config: { mode: 'live' }, trade: { id: 'manual-local', wallets: [wallet] } }) };
  try {
    assert.equal((await fetch(base + '/api/manual-trade', { ...request, headers: { 'content-type': 'application/json' } })).status, 403);
    let response = await fetch(base + '/api/manual-trade', request); assert.equal(response.status, 400); assert.match((await response.json()).error, /portfolio allocations/); assert.equal(calls, 0);
    portfolio.ledgers.live.data.lots = []; portfolio.ledgers.live.data.pending = [{ wallet }];
    assert.equal((await fetch(base + '/api/manual-trade', request)).status, 400); assert.equal(calls, 0);
    portfolio.ledgers.live.data.pending = [];
    response = await fetch(base + '/api/manual-trade', request); assert.equal(response.status, 200); assert.equal((await response.json()).manualResult.id, 'manual-local'); assert.equal(calls, 1);
    portfolio.state = 'running'; assert.equal((await fetch(base + '/api/manual-trade', request)).status, 400); assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
