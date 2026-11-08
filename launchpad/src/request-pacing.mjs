import { createHash } from 'node:crypto';
import { operatorCapacity, operatorJupiterInterval } from './operator-capacity.mjs';

const capacityError=(bucket,now)=>Object.assign(Error('Provider capacity was unavailable before this trade expired. Nothing new was submitted.'),{retryable:true,capacityLimited:true,retryAfterMs:Math.max(1000,Math.max(bucket.next,bucket.blocked)-now)});

// Retain reservations and cooldowns across runs. A stopped worker must not
// reset a provider's quota; clients sharing a credential share its queue.
export class RequestPacing {
  constructor({ now = Date.now, intervalScale = 1, maxQueue = 100, requestDeadlineMs = 15000 } = {}) { this.now = now; this.scale = intervalScale; this.maxQueue = maxQueue; this.requestDeadlineMs = requestDeadlineMs; this.buckets = new Map(); this.closed = false; }
  bucket(key) { if (!this.buckets.has(key)) this.buckets.set(key, { next: 0, blocked: 0, queue: [] }); return this.buckets.get(key); }
  acquire(key, client, interval, { signal, deadline = Infinity, maxQueue = this.maxQueue, requestDeadlineMs = this.requestDeadlineMs } = {}) {
    if (this.closed) return Promise.reject(Error('Request scheduler closed.'));
    if (signal?.aborted) return Promise.reject(signal.reason || Error('Stopped.'));
    const bucket = this.bucket(key);
    const now = this.now(); deadline = Math.min(deadline, now + requestDeadlineMs);
    if (!Number.isFinite(deadline) || !Number.isFinite(interval) || interval <= 0) return Promise.reject(Error('Invalid provider request limit.'));
    let projected = Math.max(now, bucket.next, bucket.blocked);
    for (const queued of bucket.queue) projected += queued.interval;
    if (bucket.queue.length >= maxQueue || projected > deadline) return Promise.reject(capacityError(bucket,now));
    return new Promise((resolve, reject) => {
      const entry = { client, interval: Math.max(1, interval * this.scale), signal, deadline, resolve, reject };
      entry.abort = () => { this.finish(bucket, entry, signal.reason || Error('Stopped.')); this.drain(bucket); };
      bucket.queue.push(entry); signal?.addEventListener('abort', entry.abort, { once: true });
      if (signal?.aborted) entry.abort(); else this.drain(bucket);
    });
  }
  finish(bucket, entry, error) { const i = bucket.queue.indexOf(entry); if (i < 0) return; bucket.queue.splice(i, 1); entry.signal?.removeEventListener('abort', entry.abort); error ? entry.reject(error) : entry.resolve(); }
  drain(bucket) {
    clearTimeout(bucket.timer); const now = this.now();
    for (const entry of [...bucket.queue]) if (entry.deadline < now || Math.max(bucket.next, bucket.blocked) > entry.deadline)
      this.finish(bucket, entry, capacityError(bucket,now));
    if (!bucket.queue.length) return;
    if (now >= Math.max(bucket.next, bucket.blocked)) { const entry = bucket.queue[0]; bucket.next = now + entry.interval; this.finish(bucket, entry); }
    if (bucket.queue.length) bucket.timer = setTimeout(() => this.drain(bucket), Math.max(1, Math.min(Math.max(bucket.next, bucket.blocked), ...bucket.queue.map(e => e.deadline + 1)) - this.now()));
  }
  cooldown(key, wait) { const bucket = this.bucket(key); bucket.blocked = Math.max(bucket.blocked, this.now() + Math.min(300000, Math.max(0, Number(wait) || 0))); this.drain(bucket); }
  removeClient(client) { for (const bucket of this.buckets.values()) { for (const entry of [...bucket.queue]) if (entry.client === client) this.finish(bucket, entry, Error('Request worker closed.')); this.drain(bucket); } }
  close() { this.closed = true; for (const bucket of this.buckets.values()) { clearTimeout(bucket.timer); for (const entry of [...bucket.queue]) this.finish(bucket, entry, Error('Request scheduler closed.')); } this.buckets.clear(); }
}
export const requestKey = (config, service) => createHash('sha256').update(service === 'jupiter' ? config.jupiterKey || 'public' : config.jitoAuth || 'public').digest('hex');
export const requestInterval = (config, service) => service === 'jupiter' ? operatorJupiterInterval(requestKey(config, service)) : 1050;
const local = new RequestPacing();
export function localRequestGate(service) {
  return { acquire: (config, signal, deadline) => { const limits=operatorCapacity(config); return local.acquire(`${service}:${requestKey(config, service)}`, null, requestInterval(config, service), { signal, deadline, maxQueue: limits.maxProviderQueue, requestDeadlineMs: limits.requestDeadlineMs }); },
    cooldown: (config, wait) => local.cooldown(`${service}:${requestKey(config, service)}`, wait) };
}
