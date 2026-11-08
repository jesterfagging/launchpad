// Filtered program-account reads that work on providers which refuse plain getProgramAccounts for very large
// programs (Helius: "Too many accounts requested … use getProgramAccountsV2 with pagination"). SDK-free: the
// connection is only used for its endpoint URL and its raw `_rpcRequest` transport.
//
// Helius's V2 pages walk the program's accounts in slices of `limit` *before* the filters apply ("The API may return
// fewer accounts than your limit due to filtering"), so a filtered read of a program with ten million accounts is a
// thousand near-empty pages of ten thousand. A full read is therefore done rarely; `changedSinceSlot` ("only return
// accounts that were modified at or after this slot") makes every later read incremental. The context slot of the
// first page is returned with the rows so the caller can keep it as the next cursor.
export const PAGE = 10000, MAX_PAGES = 4000, SLOT_MARGIN = 200;
const HELIUS_HOSTS = ['mainnet.helius-rpc.com', 'devnet.helius-rpc.com'];
/** True when the connection points at Helius (read from the endpoint, never from a saved key). */
export function heliusEndpoint(connection) {
  try { const url = new URL(connection?.rpcEndpoint); return url.protocol === 'https:' && HELIUS_HOSTS.includes(url.hostname); } catch { return false; }
}
/** The provider's refusal that means "switch to getProgramAccountsV2". */
export const wantsPagination = error => /getProgramAccountsV2|too many accounts/i.test(String(error?.message || ''));
const rateLimited = error => /429|rate limit|too many requests|timed? ?out|ECONNRESET|fetch failed|503|502/i.test(String(error?.message || error?.code || ''));
const sleep = (ms, signal = null) => new Promise(resolve => { const timer = setTimeout(done, ms); function done() { signal?.removeEventListener?.('abort', done); clearTimeout(timer); resolve(); } signal?.addEventListener?.('abort', done, { once: true }); });
/**
 * Every account matching `config.filters` as [{pubkey, data: Buffer}] (with `.contextSlot`, the slot of the first
 * page), read page by page with getProgramAccountsV2 until the provider's explicit null cursor. `changedSinceSlot`
 * limits the read to accounts modified at or after that slot. Duplicate pubkeys across pages keep the last copy; an
 * invalid page, account or cursor throws (nothing partial is returned). A rate-limited or dropped page is retried
 * with a growing pause; `onPage` hears each page's count for logging.
 */
/** Thrown when the caller's `signal` aborts a read between pages (service shutdown); `error.name === 'AbortError'`. */
const aborted = () => Object.assign(new Error('The program read was stopped.'), { name: 'AbortError' });
export async function programAccountsPaged(connection, program, config = {}, { changedSinceSlot = null, limit = PAGE, maxPages = MAX_PAGES, onPage = null, pauseMs = 0, retries = 6, signal = null } = {}) {
  if (typeof connection?._rpcRequest !== 'function') throw new Error('This RPC needs getProgramAccountsV2 pagination, which the transport does not offer.');
  const out = new Map(), cursors = new Set(); let cursor, contextSlot = null;
  const since = Number.isInteger(changedSinceSlot) && changedSinceSlot > 0 ? changedSinceSlot : null;
  for (let page = 0; page < maxPages; page++) {
    if (signal?.aborted) throw aborted();
    let response, attempt = 0;
    for (;;) {
      if (signal?.aborted) throw aborted();
      try { response = await connection._rpcRequest('getProgramAccountsV2', [program, { encoding: 'base64', ...config, withContext: true, limit, ...(since ? { changedSinceSlot: since } : {}), ...(cursor ? { paginationKey: cursor } : {}) }]); }
      catch (error) { if (attempt++ < retries && rateLimited(error)) { await sleep(Math.min(20000, 500 * 2 ** attempt), signal); continue; } throw error; }
      if (response?.error && attempt++ < retries && rateLimited(response.error)) { await sleep(Math.min(20000, 500 * 2 ** attempt), signal); continue; }
      break;
    }
    if (response?.error) throw new Error(`getProgramAccountsV2 failed: ${String(response.error.message || response.error.code || 'unknown error').slice(0, 200)}`);
    const value = response?.result?.value, rows = value?.accounts;
    if (!Array.isArray(rows) || rows.length > limit) throw new Error('getProgramAccountsV2 returned an invalid page.');
    if (contextSlot === null) { const slot = Number(response?.result?.context?.slot); contextSlot = Number.isInteger(slot) && slot > 0 ? slot : null; }
    for (const row of rows) {
      const data = row?.account?.data;
      if (typeof row?.pubkey !== 'string' || !Array.isArray(data) || data[1] !== 'base64' || typeof data[0] !== 'string') throw new Error('getProgramAccountsV2 returned an invalid account.');
      out.set(row.pubkey, { pubkey: row.pubkey, data: Buffer.from(data[0], 'base64') });
    }
    onPage?.({ page: page + 1, accounts: rows.length, matched: out.size });
    const next = value.paginationKey;
    if (next === null || next === undefined) return Object.assign([...out.values()], { contextSlot });
    if (typeof next !== 'string' || !next || next.length > 1024 || cursors.has(next)) throw new Error('getProgramAccountsV2 returned an invalid or repeated cursor.');
    cursors.add(next); cursor = next;
    if (pauseMs > 0) await sleep(pauseMs, signal);
    if (signal?.aborted) throw aborted();
  }
  throw new Error(`getProgramAccountsV2 exceeded the page limit (${maxPages} pages of ${limit}).`);
}
