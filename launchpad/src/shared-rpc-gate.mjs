// Shared by endpoint, including launchpad reads, submissions and toolkit workers.
// Operator endpoints have an aggregate cap plus each consumer's lower local cap.
import { RequestPacing } from './request-pacing.mjs';
const capacityError = message => Object.assign(Error(message), { capacityLimited: true, retryable: true, retryAfterMs: 1000 });
export class SharedRpcGate {
  constructor({ maxQueue = 100, requestDeadlineMs = 15000, now = Date.now } = {}) {
    this.buckets = new Map(); this.closed = false; this.maxQueue = maxQueue; this.requestDeadlineMs = requestDeadlineMs; this.now = now; this.requests = new RequestPacing({ maxQueue, requestDeadlineMs, now });
  }
  bucket(key) {
    if (!this.buckets.has(key)) this.buckets.set(key, { starts: [], sends: [], clients: new Map(), policies: new Map(), clientStarts: new Map(), queue: [], blockedUntil: 0 });
    return this.buckets.get(key);
  }
  acquire(key, client, rate, { signal, deadline = Infinity, method = '', aggregateRate, sendRate = 1, maxQueue = this.maxQueue, requestDeadlineMs = this.requestDeadlineMs } = {}) {
    if (this.closed) return Promise.reject(Error('RPC scheduler closed.'));
    if (signal?.aborted) return Promise.reject(signal.reason || Error('RPC request cancelled.'));
    if (!Number.isInteger(rate) || rate < 1 || rate > 1000 || aggregateRate !== undefined && (!Number.isInteger(aggregateRate) || aggregateRate < 1 || aggregateRate > 1000) || !Number.isInteger(sendRate) || sendRate < 1 || sendRate > 1000) return Promise.reject(Error('Invalid RPC request limit.'));
    const bucket = this.bucket(key), now = this.now();
    deadline = Math.min(deadline, now + requestDeadlineMs);
    if (!Number.isFinite(deadline) || deadline <= now) return Promise.reject(capacityError('Maximum signal age exceeded before the RPC request started.'));
    if (bucket.queue.length >= maxQueue) return Promise.reject(capacityError('RPC capacity is busy. Try again shortly; nothing new was submitted.'));
    bucket.clients.set(client, rate); bucket.policies.set(client, { aggregateRate, sendRate });
    return new Promise((resolve, reject) => {
      const entry = { client, signal, deadline, resolve, reject, send: ['sendTransaction', 'eth_sendRawTransaction', 'eth_sendTransaction'].includes(method) };
      entry.abort = () => { this.finish(bucket, entry, signal.reason || Error('RPC request cancelled.')); this.drain(bucket); };
      bucket.queue.push(entry);
      signal?.addEventListener('abort', entry.abort, { once: true });
      if (signal?.aborted) entry.abort(); else this.drain(bucket);
    });
  }
  finish(bucket, entry, error) {
    const i = bucket.queue.indexOf(entry); if (i < 0) return;
    bucket.queue.splice(i, 1); entry.signal?.removeEventListener('abort', entry.abort);
    if (error) entry.reject(error); else entry.resolve();
  }
  drain(bucket) {
    clearTimeout(bucket.timer);
    const now = this.now(), recent = starts => starts.filter(at => at > now - 1000);
    bucket.starts = recent(bucket.starts); bucket.sends = recent(bucket.sends);
    for (const [client, starts] of bucket.clientStarts) { const kept = recent(starts); if (kept.length) bucket.clientStarts.set(client, kept); else bucket.clientStarts.delete(client); }
    for (const entry of [...bucket.queue]) {
      if (entry.deadline <= now) this.finish(bucket, entry, capacityError('Maximum signal age exceeded before the RPC request started.'));
      else if (bucket.blockedUntil > now) this.finish(bucket, entry, Object.assign(Error('RPC is cooling down after a rate limit.'), { rateLimited: true, retryable: true, retryAfterMs: bucket.blockedUntil - now }));
    }
    const policies = [...bucket.policies.values()], configured = policies.map(p => p.aggregateRate).filter(n => n !== undefined);
    const limit = configured.length ? Math.min(...configured) : Math.min(...bucket.clients.values());
    const sends = Math.min(...policies.map(p => p.sendRate));
    let next = Infinity;
    // Scan past a consumer at its own cap, so background chart requests cannot
    // hold a trade behind their smaller per-consumer quota.
    for (const entry of [...bucket.queue]) {
      const local = bucket.clientStarts.get(entry.client) || [], localRate = bucket.clients.get(entry.client) || 1;
      const availableAt = Math.max(now,
        bucket.starts.length >= limit ? bucket.starts[bucket.starts.length - limit] + 1001 : now,
        local.length >= localRate ? local[local.length - localRate] + 1001 : now,
        entry.send && bucket.sends.length >= sends ? bucket.sends[bucket.sends.length - sends] + 1001 : now);
      if (availableAt > entry.deadline) { this.finish(bucket, entry, capacityError('Maximum signal age exceeded before the RPC request started.')); continue; }
      if (availableAt <= now) {
        bucket.starts.push(now); local.push(now); bucket.clientStarts.set(entry.client, local);
        if (entry.send) bucket.sends.push(now);
        this.finish(bucket, entry);
      } else next = Math.min(next, availableAt, entry.deadline + 1);
    }
    if (bucket.queue.length) bucket.timer = setTimeout(() => this.drain(bucket), Math.max(1, next - this.now()));
  }
  cooldown(key, wait) { const bucket = this.bucket(key); bucket.blockedUntil = Math.max(bucket.blockedUntil, this.now() + Math.min(120000, Math.max(0, Number(wait) || 0))); this.drain(bucket); }
  removeClient(client) {
    this.requests.removeClient(client);
    for (const bucket of this.buckets.values()) {
      bucket.clients.delete(client); bucket.policies.delete(client); bucket.clientStarts.delete(client);
      for (const entry of [...bucket.queue]) if (entry.client === client) this.finish(bucket, entry, Error('RPC worker closed.'));
      this.drain(bucket);
    }
  }
  close() { this.closed = true; this.requests.close(); for (const bucket of this.buckets.values()) { clearTimeout(bucket.timer); for (const entry of [...bucket.queue]) this.finish(bucket, entry, Error('RPC scheduler closed.')); } this.buckets.clear(); }
}

// Direct operator services without a runtime manager still share one budget.
export const processRpcGate = new SharedRpcGate();
