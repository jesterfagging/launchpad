import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { PublicAnalytics } from '../src/public-analytics.mjs';
import { MANUAL_PROTOCOL_HISTORY, MANUAL_PROTOCOL_MINT } from '../src/protocol-manual-history.mjs';

const NOW = Date.UTC(2026, 8, 26, 18);
const sig = n => { const bytes = Buffer.alloc(64, 9); bytes.writeUInt32LE(n); return bs58.encode(bytes); };
const row = (n, kind = 'burn', inputAmount = '700', outputAmount = '0', at = NOW) => ({
  kind, source: 'admin', signature: sig(n), inputAmount, outputAmount, confirmedAt: at - 1000,
  slot: 12345, commitment: 'finalized', curveDecimals: 6, mint: MANUAL_PROTOCOL_MINT,
});
function fixture({ now = NOW, state = null, direct, imported = [], volumeRead } = {}) {
  let imports = imported, unavailable = false;
  const volume = { readPublic: volumeRead || (async () => ({ launches: {}, volume: {}, directBurns: direct || { status: 'available', complete: true, curveBurned: '0', history: [] } })),
    tokenPrice: () => ({ mint: MANUAL_PROTOCOL_MINT, usd: 0.25, at: now }) };
  const service = new PublicAnalytics({ now: () => now, volume,
    accounts: { hostStore: { read: async () => state, write: () => assert.fail('analytics must never write accounting') } },
    burnHistory: { readPublic: async () => { if (unavailable) throw Error('PRIVATE_PROVIDER_ERROR'); return { status: 'available', complete: true, history: structuredClone(imports) }; } },
  });
  return { service, set imports(value) { imports = value; }, set unavailable(value) { unavailable = value; } };
}
function managed(history, { spent = '1000', bought = '10000', burned = '5000' } = {}) {
  return { version: 1, wallet: { address: MANUAL_PROTOCOL_MINT }, curveDecimals: 6, updatedAt: NOW,
    totals: { buybackSpent: spent, curveBought: bought, curveBurned: burned },
    history: history.map(row => ({ ...row, state: 'confirmed' })) };
}

test('burn-only imports add actual burns without inventing purchases or changing accounting', async () => {
  const state = managed([]), before = structuredClone(state), imported = row(1, 'burn', '9000000');
  const f = fixture({ state, imported: [imported] }), result = await f.service.read();
  assert.equal(result.treasury.solSpent, '1000'); assert.equal(result.treasury.curveBought, '10000');
  assert.equal(result.burns.curveBurned, '9005000'); assert.equal(result.burns.importedBurned, '9000000');
  assert.equal(result.burns.history[0].source, 'admin'); assert.equal(result.burns.complete, true);
  assert.deepEqual(state, before); assert(!Object.hasOwn(result.treasury, 'buybackAvailable'));
  assert(result.treasury.curvePrice, 'current price reference remains available for burn valuation');
  f.service.close();
});

test('buy and burn in the same transaction remain separate operations and repeated imports count once', async () => {
  const buy = row(2, 'buy', '1500000000', '1000000'), burn = row(2, 'burn', '2000000');
  const f = fixture({ imported: [buy, burn, { ...buy }, { ...burn }] }), out = await f.service.read();
  assert.equal(out.treasury.solSpent, '1500000000'); assert.equal(out.treasury.curveBought, '1000000');
  assert.equal(out.burns.curveBurned, '2000000'); assert.equal(out.burns.history.length, 2);
  assert.deepEqual(new Set(out.burns.history.map(r => r.kind)), new Set(['buy', 'burn']));
  assert.equal(out.burns.status, 'available'); f.service.close();
});

test('managed buy and burn sharing a signature project and deduplicate independently', async () => {
  const buy = row(3, 'buy', '1000', '10000'), burn = row(3, 'burn', '5000');
  const f = fixture({ state: managed([buy, burn]), imported: [buy, burn] }), out = await f.service.read();
  assert.equal(out.treasury.solSpent, '1000'); assert.equal(out.treasury.curveBought, '10000');
  assert.equal(out.burns.curveBurned, '5000'); assert.equal(out.burns.history.length, 2);
  assert.equal(out.burns.importedBurned, '0'); f.service.close();
});

test('imports deduplicate against automatic operations older than both public history and 500 rows', async () => {
  const history = Array.from({ length: 550 }, (_, n) => row(100 + n, 'buy', '1', '2'));
  history.forEach((r, n) => { r.confirmedAt = NOW - 100000 + n; });
  const f = fixture({ state: managed(history, { spent: '550', bought: '1100', burned: '0' }), imported: [history[0]] });
  const out = await f.service.read(); assert.equal(out.treasury.solSpent, '550'); assert.equal(out.treasury.curveBought, '1100');
  assert.equal(out.treasury.adminSolSpent, '0'); assert.equal(out.treasury.status, 'available'); f.service.close();
});

test('a previously matched automatic import stays deduplicated after its recent journal receipt is pruned', async () => {
  const imported = [row(30, 'buy', '1000', '10000'), row(31, 'burn', '5000')]
    .map(r => ({ ...r, wallet: MANUAL_PROTOCOL_MINT, accountingSource: 'managed-treasury' }));
  const f = fixture({ state: managed([]), imported }), out = await f.service.read();
  assert.equal(out.treasury.solSpent, '1000'); assert.equal(out.treasury.curveBought, '10000');
  assert.equal(out.burns.curveBurned, '5000'); assert.equal(out.burns.importedBurned, '0');
  f.service.close();
});

test('pinned historical operations and full direct burn history overlap imports only once', async () => {
  const now = Date.UTC(2026, 8, 30), directRows = Array.from({ length: 30 }, (_, n) => ({ ...row(800 + n, 'burn', '10', '0', now), source: 'direct' }));
  directRows.forEach((r, n) => { r.confirmedAt -= n; });
  const imported = [...MANUAL_PROTOCOL_HISTORY.map(r => ({ ...r, source: 'admin' })), { ...directRows.at(-1), source: 'admin' }];
  const direct = { status: 'available', complete: true, curveBurned: '300', history: directRows };
  const f = fixture({ now, direct, imported }), out = await f.service.read();
  assert.equal(out.treasury.solSpent, '8916645858'); assert.equal(out.treasury.curveBought, '2314783626758');
  assert.equal(out.burns.curveBurned, '7414695326944'); assert.equal(out.burns.importedBurned, '0');
  assert.equal(out.burns.history.length, 20); f.service.close();
});

test('conflicting amounts across imported, automatic, pinned and direct receipts fail closed', async () => {
  const original = row(4), conflicting = { ...original, inputAmount: '701' };
  for (const options of [
    { imported: [original, conflicting] },
    { state: managed([original]), imported: [conflicting] },
    { direct: { status: 'available', complete: true, curveBurned: '700', history: [{ ...original, source: 'direct' }] }, imported: [conflicting] },
    { now: Date.UTC(2026, 8, 30), imported: [{ ...MANUAL_PROTOCOL_HISTORY[1], source: 'admin', inputAmount: '1' }] },
  ]) {
    const f = fixture(options), out = await f.service.read();
    assert.equal(out.treasury.status, 'unavailable'); assert.equal(out.treasury.solSpent, null);
    assert.equal(out.burns.curveBurned, null); assert.equal(out.burns.complete, false); f.service.close();
  }
});

test('invalid imported rows are not published and unrelated private fields never reach analytics', async () => {
  for (const update of [{ mint: 'wrong-mint' }, { commitment: 'confirmed' }, { slot: 0 }, { inputAmount: '-1' }, { kind: 'transfer' }, { confirmedAt: NOW + 6000 }]) {
    const f = fixture({ imported: [{ ...row(5), ...update }] }), out = await f.service.read();
    assert.equal(out.burns.curveBurned, null); f.service.close();
  }
  const f = fixture({ imported: [{ ...row(5), privateKey: 'PRIVATE_KEY', raw: 'SIGNED_BYTES', error: 'PRIVATE_RPC' }] });
  assert.doesNotMatch(JSON.stringify(await f.service.read()), /PRIVATE_|SIGNED_BYTES/); f.service.close();
});

test('an unreadable import store retains verified existing subtotals with incomplete coverage', async () => {
  const f = fixture({ state: managed([]) }); f.unavailable = true;
  const out = await f.service.read(); assert.equal(out.treasury.solSpent, '1000'); assert.equal(out.burns.curveBurned, '5000');
  assert.equal(out.treasury.status, 'partial'); assert.equal(out.burns.status, 'partial');
  assert.equal(out.burns.complete, false); assert.equal(out.treasury.adminHistoryUnavailable, true);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE_PROVIDER_ERROR/); f.service.close();
});

test('invalidate refreshes new imports immediately and an older in-flight build cannot restore stale data', async () => {
  let release, calls = 0;
  const market = { launches: {}, volume: {}, directBurns: { status: 'available', complete: true, curveBurned: '0', history: [] } };
  const f = fixture({ volumeRead: () => ++calls === 1 ? new Promise(resolve => { release = () => resolve(market); }) : Promise.resolve(market) });
  const first = f.service.read(); await new Promise(resolve => setImmediate(resolve));
  f.imports = [row(6)]; f.service.invalidate();
  const fresh = await f.service.read(); assert.equal(fresh.burns.curveBurned, '700');
  release(); assert.equal((await first).burns.curveBurned, '700');
  assert.equal((await f.service.read()).burns.curveBurned, '700'); assert.equal(calls, 2);
  f.imports = [row(6), row(7)]; f.service.invalidate();
  assert.equal((await f.service.read()).burns.curveBurned, '1400'); assert.equal(calls, 3); f.service.close();
});
