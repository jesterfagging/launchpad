import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAgentDatabase, AgentDatabase, AGENT_SCHEMA_VERSION } from '../src/agent/db.mjs';
import { AgentLedger, ASSET, EXTERNAL, PLATFORM, agentOwner, splitBps, largestRemainder, integer, tokenAsset } from '../src/agent/ledger.mjs';

const AGENT = 'a'.repeat(24), OTHER = 'b'.repeat(24);
let clock = 1_700_000_000_000; const now = () => clock;
async function open() { return openAgentDatabase(':memory:', { now }); }

test('migrations apply once, in order, and rerun safely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-db-')), path = join(dir, 'agents.sqlite');
  const first = await openAgentDatabase(path, { now });
  assert.equal(first.version(), AGENT_SCHEMA_VERSION);
  assert.deepEqual((await first.migrate()).applied, []);
  first.close();
  const second = await openAgentDatabase(path, { now });
  assert.equal(second.version(), AGENT_SCHEMA_VERSION);
  assert.equal(second.get("SELECT journal_mode FROM pragma_journal_mode").journal_mode, 'wal');
  assert.equal(second.get('PRAGMA synchronous').synchronous, 2);
  const backup = second.backup(join(dir, 'backups'));
  assert.ok((await readdir(join(dir, 'backups'))).length === 1);
  const restored = new AgentDatabase(backup, { now });
  assert.equal(restored.version(), AGENT_SCHEMA_VERSION);
  restored.close(); second.close();
});

test('postings must balance per asset and reject bad amounts', async () => {
  const db = await open(), ledger = new AgentLedger(db, { now });
  const owner = agentOwner(AGENT);
  assert.throws(() => ledger.post({ kind: 'fee-receipt', sourceKey: 'test:x1', entries: [{ owner: EXTERNAL.chain, asset: ASSET.SOL, bucket: 'main', delta: '-100' }, { owner, asset: ASSET.SOL, bucket: 'treasury_available', delta: '90' }] }), /does not balance/);
  assert.throws(() => ledger.post({ kind: 'fee-receipt', sourceKey: 'test:x2', entries: [{ owner: EXTERNAL.chain, asset: ASSET.SOL, bucket: 'main', delta: '-1.5' }, { owner, asset: ASSET.SOL, bucket: 'treasury_available', delta: '1.5' }] }), /integer amount/);
  assert.throws(() => ledger.post({ kind: 'fee-receipt', sourceKey: 'test:x3', entries: [{ owner: EXTERNAL.chain, asset: ASSET.SOL, bucket: 'main', delta: '-1' }, { owner, asset: ASSET.USD, bucket: 'operating_backed', delta: '1' }] }), /does not balance/);
  assert.throws(() => ledger.post({ kind: 'fee-receipt', sourceKey: 'test:x4', entries: [{ owner: EXTERNAL.chain, asset: ASSET.SOL, bucket: 'main', delta: '-1' }, { owner, asset: ASSET.SOL, bucket: 'nonsense', delta: '1' }] }), /Invalid ledger bucket/);
  assert.throws(() => ledger.post({ kind: 'fee-receipt', sourceKey: 'test:x5', entries: [{ owner: EXTERNAL.chain, asset: ASSET.SOL, bucket: 'main', delta: '-1' }, { owner: 'agent:zz', asset: ASSET.SOL, bucket: 'treasury_available', delta: '1' }] }), /Invalid ledger owner/);
  assert.throws(() => integer('99999999999999999999999999'), /out of range/);
  assert.equal(ledger.verify().ok, true);
  db.close();
});

test('fee receipts split 30/70 with integer floor and are credited exactly once', async () => {
  const db = await open(), ledger = new AgentLedger(db, { now }), owner = agentOwner(AGENT);
  const { first: operations, second: treasury } = splitBps('1000000001', 3000);
  assert.equal(operations, 300000000n); assert.equal(treasury, 700000001n);
  const entries = [{ owner: EXTERNAL.chain, asset: ASSET.SOL, bucket: 'main', delta: -1000000001n }, { owner, asset: ASSET.SOL, bucket: 'operating_unsettled', delta: operations }, { owner, asset: ASSET.SOL, bucket: 'treasury_available', delta: treasury }];
  const id = ledger.post({ kind: 'fee-receipt', sourceKey: 'fee:solana:sig1:mint:0', agentId: AGENT, entries });
  assert.ok(id > 0);
  assert.throws(() => ledger.post({ kind: 'fee-receipt', sourceKey: 'fee:solana:sig1:mint:0', agentId: AGENT, entries }), error => error.code === 'AGENT_LEDGER_DUPLICATE');
  assert.equal(ledger.balance(owner, ASSET.SOL, 'operating_unsettled'), 300000000n);
  assert.equal(ledger.balance(owner, ASSET.SOL, 'treasury_available'), 700000001n);
  assert.equal(ledger.balance(EXTERNAL.chain, ASSET.SOL, 'main'), -1000000001n);
  assert.equal(ledger.balance(agentOwner(OTHER), ASSET.SOL, 'treasury_available'), 0n);
  assert.equal(ledger.verify().ok, true);
  db.close();
});

test('reservations cannot overdraw and reversals compensate', async () => {
  const db = await open(), ledger = new AgentLedger(db, { now }), owner = agentOwner(AGENT);
  ledger.post({ kind: 'backing', sourceKey: 'test:b1', agentId: AGENT, entries: [{ owner: EXTERNAL.provider, asset: ASSET.USD, bucket: 'main', delta: -2000000n }, { owner, asset: ASSET.USD, bucket: 'operating_backed', delta: 2000000n }] });
  ledger.post({ kind: 'reserve', sourceKey: 'test:r1', agentId: AGENT, entries: [{ owner, asset: ASSET.USD, bucket: 'operating_backed', delta: -100000n }, { owner, asset: ASSET.USD, bucket: 'operating_reserved', delta: 100000n }] });
  assert.throws(() => ledger.post({ kind: 'reserve', sourceKey: 'test:r2', agentId: AGENT, entries: [{ owner, asset: ASSET.USD, bucket: 'operating_backed', delta: -1950000n }, { owner, asset: ASSET.USD, bucket: 'operating_reserved', delta: 1950000n }] }), error => error.code === 'AGENT_LEDGER_INSUFFICIENT');
  assert.equal(ledger.balance(owner, ASSET.USD, 'operating_backed'), 1900000n);
  const settle = ledger.post({ kind: 'settle', sourceKey: 'test:s1', agentId: AGENT, entries: [{ owner, asset: ASSET.USD, bucket: 'operating_reserved', delta: -100000n }, { owner, asset: ASSET.USD, bucket: 'operating_spent', delta: 40000n }, { owner, asset: ASSET.USD, bucket: 'operating_backed', delta: 60000n }] });
  assert.equal(ledger.balance(owner, ASSET.USD, 'operating_backed'), 1960000n);
  const reversal = ledger.reverse(settle, { sourceKey: 'rev:s1' });
  assert.equal(ledger.balance(owner, ASSET.USD, 'operating_backed'), 1900000n);
  assert.equal(ledger.balance(owner, ASSET.USD, 'operating_reserved'), 100000n);
  assert.throws(() => ledger.reverse(settle, { sourceKey: 'rev:s1-again' }), error => error.code === 'AGENT_LEDGER_DUPLICATE');
  assert.equal(ledger.transaction(reversal).reversal_of, settle);
  assert.equal(ledger.sum({ owner, asset: ASSET.USD, bucket: 'operating_spent' }), 0n);
  assert.equal(ledger.verify().ok, true);
  assert.equal(ledger.history({ agentId: AGENT }).length, 4);
  db.close();
});

test('token assets track bought-but-not-burned balances per mint', async () => {
  const db = await open(), ledger = new AgentLedger(db, { now }), owner = agentOwner(AGENT), asset = tokenAsset('So11111111111111111111111111111111111111112');
  ledger.post({ kind: 'buyback', sourceKey: 'buy1', agentId: AGENT, entries: [{ owner: EXTERNAL.chain, asset, bucket: 'main', delta: -5000n }, { owner, asset, bucket: 'bought_pending_burn', delta: 5000n }] });
  ledger.post({ kind: 'burn', sourceKey: 'burn1', agentId: AGENT, entries: [{ owner, asset, bucket: 'bought_pending_burn', delta: -5000n }, { owner: EXTERNAL.burn, asset, bucket: 'main', delta: 5000n }] });
  assert.equal(ledger.balance(owner, asset, 'bought_pending_burn'), 0n);
  assert.throws(() => tokenAsset('nope'));
  db.close();
});

test('largest-remainder allocation is deterministic with address tie-breaks', () => {
  const rows = largestRemainder(10n, [{ key: 'b', weight: 1n }, { key: 'a', weight: 1n }, { key: 'c', weight: 1n }]);
  assert.deepEqual(rows.map(row => row.amount.toString()), ['3', '4', '3']);
  const sum = rows.reduce((acc, row) => acc + row.amount, 0n); assert.equal(sum, 10n);
  assert.deepEqual(largestRemainder(0n, [{ key: 'a', weight: 5n }]).map(row => row.amount), [0n]);
  const big = largestRemainder(1000000n, Array.from({ length: 100 }, (_, i) => ({ key: 'k' + String(i).padStart(3, '0'), weight: BigInt(1 + (i % 7)) })));
  assert.equal(big.reduce((acc, row) => acc + row.amount, 0n), 1000000n);
});

test('verify flags drift and unbalanced rows written outside the ledger', async () => {
  const db = await open(), ledger = new AgentLedger(db, { now }), owner = agentOwner(AGENT);
  ledger.post({ kind: 'deposit', sourceKey: 'test:d1', agentId: AGENT, entries: [{ owner: EXTERNAL.chain, asset: ASSET.SOL, bucket: 'main', delta: -7n }, { owner, asset: ASSET.SOL, bucket: 'treasury_available', delta: 7n }] });
  db.run('UPDATE ledger_accounts SET balance = ? WHERE owner = ?', '8', owner);
  const result = ledger.verify();
  assert.equal(result.ok, false); assert.equal(result.problems[0].code, 'drift');
  db.close();
});

test('platform buckets hold provider capacity and operator receivables', async () => {
  const db = await open(), ledger = new AgentLedger(db, { now }), owner = agentOwner(AGENT);
  ledger.post({ kind: 'provider-batch', sourceKey: 'pb1', entries: [{ owner: EXTERNAL.provider, asset: ASSET.USD, bucket: 'main', delta: -50000000n }, { owner: PLATFORM, asset: ASSET.USD, bucket: 'provider_capacity', delta: 50000000n }] });
  ledger.post({ kind: 'settlement', sourceKey: 'st1', agentId: AGENT, entries: [{ owner: EXTERNAL.swap, asset: ASSET.USDC, bucket: 'main', delta: -3000000n }, { owner, asset: ASSET.USDC, bucket: 'operating_settled', delta: 3000000n }] });
  ledger.post({ kind: 'backing', sourceKey: 'bk1', agentId: AGENT, entries: [
    { owner, asset: ASSET.USDC, bucket: 'operating_settled', delta: -3000000n }, { owner: PLATFORM, asset: ASSET.USDC, bucket: 'operator_receivable', delta: 3000000n },
    { owner: PLATFORM, asset: ASSET.USD, bucket: 'provider_capacity', delta: -2835000n }, { owner, asset: ASSET.USD, bucket: 'operating_backed', delta: 2835000n }] });
  assert.equal(ledger.balance(PLATFORM, ASSET.USD, 'provider_capacity'), 47165000n);
  assert.equal(ledger.balance(PLATFORM, ASSET.USDC, 'operator_receivable'), 3000000n);
  assert.equal(ledger.verify().ok, true);
  db.close();
});
