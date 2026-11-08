// AI Agent mode: balanced, immutable ledger postings over the SQLite database.
// Every posting is a set of integer deltas per (owner, asset, bucket) whose sum
// is zero for each asset. Owners are agents, the platform or external
// counterparties (the chain, the provider, the operator, the burn address).
// Agent and platform buckets never go negative; external accounts carry the
// matching opposite balance. Corrections are reversals, never edits.
const MAX = 2n ** 63n - 1n;
const fail = (message, code = 'AGENT_LEDGER', statusCode = 400) => { throw Object.assign(Error(message), { code, statusCode }); };

export const ASSET = Object.freeze({ SOL: 'SOL', USDC: 'USDC', USD: 'USD' });
export const tokenAsset = mint => { if (typeof mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) fail('Invalid token asset.'); return 'TOKEN:' + mint; };
export const EXTERNAL = Object.freeze({ chain: 'external:chain', provider: 'external:provider', operator: 'external:operator', burn: 'external:burn', swap: 'external:swap' });
export const PLATFORM = 'platform';
export const agentOwner = id => { if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) fail('Invalid agent id.'); return 'agent:' + id; };
export const AGENT_BUCKETS = Object.freeze({
  SOL: Object.freeze(['treasury_available', 'treasury_reserved', 'reward_frozen', 'operating_unsettled', 'operating_settling', 'suspense', 'protocol_payable', 'protocol_remitting']),
  USDC: Object.freeze(['operating_settled']),
  USD: Object.freeze(['operating_backed', 'operating_reserved', 'operating_spent', 'operating_disputed']),
  TOKEN: Object.freeze(['bought_pending_burn', 'burned']),
});
export const PLATFORM_BUCKETS = Object.freeze({ USDC: Object.freeze(['operator_receivable', 'operator_reimbursed']), USD: Object.freeze(['provider_capacity', 'provider_variance', 'purchase_fees']), SOL: Object.freeze(['suspense']) });

export function integer(value, label = 'Amount') {
  let n;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'string' && /^-?(?:0|[1-9]\d{0,29})$/.test(value)) n = BigInt(value);
  else if (typeof value === 'number' && Number.isSafeInteger(value)) n = BigInt(value);
  else fail(`${label} must be an integer amount.`, 'AGENT_AMOUNT');
  if (n > MAX || n < -MAX) fail(`${label} is out of range.`, 'AGENT_AMOUNT');
  return n;
}
export const positive = (value, label) => { const n = integer(value, label); if (n <= 0n) fail(`${label} must be positive.`, 'AGENT_AMOUNT'); return n; };
export const nonNegative = (value, label) => { const n = integer(value, label); if (n < 0n) fail(`${label} cannot be negative.`, 'AGENT_AMOUNT'); return n; };
/** Integer basis-point split: the first share is floored, the remainder goes to the second. */
export function splitBps(amount, firstBps) { const total = nonNegative(amount, 'Amount'); const bps = BigInt(firstBps); if (bps < 0n || bps > 10000n) fail('Invalid split.'); const first = total * bps / 10000n; return { first, second: total - first }; }
/** Deterministic integer largest-remainder allocation: weights sorted by the caller. */
export function largestRemainder(total, weights) {
  const budget = nonNegative(total, 'Total'); const rows = weights.map(row => ({ key: row.key, weight: nonNegative(row.weight, 'Weight') }));
  const sum = rows.reduce((acc, row) => acc + row.weight, 0n);
  if (sum === 0n || budget === 0n) return rows.map(row => ({ key: row.key, amount: 0n }));
  const shares = rows.map((row, index) => { const exact = budget * row.weight; return { key: row.key, index, amount: exact / sum, remainder: exact % sum }; });
  let left = budget - shares.reduce((acc, row) => acc + row.amount, 0n);
  const order = [...shares].sort((a, b) => (a.remainder === b.remainder ? (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index) : (a.remainder > b.remainder ? -1 : 1)));
  for (const row of order) { if (left <= 0n) break; row.amount += 1n; left -= 1n; }
  return shares.map(row => ({ key: row.key, amount: row.amount }));
}

function validOwner(owner) { return owner === PLATFORM || /^agent:[a-f0-9]{24}$/.test(owner) || Object.values(EXTERNAL).includes(owner); }
function validBucket(owner, asset, bucket) {
  if (owner.startsWith('external:')) return bucket === 'main';
  const family = asset.startsWith('TOKEN:') ? 'TOKEN' : asset;
  const table = owner === PLATFORM ? PLATFORM_BUCKETS : AGENT_BUCKETS;
  return (table[family] || []).includes(bucket);
}
function validAsset(asset) { return asset === ASSET.SOL || asset === ASSET.USDC || asset === ASSET.USD || /^TOKEN:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(asset); }

export class AgentLedger {
  constructor(db, { now = Date.now } = {}) { this.db = db; this.now = now; }
  account(owner, asset, bucket, { create = false } = {}) {
    const row = this.db.get('SELECT id, balance FROM ledger_accounts WHERE owner = ? AND asset = ? AND bucket = ?', owner, asset, bucket);
    if (row) return { id: row.id, balance: BigInt(row.balance) };
    if (!create) return { id: null, balance: 0n };
    const inserted = this.db.run('INSERT INTO ledger_accounts(owner, asset, bucket, balance) VALUES (?, ?, ?, ?)', owner, asset, bucket, '0');
    return { id: Number(inserted.lastInsertRowid), balance: 0n };
  }
  balance(owner, asset, bucket) { return this.account(owner, asset, bucket).balance; }
  balances(owner) { const out = {}; for (const row of this.db.all('SELECT asset, bucket, balance FROM ledger_accounts WHERE owner = ? ORDER BY asset, bucket', owner)) (out[row.asset] ||= {})[row.bucket] = BigInt(row.balance); return out; }
  hasSource(sourceKey) { return !!this.db.get('SELECT id FROM ledger_transactions WHERE source_key = ?', sourceKey); }
  /**
   * Posts one balanced transaction. Throws AGENT_LEDGER_DUPLICATE when the
   * source key was posted before, so callers can treat at-least-once delivery
   * as exactly-once. Returns the transaction id.
   */
  post({ kind, sourceKey, agentId = null, reference = '', memo = '', entries, reversalOf = null }) {
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(kind)) fail('Invalid ledger posting kind.');
    if (typeof sourceKey !== 'string' || sourceKey.length < 3 || sourceKey.length > 300) fail('A ledger posting needs a unique source key.');
    if (!Array.isArray(entries) || entries.length < 2 || entries.length > 400) fail('A ledger posting needs at least two entries.');
    const rows = entries.map(entry => {
      const { owner, asset, bucket } = entry, delta = integer(entry.delta, 'Ledger delta');
      if (!validOwner(owner)) fail('Invalid ledger owner.'); if (!validAsset(asset)) fail('Invalid ledger asset.'); if (!validBucket(owner, asset, bucket)) fail(`Invalid ledger bucket ${bucket} for ${owner} ${asset}.`);
      if (delta === 0n) fail('Ledger entries cannot be zero.');
      return { owner, asset, bucket, delta };
    });
    const sums = new Map(); for (const row of rows) sums.set(row.asset, (sums.get(row.asset) || 0n) + row.delta);
    for (const [asset, sum] of sums) if (sum !== 0n) fail(`Ledger posting does not balance for ${asset}.`, 'AGENT_LEDGER_UNBALANCED');
    return this.db.transaction(() => {
      if (this.hasSource(sourceKey)) fail('This ledger source was already posted.', 'AGENT_LEDGER_DUPLICATE', 409);
      const tx = this.db.run('INSERT INTO ledger_transactions(kind, source_key, agent_id, reference, memo, reversal_of, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', kind, sourceKey, agentId, String(reference).slice(0, 200), String(memo).slice(0, 500), reversalOf, this.now());
      const id = Number(tx.lastInsertRowid);
      for (const row of rows) {
        const account = this.account(row.owner, row.asset, row.bucket, { create: true }), next = account.balance + row.delta;
        if (next < 0n && !row.owner.startsWith('external:')) fail(`Insufficient ${row.asset} in ${row.owner} ${row.bucket}.`, 'AGENT_LEDGER_INSUFFICIENT', 409);
        if (next > MAX || next < -MAX) fail('Ledger balance out of range.', 'AGENT_AMOUNT');
        this.db.run('UPDATE ledger_accounts SET balance = ? WHERE id = ?', next.toString(), account.id);
        this.db.run('INSERT INTO ledger_entries(transaction_id, account_id, owner, asset, bucket, delta) VALUES (?, ?, ?, ?, ?, ?)', id, account.id, row.owner, row.asset, row.bucket, row.delta.toString());
      }
      return id;
    });
  }
  /** Compensating entries for a prior transaction; the original stays. */
  reverse(transactionId, { sourceKey, memo = '' }) {
    const original = this.db.get('SELECT id, kind, agent_id, reference FROM ledger_transactions WHERE id = ?', transactionId); if (!original) fail('Ledger transaction not found.', 'AGENT_LEDGER', 404);
    if (this.db.get('SELECT id FROM ledger_transactions WHERE reversal_of = ?', transactionId)) fail('This ledger transaction was already reversed.', 'AGENT_LEDGER_DUPLICATE', 409);
    const entries = this.db.all('SELECT owner, asset, bucket, delta FROM ledger_entries WHERE transaction_id = ? ORDER BY id', transactionId).map(row => ({ owner: row.owner, asset: row.asset, bucket: row.bucket, delta: -BigInt(row.delta) }));
    return this.post({ kind: 'reversal', sourceKey, agentId: original.agent_id, reference: original.reference, memo: memo || `Reversal of ${original.kind} #${transactionId}`, entries, reversalOf: transactionId });
  }
  transaction(id) { const row = this.db.get('SELECT * FROM ledger_transactions WHERE id = ?', id); if (!row) return null; return { ...row, entries: this.db.all('SELECT owner, asset, bucket, delta FROM ledger_entries WHERE transaction_id = ? ORDER BY id', id) }; }
  history({ agentId = null, kind = null, limit = 50, before = null } = {}) {
    const clauses = [], params = [];
    if (agentId) { clauses.push('agent_id = ?'); params.push(agentId); }
    if (kind) { clauses.push('kind = ?'); params.push(kind); }
    if (before) { clauses.push('id < ?'); params.push(before); }
    const rows = this.db.all(`SELECT * FROM ledger_transactions ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, ...params, Math.min(200, Math.max(1, limit)));
    return rows.map(row => ({ ...row, entries: this.db.all('SELECT owner, asset, bucket, delta FROM ledger_entries WHERE transaction_id = ? ORDER BY id', row.id) }));
  }
  /** Sum of entry deltas matching a filter; cumulative statistics without extra buckets. */
  sum({ owner, asset, bucket = null, kind = null }) {
    const clauses = ['e.owner = ?', 'e.asset = ?'], params = [owner, asset];
    if (bucket) { clauses.push('e.bucket = ?'); params.push(bucket); }
    if (kind) { clauses.push('t.kind = ?'); params.push(kind); }
    let total = 0n;
    for (const row of this.db.all(`SELECT e.delta AS delta FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id WHERE ${clauses.join(' AND ')}`, ...params)) total += BigInt(row.delta);
    return total;
  }
  /** Full audit: every transaction balances, balances equal entry sums, nothing internal is negative. */
  verify() {
    const problems = [];
    const sums = new Map();
    for (const row of this.db.all('SELECT transaction_id, asset, delta FROM ledger_entries')) { const key = row.transaction_id + ':' + row.asset; sums.set(key, (sums.get(key) || 0n) + BigInt(row.delta)); }
    for (const [key, sum] of sums) if (sum !== 0n) problems.push({ code: 'unbalanced', key, sum: sum.toString() });
    for (const account of this.db.all('SELECT id, owner, asset, bucket, balance FROM ledger_accounts')) {
      let total = 0n; for (const row of this.db.all('SELECT delta FROM ledger_entries WHERE account_id = ?', account.id)) total += BigInt(row.delta);
      if (total !== BigInt(account.balance)) problems.push({ code: 'drift', owner: account.owner, asset: account.asset, bucket: account.bucket, balance: account.balance, entries: total.toString() });
      if (!account.owner.startsWith('external:') && BigInt(account.balance) < 0n) problems.push({ code: 'negative', owner: account.owner, asset: account.asset, bucket: account.bucket, balance: account.balance });
    }
    return { ok: problems.length === 0, problems, checkedAt: this.now() };
  }
}
