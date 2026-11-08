import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { Engine } from './engine.mjs';
import { detectLaunches } from './launch-signals.mjs';
import { sniperRunSettings } from '../public/sniper-settings.mjs';

export class SniperEngine extends Engine {
  get platformFeeKind() { return 'sniper'; }
  start(raw, options) { return super.start(sniperRunSettings(raw), options); }
  manualTrade(raw, trade) { return super.manualTrade(sniperRunSettings(raw), trade); }
  async onTransaction(event) {
    if (!this.accepting || this.manualOnly || Date.now() - event.receivedAt > this.c.maxSignalAgeMs) return;
    const launches = event.launches || detectLaunches(event.tx, this.c.leads);
    for (const launch of launches) {
      if (!this.c.leads.includes(launch.lead)) continue;
      const key = `launch:${launch.lead}:${launch.outputMint}`;
      if (this.incoming.has(key)) continue;
      this.incoming.add(key); if (this.incoming.size > 30000) this.incoming.delete(this.incoming.values().next().value);
      if (!(await this.ledger.remember(key)) || !this.accepting) continue;
      this.metrics.detected++;
      const signal = { ...launch, signature: event.signature, slot: event.slot, observedAt: event.observedAt, receivedAt: event.receivedAt, signalAt: performance.now() };
      this.event('signal', `Developer launch detected: ${launch.outputMint}.`, { developer: launch.lead, mint: launch.outputMint, signature: event.signature, source: launch.source });
      this.p.markets([launch.outputMint, launch.inputMint]).catch(() => {});
      for (const wallet of this.c.wallets) this.enqueue(wallet, async () => {
        if (Date.now() - signal.receivedAt > this.c.maxSignalAgeMs) { this.event('warn', 'Launch signal expired before this wallet executed.', { wallet: wallet.publicKey }); return; }
        for (let attempt = 0; ; attempt++) {
          try { await this.buy(signal, wallet); break; }
          catch (error) {
            // Only explicit no-route results can retry. Never retry an unknown
            // send outcome or a signed transaction with a different signature.
            if (!error.routeUnavailable || attempt >= 2 || !this.accepting || Date.now() + 350 - signal.receivedAt >= this.c.maxSignalAgeMs) throw error;
            await delay(350, undefined, { signal: this.abort.signal });
          }
        }
      });
    }
    // Developer sales can drive mirror exits, but subsequent developer buys
    // never become another sniper entry.
    if (event.tx || event.decoded) await super.onTransaction(event);
  }
}
