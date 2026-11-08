import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { Providers } from '../src/providers.mjs';
import { validateConfig } from '../src/core.mjs';
import { config, swap } from './fixtures.mjs';

const lead = '3Dben1FZkyKYSxE9TiWe9wbv6eF4F5AqiDPGFczrMTDH';

async function stream(t, overrides = {}, handler) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const requests = [], peers = [];
  server.on('connection', peer => {
    peers.push(peer);
    peer.on('message', data => {
      const req = JSON.parse(data); requests.push(req);
      if (handler) handler(peer, req); else peer.send(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: req.id + 100 }));
    });
  });
  const c = validateConfig(config({ leads: [lead], streamMode: 'logs', fastPumpLogs: true,
    wsUrl: `ws://127.0.0.1:${server.address().port}/?api-key=stream-test-secret`, ...overrides }));
  const events = [], p = new Providers(c, () => {});
  t.after(async () => { p.close(); for (const peer of peers) peer.terminate(); await new Promise(r => server.close(r)); });
  return { p, events, requests, peers, open: () => p.subscribe(e => events.push(e), () => {}) };
}
async function until(predicate) { for (let i=0;i<100;i++) { if (predicate()) return; await delay(5); } assert(predicate(), 'timed out waiting for test event'); }

test('signature subscriptions accept only confirmed terminal messages and clean up', async t => {
  const h = await stream(t); await h.open(); const receipts=[];
  h.p.watchSignature('follower-signature', status => receipts.push(status));
  await until(() => h.requests.some(r => r.method === 'signatureSubscribe'));
  const request=h.requests.find(r=>r.method==='signatureSubscribe');
  assert.equal(request.params[1].commitment,'confirmed'); assert.equal(request.params[1].enableReceivedNotification,false);
  await until(() => h.p.signatureSubscriptions.size === 1);
  const push=value=>h.peers[0].send(JSON.stringify({method:'signatureNotification',params:{subscription:request.id+100,result:{context:{slot:451},value}}}));
  push('receivedSignature'); await delay(15); assert.equal(receipts.length,0);
  push({err:null}); await until(()=>receipts.length===1); push({err:null}); await delay(10);
  assert.deepEqual(receipts,[{confirmationStatus:'confirmed',err:null,slot:451}]);
  assert.equal(h.p.signatureWatches.size,0); assert.equal(h.p.signatureSubscriptions.size,0);
  h.p.watchSignature('cancelled',()=>assert.fail('cancelled receipt'));
  await until(()=>h.p.signatureSubscriptions.size===1); h.p.unwatchSignature('cancelled');
  await until(()=>h.requests.some(r=>r.method==='signatureUnsubscribe')); assert.equal(h.p.signatureWatches.size,0);
});

test('rejected signature subscriptions leave the log stream open', async t => {
  const h=await stream(t,{},(peer,req)=>peer.send(JSON.stringify(req.method==='signatureSubscribe'
    ? {id:req.id,error:{code:-32601,message:'not supported'}} : {id:req.id,result:req.id+100})));
  await h.open(); h.p.watchSignature('not-supported',()=>assert.fail('no confirmation'));
  await until(()=>h.requests.length===3); await delay(10);
  assert.equal(h.p.ws.readyState,1);
});

test('paid LaserStream WebSocket stays independently selectable and delivers full transactions directly', async t => {
  const h = await stream(t, { streamMode:'helius', commitment:'processed' });
  h.p.transaction = async () => { throw Error('unnecessary transaction fetch'); }; await h.open();
  assert.equal(h.requests.length,1); assert.equal(h.requests[0].method,'transactionSubscribe');
  assert.equal(h.requests[0].params[1].commitment,'processed');
  h.peers[0].send(JSON.stringify({ method:'transactionNotification',params:{result:{signature:'full-sig',slot:123,transaction:swap()}} }));
  await until(() => h.events.length === 1); assert(h.events[0].tx); assert.equal(h.p.streamInfo.mode,'helius');
});

test('subscription errors give the reason without disclosing the WebSocket API key', async t => {
  const h = await stream(t, { streamMode:'helius' }, (peer,req) => peer.send(JSON.stringify({ id:req.id,error:{message:'Access denied for api-key=stream-test-secret'} })));
  await assert.rejects(h.open(), e => /Access denied/.test(e.message) && /Developer/.test(e.message) && !e.message.includes('stream-test-secret'));
  assert.equal(h.requests.length,1);
});
