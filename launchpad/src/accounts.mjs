import { launchpadEnv } from './brand-env.mjs';
import { defaultTradingWallets } from './wallet-generation.mjs';
import { createRobinhoodAccount } from './robinhood-settings.mjs';
import { createPublicKey, verify, createHash, createHmac, hkdfSync, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { passwordHash, verifyPassword, validatePassword } from './password-hash.mjs';
export { passwordHash };
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { TelegramStore, loadMasterKey, userId } from './telegram-store.mjs';
import { acquireProcessLock } from './process-lock.mjs';
import { defaults } from './telegram-settings.mjs';
import { newTotpSecret, verifyTotp, newRecoveryCodes, recoveryHash } from './totp.mjs';
import { isAddress as isEvmAddress, checksumAddress as evmChecksum, recoverAddress as recoverEvmAddress } from './evm/secp256k1.mjs';
import { personalMessageHash } from './evm/tx.mjs';

const scrypt = promisify(scryptCallback);
const AUTH_ERROR = 'Invalid username or password.';
const AUTH_PROOF = Symbol('authentication-proof');
const securityStamp = record => JSON.stringify([record.password.hash, record.mfa?.secret || null]);
const walletStamp = record => tokenHash(JSON.stringify([securityStamp(record), record.signInWallet || '', record.walletLinkVersion || 0, record.walletSessionVersion || 0]));
const ownsSignInWallet = (record, wallet) => record.authType === 'wallet' ? record.mainWallet === wallet : record.signInWallet === wallet;
function requireCurrentProof(record, proof) {
  if (proof?.[AUTH_PROOF] !== securityStamp(record)) throw new Error('Account security changed. Sign in again.');
}
const SESSION_TTL = 12 * 60 * 60 * 1000;
const LINK_TTL = 10 * 60 * 1000;
const tokenHash = value => createHash('sha256').update(value).digest('hex');
const emptyRegistry = () => ({ version: 1, accounts: [], sessions: [], links: [] });
const REGISTRY_REVALIDATE_MS = 5000;
// Only immutable read snapshots receive indexes. Mutation callbacks work with an
// independent copy and continue using array lookup so edits cannot stale an index.
const registryIndexes = new WeakMap();
function freezeRegistry(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeRegistry(item);
    Object.freeze(value);
  }
  return value;
}
function indexedRegistry(value) {
  const accounts = new Map(), usernames = new Map(), telegram = new Map(), wallets = new Map(), sessions = new Map();
  for (const record of value.accounts) {
    accounts.set(record.id, record); usernames.set(record.username, record);
    if (record.telegramId) telegram.set(record.telegramId, record);
    if (record.authType === 'wallet' && !wallets.has(record.mainWallet)) wallets.set(record.mainWallet, record);
  }
  for (const session of value.sessions) if (!sessions.has(session.hash)) sessions.set(session.hash, session);
  registryIndexes.set(value, { accounts, usernames, telegram, wallets, sessions });
  return freezeRegistry(value);
}
const lookupAccount = (registry, id) => registryIndexes.has(registry) ? registryIndexes.get(registry).accounts.get(id) : registry.accounts.find(record => record.id === id);
function registryRevision(info) {
  if (!info.isFile()) throw new Error('Account registry is damaged; restore the matching data and key.');
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}
// The registry is one encrypted document and every host-wide report scans it,
// so the total number of accounts of every kind stays bounded by this ceiling
// (also the largest LAUNCHPAD_MAX_USERS and every report's account scan limit).
export const MAX_REGISTRY_ACCOUNTS = 10000;
function validateCapacity(maxUsers) {
  if (maxUsers !== undefined && (!Number.isSafeInteger(maxUsers) || maxUsers < 1 || maxUsers > MAX_REGISTRY_ACCOUNTS)) throw new Error('Invalid account capacity.');
}
const REGISTRATION_FULL = 'Registration is currently full. Contact the operator.';
// Password attempts: each source address has its own allowance per username, so
// a stranger can no longer lock an account out by guessing from elsewhere. Wrong
// passwords and second factors from addresses this account has not signed in
// from recently also share a per-username ceiling that still bounds distributed
// guessing; an address the account recently signed in from is never blocked by
// it. Reauthentication (only reachable with the account's own session) has its
// own allowance and is never affected by anonymous sign-in failures.
const AUTH_WINDOW_MS = 15 * 60000, AUTH_SOURCE_ATTEMPTS = 10, AUTH_PASSWORD_FAILURES = 50, AUTH_FACTOR_FAILURES = 10, AUTH_REAUTH_ATTEMPTS = 10;
const AUTH_MAX_WINDOWS = 20000, AUTH_TRUST_MS = 30 * 86400000, AUTH_TRUSTED_PER_ACCOUNT = 8, AUTH_MAX_TRUSTED = 20000;
const tooManyAttempts = ms => {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return Object.assign(new Error(`Too many account attempts. Wait ${minutes} minute${minutes === 1 ? '' : 's'} before trying again.`), { statusCode: 429, retryAfterMs: Math.max(1000, ms), rateWindow: true });
};
const authSource = value => typeof value === 'string' && value.trim() ? value.trim().slice(0, 100) : 'local';
// Pending wallet sign-in challenges live in memory: a challenge lost in a restart
// only means the visitor signs again, and an unauthenticated request never
// rewrites the registry. The table is bounded; the oldest pending entry yields.
const WALLET_CHALLENGE_MS = 5 * 60000, MAX_WALLET_CHALLENGES = 10000;
function walletUsername(registry) {
  const adjectives=['sunrise','coral','amber','violet','golden','mellow','cosmic','lunar','copper','peach','silver','bright'];
  const nouns=['otter','falcon','comet','fox','panda','heron','tiger','finch','badger','orca','lynx','raven'];
  for(let attempt=0;attempt<100;attempt++){
    const bytes=randomBytes(6),name=`${adjectives[bytes[0]%adjectives.length]}-${nouns[bytes[1]%nouns.length]}-${bytes.subarray(2).toString('hex')}`;
    if(!registry.accounts.some(record=>record.username===name))return name;
  }
  throw new Error('Could not allocate a wallet username. Connect again.');
}


export function accountId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new Error('Invalid Launchpad account.');
  return value;
}
export function accountKey(master, id) {
  return Buffer.from(hkdfSync('sha256', master, Buffer.from('relay-accounts-v1'), Buffer.from(accountId(id)), 32));
}
export function normalizeUsername(value) {
  if (typeof value !== 'string') throw new Error('Username must contain 3–32 letters, numbers, underscores or hyphens.');
  const name = value.trim().toLowerCase();
  if (!/^[a-z0-9_][a-z0-9_-]{2,31}$/.test(name)) throw new Error('Username must contain 3–32 letters, numbers, underscores or hyphens.');
  return name;
}
function cashbackAddress(value) {
  if (typeof value !== 'string') throw new Error('Enter a valid Solana cashback wallet address.');
  let key; try { key = new PublicKey(value.trim()); } catch { throw new Error('Enter a valid Solana cashback wallet address.'); }
  if (key.toBase58() !== value.trim() || !PublicKey.isOnCurve(key.toBytes()) || key.equals(PublicKey.default)) throw new Error('Use a regular Solana wallet as your cashback destination.');
  return key.toBase58();
}
/** A linked EVM wallet (Robinhood Chain and the other EVM venues), checksummed; never an auth key. */
function evmWalletAddress(value) {
  if (typeof value !== 'string' || !isEvmAddress(value.trim())) throw new Error('Connect a valid EVM wallet address.');
  const address = evmChecksum(value.trim());
  if (/^0x0{40}$/i.test(address)) throw new Error('Connect a valid EVM wallet address.');
  return address;
}
const sameEvmWallet = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
/**
 * The address that signed `message` with an EIP-191 personal signature (65 bytes: r, s, v with v = 27/28 or 0/1),
 * checksummed. Throws 'Invalid wallet signature.' for anything else.
 */
export function evmSignatureAddress(message, signature) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('Invalid wallet signature.');
  const bytes = Buffer.from(signature.slice(2), 'hex');
  const r = BigInt('0x' + bytes.subarray(0, 32).toString('hex')), s = BigInt('0x' + bytes.subarray(32, 64).toString('hex'));
  let v = bytes[64]; if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error('Invalid wallet signature.');
  try { return evmChecksum(recoverEvmAddress(personalMessageHash(message), { r, s, recovery: v })); } catch { throw new Error('Invalid wallet signature.'); }
}
function publicAccount(record, registry) {
  if (!record) return null;
  const walletAccount = record.authType !== 'wallet' && record.signInWallet && (registryIndexes.has(registry) ? registryIndexes.get(registry).wallets.get(record.signInWallet) : registry?.accounts?.find(row => row.authType === 'wallet' && row.mainWallet === record.signInWallet));
  return {
    bio: record.bio || '', avatar: record.avatarId ? '/token-images/'+record.avatarId : null, avatarId: record.avatarId || '', usernameChangeAvailableAt: record.usernameChangedAt ? record.usernameChangedAt + 30*86400000 : 0, authType: record.authType || 'password', id: record.id, username: record.username, mainWallet: record.mainWallet, cashbackWallet: record.cashbackWallet || record.mainWallet,
    signInWallet: record.authType === 'wallet' ? record.mainWallet : record.signInWallet || '', walletAccount: walletAccount ? { id: walletAccount.id, username: walletAccount.username } : null,
    evmWallet: record.evmWallet || '', evmWalletLinkedAt: record.evmWalletLinkedAt || 0,
    banned: record.banned===true, cashbackBps: record.cashbackBps, role: record.role, createdAt: record.createdAt,
    telegramId: record.telegramId || null,
    mfaEnabled: !!record.mfa, recoveryCodesRemaining: record.mfa?.recoveryHashes?.length || 0,
  };
}
function findAccount(registry, id) {
  const record = lookupAccount(registry, accountId(id));
  if (!record) throw new Error('Launchpad account was not found.');
  return record;
}
function validateRegistry(value) {
  if (value?.version !== 1 || !['accounts', 'sessions', 'links'].every(key => Array.isArray(value[key]))) throw new Error('Account registry is damaged; restore the matching data and key.');
  const ids = new Set(), usernames = new Set(), telegramIds = new Set(), signInWallets = new Set(), evmWallets = new Set();
  for (const record of value.accounts) {
    accountId(record.id);
    if (record.mfa && (!/^[A-Z2-7]{32}$/.test(record.mfa.secret) || !Number.isSafeInteger(record.mfa.lastCounter) || !Array.isArray(record.mfa.recoveryHashes) || !record.mfa.recoveryHashes.every(hash => /^[a-f0-9]{64}$/.test(hash)))) throw new Error('Two-factor authentication data is damaged.');
    if (record.username !== normalizeUsername(record.username) || ids.has(record.id) || usernames.has(record.username) || !['user', 'admin'].includes(record.role) || !Number.isInteger(record.cashbackBps) || record.cashbackBps < 0 || record.cashbackBps > 10000 || typeof record.mainWallet !== 'string') throw new Error('Account registry is damaged; restore the matching data and key.');
    if (record.cashbackWallet !== undefined && cashbackAddress(record.cashbackWallet) !== record.cashbackWallet) throw new Error('Account cashback wallet data is damaged.');
    if (record.signInWallet) { if (record.authType === 'wallet' || cashbackAddress(record.signInWallet) !== record.signInWallet || signInWallets.has(record.signInWallet)) throw new Error('Account sign-in wallet data is damaged.'); signInWallets.add(record.signInWallet); }
    if (record.evmWallet !== undefined) { let ok = false; try { ok = evmWalletAddress(record.evmWallet) === record.evmWallet && !evmWallets.has(record.evmWallet.toLowerCase()); } catch { ok = false; } if (!ok) throw new Error('Account EVM wallet data is damaged.'); evmWallets.add(record.evmWallet.toLowerCase()); }
    if (record.telegramId) {
      if (userId(record.telegramId) !== record.telegramId || telegramIds.has(record.telegramId)) throw new Error('Account registry is damaged; restore the matching data and key.');
      telegramIds.add(record.telegramId);
    }
    ids.add(record.id); usernames.add(record.username);
  }
  for (const session of value.sessions) if (!ids.has(session.accountId) || !/^[a-f0-9]{64}$/.test(session.hash) || !Number.isSafeInteger(session.expiresAt)) throw new Error('Account session data is damaged.');
  for (const link of value.links) if (!ids.has(link.accountId) || !/^[a-f0-9]{64}$/.test(link.hash) || !Number.isSafeInteger(link.expiresAt)) throw new Error('Account link data is damaged.');
  return value;
}

// HTTP/CLI callers enforce authorization and rate limits. Public registration
// always creates an ordinary user; an administrator must be designated by CLI.
export class AccountService {
  #walletProofs = new WeakMap();
  #passwordProofs = new WeakMap();
  #linkedAccountProofs = new WeakMap();
  #registryCache = null;
  #registryRead = null;
  #registryGeneration = 0;
  #authSweepAt = 0;
  #trustedSources = new Map();
  #walletChallenges = new Map();
  #walletChallengeBindings = new Map();
  constructor(dir, { now = Date.now, sessionTtlMs = SESSION_TTL, linkTtlMs = LINK_TTL, keyFile = launchpadEnv('MASTER_KEY_FILE'), requireExisting = false, maxAccounts = MAX_REGISTRY_ACCOUNTS } = {}) {
    if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1000 || sessionTtlMs > 30 * 24 * 60 * 60 * 1000) throw new Error('Invalid session lifetime.');
    if (!Number.isSafeInteger(linkTtlMs) || linkTtlMs < 1000 || linkTtlMs > 60 * 60 * 1000) throw new Error('Invalid linking lifetime.');
    if (typeof requireExisting !== 'boolean') throw new Error('Invalid existing-account-store requirement.');
    if (!Number.isSafeInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > MAX_REGISTRY_ACCOUNTS) throw new Error('Invalid account capacity.');
    this.dir = dir; this.now = now; this.sessionTtlMs = sessionTtlMs; this.linkTtlMs = linkTtlMs; this.requireExisting = requireExisting; this.maxAccounts = maxAccounts;
    this.queue = Promise.resolve(); this.stores = new Map(); this.initialized = false;
    this.keyFile = keyFile; this.authJobs = 0; this.authLimits = new Map();
  }
  async init() {
    if (this.initialized) return this;
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      if (this.requireExisting) {
        if (!(await stat(this.dir)).isDirectory()) throw new Error('Existing account data is required; no account store was created.');
      } else await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const release = await acquireProcessLock(join(this.dir, 'accounts.lock'));
      try {
        this.master = await loadMasterKey(this.dir, { keyFile: this.keyFile || (this.requireExisting ? join(this.dir, 'master.key') : undefined) });
        this.hostStore = new TelegramStore(this.dir, this.master, 'relay-accounts-host');
        let registry = await this.hostStore.read('registry');
        if (!registry) {
          if (this.requireExisting) throw new Error('Account registry is missing; no account store was created.');
          const existing = await readdir(join(this.dir, 'users')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
          if (existing.length) throw new Error('Account registry is missing. Restore the registry and matching key; existing wallets will not be reset.');
          registry = emptyRegistry(); await this.hostStore.write('registry', registry);
        }
        validateRegistry(registry);
        // Unknown usernames still take the same password derivation path.
        this.dummyPassword = await passwordHash(randomBytes(32).toString('base64url'));
        this.initialized = true; return this;
      } finally { await release(); }
    })();
    try { return await this.initPromise; } finally { this.initPromise = null; }
  }
  ready() { if (!this.initialized) throw new Error('Account service is not initialized.'); }
  async registry() {
    this.ready();
    // Every read checks the durable file revision: there is no time window in
    // which a completed logout, ban or role change can be hidden by a cache TTL.
    // Each caller stats independently (including callers arriving during a
    // read); only decrypt/validate work for an identical revision is coalesced.
    const generation = this.#registryGeneration;
    let revision;
    try { revision = await this.#revision(); }
    catch (error) { if (generation === this.#registryGeneration) this.#registryCache = null; throw error; }
    if (generation !== this.#registryGeneration) return this.registry();
    const cached = this.#registryCache, elapsed = this.now() - (cached?.loadedAt || 0);
    if (cached?.revision === revision && elapsed >= 0 && elapsed < REGISTRY_REVALIDATE_MS) return cached.value;
    if (this.#registryRead?.revision === revision && this.#registryRead.generation === generation) return this.#registryRead.job;
    const job = this.#readRegistry(generation, revision);
    this.#registryRead = { revision, generation, job };
    try { return await job; }
    finally { if (this.#registryRead?.job === job) this.#registryRead = null; }
  }
  async #revision() {
    try { return registryRevision(await stat(this.hostStore.path('registry'), { bigint: true })); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('Account registry is missing; no data was reset.');
      throw error;
    }
  }
  async #readRegistry(generation, initialRevision) {
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const before = attempt === 0 ? initialRevision : await this.#revision();
        if (generation !== this.#registryGeneration) return this.registry();
        const cached = this.#registryCache, elapsed = this.now() - (cached?.loadedAt || 0);
        if (cached?.revision === before && elapsed >= 0 && elapsed < REGISTRY_REVALIDATE_MS) return cached.value;
        const registry = await this.hostStore.read('registry');
        if (!registry) throw new Error('Account registry is missing; no data was reset.');
        const after = await this.#revision();
        if (generation !== this.#registryGeneration) return this.registry();
        // A concurrent process may replace the file between stat and read. Only
        // publish a snapshot whose entire read belongs to one durable revision.
        if (before !== after) continue;
        const value = indexedRegistry(validateRegistry(registry));
        this.#registryCache = { value, revision: after, loadedAt: this.now() };
        return value;
      }
      throw Object.assign(new Error('Account settings are changing. Try again shortly.'), { statusCode: 503 });
    } catch (error) {
      // Missing/corrupt storage must fail closed, even with a healthy old cache.
      if (generation === this.#registryGeneration) this.#registryCache = null;
      throw error;
    }
  }
  #invalidateRegistry() {
    this.#registryGeneration++;
    this.#registryCache = null;
    this.#registryRead = null;
  }
  async mutate(callback) {
    this.ready();
    const job = this.queue.catch(() => {}).then(async () => {
      const release = await acquireProcessLock(join(this.dir, 'accounts.lock'));
      try {
        const registry = structuredClone(await this.registry()), result = await callback(registry);
        await this.hostStore.write('registry', registry);
        return result;
      } finally { this.#invalidateRegistry(); await release(); }
    });
    this.queue = job; return job;
  }
  storeFor(id) {
    this.ready(); accountId(id);
    if (!this.stores.has(id)) this.stores.set(id, new TelegramStore(join(this.dir, 'users', id), accountKey(this.master, id), `account:${id}`));
    return this.stores.get(id);
  }
  async register(username, password, { maxUsers } = {}) {
    validateCapacity(maxUsers);
    this.ready();
    if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,32}$/.test(username.trim())) throw new Error('Use 3–32 letters, numbers, or underscores for a new username.');
    normalizeUsername(username);
    return this.registerWithCredential(username, await this.hashPassword(password), { maxUsers });
  }
  /**
   * A password account from a credential made by passwordHash() elsewhere: a hosting platform hashes a new launchpad owner's
   * password when it is chosen and keeps only the hash until the launchpad exists (scripts/tenant-provision.mjs).
   */
  async registerWithCredential(username, credential, { maxUsers } = {}) {
    validateCapacity(maxUsers);
    this.ready();
    if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,32}$/.test(username.trim())) throw new Error('Use 3–32 letters, numbers, or underscores for a new username.');
    const name = normalizeUsername(username);
    if (credential?.algorithm !== 'scrypt-v1' || typeof credential.salt !== 'string' || typeof credential.hash !== 'string' || Buffer.from(credential.salt, 'base64').length !== 32 || Buffer.from(credential.hash, 'base64').length !== 64) throw new Error('Account password data is damaged.');
    credential = { algorithm: 'scrypt-v1', salt: credential.salt, hash: credential.hash };
    return this.mutate(async registry => {
      if (registry.accounts.some(record => record.username === name)) throw new Error('That username is already taken.');
      // LAUNCHPAD_MAX_USERS counts accounts with server-held credentials and wallets;
      // wallet-only visitors are bounded by the registry ceiling instead.
      if (maxUsers !== undefined && registry.accounts.filter(record => record.authType !== 'wallet').length >= maxUsers || registry.accounts.length >= this.maxAccounts) throw new Error(REGISTRATION_FULL);
      const id = randomBytes(16).toString('hex'), wallet = Keypair.generate(), store = this.storeFor(id);
      const record = { id, username: name, password: credential, mainWallet: wallet.publicKey.toBase58(), cashbackBps: 0, role: 'user', createdAt: this.now(), telegramId: null };
      try {
        await store.write('main-wallet', { publicKey: record.mainWallet, privateKey: bs58.encode(wallet.secretKey) });
        await store.write('settings', await defaultTradingWallets(defaults));
        await store.write('robinhood-account', createRobinhoodAccount());
      } catch (error) {
        await rm(store.dir, { recursive: true, force: true }).catch(() => {}); this.stores.delete(id); throw error;
      } finally { wallet.secretKey.fill(0); }
      // The registry is committed only after the isolated encrypted wallet and
      // default trading wallets exist. A failed registry write leaves an inert
      // orphan directory, never a login with a missing wallet or reused key.
      registry.accounts.push(record); return this.#passwordResult(publicAccount(record, registry), record);
    });
  }
  async moderateUser(actorId,{target,banned,reason}={}) {
    if(typeof target!=='string'||!target.trim()||typeof banned!=='boolean'||typeof reason!=='string'||reason.trim().length<5||reason.length>500)throw Error('Enter a username or wallet, a ban action and a reason (5–500 characters).');
    const value=target.trim();let wallet=null;try{wallet=new PublicKey(value).toBase58();}catch{}
    return this.mutate(registry=>{
      const actor=findAccount(registry,actorId);if(actor.role!=='admin'||!actor.mfa||actor.banned)throw Object.assign(Error('Administrator access required.'),{statusCode:403});
      const matches=registry.accounts.filter(a=>wallet?a.mainWallet===wallet||a.signInWallet===wallet:a.username===value.toLowerCase());
      if(!wallet&&!matches.length)throw Error('User not found.');
      if(matches.some(a=>a.role==='admin'))throw Error('Administrator accounts cannot be banned here.');
      registry.bannedWallets=(registry.bannedWallets||[]).filter(w=>w!==wallet);
      if(wallet&&banned)registry.bannedWallets.push(wallet);
      for(const record of matches){record.banned=banned;record.banReason=banned?reason.trim():'';
        registry.bannedWallets=registry.bannedWallets.filter(w=>w!==record.mainWallet);
        if(banned)registry.bannedWallets.push(record.mainWallet);
        if(banned){registry.sessions=registry.sessions.filter(row=>row.accountId!==record.id);registry.links=registry.links.filter(row=>row.accountId!==record.id);}
      }
      registry.moderationHistory=[...(registry.moderationHistory||[]),{actorId,target:value,banned,reason:reason.trim(),at:this.now()}].slice(-1000);
      return {banned,target:value,accounts:matches.map(row => publicAccount(row, registry))};
    });
  }
  async assertWalletAllowed(address){if((await this.registry()).bannedWallets?.includes(address))throw Object.assign(Error('This wallet is banned from Launchpad.'),{statusCode:403});}
  async updateProfile(id, { username, bio = '', avatarId = '' } = {}) {
    const name=normalizeUsername(username);
    if(typeof bio!=='string'||bio.length>280)throw new Error('Use a bio of at most 280 characters.');
    if(typeof avatarId!=='string'||avatarId&&!/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(avatarId))throw new Error('Upload a PNG, JPG or WebP profile picture.');
    if(avatarId){const images=await this.storeFor(id).read('launch-images',{ids:[]});if(!images.ids.includes(avatarId))throw new Error('Upload your own profile picture first.');}
    return this.mutate(registry=>{
      const record=findAccount(registry,id);
      if(name!==record.username){
        if(record.usernameChangedAt&&this.now()<record.usernameChangedAt+30*86400000)throw new Error('You can change your username once every 30 days.');
        if(registry.accounts.some(a=>a.id!==id&&a.username===name))throw new Error('That username is already taken.');
        record.username=name;record.usernameChangedAt=this.now();
      }
      record.bio=bio.trim();record.avatarId=avatarId;return publicAccount(record, registry);
    });
  }
  cashbackSession(registry, id, token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw Object.assign(new Error('Sign in again before changing your cashback wallet.'), { statusCode: 401 });
    const record = findAccount(registry, id), session = registry.sessions.find(row => row.accountId === id && row.hash === tokenHash(token) && row.expiresAt > this.now());
    const walletVerified = session && this.validWalletSession(registry, record, session);
    if (!session || session.authMethod === 'wallet' && !walletVerified || record.mfa && !session.mfaVerified && !walletVerified) throw Object.assign(new Error('Sign in again before changing account settings.'), { statusCode: 401 });
    if (record.banned || registry.bannedWallets?.includes(record.mainWallet)) throw Object.assign(new Error('This account is banned from Launchpad.'), { statusCode: 403 });
    return record;
  }
  async cashbackWalletChallenge(id, destination, { token, origin } = {}) {
    const address = cashbackAddress(destination), nonce = randomBytes(32).toString('hex'), expiresAt = this.now() + 5 * 60000;
    return this.mutate(registry => {
      const record = this.cashbackSession(registry, id, token);
      if (record.authType !== 'wallet') throw new Error('Verify your password to change your cashback wallet.');
      if (registry.bannedWallets?.includes(address)) throw Object.assign(new Error('This wallet is banned from Launchpad.'), { statusCode: 403 });
      const binding = tokenHash(token), message = `Launchpad cashback wallet change\nOrigin: ${origin}\nAccount: ${id}\nSigning wallet: ${record.mainWallet}\nNew cashback wallet: ${address}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}\n\nApprove this receiving address for your cashback. Your login wallet stays unchanged. This does not authorize a transaction.`;
      registry.cashbackChallenges = (registry.cashbackChallenges || []).filter(c => c.expiresAt > this.now() && c.binding !== binding);
      // Bounded: the oldest pending request yields instead of refusing everyone.
      while (registry.cashbackChallenges.length >= 1000) registry.cashbackChallenges.shift();
      registry.cashbackChallenges.push({ nonce, accountId: id, wallet: record.mainWallet, address, origin, binding, expiresAt, message });
      return { nonce, message, expiresAt };
    });
  }
  async setCashbackWallet(id, { address: destination, password, code, nonce, signature } = {}, { token, origin } = {}) {
    const address = cashbackAddress(destination), initial = findAccount(await this.registry(), id);
    const proof = initial.authType === 'wallet' ? null : await this.reauthenticate(id, password, code);
    return this.mutate(registry => {
      const record = this.cashbackSession(registry, id, token);
      if (registry.bannedWallets?.includes(address)) throw Object.assign(new Error('This wallet is banned from Launchpad.'), { statusCode: 403 });
      if (record.authType === 'wallet') {
        if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error('Invalid wallet signature.');
        const challenge = (registry.cashbackChallenges || []).find(c => c.nonce === nonce && c.accountId === id && c.wallet === record.mainWallet && c.address === address && c.origin === origin && c.binding === tokenHash(token) && c.expiresAt > this.now());
        if (!challenge) throw new Error('Cashback wallet request expired or changed. Verify the destination again.');
        const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100','hex'), new PublicKey(record.mainWallet).toBuffer()]), format: 'der', type: 'spki' });
        if (!verify(null, Buffer.from(challenge.message), key, Buffer.from(signature,'base64'))) throw new Error('Invalid wallet signature.');
      } else requireCurrentProof(record, proof);
      record.cashbackWallet = address;
      registry.cashbackChallenges = (registry.cashbackChallenges || []).filter(c => c.accountId !== id && c.expiresAt > this.now());
      this.recordSecurity(registry, id, 'cashback-wallet-updated');
      return publicAccount(record, registry);
    });
  }
  assertWalletLinkable(registry, record, address) {
    if (record.authType === 'wallet') throw new Error('Sign in with your username and password to link a wallet.');
    if (record.banned || registry.bannedWallets?.includes(address)) throw Object.assign(new Error('This account or wallet is banned from Launchpad.'), { statusCode: 403 });
    if (registry.accounts.some(row => row.id !== record.id && row.signInWallet === address)) throw new Error('This wallet is already linked to another account. Unlink it there first.');
    const original = registry.accounts.find(row => row.authType === 'wallet' && row.mainWallet === address);
    if (original?.banned) throw Object.assign(new Error('This wallet account is banned from Launchpad.'), { statusCode: 403 });
    if (original?.role === 'admin') throw new Error('This wallet already belongs to an administrator account.');
    return original;
  }
  async walletLinkChallenge(id, { address: value, password, code } = {}, { token, origin } = {}) {
    const address = cashbackAddress(value), initial = findAccount(await this.registry(), id);
    if (initial.authType === 'wallet') throw new Error('Sign in with your username and password to link a wallet.');
    const proof = await this.reauthenticate(id, password, code);
    return this.mutate(registry => {
      const record = this.cashbackSession(registry, id, token); requireCurrentProof(record, proof);
      this.assertWalletLinkable(registry, record, address);
      const nonce = randomBytes(32).toString('hex'), expiresAt = this.now() + 5 * 60000, binding = tokenHash(token);
      const message = `Launchpad link wallet for sign-in\nOrigin: ${origin}\nAccount: ${record.username} (${id})\nWallet: ${address}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}\n\nAllow this wallet to sign in to this existing Launchpad account without a password or authenticator code. This does not authorize a transaction or change your existing wallet keys.`;
      registry.walletLinkChallenges = (registry.walletLinkChallenges || []).filter(c => c.expiresAt > this.now() && c.accountId !== id);
      while (registry.walletLinkChallenges.length >= 1000) registry.walletLinkChallenges.shift();
      registry.walletLinkChallenges.push({ nonce, accountId: id, address, origin, binding, expiresAt, message, security: walletStamp(record) });
      return { nonce, message, expiresAt };
    });
  }
  async linkWallet(id, { nonce, signature } = {}, { token, origin } = {}) {
    if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error('Invalid wallet signature.');
    const verified = await this.mutate(registry => {
      const record = this.cashbackSession(registry, id, token);
      const challenge = (registry.walletLinkChallenges || []).find(c => c.nonce === nonce && c.accountId === id && c.origin === origin && c.binding === tokenHash(token) && c.security === walletStamp(record) && c.expiresAt > this.now());
      if (!challenge) throw new Error('Wallet link request expired or changed. Verify your account again.');
      const original = this.assertWalletLinkable(registry, record, challenge.address);
      const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100','hex'), new PublicKey(challenge.address).toBuffer()]), format: 'der', type: 'spki' });
      if (!verify(null, Buffer.from(challenge.message), key, Buffer.from(signature,'base64'))) throw new Error('Invalid wallet signature.');
      record.signInWallet = challenge.address; record.walletLinkVersion = (record.walletLinkVersion || 0) + 1;
      if (original) original.walletSessionVersion = (original.walletSessionVersion || 0) + 1;
      registry.walletLinkChallenges = registry.walletLinkChallenges.filter(c => c.accountId !== id);
      registry.sessions = registry.sessions.filter(row => !(row.accountId === id && row.authMethod === 'wallet') && row.accountId !== original?.id);
      this.recordSecurity(registry, id, 'sign-in-wallet-linked');
      return { account: publicAccount(record, registry), proof: { id, security: walletStamp(record), mfaVerified: !!record.mfa, expiresAt: this.now() + 30000 } };
    });
    this.#linkedAccountProofs.set(verified.account, verified.proof); return verified.account;
  }
  async unlinkWallet(id, { password, code } = {}, { token } = {}) {
    const initial = findAccount(await this.registry(), id);
    if (initial.authType === 'wallet') throw new Error('A wallet-created account must keep its sign-in wallet.');
    const proof = await this.reauthenticate(id, password, code);
    const verified = await this.mutate(registry => {
      const record = this.cashbackSession(registry, id, token); requireCurrentProof(record, proof);
      delete record.signInWallet; record.walletLinkVersion = (record.walletLinkVersion || 0) + 1;
      registry.walletLinkChallenges = (registry.walletLinkChallenges || []).filter(c => c.accountId !== id);
      registry.sessions = registry.sessions.filter(row => !(row.accountId === id && row.authMethod === 'wallet'));
      this.recordSecurity(registry, id, 'sign-in-wallet-unlinked');
      return { account: publicAccount(record, registry), proof: { id, security: walletStamp(record), mfaVerified: !!record.mfa, expiresAt: this.now() + 30000 } };
    });
    this.#linkedAccountProofs.set(verified.account, verified.proof); return verified.account;
  }
  // ---- the linked EVM wallet (v71.40): the account's wallet on Robinhood Chain and the other EVM venues. It is not a
  // sign-in method and moves no funds by itself: the pages prefer it, and the Robinhood venue records it as the
  // account's wallet. Linking proves control of the wallet (an EIP-191 personal signature over a challenge bound to
  // this session) and, on a password account, verifies the password and the second factor; a wallet-created account
  // is verified by its wallet session. One EVM wallet links to one account.
  assertEvmWalletLinkable(registry, record, address) {
    if (record.banned) throw Object.assign(new Error('This account is banned from Launchpad.'), { statusCode: 403 });
    if (registry.bannedEvmWallets?.some(w => sameEvmWallet(w, address))) throw Object.assign(new Error('This wallet is banned from Launchpad.'), { statusCode: 403 });
    if (registry.accounts.some(row => row.id !== record.id && sameEvmWallet(row.evmWallet, address))) throw new Error('This wallet is already linked to another Launchpad account. Disconnect it there first.');
  }
  async evmWalletChallenge(id, { address: value, password, code } = {}, { token, origin } = {}) {
    const address = evmWalletAddress(value), initial = findAccount(await this.registry(), id);
    const proof = initial.authType === 'wallet' ? null : await this.reauthenticate(id, password, code);
    return this.mutate(registry => {
      const record = this.cashbackSession(registry, id, token); if (proof) requireCurrentProof(record, proof);
      this.assertEvmWalletLinkable(registry, record, address);
      const nonce = randomBytes(32).toString('hex'), expiresAt = this.now() + 5 * 60000, binding = tokenHash(token);
      const message = `Launchpad link EVM wallet\nOrigin: ${origin}\nAccount: ${record.username} (${id})\nWallet: ${address}\nChain: Robinhood Chain (4663)\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}\n\nLink this wallet to your Launchpad account for Robinhood Chain launches, trades and rewards. This does not authorize a transaction and does not change how you sign in.`;
      registry.evmWalletChallenges = (registry.evmWalletChallenges || []).filter(c => c.expiresAt > this.now() && c.accountId !== id);
      while (registry.evmWalletChallenges.length >= 1000) registry.evmWalletChallenges.shift();
      registry.evmWalletChallenges.push({ nonce, accountId: id, address, origin, binding, expiresAt, message, security: walletStamp(record) });
      return { nonce, message, expiresAt, address };
    });
  }
  async linkEvmWallet(id, { nonce, signature } = {}, { token, origin } = {}) {
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('Invalid wallet signature.');
    return this.mutate(registry => {
      const record = this.cashbackSession(registry, id, token);
      const challenge = (registry.evmWalletChallenges || []).find(c => c.nonce === nonce && c.accountId === id && c.origin === origin && c.binding === tokenHash(token) && c.security === walletStamp(record) && c.expiresAt > this.now());
      if (!challenge) throw new Error('The wallet link request expired or changed. Verify your account again.');
      this.assertEvmWalletLinkable(registry, record, challenge.address);
      const signer = evmSignatureAddress(challenge.message, signature);
      if (!sameEvmWallet(signer, challenge.address)) throw new Error('The signature did not come from the wallet you connected. Connect that wallet and sign again.');
      record.evmWallet = challenge.address; record.evmWalletLinkedAt = this.now();
      registry.evmWalletChallenges = registry.evmWalletChallenges.filter(c => c.accountId !== id);
      this.recordSecurity(registry, id, 'evm-wallet-linked');
      return publicAccount(record, registry);
    });
  }
  async unlinkEvmWallet(id, { password, code } = {}, { token } = {}) {
    const initial = findAccount(await this.registry(), id);
    const proof = initial.authType === 'wallet' ? null : await this.reauthenticate(id, password, code);
    return this.mutate(registry => {
      const record = this.cashbackSession(registry, id, token); if (proof) requireCurrentProof(record, proof);
      if (!record.evmWallet) throw new Error('No EVM wallet is linked to this account.');
      delete record.evmWallet; delete record.evmWalletLinkedAt;
      registry.evmWalletChallenges = (registry.evmWalletChallenges || []).filter(c => c.accountId !== id);
      this.recordSecurity(registry, id, 'evm-wallet-unlinked');
      return publicAccount(record, registry);
    });
  }
  /** The account that linked this EVM wallet, if any (public view). */
  async accountByEvmWallet(address) {
    if (typeof address !== 'string' || !isEvmAddress(address)) return null;
    const registry = await this.registry(), record = registry.accounts.find(row => sameEvmWallet(row.evmWallet, address));
    return publicAccount(record, registry);
  }
  #forgetWalletChallenge(challenge) {
    if (!challenge) return;
    this.#walletChallenges.delete(challenge.nonce);
    if (this.#walletChallengeBindings.get(challenge.binding) === challenge.nonce) this.#walletChallengeBindings.delete(challenge.binding);
  }
  async walletChallenge(address, origin, binding, { accountId: requestedAccountId } = {}) {
    const key = new PublicKey(address);
    if (key.toBase58() !== address || !PublicKey.isOnCurve(key.toBytes())) throw new Error('Connect a valid Solana wallet.');
    if (requestedAccountId !== undefined) accountId(requestedAccountId);
    if (typeof binding !== 'string' || !binding) throw new Error('Connect your wallet again.');
    const registry = await this.registry();
    if(registry.bannedWallets?.includes(address))throw Object.assign(Error('This wallet is banned from Launchpad.'),{statusCode:403});
    if (requestedAccountId && !registry.accounts.some(row => row.id === requestedAccountId && row.authType === 'wallet' && row.mainWallet === address && !row.banned)) throw new Error('Original wallet account is unavailable.');
    const now = this.now(), nonce = randomBytes(32).toString('hex'), expiresAt = now + WALLET_CHALLENGE_MS, bindingHash = tokenHash(binding);
    const message = `Launchpad wallet sign-in\nOrigin: ${origin}\nWallet: ${address}${requestedAccountId ? `\nOriginal wallet account: ${requestedAccountId}` : ''}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt).toISOString()}\n\nThis proves wallet ownership. It does not authorize a transaction.`;
    // Entries are inserted in expiry order: drop expired ones from the front,
    // replace this browser's earlier challenge, then make room by retiring the
    // oldest pending challenge instead of refusing every new visitor.
    for (const pending of this.#walletChallenges.values()) { if (pending.expiresAt > now) break; this.#forgetWalletChallenge(pending); }
    this.#forgetWalletChallenge(this.#walletChallenges.get(this.#walletChallengeBindings.get(bindingHash)));
    while (this.#walletChallenges.size >= MAX_WALLET_CHALLENGES) this.#forgetWalletChallenge(this.#walletChallenges.values().next().value);
    this.#walletChallenges.set(nonce, { nonce, address, origin, binding: bindingHash, expiresAt, message, ...(requestedAccountId ? { accountId: requestedAccountId } : {}) });
    this.#walletChallengeBindings.set(bindingHash, nonce);
    return { nonce, message, expiresAt };
  }
  async authenticateWallet({ nonce, signature } = {}, origin, binding, { maxUsers } = {}) {
    validateCapacity(maxUsers);
    if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error('Invalid wallet signature.');
    this.ready();
    const challenge = typeof nonce === 'string' ? this.#walletChallenges.get(nonce) : undefined;
    if (!challenge || challenge.origin !== origin || typeof binding !== 'string' || challenge.binding !== tokenHash(binding) || challenge.expiresAt <= this.now()) throw new Error('Wallet request expired. Connect again.');
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100','hex'), new PublicKey(challenge.address).toBuffer()]), format: 'der', type: 'spki' });
    if (!verify(null, Buffer.from(challenge.message), key, Buffer.from(signature,'base64'))) throw new Error('Invalid wallet signature.');
    // Single use: verified and consumed in one synchronous step, so a concurrent
    // replay of the same proof can never find it.
    this.#forgetWalletChallenge(challenge);
    const banned = registry => { if(registry.bannedWallets?.includes(challenge.address))throw Object.assign(Error('This wallet is banned from Launchpad.'),{statusCode:403}); };
    const find = registry => challenge.accountId ? registry.accounts.find(a => a.id === challenge.accountId && a.authType === 'wallet' && a.mainWallet === challenge.address) : registry.accounts.find(a => a.authType !== 'wallet' && a.signInWallet === challenge.address) || registry.accounts.find(a => a.authType === 'wallet' && a.mainWallet === challenge.address);
    const legacyName = record => /^wallet-[a-f0-9]{24}$/.test(record.username);
    const finish = (registry, record) => {
      if (challenge.accountId && !record) throw new Error('Original wallet account is unavailable.');
      if(record.banned)throw Object.assign(Error('This account is banned from Launchpad.'),{statusCode:403});
      return { account: publicAccount(record, registry), proof: { id: record.id, wallet: challenge.address, security: walletStamp(record), expiresAt: this.now() + 30000 } };
    };
    // A returning wallet needs no registry write here: the session issued next
    // re-checks this proof (security stamp, wallet ownership, bans) atomically.
    const snapshot = await this.registry(); banned(snapshot);
    const known = find(snapshot);
    const result = known && !legacyName(known) || !known && challenge.accountId ? finish(snapshot, known) : await this.mutate(async registry => {
      banned(registry);
      let record = find(registry);
      if (!record && !challenge.accountId) {
        // Wallet-only visitors hold no server key or custodial wallet, so they do
        // not use LAUNCHPAD_MAX_USERS; the registry's total ceiling still bounds them.
        if (registry.accounts.length >= this.maxAccounts) throw new Error(REGISTRATION_FULL);
        const id = randomBytes(16).toString('hex');
        record = { id, username: walletUsername(registry), authType: 'wallet', mainWallet: challenge.address, password: { hash: randomBytes(32).toString('hex') }, cashbackBps: 0, role: 'user', createdAt: this.now(), telegramId: null };
        // No private key or custodial wallet is created for wallet-only visitors.
        await this.storeFor(id).write('settings', { ...structuredClone(defaults), wallets: [], walletSchema: 1 });
        registry.accounts.push(record);
      }
      const value = finish(registry, record);
      if(legacyName(record)){record.username=walletUsername(registry);value.account=publicAccount(record, registry);}
      return value;
    });
    this.#walletProofs.set(result.account, result.proof); return result.account;
  }
  #sweepAuthentication(now) {
    if (now < this.#authSweepAt && this.authLimits.size < AUTH_MAX_WINDOWS) return;
    for (const [key, value] of this.authLimits) if (value.until <= now) this.authLimits.delete(key);
    this.#authSweepAt = now + 1000;
  }
  // One fixed window per key. A full table forgets an idle window before one
  // that is currently refusing attempts; it never refuses a new key outright.
  #authenticationWindow(key, limit, now) {
    this.#sweepAuthentication(now);
    let bucket = this.authLimits.get(key);
    if (bucket && bucket.until <= now) { this.authLimits.delete(key); bucket = undefined; }
    if (bucket) this.authLimits.delete(key);
    else {
      if (this.authLimits.size >= AUTH_MAX_WINDOWS) {
        let victim, scanned = 0;
        for (const [candidate, value] of this.authLimits) { if (value.count < value.limit) { victim = candidate; break; } if (++scanned >= 256) break; }
        this.authLimits.delete(victim ?? this.authLimits.keys().next().value);
      }
      bucket = { count: 0, until: now + AUTH_WINDOW_MS, limit };
    }
    this.authLimits.set(key, bucket);
    return bucket;
  }
  #authenticationBlocked(key, now) { const bucket = this.authLimits.get(key); return bucket && bucket.until > now && bucket.count >= bucket.limit ? bucket : null; }
  #authenticationFailure(key, limit) { this.#authenticationWindow(key, limit, this.now()).count++; }
  limitAuthentication(key, limit = AUTH_SOURCE_ATTEMPTS) {
    const now = this.now(), bucket = this.#authenticationWindow(key, limit, now);
    if (bucket.count >= limit) throw tooManyAttempts(bucket.until - now);
    bucket.count++;
  }
  #trustedSource(name, source, now) { const until = this.#trustedSources.get(name)?.get(source); return !!until && until > now; }
  #trustSource(name, source, now) {
    const sources = this.#trustedSources.get(name) || new Map();
    this.#trustedSources.delete(name); sources.delete(source); sources.set(source, now + AUTH_TRUST_MS);
    while (sources.size > AUTH_TRUSTED_PER_ACCOUNT) sources.delete(sources.keys().next().value);
    this.#trustedSources.set(name, sources);
    while (this.#trustedSources.size > AUTH_MAX_TRUSTED) this.#trustedSources.delete(this.#trustedSources.keys().next().value);
  }
  async checkPassword(password, credential) {
    if (this.authJobs >= 4) throw Object.assign(new Error('Sign-in is busy. Try again shortly.'), { statusCode: 429, retryAfterMs: 2000 });
    this.authJobs++;
    try { return await verifyPassword(password, credential || this.dummyPassword); }
    finally { this.authJobs--; }
  }
  async hashPassword(password) {
    if (this.authJobs >= 4) throw Object.assign(new Error('Sign-in is busy. Try again shortly.'), { statusCode: 429, retryAfterMs: 2000 });
    this.authJobs++;
    try { return await passwordHash(password); } finally { this.authJobs--; }
  }
  consumeFactor(record, code) {
    if (!record.mfa) return;
    if (!code) throw Object.assign(new Error('Enter your authenticator code or a recovery code.'), { mfaRequired: true });
    const index = record.mfa.recoveryHashes.findIndex(hash => hash === recoveryHash(code));
    if (index >= 0) { record.mfa.recoveryHashes.splice(index, 1); return; }
    const counter = verifyTotp(record.mfa.secret, String(code).trim(), this.now(), record.mfa.lastCounter);
    if (counter === null) throw Object.assign(new Error('Invalid or already used authentication code. Use a new code.'), { mfaRequired: true });
    record.mfa.lastCounter = counter;
  }
  recordSecurity(registry, id, action) {
    registry.securityEvents = [...(registry.securityEvents || []), { accountId: id, action, at: this.now() }].slice(-1000);
  }
  // `source` is the caller's network address (HTTP) or omitted for local tools.
  async authenticate(username, password, code, { source } = {}) {
    let name;
    try { name = normalizeUsername(username); validatePassword(password); } catch { throw new Error(AUTH_ERROR); }
    const from = authSource(source), now = this.now(), attemptKey = `login:${name}:${from}`, passwordKey = `login-failures:${name}`, factorKey = `factor-failures:${name}`;
    const trusted = this.#trustedSource(name, from, now);
    this.limitAuthentication(attemptKey, AUTH_SOURCE_ATTEMPTS);
    const blocked = !trusted && (this.#authenticationBlocked(passwordKey, now) || this.#authenticationBlocked(factorKey, now));
    if (blocked) throw tooManyAttempts(blocked.until - now);
    const registry = await this.registry(), record = registryIndexes.get(registry).usernames.get(name);
    const valid = await this.checkPassword(password, record?.authType==='wallet'?undefined:record?.password);
    if (!record || !valid) { if (!trusted) this.#authenticationFailure(passwordKey, AUTH_PASSWORD_FAILURES); throw new Error(AUTH_ERROR); }
    let result;
    try { result = await this.finishAuthentication(record, code); }
    catch (error) { if (error.mfaRequired && code && !trusted) this.#authenticationFailure(factorKey, AUTH_FACTOR_FAILURES); throw error; }
    this.authLimits.delete(attemptKey); this.#trustSource(name, from, this.now());
    return result;
  }
  async finishAuthentication(record, code) {
    return this.mutate(registry => {
      const current = findAccount(registry, record.id);
      if(current.banned)throw Object.assign(Error('This account is banned from Launchpad.'),{statusCode:403});
      if (current.password.hash !== record.password.hash || current.mfa?.secret !== record.mfa?.secret) throw new Error('Account security changed. Sign in again.');
      this.consumeFactor(current, code);
      return this.#passwordResult(Object.defineProperty(publicAccount(current, registry), AUTH_PROOF, { value: securityStamp(current) }), current);
    });
  }
  // Reachable only through the account's own session; anonymous sign-in
  // failures for the same username never block it.
  async reauthenticate(id, password, code) {
    const record = findAccount(await this.registry(), id), attemptKey = `reauth:${record.id}`;
    this.limitAuthentication(attemptKey, AUTH_REAUTH_ATTEMPTS);
    try { validatePassword(password); } catch { throw new Error(AUTH_ERROR); }
    if (!await this.checkPassword(password, record.password)) throw new Error(AUTH_ERROR);
    const result = await this.finishAuthentication(record, code);
    this.authLimits.delete(attemptKey);
    return result;
  }
  async get(id) {
    try { accountId(id); } catch { return null; }
    const registry = await this.registry(); return publicAccount(lookupAccount(registry, id), registry);
  }
  async list() { const registry = await this.registry(); return registry.accounts.map(record => publicAccount(record, registry)); }
  async exportMainWallet(id, password, code) {
    const record = await this.reauthenticate(id, password, code);
    const saved = await this.storeFor(id).read('main-wallet');
    let wallet;
    try {
      wallet = Keypair.fromSecretKey(bs58.decode(saved?.privateKey || ''));
      if (saved.publicKey !== record.mainWallet || wallet.publicKey.toBase58() !== record.mainWallet) throw new Error('mismatch');
      return { publicKey: saved.publicKey, privateKey: saved.privateKey };
    } catch { throw new Error('Main wallet data is damaged. Restore the matching account data and key.'); }
    finally { wallet?.secretKey.fill(0); }
  }
  async setCashback(id, bps) {
    if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new Error('Cashback must be a whole number from 0 to 10000 basis points of the Launchpad fee.');
    return this.mutate(registry => { const record = findAccount(registry, id); record.cashbackBps = bps; return publicAccount(record, registry); });
  }
  async setAdmin(id, enabled = true) {
    if (typeof enabled !== 'boolean') throw new Error('Invalid account role.');
    return this.mutate(registry => { const record = findAccount(registry, id); record.role = enabled ? 'admin' : 'user'; return publicAccount(record, registry); });
  }
  // Password change, 2FA removal and "sign out everywhere" revoke every session
  // and link of the account. Their result carries a short-lived proof of the
  // password (and second factor) just verified, so the caller may issue one
  // replacement session for the browser that made the change
  // (createAuthenticatedSession); every other session stays revoked.
  async changePassword(id, currentPassword, newPassword, code) {
    const record = findAccount(await this.registry(), id);
    validatePassword(newPassword);
    const proof = await this.reauthenticate(id, currentPassword, code);
    const credential = await this.hashPassword(newPassword);
    const result = await this.mutate(registry => {
      const current = findAccount(registry, id);
      requireCurrentProof(current, proof);
      if(current.banned)throw Object.assign(Error('This account is banned from Launchpad.'),{statusCode:403});
      if (current.password.hash !== record.password.hash) throw new Error('Password changed. Sign in again before retrying.');
      current.password = credential;
      registry.sessions = registry.sessions.filter(session => session.accountId !== id);
      registry.links = registry.links.filter(link => link.accountId !== id);
      current.telegramId = null;
      this.recordSecurity(registry, id, 'password-changed');
      return this.#passwordResult(publicAccount(current, registry), current);
    });
    this.#trustedSources.delete(record.username);
    return result;
  }
  async beginMfa(id, password) {
    const proof = await this.reauthenticate(id, password);
    return this.mutate(registry => {
      const record = findAccount(registry, id);
      requireCurrentProof(record, proof);
      if (record.mfa) throw new Error('Two-factor authentication is already enabled.');
      const secret = newTotpSecret(); record.pendingMfa = { secret, expiresAt: this.now() + 10 * 60000 };
      return { secret, expiresAt: record.pendingMfa.expiresAt };
    });
  }
  async enableMfa(id, password, code) {
    const proof = await this.reauthenticate(id, password);
    return this.mutate(registry => {
      const record = findAccount(registry, id), pending = record.pendingMfa;
      requireCurrentProof(record, proof);
      if (record.mfa || !pending || pending.expiresAt <= this.now()) throw new Error('Start two-factor setup again.');
      const counter = verifyTotp(pending.secret, code, this.now());
      if (counter === null) throw new Error('Invalid authenticator code.');
      const recovery = newRecoveryCodes();
      record.mfa = { secret: pending.secret, lastCounter: counter, recoveryHashes: recovery.hashes }; delete record.pendingMfa;
      record.telegramId = null;
      registry.sessions = registry.sessions.filter(row => row.accountId !== id);
      registry.links = registry.links.filter(row => row.accountId !== id);
      this.recordSecurity(registry, id, 'two-factor-enabled');
      return this.#passwordResult({ recoveryCodes: recovery.codes }, record);
    });
  }
  async disableMfa(id, password, code) {
    const proof = await this.reauthenticate(id, password, code);
    const result = await this.mutate(registry => {
      const record = findAccount(registry, id);
      requireCurrentProof(record, proof);
      if (record.role === 'admin') throw new Error('Administrator accounts must keep two-factor authentication enabled.');
      delete record.mfa; delete record.pendingMfa;
      registry.sessions = registry.sessions.filter(row => row.accountId !== id);
      registry.links = registry.links.filter(row => row.accountId !== id);
      record.telegramId = null; this.recordSecurity(registry, id, 'two-factor-disabled');
      return this.#passwordResult(publicAccount(record, registry), record);
    });
    this.#trustedSources.delete(result.username);
    return result;
  }
  async revokeAllAccess(id, password, code) {
    const proof = await this.reauthenticate(id, password, code);
    const result = await this.mutate(registry => {
      const record = findAccount(registry, id); requireCurrentProof(record, proof); record.telegramId = null; record.walletSessionVersion = (record.walletSessionVersion || 0) + 1;
      registry.sessions = registry.sessions.filter(row => row.accountId !== id);
      registry.links = registry.links.filter(row => row.accountId !== id);
      this.recordSecurity(registry, id, 'all-access-revoked');
      return this.#passwordResult(publicAccount(record, registry), record);
    });
    this.#trustedSources.delete(result.username);
    return result;
  }
  async audit(id, action) { await this.mutate(registry => { findAccount(registry, id); this.recordSecurity(registry, id, action); }); }
  async securityEvents(id) { return (await this.registry()).securityEvents?.filter(row => row.accountId === id).slice(-20).reverse() || []; }
  csrfToken(token) { return createHmac('sha256', this.master).update(`relay-account-csrf-v1:${token}`).digest('base64url'); }
  validWalletSession(registry, record, session) {
    return !!record && session.authMethod === 'wallet' && session.walletVerified === true && ownsSignInWallet(record, session.walletAddress) && session.walletSecurity === walletStamp(record) && !registry.bannedWallets?.includes(session.walletAddress);
  }
  #passwordResult(value, record) {
    this.#passwordProofs.set(value, { id: record.id, security: walletStamp(record), mfaVerified: !!record.mfa, expiresAt: this.now() + 30000 });
    return value;
  }
  async createAuthenticatedSession(authenticatedResult) {
    const proof = authenticatedResult && this.#passwordProofs.get(authenticatedResult);
    if (!proof) throw new Error('Verify your account again before signing in.');
    this.#passwordProofs.delete(authenticatedResult);
    return this.#createSession(proof.id, { passwordProof: proof });
  }
  async createWalletSession(authenticatedAccount) {
    const proof = authenticatedAccount && this.#walletProofs.get(authenticatedAccount);
    if (!proof) throw new Error('Verify your wallet signature before signing in.');
    this.#walletProofs.delete(authenticatedAccount);
    return this.#createSession(proof.id, { walletProof: proof });
  }
  async createLinkedAccountSession(updatedAccount) {
    const proof = updatedAccount && this.#linkedAccountProofs.get(updatedAccount);
    if (!proof) throw new Error('Verify your account again before refreshing this session.');
    this.#linkedAccountProofs.delete(updatedAccount);
    return this.#createSession(proof.id, { reauthProof: proof });
  }
  // Trusted internal callers only. HTTP session issuance must consume a proof.
  async createSession(id, { mfaVerified = false } = {}) { return this.#createSession(id, { mfaVerified }); }
  async #createSession(id, { mfaVerified = false, walletProof = null, reauthProof = null, passwordProof = null } = {}) {
    const token = randomBytes(32).toString('base64url'), hash = tokenHash(token), expiresAt = this.now() + this.sessionTtlMs;
    return this.mutate(registry => {
      const record = findAccount(registry, id);
      if(record.banned)throw Object.assign(Error('This account is banned from Launchpad.'),{statusCode:403});
      if (passwordProof) {
        if (passwordProof.expiresAt <= this.now() || passwordProof.security !== walletStamp(record)) throw new Error('Account security changed or verification expired. Sign in again.');
        mfaVerified = passwordProof.mfaVerified;
      }
      if (reauthProof) {
        if (reauthProof.expiresAt <= this.now() || reauthProof.security !== walletStamp(record)) throw new Error('Account security changed or verification expired. Sign in again.');
        mfaVerified = reauthProof.mfaVerified;
      }
      if (walletProof && (walletProof.expiresAt <= this.now() || walletProof.security !== walletStamp(record) || !ownsSignInWallet(record, walletProof.wallet) || registry.bannedWallets?.includes(walletProof.wallet))) throw new Error('Wallet sign-in changed or expired. Connect again.');
      registry.sessions = registry.sessions.filter(session => session.expiresAt > this.now());
      // Wallet sign-in challenges are now held in memory; retire the old list.
      delete registry.walletChallenges;
      const own = registry.sessions.filter(session => session.accountId === id);
      const retire = new Set(own.slice(0, Math.max(0, own.length - 9)).map(session => session.hash));
      registry.sessions = registry.sessions.filter(session => !retire.has(session.hash));
      if (record.mfa && !mfaVerified && !walletProof) throw new Error('Two-factor authentication required.');
      const method = walletProof ? { authMethod: 'wallet', walletVerified: true, walletAddress: walletProof.wallet, walletSecurity: walletProof.security } : { authMethod: 'password', walletVerified: false };
      registry.sessions.push({ hash, accountId: id, expiresAt, mfaVerified, ...method });
      return { token, csrfToken: this.csrfToken(token), expiresAt, account: publicAccount(record, registry), authMethod: method.authMethod, walletVerified: method.walletVerified, mfaVerified };
    });
  }
  async getSession(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const registry = await this.registry(), hash = tokenHash(token);
    const session = registryIndexes.get(registry).sessions.get(hash);
    if (!session || session.expiresAt <= this.now()) return null;
    const record = lookupAccount(registry, session.accountId), account = publicAccount(record, registry);
    if(!account || account.banned)return null;
    const walletVerified = this.validWalletSession(registry, record, session);
    if (session.authMethod === 'wallet' && !walletVerified) return null;
    if (account.mfaEnabled && !session.mfaVerified && !walletVerified) return null;
    return { account, csrfToken: this.csrfToken(token), expiresAt: session.expiresAt, mfaVerified: session.mfaVerified === true, walletVerified, walletAddress: walletVerified ? session.walletAddress : null, authMethod: walletVerified ? 'wallet' : 'password' };
  }
  async verifyCsrf(token, csrfToken) {
    return (await this.getSessionWithCsrf(token, csrfToken)).csrfValid;
  }
  async getSessionWithCsrf(token, csrfToken) {
    const session = await this.getSession(token);
    const csrfValid = !!session && typeof csrfToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(csrfToken) && timingSafeEqual(Buffer.from(session.csrfToken), Buffer.from(csrfToken));
    return { session, csrfValid };
  }
  async revokeSession(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    await this.mutate(registry => { const hash = tokenHash(token); registry.sessions = registry.sessions.filter(session => session.hash !== hash); });
  }
  async createLinkCode(id) {
    const code = `RL-${randomBytes(18).toString('base64url')}`;
    return this.mutate(registry => {
      const record = findAccount(registry, id);
      if (record.telegramId) throw new Error('This account is already linked to Telegram.');
      registry.links = registry.links.filter(link => link.accountId !== id && link.expiresAt > this.now());
      const expiresAt = this.now() + this.linkTtlMs;
      registry.links.push({ accountId: id, hash: tokenHash(code), expiresAt });
      return { code, expiresAt };
    });
  }
  async redeemLinkCode(code, telegramId) {
    const telegram = userId(telegramId);
    if (typeof code !== 'string' || !/^RL-[A-Za-z0-9_-]{24}$/.test(code)) throw new Error('Link code is invalid or expired.');
    return this.mutate(registry => {
      const hash = tokenHash(code), link = registry.links.find(item => item.hash === hash && item.expiresAt > this.now());
      if (!link) throw new Error('Link code is invalid or expired.');
      const account = findAccount(registry, link.accountId);
      if (account.telegramId || registry.accounts.some(item => item.telegramId === telegram)) throw new Error('This Telegram identity or Launchpad account is already linked.');
      account.telegramId = telegram;
      registry.links = registry.links.filter(item => item.accountId !== account.id);
      return account.id;
    });
  }
  async getTelegramAccount(telegramId) {
    const id = userId(telegramId);
    const registry = await this.registry(), account = registryIndexes.get(registry).telegram.get(id); return publicAccount(account?.banned ? null : account, registry);
  }
  async unlinkTelegram(telegramId, expectedAccountId) {
    const telegram = userId(telegramId), id = accountId(expectedAccountId);
    return this.mutate(registry => {
      const record = registry.accounts.find(account => account.telegramId === telegram);
      if (!record) return null;
      if (record.id !== id) throw new Error('Telegram account link changed. Sign in again.');
      record.telegramId = null;
      registry.links = registry.links.filter(link => link.accountId !== id);
      return publicAccount(record, registry);
    });
  }
}
