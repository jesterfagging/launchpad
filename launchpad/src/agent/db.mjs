// AI Agent mode: the dedicated SQLite ledger database. Node's bundled SQLite
// (node:sqlite, SQLite 3.50) needs no native dependency. The file lives next to
// the encrypted account data, uses WAL with FULL synchronous durability and is
// opened by the agent core only; every other process goes through its API.
// Amounts are stored as decimal TEXT and handled as BigInt in JavaScript so
// nothing ever rounds through a JavaScript number.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireProcessLock } from '../process-lock.mjs';

const fail = (message, code = 'AGENT_DB') => { throw Object.assign(Error(message), { code, statusCode: 503 }); };

// Additive, versioned migrations. Each entry runs once inside a transaction and
// is recorded in schema_migrations; existing rows are never rewritten by code.
export const MIGRATIONS = Object.freeze([
  { version: 1, name: 'agent-core', sql: `
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, chain TEXT NOT NULL, mint TEXT UNIQUE, route TEXT NOT NULL, launch_id TEXT, account_id TEXT NOT NULL, draft_key TEXT UNIQUE,
      wallet TEXT NOT NULL UNIQUE, name TEXT NOT NULL, symbol TEXT NOT NULL, image TEXT, policy_hash TEXT NOT NULL, policy_version TEXT NOT NULL,
      capabilities INTEGER NOT NULL, model TEXT NOT NULL, state TEXT NOT NULL, state_reason TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
      mission TEXT NOT NULL, personality TEXT NOT NULL DEFAULT '', personality_preset TEXT NOT NULL DEFAULT 'analyst', domains TEXT NOT NULL DEFAULT '[]',
      creator_wallet TEXT NOT NULL DEFAULT '', launch_state TEXT NOT NULL DEFAULT 'pending', launch_signature TEXT, authority_checked_at INTEGER,
      archived INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, creator_paused INTEGER NOT NULL DEFAULT 0, admin_paused INTEGER NOT NULL DEFAULT 0, admin_pause_reason TEXT NOT NULL DEFAULT '',
      integrity_paused INTEGER NOT NULL DEFAULT 0, integrity_reason TEXT NOT NULL DEFAULT '', day_key TEXT NOT NULL DEFAULT '', day_budget_usd TEXT NOT NULL DEFAULT '0', day_spent_usd TEXT NOT NULL DEFAULT '0',
      treasury_day_key TEXT NOT NULL DEFAULT '', treasury_day_baseline TEXT NOT NULL DEFAULT '0', last_run_started_at INTEGER NOT NULL DEFAULT 0, next_run_at INTEGER NOT NULL DEFAULT 0, cadence_minutes INTEGER NOT NULL DEFAULT 30,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, activated_at INTEGER
    );
    CREATE INDEX agents_state ON agents(state, archived);
    CREATE INDEX agents_account ON agents(account_id);
    CREATE TABLE agent_policies (hash TEXT PRIMARY KEY, version TEXT NOT NULL, document TEXT NOT NULL, rate_card TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE agent_revisions (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL REFERENCES agents(id), revision INTEGER NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, changes TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX agent_revisions_agent ON agent_revisions(agent_id, revision);
    CREATE TABLE ledger_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, asset TEXT NOT NULL, bucket TEXT NOT NULL, balance TEXT NOT NULL DEFAULT '0', UNIQUE(owner, asset, bucket));
    CREATE TABLE ledger_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, source_key TEXT NOT NULL UNIQUE, agent_id TEXT, reference TEXT NOT NULL DEFAULT '', memo TEXT NOT NULL DEFAULT '', reversal_of INTEGER REFERENCES ledger_transactions(id), created_at INTEGER NOT NULL);
    CREATE INDEX ledger_transactions_agent ON ledger_transactions(agent_id, created_at);
    CREATE INDEX ledger_transactions_kind ON ledger_transactions(kind, created_at);
    CREATE TABLE ledger_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id INTEGER NOT NULL REFERENCES ledger_transactions(id), account_id INTEGER NOT NULL REFERENCES ledger_accounts(id), owner TEXT NOT NULL, asset TEXT NOT NULL, bucket TEXT NOT NULL, delta TEXT NOT NULL);
    CREATE INDEX ledger_entries_tx ON ledger_entries(transaction_id);
    CREATE INDEX ledger_entries_account ON ledger_entries(account_id);
    CREATE TABLE fee_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL REFERENCES agents(id), chain TEXT NOT NULL, signature TEXT NOT NULL, allocation TEXT NOT NULL, venue TEXT NOT NULL, launch_mint TEXT NOT NULL, source_wallet TEXT NOT NULL, mint TEXT NOT NULL, amount TEXT NOT NULL, operations TEXT NOT NULL, treasury TEXT NOT NULL, slot INTEGER NOT NULL, source_at INTEGER, created_at INTEGER NOT NULL, UNIQUE(chain, signature, allocation));
    CREATE INDEX fee_receipts_agent ON fee_receipts(agent_id, created_at);
    CREATE TABLE funding_intents (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), account_id TEXT NOT NULL, purpose TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL, mint TEXT NOT NULL, amount TEXT NOT NULL, memo TEXT NOT NULL UNIQUE, state TEXT NOT NULL, signature TEXT, message_hash TEXT, unsigned_raw TEXT, blockhash TEXT, last_valid_block_height INTEGER, prepared_slot INTEGER, operation TEXT, receipt TEXT, expiry_check TEXT, error TEXT NOT NULL DEFAULT '', expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finalized_at INTEGER);
    CREATE INDEX funding_intents_agent ON funding_intents(agent_id, created_at);
    CREATE INDEX funding_intents_state ON funding_intents(state, updated_at);
    CREATE TABLE settlement_batches (id TEXT PRIMARY KEY, state TEXT NOT NULL, input_lamports TEXT NOT NULL, output_usdc TEXT, network_cost TEXT NOT NULL DEFAULT '0', apportionment TEXT NOT NULL, operation TEXT, signature TEXT, quote TEXT, error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finalized_at INTEGER);
    CREATE INDEX settlement_batches_state ON settlement_batches(state, updated_at);
    CREATE TABLE provider_batches (id TEXT PRIMARY KEY, provider TEXT NOT NULL, reference TEXT NOT NULL UNIQUE, evidence TEXT NOT NULL, paid_usdc TEXT NOT NULL, purchase_fee_usdc TEXT NOT NULL, credits_usd TEXT NOT NULL, allocated_usdc TEXT NOT NULL DEFAULT '0', allocated_usd TEXT NOT NULL DEFAULT '0', actor TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE provider_allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL REFERENCES provider_batches(id), agent_id TEXT NOT NULL REFERENCES agents(id), usdc TEXT NOT NULL, usd TEXT NOT NULL, transaction_id INTEGER NOT NULL REFERENCES ledger_transactions(id), created_at INTEGER NOT NULL);
    CREATE INDEX provider_allocations_agent ON provider_allocations(agent_id, created_at);
    CREATE TABLE reimbursements (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), usdc TEXT NOT NULL, destination TEXT NOT NULL, state TEXT NOT NULL, operation TEXT, signature TEXT, expiry_check TEXT, actor TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finalized_at INTEGER);
    CREATE TABLE runs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL, trigger TEXT NOT NULL, policy_hash TEXT NOT NULL, model TEXT NOT NULL, revision INTEGER NOT NULL, reserved_usd TEXT NOT NULL DEFAULT '0', spent_usd TEXT NOT NULL DEFAULT '0', disputed_usd TEXT NOT NULL DEFAULT '0', model_calls INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0, browser_actions INTEGER NOT NULL DEFAULT 0, browser_seconds INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at INTEGER NOT NULL DEFAULT 0, fence INTEGER NOT NULL DEFAULT 0, summary TEXT NOT NULL DEFAULT '', error_code TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', provider_requests TEXT NOT NULL DEFAULT '[]', dry_run INTEGER NOT NULL DEFAULT 0, queued_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, updated_at INTEGER NOT NULL);
    CREATE INDEX runs_agent ON runs(agent_id, queued_at);
    CREATE INDEX runs_state ON runs(state, updated_at);
    CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), agent_id TEXT NOT NULL, provider TEXT NOT NULL, request_id TEXT NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0, cost_usd TEXT NOT NULL DEFAULT '0', estimated_usd TEXT NOT NULL DEFAULT '0', state TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, resolved_at INTEGER, UNIQUE(provider, request_id));
    CREATE INDEX usage_events_run ON usage_events(run_id);
    CREATE INDEX usage_events_state ON usage_events(state, created_at);
    CREATE TABLE actions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), run_id TEXT, kind TEXT NOT NULL, state TEXT NOT NULL, proposal TEXT NOT NULL, evaluation TEXT NOT NULL DEFAULT '', principal_lamports TEXT NOT NULL DEFAULT '0', reserved_lamports TEXT NOT NULL DEFAULT '0', spent_lamports TEXT NOT NULL DEFAULT '0', intent_hash TEXT NOT NULL DEFAULT '', policy_hash TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', venue TEXT NOT NULL DEFAULT '', quote TEXT, outcome TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finalized_at INTEGER);
    CREATE INDEX actions_agent ON actions(agent_id, created_at);
    CREATE INDEX actions_state ON actions(state, updated_at);
    CREATE TABLE action_legs (id TEXT PRIMARY KEY, action_id TEXT NOT NULL REFERENCES actions(id), agent_id TEXT NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, operation TEXT, signature TEXT, raw_hash TEXT, expires_height INTEGER, prepared_slot INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_broadcast_at INTEGER NOT NULL DEFAULT 0, next_check_at INTEGER NOT NULL DEFAULT 0, receipt TEXT, expiry_check TEXT, error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finalized_at INTEGER, UNIQUE(action_id, sequence));
    CREATE INDEX action_legs_state ON action_legs(state, next_check_at);
    CREATE TABLE reward_cycles (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), action_id TEXT NOT NULL REFERENCES actions(id), state TEXT NOT NULL, policy_hash TEXT NOT NULL, window_from INTEGER NOT NULL, window_to INTEGER NOT NULL, sample_count INTEGER NOT NULL, total_lamports TEXT NOT NULL, recipients TEXT NOT NULL, exclusions TEXT NOT NULL, evidence TEXT NOT NULL, paid_index INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finalized_at INTEGER);
    CREATE TABLE reward_debts (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL REFERENCES agents(id), cycle_id TEXT NOT NULL REFERENCES reward_cycles(id), owner TEXT NOT NULL, lamports TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', signature TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX reward_debts_agent ON reward_debts(agent_id, state);
    CREATE TABLE holder_samples (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL REFERENCES agents(id), at INTEGER NOT NULL, slot INTEGER NOT NULL, complete INTEGER NOT NULL, program TEXT NOT NULL, decimals INTEGER NOT NULL, rows TEXT NOT NULL, holder_count INTEGER NOT NULL, UNIQUE(agent_id, at));
    CREATE INDEX holder_samples_agent ON holder_samples(agent_id, at);
    CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL REFERENCES agents(id), run_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, source_url TEXT NOT NULL DEFAULT '', provenance TEXT NOT NULL, bytes INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE INDEX notes_agent ON notes(agent_id, active, created_at);
    CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, content='notes', content_rowid='id');
    CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN INSERT INTO notes_fts(rowid, title, body) VALUES (new.id, new.title, new.body); END;
    CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES ('delete', old.id, old.title, old.body); END;
    CREATE TABLE activity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL REFERENCES agents(id), run_id TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}', public INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
    CREATE INDEX activity_events_agent ON activity_events(agent_id, id);
    CREATE INDEX activity_events_public ON activity_events(public, id);
    CREATE TABLE browser_sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), run_id TEXT NOT NULL, provider TEXT NOT NULL, provider_session_id TEXT NOT NULL DEFAULT '', state TEXT NOT NULL, actions INTEGER NOT NULL DEFAULT 0, seconds INTEGER NOT NULL DEFAULT 0, charged_usd TEXT NOT NULL DEFAULT '0', current_url TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER, expires_at INTEGER NOT NULL);
    CREATE INDEX browser_sessions_state ON browser_sessions(state, expires_at);
    CREATE TABLE screenshots (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES browser_sessions(id), agent_id TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', bytes BLOB NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX screenshots_session ON screenshots(session_id, id);
    CREATE INDEX screenshots_expiry ON screenshots(expires_at);
    CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, dedup_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, done_at INTEGER);
    CREATE INDEX outbox_pending ON outbox(done_at, next_at);
    CREATE TABLE admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '{}', reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL DEFAULT '');
    CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, cleared_at INTEGER);
    CREATE INDEX alerts_open ON alerts(cleared_at, created_at);
  ` },
  // v2 (Launchpad v71.18): remittances of the platform share set aside by policy v2.
  { version: 2, name: 'platform-share-remits', sql: `
    CREATE TABLE platform_remits (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), amount TEXT NOT NULL, destination TEXT NOT NULL, state TEXT NOT NULL, operation TEXT, signature TEXT UNIQUE, fee TEXT NOT NULL DEFAULT '0', expiry_check TEXT, error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX platform_remits_state ON platform_remits(state, updated_at);
  ` },
  // v3 (Launchpad v71.27): objectives. Every existing agent reads as objective 'custom'
  // (mission only, no program). The platform runs an objective's program from
  // program_state; market_samples keeps one public market snapshot per agent per
  // UTC day as the evidence the volume rules (7-day vs 30-day) are judged on.
  { version: 3, name: 'agent-objectives', sql: `
    ALTER TABLE agents ADD COLUMN objective TEXT NOT NULL DEFAULT 'custom';
    ALTER TABLE agents ADD COLUMN objective_settings TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE agents ADD COLUMN program_state TEXT NOT NULL DEFAULT '{}';
    CREATE TABLE market_samples (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL REFERENCES agents(id), day_key TEXT NOT NULL, at INTEGER NOT NULL, price_usd REAL, market_cap_usd REAL, volume24h_usd REAL, price_change24h REAL, progress_percent REAL, graduated INTEGER NOT NULL DEFAULT 0, UNIQUE(agent_id, day_key));
    CREATE INDEX market_samples_agent ON market_samples(agent_id, day_key);
  ` },
  // v4 (Launchpad v71.30): AI influencer. X accounts creators connected (their tokens live in the encrypted
  // host store under 'x-token-<id>', never here), the per-agent influencer record, media jobs and posts.
  { version: 4, name: 'influencer', sql: `
    CREATE TABLE x_oauth_states (state TEXT PRIMARY KEY, account_id TEXT NOT NULL, code_verifier TEXT NOT NULL, return_to TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX x_oauth_states_expiry ON x_oauth_states(expires_at);
    CREATE TABLE x_accounts (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, agent_id TEXT REFERENCES agents(id), x_user_id TEXT NOT NULL, handle TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', scopes TEXT NOT NULL DEFAULT '', token_expires_at INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, state_reason TEXT NOT NULL DEFAULT '', posts_day_key TEXT NOT NULL DEFAULT '', posts_today INTEGER NOT NULL DEFAULT 0, last_post_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(agent_id));
    CREATE INDEX x_accounts_account ON x_accounts(account_id, created_at);
    CREATE INDEX x_accounts_user ON x_accounts(x_user_id);
    CREATE TABLE influencers (agent_id TEXT PRIMARY KEY REFERENCES agents(id), version INTEGER NOT NULL DEFAULT 1, spec TEXT NOT NULL DEFAULT '{}', prompt TEXT NOT NULL DEFAULT '', state TEXT NOT NULL, state_reason TEXT NOT NULL DEFAULT '', master_file TEXT NOT NULL DEFAULT '', sheet_file TEXT NOT NULL DEFAULT '', reference_file TEXT NOT NULL DEFAULT '', soul_id TEXT NOT NULL DEFAULT '', consistency INTEGER, generations INTEGER NOT NULL DEFAULT 0, posting_paused INTEGER NOT NULL DEFAULT 0, admin_paused INTEGER NOT NULL DEFAULT 0, admin_pause_reason TEXT NOT NULL DEFAULT '', day_key TEXT NOT NULL DEFAULT '', posts_today INTEGER NOT NULL DEFAULT 0, images_today INTEGER NOT NULL DEFAULT 0, videos_today INTEGER NOT NULL DEFAULT 0, next_post_at INTEGER NOT NULL DEFAULT 0, last_post_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX influencers_state ON influencers(state, updated_at);
    CREATE TABLE media_jobs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), run_id TEXT, post_id TEXT, kind TEXT NOT NULL, stage TEXT NOT NULL DEFAULT '', provider TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', provider_request_id TEXT NOT NULL DEFAULT '', request TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL, file TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '', reserved_usd TEXT NOT NULL DEFAULT '0', cost_usd TEXT NOT NULL DEFAULT '0', score INTEGER, error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, next_check_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER);
    CREATE INDEX media_jobs_open ON media_jobs(state, next_check_at);
    CREATE INDEX media_jobs_agent ON media_jobs(agent_id, created_at);
    CREATE TABLE x_posts (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), run_id TEXT, x_account_id TEXT, kind TEXT NOT NULL, text TEXT NOT NULL, link TEXT NOT NULL DEFAULT '', media_job_id TEXT, state TEXT NOT NULL, x_post_id TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', reserved_usd TEXT NOT NULL DEFAULT '0', cost_usd TEXT NOT NULL DEFAULT '0', error TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, posted_at INTEGER);
    CREATE INDEX x_posts_agent ON x_posts(agent_id, created_at);
    CREATE INDEX x_posts_open ON x_posts(state, next_attempt_at);
  ` },
  // v5 (Launchpad v71.32): the daily feature clip counter of an influencer (one longer clip per UTC day).
  { version: 5, name: 'influencer-feature-clip', sql: `
    ALTER TABLE influencers ADD COLUMN feature_today INTEGER NOT NULL DEFAULT 0;
  ` },
  // v6 (Launchpad v71.37): why, when and by whom an agent was hidden from the public directory (moderation); '' / NULL when visible.
  { version: 6, name: 'agent-moderation', sql: `
    ALTER TABLE agents ADD COLUMN hidden_reason TEXT NOT NULL DEFAULT '';
    ALTER TABLE agents ADD COLUMN hidden_at INTEGER;
    ALTER TABLE agents ADD COLUMN hidden_by TEXT NOT NULL DEFAULT '';
  ` },
]);
export const AGENT_SCHEMA_VERSION = MIGRATIONS.at(-1).version;

export class AgentDatabase {
  constructor(path, { now = Date.now } = {}) {
    if (typeof path !== 'string' || !path) fail('An agent database path is required.');
    this.path = path; this.now = now; this.statements = new Map(); this.depth = 0;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL'); this.db.exec('PRAGMA synchronous=FULL'); this.db.exec('PRAGMA foreign_keys=ON'); this.db.exec('PRAGMA busy_timeout=5000'); this.db.exec('PRAGMA temp_store=MEMORY');
  }
  prepare(sql) { let statement = this.statements.get(sql); if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); } return statement; }
  run(sql, ...params) { return this.prepare(sql).run(...params); }
  get(sql, ...params) { return this.prepare(sql).get(...params); }
  all(sql, ...params) { return this.prepare(sql).all(...params); }
  /** Serializable write transaction. Nested calls join the outer transaction. */
  transaction(fn) {
    if (this.depth > 0) { this.depth++; try { return fn(); } finally { this.depth--; } }
    this.db.exec('BEGIN IMMEDIATE'); this.depth = 1;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch { /* The connection reports the original failure. */ } throw error; }
    finally { this.depth = 0; }
  }
  version() { try { return this.get('SELECT MAX(version) AS version FROM schema_migrations')?.version || 0; } catch { return 0; } }
  /** Applies pending migrations once, under a cross-process file lock. */
  async migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    let release = null;
    if (this.path !== ':memory:') release = await acquireProcessLock(this.path + '.migrate.lock');
    try {
      const applied = [];
      for (const migration of MIGRATIONS) {
        if (this.get('SELECT version FROM schema_migrations WHERE version = ?', migration.version)) continue;
        const previous = this.version();
        if (previous !== migration.version - 1) fail(`The agent database is at schema ${previous}; migration ${migration.version} cannot be applied out of order.`);
        this.transaction(() => { this.db.exec(migration.sql); this.run('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)', migration.version, migration.name, this.now()); });
        applied.push(migration.version);
      }
      const version = this.version();
      if (version > AGENT_SCHEMA_VERSION) fail(`The agent database schema ${version} is newer than this release (${AGENT_SCHEMA_VERSION}). Install the matching release or restore the backup taken before the upgrade.`);
      return { version, applied };
    } finally { await release?.(); }
  }
  /** Consistent online backup (WAL included) via VACUUM INTO. */
  backup(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-'), target = join(directory, `agents-${stamp}.sqlite`);
    if (existsSync(target)) fail('A backup with the same timestamp already exists.');
    this.db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    // Keep the newest 48 copies (two days of hourly backups); back up the data folder for anything older.
    try { const names = readdirSync(directory).filter(name => /^agents-.*\.sqlite$/.test(name)).sort(); for (const name of names.slice(0, Math.max(0, names.length - 48))) unlinkSync(join(directory, name)); } catch { /* Pruning is best effort. */ }
    return target;
  }
  checkpoint() { try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* A busy checkpoint retries on the next pass. */ } }
  integrity() { const row = this.get('PRAGMA quick_check'); return row?.quick_check === 'ok'; }
  close() { if (!this.db.isOpen) return; try { this.checkpoint(); } finally { this.statements.clear(); this.db.close(); } }
}

export async function openAgentDatabase(path, options = {}) {
  const db = new AgentDatabase(path, options);
  try { await db.migrate(); return db; } catch (error) { db.close(); throw error; }
}
