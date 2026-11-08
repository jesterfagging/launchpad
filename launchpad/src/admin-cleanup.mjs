// Admin → Tokens → Cleanup: one list of every launch that stopped before it
// finished, across venues (Raydium, PumpSwap, Meteora, Pump.fun), with the
// money still involved and the action each row allows. Reads only: every
// action goes through the existing routes (archive, moderation, Pump.fun
// controls, the bulk failed-launch archive), each with its own identity check.
import { launchArchiveView, stoppedBeforeToken } from './launchpad-archive.mjs';
import { failedLaunchArchiveEligibility } from './admin-failed-launch-archive.mjs';
import { displayUnits } from '../public/launchpad-model.mjs';

const fail = (message, statusCode = 400) => { throw Object.assign(Error(message), { statusCode }); };
const text = (value, max = 300) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : '';
const time = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000 ? value : null;
const ROUTES = new Set(['raydium', 'pumpswap', 'damm-pump', 'meteora', 'pump-classic']);
const VENUE_LABELS = Object.freeze({ raydium: 'Raydium', pumpswap: 'PumpSwap', 'damm-pump': 'PumpSwap', meteora: 'Meteora', 'pump-classic': 'Pump.fun' });
// Rows are grouped by what the operator should do with them.
const KINDS = Object.freeze({ failed: 'Failed', unfinished: 'Never finished', refund: 'Refund', abandoned: 'Abandoned quote', archived: 'Archived' });
const STATE_LABELS = Object.freeze({ draft: 'Draft', error: 'Error', failed: 'Failed', stopping: 'Stopping', pending: 'Pending', cancelled: 'Cancelled', expired: 'Expired' });
const NATIVE_UNFINISHED = new Set(['draft', 'error', 'failed', 'cancelled', 'expired']);
const RAYDIUM_UNFINISHED = new Set(['draft', 'error', 'failed', 'stopping']);
export const CLEANUP_DRAFT_AGE_MS = 24 * 3600000;
const lamportsText = value => { try { const units = BigInt(value ?? '0'); return units === 0n ? null : displayUnits(units.toString(), 9); } catch { return null; } };
const sum = values => values.reduce((total, value) => { try { return total + BigInt(value ?? '0'); } catch { return total; } }, 0n);

/** Money still tied to a Raydium request: credits, reserved gas and recovery balances (display units of SOL/quote). */
function raydiumMoney(launch) {
  const quote = launch.credits?.quote, base = launch.credits?.base, decimals = Number.isInteger(launch.review?.quoteDecimals) ? launch.review.quoteDecimals : 9;
  const parts = [];
  try { if (quote && BigInt(quote) > 0n) parts.push(`${displayUnits(String(quote), decimals)} ${text(launch.review?.quoteSymbol || launch.input?.quoteSymbol, 16) || 'quote'} credit`); } catch { /* shown as unknown */ }
  try { if (base && BigInt(base) > 0n) parts.push(`${displayUnits(String(base), 6)} ${text(launch.input?.symbol, 16) || 'tokens'} credit`); } catch { /* shown as unknown */ }
  const reserved = sum([launch.gas?.reserved, launch.reservedLamports, launch.refundPendingLamports, launch.recovery?.unreturnedLamports, launch.recovery?.reservedLamports, launch.recovery?.remainingLamports, launch.recovery?.balanceLamports]);
  if (reserved > 0n) parts.push(`${displayUnits(reserved.toString(), 9)} SOL reserved`);
  return { text: parts.join(' · '), zero: !parts.length };
}

export function cleanupStateLabel(route, state) {
  if (route === 'pump-classic') return state;
  return STATE_LABELS[state] || text(state, 24) || 'Unknown';
}

export class AdminCleanup {
  /**
   * @param launchAdmin   LaunchpadAdmin (inventory across venues; its pumpClassic is set by the app)
   * @param pumpClassic   PumpClassicService (adminUnfinished), optional
   */
  constructor({ accounts, launchpad, launchAdmin, pumpClassic = null, now = Date.now, draftAgeMs = CLEANUP_DRAFT_AGE_MS } = {}) {
    Object.assign(this, { accounts, launchpad, launchAdmin, fixedPumpClassic: pumpClassic, now, draftAgeMs });
  }
  get pumpClassic() { return this.fixedPumpClassic || this.launchAdmin?.pumpClassic || null; }
  raydiumRow(account, launch, now) {
    const state = launch.state, view = launchArchiveView(launch);
    if (!RAYDIUM_UNFINISHED.has(state)) return null;
    if (state === 'draft' && (!stoppedBeforeToken(launch) || now - (time(launch.createdAt) || 0) < this.draftAgeMs)) return null;
    const money = raydiumMoney(launch), bulk = failedLaunchArchiveEligibility(launch, 'raydium');
    const pending = (launch.operations || []).some(op => ['pending', 'awaiting_signature'].includes(op?.state));
    const actions = [];
    if (view.canArchive) actions.push('archive');
    if (view.canRestore) actions.push('restore');
    return {
      key: `raydium:${account.id}:${launch.id}`, route: 'raydium', venue: VENUE_LABELS.raydium, accountId: account.id, username: text(account.username, 32), id: launch.id, mint: text(launch.keys?.mint?.address, 44),
      name: text(launch.input?.name, 100), symbol: text(launch.input?.symbol, 24), state, stateLabel: cleanupStateLabel('raydium', state),
      kind: view.listArchived ? 'archived' : state === 'draft' ? 'unfinished' : 'failed', reason: text(launch.error || launch.serviceError, 300),
      createdAt: time(launch.createdAt), updatedAt: time(launch.updatedAt) || time(launch.createdAt), money: money.text, moneyZero: money.zero, pending,
      recovery: !!launch.recovery && launch.recovery.status !== 'not-needed' && launch.recovery.status !== 'complete',
      archived: view.manuallyArchived, hidden: view.hidden, listArchived: view.listArchived, archiveReason: text(view.archiveReason, 200),
      bulkEligible: bulk.eligible, bulkCode: bulk.code, actions,
    };
  }
  nativeRow(account, launch, row, now) {
    const state = row.state || launch.state;
    if (!NATIVE_UNFINISHED.has(state)) return null;
    if (state === 'draft' && (!row.canArchive || now - (time(launch.createdAt) || 0) < this.draftAgeMs)) return null;
    const actions = [];
    if (row.canArchive) actions.push('archive');
    if (row.canRestore) actions.push('restore');
    return {
      key: `${row.route}:${account.id}:${launch.id}`, route: row.route, venue: VENUE_LABELS[row.route] || text(row.route, 24), accountId: account.id, username: text(account.username || row.username, 32), id: launch.id, mint: text(row.mint, 44),
      name: text(row.name, 100), symbol: text(row.symbol, 24), state, stateLabel: cleanupStateLabel(row.route, state),
      kind: row.listArchived ? 'archived' : state === 'draft' ? 'unfinished' : 'failed', reason: text(row.serviceError, 300),
      createdAt: time(launch.createdAt), updatedAt: time(launch.createdAt), money: '', moneyZero: true, pending: !!row.pendingOperation, recovery: false,
      archived: row.manuallyArchived === true, hidden: row.hidden === true, listArchived: row.listArchived === true, archiveReason: text(row.archiveReason, 200),
      bulkEligible: false, bulkCode: '', actions,
    };
  }
  /** Every unfinished launch across venues, newest first. */
  async discover(actorId) {
    await this.launchAdmin.requireAdmin(actorId);
    const now = this.now(), rows = [], seen = new Set();
    const { launches } = await this.launchAdmin.inventory(undefined, actorId);
    for (const { account, launch, adminRow } of launches) {
      if (!account || !launch) continue;
      const route = adminRow?.route || launch.input?.route || 'raydium';
      if (route === 'pump-classic') continue; // the Pump.fun journal lists its own unfinished launches below
      const row = adminRow && ROUTES.has(route) ? this.nativeRow(account, launch, adminRow, now) : route === 'raydium' ? this.raydiumRow(account, launch, now) : null;
      if (row && !seen.has(row.key)) { seen.add(row.key); rows.push(row); }
    }
    const pump = this.pumpClassic;
    if (pump && typeof pump.adminUnfinished === 'function') {
      for (const row of await pump.adminUnfinished(actorId)) { const key = `pump-classic:${row.accountId}:${row.id}`; if (!seen.has(key)) { seen.add(key); rows.push({ ...row, key, route: 'pump-classic', venue: VENUE_LABELS['pump-classic'] }); } }
    }
    rows.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0) || String(a.key).localeCompare(String(b.key)));
    await this.launchAdmin.requireAdmin(actorId);
    return rows;
  }
  /**
   * The cleanup list: `search` matches coin, ticker, mint, account or reason; `venue` and `kind` narrow;
   * archived rows are left out unless `includeArchived`. Paged with `offset`/`limit` (25 by default).
   */
  async list(actorId, { search = '', venue = '', kind = '', includeArchived = false, offset = 0, limit = 25 } = {}) {
    if (typeof search !== 'string' || search.length > 128) fail('Search must be 128 characters or fewer.');
    if (venue && !ROUTES.has(venue)) fail('Choose a valid launch venue.');
    if (kind && !Object.hasOwn(KINDS, kind)) fail('Choose a valid cleanup filter.');
    offset = Number(offset); limit = Number(limit);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('Invalid cleanup page.');
    const all = await this.discover(actorId), query = search.trim().toLowerCase(), showArchived = includeArchived === true || includeArchived === 'true' || includeArchived === '1';
    const counts = { total: 0, failed: 0, unfinished: 0, refund: 0, abandoned: 0, archived: 0, byVenue: {}, moneyRows: 0, bulkEligible: 0, pumpEligible: 0 };
    for (const row of all) {
      counts.total++; counts[row.kind] = (counts[row.kind] || 0) + 1; counts.byVenue[row.route] = (counts.byVenue[row.route] || 0) + 1;
      if (!row.moneyZero && row.kind !== 'archived') counts.moneyRows++;
      if (row.bulkEligible) { counts.bulkEligible++; if (row.route === 'pump-classic') counts.pumpEligible++; }
    }
    // Abandoned quotes (expired or cancelled before any funding) only show when asked for: they never held money.
    const matched = all.filter(row => (showArchived || row.kind !== 'archived') && (kind === 'abandoned' || row.kind !== 'abandoned') && (!venue || row.route === venue) && (!kind || row.kind === kind)
      && (!query || [row.name, row.symbol, row.mint, row.username, row.id, row.reason, row.stateLabel, row.venue].some(value => String(value || '').toLowerCase().includes(query))));
    await this.launchAdmin.requireAdmin(actorId);
    return { at: this.now(), version: 1, counts, kinds: KINDS, venues: VENUE_LABELS, rows: matched.slice(offset, offset + limit), total: matched.length, offset, limit, nextOffset: offset + limit < matched.length ? offset + limit : null, includeArchived: showArchived, search: query, venue, kind };
  }
}
