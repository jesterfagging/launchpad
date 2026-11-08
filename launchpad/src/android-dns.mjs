import dns from 'node:dns';
import { isIP } from 'node:net';
import { createInterface } from 'node:readline';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const PREFIX = 'LAUNCHPAD_DNS ';

// Use Android's Java resolver so lookups follow the phone's active network,
// Private DNS and VPN configuration. Only hostnames cross the private pipes;
// HTTP bodies, API keys, TLS and transaction submission stay in Node.
export function installAndroidDns({ input = process.stdin, output = process.stdout, timeoutMs = 8000, cacheMs = 10000 } = {}) {
  const original = dns.lookup, originalPromise = dns.promises.lookup;
  const pending = new Map(), cache = new Map(), requests = new Map();
  let nextId = 0, closed = false;
  const lines = createInterface({ input, crlfDelay: Infinity });
  const failure = code => Object.assign(new Error(`Android DNS lookup failed (${code}).`), { code, syscall: 'getaddrinfo' });
  lines.on('line', line => {
    if (!line.startsWith(PREFIX) || line.length > 16384) return;
    let reply; try { reply = JSON.parse(line.slice(PREFIX.length)); } catch { return; }
    const job = pending.get(reply.id); if (!job) return;
    pending.delete(reply.id); clearTimeout(job.timer);
    const addresses = Array.isArray(reply.addresses) ? reply.addresses.filter(a =>
      typeof a?.address === 'string' && [4, 6].includes(a.family) && isIP(a.address) === a.family).slice(0, 32) : [];
    if (reply.error || !addresses.length) job.reject(failure(reply.error === 'EAI_AGAIN' ? 'EAI_AGAIN' : 'ENOTFOUND'));
    else job.resolve(addresses);
  });
  const rejectPending = () => {
    closed = true;
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(failure('EAI_AGAIN')); }
    pending.clear(); cache.clear();
  };
  lines.on('close', rejectPending);
  async function resolve(host) {
    if (closed) throw failure('EAI_AGAIN');
    const found = cache.get(host); if (found?.until > Date.now()) return found.addresses;
    if (requests.has(host)) return requests.get(host);
    const request = new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(failure('EAI_AGAIN')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      output.write(PREFIX + JSON.stringify({ id, host }) + '\n', error => {
        if (error && pending.delete(id)) { clearTimeout(timer); reject(failure('EAI_AGAIN')); }
      });
    }).then(addresses => {
      if (cache.size >= 128) cache.delete(cache.keys().next().value);
      cache.set(host, { addresses, until: Date.now() + cacheMs }); return addresses;
    }).finally(() => requests.delete(host));
    requests.set(host, request); return request;
  }
  async function lookupPromise(host, options = {}) {
    if (typeof host !== 'string' || !host || isIP(host)) return originalPromise(host, options);
    if (host.length > 253 || !/^[a-zA-Z0-9_.-]+$/.test(host)) throw failure('ENOTFOUND');
    const opts = typeof options === 'number' ? { family: options } : options || {};
    const family = opts.family === 'IPv4' ? 4 : opts.family === 'IPv6' ? 6 : opts.family || 0;
    if (![0, 4, 6].includes(family)) throw Object.assign(new TypeError('Invalid DNS address family.'), { code: 'ERR_INVALID_ARG_VALUE' });
    let addresses = (await resolve(host)).map(a => ({ ...a }));
    const order = opts.order || (opts.verbatim === false ? 'ipv4first' : opts.verbatim === true ? 'verbatim' : dns.getDefaultResultOrder());
    if (order === 'ipv4first') addresses.sort((a, b) => a.family - b.family);
    if (order === 'ipv6first') addresses.sort((a, b) => b.family - a.family);
    if (family) {
      const matching = addresses.filter(a => a.family === family);
      addresses = family === 6 && !matching.length && (opts.hints & dns.V4MAPPED)
        ? addresses.filter(a => a.family === 4).map(a => ({ address: '::ffff:' + a.address, family: 6 })) : matching;
    }
    if (!addresses.length) throw failure('ENOTFOUND');
    return opts.all ? addresses : addresses[0];
  }
  function lookup(host, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (typeof callback !== 'function') throw new TypeError('DNS lookup requires a callback.');
    lookupPromise(host, options).then(value => {
      if (options?.all) callback(null, value); else callback(null, value.address, value.family);
    }, callback);
  }
  lookup[promisify.custom] = lookupPromise;
  dns.lookup = lookup; dns.promises.lookup = lookupPromise; syncBuiltinESMExports();
  return () => {
    dns.lookup = original; dns.promises.lookup = originalPromise; syncBuiltinESMExports();
    lines.close(); rejectPending();
  };
}
