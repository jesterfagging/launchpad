// Pump.fun Classic: durable state in Node's bundled SQLite (WAL, FULL sync).
//
// One database file under the data directory. Money is TEXT decimal (BigInt in
// JS). Operations keep the exact signed bytes BEFORE broadcast; fee receipts are
// append-only with a unique (signature, event, recipient) identity; strategy
// capital credits are unique per receipt. Per-role balances are updated in the
// same transaction as the journal row that moves them, so a crash can never
// record one without the other.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { acquireProcessLock } from '../process-lock.mjs';

const fail = (message, code = 'PUMP_CLASSIC_STORE', statusCode = 503) => { throw Object.assign(Error(message), { code, statusCode }); };
export const PUMP_CLASSIC_SCHEMA_VERSION = 4;
const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const MIGRATIONS = Object.freeze([
  { version: 1, name: 'pump-classic-core', sql: `
    CREATE TABLE launches (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE, mode TEXT NOT NULL,
      policy_version TEXT NOT NULL, policy_hash TEXT NOT NULL,
      name TEXT NOT NULL, symbol TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '',
      website TEXT NOT NULL DEFAULT '', twitter TEXT NOT NULL DEFAULT '', telegram TEXT NOT NULL DEFAULT '',
      metadata_uri TEXT NOT NULL DEFAULT '', gotchi TEXT, agent TEXT,
      developer_wallet TEXT NOT NULL DEFAULT '', launch_wallet TEXT NOT NULL UNIQUE, protocol_wallet TEXT NOT NULL UNIQUE,
      mode_wallet TEXT UNIQUE, mint TEXT NOT NULL UNIQUE, recipient TEXT NOT NULL DEFAULT '',
      dev_buy_lamports TEXT NOT NULL DEFAULT '0', seed_lamports TEXT NOT NULL DEFAULT '0', plan TEXT NOT NULL, quote TEXT NOT NULL, quote_expires_at INTEGER NOT NULL,
      funding_signature TEXT UNIQUE, funded_lamports TEXT NOT NULL DEFAULT '0', funded_at INTEGER,
      state TEXT NOT NULL, state_reason TEXT NOT NULL DEFAULT '', create_attempts INTEGER NOT NULL DEFAULT 0,
      create_signature TEXT UNIQUE, created_slot INTEGER, live_at INTEGER,
      dev_tokens TEXT NOT NULL DEFAULT '0', delivery_state TEXT NOT NULL DEFAULT 'none', fee_state TEXT NOT NULL DEFAULT 'pending',
      shareholders TEXT NOT NULL DEFAULT '[]', venue_state TEXT NOT NULL DEFAULT 'curve', pool TEXT, graduated_at INTEGER,
      refund_state TEXT NOT NULL DEFAULT 'none', refund_signature TEXT, refunded_lamports TEXT NOT NULL DEFAULT '0',
      hidden INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX launches_account ON launches(account_id, created_at);
    CREATE INDEX launches_state ON launches(state);
    CREATE TABLE operations (
      id TEXT PRIMARY KEY, launch_id TEXT NOT NULL REFERENCES launches(id), kind TEXT NOT NULL, state TEXT NOT NULL,
      wallet TEXT NOT NULL, signature TEXT UNIQUE, raw TEXT, raw_hash TEXT, unsigned TEXT, version INTEGER NOT NULL DEFAULT 0,
      blockhash TEXT, last_valid_block_height INTEGER, prepared_slot INTEGER,
      expected TEXT NOT NULL DEFAULT '{}', receipt TEXT, error TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0, last_broadcast_at INTEGER, check_after INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX operations_launch ON operations(launch_id, state);
    CREATE INDEX operations_open ON operations(state, check_after);
    CREATE TABLE fee_receipts (
      id TEXT PRIMARY KEY, launch_id TEXT NOT NULL REFERENCES launches(id), mint TEXT NOT NULL, signature TEXT NOT NULL, event_index INTEGER NOT NULL,
      recipient TEXT NOT NULL, role TEXT NOT NULL, amount TEXT NOT NULL, distributed TEXT NOT NULL, slot INTEGER NOT NULL, block_time INTEGER,
      caller TEXT NOT NULL DEFAULT '', ours INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
      UNIQUE(signature, event_index, recipient)
    );
    CREATE INDEX fee_receipts_launch ON fee_receipts(launch_id, slot);
    CREATE TABLE balances (
      launch_id TEXT NOT NULL REFERENCES launches(id), role TEXT NOT NULL, credited TEXT NOT NULL DEFAULT '0', debited TEXT NOT NULL DEFAULT '0', costs TEXT NOT NULL DEFAULT '0',
      updated_at INTEGER NOT NULL, PRIMARY KEY(launch_id, role)
    );
    CREATE TABLE sweeps (
      id TEXT PRIMARY KEY, launch_id TEXT NOT NULL REFERENCES launches(id), kind TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, signature TEXT UNIQUE,
      from_wallet TEXT NOT NULL, to_wallet TEXT NOT NULL, amount TEXT NOT NULL, fee TEXT NOT NULL DEFAULT '0', state TEXT NOT NULL, slot INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX sweeps_kind ON sweeps(kind, state);
    CREATE TABLE cursors (launch_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(launch_id, name));
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, launch_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', signature TEXT, public INTEGER NOT NULL DEFAULT 1, at INTEGER NOT NULL);
    CREATE INDEX events_launch ON events(launch_id, id);
    CREATE TABLE flags (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT '', updated_by TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
    CREATE TABLE strategies (
      launch_id TEXT PRIMARY KEY REFERENCES launches(id), kind TEXT NOT NULL, wallet TEXT NOT NULL UNIQUE,
      desired TEXT NOT NULL DEFAULT 'active', observed TEXT NOT NULL DEFAULT 'waiting_for_fees', pause_reason TEXT NOT NULL DEFAULT '',
      contributed TEXT NOT NULL DEFAULT '0', cash TEXT NOT NULL DEFAULT '0', tokens TEXT NOT NULL DEFAULT '0', lp TEXT NOT NULL DEFAULT '0',
      fees_spent TEXT NOT NULL DEFAULT '0', day_key TEXT NOT NULL DEFAULT '', day_turnover TEXT NOT NULL DEFAULT '0', day_fees TEXT NOT NULL DEFAULT '0',
      last_action_at INTEGER NOT NULL DEFAULT 0, last_side TEXT NOT NULL DEFAULT '', last_price TEXT NOT NULL DEFAULT '0', failures INTEGER NOT NULL DEFAULT 0,
      high_water TEXT NOT NULL DEFAULT '0', last_value TEXT NOT NULL DEFAULT '0', last_valued_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );
    CREATE TABLE strategy_credits (receipt_id TEXT PRIMARY KEY, launch_id TEXT NOT NULL REFERENCES launches(id), kind TEXT NOT NULL, amount TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE holder_samples (launch_id TEXT NOT NULL REFERENCES launches(id), slot INTEGER NOT NULL, at INTEGER NOT NULL, balances TEXT NOT NULL, PRIMARY KEY(launch_id, slot));
    CREATE TABLE reward_cycles (
      id TEXT PRIMARY KEY, launch_id TEXT NOT NULL REFERENCES launches(id), state TEXT NOT NULL, amount TEXT NOT NULL, payouts TEXT NOT NULL,
      next_index INTEGER NOT NULL DEFAULT 0, paid TEXT NOT NULL DEFAULT '0', window_from INTEGER NOT NULL, window_to INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX reward_cycles_open ON reward_cycles(launch_id, state);
    CREATE TABLE reward_debts (launch_id TEXT NOT NULL REFERENCES launches(id), owner TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY(launch_id, owner));
  ` },
  // v71.19: coins paired with a quote asset other than SOL. Existing rows are SOL
  // coins; their defaults describe exactly what they already are.
  { version: 2, name: 'pump-classic-quote-assets', sql: `
    ALTER TABLE launches ADD COLUMN quote_mint TEXT NOT NULL DEFAULT 'So11111111111111111111111111111111111111112';
    ALTER TABLE launches ADD COLUMN quote_program TEXT NOT NULL DEFAULT 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    ALTER TABLE launches ADD COLUMN quote_decimals INTEGER NOT NULL DEFAULT 9;
    ALTER TABLE launches ADD COLUMN quote_symbol TEXT NOT NULL DEFAULT 'SOL';
    ALTER TABLE launches ADD COLUMN quote_kind TEXT NOT NULL DEFAULT 'sol';
    ALTER TABLE launches ADD COLUMN quote_control INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE launches ADD COLUMN quote_reserves TEXT NOT NULL DEFAULT '0';
    ALTER TABLE launches ADD COLUMN sol_reserves TEXT NOT NULL DEFAULT '0';
    ALTER TABLE launches ADD COLUMN creator_fee_bps INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE launches ADD COLUMN dev_buy_raw TEXT NOT NULL DEFAULT '0';
    ALTER TABLE launches ADD COLUMN funded_quote TEXT NOT NULL DEFAULT '0';
    ALTER TABLE launches ADD COLUMN quote_refund_state TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE launches ADD COLUMN quote_refund_signature TEXT;
    ALTER TABLE launches ADD COLUMN refunded_quote TEXT NOT NULL DEFAULT '0';
    ALTER TABLE fee_receipts ADD COLUMN quote_mint TEXT NOT NULL DEFAULT 'So11111111111111111111111111111111111111112';
    CREATE TABLE quote_balances (
      launch_id TEXT NOT NULL REFERENCES launches(id), role TEXT NOT NULL, credited TEXT NOT NULL DEFAULT '0', converted TEXT NOT NULL DEFAULT '0',
      updated_at INTEGER NOT NULL, PRIMARY KEY(launch_id, role)
    );
    CREATE TABLE conversions (
      id TEXT PRIMARY KEY, launch_id TEXT NOT NULL REFERENCES launches(id), role TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE, signature TEXT UNIQUE,
      wallet TEXT NOT NULL, quote_mint TEXT NOT NULL, input TEXT NOT NULL, output TEXT NOT NULL DEFAULT '0', fee TEXT NOT NULL DEFAULT '0', state TEXT NOT NULL, slot INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX conversions_launch ON conversions(launch_id, state);
  ` },
  // v71.35: Diamond Hands, Earned and Insured. The option (its settings and
  // lifecycle state) is one JSON document on the launch; Diamond Hands keeps a
  // streak ledger per holder. Existing rows have no option.
  { version: 3, name: 'pump-classic-launch-options', sql: `
    ALTER TABLE launches ADD COLUMN option TEXT;
    CREATE TABLE holder_streaks (
      launch_id TEXT NOT NULL REFERENCES launches(id), owner TEXT NOT NULL, streak INTEGER NOT NULL DEFAULT 0, balance TEXT NOT NULL DEFAULT '0',
      updated_at INTEGER NOT NULL, PRIMARY KEY(launch_id, owner)
    );
    CREATE INDEX holder_streaks_rank ON holder_streaks(launch_id, streak DESC);
  ` },
  // v71.35: reward baskets for Holders coins. The basket (its assets) is one
  // JSON document on the launch; each extra asset keeps a raw-unit ledger of
  // what the rewards wallet bought and paid out; a reward cycle paid in an
  // extra asset records that asset's mint (null: SOL or the pair asset, as
  // before). Existing rows have no basket.
  { version: 4, name: 'pump-classic-reward-baskets', sql: `
    ALTER TABLE launches ADD COLUMN basket TEXT;
    ALTER TABLE reward_cycles ADD COLUMN mint TEXT;
    CREATE TABLE basket_ledger (
      launch_id TEXT NOT NULL REFERENCES launches(id), mint TEXT NOT NULL, credited TEXT NOT NULL DEFAULT '0', paid TEXT NOT NULL DEFAULT '0',
      payments INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(launch_id, mint)
    );
  ` },
]);
const big = value => BigInt(String(value ?? '0'));
export const newId = prefix => prefix + '_' + randomBytes(12).toString('base64url');

export class PumpClassicDatabase {
  constructor(path, { now = Date.now } = {}) {
    if (typeof path !== 'string' || !path) fail('A Pump.fun Classic database path is required.');
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
        if (this.version() !== m.version - 1) fail(`The Pump.fun Classic database is at schema ${this.version()}; migration ${m.version} is out of order.`);
        this.transaction(() => { this.db.exec(m.sql); this.run('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, this.now()); });
      }
      if (this.version() > PUMP_CLASSIC_SCHEMA_VERSION) fail(`The Pump.fun Classic database schema ${this.version()} is newer than this release. Install the matching release or restore the pre-upgrade backup.`);
      return this.version();
    } finally { await release?.(); }
  }
  backup(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `pump-classic-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}.sqlite`);
    if (existsSync(target)) fail('A backup with the same timestamp already exists.');
    this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    try { const names = readdirSync(directory).filter(n => /^pump-classic-.*\.sqlite$/.test(n)).sort(); for (const n of names.slice(0, Math.max(0, names.length - 48))) unlinkSync(join(directory, n)); } catch { /* best effort */ }
    return target;
  }
  checkpoint() { try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* retried next pass */ } }
  integrity() { return this.get('PRAGMA quick_check')?.quick_check === 'ok'; }
  close() { if (!this.db.isOpen) return; try { this.checkpoint(); } finally { this.statements.clear(); this.db.close(); } }
}
export async function openPumpClassicDatabase(path, options) {
  const db = new PumpClassicDatabase(path, options);
  try { await db.migrate(); return db; } catch (error) { db.close(); throw error; }
}

const LAUNCH_JSON = ['plan', 'quote', 'gotchi', 'agent', 'shareholders', 'option', 'basket'];
const parseLaunch = row => { if (!row) return null; const out = { ...row }; for (const k of LAUNCH_JSON) out[k] = row[k] == null ? null : JSON.parse(row[k]); out.hidden = !!row.hidden; out.archived = !!row.archived; return out; };
const parseOp = row => row ? { ...row, expected: JSON.parse(row.expected || '{}'), receipt: row.receipt ? JSON.parse(row.receipt) : null } : null;

export class PumpClassicStore {
  constructor(db, { now = Date.now } = {}) { this.db = db; this.now = now; }
  // --- flags ---
  flags() { const out = {}; for (const r of this.db.all('SELECT name, enabled, reason, updated_by, updated_at FROM flags')) out[r.name] = { enabled: !!r.enabled, reason: r.reason, updatedBy: r.updated_by, updatedAt: r.updated_at }; return out; }
  flag(name) { return !!this.db.get('SELECT enabled FROM flags WHERE name = ?', name)?.enabled; }
  setFlag(name, enabled, { reason = '', by = '' } = {}) { this.db.run('INSERT INTO flags(name, enabled, reason, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET enabled = excluded.enabled, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = excluded.updated_at', name, enabled ? 1 : 0, reason, by, this.now()); }
  // --- launches ---
  insertLaunch(row) {
    const now = this.now(), cols = Object.keys(row), values = cols.map(k => LAUNCH_JSON.includes(k) && row[k] != null ? JSON.stringify(row[k]) : typeof row[k] === 'boolean' ? (row[k] ? 1 : 0) : row[k]);
    this.db.run(`INSERT INTO launches(${cols.join(',')}, created_at, updated_at) VALUES (${cols.map(() => '?').join(',')}, ?, ?)`, ...values, now, now);
    return this.launch(row.id);
  }
  launch(id) { return parseLaunch(this.db.get('SELECT * FROM launches WHERE id = ?', id)); }
  launchByRequest(key) { return parseLaunch(this.db.get('SELECT * FROM launches WHERE request_key = ?', key)); }
  launchByMint(mint) { return parseLaunch(this.db.get('SELECT * FROM launches WHERE mint = ?', mint)); }
  launchesForAccount(accountId, limit = 50) { return this.db.all('SELECT * FROM launches WHERE account_id = ? ORDER BY created_at DESC LIMIT ?', accountId, limit).map(parseLaunch); }
  launchesInStates(states) { return this.db.all(`SELECT * FROM launches WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY created_at`, ...states).map(parseLaunch); }
  liveLaunches() { return this.db.all("SELECT * FROM launches WHERE state = 'created' ORDER BY created_at").map(parseLaunch); }
  allLaunches(limit = 500) { return this.db.all('SELECT * FROM launches ORDER BY created_at DESC LIMIT ?', limit).map(parseLaunch); }
  /**
   * Launches newest first (the order of allLaunches) with no row cap unless `limit` is given: `states` keeps only
   * those states, `exceptStates` drops them, `mode` and `accountId` narrow further. Lists of live coins read them by
   * state, so abandoned quotes (every review adds a row) can never push a live coin out of a list.
   */
  launchesWhere({ states = null, exceptStates = null, mode = null, accountId = null, limit = null } = {}) {
    const where = [], params = [], list = values => values.map(() => '?').join(',');
    if (states) { where.push(`state IN (${list(states)})`); params.push(...states); }
    if (exceptStates) { where.push(`state NOT IN (${list(exceptStates)})`); params.push(...exceptStates); }
    if (mode) { where.push('mode = ?'); params.push(mode); }
    if (accountId) { where.push('account_id = ?'); params.push(accountId); }
    if (limit) params.push(limit);
    return this.db.all(`SELECT * FROM launches${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC${limit ? ' LIMIT ?' : ''}`, ...params).map(parseLaunch);
  }
  /** An account's launches in `states`. */
  countLaunches({ accountId, states }) { return this.db.get(`SELECT COUNT(*) AS n FROM launches WHERE account_id = ? AND state IN (${states.map(() => '?').join(',')})`, accountId, ...states)?.n || 0; }
  /** Operator views, newest first: every launch outside `exceptStates` (no cap) plus the newest `recent` launches in any state. */
  launchesForReview({ exceptStates, recent }) {
    return this.db.all(`SELECT * FROM launches WHERE state NOT IN (${exceptStates.map(() => '?').join(',')}) OR id IN (SELECT id FROM launches ORDER BY created_at DESC LIMIT ?) ORDER BY created_at DESC`, ...exceptStates, recent).map(parseLaunch);
  }
  updateLaunch(id, fields) {
    const cols = Object.keys(fields); if (!cols.length) return this.launch(id);
    const values = cols.map(k => LAUNCH_JSON.includes(k) && fields[k] != null ? JSON.stringify(fields[k]) : typeof fields[k] === 'boolean' ? (fields[k] ? 1 : 0) : fields[k]);
    const result = this.db.run(`UPDATE launches SET ${cols.map(c => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...values, this.now(), id);
    if (result.changes !== 1) fail('The launch changed or no longer exists.', 'PUMP_CLASSIC_CONFLICT', 409);
    return this.launch(id);
  }
  /** Compare-and-set of a launch's mint and metadata address while the launch is in one of `states` (a vanity address replacing the quoted one). */
  switchMint(id, { from, to, uri, states }) {
    const result = this.db.run(`UPDATE launches SET mint = ?, metadata_uri = ?, updated_at = ? WHERE id = ? AND mint = ? AND state IN (${states.map(() => '?').join(',')})`, to, uri, this.now(), id, from, ...states);
    return result.changes === 1;
  }
  /** Compare-and-set on the launch state; returns false when another worker moved it first. */
  moveLaunch(id, from, to, fields = {}) {
    const cols = Object.keys(fields), values = cols.map(k => LAUNCH_JSON.includes(k) && fields[k] != null ? JSON.stringify(fields[k]) : fields[k]);
    const result = this.db.run(`UPDATE launches SET state = ?${cols.map(c => ', ' + c + ' = ?').join('')}, updated_at = ? WHERE id = ? AND state IN (${(Array.isArray(from) ? from : [from]).map(() => '?').join(',')})`, to, ...values, this.now(), id, ...(Array.isArray(from) ? from : [from]));
    return result.changes === 1;
  }
  // --- operations ---
  insertOperation(op) {
    const now = this.now();
    this.db.run(`INSERT INTO operations(id, launch_id, kind, state, wallet, signature, raw, raw_hash, unsigned, version, blockhash, last_valid_block_height, prepared_slot, expected, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, op.id, op.launchId, op.kind, op.state, op.wallet, op.signature ?? null, op.raw ?? null, op.rawHash ?? null, op.unsigned ?? null,
      op.version ?? 0, op.blockhash ?? null, op.lastValidBlockHeight ?? null, op.preparedSlot ?? null, JSON.stringify(op.expected || {}), now, now);
    return this.operation(op.id);
  }
  operation(id) { return parseOp(this.db.get('SELECT * FROM operations WHERE id = ?', id)); }
  operationBySignature(signature) { return parseOp(this.db.get('SELECT * FROM operations WHERE signature = ?', signature)); }
  openOperations(launchId) { return this.db.all("SELECT * FROM operations WHERE launch_id = ? AND state IN ('awaiting_signature','signed','submitted','unknown') ORDER BY created_at", launchId).map(parseOp); }
  allOpenOperations() { return this.db.all("SELECT * FROM operations WHERE state IN ('signed','submitted','unknown') ORDER BY created_at").map(parseOp); }
  operationsFor(launchId, kind) { return this.db.all('SELECT * FROM operations WHERE launch_id = ? AND (? IS NULL OR kind = ?) ORDER BY created_at', launchId, kind ?? null, kind ?? null).map(parseOp); }
  updateOperation(id, fields) {
    const map = { lastValidBlockHeight: 'last_valid_block_height', preparedSlot: 'prepared_slot', rawHash: 'raw_hash', lastBroadcastAt: 'last_broadcast_at', checkAfter: 'check_after' };
    const cols = Object.keys(fields).map(k => map[k] || k), values = Object.values(fields).map(v => v !== null && typeof v === 'object' ? JSON.stringify(v) : v);
    this.db.run(`UPDATE operations SET ${cols.map(c => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...values, this.now(), id);
    return this.operation(id);
  }
  // --- balances ---
  balance(launchId, role) {
    const r = this.db.get('SELECT credited, debited, costs FROM balances WHERE launch_id = ? AND role = ?', launchId, role) || { credited: '0', debited: '0', costs: '0' };
    return { credited: big(r.credited), debited: big(r.debited), costs: big(r.costs), available: big(r.credited) - big(r.debited) - big(r.costs) };
  }
  adjust(launchId, role, { credit = 0n, debit = 0n, cost = 0n } = {}) {
    const now = this.now(), current = this.balance(launchId, role);
    const next = { credited: current.credited + big(credit), debited: current.debited + big(debit), costs: current.costs + big(cost) };
    this.db.run('INSERT INTO balances(launch_id, role, credited, debited, costs, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(launch_id, role) DO UPDATE SET credited = excluded.credited, debited = excluded.debited, costs = excluded.costs, updated_at = excluded.updated_at',
      launchId, role, String(next.credited), String(next.debited), String(next.costs), now);
    return this.balance(launchId, role);
  }
  balances(launchId) { return Object.fromEntries(this.db.all('SELECT role FROM balances WHERE launch_id = ?', launchId).map(r => [r.role, this.balance(launchId, r.role)])); }
  // --- fee receipts ---
  /**
   * Records one distribution leg exactly once. Returns false for a duplicate.
   * A leg in another quote asset (`quoteMint`) credits that role's quote ledger;
   * it reaches the SOL ledger only through a verified conversion.
   */
  recordFeeReceipt(row) {
    const id = `${row.signature}:${row.eventIndex}:${row.recipient}`, quoteMint = row.quoteMint || SOL_MINT, native = quoteMint === SOL_MINT;
    if (this.db.get('SELECT id FROM fee_receipts WHERE id = ?', id)) return false;
    if (!native && row.role === 'strategy') fail('Strategy capital is only credited in SOL.', 'PUMP_CLASSIC_STRATEGY', 409);
    this.db.transaction(() => {
      this.db.run(`INSERT INTO fee_receipts(id, launch_id, mint, signature, event_index, recipient, role, amount, distributed, slot, block_time, caller, ours, quote_mint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, row.launchId, row.mint, row.signature, row.eventIndex, row.recipient, row.role, String(row.amount), String(row.distributed), row.slot, row.blockTime ?? null, row.caller || '', row.ours ? 1 : 0, quoteMint, this.now());
      if (native) this.adjust(row.launchId, row.role, { credit: big(row.amount) }); else this.adjustQuote(row.launchId, row.role, { credit: big(row.amount) });
      if (row.role === 'strategy') this.creditStrategy(row.launchId, id, row.amount, 'fee');
    });
    return true;
  }
  // --- quote-asset ledger (coins on another pair) ---
  quoteBalance(launchId, role) {
    const r = this.db.get('SELECT credited, converted FROM quote_balances WHERE launch_id = ? AND role = ?', launchId, role) || { credited: '0', converted: '0' };
    return { credited: big(r.credited), converted: big(r.converted), available: big(r.credited) - big(r.converted) };
  }
  adjustQuote(launchId, role, { credit = 0n, converted = 0n } = {}) {
    const current = this.quoteBalance(launchId, role), next = { credited: current.credited + big(credit), converted: current.converted + big(converted) };
    if (next.converted > next.credited) fail('A conversion would exceed the credited quote-asset receipts.', 'PUMP_CLASSIC_LEDGER', 409);
    this.db.run('INSERT INTO quote_balances(launch_id, role, credited, converted, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(launch_id, role) DO UPDATE SET credited = excluded.credited, converted = excluded.converted, updated_at = excluded.updated_at',
      launchId, role, String(next.credited), String(next.converted), this.now());
    return this.quoteBalance(launchId, role);
  }
  quoteBalances(launchId) { return Object.fromEntries(this.db.all('SELECT role FROM quote_balances WHERE launch_id = ?', launchId).map(r => [r.role, this.quoteBalance(launchId, r.role)])); }
  // --- conversions of quote-asset fee shares to SOL ---
  insertConversion(row) {
    const now = this.now();
    this.db.run('INSERT INTO conversions(id, launch_id, role, operation_id, signature, wallet, quote_mint, input, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.id, row.launchId, row.role, row.operationId, row.signature ?? null, row.wallet, row.quoteMint, String(row.input), row.state || 'pending', now, now);
  }
  conversionForOperation(operationId) { return this.db.get('SELECT * FROM conversions WHERE operation_id = ?', operationId); }
  updateConversion(id, fields) { const cols = Object.keys(fields); this.db.run(`UPDATE conversions SET ${cols.map(c => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...Object.values(fields).map(v => typeof v === 'bigint' ? String(v) : v), this.now(), id); }
  conversions({ launchId, state, role } = {}) {
    return this.db.all('SELECT * FROM conversions WHERE (? IS NULL OR launch_id = ?) AND (? IS NULL OR state = ?) AND (? IS NULL OR role = ?) ORDER BY created_at', launchId ?? null, launchId ?? null, state ?? null, state ?? null, role ?? null, role ?? null);
  }
  feeReceipts(launchId, limit = 200) { return this.db.all('SELECT * FROM fee_receipts WHERE launch_id = ? ORDER BY slot DESC, id LIMIT ?', launchId, limit); }
  feeTotals(launchId) {
    const rows = this.db.all('SELECT role, amount FROM fee_receipts WHERE launch_id = ?', launchId), out = {};
    for (const r of rows) out[r.role] = String(big(out[r.role]) + big(r.amount));
    return out;
  }
  knownDistribution(signature) { return !!this.db.get('SELECT id FROM fee_receipts WHERE signature = ? LIMIT 1', signature); }
  // --- sweeps ---
  insertSweep(row) {
    const now = this.now();
    this.db.run('INSERT INTO sweeps(id, launch_id, kind, operation_id, signature, from_wallet, to_wallet, amount, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      row.id, row.launchId, row.kind, row.operationId, row.signature ?? null, row.from, row.to, String(row.amount), row.state || 'pending', now, now);
  }
  sweepForOperation(operationId) { return this.db.get('SELECT * FROM sweeps WHERE operation_id = ?', operationId); }
  updateSweep(id, fields) { const cols = Object.keys(fields); this.db.run(`UPDATE sweeps SET ${cols.map(c => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...Object.values(fields), this.now(), id); }
  sweeps({ kind, state, launchId } = {}) {
    return this.db.all('SELECT * FROM sweeps WHERE (? IS NULL OR kind = ?) AND (? IS NULL OR state = ?) AND (? IS NULL OR launch_id = ?) ORDER BY created_at', kind ?? null, kind ?? null, state ?? null, state ?? null, launchId ?? null, launchId ?? null);
  }
  // --- cursors / events ---
  cursor(launchId, name) { return this.db.get('SELECT value FROM cursors WHERE launch_id = ? AND name = ?', launchId, name)?.value ?? null; }
  setCursor(launchId, name, value) { this.db.run('INSERT INTO cursors(launch_id, name, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(launch_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', launchId, name, String(value), this.now()); }
  addEvent({ launchId, kind, title, body = '', signature = null, isPublic = true }) { this.db.run('INSERT INTO events(launch_id, kind, title, body, signature, public, at) VALUES (?, ?, ?, ?, ?, ?, ?)', launchId, kind, title.slice(0, 160), body.slice(0, 600), signature, isPublic ? 1 : 0, this.now()); }
  events(launchId, { publicOnly = true, limit = 50 } = {}) { return this.db.all(`SELECT kind, title, body, signature, at FROM events WHERE launch_id = ?${publicOnly ? ' AND public = 1' : ''} ORDER BY id DESC LIMIT ?`, launchId, limit); }
  // --- strategies ---
  ensureStrategy(launchId, kind, wallet) {
    this.db.run("INSERT INTO strategies(launch_id, kind, wallet, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(launch_id) DO NOTHING", launchId, kind, wallet, this.now());
    return this.strategy(launchId);
  }
  strategy(launchId) { return this.db.get('SELECT * FROM strategies WHERE launch_id = ?', launchId) || null; }
  strategies() { return this.db.all('SELECT * FROM strategies ORDER BY launch_id'); }
  updateStrategy(launchId, fields) { const cols = Object.keys(fields); if (!cols.length) return this.strategy(launchId); this.db.run(`UPDATE strategies SET ${cols.map(c => c + ' = ?').join(', ')}, updated_at = ? WHERE launch_id = ?`, ...Object.values(fields).map(v => typeof v === 'bigint' ? String(v) : v), this.now(), launchId); return this.strategy(launchId); }
  /** creditCapital: idempotent per receipt id; adds to contributed capital and cash, never to profit. */
  creditStrategy(launchId, receiptId, amount, kind) {
    if (this.db.get('SELECT receipt_id FROM strategy_credits WHERE receipt_id = ?', receiptId)) return false;
    const s = this.strategy(launchId); if (!s) fail('No strategy exists for this launch.', 'PUMP_CLASSIC_STRATEGY');
    this.db.transaction(() => {
      this.db.run('INSERT INTO strategy_credits(receipt_id, launch_id, kind, amount, at) VALUES (?, ?, ?, ?, ?)', receiptId, launchId, kind, String(amount), this.now());
      this.db.run('UPDATE strategies SET contributed = ?, cash = ?, updated_at = ? WHERE launch_id = ?', String(big(s.contributed) + big(amount)), String(big(s.cash) + big(amount)), this.now(), launchId);
    });
    return true;
  }
  strategyCredits(launchId) { return this.db.all('SELECT * FROM strategy_credits WHERE launch_id = ? ORDER BY at', launchId); }
  // --- holder rewards ---
  addHolderSample(launchId, slot, at, balances) { this.db.run('INSERT INTO holder_samples(launch_id, slot, at, balances) VALUES (?, ?, ?, ?) ON CONFLICT(launch_id, slot) DO NOTHING', launchId, slot, at, JSON.stringify(balances)); }
  holderSamples(launchId, since) { return this.db.all('SELECT slot, at, balances FROM holder_samples WHERE launch_id = ? AND at >= ? ORDER BY at', launchId, since).map(r => ({ slot: r.slot, at: r.at, balances: JSON.parse(r.balances) })); }
  pruneHolderSamples(launchId, before) { this.db.run('DELETE FROM holder_samples WHERE launch_id = ? AND at < ?', launchId, before); }
  openRewardCycle(launchId) { const r = this.db.get("SELECT * FROM reward_cycles WHERE launch_id = ? AND state IN ('frozen','paying') ORDER BY created_at LIMIT 1", launchId); return r ? { ...r, payouts: JSON.parse(r.payouts) } : null; }
  rewardCycles(launchId, limit = 20) { return this.db.all('SELECT * FROM reward_cycles WHERE launch_id = ? ORDER BY created_at DESC LIMIT ?', launchId, limit).map(r => ({ ...r, payouts: JSON.parse(r.payouts) })); }
  rewardCycle(id) { const r = this.db.get('SELECT * FROM reward_cycles WHERE id = ?', id); return r ? { ...r, payouts: JSON.parse(r.payouts) } : null; }
  /** Paid totals of a coin's reward cycles: SOL cycles in lamports, pair-asset cycles (v71.24, payouts carry `tokens`) in raw pair
   * units; a basket asset's cycles (v71.35, `mint` set) are counted under that mint instead. */
  rewardPaidTotals(launchId) {
    let sol = 0n, tokens = 0n; const basket = {};
    for (const r of this.db.all(`SELECT paid, mint, instr(payouts, '"tokens"') > 0 AS token FROM reward_cycles WHERE launch_id = ?`, launchId)) { if (r.mint) basket[r.mint] = (basket[r.mint] || 0n) + big(r.paid); else if (r.token) tokens += big(r.paid); else sol += big(r.paid); }
    return { sol, tokens, basket };
  }
  /** The newest operation of a kind in a state (indexed by launch). */
  latestOperation(launchId, kind, state) { return parseOp(this.db.get('SELECT * FROM operations WHERE launch_id = ? AND kind = ? AND state = ? ORDER BY created_at DESC LIMIT 1', launchId, kind, state)); }
  /** Operations of a kind created since `since` whose saved expectations contain `marker` (for example a purpose). */
  countOperations(launchId, kind, since, marker) { return this.db.get('SELECT COUNT(*) AS n FROM operations WHERE launch_id = ? AND kind = ? AND created_at >= ? AND instr(expected, ?) > 0', launchId, kind, since, marker)?.n || 0; }
  insertRewardCycle(row) { const now = this.now(); this.db.run('INSERT INTO reward_cycles(id, launch_id, state, amount, payouts, window_from, window_to, mint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', row.id, row.launchId, 'frozen', String(row.amount), JSON.stringify(row.payouts), row.windowFrom, row.windowTo, row.mint || null, now, now); }
  updateRewardCycle(id, fields) { const cols = Object.keys(fields); this.db.run(`UPDATE reward_cycles SET ${cols.map(c => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, ...Object.values(fields).map(v => typeof v === 'bigint' ? String(v) : v), this.now(), id); }
  rewardDebts(launchId) { return this.db.all('SELECT owner, amount FROM reward_debts WHERE launch_id = ?', launchId); }
  setRewardDebt(launchId, owner, amount) { if (big(amount) === 0n) this.db.run('DELETE FROM reward_debts WHERE launch_id = ? AND owner = ?', launchId, owner); else this.db.run('INSERT INTO reward_debts(launch_id, owner, amount) VALUES (?, ?, ?) ON CONFLICT(launch_id, owner) DO UPDATE SET amount = excluded.amount', launchId, owner, String(amount)); }
  // --- Reward baskets (v71.35): one raw-unit ledger per extra asset ---
  /** What the rewards wallet bought of an extra asset, what it paid out, and the difference still to pay. */
  basketBalance(launchId, mint) {
    const r = this.db.get('SELECT credited, paid, payments FROM basket_ledger WHERE launch_id = ? AND mint = ?', launchId, mint) || { credited: '0', paid: '0', payments: 0 };
    return { credited: big(r.credited), paid: big(r.paid), payments: Number(r.payments) || 0, available: big(r.credited) - big(r.paid) };
  }
  adjustBasket(launchId, mint, { credit = 0n, paid = 0n, payments = 0 } = {}) {
    const current = this.basketBalance(launchId, mint), next = { credited: current.credited + big(credit), paid: current.paid + big(paid), payments: current.payments + (Number(payments) || 0) };
    if (next.paid > next.credited) fail('A basket payout would exceed the asset bought for it.', 'PUMP_CLASSIC_LEDGER', 409);
    this.db.run('INSERT INTO basket_ledger(launch_id, mint, credited, paid, payments, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(launch_id, mint) DO UPDATE SET credited = excluded.credited, paid = excluded.paid, payments = excluded.payments, updated_at = excluded.updated_at',
      launchId, mint, String(next.credited), String(next.paid), next.payments, this.now());
    return this.basketBalance(launchId, mint);
  }
  basketBalances(launchId) { return Object.fromEntries(this.db.all('SELECT mint FROM basket_ledger WHERE launch_id = ?', launchId).map(r => [r.mint, this.basketBalance(launchId, r.mint)])); }
  // --- Diamond Hands streaks (v71.35) ---
  /** Every wallet's streak and the balance recorded at its last payout, as a Map. */
  streaks(launchId) { return new Map(this.db.all('SELECT owner, streak, balance FROM holder_streaks WHERE launch_id = ?', launchId).map(r => [r.owner, { streak: r.streak, balance: big(r.balance) }])); }
  /** Writes the streak updates of one payout in the caller's transaction (rows: { owner, streak, balance }). */
  setStreaks(launchId, rows) { const now = this.now(); for (const row of rows) this.db.run('INSERT INTO holder_streaks(launch_id, owner, streak, balance, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(launch_id, owner) DO UPDATE SET streak = excluded.streak, balance = excluded.balance, updated_at = excluded.updated_at', launchId, row.owner, Number(row.streak), String(row.balance), now); }
  /** The longest streaks, ties by address, plus how many wallets hold a streak at all. */
  topStreaks(launchId, limit = 10) { return { rows: this.db.all('SELECT owner, streak, balance, updated_at FROM holder_streaks WHERE launch_id = ? AND streak > 0 ORDER BY streak DESC, owner ASC LIMIT ?', launchId, limit), holding: this.db.get('SELECT COUNT(*) AS n FROM holder_streaks WHERE launch_id = ? AND streak > 0', launchId)?.n || 0 }; }
}
