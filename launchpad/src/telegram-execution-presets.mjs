import { randomUUID } from 'node:crypto';
import { cleanExecutionPresets, executionFields, executionInputValue, selectedExecutionValues, useExecutionPreset } from '../public/execution-presets.mjs';

export class TelegramExecutionPresets {
  constructor(bot) { this.bot = bot; }
  chain(ctx) { return ctx.chain === 'robinhood' ? 'robinhood' : 'solana'; }
  button(ctx, label, op, args = {}) { return this.bot.button(ctx, label, op, { revision: ctx.revision, ...args }); }
  editable(ctx) {
    const status = ctx.engine?.status();
    if (ctx.startTask || ctx.closingTask || ctx.engine?.busy || status?.state && status.state !== 'stopped' || Object.values(status?.runs || {}).some(r => r.state !== 'stopped')) throw Error('Stop active tools on this chain before changing execution presets.');
  }
  async save(ctx, next) { this.editable(ctx); return this.chain(ctx) === 'robinhood' ? this.bot.robinhoodMenus.save(ctx, next) : this.bot.save(ctx, next); }
  menu(ctx) {
    ctx.prompt = null; ctx.executionDraft = null;
    const chain = this.chain(ctx), book = cleanExecutionPresets(chain, ctx.settings.executionPresets, ctx.settings), selected = selectedExecutionValues(chain, ctx.settings) ? book.selected : null;
    const rows = book.slots.flatMap((slot, index) => [[this.button(ctx, `${selected === index ? '✓ ' : ''}P${index + 1} · ${slot.name}`, 'executionUse', { index }), this.button(ctx, `Edit P${index + 1}`, 'executionEdit', { index })]]);
    this.bot.say(ctx, `Gas & fee presets · ${chain === 'solana' ? 'Solana' : 'Robinhood'}\n\n${selected == null ? 'Current settings' : `Using P${selected + 1}`}\nChoose P1, P2 or P3 to apply its saved settings across this chain’s tools. Edit a slot, then Save & use. New slots start with your current settings.\n\nPlatform fees still apply. Changes apply to your next run.`, [...rows, [this.button(ctx, '‹ Tool menu', 'home')]]);
  }
  draft(ctx, args) {
    const draft = ctx.executionDraft;
    if (!draft || args.id !== draft.id || draft.chain !== this.chain(ctx) || draft.revision !== ctx.revision || draft.generation !== ctx.generation || draft.expires < this.bot.now()) throw Error('This preset editor expired. Open Gas & fee presets again.');
    return draft;
  }
  editor(ctx) {
    const draft = ctx.executionDraft; ctx.prompt = null;
    const fields = executionFields(draft.chain), rows = [this.button(ctx, `Name · ${draft.slot.name}`, 'executionField', { id: draft.id, key: 'name' })];
    for (const field of fields) {
      const value = draft.slot.values[field.key], shown = field.type === 'boolean' ? value ? 'On' : 'Off' : field.scale ? Number(value) / field.scale : value;
      rows.push(this.button(ctx, `${field.label} · ${shown}`, 'executionField', { id: draft.id, key: field.key }));
    }
    this.bot.say(ctx, `Edit P${draft.index + 1} · ${draft.slot.name}\nChanges stay in this draft until you choose Save & use.`, [...rows.map(row => [row]), [this.button(ctx, 'Save & use preset', 'executionSave', { id: draft.id })], [this.button(ctx, '‹ Presets', 'executionPresets')]]);
  }
  set(ctx, args, value) {
    const draft = this.draft(ctx, args), field = executionFields(draft.chain).find(f => f.key === args.key);
    if (args.key === 'name') draft.slot.name = String(value).trim();
    else if (!field) throw Error('Unknown preset setting.');
    else if (field.type === 'boolean') { if (typeof value !== 'boolean') throw Error('Choose On or Off.'); draft.slot.values[field.key] = value; }
    else if (field.options) { if (!field.options.includes(value)) throw Error('Choose one of the displayed options.'); draft.slot.values[field.key] = value; }
    else draft.slot.values[field.key] = executionInputValue(field, String(value).trim());
    return this.editor(ctx);
  }
  async action(ctx, op, args = {}) {
    if (args.revision !== undefined && args.revision !== ctx.revision) throw Error('Settings changed. Open Gas & fee presets again.');
    if (op === 'executionPresets') return this.menu(ctx);
    this.editable(ctx);
    if (op === 'executionUse') { await this.save(ctx, useExecutionPreset(this.chain(ctx), ctx.settings, args.index)); return this.menu(ctx); }
    if (op === 'executionEdit') {
      if (![0,1,2].includes(args.index)) throw Error('Choose P1, P2 or P3.');
      const chain = this.chain(ctx), book = cleanExecutionPresets(chain, ctx.settings.executionPresets, ctx.settings);
      ctx.executionDraft = { id: randomUUID(), index: args.index, chain, slot: structuredClone(book.slots[args.index]), revision: ctx.revision, generation: ctx.generation, expires: this.bot.now() + 10 * 60000 };
      return this.editor(ctx);
    }
    const draft = this.draft(ctx, args);
    if (op === 'executionSave') { await this.save(ctx, useExecutionPreset(draft.chain, ctx.settings, draft.index, draft.slot)); return this.menu(ctx); }
    if (op === 'executionValue') return this.set(ctx, args, args.value);
    if (op === 'executionField') {
      const field = executionFields(draft.chain).find(f => f.key === args.key);
      if (args.key !== 'name' && !field) throw Error('Unknown preset setting.');
      const options = field?.options || (field?.type === 'boolean' ? [true, false] : null);
      if (options) return this.bot.say(ctx, field.label, [options.map(value => this.button(ctx, value === true ? 'On' : value === false ? 'Off' : value, 'executionValue', { id: draft.id, key: field.key, value }))]);
      ctx.prompt = { kind: 'executionPreset', id: draft.id, key: args.key, revision: ctx.revision, tool: ctx.tool, chain: draft.chain };
      return this.bot.say(ctx, `P${draft.index + 1} · ${field?.label || 'Preset name'}\nSend the new value. It will be saved only when you choose Save & use.`, [[this.button(ctx, '‹ Presets', 'executionPresets')]]);
    }
    throw Error('Open Gas & fee presets again.');
  }
  async message(ctx, message) {
    const prompt = ctx.prompt; this.editable(ctx);
    if (!prompt || prompt.kind !== 'executionPreset' || prompt.tool !== ctx.tool || prompt.chain !== this.chain(ctx) || message.document) throw Error('Open the preset setting again.');
    return this.set(ctx, prompt, String(message.text || '').trim());
  }
}
