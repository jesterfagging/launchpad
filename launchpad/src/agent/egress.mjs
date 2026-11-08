// Browser egress policy for AI Agent runs. Decisions are made by code, never
// by the model: only https:// URLs on approved public domains, no credentials,
// no unusual ports, and every DNS answer must be a public unicast address at
// connection time (string checks alone do not defeat rebinding). The same
// policy is applied to the top-level navigation, to every redirect hop and to
// every subresource request the browser makes.
import { isIP } from 'node:net';
import dns from 'node:dns/promises';

const BLOCKED_PORTS = new Set([21, 22, 23, 25, 110, 143, 465, 587, 993, 995, 1080, 3306, 5432, 6379, 8080, 8443, 9229, 27017]);
export const EGRESS_DENY_REASONS = Object.freeze({ scheme: 'Only https:// pages are allowed.', credentials: 'URLs with embedded credentials are blocked.', port: 'Only the default HTTPS port is allowed.', host: 'IP-address hosts are blocked.', domain: 'This domain is not on the approved list.', private: 'The host resolves to a private, loopback, link-local or metadata address.', dns: 'The host name could not be resolved.', length: 'The URL is too long.' });

/** IPv4/IPv6 literal classification: public unicast only. */
export function publicAddress(address) {
  const family = isIP(address); if (!family) return false;
  if (family === 4) {
    const parts = address.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local and cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return false;
    if (a === 198 && (b === 18 || b === 19 || b === 51 && parts[2] === 100)) return false;
    if (a === 203 && b === 0 && parts[2] === 113) return false;
    return true;
  }
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return false;
  if (lower.startsWith('::ffff:')) { const v4 = lower.slice(7); return isIP(v4) === 4 ? publicAddress(v4) : false; }
  if (/^(fc|fd)/.test(lower)) return false; // unique local
  if (/^fe[89ab]/.test(lower)) return false; // link-local
  if (/^ff/.test(lower)) return false; // multicast
  if (lower.startsWith('2001:db8') || lower.startsWith('64:ff9b') || lower.startsWith('100::')) return false;
  if (lower.startsWith('2002:')) return false; // 6to4 can embed private v4
  if (lower.startsWith('::')) return false;
  return true;
}
export function domainAllowed(host, allowlist) { const name = String(host || '').toLowerCase().replace(/\.$/, ''); return allowlist.some(allowed => name === allowed || name.endsWith('.' + allowed)); }
/** Synchronous URL screening. Returns {ok, url, host, reason}. */
export function screenUrl(input, allowlist) {
  const reject = reason => ({ ok: false, reason: EGRESS_DENY_REASONS[reason] || reason, code: reason });
  if (typeof input !== 'string' || input.length > 2048) return reject('length');
  let url; try { url = new URL(input); } catch { return reject('scheme'); }
  if (url.protocol !== 'https:') return reject('scheme');
  if (url.username || url.password) return reject('credentials');
  if (url.port && url.port !== '443') return reject('port');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(host) || host.startsWith('[')) return reject('host');
  if (!/^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,24}$/.test(host)) return reject('host');
  if (!domainAllowed(host, allowlist)) return reject('domain');
  url.hash = '';
  return { ok: true, url: url.href, host };
}
/** Resolve and verify every address; the result is only valid for the moment it was checked. */
export async function resolvePublic(host, { lookup = name => dns.lookup(name, { all: true, verbatim: true }) } = {}) {
  let answers; try { answers = await lookup(host); } catch { return { ok: false, reason: EGRESS_DENY_REASONS.dns, code: 'dns' }; }
  const addresses = (Array.isArray(answers) ? answers : [answers]).map(row => typeof row === 'string' ? row : row?.address).filter(Boolean);
  if (!addresses.length) return { ok: false, reason: EGRESS_DENY_REASONS.dns, code: 'dns' };
  if (!addresses.every(publicAddress)) return { ok: false, reason: EGRESS_DENY_REASONS.private, code: 'private', addresses };
  return { ok: true, addresses };
}
/** Full policy for one request: screen, resolve, pin. */
export async function authorizeRequest(input, allowlist, options = {}) {
  const screened = screenUrl(input, allowlist); if (!screened.ok) return screened;
  const resolved = await resolvePublic(screened.host, options); if (!resolved.ok) return { ...resolved, url: screened.url, host: screened.host };
  return { ok: true, url: screened.url, host: screened.host, addresses: resolved.addresses };
}
/** Fetch-level interception policy for the browser (subresources, redirects, websockets, non-GET). */
export function requestDecision({ url, method = 'GET', resourceType = '', isNavigation = false }, { allowlist, methods = ['GET'] }) {
  if (resourceType === 'WebSocket' || /^wss?:/i.test(String(url))) return { allow: false, reason: 'WebSocket connections are blocked.' };
  if (!methods.includes(String(method).toUpperCase())) return { allow: false, reason: `${method} requests are blocked; browsing is read-only.` };
  const screened = screenUrl(url, allowlist); if (!screened.ok) return { allow: false, reason: screened.reason };
  if (!isNavigation && !['Document', 'Stylesheet', 'Image', 'Font', 'Script', 'XHR', 'Fetch', 'Other', 'Media', 'Manifest', 'TextTrack', ''].includes(resourceType)) return { allow: false, reason: 'Unsupported resource type.' };
  return { allow: true, url: screened.url, host: screened.host };
}
