// Robinhood launch venue: durable state in Node's bundled SQLite (WAL, FULL sync), the Pump.fun Classic shape adapted
// to an EVM chain. Money is TEXT decimal (BigInt in JS) in the asset the row names. Operations keep the exact signed
// bytes and nonce before broadcast; fee claims are append-only keyed by transaction and log index; per-role balances
// move in the same transaction as the journal row that moves them. Host-level work (the owner's and the platform
// wallet's transactions, the platform ledger) uses the launch id 'host'.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { acquireProcessLock } from '../process-lock.mjs';

const fail = (message, code = 'ROBINHOOD_LAUNCH_STORE', statusCode = 503) => { throw Object.assign(Error(message), { code, statusCode }); };
export const ROBINHOOD_LAUNCH_SCHEMA_VERSION = 3;
export const MIGRATIONS = Object.freeze([
  { version: 1, name: 'robinhood-launch-core', sql: `
    CREATE TABLE launches (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE, mode TEXT NOT NULL,
      policy_version TEXT NOT NULL, policy_hash TEXT NOT NULL,
      name TEXT NOT NULL, symbol TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '', twitter TEXT NOT NULL DEFAULT '', telegram TEXT NOT NULL DEFAULT '', metadata_uri TEXT NOT NULL DEFAULT '',
      option TEXT, rules TEXT, tier TEXT NOT NULL, pair_token TEXT NOT NULL, pair_symbol TEXT NOT NULL, pair_decimals INTEGER NOT NULL, pair_kind TEXT NOT NULL,
      pair_usd TEXT NOT NULL DEFAULT '0', eth_usd TEXT NOT NULL DEFAULT '0', virtual_quote TEXT NOT NULL, graduation_quote TEXT NOT NULL,
      developer_wallet TEXT NOT NULL, launch_wallet TEXT NOT NULL UNIQUE, fee_wallet TEXT UNIQUE, token TEXT NOT NULL UNIQUE, curve TEXT, salt TEXT NOT NULL,
      creator_tax_bps INTEGER NOT NULL DEFAULT 0, dev_buy TEXT NOT NULL DEFAULT '0', plan TEXT NOT NULL, quote TEXT NOT NULL, quote_expires_at INTEGER NOT NULL,
      funding_tx TEXT, funded_wei TEXT NOT NULL DEFAULT '0', funded_pair TEXT NOT NULL DEFAULT '0', funded_at INTEGER,
      state TEXT NOT NULL, state_reason TEXT NOT NULL DEFAULT '', create_attempts INTEGER NOT NULL DEFAULT 0, create_tx TEXT UNIQUE, created_block INTEGER, live_at INTEGER,
      dev_tokens TEXT NOT NULL DEFAULT '0', fee_state TEXT NOT NULL DEFAULT 'pending', venue_state TEXT NOT NULL DEFAULT 'curve', pool_id TEXT, graduated_at INTEGER,
      refund_state TEXT NOT NULL DEFAULT 'none', refund_tx TEXT, refunded_wei TEXT NOT NULL DEFAULT '0', refunded_pair TEXT NOT NULL DEFAULT '0',
      hidden INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX launches_account ON launches(account_id, created_at);
    CREATE INDEX launches_state ON launches(state);
    CREATE TABLE operations (
      id TEXT PRIMARY KEY, launch_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, wallet TEXT NOT NULL,
      hash TEXT UNIQUE, raw TEXT, nonce INTEGER, gas TEXT NOT NULL DEFAULT '0', max_fee TEXT NOT NULL DEFAULT '0', expected TEXT NOT NULL DEFAULT '{}', receipt TEXT, error TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0, last_broadcast_at INTEGER, check_after INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX operations_launch ON operations(launch_id, state);
    CREATE INDEX operations_open ON operations(state, check_after);
    CREATE TABLE balances (
      launch_id TEXT NOT NULL, role TEXT NOT NULL, asset TEXT NOT NULL, credited TEXT NOT NULL DEFAULT '0', debited TEXT NOT NULL DEFAULT '0', costs TEXT NOT NULL DEFAULT '0',
      updated_at INTEGER NOT NULL, PRIMARY KEY(launch_id, role, asset)
    );
    CREATE TABLE fee_claims (
      id TEXT PRIMARY KEY, launch_id TEXT NOT NULL, kind TEXT NOT NULL, wallet TEXT NOT NULL, role TEXT NOT NULL, asset TEXT NOT NULL, amount TEXT NOT NULL, -- launch_id 'host' for the platform wallet's claims
      tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(tx_hash, log_index)
    );
    CREATE INDEX fee_claims_launch ON fee_claims(launch_id, block);
    CREATE TABLE sweeps (
      id TEXT PRIMARY KEY, launch_id TEXT NOT NULL, kind TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, hash TEXT UNIQUE,
      from_wallet TEXT NOT NULL, to_wallet TEXT NOT NULL, asset TEXT NOT NULL, amount TEXT NOT NULL, state TEXT NOT NULL, block INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX sweeps_kind ON sweeps(kind, state);
    CREATE TABLE holder_balances (launch_id TEXT NOT NULL REFERENCES launches(id), owner TEXT NOT NULL, balance TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(launch_id, owner));
    CREATE INDEX holder_balances_rank ON holder_balances(launch_id, balance DESC);
    CREATE TABLE holder_samples (launch_id TEXT NOT NULL REFERENCES launches(id), block INTEGER NOT NULL, at INTEGER NOT NULL, balances TEXT NOT NULL, PRIMARY KEY(launch_id, block));
    CREATE TABLE holder_streaks (launch_id TEXT NOT NULL REFERENCES launches(id), owner TEXT NOT NULL, streak INTEGER NOT NULL DEFAULT 0, balance TEXT NOT NULL DEFAULT '0', updated_at INTEGER NOT NULL, PRIMARY KEY(launch_id, owner));
    CREATE INDEX holder_streaks_rank ON holder_streaks(launch_id, streak DESC);
    CREATE TABLE reward_cycles (
      id TEXT PRIMARY KEY, launch_id TEXT NOT NULL REFERENCES launches(id), state TEXT NOT NULL, asset TEXT NOT NULL, amount TEXT NOT NULL, payouts TEXT NOT NULL,
      next_index INTEGER NOT NULL DEFAULT 0, paid TEXT NOT NULL DEFAULT '0', skipped INTEGER NOT NULL DEFAULT 0, window_from INTEGER NOT NULL, window_to INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX reward_cycles_open ON reward_cycles(launch_id, state);
    CREATE TABLE trades (
      id TEXT PRIMARY KEY, launch_id TEXT NOT NULL REFERENCES launches(id), side TEXT NOT NULL, wallet TEXT NOT NULL, quote TEXT NOT NULL, tokens TEXT NOT NULL, fee TEXT NOT NULL DEFAULT '0',
      tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block INTEGER NOT NULL, at INTEGER NOT NULL, UNIQUE(tx_hash, log_index)
    );
    CREATE INDEX trades_launch ON trades(launch_id, block DESC);
    CREATE TABLE cursors (launch_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(launch_id, name));
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, launch_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', tx_hash TEXT, public INTEGER NOT NULL DEFAULT 1, at INTEGER NOT NULL);
    CREATE INDEX events_launch ON events(launch_id, id);
    CREATE TABLE flags (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
    CREATE TABLE pairs (
      address TEXT PRIMARY KEY, symbol TEXT NOT NULL, name TEXT NOT NULL, decimals INTEGER NOT NULL, kind TEXT NOT NULL, logo TEXT, isin TEXT,
      enabled INTEGER NOT NULL DEFAULT 0, approved INTEGER NOT NULL DEFAULT 0, approved_at INTEGER, updated_by TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
    );
  ` },
  // v71.41 (pool-native launches): every trade keeps the pool's price after it, for the chart and the price line.
  { version: 2, name: 'robinhood-launch-pool-native', sql: `
    ALTER TABLE trades ADD COLUMN sqrt_price TEXT NOT NULL DEFAULT '0';
    ALTER TABLE trades ADD COLUMN tick INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE trades ADD COLUMN attributed INTEGER NOT NULL DEFAULT 1;
  ` },
  // v71.41 (Raydium's fee shape, two pools): the holder tax, both pools' fees and the curve pool's id once the coin has
  // moved into its graduation pool (`pool_id` is always the pool trading now).
  { version: 3, name: 'robinhood-launch-two-pools', sql: `
    ALTER TABLE launches ADD COLUMN tax_bps INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE launches ADD COLUMN curve_fee INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE launches ADD COLUMN pool_fee INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE launches ADD COLUMN curve_pool_id TEXT;
  ` },
]);
const big = value => BigInt(String(value ?? '0'));
export const newId = prefix => prefix + '_' + randomBytes(12).toString('base64url');

export class RobinhoodLaunchDatabase {
  constructor(path, { now = Date.now } = {}) {
    if (typeof path !== 'string' || !path) fail('A Robinhood launch database path is required.');
    this.path = path; this.now = now; this.statements = new Map(); this.depth = 0;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    for (const pragma of ['journal_mode=WAL', 'synchronous=FULL', 'foreign_keys=ON', 'busy_timeout=5000', 'temp_store=MEMORY']) this.db.exec('PRAGMA ' + pragma);
  }
  prepare(sql) { let s = this.statements.get(sql); if (!s) { s = this.db.prepare(sql); this.statements.set(sql, s); } return s; }
  run(sql, ...params) { return this.prepare(sql).run(...params); }
  get(sql, ...params) { return this.prepare(sql).get(...params); }
  all(sql, ...params) { return this.prepare(sql).all(...params); }
  transaction(fn) {
    if (this.depth > 0) { this.depth++; try { return fn(); } finally { this.depth--; } }
    this.db.exec('BEGIN IMMEDIATE'); this.depth = 1;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* original error wins */ } throw error; }
    finally { this.depth = 0; }
  }
  version() { try { return this.get('SELECT MAX(version) AS version FROM schema_migrations')?.version || 0; } catch { return 0; } }
  async migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    const release = this.path === ':memory:' ? null : await acquireProcessLock(this.path + '.migrate.lock');
    try {
      for (const m of MIGRATIONS) {
        if (this.get('SELECT version FROM schema_migrations WHERE version = ?', m.version)) continue;
        if (this.version() !== m.version - 1) fail(`The Robinhood launch database is at schema ${this.version()}; migration ${m.version} is out of order.`);
        this.transaction(() => { this.db.exec(m.sql); this.run('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, this.now()); });
      }
      if (this.version() > ROBINHOOD_LAUNCH_SCHEMA_VERSION) fail(`The Robinhood launch database schema ${this.version()} is newer than this release. Install the matching release or restore the pre-upgrade backup.`);
      return this.version();
    } finally { await release?.(); }
  }
  backup(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `robinhood-launch-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}.sqlite`);
    if (existsSync(target)) fail('A backup with the same timestamp already exists.');
    this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    try { const names = readdirSync(directory).filter(n => /^robinhood-launch-.*\.sqlite$/.test(n)).sort(); for (const n of names.slice(0, Math.max(0, names.length - 48))) unlinkSync(join(directory, n)); } catch { /* best effort */ }
    return target;
  }
  checkpoint() { try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* retried next pass */ } }
  integrity() { return this.get('PRAGMA quick_check')?.quick_check === 'ok'; }
  close() { if (!this.db.isOpen) return; try { this.checkpoint(); } finally { this.statements.clear(); this.db.close(); } }
}
export async function openRobinhoodLaunchDatabase(path, options) {
  const db = new RobinhoodLaunchDatabase(path, options);
  try { await db.migrate(); return db; } catch (error) { db.close(); throw error; }
}

const LAUNCH_JSON = ['plan', 'quote', 'option', 'rules'];
const parseLaunch = row => { if (!row) return null; const out = { ...row }; for (const k of LAUNCH_JSON) out[k] = row[k] == null ? null : JSON.parse(row[k]); out.hidden = !!row.hidden; out.archived = !!row.archived; return out; };
const parseOp = row => row ? { ...row, expected: JSON.parse(row.expected || '{}'), receipt: row.receipt ? JSON.parse(row.receipt) : null } : null;
const serialize = (k, v) => LAUNCH_JSON.includes(k) && v != null ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'bigint' ? String(v) : v;

export class RobinhoodLaunchStore {
  constructor(db, { now = Date.now } = {}) { this.db = db; this.now = now; }
  /** Runs `fn` in one database transaction (nested calls join the outer one). */
  transaction(fn) { return this.db.transaction(fn); }
  // --- flags ---
  flags() { const out = {}; for (const r of this.db.all('SELECT name, enabled, reason, updated_by, updated_at FROM flags')) out[r.name] = { enabled: !!r.enabled, reason: r.reason, updatedBy: r.updated_by, updatedAt: r.updated_at }; return out; }
  flag(name) { return !!this.db.get('SELECT enabled FROM flags WHERE name = ?', name)?.enabled; }
  setFlag(name, enabled, { reason = '', by = '' } = {}) { this.db.run('INSERT INTO flags(name, enabled, reason, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = excluded.updated_at', name, enabled ? 1 : 0, reason, by, this.now()); }
  // --- launches ---
  insertLaunch(row) {
    const now = this.now(), cols = Object.keys(row), values = cols.map(k => serialize(k, row[k]));
    this.db.run(`INSERT INTO launches(${cols.join(',')}, created_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, ?, ?)`, ...values, now, now);
    return this.launch(row.id);
  }
  launch(id) { return parseLaunch(this.db.get('SELECT * FROM launches WHERE id = ?', id)); }
  launchByRequest(key) { return parseLaunch(this.db.get('SELECT * FROM launches WHERE request_key = ?', key)); }
  launchByToken(token) { return parseLaunch(this.db.get('SELECT * FROM launches WHERE lower(token) = lower(?)', token)); }
  launchByCurve(curve) { return parseLaunch(this.db.get('SELECT * FROM launches WHERE lower(curve) = lower(?)', curve)); }
  launchesInStates(states) { return this.db.all(`SELECT * FROM launches WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY created_at`, ...states).map(parseLaunch); }
  /**
   * The coins the worker tracks: created, and (when the venue is given) made on it — `curve` is the PoolManager for
   * every pool-native launch (v71.41). A created launch whose `curve` is something else was made by the v71.39 contract
   * set (its bonding-curve contract); it stays in the journal for the record and is left alone (`legacyLaunches`).
   */
  liveLaunches(venue = null) { const rows = this.db.all("SELECT * FROM launches WHERE state = 'created' ORDER BY created_at").map(parseLaunch); return venue ? rows.filter(l => String(l.curve || '').toLowerCase() === String(venue).toLowerCase()) : rows; }
  legacyLaunches(venue) { return this.db.all("SELECT * FROM launches WHERE state = 'created' ORDER BY created_at").map(parseLaunch).filter(l => String(l.curve || '').toLowerCase() !== String(venue).toLowerCase()); }
  launchesWhere({ states = null, exceptStates = null, mode = null, accountId = null, limit = null } = {}) {
    const where = [], params = [], list = values => values.map(() => '?').join(',');
    if (states) { where.push(`state IN (${list(states)})`); params.push(...states); }
    if (exceptStates) { where.push(`state NOT IN (${list(exceptStates)})`); params.push(...exceptStates); }
    if (mode) { where.push('mode = ?'); params.push(mode); }
    if (accountId) { where.push('account_id = ?'); params.push(accountId); }
    if (limit) params.push(limit);
    return this.db.all(`SELECT * FROM launches${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC${limit ? ' LIMIT ?' : ''}`, ...params).map(parseLaunch);
  }
  countLaunches({ accountId, states }) { return this.db.get(`SELECT COUNT(*) AS n FROM launches WHERE account_id = ? AND state IN (${states.map(() => '?').join(',')})`, accountId, ...states)?.n || 0; }
  launchesForReview({ exceptStates, recent }) {
    return this.db.all(`SELECT * FROM launches WHERE state NOT IN (${exceptStates.map(() => '?').join(',')}) OR id IN (SELECT id FROM launches ORDER BY created_at DESC LIMIT ?) ORDER BY created_at DESC`, ...exceptStates, recent).map(parseLaunch);
  }
  updateLaunch(id, fields) {
    const cols = Object.keys(fields); if (!cols.length) return this.launch(id);
    const result = this.db.run(`UPDATE launches SET ${cols.map(c => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...cols.map(k => serialize(k, fields[k])), this.now(), id);
    if (result.changes !== 1) fail('The launch changed or no longer exists.', 'ROBINHOOD_LAUNCH_CONFLICT', 409);
    return this.launch(id);
  }
  /** Compare-and-set on the launch state; false when another worker moved it first. */
  moveLaunch(id, from, to, fields = {}) {
    const states = Array.isArray(from) ? from : [from], cols = Object.keys(fields);
    const result = this.db.run(`UPDATE launches SET state = ?${cols.map(c => ', ' + c + ' = ?').join('')}, updated_at = ? WHERE id = ? AND state IN (${states.map(() => '?').join(',')})`, to, ...cols.map(k => serialize(k, fields[k])), this.now(), id, ...states);
    return result.changes === 1;
  }
  // --- operations ---
  insertOperation(op) {
    const now = this.now();
    this.db.run(`INSERT INTO operations(id, launch_id, kind, state, wallet, hash, raw, nonce, gas, max_fee, expected, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      op.id, op.launchId, op.kind, op.state, op.wallet, op.hash ?? null, op.raw ?? null, op.nonce ?? null, String(op.gas ?? 0), String(op.maxFee ?? 0), JSON.stringify(op.expected || {}), now, now);
    return this.operation(op.id);
  }
  operation(id) { return parseOp(this.db.get('SELECT * FROM operations WHERE id = ?', id)); }
  operationByHash(hash) { return parseOp(this.db.get('SELECT * FROM operations WHERE lower(hash) = lower(?)', hash)); }
  openOperations(launchId) { return this.db.all("SELECT * FROM operations WHERE launch_id = ? AND state IN ('signed','submitted','unknown') ORDER BY created_at", launchId).map(parseOp); }
  allOpenOperations() { return this.db.all("SELECT * FROM operations WHERE state IN ('signed','submitted','unknown') ORDER BY created_at").map(parseOp); }
  operationsFor(launchId, kind) { return this.db.all('SELECT * FROM operations WHERE launch_id = ? AND (? IS NULL OR kind = ?) ORDER BY created_at', launchId, kind ?? null, kind ?? null).map(parseOp); }
  latestOperation(launchId, kind, state) { return parseOp(this.db.get('SELECT * FROM operations WHERE launch_id = ? AND kind = ? AND state = ? ORDER BY created_at DESC LIMIT 1', launchId, kind, state)); }
  countOperations(launchId, kind, since, marker) { return this.db.get('SELECT COUNT(*) AS n FROM operations WHERE launch_id = ? AND kind = ? AND created_at >= ? AND instr(expected, ?) > 0', launchId, kind, since, marker)?.n || 0; }
  /** The highest nonce this store has signed for a wallet (−1 when none), so a restart never reuses one. */
  highestNonce(wallet) { const r = this.db.get('SELECT MAX(nonce) AS n FROM operations WHERE lower(wallet) = lower(?) AND nonce IS NOT NULL AND state != ?', wallet, 'replaced'); return r?.n == null ? -1 : Number(r.n); }
  updateOperation(id, fields) {
    const map = { maxFee: 'max_fee', lastBroadcastAt: 'last_broadcast_at', checkAfter: 'check_after' };
    const cols = Object.keys(fields).map(k => map[k] || k), values = Object.values(fields).map(v => v !== null && typeof v === 'object' ? JSON.stringify(v) : typeof v === 'bigint' ? String(v) : v);
    this.db.run(`UPDATE operations SET ${cols.map(c => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...values, this.now(), id);
    return this.operation(id);
  }
  // --- balances (per role, per asset) ---
  balance(launchId, role, asset) {
    const r = this.db.get('SELECT credited, debited, costs FROM balances WHERE launch_id = ? AND role = ? AND lower(asset) = lower(?)', launchId, role, asset) || { credited: '0', debited: '0', costs: '0' };
    return { credited: big(r.credited), debited: big(r.debited), costs: big(r.costs), available: big(r.credited) - big(r.debited) - big(r.costs) };
  }
  adjust(launchId, role, asset, { credit = 0n, debit = 0n, cost = 0n } = {}) {
    const now = this.now(), current = this.balance(launchId, role, asset);
    const next = { credited: current.credited + big(credit), debited: current.debited + big(debit), costs: current.costs + big(cost) };
    if (next.debited + next.costs > next.credited) fail('A debit would exceed the role’s credited balance.', 'ROBINHOOD_LAUNCH_LEDGER', 409);
    this.db.run('INSERT INTO balances(launch_id, role, asset, credited, debited, costs, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(launch_id, role, asset) DO UPDATE SET credited = excluded.credited, debited = excluded.debited, costs = excluded.costs, updated_at = excluded.updated_at',
      launchId, role, asset.toLowerCase(), String(next.credited), String(next.debited), String(next.costs), now);
    return this.balance(launchId, role, asset);
  }
  balances(launchId) { return this.db.all('SELECT role, asset FROM balances WHERE launch_id = ?', launchId).map(r => ({ role: r.role, asset: r.asset, ...this.balance(launchId, r.role, r.asset) })); }
  // --- fee claims (append-only, one per log) ---
  recordFeeClaim(row) {
    const id = `${row.txHash.toLowerCase()}:${row.logIndex}`;
    if (this.db.get('SELECT id FROM fee_claims WHERE id = ?', id)) return false;
    this.db.transaction(() => {
      this.db.run('INSERT INTO fee_claims(id, launch_id, kind, wallet, role, asset, amount, tx_hash, log_index, block, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, row.launchId, row.kind, row.wallet, row.role, row.asset.toLowerCase(), String(row.amount), row.txHash.toLowerCase(), row.logIndex, row.block, this.now());
      this.adjust(row.launchId, row.role, row.asset, { credit: big(row.amount) });
    });
    return true;
  }
  feeClaims(launchId, limit = 200) { return this.db.all('SELECT * FROM fee_claims WHERE launch_id = ? ORDER BY block DESC, id LIMIT ?', launchId, limit); }
  feeTotals(launchId) { const out = {}; for (const r of this.db.all('SELECT role, asset, amount FROM fee_claims WHERE launch_id = ?', launchId)) { const k = `${r.role}:${r.asset}`; out[k] = String(big(out[k]) + big(r.amount)); } return out; }
  // --- sweeps ---
  insertSweep(row) {
    const now = this.now();
    this.db.run('INSERT INTO sweeps(id, launch_id, kind, operation_id, hash, from_wallet, to_wallet, asset, amount, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.id, row.launchId, row.kind, row.operationId, row.hash ?? null, row.from, row.to, row.asset.toLowerCase(), String(row.amount), row.state || 'pending', now, now);
  }
  sweepForOperation(operationId) { return this.db.get('SELECT * FROM sweeps WHERE operation_id = ?', operationId); }
  updateSweep(id, fields) { const cols = Object.keys(fields); this.db.run(`UPDATE sweeps SET ${cols.map(c => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...Object.values(fields).map(v => typeof v === 'bigint' ? String(v) : v), this.now(), id); }
  sweeps({ kind, state, launchId } = {}) { return this.db.all('SELECT * FROM sweeps WHERE (? IS NULL OR kind = ?) AND (? IS NULL OR state = ?) AND (? IS NULL OR launch_id = ?) ORDER BY created_at', kind ?? null, kind ?? null, state ?? null, state ?? null, launchId ?? null, launchId ?? null); }
  // --- holder balance index (from Transfer logs) ---
  holderBalance(launchId, owner) { return big(this.db.get('SELECT balance FROM holder_balances WHERE launch_id = ? AND lower(owner) = lower(?)', launchId, owner)?.balance); }
  /** Applies Transfer logs to the holder index. A balance that would go below zero means a log was missed before the
   * cursor; it is clamped at zero and reported (`underflows`) rather than stopping the index for good. */
  applyTransfers(launchId, transfers) {
    const now = this.now(); let applied = 0, underflows = 0;
    for (const t of transfers) {
      for (const [owner, delta] of [[t.from, -big(t.value)], [t.to, big(t.value)]]) {
        if (/^0x0{40}$/i.test(owner)) continue;
        let next = this.holderBalance(launchId, owner) + delta;
        if (next < 0n) { underflows += 1; next = 0n; }
        if (next === 0n) this.db.run('DELETE FROM holder_balances WHERE launch_id = ? AND lower(owner) = lower(?)', launchId, owner);
        else this.db.run('INSERT INTO holder_balances(launch_id, owner, balance, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(launch_id, owner) DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at', launchId, owner.toLowerCase(), String(next), now);
      }
      applied += 1;
    }
    return { applied, underflows };
  }
  holders(launchId, { limit = 1000 } = {}) { return this.db.all('SELECT owner, balance FROM holder_balances WHERE launch_id = ? ORDER BY CAST(balance AS REAL) DESC, owner LIMIT ?', launchId, limit).map(r => ({ owner: r.owner, balance: big(r.balance) })); }
  holderCount(launchId, { exclude = [] } = {}) { const skip = new Set(exclude.map(a => a.toLowerCase())); return exclude.length ? this.db.all('SELECT owner FROM holder_balances WHERE launch_id = ?', launchId).filter(r => !skip.has(r.owner.toLowerCase())).length : (this.db.get('SELECT COUNT(*) AS n FROM holder_balances WHERE launch_id = ?', launchId)?.n || 0); }
  addHolderSample(launchId, block, at, balances) { this.db.run('INSERT INTO holder_samples(launch_id, block, at, balances) VALUES (?, ?, ?, ?) ON CONFLICT(launch_id, block) DO NOTHING', launchId, block, at, JSON.stringify(balances)); }
  holderSamples(launchId, since) { return this.db.all('SELECT block, at, balances FROM holder_samples WHERE launch_id = ? AND at >= ? ORDER BY at', launchId, since).map(r => ({ block: r.block, at: r.at, balances: JSON.parse(r.balances) })); }
  pruneHolderSamples(launchId, before) { this.db.run('DELETE FROM holder_samples WHERE launch_id = ? AND at < ?', launchId, before); }
  // --- reward cycles ---
  openRewardCycle(launchId) { const r = this.db.get("SELECT * FROM reward_cycles WHERE launch_id = ? AND state IN ('frozen','paying') ORDER BY created_at LIMIT 1", launchId); return r ? { ...r, payouts: JSON.parse(r.payouts) } : null; }
  rewardCycles(launchId, limit = 20) { return this.db.all('SELECT * FROM reward_cycles WHERE launch_id = ? ORDER BY created_at DESC LIMIT ?', launchId, limit).map(r => ({ ...r, payouts: JSON.parse(r.payouts) })); }
  rewardCycle(id) { const r = this.db.get('SELECT * FROM reward_cycles WHERE id = ?', id); return r ? { ...r, payouts: JSON.parse(r.payouts) } : null; }
  insertRewardCycle(row) { const now = this.now(); this.db.run('INSERT INTO reward_cycles(id, launch_id, state, asset, amount, payouts, window_from, window_to, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', row.id, row.launchId, 'frozen', row.asset.toLowerCase(), String(row.amount), JSON.stringify(row.payouts), row.windowFrom, row.windowTo, now, now); return this.rewardCycle(row.id); }
  updateRewardCycle(id, fields) { const cols = Object.keys(fields); this.db.run(`UPDATE reward_cycles SET ${cols.map(c => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...Object.values(fields).map(v => typeof v === 'bigint' ? String(v) : v !== null && typeof v === 'object' ? JSON.stringify(v) : v), this.now(), id); }
  rewardPaidTotals(launchId) { const out = {}; for (const r of this.db.all('SELECT asset, paid FROM reward_cycles WHERE launch_id = ?', launchId)) out[r.asset] = String(big(out[r.asset]) + big(r.paid)); return out; }
  // --- Diamond Hands streaks ---
  streaks(launchId) { return new Map(this.db.all('SELECT owner, streak, balance FROM holder_streaks WHERE launch_id = ?', launchId).map(r => [r.owner, { streak: r.streak, balance: big(r.balance) }])); }
  setStreaks(launchId, rows) { const now = this.now(); for (const row of rows) this.db.run('INSERT INTO holder_streaks(launch_id, owner, streak, balance, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(launch_id, owner) DO UPDATE SET streak = excluded.streak, balance = excluded.balance, updated_at = excluded.updated_at', launchId, row.owner.toLowerCase(), row.streak, String(row.balance), now); }
  topStreaks(launchId, limit = 10) { return { rows: this.db.all('SELECT owner, streak, balance, updated_at FROM holder_streaks WHERE launch_id = ? AND streak > 0 ORDER BY streak DESC, owner ASC LIMIT ?', launchId, limit), holding: this.db.get('SELECT COUNT(*) AS n FROM holder_streaks WHERE launch_id = ? AND streak > 0', launchId)?.n || 0 }; }
  // --- trades (Buy / Sell events) ---
  recordTrade(row) {
    const id = `${row.txHash.toLowerCase()}:${row.logIndex}`;
    if (this.db.get('SELECT id FROM trades WHERE id = ?', id)) return false;
    this.db.run('INSERT INTO trades(id, launch_id, side, wallet, quote, tokens, fee, tx_hash, log_index, block, at, sqrt_price, tick, attributed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', id, row.launchId, row.side, row.wallet.toLowerCase(), String(row.quote), String(row.tokens), String(row.fee ?? 0), row.txHash.toLowerCase(), row.logIndex, row.block, row.at, String(row.sqrtPrice ?? 0), Number(row.tick ?? 0), row.attributed === false ? 0 : 1);
    return true;
  }
  /** The price path: every trade's price after it, oldest first, for the chart (bounded). */
  priceHistory(launchId, limit = 2000) { return this.db.all('SELECT block, log_index, at, side, quote, tokens, sqrt_price, tick FROM trades WHERE launch_id = ? ORDER BY block DESC, log_index DESC LIMIT ?', launchId, limit).reverse(); }
  trades(launchId, limit = 50) { return this.db.all('SELECT * FROM trades WHERE launch_id = ? ORDER BY block DESC, log_index DESC LIMIT ?', launchId, limit); }
  /** The last day's activity: buys, sells, the pair-asset volume (as a decimal string of raw units) and the latest buy. */
  tradeWindow(launchId, sinceAt) {
    const r = this.db.get("SELECT SUM(CASE WHEN side = 'buy' THEN 1 ELSE 0 END) AS buys, SUM(CASE WHEN side = 'sell' THEN 1 ELSE 0 END) AS sells, SUM(CAST(quote AS REAL)) AS volume, MAX(CASE WHEN side = 'buy' THEN at ELSE NULL END) AS last_buy_at FROM trades WHERE launch_id = ? AND at >= ?", launchId, sinceAt);
    return { buys: r?.buys || 0, sells: r?.sells || 0, volume: r?.volume || 0, lastBuyAt: r?.last_buy_at || null };
  }
  tradeTotals(launchId) { const r = this.db.get("SELECT COUNT(*) AS n, SUM(CAST(quote AS REAL)) AS volume FROM trades WHERE launch_id = ?", launchId); return { count: r?.n || 0, volume: r?.volume || 0 }; }
  // --- cursors / events ---
  cursor(launchId, name) { return this.db.get('SELECT value FROM cursors WHERE launch_id = ? AND name = ?', launchId, name)?.value ?? null; }
  cursorsLike(launchId, prefix) { return this.db.all("SELECT name, value, updated_at FROM cursors WHERE launch_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY updated_at DESC", launchId, prefix.replace(/[\\%_]/g, c => '\\' + c) + '%'); }
  deleteCursor(launchId, name) { this.db.run('DELETE FROM cursors WHERE launch_id = ? AND name = ?', launchId, name); }
  deletePair(address) { this.db.run('DELETE FROM pairs WHERE address = ?', String(address).toLowerCase()); }
  setCursor(launchId, name, value) { this.db.run('INSERT INTO cursors(launch_id, name, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(launch_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', launchId, name, String(value), this.now()); }
  addEvent({ launchId, kind, title, body = '', txHash = null, isPublic = true }) { this.db.run('INSERT INTO events(launch_id, kind, title, body, tx_hash, public, at) VALUES (?, ?, ?, ?, ?, ?, ?)', launchId, kind, title.slice(0, 160), body.slice(0, 600), txHash, isPublic ? 1 : 0, this.now()); }
  events(launchId, { publicOnly = true, limit = 50 } = {}) { return this.db.all(`SELECT kind, title, body, tx_hash, at FROM events WHERE launch_id = ?${publicOnly ? ' AND public = 1' : ''} ORDER BY id DESC LIMIT ?`, launchId, limit); }
  // --- pairs ---
  upsertPair(row) {
    this.db.run(`INSERT INTO pairs(address, symbol, name, decimals, kind, logo, isin, enabled, approved, approved_at, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(address) DO UPDATE SET symbol = excluded.symbol, name = excluded.name, decimals = excluded.decimals, kind = excluded.kind, logo = excluded.logo, isin = excluded.isin, updated_at = excluded.updated_at`,
      row.address.toLowerCase(), row.symbol, row.name, row.decimals, row.kind, row.logo ?? null, row.isin ?? null, row.enabled ? 1 : 0, row.approved ? 1 : 0, row.approvedAt ?? null, row.updatedBy || '', this.now());
  }
  setPairState(address, fields) { const map = { approvedAt: 'approved_at', updatedBy: 'updated_by' }; const cols = Object.keys(fields).map(k => map[k] || k); this.db.run(`UPDATE pairs SET ${cols.map(c => c + ' = ?').join(', ')}, updated_at = ? WHERE address = ?`, ...Object.values(fields).map(v => typeof v === 'boolean' ? (v ? 1 : 0) : v), this.now(), address.toLowerCase()); }
  pair(address) { const r = this.db.get('SELECT * FROM pairs WHERE address = ?', String(address).toLowerCase()); return r ? { ...r, enabled: !!r.enabled, approved: !!r.approved } : null; }
  pairs() { return this.db.all('SELECT * FROM pairs ORDER BY CASE kind WHEN \'native\' THEN 0 WHEN \'stable\' THEN 1 WHEN \'stock\' THEN 2 WHEN \'etf\' THEN 3 ELSE 4 END, symbol').map(r => ({ ...r, enabled: !!r.enabled, approved: !!r.approved })); }
}
