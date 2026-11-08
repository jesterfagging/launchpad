import { invariant } from './core.mjs';
export const journalName = (kind, mode) => kind === 'copy' ? mode : `${kind}-${mode}`;
export const emptyJournal = () => ({ version: 1, lots: [], pending: [], seen: [], events: [], trades: 0, feeReceipts: [] });
export const runJournalNames = ['live', 'paper', 'sniper-live', 'sniper-paper', 'market-live', 'market-paper', 'liquidity-live', 'liquidity-paper'];

// All account operations await this marker before starting a worker. A crash
// midway can repeat the conversion safely: no new worker could have traded yet.
// The encrypted legacy journals remain as a recovery snapshot, never deleted.
export async function prepareRunJournals(store) {
  const marker = await store.read('concurrent-runs', null);
  if (marker) { invariant(marker.version === 1, 'Unsupported concurrent-run journal format.'); return; }
  for (const mode of ['live', 'paper']) {
    const legacy = await store.read(`portfolio-${mode}`, emptyJournal());
    invariant(Array.isArray(legacy.lots) && Array.isArray(legacy.pending), 'Portfolio journal is invalid; restore it before starting.');
    invariant(legacy.lots.every(row => ['market', 'liquidity'].includes(row.kind)), 'A legacy allocation has no strategy identity. No positions were discarded.');
    const kindFor = pending => {
      const options = new Set(legacy.lots.filter(row => row.wallet === pending.wallet).map(row => row.kind));
      invariant(options.size === 1, 'A pending portfolio transaction cannot be assigned safely. Resolve it in the previous build before upgrading.');
      return [...options][0];
    };
    const pendingKinds = new Map(legacy.pending.map(row => [row, kindFor(row)]));
    for (const kind of ['market', 'liquidity']) {
      const data = { ...emptyJournal(), ...legacy, version: 1,
        lots: legacy.lots.filter(row => row.kind === kind), pending: legacy.pending.filter(row => pendingKinds.get(row) === kind),
        feeReceipts: (legacy.feeReceipts || []).filter(row => row.kind === kind),
        trades: 0, legacyTrades: legacy.trades || 0, migratedFrom: `portfolio-${mode}` };
      await store.write(journalName(kind, mode), data);
    }
  }
  await store.write('concurrent-runs', { version: 1, at: Date.now() });
}
