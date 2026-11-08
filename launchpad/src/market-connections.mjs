import { createHash } from 'node:crypto';

const defaults = { coingeckoKey: '', coingeckoPlan: 'demo', blockscoutKey: '', marketRefreshSeconds: '60' };
const queues = new WeakMap();
const conflict = () => Object.assign(Error('Market connections changed. Reload connections before saving.'), { statusCode: 409 });

// Separate from run settings: changing a chart key cannot replace wallets or
// modify a running strategy. Web and Telegram use the same encrypted profile.
export class MarketConnections {
  constructor(accounts) { this.accounts = accounts; }
  async readSettings(id) {
    const settings = { ...defaults, ...await this.accounts.storeFor(id).read('market-connections', {}) };
    return { settings, revision: createHash('sha256').update(JSON.stringify(settings)).digest('hex') };
  }
  async saveSettings(id, values, revision) {
    const store = this.accounts.storeFor(id);
    const job = (queues.get(store) || Promise.resolve()).catch(() => {}).then(async () => {
      const current = await this.readSettings(id);
      if (typeof revision !== 'string' || revision !== current.revision) throw conflict();
      const settings = Object.fromEntries(Object.keys(defaults).map(key => [key, values[key] ?? defaults[key]]));
      for (const field of ['coingeckoKey', 'blockscoutKey']) {
        if (typeof settings[field] !== 'string' || !/^[A-Za-z0-9_-]{0,512}$/.test(settings[field])) throw Error('Paste the API key only, without a URL, spaces, or quotes.');
      }
      if (!['demo', 'pro'].includes(settings.coingeckoPlan)) throw Error('Choose Demo or Paid plan for your CoinGecko key.');
      if (!['0', '60', '300'].includes(settings.marketRefreshSeconds)) throw Error('Choose a market refresh interval.');
      await store.write('market-connections', settings);
      return this.readSettings(id);
    });
    queues.set(store, job);
    try { return await job; } finally { if (queues.get(store) === job) queues.delete(store); }
  }
}
