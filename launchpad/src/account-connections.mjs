import { connectionFields, connectionKeys } from '../public/connection-fields.mjs';
import { settingsSecrets } from './account-secrets.mjs';
import { parseField } from './telegram-settings.mjs';
import { MarketConnections } from './market-connections.mjs';

const bad = message => Object.assign(Error(message), { statusCode: 400 });
export class AccountConnections {
  constructor(accounts, solana, robinhood) { Object.assign(this, { accounts, solana, robinhood }); this.market = new MarketConnections(accounts); }
  manager(chain) {
    if (!Object.hasOwn(connectionFields, chain)) throw bad('Choose Solana, Robinhood, or Market data.');
    if (!this[chain]) throw Object.assign(Error('This chain is unavailable on this host.'), { statusCode: 503 });
    return this[chain];
  }
  protect(id, chain, saved) {
    const scope = chain === 'solana' ? id : `${id}:${chain}`;
    const protectedSettings = settingsSecrets(this.accounts.master, scope, saved.settings).protectedSettings;
    return { chain, revision: saved.revision, values: Object.fromEntries(connectionKeys(chain).map(key => [key, protectedSettings[key] ?? ''])) };
  }
  async read(id, chain) { return this.protect(id, chain, await this.manager(chain).readSettings(id)); }
  async save(id, chain, values, revision) {
    const manager = this.manager(chain), keys = connectionKeys(chain);
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(key => !keys.includes(key))) throw bad('Only connection settings can be changed here.');
    const saved = await manager.readSettings(id);
    if (saved.revision !== revision) throw Object.assign(Error('Settings changed in another tab or Telegram. Reload connections before saving.'), { statusCode: 409 });
    const scope = chain === 'solana' ? id : `${id}:${chain}`;
    const patch = settingsSecrets(this.accounts.master, scope, saved.settings).resolve(values);
    for (const [key, value] of Object.entries(patch)) {
      if (!['string','number','boolean'].includes(typeof value) || String(value).length > 4096) throw bad('Enter a valid connection setting.');
      if (chain === 'solana') patch[key] = parseField(key, String(value));
    }
    // Merge only the allowlisted fields into the latest setup. Wallets, fees,
    // running configurations and the other chain's credentials are untouched.
    const result = await manager.saveSettings(id, { ...saved.settings, ...patch }, revision);
    await this.accounts.audit(id, `${chain}-connections-updated`);
    return this.protect(id, chain, result);
  }
}
