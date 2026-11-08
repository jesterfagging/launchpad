// Admin → Tokens → Cleanup: one list of every launch that stopped before it
// finished, across venues, with the money still involved and the action each
// row allows. Read-only: nothing here changes a launch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AdminCleanup } from '../src/admin-cleanup.mjs';

const NOW = 1790668800000, DAY = 86400000, HEX = c => c.repeat(32), MINT = c => c.repeat(43);
const account = (id, username) => ({ id, username });
const raydium = (id, state, extra = {}) => ({ id, state, createdAt: NOW - 3 * DAY, input: { route: 'raydium', network: 'mainnet-beta', name: 'Coin ' + id.slice(0, 2), symbol: 'C' + id.slice(0, 2), quoteSymbol: 'SOL' }, review: { quoteDecimals: 9, quoteSymbol: 'SOL' }, keys: { mint: { address: MINT('A') }, wallet: { secret: 'NEVER_PRINTED' } }, operations: [{ kind: 'create', state: 'failed' }], credits: { quote: '0', base: '0' }, gas: { reserved: '0' }, error: 'The launch transaction expired before it executed.', ...extra });
const nativeRow = (route, id, state, extra = {}) => ({ route, accountId: HEX('b'), username: 'maker', id, mint: MINT('B'), name: 'Native ' + id, symbol: 'N' + id, state, hidden: false, manuallyArchived: false, listArchived: false, canArchive: true, canRestore: false, archiveReason: '', serviceError: '', pendingOperation: null, ...extra });
function harness({ launches = [], pumpRows = [], admin = true } = {}) {
  const launchAdmin = { requireAdmin: async actorId => { if (actorId !== HEX('a') || !admin) throw Object.assign(Error('Administrator access required.'), { statusCode: 403 }); }, inventory: async () => ({ launches, context: () => ({}) }), pumpClassic: { adminUnfinished: async () => pumpRows } };
  return new AdminCleanup({ launchAdmin, now: () => NOW });
}

test('the cleanup list needs an administrator and reads the inventory only then', async () => {
  const cleanup = harness({ admin: false });
  await assert.rejects(cleanup.list(HEX('a')), e => e.statusCode === 403);
  await assert.rejects(harness().list(HEX('c')), e => e.statusCode === 403);
});

test('unfinished launches on every venue are listed with their kind, money, age and actions; live coins and fresh drafts are not', async () => {
  const launches = [
    { account: account(HEX('b'), 'maker'), launch: raydium(HEX('1'), 'failed', { credits: { quote: '42100000', base: '0' }, gas: { reserved: '9000' } }) },
    { account: account(HEX('b'), 'maker'), launch: raydium(HEX('2'), 'error', { operations: [], error: 'Insufficient SOL for the creation fee.' }) },
    { account: account(HEX('b'), 'maker'), launch: raydium(HEX('3'), 'live', { curve: 'curve', operations: [{ kind: 'create', state: 'confirmed' }] }) },
    { account: account(HEX('b'), 'maker'), launch: raydium(HEX('4'), 'draft', { operations: [], error: '', createdAt: NOW - 2 * DAY }) },
    { account: account(HEX('b'), 'maker'), launch: raydium(HEX('5'), 'draft', { operations: [], error: '', createdAt: NOW - 3600000 }) },
    { account: account(HEX('b'), 'maker'), launch: raydium(HEX('6'), 'failed', { listArchive: { archived: true, at: NOW - DAY }, operations: [] }) },
    { account: account(HEX('b'), 'maker'), launch: { id: 'f'.repeat(8) + '-' + 'f'.repeat(4) + '-' + 'f'.repeat(4) + '-' + 'f'.repeat(4) + '-' + 'f'.repeat(12), createdAt: NOW - 4 * DAY, state: 'error', input: { route: 'meteora' } }, adminRow: nativeRow('meteora', 'm1', 'error', { pendingOperation: { kind: 'initialize', state: 'pending' } }) },
    { account: account(HEX('b'), 'maker'), launch: { id: 'p1', createdAt: NOW - 5 * DAY, state: 'trading', input: { route: 'pumpswap' } }, adminRow: nativeRow('pumpswap', 'p1', 'trading') },
    { account: account(HEX('b'), 'maker'), launch: { id: 'pc', createdAt: NOW, state: 'created', input: { route: 'pump-classic' } }, adminRow: nativeRow('pump-classic', 'pc', 'created') },
  ];
  const pumpRows = [
    { accountId: HEX('b'), username: 'maker', id: 'x1', mint: MINT('C'), name: 'Pump one', symbol: 'P1', state: 'failed', stateLabel: 'Failed', kind: 'refund', reason: 'Creation did not succeed.', createdAt: NOW - DAY, updatedAt: NOW - 3600000, money: '0.12 SOL funded', moneyZero: false, pending: true, recovery: true, archived: false, hidden: false, listArchived: false, archiveReason: 'Its refund is still being returned.', bulkEligible: false, bulkCode: '', actions: [] },
    { accountId: HEX('b'), username: 'maker', id: 'x2', mint: MINT('D'), name: 'Pump two', symbol: 'P2', state: 'expired', stateLabel: 'Quote expired', kind: 'abandoned', reason: 'The quote expired before funding.', createdAt: NOW - 6 * DAY, updatedAt: NOW - 6 * DAY, money: '', moneyZero: true, pending: false, recovery: false, archived: false, hidden: false, listArchived: false, archiveReason: '', bulkEligible: true, bulkCode: '', actions: ['archive'] },
    { accountId: HEX('b'), username: 'maker', id: 'x3', mint: MINT('E'), name: 'Pump three', symbol: 'P3', state: 'refunded', stateLabel: 'Refunded', kind: 'archived', reason: '', createdAt: NOW - 9 * DAY, updatedAt: NOW - 8 * DAY, money: '0.1 SOL refunded', moneyZero: false, pending: false, recovery: false, archived: true, hidden: false, listArchived: true, archiveReason: 'This launch is already archived.', bulkEligible: false, bulkCode: '', actions: ['unarchive'] },
  ];
  const cleanup = harness({ launches, pumpRows }), result = await cleanup.list(HEX('a'));
  const keys = result.rows.map(row => row.key);
  assert.deepEqual(keys, ['pump-classic:' + HEX('b') + ':x1', 'raydium:' + HEX('b') + ':' + HEX('4'), 'raydium:' + HEX('b') + ':' + HEX('1'), 'raydium:' + HEX('b') + ':' + HEX('2'), 'meteora:' + HEX('b') + ':' + 'f'.repeat(8) + '-' + 'f'.repeat(4) + '-' + 'f'.repeat(4) + '-' + 'f'.repeat(4) + '-' + 'f'.repeat(12)], 'newest first; live coins, a fresh draft, archived rows and abandoned quotes stay out of the default list');
  const byId = Object.fromEntries(result.rows.map(row => [row.id, row])), failed = byId[HEX('1')];
  assert.deepEqual([failed.kind, failed.stateLabel, failed.money, failed.actions, failed.bulkEligible], ['failed', 'Failed', '0.0421 SOL credit · 0.000009 SOL reserved', ['archive'], false], 'money left on the request blocks the bulk archive but not a reviewed archive');
  assert.equal(byId[HEX('2')].bulkEligible, true, 'a settled failure with nothing left is bulk-eligible');
  assert.deepEqual([byId[HEX('4')].kind, byId[HEX('4')].stateLabel], ['unfinished', 'Draft'], 'a draft older than a day that stopped before its token is never finished');
  const meteora = result.rows[4];
  assert.deepEqual([meteora.pending, meteora.venue, meteora.actions], [true, 'Meteora', ['archive']]);
  assert.deepEqual([byId.x1.venue, byId.x1.kind, byId.x1.recovery], ['Pump.fun', 'refund', true]);
  assert.deepEqual(result.counts, { total: 8, failed: 3, unfinished: 1, refund: 1, abandoned: 1, archived: 2, byVenue: { raydium: 4, meteora: 1, 'pump-classic': 3 }, moneyRows: 2, bulkEligible: 2, pumpEligible: 1 });
  assert.doesNotMatch(JSON.stringify(result), /NEVER_PRINTED/);
  // Filters: kind, venue, archived, search; paging.
  assert.deepEqual((await cleanup.list(HEX('a'), { kind: 'archived', includeArchived: true })).rows.map(row => row.id), [HEX('6'), 'x3']);
  assert.deepEqual((await cleanup.list(HEX('a'), { kind: 'abandoned' })).rows.map(row => row.id), ['x2']);
  assert.deepEqual((await cleanup.list(HEX('a'), { venue: 'raydium' })).rows.map(row => row.id), [HEX('4'), HEX('1'), HEX('2')]);
  assert.deepEqual((await cleanup.list(HEX('a'), { search: 'expired before it' })).rows.map(row => row.id), [HEX('1')]);
  const page = await cleanup.list(HEX('a'), { offset: 2, limit: 2 });
  assert.deepEqual([page.total, page.rows.length, page.offset, page.nextOffset], [5, 2, 2, 4]);
  await assert.rejects(cleanup.list(HEX('a'), { limit: 1000 }), /Invalid cleanup page/);
  await assert.rejects(cleanup.list(HEX('a'), { venue: 'nope' }), /valid launch venue/);
  await assert.rejects(cleanup.list(HEX('a'), { kind: 'nope' }), /valid cleanup filter/);
});

test('a host without the Pump.fun service lists the other venues', async () => {
  const cleanup = harness({ launches: [{ account: account(HEX('b'), 'maker'), launch: raydium(HEX('1'), 'failed', { operations: [] }) }] });
  cleanup.launchAdmin.pumpClassic = null;
  const result = await cleanup.list(HEX('a'));
  assert.deepEqual(result.rows.map(row => row.route), ['raydium']); assert.equal(result.counts.pumpEligible, 0);
});
