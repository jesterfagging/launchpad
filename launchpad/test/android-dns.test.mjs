import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { installAndroidDns } from '../src/android-dns.mjs';

test('Android resolver carries HTTP and WebSocket traffic, caches concurrent lookups and respects address families', async () => {
  const original = dns.lookup, replies = new PassThrough(); let reads = 0;
  const requests = new Writable({ write(chunk, encoding, done) {
    const { id, host } = JSON.parse(chunk.toString().slice('LAUNCHPAD_DNS '.length));
    assert.equal(host, 'relay-network-test.invalid'); reads++;
    setImmediate(() => replies.write('LAUNCHPAD_DNS ' + JSON.stringify({ id, addresses: [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }] }) + '\n'));
    done();
  } });
  const uninstall = installAndroidDns({ input: replies, output: requests });
  const server = http.createServer((req, res) => res.end('{"ok":true}'));
  const ws = new WebSocketServer({ server }); ws.on('connection', socket => socket.send('stream works'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const host = `relay-network-test.invalid:${server.address().port}`;
  let socket;
  try {
    const lookups = await Promise.all(Array.from({ length: 20 }, () => dns.promises.lookup('relay-network-test.invalid', { all: true })));
    assert.equal(reads, 1); assert.equal(lookups[0].length, 2);
    assert.deepEqual(await dns.promises.lookup('relay-network-test.invalid', { family: 6 }), { address: '::1', family: 6 });
    const httpBody = await new Promise((resolve, reject) => http.get('http://' + host, res => {
      let body = ''; res.on('data', b => body += b); res.on('end', () => resolve(body));
    }).on('error', reject));
    assert.deepEqual(JSON.parse(httpBody), { ok: true });
    assert.deepEqual(await (await fetch('http://' + host, { signal: AbortSignal.timeout(3000) })).json(), { ok: true });
    socket = new WebSocket('ws://' + host);
    const [message] = await once(socket, 'message'); assert.equal(message.toString(), 'stream works');
    assert.equal(reads, 1);
    assert.deepEqual(await dns.promises.lookup('127.0.0.1'), { address: '127.0.0.1', family: 4 });
    assert.equal(reads, 1, 'literal loopback must not need the parent resolver');
  } finally {
    socket?.terminate(); for (const client of ws.clients) client.terminate();
    ws.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
    uninstall(); replies.destroy(); requests.destroy();
  }
  assert.equal(dns.lookup, original);
});

test('Android resolver rejects failed, malformed and missing replies and cannot hang after parent exit', async () => {
  for (const kind of ['failed', 'malformed', 'timeout', 'closed']) {
    const replies = new PassThrough();
    const requests = new Writable({ write(chunk, encoding, done) {
      const { id } = JSON.parse(chunk.toString().slice('LAUNCHPAD_DNS '.length));
      if (kind === 'failed') setImmediate(() => replies.write('LAUNCHPAD_DNS ' + JSON.stringify({ id, error: 'ENOTFOUND' }) + '\n'));
      if (kind === 'malformed') setImmediate(() => replies.write('LAUNCHPAD_DNS ' + JSON.stringify({ id, addresses: [{ address: 'not-an-ip', family: 4 }] }) + '\n'));
      if (kind === 'closed') setImmediate(() => replies.end());
      done();
    } });
    const uninstall = installAndroidDns({ input: replies, output: requests, timeoutMs: 50 });
    try { await assert.rejects(dns.promises.lookup('relay-network-test.invalid'), { code: ['failed', 'malformed'].includes(kind) ? 'ENOTFOUND' : 'EAI_AGAIN' }); }
    finally { uninstall(); replies.destroy(); requests.destroy(); }
  }
});
