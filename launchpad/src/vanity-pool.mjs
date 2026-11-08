// Vanity contract addresses: a pool of operator-supplied mint keypairs (for
// example addresses ground with `solana-keygen grind`) that new launches use
// as their coin's address instead of a random one.
//
// Custody
// - Private keys live only in the encrypted host store, in one document
//   (`vanity-pool`, AES-256-GCM under the host master key, like every other
//   launch key). reserve() is the only method that returns a private key, to
//   the launch that will sign its coin's creation. The admin view, imports,
//   removals and events carry addresses only.
// - An address is used at most once. A launch holds one on a lease that
//   expires, keeps the key with its own launch keys, and commits it only when
//   the launch commits money (its first signed transaction, or Pump.fun funding
//   that has settled): the pool then forgets the private key and lists the
//   address under "Used". A lease released, or left to expire, returns the
//   address to the pool, so abandoned reviews, drafts and quotes use none.
// - A used address whose launch ended without creating its coin can be
//   returned with its key (restore()): the venue first moves that launch back
//   to its own quoted address and checks the address is still empty onchain.
// - Before an address is handed out it is checked onchain; an address that
//   already holds an account (it could never be created as a mint) is moved
//   to the used list as skipped. When the chain cannot be asked, no address is
//   handed out (the launch keeps a random one).
// - With no address left, a launch keeps its random address and the venue
//   reports the fallback when that launch commits money. Pool failures never
//   block a launch; a pool that was never stocked is never written.
import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { acquireProcessLock } from './process-lock.mjs';
import { base58Encode, base58Decode } from './pump-classic/codec.mjs';

export const VANITY_VENUES = Object.freeze(['pump', 'raydium', 'meteora']);
export const VANITY_SCOPES = Object.freeze(['all', ...VANITY_VENUES]);
export const VANITY_LABELS = Object.freeze({ all: 'Every launch', pump: 'Pump.fun', raydium: 'Raydium', meteora: 'Meteora' });
export const VANITY_LIMITS = Object.freeze({ importKeys: 2000, poolKeys: 10000, usedKept: 5000, leaseMs: 10 * 60 * 1000, draftLeaseMs: 60 * 60 * 1000, lowWater: 10 });
const DOC = 'vanity-pool', SEEN = 'vanity-seen', LOCK = 'vanity-pool.lock', EVENTS = 100, ONCHAIN_TTL = 60000, CHECKS_PER_RESERVE = 5;
// Every address ever added is remembered as an 8-character hash, so a key from an old backup is never added again after its used entry was trimmed.
const seenHash = address => createHash('sha256').update('curve-vanity-seen-v1:' + address).digest('base64url').slice(0, 8);
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const HEADER = /^(?:address|pubkey|public|public_?key|private|private_?key|secret_?key|secret|key|keypair|wallet|mint|ca|base58)$/i;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/, ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, REF = /^[A-Za-z0-9_-]{6,80}$/;

const fail = (message, statusCode = 400, code = 'VANITY_INVALID') => { throw Object.assign(Error(message), { statusCode, code }); };
const empty = () => ({ version: 1, keys: [], stats: { fallbacks: 0, fallbacksSinceImport: 0, lastFallbackAt: null, lastFallbackVenue: null, fallbackRefs: [], checkFailures: 0, lastCheckFailureAt: null }, events: [] });
const label = (value, max) => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
const venueOf = value => { if (!VANITY_VENUES.includes(value)) fail('Unknown launch venue.'); return value; };
const refOf = value => { if (typeof value !== 'string' || !REF.test(value)) fail('Invalid launch reference.'); return value; };

/** Ed25519 public key (32 bytes) for a 32-byte seed. */
function publicFromSeed(seed) {
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  return Buffer.from(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32));
}
/**
 * A Solana keypair from a 64-byte secret key (seed ‖ public key, the format of
 * solana-keygen files and wallet exports). The public half must match the
 * seed, and a claimed address must match the key.
 */
export function vanityKeyFromBytes(bytes, claimedAddress = null) {
  if (!bytes || bytes.length !== 64) return { reason: 'not a 64-byte Solana private key' };
  const seed = Buffer.from(bytes.subarray(0, 32)), pub = publicFromSeed(seed);
  try {
    if (!pub.equals(Buffer.from(bytes.subarray(32)))) return { reason: 'the private key does not match its own public key' };
    const address = base58Encode(pub);
    if (claimedAddress && claimedAddress !== address) return { reason: 'the address next to it belongs to a different key' };
    const full = Buffer.concat([seed, pub]);
    try { return { address, secret: base58Encode(full) }; } finally { full.fill(0); }
  } finally { seed.fill(0); }
}
function bytesFromNumbers(value) {
  if (!Array.isArray(value) || value.length !== 64 || !value.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) return null;
  return Buffer.from(value);
}
function decode58(token) { if (typeof token !== 'string' || !BASE58.test(token) || token.length > 100) return null; try { return base58Decode(token, 100); } catch { return null; } }

/**
 * Parses pasted text and uploaded files into keypairs. Accepted: solana-keygen
 * JSON files (an array of 64 numbers), JSON arrays of those, objects with a
 * secretKey/privateKey field, base58 private keys (one per line) and
 * "address,privatekey" lines in either order. Rejections name the source and
 * line, never its content.
 */
export function parseVanityEntries(entries, { max = VANITY_LIMITS.importKeys } = {}) {
  if (!Array.isArray(entries) || !entries.length) fail('Paste private keys or choose key files to add.');
  if (entries.length > max) fail(`Add at most ${max} files at a time.`);
  const keys = [], rejected = []; let truncated = false, seq = 0;
  // `seq` keeps every result in the order it was read, so rejections can be listed by source and line.
  const push = (where, bytes, claimed, reason) => {
    try {
      if (keys.length + rejected.length >= max) { truncated = true; return; }
      if (!bytes) { rejected.push({ where, reason: reason || 'not a private key', seq: seq++ }); return; }
      const key = vanityKeyFromBytes(bytes, claimed);
      if (key.reason) rejected.push({ where, reason: key.reason, seq: seq++ }); else keys.push({ ...key, where, seq: seq++ });
    } finally { bytes?.fill?.(0); }
  };
  const fromJson = (value, where, depth = 0) => {
    if (depth > 3) return push(where, null, null, 'nested too deeply');
    if (Array.isArray(value)) {
      if (value.length && value.every(n => typeof n === 'number')) return push(where, bytesFromNumbers(value), null, 'not a 64-byte Solana private key');
      if (!value.length) return push(where, null, null, 'empty list');
      value.forEach((item, index) => fromJson(item, `${where} item ${index + 1}`, depth + 1)); return;
    }
    if (typeof value === 'string') return fromLine(value, where);
    if (value && typeof value === 'object') {
      const secret = value.secretKey ?? value.privateKey ?? value.secret ?? value.secret_key ?? value.private_key;
      const claimed = value.publicKey ?? value.address ?? value.pubkey ?? value.public_key;
      const bytes = Array.isArray(secret) ? bytesFromNumbers(secret) : typeof secret === 'string' ? decode58(secret.trim()) : null;
      return push(where, bytes, typeof claimed === 'string' ? claimed.trim() : null, 'no private key in this entry');
    }
    push(where, null, null);
  };
  const fromLine = (line, where) => {
    const text = String(line).trim(); if (!text || text.startsWith('#') || text.startsWith('//')) return;
    if (text.startsWith('[') || text.startsWith('{')) { let value; try { value = JSON.parse(text); } catch { return push(where, null, null, 'not valid JSON'); } return fromJson(value, where, 1); }
    const tokens = text.split(/[\s,;:|"'=]+/).filter(Boolean);
    if (tokens.every(token => HEADER.test(token))) return; // a column header such as "address,private_key"
    let secret = null, claimed = null;
    for (const token of tokens) {
      const bytes = decode58(token);
      if (bytes?.length === 64) { if (secret) { secret.fill(0); bytes.fill(0); return push(where, null, null, 'more than one private key on one line'); } secret = bytes; }
      else { if (bytes?.length === 32 && !claimed) claimed = token; bytes?.fill(0); }
    }
    push(where, secret, claimed, claimed ? 'an address without its private key' : 'not a private key');
  };
  for (const [index, entry] of entries.entries()) {
    const name = label(entry?.name, 120) || (entries.length > 1 ? `entry ${index + 1}` : 'pasted text'), text = typeof entry?.text === 'string' ? entry.text : '';
    if (!text.trim()) { rejected.push({ where: name, reason: 'empty', seq: seq++ }); continue; }
    const trimmed = text.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) { let value, parsed = false; try { value = JSON.parse(trimmed); parsed = true; } catch { /* one JSON value per line, or plain lines */ } if (parsed) { fromJson(value, name); continue; } }
    trimmed.split(/\r?\n/).forEach((line, n) => fromLine(line, `${name} line ${n + 1}`));
    if (truncated) break;
  }
  return { keys, rejected, truncated };
}
const inOrder = rows => rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map(({ where, reason }) => ({ where, reason }));
/** One page of a vanity list: `search` matches an address (any part; a prefix sorts first), coin name or ticker; `state` is a named filter. */
function pageVanityRows(rows, options, fallbackLimit, states, search) {
  const query = typeof search === 'string' ? label(search, 64).toLowerCase() : '';
  const state = typeof options?.state === 'string' && Object.hasOwn(states, options.state) ? options.state : '';
  if (options?.state && !state) fail('Choose a valid vanity filter.');
  let offset = options?.offset === undefined ? 0 : Number(options.offset), limit = options?.limit === undefined ? fallbackLimit : Number(options.limit);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 2000) fail('Invalid vanity page.');
  let matched = rows;
  if (state) matched = matched.filter(states[state]);
  if (query) {
    const hit = row => [row.address, row.name, row.symbol].some(value => String(value || '').toLowerCase().includes(query));
    matched = matched.filter(hit);
    const prefix = row => String(row.address).toLowerCase().startsWith(query) ? 0 : 1;
    matched = matched.map((row, index) => ({ row, index })).sort((a, b) => prefix(a.row) - prefix(b.row) || a.index - b.index).map(item => item.row);
  }
  return { rows: matched.slice(offset, offset + limit), matched: matched.length, offset, limit, nextOffset: offset + limit < matched.length ? offset + limit : null };
}

export class VanityMintPool {
  /**
   * @param accounts  host accounts (hostStore for the encrypted document, dir for the lock, get() for admin checks)
   * @param onChain   async (addresses) => booleans: true when an account already exists at the address
   * @param inUse     (address) => true when something on this host still names the address (an AI Agent bound to it): never handed out
   */
  constructor({ accounts, store = null, dir = null, onChain = null, inUse = null, now = Date.now, leaseMs = VANITY_LIMITS.leaseMs, lowWater = VANITY_LIMITS.lowWater } = {}) {
    Object.assign(this, { accounts, fixedStore: store, fixedDir: dir, onChain, inUse, now, leaseMs, lowWater });
    this.queue = Promise.resolve(); this.chainCache = new Map();
  }
  // ---- storage --------------------------------------------------------------------------------
  /** The host's encrypted document store and data directory (resolved on use: the account store opens after the app is wired). */
  get store() { const store = this.fixedStore || this.accounts?.hostStore; if (!store) fail('Vanity addresses are unavailable until the account store is open.', 503, 'VANITY_UNAVAILABLE'); return store; }
  get dir() { const dir = this.fixedDir || this.accounts?.dir; if (typeof dir !== 'string' || !dir) fail('Vanity addresses are unavailable until the account store is open.', 503, 'VANITY_UNAVAILABLE'); return dir; }
  async locked(fn) {
    const run = this.queue.then(async () => { let release; try { release = await acquireProcessLock(join(this.dir, LOCK)); return await fn(); } finally { await release?.(); } });
    this.queue = run.catch(() => {});
    return run;
  }
  async load() {
    const doc = await this.store.read(DOC, null); if (doc === null || doc === undefined) return empty();
    if (doc.version !== 1 || !Array.isArray(doc.keys) || !Array.isArray(doc.events)) fail('The vanity address pool was written by a newer release. Nothing was changed.', 503, 'VANITY_VERSION');
    doc.stats = { ...empty().stats, ...(doc.stats || {}) }; return doc;
  }
  async save(doc) { await this.store.write(DOC, doc); }
  event(doc, kind, text) { doc.events.push({ at: this.now(), kind, text: label(text, 300) }); if (doc.events.length > EVENTS) doc.events.splice(0, doc.events.length - EVENTS); }
  /** Leases past their time return to the pool. */
  expire(doc) { const now = this.now(); for (const key of doc.keys) if (key.state === 'reserved' && !(key.lease?.until > now)) { key.state = 'available'; delete key.lease; } }
  async requireAdmin(actorId) {
    if (typeof this.accounts?.get !== 'function') return;
    const actor = await this.accounts.get(actorId);
    if (actor?.role !== 'admin' || actor.mfaEnabled !== true || actor.banned) fail('Administrator access with two-factor authentication is required.', 403, 'VANITY_ADMIN');
  }
  /** true / false when the chain answered, null when it could not be asked. Without a checker (tests, tools) every address counts as free. */
  async exists(address) {
    if (typeof this.onChain !== 'function') return false;
    try { const [value] = await this.onChain([address]); return value === true ? true : value === false ? false : null; } catch { return null; }
  }
  // ---- launches ---------------------------------------------------------------------------------
  /**
   * Leases the next address for `venue` (addresses kept for that venue first,
   * then those for every launch; oldest first) to the launch `ref` for `ttlMs`.
   * Returns { address, secret } (base58 of the 64-byte secret key) or null when
   * no address can be handed out. Asking again for the same launch returns the
   * same address. A pool that was never stocked is not even written.
   */
  async reserve({ venue, ref, ttlMs = this.leaseMs, exclude = null }) {
    venueOf(venue); refOf(ref);
    return this.locked(async () => {
      const doc = await this.load(), now = this.now(); if (!doc.keys.length) return null;
      this.expire(doc);
      const mine = doc.keys.find(k => k.state === 'reserved' && k.lease?.venue === venue && k.lease?.ref === ref);
      if (mine) { mine.lease.until = Math.max(mine.lease.until, now + ttlMs); await this.save(doc); return { address: mine.address, secret: mine.secret }; }
      let changed = false;
      // `exclude` names addresses the venue's own records still use (a draft that let its lease lapse): left for other venues.
      // `inUse` names addresses something else on this host is bound to: never handed out.
      const excluded = new Set();
      for (let checks = 0; checks < CHECKS_PER_RESERVE;) {
        const candidate = this.pick(doc, venue, excluded); if (!candidate) break;
        let named = false, exists;
        try { named = (typeof exclude === 'function' && exclude(candidate.address)) || (typeof this.inUse === 'function' && await this.inUse(candidate.address)); } catch { exists = null; }
        if (named) { excluded.add(candidate.address); continue; }
        if (exists !== null) { checks++; exists = await this.exists(candidate.address); }
        if (exists === null) {
          // Fail closed: an address that could not be checked (onchain, or against the AI Agent ledger) is not handed out. This launch is
          // not counted as an empty-pool fallback: the warning about the check covers it.
          doc.stats.checkFailures++; const quiet = doc.stats.lastCheckFailureAt && now - doc.stats.lastCheckFailureAt < 600000; doc.stats.lastCheckFailureAt = now;
          doc.stats.fallbackRefs = [...doc.stats.fallbackRefs, venue + ':' + ref].slice(-200);
          if (!quiet) this.event(doc, 'check', 'Whether a vanity address is free could not be checked; launches use random addresses until it can.');
          await this.save(doc); return null;
        }
        if (exists) {
          // Set aside, never handed out; its key stays encrypted until an administrator removes it.
          candidate.state = 'skipped'; candidate.use = { venue, ref, at: now, reason: 'An account already exists at this address, so it cannot become a coin.' };
          this.event(doc, 'skipped', `${candidate.address} skipped: an account already exists at this address.`); this.trim(doc); changed = true; continue;
        }
        candidate.state = 'reserved'; candidate.lease = { venue, ref, at: now, until: now + ttlMs };
        await this.save(doc); return { address: candidate.address, secret: candidate.secret };
      }
      if (changed) await this.save(doc);
      return null;
    });
  }
  /**
   * Records a launch that committed money with a random address because no
   * vanity address could be handed out (once per launch; never for a pool that
   * was never stocked).
   */
  async noteFallback({ venue, ref }) {
    venueOf(venue); refOf(ref);
    return this.locked(async () => {
      const doc = await this.load(), key = venue + ':' + ref; if (!doc.keys.length || doc.stats.fallbackRefs.includes(key)) return false;
      doc.stats.fallbackRefs = [...doc.stats.fallbackRefs, key].slice(-200);
      doc.stats.fallbacks++; doc.stats.fallbacksSinceImport++; doc.stats.lastFallbackAt = this.now(); doc.stats.lastFallbackVenue = venue;
      this.event(doc, 'fallback', `A ${VANITY_LABELS[venue]} launch used a random address: no vanity address was available.`);
      await this.save(doc); return true;
    });
  }
  pick(doc, venue, excluded = new Set()) {
    const free = scope => doc.keys.filter(k => k.state === 'available' && k.scope === scope && typeof k.secret === 'string' && !excluded.has(k.address)).sort((a, b) => a.addedAt - b.addedAt)[0]; // stable: import order within a batch
    return free(venue) || free('all') || null;
  }
  /**
   * Marks a reserved address as used by the launch, after the launch has
   * stored the key with its own keys. The private key is dropped from the pool.
   * Committing again for the same launch is a no-op; an address another launch
   * holds is refused (VANITY_TAKEN).
   */
  async commit({ venue, ref, address, launch = {} }) {
    venueOf(venue); refOf(ref); if (!ADDRESS.test(address || '')) fail('Invalid vanity address.');
    return this.locked(async () => {
      const doc = await this.load(); this.expire(doc);
      const key = doc.keys.find(k => k.address === address);
      if (!key) fail('This vanity address is no longer in the pool.', 409, 'VANITY_TAKEN');
      if (key.state === 'used' && key.use?.venue === venue && key.use?.ref === ref) return true;
      const ours = key.state === 'reserved' && key.lease?.venue === venue && key.lease?.ref === ref;
      if (!ours && key.state !== 'available') fail('This vanity address was taken by another launch.', 409, 'VANITY_TAKEN');
      key.state = 'used'; delete key.secret; delete key.lease;
      key.use = { venue, ref, at: this.now(), name: label(launch.name, 64), symbol: label(launch.symbol, 24), accountId: label(launch.accountId, 64) };
      this.event(doc, 'used', `${address} used by ${key.use.symbol ? '$' + key.use.symbol : 'a launch'} on ${VANITY_LABELS[venue]}.`);
      this.trim(doc); await this.save(doc); return true;
    });
  }
  /** Returns a leased address to the pool (a review that expired, a launch that failed before saving). */
  async release({ venue, ref, address }) {
    venueOf(venue); refOf(ref);
    return this.locked(async () => {
      const doc = await this.load(), key = doc.keys.find(k => k.address === address);
      if (!key || key.state !== 'reserved' || key.lease?.venue !== venue || key.lease?.ref !== ref) return false;
      key.state = 'available'; delete key.lease; await this.save(doc); return true;
    });
  }
  /** Re-establishes (or extends, for `ttlMs`) a launch's hold on a specific address: true when it is (again) leased to that launch or already used by it. */
  async claim({ venue, ref, address, ttlMs = this.leaseMs }) {
    venueOf(venue); refOf(ref);
    return this.locked(async () => {
      const doc = await this.load(); this.expire(doc);
      const key = doc.keys.find(k => k.address === address); if (!key) return false;
      if (key.state === 'used') return key.use?.venue === venue && key.use?.ref === ref;
      if (key.state === 'reserved' && !(key.lease?.venue === venue && key.lease?.ref === ref)) return false;
      if (key.state !== 'reserved' && key.state !== 'available') return false;
      key.state = 'reserved'; key.lease = { venue, ref, at: key.lease?.at ?? this.now(), until: Math.max(key.lease?.until || 0, this.now() + ttlMs) };
      await this.save(doc); return true;
    });
  }
  /**
   * Puts an address back in the pool, with its key, after the launch that used
   * it gave it up without ever creating its coin (the venue has already switched
   * that launch back to its own quoted address and checked the address is still
   * empty onchain). Only the launch recorded as its user may return it. Returns
   * true when it was returned now, false when it was already back.
   */
  async restore({ venue, ref, address, secret }) {
    venueOf(venue); refOf(ref); if (!ADDRESS.test(address || '')) fail('Invalid vanity address.');
    const bytes = decode58(String(secret || '')), key = bytes ? vanityKeyFromBytes(bytes, address) : { reason: 'not a private key' }; bytes?.fill(0);
    if (key.reason) fail('The returned key does not match its address.', 400, 'VANITY_KEY');
    try {
      return await this.locked(async () => {
        const doc = await this.load(), now = this.now(); this.expire(doc);
        const entry = doc.keys.find(k => k.address === address);
        if (entry && entry.state !== 'used') return false;
        if (entry && !(entry.use?.venue === venue && entry.use?.ref === ref)) fail('Another launch recorded this vanity address as used.', 409, 'VANITY_TAKEN');
        if (entry) { entry.state = 'available'; entry.secret = key.secret; entry.returned = { venue, ref, at: now, uses: (entry.returned?.uses || 0) + 1 }; delete entry.use; }
        else doc.keys.push({ address, secret: key.secret, scope: venue, addedAt: now, addedBy: 'returned', state: 'available', returned: { venue, ref, at: now, uses: 1 } });
        this.event(doc, 'returned', `${address} returned to the pool: its ${VANITY_LABELS[venue]} launch was never created.`);
        await this.save(doc); return true;
      });
    } finally { key.secret = ''; }
  }
  /** Returns by `venue` whose last step (the venue forgetting the key) is not recorded as settled yet. */
  async returnedFor(venue) {
    venueOf(venue); const doc = await this.load();
    return doc.keys.filter(k => k.returned?.venue === venue && k.returned.settled !== true && typeof k.returned.ref === 'string').map(k => ({ address: k.address, ref: k.returned.ref }));
  }
  /** Records that the launch which returned `address` has forgotten its copy of the key. */
  async settleReturn({ venue, ref, address }) {
    venueOf(venue); refOf(ref);
    return this.locked(async () => {
      const doc = await this.load(), key = doc.keys.find(k => k.address === address);
      if (!key || key.returned?.venue !== venue || key.returned?.ref !== ref || key.returned.settled === true) return false;
      key.returned.settled = true; await this.save(doc); return true;
    });
  }
  /** Addresses recorded as used by `venue`, with the launch that used each (addresses and references only). */
  async usedFor(venue) {
    venueOf(venue); const doc = await this.load();
    return doc.keys.filter(k => k.state === 'used' && k.use?.venue === venue && typeof k.use.ref === 'string').map(k => ({ address: k.address, ref: k.use.ref, at: k.use.at || 0 }));
  }
  /** Oldest used entries beyond the kept history are dropped (addresses only; they carry no key). */
  trim(doc) {
    const used = doc.keys.filter(k => k.state === 'used'); if (used.length <= VANITY_LIMITS.usedKept) return;
    const drop = new Set(used.sort((a, b) => (a.use?.at || 0) - (b.use?.at || 0)).slice(0, used.length - VANITY_LIMITS.usedKept).map(k => k.address));
    doc.keys = doc.keys.filter(k => !drop.has(k.address));
  }
  // ---- administration ---------------------------------------------------------------------------
  /** Adds keypairs to the pool. Returns the added addresses and the rejected entries (source and reason only). */
  async importKeys({ actorId, entries, scope = 'all' }) {
    await this.requireAdmin(actorId);
    if (!VANITY_SCOPES.includes(scope)) fail('Choose which launches these addresses are for.');
    const parsed = parseVanityEntries(entries);
    try {
      return await this.locked(async () => {
        const doc = await this.load(), now = this.now(), known = new Map(doc.keys.map(k => [k.address, k])), seen = new Set(), added = [], rejected = [...parsed.rejected];
        const history = await this.store.read(SEEN, null) || { version: 1, h: '' }; if (history.version !== 1 || typeof history.h !== 'string') fail('The vanity address history was written by a newer release. Nothing was changed.', 503, 'VANITY_VERSION');
        const before = new Set(history.h.match(/.{8}/g) || []);
        // Addresses already in the pool whose history write was lost are remembered with this import.
        const backfill = doc.keys.map(k => seenHash(k.address)).filter(h => !before.has(h));
        const refuse = (key, reason) => rejected.push({ where: key.where, reason, seq: key.seq });
        let room = VANITY_LIMITS.poolKeys - doc.keys.filter(k => k.state === 'available' || k.state === 'reserved').length;
        for (const key of parsed.keys) {
          if (seen.has(key.address)) { refuse(key, 'listed twice in this import'); continue; }
          seen.add(key.address);
          const existing = known.get(key.address);
          if (existing) { refuse(key, existing.state === 'used' || existing.state === 'skipped' ? 'already used' : 'already in the pool'); continue; }
          if (before.has(seenHash(key.address))) { refuse(key, 'already used'); continue; }
          if (room <= 0) { refuse(key, 'the pool is full'); continue; }
          doc.keys.push({ address: key.address, secret: key.secret, scope, addedAt: now, addedBy: label(actorId, 64), state: 'available' }); added.push(key.address); room--;
        }
        // The pool first: if the history write then fails, the addresses are still refused while they are in the pool.
        if (added.length) { doc.stats.fallbacksSinceImport = 0; this.event(doc, 'import', `${added.length} address${added.length === 1 ? '' : 'es'} added for ${scope === 'all' ? 'every launch' : VANITY_LABELS[scope] + ' launches'}.`); await this.save(doc); await this.store.write(SEEN, { version: 1, h: history.h + [...new Set([...backfill, ...added.map(seenHash)])].join('') }); }
        return { added, rejected: inOrder(rejected), truncated: parsed.truncated, view: this.snapshot(doc) };
      });
    } finally { for (const key of parsed.keys) key.secret = ''; }
  }
  /** Removes unused addresses (and their keys) from the pool. Addresses leased to a launch in progress, or used, stay. */
  async remove({ actorId, addresses }) {
    await this.requireAdmin(actorId);
    if (!Array.isArray(addresses) || !addresses.length || addresses.length > 1000 || !addresses.every(a => typeof a === 'string' && ADDRESS.test(a))) fail('Choose the addresses to remove.');
    return this.locked(async () => {
      const doc = await this.load(); this.expire(doc);
      const wanted = new Set(addresses), removed = [], kept = [];
      for (const address of wanted) {
        const key = doc.keys.find(k => k.address === address);
        if (!key) kept.push({ address, reason: 'not in the pool' });
        else if (key.state === 'reserved') kept.push({ address, reason: 'a launch is using it right now; try again in a few minutes' });
        else if (key.state === 'used') kept.push({ address, reason: 'already used' });
        else removed.push(address);
      }
      if (removed.length) {
        const drop = new Set(removed), unused = new Set(doc.keys.filter(k => drop.has(k.address) && k.state === 'available').map(k => seenHash(k.address)));
        doc.keys = doc.keys.filter(k => !drop.has(k.address)); this.event(doc, 'remove', `${removed.length} address${removed.length === 1 ? '' : 'es'} removed from the pool.`); await this.save(doc);
        // A removed address that was never used may be added again later.
        if (unused.size) { const history = await this.store.read(SEEN, null); if (history?.version === 1 && typeof history.h === 'string') await this.store.write(SEEN, { version: 1, h: (history.h.match(/.{8}/g) || []).filter(h => !unused.has(h)).join('') }); }
      }
      return { removed, kept, view: this.snapshot(doc) };
    });
  }
  /**
   * Admin view: counts, the pool and the used list. Addresses only, never keys. Without a query the pool
   * lists its first 2,000 and the used list its first 1,000 entries; `query` pages each list separately
   * (`pool`/`used`: { offset, limit, state }) after `search` (an address prefix or any part of an address,
   * coin name or ticker). Only the returned used rows are checked onchain.
   */
  async view(actorId, query = {}) {
    await this.requireAdmin(actorId);
    const doc = await this.load(), snapshot = this.snapshot(doc, query);
    // A created coin stays created; "not yet" is asked again after a minute.
    const fresh = address => { const cached = this.chainCache.get(address); return !!cached && (cached.onChain || this.now() - cached.at <= ONCHAIN_TTL); };
    const pending = snapshot.used.filter(row => row.state === 'used' && !fresh(row.address)).map(row => row.address);
    if (pending.length && typeof this.onChain === 'function') {
      try { for (let i = 0; i < pending.length && i < 1000; i += 100) { const batch = pending.slice(i, i + 100), found = await this.onChain(batch); batch.forEach((address, n) => { if (typeof found?.[n] === 'boolean') this.chainCache.set(address, { onChain: found[n], at: this.now() }); }); } } catch { /* shown as unknown */ }
    }
    for (const row of snapshot.used) if (row.state === 'used') { const cached = this.chainCache.get(row.address); row.onChain = cached ? cached.onChain : null; }
    return snapshot;
  }
  snapshot(doc, query = {}) {
    const now = this.now(), pool = [], used = [], available = Object.fromEntries(VANITY_SCOPES.map(s => [s, 0]));
    let reserved = 0, skipped = 0;
    for (const key of doc.keys) {
      const leased = key.state === 'reserved' && key.lease?.until > now;
      if (key.state === 'available' || (key.state === 'reserved' && !leased)) { available[key.scope] = (available[key.scope] || 0) + 1; pool.push({ address: key.address, scope: key.scope, addedAt: key.addedAt, state: 'available' }); }
      else if (leased) { reserved++; pool.push({ address: key.address, scope: key.scope, addedAt: key.addedAt, state: 'reserved', venue: key.lease.venue, until: key.lease.until }); }
      else { if (key.state === 'skipped') skipped++; used.push({ address: key.address, scope: key.scope, addedAt: key.addedAt, state: key.state, venue: key.use?.venue || null, at: key.use?.at || null, name: key.use?.name || '', symbol: key.use?.symbol || '', reason: key.use?.reason || '' }); }
    }
    pool.sort((a, b) => a.addedAt - b.addedAt); used.sort((a, b) => (b.at || 0) - (a.at || 0));
    const forVenue = Object.fromEntries(VANITY_VENUES.map(v => [v, (available[v] || 0) + (available.all || 0)]));
    const page = (rows, options, fallbackLimit, states) => pageVanityRows(rows, options, fallbackLimit, states, query.search);
    const pooled = page(pool, query.pool, 2000, { available: row => row.state === 'available', reserved: row => row.state === 'reserved', ...Object.fromEntries(VANITY_SCOPES.map(scope => [scope, row => row.scope === scope])) });
    const taken = page(used, query.used, 1000, { used: row => row.state === 'used', skipped: row => row.state === 'skipped', ...Object.fromEntries(VANITY_VENUES.map(venue => [venue, row => row.venue === venue])) });
    return {
      version: 1, at: now, labels: VANITY_LABELS, scopes: VANITY_SCOPES, lowWater: this.lowWater,
      counts: { available: Object.values(available).reduce((a, b) => a + b, 0), byScope: available, forVenue, reserved, used: used.length - skipped, skipped },
      stocked: doc.keys.length > 0, low: doc.keys.length ? VANITY_VENUES.filter(v => forVenue[v] < this.lowWater) : [],
      fallbacks: { total: doc.stats.fallbacks, sinceImport: doc.stats.fallbacksSinceImport, lastAt: doc.stats.lastFallbackAt, lastVenue: doc.stats.lastFallbackVenue },
      checks: { failures: doc.stats.checkFailures, lastFailureAt: doc.stats.lastCheckFailureAt },
      pool: pooled.rows, poolTotal: pool.length, poolMatched: pooled.matched, poolOffset: pooled.offset, poolLimit: pooled.limit, poolNextOffset: pooled.nextOffset,
      used: taken.rows, usedTotal: used.length, usedMatched: taken.matched, usedOffset: taken.offset, usedLimit: taken.limit, usedNextOffset: taken.nextOffset,
      search: typeof query.search === 'string' ? label(query.search, 64).toLowerCase() : '',
      events: doc.events.slice(-30).reverse(),
    };
  }
}

/** A random 16-byte hex id, used by venues that assign the launch id before reserving. */
export const vanityRef = () => randomBytes(16).toString('hex');
