import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanExecutionPresets, executionFields, executionInputValue, selectedExecutionValues, useExecutionPreset } from '../public/execution-presets.mjs';
import { createPreset, readPreset } from '../public/presets.mjs';
import { cleanSniper, sniperRunSettings } from '../public/sniper-settings.mjs';
import { importSettings, defaults } from '../src/telegram-settings.mjs';
import { TelegramExecutionPresets } from '../src/telegram-execution-presets.mjs';
import { cleanRobinhoodSettings, createRobinhoodAccount } from '../src/robinhood-settings.mjs';
import { portfolioConfig } from '../src/portfolio-plan.mjs';
import { validateConfig, SOL } from '../src/core.mjs';
import { RobinhoodExecutor } from '../src/robinhood-executor.mjs';
import { parseTransaction, parseEther, parseGwei, keccak256 } from 'viem';
import { config, mint, lead } from './fixtures.mjs';

const solana = () => ({ ...structuredClone(defaults), ...config({ mode: 'live' }), leads: lead, sniper: cleanSniper({ developers: lead }) });
test('legacy settings initialize three independent slots without changing execution fees', () => {
  for (const [chain, settings] of [['solana', solana()], ['robinhood', createRobinhoodAccount().settings]]) {
    const before = structuredClone(settings), book = cleanExecutionPresets(chain, undefined, settings);
    assert.equal(book.selected, null); assert.deepEqual(book.slots.map(s => s.name), ['P1','P2','P3']); assert.deepEqual(settings, before);
    book.slots[0].name = 'Changed'; assert.equal(book.slots[1].name, 'P2'); assert.equal(selectedExecutionValues(chain, settings), null);
  }
});
test('Solana preset values survive web export, Telegram import and all four execution configs', () => {
  const raw = solana(), book = cleanExecutionPresets('solana', undefined, raw);
  const slot = { name: 'Busy network', values: { ...book.slots[0].values, prioritySol: '0.0006', jitoSol: '0.00001', heliusSol: '0', slippagePercent: '1.25', sendRpc: true } };
  const selected = useExecutionPreset('solana', raw, 1, slot), fromWeb = readPreset(JSON.stringify(createPreset(selected))), fromTelegram = importSettings(JSON.stringify(createPreset(selected)));
  for (const settings of [selected, fromWeb, fromTelegram]) {
    assert.equal(settings.executionPresets.selected, 1); assert.equal(settings.executionPresets.slots[1].name, 'Busy network');
    for (const input of [settings, sniperRunSettings(settings)]) { const c = validateConfig(structuredClone(input)); assert.equal(c.fees.priority, 600000n); assert.equal(c.fees.jito, 10000n); assert.equal(c.slippageBps, 125); }
    for (const kind of ['market','liquidity']) { const c = portfolioConfig({ ...structuredClone(settings), strategy: { baseMint: mint, quoteMint: SOL, budgetSol: '1', preset: 'balanced' } }, kind); assert.equal(c.fees.priority, 600000n); assert.equal(c.fees.jito, 10000n); assert.equal(c.slippageBps, 125); assert.equal(c.allocations[0].strategy.limits.slippagePercent, 1.25); }
  }
  assert.equal(selected.wallets[0].privateKey, raw.wallets[0].privateKey);
  assert.equal(selected.sniper.prioritySol, '0.0006');
});
test('Robinhood presets persist gas, priority, reserve and slippage independently of tool budgets', () => {
  const raw = createRobinhoodAccount().settings, book = cleanExecutionPresets('robinhood', undefined, raw);
  const next = cleanRobinhoodSettings(useExecutionPreset('robinhood', raw, 2, { name: 'P3 custom', values: { ...book.slots[2].values, maxGasGwei: '12', priorityGwei: '2', reserveEth: '0.007', slippageBps: 75 } }));
  assert.equal(next.maxGasGwei, '12'); assert.equal(next.priorityGwei, '2'); assert.equal(next.reserveEth, '0.007'); assert.equal(next.slippageBps, 75);
  assert.equal(next.executionPresets.selected, 2); assert.deepEqual(next.tools, raw.tools); assert.deepEqual(next.wallets, raw.wallets);
  const custom = { ...next, maxGasGwei: '8' }; assert.equal(selectedExecutionValues('robinhood', custom), null);
  assert.equal(useExecutionPreset('robinhood', custom, 2).maxGasGwei, '12');
});
test('presets reject invalid values, unavailable relay routes and over-precise input before applying', () => {
  const rh = createRobinhoodAccount().settings, sol = solana();
  const apply = (chain, settings, patch) => useExecutionPreset(chain, settings, 0, { name: 'P1', values: { ...cleanExecutionPresets(chain, undefined, settings).slots[0].values, ...patch } });
  assert.throws(() => apply('robinhood', rh, { maxGasGwei: '1', priorityGwei: '2' }), /cannot exceed/);
  assert.throws(() => apply('robinhood', rh, { maxGasGwei: '0.0000000001' }), /decimal/);
  assert.throws(() => apply('solana', sol, { prioritySol: '-1' }), /Priority fee/);
  assert.throws(() => apply('solana', sol, { heliusSol: '0.00001', senderTier: 'max' }), /0.001/);
  assert.throws(() => apply('solana', sol, { heliusSol: '0', jitoSol: '0', sendRpc: false }), /Enable RPC/);
  const slippage = executionFields('robinhood')[0]; assert.equal(executionInputValue(slippage, '1.25'), 125); assert.throws(() => executionInputValue(slippage, '1.251'), /two decimal/);
  assert.throws(() => cleanExecutionPresets('robinhood', { selected: 0, slots: [] }, rh), /three slots/);
  assert.throws(() => useExecutionPreset('solana', sol, 3), /P1, P2 or P3/);
});
test('manual fee changes after selecting a preset remain effective in sniping and portfolio tools', () => {
  const selected = useExecutionPreset('solana', solana(), 0);
  selected.sniper.prioritySol = '0.0009'; selected.prioritySol = '0.0008';
  assert.equal(validateConfig(structuredClone(sniperRunSettings(selected))).fees.priority, 900000n);
  assert.equal(selectedExecutionValues('solana', selected), null);
  for (const kind of ['market','liquidity']) assert.equal(portfolioConfig({ ...structuredClone(selected), strategy: { baseMint: mint, quoteMint: SOL, budgetSol: '1', preset: 'balanced' } }, kind).fees.priority, 800000n);
});
test('the Robinhood signer uses selected gas limits in the serialized transaction', async () => {
  const raw = createRobinhoodAccount().settings, slot = cleanExecutionPresets('robinhood', undefined, raw).slots[0];
  Object.assign(slot.values, { maxGasGwei: '12', priorityGwei: '2' }); const settings = cleanRobinhoodSettings(useExecutionPreset('robinhood', raw, 0, slot));
  const ledger = { data: { pending: [], lots: [], feeReceipts: [] }, async save() {} }; let signed;
  const rpc = { config: settings, client: { getTransactionCount: async () => 0, getBalance: async () => parseEther('10'), getBlock: async () => ({ baseFeePerGas: parseGwei('5') }), estimateGas: async () => 21000n }, request: async ({ method, params }) => {
    if (method === 'eth_sendRawTransaction') { signed = params[0]; return keccak256(signed); }
    if (method === 'eth_getTransactionReceipt') { const p = ledger.data.pending[0]; return { transactionHash: p.signature, from: p.wallet, to: p.to, status: '0x1', blockNumber: '0x1', blockHash: 'block', logs: [] }; }
    if (method === 'eth_getBlockByNumber') return { hash: 'block' }; throw Error(method);
  } };
  await new RobinhoodExecutor(rpc, ledger, { policy: {} }).send(settings.wallets[0], { to: '0x1111111111111111111111111111111111111111', data: '0x', value: 0n });
  const transaction = parseTransaction(signed); assert.equal(transaction.chainId, 4663); assert.equal(transaction.maxFeePerGas, parseGwei('12')); assert.equal(transaction.maxPriorityFeePerGas, parseGwei('2')); assert.equal(ledger.data.pending.length, 0);
});
test('Telegram edits drafts, applies the same three presets, rejects stale edits and locks active tools', async () => {
  const sent = [], saves = [], bot = { now: () => 1000, button: (_ctx, text, op, args) => ({ text, op, args }), say: (_ctx, text, rows) => sent.push({ text, rows }), save: async (ctx, next) => { ctx.settings = next; ctx.revision++; saves.push(next); } };
  bot.robinhoodMenus = { save: bot.save }; const ui = new TelegramExecutionPresets(bot);
  for (const [chain, settings, key, value] of [['solana', solana(), 'prioritySol','0.0007'], ['robinhood',createRobinhoodAccount().settings,'maxGasGwei','17']]) {
    const ctx = { chain, tool: 'copy', revision: 1, generation: 0, settings, engine: { status: () => ({ state: 'stopped' }) } };
    ui.menu(ctx); assert.equal(sent.at(-1).rows.filter(row => row[0].op === 'executionUse').length, 3);
    await ui.action(ctx, 'executionEdit', { index: 1, revision: 1 }); const id = ctx.executionDraft.id;
    await ui.action(ctx, 'executionField', { id, key }); await ui.message(ctx, { text: value }); assert.notEqual(ctx.settings[key], value);
    await ui.action(ctx, 'executionSave', { id, revision: 1 }); assert.equal(ctx.settings[key], value); assert.equal(ctx.settings.executionPresets.selected, 1);
    await assert.rejects(ui.action(ctx, 'executionUse', { index: 0, revision: 1 }), /Settings changed/);
    ctx.engine.status = () => ({ state: 'running', runs: { liquidity: { state: 'running' } } });
    await assert.rejects(ui.action(ctx, 'executionUse', { index: 0, revision: 2 }), /Stop active tools/);
  }
  assert.equal(saves.length, 2);
});
