import dns from 'node:dns';
import { isIP } from 'node:net';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

export function isPublicAddress(ip) {
  const family = isIP(ip);
  if (family === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    const groups = ip.toLowerCase().split('::'), left = groups[0].split(':').filter(Boolean), right = (groups[1] || '').split(':').filter(Boolean);
    const full = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right].map(x => parseInt(x, 16));
    const [a, b] = full;
    return a >= 0x2000 && a <= 0x3fff && a !== 0x2002 && !(a === 0x2001 && (b < 0x200 || b === 0xdb8)) && !(a === 0x3fff && b < 0x1000);
  }
  return false;
}
export function publicEndpoint(value, websocket = false) {
  let url; try { url = new URL(value); } catch { throw new Error('Enter a valid provider URL.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== (websocket ? 'wss:' : 'https:') || url.username || url.password || url.hash
    || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
    || (isIP(host) && !isPublicAddress(host))) throw new Error('Hosted Telegram runs require a public HTTPS RPC or WSS stream URL.');
  return url;
}

// Enforce the address check at connection time, not just when saving a URL.
// A DNS change cannot turn a customer RPC into a request to the host's private network.
export function safeLookup(original = dns.lookup.bind(dns)) {
  return (host, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof options === 'number') options = { family: options };
    options ||= {};
    original(host, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(Object.assign(new Error('Provider DNS lookup failed.'), { code: error.code }));
      if (!addresses.length || addresses.some(row => !isPublicAddress(row.address))) return callback(Object.assign(new Error('Provider resolved to a non-public address.'), { code: 'EACCES' }));
      if (options.all) callback(null, addresses); else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}
export function createPublicFetcher(originalLookup = dns.lookup.bind(dns)) {
  const lookup = safeLookup(originalLookup);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 64, lookup });
  const fetcher = async (input, options = {}) => {
    const url = publicEndpoint(input instanceof Request ? input.url : String(input));
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      const req = https.request(url, { agent, lookup, method: options.method || 'GET', headers: Object.fromEntries(new Headers(options.headers)), signal: options.signal }, res => {
        if (!Number.isInteger(res.statusCode) || res.statusCode < 200 || res.statusCode > 599) { res.destroy(); reject(new Error('Provider returned an invalid HTTP status.')); return; }
        if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); reject(new Error('Provider redirects are disabled.')); return; }
        const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
        const decompress = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
        const stream = decompress ? res.pipe(decompress) : res;
        stream.on('data', chunk => { size += chunk.length; if (size > 16 * 1024 * 1024) { stream.destroy(new Error('Provider response is too large.')); res.destroy(); } else chunks.push(chunk); });
        res.on('error', () => reject(new Error('Provider response interrupted.')));
        if (decompress) stream.on('error', () => { res.destroy(); reject(new Error('Provider response could not be decoded.')); });
        stream.on('end', () => {
          try { resolve(new Response([204, 205, 304].includes(res.statusCode) ? null : Buffer.concat(chunks), { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).filter(([k,v]) => v !== undefined && (!decompress || !['content-encoding','content-length'].includes(k))).map(([k,v]) => [k, Array.isArray(v) ? v.join(', ') : v])) })); }
          catch { reject(new Error('Provider returned an invalid response.')); }
        });
      });
      req.setTimeout(15000, () => req.destroy(new Error('Provider connection timed out.')));
      req.on('error', error => reject(Object.assign(new Error(error.name === 'AbortError' ? 'Stopped.' : 'Provider connection failed.'), { name: error.name, cause: { code: error.code } })));
      req.end(options.body);
    });
  };
  return { fetcher, close: () => agent.destroy() };
}

export function installTelegramNetworkGuard() {
  const originalLookup = dns.lookup, originalFetch = globalThis.fetch;
  const guarded = createPublicFetcher(originalLookup.bind(dns));
  dns.lookup = safeLookup(originalLookup.bind(dns)); syncBuiltinESMExports();
  globalThis.fetch = guarded.fetcher;
  return () => { guarded.close(); dns.lookup = originalLookup; syncBuiltinESMExports(); globalThis.fetch = originalFetch; };
}
