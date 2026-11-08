// Public notices deliberately exclude provider payloads, error codes and keys.
// The original diagnostic remains in the account's Activity journal.
export function tradingIssue(message = '') {
  const text = String(message).toLowerCase();
  if (/unresolved|pending transaction|awaiting confirmation/.test(text)) return 'A transaction is still awaiting confirmation. New trades are stopped while its status is checked. Review Activity before restarting.';
  if (/insufficient|not enough|fund this|balance.*low|budget/.test(text)) return 'A wallet could not cover the trade or its fees. Check its balance and budget.';
  if (/429|rate.?limit|too many requests|timeout|timed out|rpc|provider|network|fetch failed/.test(text)) return 'The network connection could not complete the request. Check your connection settings and try again later.';
  if (/route|pool|liquidity/.test(text)) return 'A usable trading route or liquidity pool was unavailable. Review the selected token and pool.';
  if (/slippage|minimum output|price impact/.test(text)) return 'The trade could not meet your price limits. Review the trade settings before restarting.';
  if (/journal|storage|save|disk/.test(text)) return 'Trade records could not be saved. Check the host storage before restarting.';
  return 'A trade could not be completed. Check Activity for the details before restarting.';
}

const eventsOf = status => [status, ...Object.values(status.views || {})].flatMap(view => view.events || []);

// One guard per tool worker. It runs synchronously on change, before the
// throttled web/Telegram status update, so the normal Stop path cancels queues.
export class RunErrorStop {
  constructor(runtime) {
    this.runtime = runtime; this.armed = false; this.reason = null;
    runtime.on('change', () => this.observe());
  }
  arm() {
    this.reason = null;
    this.seen = new Set(eventsOf(this.runtime.status()).map(event => event.id));
    this.armed = true;
  }
  disarm() { this.armed = false; }
  observe() {
    if (!this.armed || this.reason) return;
    const status = this.runtime.status(), events = eventsOf(status);
    const failure = events.filter(event => event.level === 'error' && !this.seen.has(event.id)).sort((a, b) => a.at - b.at)[0];
    for (const event of events) this.seen.add(event.id);
    if (this.seen.size > 2000) this.seen = new Set(events.map(event => event.id));
    if (!failure) return;
    // Set the latch before Stop emits another change. Pending transactions and
    // positions are kept by the existing engine reconciliation machinery.
    this.reason = { id: failure.id, at: failure.at, message: tradingIssue(failure.message) };
    this.armed = false;
    if (status.state !== 'stopped') this.runtime.stop();
  }
  status() { return { ...this.runtime.status(), stopReason: this.reason }; }
}
