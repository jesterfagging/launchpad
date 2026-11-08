// A white-label launchpad's own features, each switched on in its settings (tenant.json features):
//   registry     every coin numbered in launch order (the first 100 are Founding), a Launches page and a Stats page
//   summit       one coin in the spotlight per UTC day, drawn at random with odds weighted by market cap, volume and age
//   tickerLock   a ticker or name cannot be launched again for 3 days, nor while that coin is established; lookalike
//                tickers and copied images are allowed but flagged
//   bundleCheck  a minute and a half after launch the wallets that bought in the first 20 slots are traced to the wallets
//                that funded them; buyers linked to the creator or to each other are flagged with what they still hold
//   takeover     holders of 0.5% or more of a coin sign a request for a new logo, banner, links and description; the
//                owner approves it in the admin panel
// The coins and their markets come from the engine's own discovery (src/launchpad-explore.mjs); this module keeps only
// its own records, under <data>/pad/. Reads are public; nothing here moves funds or signs transactions.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';

export const LOCK_MS = 3 * 86400000, ESTABLISHED_ACTIVE_MS = 7 * 86400000, CLAIM_MS = 20 * 60000, FOUNDING = 100;
export const BUNDLE = Object.freeze({ delayMs: 90000, slots: 20, maxAgeMs: 6 * 3600000, maxTransactions: 60, fundingLookback: 8 });
export const TAKEOVER = Object.freeze({ minHoldPct: 0.5, messageMaxAgeMs: 10 * 60000, logoBytes: 1_000_000, bannerBytes: 2_500_000, description: 500 });
const DAY = 86400000;
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---------------------------------------------------------------- names, tickers and lookalikes
/** The ticker as it is locked: case-insensitive, letters and digits only. */
export const tickerKey = symbol => String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
/** The name as it is locked: ignoring case, spaces and symbols ("Peak Cat" and "PeakCat" are the same name). */
export const nameKey = name => String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const LEET = { 0: 'O', 1: 'I', 3: 'E', 4: 'A', 5: 'S', 7: 'T', 8: 'B', 9: 'G', 2: 'Z', 6: 'G' };
/** The ticker with look-alike digits read as letters (P3PE → PEPE). */
export const leetKey = symbol => tickerKey(String(symbol || '').replace(/\$/g, 'S').replace(/@/g, 'A')).replace(/[0-9]/g, d => LEET[d] || d);
export function editDistance(a, b) {
  if (a === b) return 0; if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) { const row = [i]; for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = row; }
  return prev[b.length];
}
/**
 * Whether two different tickers look alike: the same once digits are read as letters (P3PE), the same ticker with a short
 * add-on (PEPE2, PEPEAI, BABYPEPE), or one letter off in a long one (SOLANO). Different short words stay apart (DOGE, DOGS).
 */
export function looksAlike(a, b) {
  const ka = tickerKey(a), kb = tickerKey(b); if (!ka || !kb || ka === kb) return false;
  const la = leetKey(a), lb = leetKey(b); if (la === lb) return true;
  const [short, long] = la.length <= lb.length ? [la, lb] : [lb, la];
  if (short.length >= 4 && long.length - short.length <= 4 && (long.startsWith(short) || long.endsWith(short))) return true;
  return short.length >= 5 && editDistance(la, lb) === 1;
}
const value = coin => Number(coin?.marketCapUsd ?? coin?.fdvUsd) || 0;
/** Established: a $20K market cap, or graduated and still at $10K, and traded in the last 7 days. */
export const established = (entry, now) => !!entry && (entry.valueUsd >= 20000 || entry.graduated && entry.valueUsd >= 10000) && now - (entry.activeAt || 0) <= ESTABLISHED_ACTIVE_MS;

// ---------------------------------------------------------------- base58, signatures
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function fromBase58(text) {
  let n = 0n; for (const c of String(text)) { const i = B58.indexOf(c); if (i < 0) fail('Invalid address.'); n = n * 58n + BigInt(i); }
  const bytes = []; while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of String(text)) { if (c !== '1') break; bytes.unshift(0); }
  return Buffer.from(bytes);
}
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
/** An ed25519 signature by a Solana wallet over the exact message bytes. */
export function walletSigned(wallet, message, signatureBase64) {
  try { const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, fromBase58(wallet)]), format: 'der', type: 'spki' }); return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(String(signatureBase64), 'base64')); }
  catch { return false; }
}
/** The text a holder signs for a takeover request: the coin, the launchpad, a hash of everything asked for, the time. */
export const takeoverMessage = ({ host, mint, payloadHash, at }) => `Community takeover request\nLaunchpad: ${host}\nCoin: ${mint}\nRequest: ${payloadHash}\nTime: ${new Date(at).toISOString()}`;
export const payloadHash = payload => createHash('sha256').update(JSON.stringify(payload)).digest('hex');

// ---------------------------------------------------------------- the summit draw
/** A coin's odds for the day: market cap, 24-hour volume and how new it is. */
export function summitWeight(entry, now) {
  const ageDays = Math.max(0, (now - entry.createdAt) / DAY);
  return (0.5 + Math.log10(1 + entry.valueUsd / 1000)) * (0.5 + Math.log10(1 + (entry.volume24h || 0) / 1000)) * (1 + 2 * Math.exp(-ageDays / 3));
}
/** Draws one coin with a uniform number from the day's seed; the same day and coins always draw the same coin. */
export function drawSummit(entries, seed) {
  const pool = entries.map(entry => [entry, Math.max(0, entry.weight)]).filter(([, w]) => w > 0); if (!pool.length) return null;
  const total = pool.reduce((sum, [, w]) => sum + w, 0), u = seed.readUInt32BE(0) / 2 ** 32; let at = u * total;
  for (const [entry, w] of pool) { if ((at -= w) < 0) return entry; }
  return pool.at(-1)[0];
}

// ---------------------------------------------------------------- images in takeover requests
function imageBytes(dataUrl, max, label) {
  if (dataUrl === undefined || dataUrl === null || dataUrl === '') return null;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl)); if (!match) fail(`The ${label} must be a PNG, JPEG or WebP image.`);
  const bytes = Buffer.from(match[2], 'base64'); if (bytes.length > max) fail(`The ${label} is too large (${Math.round(max / 1000)} KB at most).`);
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1], sig = bytes.subarray(0, 12);
  const ok = ext === 'png' ? sig.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) : ext === 'jpg' ? sig[0] === 0xff && sig[1] === 0xd8 : sig.toString('latin1', 0, 4) === 'RIFF' && sig.toString('latin1', 8, 12) === 'WEBP';
  if (!ok) fail(`The ${label} could not be read.`);
  return { bytes, ext, name: createHash('sha256').update(bytes).digest('hex') + '.' + ext };
}
const cleanLink = (raw, pattern) => { const text = String(raw || '').trim(); if (!text) return ''; if (text.length > 200 || !pattern.test(text)) fail('Use full https:// links for X, Telegram and the website.'); return text; };

// ---------------------------------------------------------------- JSON-RPC
export function createRpc(url, { fetcher = globalThis.fetch, concurrency = 3, timeoutMs = 15000 } = {}) {
  let active = 0; const waiting = [];
  const slot = () => new Promise(resolve => { if (active < concurrency) { active++; resolve(); } else waiting.push(resolve); });
  const release = () => { const next = waiting.shift(); if (next) next(); else active--; };
  return async function rpc(method, params) {
    if (!url) fail('No RPC is configured.', 503);
    await slot();
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: controller.signal });
          if (response.status === 429 || response.status >= 500) { await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); continue; }
          const data = await response.json(); if (data.error) throw Object.assign(new Error(data.error.message || 'RPC error'), { rpc: data.error });
          return data.result;
        } finally { clearTimeout(timer); }
      }
      throw new Error('The RPC is busy.');
    } finally { release(); }
  };
}

// ---------------------------------------------------------------- the bundle check
const tokenBalances = (rows, mint) => { const out = new Map(); for (const row of rows || []) if (row?.mint === mint && row.owner) out.set(row.owner, (out.get(row.owner) || 0n) + BigInt(row.uiTokenAmount?.amount || '0')); return out; };
/** Who bought in a coin's first slots, who funded them, and which of them are linked to the creator or to each other. */
export async function bundleCheck({ rpc, mint, creatorWallets = [], exclude = [], slots = BUNDLE.slots }) {
  const creators = new Set(creatorWallets.filter(Boolean)), skip = new Set(exclude.filter(Boolean));
  let sigs = await rpc('getSignaturesForAddress', [mint, { limit: 1000 }]) || [];
  for (let page = 0; sigs.length && sigs.length % 1000 === 0 && page < 4; page++) { const more = await rpc('getSignaturesForAddress', [mint, { limit: 1000, before: sigs.at(-1).signature }]) || []; if (!more.length) break; sigs = sigs.concat(more); }
  const ordered = sigs.filter(row => !row.err).sort((a, b) => a.slot - b.slot); if (!ordered.length) return { status: 'empty', buyers: 0, linked: [], linkedHoldPct: 0 };
  const firstSlot = ordered[0].slot, window = ordered.filter(row => row.slot < firstSlot + slots).slice(0, BUNDLE.maxTransactions);
  const supplyInfo = await rpc('getTokenSupply', [mint]), supply = BigInt(supplyInfo?.value?.amount || '0');
  const buyers = new Map();
  for (const row of window) {
    const tx = await rpc('getTransaction', [row.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]); if (!tx?.meta || tx.meta.err) continue;
    // The creation transaction's fee payer is the coin's launch wallet on every venue: it counts as the creator.
    if (row === ordered[0]) { const payer = tx.transaction?.message?.accountKeys?.[0], key = typeof payer === 'string' ? payer : payer?.pubkey; if (ADDRESS.test(key || '') && !skip.has(key)) creators.add(key); }
    const pre = tokenBalances(tx.meta.preTokenBalances, mint), post = tokenBalances(tx.meta.postTokenBalances, mint);
    for (const [owner, amount] of post) {
      const gained = amount - (pre.get(owner) || 0n); if (gained <= 0n || skip.has(owner)) continue;
      if (supply > 0n && gained * 2n > supply) continue; // the curve's vault receiving the supply at creation
      if (!buyers.has(owner)) buyers.set(owner, { wallet: owner, signature: row.signature, slot: row.slot });
    }
  }
  // Funders: the wallet that most recently sent each buyer SOL before its buy.
  for (const buyer of buyers.values()) {
    const history = await rpc('getSignaturesForAddress', [buyer.wallet, { limit: 20, before: buyer.signature }]) || [];
    for (const row of history.slice(0, BUNDLE.fundingLookback)) {
      const tx = await rpc('getTransaction', [row.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]); if (!tx?.transaction?.message) continue;
      const transfer = [...(tx.transaction.message.instructions || []), ...(tx.meta?.innerInstructions || []).flatMap(inner => inner.instructions || [])].find(ix => ix?.program === 'system' && ['transfer', 'transferWithSeed'].includes(ix.parsed?.type) && ix.parsed?.info?.destination === buyer.wallet && ix.parsed.info.source !== buyer.wallet);
      if (transfer) { buyer.funder = transfer.parsed.info.source; break; }
    }
  }
  const byFunder = new Map(); for (const buyer of buyers.values()) if (buyer.funder) byFunder.set(buyer.funder, (byFunder.get(buyer.funder) || 0) + 1);
  const linked = [];
  for (const buyer of buyers.values()) {
    const reason = creators.has(buyer.wallet) ? 'creator' : creators.has(buyer.funder) ? 'funded by the creator' : buyers.has(buyer.funder) ? 'funded by another early buyer' : byFunder.get(buyer.funder) > 1 ? 'shares a funder with other early buyers' : '';
    if (!reason) continue;
    const accounts = await rpc('getTokenAccountsByOwner', [buyer.wallet, { mint }, { encoding: 'jsonParsed' }]);
    const held = (accounts?.value || []).reduce((sum, row) => sum + BigInt(row.account?.data?.parsed?.info?.tokenAmount?.amount || '0'), 0n);
    linked.push({ wallet: buyer.wallet, reason, holdsPct: supply > 0n ? Number(held * 1000000n / supply) / 10000 : 0 });
  }
  linked.sort((a, b) => b.holdsPct - a.holdsPct);
  return { status: 'checked', firstSlot, buyers: buyers.size, linked, linkedHoldPct: +linked.reduce((sum, row) => sum + row.holdsPct, 0).toFixed(4) };
}

// ---------------------------------------------------------------- the service
/** The running launchpad's features, for the launch paths' ticker check (src/tenant/gate.mjs padCheck). */
let active = null;
export function setActivePad(pad) { active = pad || null; }
/** Refuses a new coin whose ticker or name is locked on this launchpad; a no-op anywhere else. */
export function padCheck({ name, symbol, owner = '' } = {}) { active?.checkLaunch({ name, symbol, owner }); }
export function createPadFeatures({ config, discovery, dir, rpcUrl = '', rpc = null, host = '', now = Date.now, log = () => {}, syncMs = 30000 } = {}) {
  const features = config?.features || {}, on = id => features[id] === true, any = Object.values(features).some(Boolean);
  const root = join(dir, 'pad'), media = join(root, 'media');
  const state = { registry: { next: 1, coins: {} }, summit: { days: {} }, takeovers: { requests: [], applied: {} }, bundles: {}, secret: null };
  const claims = new Map(); let timer = null, ticking = null, loaded = false, loading = null, bundleBusy = false;
  const call = rpc || createRpc(rpcUrl);
  async function readJson(name, fallback) { try { return JSON.parse(await readFile(join(root, name), 'utf8')); } catch { return fallback; } }
  const writes = new Map();
  async function save(name) {
    const previous = writes.get(name) || Promise.resolve();
    const next = previous.then(async () => { await mkdir(root, { recursive: true, mode: 0o700 }); const file = join(root, name), temp = file + '.tmp'; await writeFile(temp, JSON.stringify(state[name.replace('.json', '')]), { mode: 0o600 }); await rename(temp, file); }).catch(error => log('pad: could not save ' + name + ': ' + error.message));
    writes.set(name, next); return next;
  }
  // Every caller waits for the one read of the files (a request at start-up must not see, or save over, empty state).
  function load() {
    loading ||= (async () => {
      state.registry = await readJson('registry.json', state.registry); state.summit = await readJson('summit.json', state.summit);
      state.takeovers = await readJson('takeovers.json', state.takeovers); state.bundles = await readJson('bundles.json', state.bundles);
      try { state.secret = Buffer.from(await readFile(join(root, 'secret'), 'utf8'), 'hex'); if (state.secret.length !== 32) throw Error(); }
      catch { state.secret = randomBytes(32); await mkdir(root, { recursive: true, mode: 0o700 }); await writeFile(join(root, 'secret'), state.secret.toString('hex'), { mode: 0o600 }); }
      loaded = true;
    })().catch(error => { loading = null; throw error; });
    return loading;
  }
  const coins = () => Object.values(state.registry.coins);
  /** Keeps the registry in step with the engine's coins: new coins get the next number, and every coin its market. */
  async function sync() {
    await load(); await discovery.inventory();
    const catalogue = discovery.catalogue(), t = now(); let changed = false;
    const fresh = catalogue.coins.filter(coin => coin?.mint && !state.registry.coins[coin.mint]).sort((a, b) => a.createdAt - b.createdAt || a.mint.localeCompare(b.mint));
    for (const coin of fresh) {
      const earlier = coins();
      const lookalike = earlier.find(entry => t - entry.createdAt < 30 * DAY && looksAlike(entry.symbol, coin.symbol)) || null;
      const copied = coin.image ? earlier.find(entry => entry.image === coin.image) || null : null;
      const record = discovery.records?.get?.(coin.mint), keys = record?.chainRecord?.keys || {}, curve = coin.curve || record?.coin?.curve || '';
      const wallets = [keys.wallet?.address, keys.payer?.address].filter(address => ADDRESS.test(address || '') && address !== curve);
      state.registry.coins[coin.mint] = { no: state.registry.next++, mint: coin.mint, name: coin.name, symbol: coin.symbol, image: coin.image || '', platform: coin.platform || '', createdAt: coin.createdAt, registeredAt: t, creator: coin.creator?.username || '', creatorWallets: wallets, exclude: [curve, coin.poolId].filter(Boolean), lookalikeOf: lookalike?.mint || '', copiedImageOf: copied?.mint || '', valueUsd: 0, peakUsd: 0, volume24h: 0, progress: null, graduated: false, graduatedAt: 0, activeAt: 0 };
      changed = true;
    }
    for (const coin of catalogue.coins) {
      const entry = state.registry.coins[coin.mint]; if (!entry) continue;
      const v = value(coin), vol = Number(coin.volume24h ?? coin.volumeObserved) || 0, graduated = coin.stage === 'graduated';
      if (v && v !== entry.valueUsd) { entry.valueUsd = v; entry.peakUsd = Math.max(entry.peakUsd || 0, v); changed = true; }
      if (vol !== entry.volume24h) { entry.volume24h = vol; changed = true; }
      if (vol > 0 && t - (entry.activeAt || 0) > 60000) { entry.activeAt = t; changed = true; }
      if (Number.isFinite(coin.progressPercent) && coin.progressPercent !== entry.progress) { entry.progress = coin.progressPercent; changed = true; }
      if (graduated && !entry.graduated) { entry.graduated = true; entry.graduatedAt = t; changed = true; }
      if (coin.name && coin.name !== entry.name) { entry.name = coin.name; changed = true; }
    }
    if (changed) await save('registry.json');
    if (on('summit')) await drawToday();
    if (on('bundleCheck')) runBundles().catch(error => log('pad: bundle checks failed: ' + error.message));
  }
  const dayKey = t => new Date(t).toISOString().slice(0, 10);
  const flagged = entry => !!(entry.lookalikeOf || entry.copiedImageOf || (state.bundles[entry.mint]?.linked?.length && state.bundles[entry.mint].linkedHoldPct >= 1));
  async function drawToday() {
    const t = now(), day = dayKey(t); if (state.summit.days[day]) return state.summit.days[day];
    const eligible = coins().filter(entry => t - entry.createdAt > 10 * 60000 && entry.valueUsd > 0 && !flagged(entry)).map(entry => ({ ...entry, weight: summitWeight(entry, t) }));
    const picked = drawSummit(eligible, createHmac('sha256', state.secret).update('summit:' + day).digest()); if (!picked) return null;
    state.summit.days[day] = { mint: picked.mint, drawnAt: t, odds: +(picked.weight / eligible.reduce((sum, row) => sum + row.weight, 0)).toFixed(4), field: eligible.length };
    for (const old of Object.keys(state.summit.days).sort().slice(0, -60)) delete state.summit.days[old];
    await save('summit.json'); log(`pad: summit ${day} → ${picked.symbol}`); return state.summit.days[day];
  }
  async function runBundles() {
    if (bundleBusy) return; bundleBusy = true;
    try {
      const t = now();
      for (const entry of coins().sort((a, b) => a.createdAt - b.createdAt)) {
        const done = state.bundles[entry.mint]; if (done && (done.status === 'checked' || done.status === 'empty' || (done.attempts || 0) >= 3)) continue;
        if (t - entry.createdAt < BUNDLE.delayMs || t - entry.createdAt > BUNDLE.maxAgeMs && !done) { if (!done && t - entry.createdAt > BUNDLE.maxAgeMs) { state.bundles[entry.mint] = { status: 'too-old', at: t }; await save('bundles.json'); } continue; }
        try { state.bundles[entry.mint] = { ...(await bundleCheck({ rpc: call, mint: entry.mint, creatorWallets: entry.creatorWallets, exclude: entry.exclude })), at: now() }; log(`pad: bundle check ${entry.symbol}: ${state.bundles[entry.mint].linked.length} linked`); }
        catch (error) { state.bundles[entry.mint] = { status: 'retry', attempts: (done?.attempts || 0) + 1, error: String(error.message).slice(0, 160), at: now() }; }
        await save('bundles.json');
      }
    } finally { bundleBusy = false; }
  }
  // ---- the ticker lock (called by the launch gate before a new coin is prepared)
  function lockFor({ name, symbol }) {
    const t = now(), tk = tickerKey(symbol), nk = nameKey(name);
    for (const entry of coins()) {
      const recent = t - entry.createdAt < LOCK_MS, live = established(entry, t); if (!recent && !live) continue;
      const until = recent ? entry.createdAt + LOCK_MS : 0;
      if (tk && tickerKey(entry.symbol) === tk) return { field: 'ticker', entry, until };
      if (nk && nameKey(entry.name) === nk) return { field: 'name', entry, until };
    }
    return null;
  }
  function checkLaunch({ name, symbol, owner = '' } = {}) {
    if (!on('tickerLock') || !loaded) return;
    const lock = lockFor({ name, symbol });
    if (lock) fail(lock.until ? `$${lock.entry.symbol} was launched here ${lock.field === 'ticker' ? 'with that ticker' : 'with that name'} less than 3 days ago. It is locked until ${new Date(lock.until).toUTCString().replace(/:\d\d GMT/, ' UTC')}.` : `${lock.field === 'ticker' ? 'That ticker' : 'That name'} belongs to $${lock.entry.symbol}, which is still active here. Pick another.`);
    const t = now(), tk = tickerKey(symbol); for (const [key, claim] of claims) if (t - claim.at > CLAIM_MS) claims.delete(key);
    const claim = claims.get(tk); if (claim && owner && claim.owner !== owner) fail('Someone is launching that ticker here right now. Pick another, or try again in a few minutes.');
    if (tk && owner) claims.set(tk, { owner, at: t });
  }
  // ---- views
  const bundleView = mint => { const b = state.bundles[mint]; if (!on('bundleCheck') || !b) return null; return b.status === 'checked' || b.status === 'empty' ? { status: 'checked', buyers: b.buyers || 0, linked: (b.linked || []).slice(0, 12), linkedHoldPct: b.linkedHoldPct || 0, at: b.at } : { status: b.status === 'too-old' ? 'unavailable' : 'pending' }; };
  const takeoverView = mint => { const applied = on('takeover') ? state.takeovers.applied[mint] : null; return applied ? { logo: applied.logo || '', banner: applied.banner || '', links: applied.links || {}, description: applied.description || '', at: applied.at } : null; };
  function coinView(entry, t = now()) {
    return { no: entry.no, founding: entry.no <= FOUNDING, mint: entry.mint, name: entry.name, symbol: entry.symbol, image: takeoverView(entry.mint)?.logo || entry.image, platform: entry.platform, createdAt: entry.createdAt, creator: entry.creator, valueUsd: entry.valueUsd || null, peakUsd: entry.peakUsd || null, volume24h: entry.volume24h || 0, progress: entry.progress, graduated: entry.graduated,
      flags: { lookalikeOf: on('tickerLock') && entry.lookalikeOf ? brief(entry.lookalikeOf) : null, copiedImageOf: on('tickerLock') && entry.copiedImageOf ? brief(entry.copiedImageOf) : null, bundle: bundleView(entry.mint), takeover: !!takeoverView(entry.mint) }, lockedUntil: on('tickerLock') && t - entry.createdAt < LOCK_MS ? entry.createdAt + LOCK_MS : null };
  }
  const brief = mint => { const entry = state.registry.coins[mint]; return entry ? { mint, symbol: entry.symbol, no: entry.no } : { mint }; };
  function registry(query) {
    const t = now(), q = String(query.get('q') || '').trim().toLowerCase().slice(0, 60), sort = query.get('sort') || 'newest', filter = query.get('filter') || 'all';
    const offset = Math.max(0, Math.min(100000, parseInt(query.get('offset') || '0', 10) || 0)), limit = Math.max(1, Math.min(48, parseInt(query.get('limit') || '24', 10) || 24));
    let rows = coins();
    if (q) rows = rows.filter(entry => entry.name.toLowerCase().includes(q) || entry.symbol.toLowerCase().includes(q) || entry.mint === query.get('q') || String(entry.no) === q.replace(/^no\.?\s*/, ''));
    if (filter === 'bonding') rows = rows.filter(entry => !entry.graduated); else if (filter === 'graduated') rows = rows.filter(entry => entry.graduated);
    else if (filter === 'new') rows = rows.filter(entry => t - entry.createdAt < 10 * 60000); else if (filter === 'founding') rows = rows.filter(entry => entry.no <= FOUNDING);
    else if (filter === 'clean') rows = rows.filter(entry => state.bundles[entry.mint]?.status === 'checked' && !state.bundles[entry.mint].linked?.length);
    const sorts = { newest: (a, b) => b.no - a.no, oldest: (a, b) => a.no - b.no, value: (a, b) => (b.valueUsd || 0) - (a.valueUsd || 0), volume: (a, b) => (b.volume24h || 0) - (a.volume24h || 0), graduation: (a, b) => (b.graduated ? -1 : b.progress || 0) - (a.graduated ? -1 : a.progress || 0) };
    rows = rows.sort(sorts[sort] || sorts.newest);
    return { total: rows.length, registered: coins().length, founding: Math.min(FOUNDING, coins().length), foundingLeft: Math.max(0, FOUNDING - coins().length), coins: rows.slice(offset, offset + limit).map(entry => coinView(entry, t)) };
  }
  function stats() {
    const t = now(), all = coins(), view = entry => coinView(entry, t), checked = all.filter(entry => state.bundles[entry.mint]?.status === 'checked');
    return { coins: all.length, graduated: all.filter(entry => entry.graduated).length, launched24h: all.filter(entry => t - entry.createdAt < DAY).length, volume24h: all.reduce((sum, entry) => sum + (entry.volume24h || 0), 0), valueUsd: all.reduce((sum, entry) => sum + (entry.valueUsd || 0), 0),
      clean: on('bundleCheck') ? { checked: checked.length, clean: checked.filter(entry => !state.bundles[entry.mint].linked?.length).length } : null,
      biggest: all.filter(entry => entry.valueUsd).sort((a, b) => b.valueUsd - a.valueUsd).slice(0, 10).map(view), busiest: all.filter(entry => entry.volume24h).sort((a, b) => b.volume24h - a.volume24h).slice(0, 10).map(view),
      graduations: all.filter(entry => entry.graduated).sort((a, b) => b.graduatedAt - a.graduatedAt).slice(0, 8).map(view), newest: all.sort((a, b) => b.no - a.no).slice(0, 8).map(view) };
  }
  function summit() {
    const t = now(), days = Object.entries(state.summit.days).sort(([a], [b]) => b.localeCompare(a));
    const today = state.summit.days[dayKey(t)], entry = today && state.registry.coins[today.mint];
    const nextDraw = Date.parse(dayKey(t) + 'T00:00:00Z') + DAY;
    return { today: entry ? { ...coinView(entry, t), odds: today.odds, field: today.field, drawnAt: today.drawnAt } : null, nextDraw, history: days.slice(1, 8).map(([day, row]) => ({ day, coin: state.registry.coins[row.mint] ? coinView(state.registry.coins[row.mint], t) : null })).filter(row => row.coin) };
  }
  // ---- takeovers
  async function holdsPct(wallet, mint) {
    const [accounts, supply] = await Promise.all([call('getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed' }]), call('getTokenSupply', [mint])]);
    const held = (accounts?.value || []).reduce((sum, row) => sum + BigInt(row.account?.data?.parsed?.info?.tokenAmount?.amount || '0'), 0n), total = BigInt(supply?.value?.amount || '0');
    return total > 0n ? Number(held * 1000000n / total) / 10000 : 0;
  }
  async function storeMedia(image) { if (!image) return ''; await mkdir(media, { recursive: true, mode: 0o700 }); await writeFile(join(media, image.name), image.bytes, { mode: 0o600 }); return '/pad-media/' + image.name; }
  async function requestTakeover(body, requestHost = '') {
    const mint = String(body?.mint || ''), wallet = String(body?.wallet || ''); if (!ADDRESS.test(mint) || !ADDRESS.test(wallet)) fail('Pick the coin and connect your wallet.');
    const entry = state.registry.coins[mint]; if (!entry) fail('That coin was not launched here.', 404);
    const payload = { mint, logo: body.logo ? payloadHash(String(body.logo)) : '', banner: body.banner ? payloadHash(String(body.banner)) : '', links: { x: String(body.links?.x || ''), telegram: String(body.links?.telegram || ''), website: String(body.links?.website || '') }, description: String(body.description || '') };
    const at = Number(body.at); if (!Number.isFinite(at) || Math.abs(now() - at) > TAKEOVER.messageMaxAgeMs) fail('The signed request expired. Sign it again.');
    // The page signs with the address it was opened on: the launchpad's own address or its owner's domain.
    const hosts = [...new Set([host, String(requestHost || '').toLowerCase()].filter(Boolean))];
    if (!hosts.some(h => walletSigned(wallet, takeoverMessage({ host: h, mint, payloadHash: payloadHash(payload), at }), body.signature))) fail('The signature does not match this request. Sign it again with the same wallet.');
    const links = { x: cleanLink(payload.links.x, /^https:\/\/(x|twitter)\.com\/[^\s]+$/i), telegram: cleanLink(payload.links.telegram, /^https:\/\/t\.me\/[^\s]+$/i), website: cleanLink(payload.links.website, /^https:\/\/[^\s/]+\.[^\s]+$/i) };
    const description = payload.description.trim(); if (description.length > TAKEOVER.description || /[<>]/.test(description)) fail(`Keep the description under ${TAKEOVER.description} characters, without < or >.`);
    const logo = imageBytes(body.logo, TAKEOVER.logoBytes, 'logo'), banner = imageBytes(body.banner, TAKEOVER.bannerBytes, 'banner');
    if (!logo && !banner && !links.x && !links.telegram && !links.website && !description) fail('Ask for at least one change.');
    if (state.takeovers.requests.filter(row => row.mint === mint && row.wallet === wallet && row.status === 'pending').length) fail('This wallet already has a request waiting for this coin.');
    if (state.takeovers.requests.filter(row => row.status === 'pending').length >= 200) fail('Too many requests are waiting. Try again later.', 503);
    let held; try { held = await holdsPct(wallet, mint); } catch { fail('The wallet balance could not be checked right now. Try again in a minute.', 503); }
    if (held < TAKEOVER.minHoldPct) fail(`This wallet holds ${held}% of $${entry.symbol}. A takeover request needs ${TAKEOVER.minHoldPct}% or more.`);
    const request = { id: randomBytes(9).toString('hex'), mint, symbol: entry.symbol, wallet, holdsPct: held, at: now(), status: 'pending', logo: await storeMedia(logo), banner: await storeMedia(banner), links, description, signature: String(body.signature) };
    state.takeovers.requests.push(request); await save('takeovers.json'); return { id: request.id, status: 'pending' };
  }
  async function decideTakeover(body) {
    const request = state.takeovers.requests.find(row => row.id === String(body?.id || '')); if (!request) fail('Request not found.', 404);
    if (request.status !== 'pending') fail('That request was already decided.');
    request.status = body.approve === true ? 'approved' : 'rejected'; request.decidedAt = now();
    if (request.status === 'approved') state.takeovers.applied[request.mint] = { logo: request.logo, banner: request.banner, links: request.links, description: request.description, at: request.decidedAt, requestId: request.id, wallet: request.wallet };
    await save('takeovers.json'); return { id: request.id, status: request.status };
  }
  async function revertTakeover(body) { const mint = String(body?.mint || ''); if (!state.takeovers.applied[mint]) fail('That coin has no takeover.', 404); delete state.takeovers.applied[mint]; await save('takeovers.json'); return { mint, reverted: true }; }
  // ---- HTTP
  async function handlePublic(method, path, query, readBody, { requestHost = '' } = {}) {
    if (!any) return [404, { error: 'Not found.' }];
    await load();
    const config_ = { features: Object.fromEntries(Object.entries(features).filter(([, v]) => v)), founding: FOUNDING, lockDays: LOCK_MS / DAY, minHoldPct: TAKEOVER.minHoldPct };
    if (method === 'GET' && path === '/api/pad/config') return [200, config_];
    if (method === 'GET' && path === '/api/pad/registry' && on('registry')) return [200, registry(query)];
    if (method === 'GET' && path === '/api/pad/stats' && on('registry')) return [200, stats()];
    if (method === 'GET' && path === '/api/pad/summit' && on('summit')) { await drawToday(); return [200, summit()]; }
    if (method === 'GET' && path === '/api/pad/coin') { const entry = state.registry.coins[query.get('mint') || '']; if (!entry) return [404, { error: 'Not found.' }]; return [200, { ...coinView(entry), registry: on('registry'), summit: on('summit') && state.summit.days[dayKey(now())]?.mint === entry.mint, takeover: takeoverView(entry.mint) }]; }
    if (method === 'GET' && path === '/api/pad/check' && on('tickerLock')) { const lock = lockFor({ name: query.get('name'), symbol: query.get('ticker') }); const symbol = query.get('ticker'); const alike = symbol ? coins().find(entry => now() - entry.createdAt < 30 * DAY && looksAlike(entry.symbol, symbol)) : null; return [200, { locked: lock ? { field: lock.field, symbol: lock.entry.symbol, until: lock.until || null } : null, lookalike: alike ? { symbol: alike.symbol, no: alike.no } : null }]; }
    if (method === 'POST' && path === '/api/pad/takeover' && on('takeover')) return [201, await requestTakeover(await readBody(), requestHost)];
    if (method === 'GET' && path === '/api/pad/takeover' && on('takeover')) { const mint = query.get('mint') || ''; return [200, { message: { host }, pending: state.takeovers.requests.filter(row => row.mint === mint && row.status === 'pending').length }]; }
    return [404, { error: 'Not found.' }];
  }
  async function handleAdmin(method, path, readBody) {
    await load();
    if (method === 'GET' && path === '/api/admin/pad/takeovers') return [200, { enabled: on('takeover'), requests: state.takeovers.requests.slice(-100).reverse(), applied: state.takeovers.applied }];
    if (method === 'POST' && path === '/api/admin/pad/takeovers/decide' && on('takeover')) return [200, await decideTakeover(await readBody())];
    if (method === 'POST' && path === '/api/admin/pad/takeovers/revert' && on('takeover')) return [200, await revertTakeover(await readBody())];
    return [404, { error: 'Not found.' }];
  }
  async function mediaFile(name) { if (!/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(name)) return null; try { return await readFile(join(media, name)); } catch { return null; } }
  function start() { if (!any || timer) return; const run = () => { if (ticking) return; ticking = sync().catch(error => log('pad: sync failed: ' + error.message)).finally(() => { ticking = null; }); }; run(); timer = setInterval(run, syncMs); timer.unref?.(); }
  function stop() { clearInterval(timer); timer = null; }
  return { enabled: any, features, start, stop, sync, load, checkLaunch, handlePublic, handleAdmin, mediaFile, drawToday, runBundles, state, registry, stats, summit, lockFor };
}
