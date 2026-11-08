import { AccountConnections } from './account-connections.mjs';
import { connectionFields, connectionTitles } from '../public/connection-fields.mjs';

export class TelegramConnections {
  constructor(bot, solana, robinhood) { this.bot = bot; this.service = new AccountConnections(bot.accounts, solana, robinhood); }
  button(ctx, text, op, args) { return this.bot.button(ctx, text, op, args); }
  async menu(ctx, chain = ctx.chain || 'solana', page = 0) {
    ctx.prompt = null;
    const profile = await this.service.read(ctx.account.id, chain), fields = connectionFields[chain];
    page = Math.max(0, Math.min(Math.floor(Number(page) || 0), Math.ceil(fields.length / 7) - 1));
    const rows = fields.slice(page * 7, page * 7 + 7).map(field => {
      const value = profile.values[field.key];
      const shown = field.type === 'secret' ? value ? 'Saved ✓' : 'Not set' : field.type === 'boolean' ? value ? 'On' : 'Off' : field.options?.find(o => o[0] === value)?.[1] || value;
      return [this.button(ctx, `${field.label}: ${shown}`, 'connectionField', { chain, key: field.key, revision: profile.revision })];
    });
    rows.unshift([this.button(ctx, `${chain === 'solana' ? '✓ ' : ''}Solana`, 'accountConnections', { chain: 'solana' }), ...(this.service.robinhood ? [this.button(ctx, `${chain === 'robinhood' ? '✓ ' : ''}Robinhood`, 'accountConnections', { chain: 'robinhood' })] : [])]);
    rows.splice(1, 0, [this.button(ctx, `${chain === 'market' ? '✓ ' : ''}Market data · charts & holders`, 'accountConnections', { chain: 'market' })]);
    if (fields.length > 7) rows.push([...(page ? [this.button(ctx, '‹ Previous', 'accountConnections', { chain, page: page - 1 })] : []), ...(page * 7 + 7 < fields.length ? [this.button(ctx, 'More endpoints ›', 'accountConnections', { chain, page: page + 1 })] : [])]);
    rows.push([this.button(ctx, '‹ Account', 'account')]);
    this.bot.say(ctx, `Account → Connections → ${connectionTitles[chain]}\n\n${chain === 'market' ? 'The web trading viewer uses DEX Screener for charts, swaps and statistics. No market API key is needed. Your Blockscout key supplies Robinhood holders; Solana holders use your saved Solana RPC. Refresh settings control Launchpad snapshots; the embedded chart updates independently. Changes sync with web.' : 'Your RPCs and API keys apply to all tools on this chain. Changes sync with web and apply to new runs.'}`, rows);
  }
  async field(ctx, args) {
    const field = connectionFields[args.chain]?.find(f => f.key === args.key); if (!field) throw Error('Choose a connection setting.');
    const profile = await this.service.read(ctx.account.id, args.chain);
    if (profile.revision !== args.revision) throw Error('Connections changed. Reopen Account → Connections.');
    const options = field.options || (field.type === 'boolean' ? [['true','On'],['false','Off']] : null);
    if (options) return this.bot.say(ctx, `${field.label}\n${field.help || 'Choose a value.'}`, [...options.map(([value, title]) => [this.button(ctx, title, 'connectionSet', { ...args, value })]), [this.button(ctx, '‹ Connections', 'accountConnections', { chain: args.chain })]]);
    ctx.prompt = { kind: 'accountConnection', chain: args.chain, key: args.key, savedRevision: args.revision, revision: ctx.revision, expires: this.bot.now() + 10 * 60000 };
    this.bot.say(ctx, `${field.label}\n${field.help || 'Send the new value.'}${field.link ? '\n' + field.link : ''}${field.type === 'secret' ? '\nPaste the complete value, or send - to clear. The input message is deleted after processing.' : `\nEnter ${field.min}–${field.max}.`}`, [[this.button(ctx, '‹ Connections', 'accountConnections', { chain: args.chain })]]);
  }
  async save(ctx, { chain, key, value, revision }) {
    if (!connectionFields[chain]?.some(field => field.key === key)) throw Error('Choose a connection setting.');
    await this.service.save(ctx.account.id, chain, { [key]: value === '-' ? '' : value }, revision);
    ctx.prompt = null; await this.bot.refreshSettings(ctx);
    this.bot.say(ctx, chain === 'market' ? 'Market connection saved.' : 'Connection saved. It will apply to new runs.'); return this.menu(ctx, chain);
  }
  async message(ctx, message) {
    await this.bot.deleteInput(ctx, message, true); const prompt = ctx.prompt;
    if (!prompt || prompt.kind !== 'accountConnection' || prompt.expires < this.bot.now() || prompt.revision !== ctx.revision || message.document) throw Error('Connection prompt expired. Reopen Account → Connections.');
    return this.save(ctx, { chain: prompt.chain, key: prompt.key, revision: prompt.savedRevision, value: String(message.text || '').trim() });
  }
}
