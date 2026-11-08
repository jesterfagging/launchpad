import { SOL } from './core.mjs';

// Dashboard prices are read-only and independent of wallet keys or a running
// strategy. Coalesce viewers' requests and keep the last observation on an
// outage; summarizePositions marks old observations unavailable.
export class PositionMarketFeed {
  constructor({ readMarkets, intervalMs = 5000, now = () => Date.now() } = {}) {
    this.readMarkets = readMarkets; this.intervalMs = intervalMs; this.now = now;
    this.market = new Map(); this.attempts = new Map(); this.pending = new Map();
    this.queued = new Set(); this.scheduled = false; this.closed = false;
    this.abort = new AbortController();
  }
  async read(keys) {
    if (!this.readMarkets) {
      const { Providers } = await import('./providers.mjs');
      const provider = new Providers({}, () => {});
      this.readMarkets = (mints, signal) => provider.markets(mints, signal);
    }
    return this.readMarkets(keys, this.abort.signal);
  }
  async prices(mints) {
    const keys = [...new Set([SOL, ...mints])].filter(key => typeof key === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(key));
    if (this.closed || !mints.length) return new Map();
    const now = this.now(), waits = [];
    for (const key of keys) {
      if (this.pending.has(key)) { waits.push(this.pending.get(key).promise); continue; }
      if (this.attempts.has(key) && now - this.attempts.get(key) < this.intervalMs) continue;
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      this.pending.set(key, { promise, resolve }); this.queued.add(key); waits.push(promise);
    }
    if (this.queued.size && !this.scheduled) {
      this.scheduled = true; queueMicrotask(() => this.flush());
    }
    await Promise.all(waits);
    return new Map(keys.filter(key => this.market.has(key)).map(key => [key, this.market.get(key)]));
  }
  async flush() {
    const keys = [...this.queued]; this.queued.clear(); this.scheduled = false;
    for (let i = 0; i < keys.length; i += 30) {
      const chunk = keys.slice(i, i + 30);
      for (const key of chunk) this.attempts.set(key, this.now());
      try {
        if (!this.closed) {
          const prices = await this.read(chunk);
          if (!this.closed) for (const key of chunk) {
            const value = prices?.get?.(key);
            if (value) this.market.set(key, value); else this.market.delete(key);
          }
        }
      } catch { /* An unavailable price must not hide positions or stop trading. */ }
      finally {
        for (const key of chunk) { this.pending.get(key)?.resolve(); this.pending.delete(key); }
      }
    }
    // Bound a long-lived shared host's cache without removing pending lookups.
    for (const [key, at] of this.attempts) if (this.now() - at > 300000 && !this.pending.has(key)) {
      this.attempts.delete(key); this.market.delete(key);
    }
  }
  close() { this.closed = true; this.abort.abort(); }
}
