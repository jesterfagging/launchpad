// Pair logos (v71.40; sources v71.42). The catalogue shows each stock's or ETF's own mark in a circular badge, as
// Solana's quote picker does. Robinhood's stock-token API names a logo per token, but it is the same Robinhood token
// mark for every stock, so the host looks the company's mark up by ISIN or ticker on public logo services instead
// (Parqet, then EODHD), takes Robinhood's image only when neither has one, and uses Parqet's crypto marks for ETH and
// USDG. The browser's content policy loads images from this host only, so the host fetches each logo once, keeps it for
// a week and serves it from `/robinhood-pairs/logo/<address>`; a pair with no logo anywhere is a lettermark in the
// browser. The operator can still drop a file into `<accounts dir>/robinhood-logos/overrides/<address>.(png|jpg|webp|svg)`,
// which wins for that pair. Nothing here touches a key or a wallet.
import { mkdir, readFile, readdir, stat, writeFile, rename, unlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ROBINHOOD_SOURCE = /^https:\/\/cdn\.robinhood\.com\//;
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const EXTENSIONS = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
export const LOGO_PATH_PREFIX = '/robinhood-pairs/logo/';
/** The cache generation: bumped when the sources change, so copies fetched by an older release are not served (v71.42: 2). */
export const LOGO_VERSION = 2;
const lower = v => String(v || '').toLowerCase();
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/, SYMBOL = /^[A-Z0-9.]{1,12}$/;
/** The crypto marks Parqet publishes, by the pair symbol the host uses. */
const CRYPTO_MARKS = Object.freeze({ ETH: 'ETH', USDG: 'USDG' });

/**
 * The URLs to try for a pair, in order: the company's mark by ISIN then by ticker on Parqet, by ticker on EODHD,
 * Robinhood's own token image; a crypto mark for the native and stable pairs; whatever URL a custom pair carries.
 */
export function logoCandidates({ kind, symbol, isin, sourceUrl, logo } = {}) {
  sourceUrl ??= logo;
  const out = [], ticker = String(symbol || '').toUpperCase(), code = String(isin || '').toUpperCase();
  if (kind === 'stock' || kind === 'etf') {
    if (ISIN.test(code)) out.push(`https://assets.parqet.com/logos/isin/${code}?format=png`);
    if (SYMBOL.test(ticker)) out.push(`https://assets.parqet.com/logos/symbol/${encodeURIComponent(ticker)}?format=png`, `https://eodhd.com/img/logos/US/${encodeURIComponent(ticker)}.png`);
  } else if ((kind === 'native' || kind === 'stable') && CRYPTO_MARKS[ticker]) out.push(`https://assets.parqet.com/logos/crypto/${CRYPTO_MARKS[ticker]}?format=png`);
  if (typeof sourceUrl === 'string' && /^https:\/\/[^\s"']+$/.test(sourceUrl) && !out.includes(sourceUrl)) out.push(sourceUrl);
  return out;
}

export class PairLogos {
  /**
   * @param {object} options dir (the cache folder; `overrides/` inside it is the operator's), fetcher (fetch), now,
   *   ttlMs (a week), maxBytes (512 KB), timeoutMs (8 s), log.
   */
  constructor({ dir, fetcher = globalThis.fetch, now = Date.now, ttlMs = 7 * 86400000, maxBytes = 512 * 1024, timeoutMs = 8000, log = null } = {}) {
    Object.assign(this, { dir, fetcher, now, ttlMs, maxBytes, timeoutMs, log });
    this.cacheDir = dir ? join(dir, 'v' + LOGO_VERSION) : null;
    this.overrides = new Map(); // lowercase address → { file, type }
    this.overridesAt = null;
    this.pending = new Map(); // lowercase address → Promise (one fetch at a time per pair)
    this.failedAt = new Map(); // lowercase address → when every source failed (retried after an hour)
  }

  /**
   * The public path of a pair's badge (`/robinhood-pairs/logo/<address>?v=2`), or null when nothing could ever be
   * served for it: no override and no source to try. `pair` is the catalogue row ({kind, symbol, isin, logo}).
   */
  pathFor(address, pair) {
    if (!ADDRESS.test(String(address || ''))) return null;
    if (this.overrides.has(lower(address))) return LOGO_PATH_PREFIX + address + '?v=' + LOGO_VERSION;
    const row = pair && typeof pair === 'object' ? pair : { logo: pair };
    return logoCandidates({ kind: row.kind, symbol: row.symbol, isin: row.isin, sourceUrl: row.logo }).length ? LOGO_PATH_PREFIX + address + '?v=' + LOGO_VERSION : null;
  }

  /** Reads the operator's overrides folder (at most once a minute). */
  async refreshOverrides() {
    if (this.overridesAt !== null && this.now() - this.overridesAt < 60000) return;
    this.overridesAt = this.now();
    const next = new Map();
    try {
      for (const name of await readdir(join(this.dir, 'overrides'))) {
        const m = /^(0x[0-9a-fA-F]{40})\.(png|jpg|jpeg|webp|svg)$/.exec(name); if (!m) continue;
        next.set(lower(m[1]), { file: join(this.dir, 'overrides', name), type: EXTENSIONS[m[2].toLowerCase()] });
      }
    } catch (error) { if (error?.code !== 'ENOENT') this.log?.('robinhood logos: overrides unreadable: ' + (error?.message || error)); }
    this.overrides = next;
  }

  /**
   * The badge bytes for a pair: the override, else the cached copy (fetched from the first source that answers, or
   * refreshed when older than the TTL), else null. `{ bytes, type, etag }`.
   */
  async get(address, pair = null) {
    if (!ADDRESS.test(String(address || ''))) return null;
    await this.refreshOverrides();
    const key = lower(address), override = this.overrides.get(key);
    if (override) { try { return this.pack(await readFile(override.file), override.type); } catch { /* removed meanwhile */ } }
    const row = pair && typeof pair === 'object' ? pair : { logo: pair };
    const candidates = logoCandidates({ kind: row.kind, symbol: row.symbol, isin: row.isin, sourceUrl: row.logo });
    if (!candidates.length) return null;
    const cached = await this.cached(key);
    if (cached && this.now() - cached.at < this.ttlMs) return cached;
    const failed = this.failedAt.get(key);
    if (cached && failed && this.now() - failed < 3600000) return cached; // a stale copy beats a retry storm
    if (!cached && failed && this.now() - failed < 600000) return null;
    let job = this.pending.get(key);
    if (!job) { job = this.fetchFirst(key, candidates).finally(() => this.pending.delete(key)); this.pending.set(key, job); }
    const fresh = await job;
    return fresh || cached;
  }

  pack(bytes, type) { return { bytes, type, etag: '"' + createHash('sha256').update(bytes).digest('base64url').slice(0, 24) + '"' }; }

  async cached(key) {
    if (!this.cacheDir) return null;
    for (const ext of ['png', 'jpg', 'webp', 'svg']) {
      const file = join(this.cacheDir, key + '.' + ext);
      try { const s = await stat(file); return { ...this.pack(await readFile(file), EXTENSIONS[ext]), at: s.mtimeMs }; } catch { /* next */ }
    }
    return null;
  }

  /** The first candidate that answers with an image is cached and returned; when none does the failure is remembered. */
  async fetchFirst(key, candidates) {
    const reasons = [];
    for (const url of candidates) {
      const result = await this.fetch(key, url).catch(error => { reasons.push(url + ': ' + (error?.message || error)); return null; });
      if (result) { this.failedAt.delete(key); return result; }
    }
    this.failedAt.set(key, this.now());
    this.log?.(`robinhood logos: ${key} not fetched: ${reasons.join(' | ')}`);
    return null;
  }

  async fetch(key, sourceUrl) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(sourceUrl, { signal: controller.signal, redirect: 'follow', headers: { accept: 'image/png,image/jpeg,image/webp,image/svg+xml' } });
      if (!response.ok) throw Error('HTTP ' + response.status);
      const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(), ext = TYPES[type];
      if (!ext) throw Error('not an image: ' + (type || 'no content type'));
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > this.maxBytes) throw Error(bytes.length ? 'too large' : 'empty');
      if (ext === 'svg' && /<script|on[a-z]+\s*=|javascript:/i.test(bytes.toString('utf8'))) throw Error('scripted svg');
      if (!this.cacheDir) return { ...this.pack(bytes, type), at: this.now() };
      await mkdir(this.cacheDir, { recursive: true });
      const file = join(this.cacheDir, key + '.' + ext), temp = file + '.' + process.pid + '.tmp';
      await writeFile(temp, bytes); await rename(temp, file);
      await utimes(file, this.now() / 1000, this.now() / 1000).catch(() => {}); // the cache's age follows the service clock
      for (const other of ['png', 'jpg', 'webp', 'svg']) if (other !== ext) await unlink(join(this.cacheDir, key + '.' + other)).catch(() => {});
      return { ...this.pack(bytes, type), at: this.now() };
    } finally { clearTimeout(timer); }
  }
}
export const isRobinhoodLogo = url => typeof url === 'string' && ROBINHOOD_SOURCE.test(url);
