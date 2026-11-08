import test from 'node:test';
import assert from 'node:assert/strict';
import { SOL } from '../src/core.mjs';
import { defaults, fields, importSettings, validateSettings } from '../src/telegram-settings.mjs';
import { getStrategy, normalizeStrategies, parseStrategyField, removeWalletBudgets, setWalletBudget, strategyFields, strategyRunSettings, updateStrategy } from '../src/telegram-strategy.mjs';
import { portfolioConfig } from '../src/portfolio-plan.mjs';
import { createPreset, settingIds } from '../public/presets.mjs';
import { profiles, resolvedStrategy, strategyDefaults } from '../public/strategy-settings.mjs';
import { config, key1, key2, mint, quote } from './fixtures.mjs';

const settings = extra => ({ ...structuredClone(defaults), ...config({ mode: 'live', wallets: [key1, key2] }), leads: '', ...extra });
function configured(kind, extra = {}) {
  const s = settings(extra);
  return updateStrategy(s, kind, 'baseMint', mint);
}

test('old Telegram settings receive independent strategy defaults without extending copy fields', () => {
  assert.deepEqual(Object.keys(fields).sort(), [...settingIds].sort());
  const both = normalizeStrategies();
  assert.deepEqual(both.market, strategyDefaults()); assert.deepEqual(both.liquidity, strategyDefaults());
  both.market.walletBudgets[0] = '5';
  assert.deepEqual(both.liquidity.walletBudgets, {});
  assert.deepEqual(getStrategy({}, 'market'), strategyDefaults());
  assert.deepEqual(normalizeStrategies({ market: { preset: 'active' } }).liquidity, strategyDefaults());
  assert.throws(() => normalizeStrategies([]), /Invalid/);
  assert.throws(() => getStrategy({}, 'other'), /Choose/);
  assert.equal(strategyFields.pool.advanced, true);
  assert.deepEqual(strategyFields.rangeBins.kinds, ['liquidity']);
});

test('Telegram imports both PC/Android strategy presets and secrets with no lead configured', () => {
  let s = configured('market', { heliusKey: 'private-helius-key', jupiterKey: 'private-jupiter-key', rpcUrl: 'https://rpc.example/?api-key=private-rpc-key' });
  s = updateStrategy(s, 'market', 'quoteMint', quote);
  s = updateStrategy(s, 'market', 'advanced', 'on');
  s = updateStrategy(s, 'market', 'tradePercent', '12');
  s = setWalletBudget(s, 'market', 0, '.000000001');
  s = updateStrategy(s, 'liquidity', 'baseMint', mint);
  s = updateStrategy(s, 'liquidity', 'preset', 'active');
  s = updateStrategy(s, 'liquidity', 'advanced', 'on');
  s = updateStrategy(s, 'liquidity', 'pool', quote);
  s = updateStrategy(s, 'liquidity', 'rangeBins', '8');
  s = setWalletBudget(s, 'liquidity', 1, '10');
  const imported = importSettings(JSON.stringify(createPreset(s)));
  assert.deepEqual(imported.strategies, s.strategies);
  assert.equal(imported.leads, '');
  for (const key of ['heliusKey', 'jupiterKey', 'rpcUrl']) assert.equal(imported[key], s[key]);
  assert.deepEqual(imported.wallets, s.wallets);
  assert.deepEqual(importSettings(JSON.stringify(createPreset(imported))), imported);
});

test('strategy updates do not mutate settings or the other mode; preset changes reset only tuning', () => {
  const original = configured('market'), snapshot = structuredClone(original);
  assert.throws(() => updateStrategy(original, 'market', 'bandPercent', '12'), /Advanced/);
  let next = updateStrategy(original, 'market', 'advanced', true);
  next = updateStrategy(next, 'market', 'tuning.bandPercent', '12');
  next = setWalletBudget(next, 'market', 0, '2');
  assert.equal(getStrategy(next, 'market').tuning.bandPercent, 12);
  const reset = updateStrategy(next, 'market', 'preset', 'conservative');
  assert.deepEqual(reset.strategies.market.tuning, {});
  assert.equal(resolvedStrategy(reset.strategies.market).limits.bandPercent, profiles.conservative.bandPercent);
  assert.equal(reset.strategies.market.walletBudgets[0], '2');
  assert.deepEqual(reset.strategies.liquidity, original.strategies.liquidity);
  assert.deepEqual(reset.wallets, original.wallets);
  assert.deepEqual(original, snapshot);
  assert.equal(reset.strategies.market.advanced, true);
});

test('wallet budget overrides clear and follow the remaining wallets after removal in both modes', () => {
  let s = settings({ wallets: [...settings().wallets, { ...settings().wallets[0], label: 'Third' }] });
  s = setWalletBudget(s, 'market', 0, '1'); s = setWalletBudget(s, 'market', 1, '2'); s = setWalletBudget(s, 'market', 2, '3');
  s = setWalletBudget(s, 'liquidity', 1, '10'); s = setWalletBudget(s, 'liquidity', 2, '20');
  const cleared = setWalletBudget(s, 'market', 1, '-');
  assert.equal(cleared.strategies.market.walletBudgets[1], undefined);
  assert.equal(s.strategies.market.walletBudgets[1], '2');
  const removed = removeWalletBudgets(s, 1);
  assert.deepEqual(removed.strategies.market.walletBudgets, { 0: '1', 1: '3' });
  assert.deepEqual(removed.strategies.liquidity.walletBudgets, { 1: '20' });
  assert.deepEqual(removed.wallets, s.wallets); // Caller removes the wallet after updating both maps.
  for (const index of [-1, 3, 20, 0.5, '0']) assert.throws(() => setWalletBudget(s, 'market', index, '1'), /imported wallet/);
  assert.throws(() => removeWalletBudgets(s, 20), /imported wallet/);
});

test('strategy input validates exact SOL amounts, addresses, enums, numeric bounds and advanced-only fields', () => {
  assert.equal(parseStrategyField('market', 'budgetSol', '.000000001'), '.000000001');
  assert.equal(parseStrategyField('liquidity', 'budgetSol', '1000000'), '1000000');
  for (const input of ['0', '-1', '1e3', '.0000000001', '1000000.000000001', 'NaN', 'Infinity', '1'.repeat(31)]) {
    assert.throws(() => parseStrategyField('market', 'budgetSol', input));
    assert.throws(() => setWalletBudget(settings(), 'market', 0, input));
  }
  assert.equal(parseStrategyField('market', 'baseMint', mint), mint);
  assert.equal(parseStrategyField('market', 'quoteMint', SOL), SOL);
  assert.throws(() => parseStrategyField('market', 'baseMint', 'SOL'), /public address/);
  assert.throws(() => parseStrategyField('market', 'quoteMint', '-'), /public address/);
  assert.equal(parseStrategyField('liquidity', 'pool', '-'), '');
  assert.throws(() => parseStrategyField('market', 'pool', mint), /not available/);
  assert.throws(() => parseStrategyField('market', 'rangeBins', '2'), /not available/);
  assert.throws(() => parseStrategyField('liquidity', 'rangeBins', '2.5'), /whole number/);
  assert.throws(() => parseStrategyField('liquidity', 'maxMoves', '11'), /1–10/);
  assert.throws(() => parseStrategyField('market', 'pollSeconds', '9'), /10–300/);
  assert.throws(() => parseStrategyField('market', 'preset', 'ultra'), /Choose/);
  assert.throws(() => parseStrategyField('market', 'advanced', 'yes'), /on or off/);
  assert.throws(() => parseStrategyField('market', '__proto__', '{}'), /not available/);
});

test('both Telegram strategies validate without leads or copy-only settings, retaining keys and custom budgets', () => {
  for (const kind of ['market', 'liquidity']) {
    let s = configured(kind, { leads: 'not a lead', buyAmount: 'bad', amountMode: 'custom', quoteMints: 'not a mint', percentStep: 'bad', marketcapStep: 'bad', sellPercent: 'bad' });
    s = setWalletBudget(s, kind, 0, '.5'); s = setWalletBudget(s, kind, 1, '10');
    const before = structuredClone(s), c = validateSettings(s, kind);
    assert.equal(c.kind, kind); assert.deepEqual(c.leads, []);
    assert.deepEqual(c.wallets.map(w => w.budget), [500000000n, 10000000000n]);
    assert.ok(c.wallets.every(w => w.keypair === null));
    assert.equal(c.strategy.baseMint, mint);
    assert.deepEqual(s, before);
    assert.throws(() => validateSettings(s), /public address/);
    assert.throws(() => validateSettings(updateStrategy(configured(kind), kind, 'baseMint', SOL), kind), /different token mints/);
  }
  assert.throws(() => validateSettings(configured('market'), 'other'), /Choose/);
});

test('worker run settings match validation, preserve providers and explicit strategies, and leave copy settings unchanged', () => {
  const s = configured('market', { leads: 'unfinished', quoteMints: 'unfinished', percentStep: 'unfinished', heliusKey: 'saved-key', rpcUrl: 'https://rpc.example/?key=secret' });
  const run = strategyRunSettings(s, 'market'), c = portfolioConfig(run, 'market');
  assert.equal(c.strategy.baseMint, mint);
  assert.deepEqual(c.strategy, validateSettings(s, 'market').strategy);
  assert.equal(run.wallets[0].privateKey, ''); // portfolioConfig consumes only its clone’s keys.
  assert.notEqual(s.wallets[0].privateKey, '');
  const explicit = strategyRunSettings({ ...s, strategy: { baseMint: quote, budgetSol: '5' } }, 'market');
  assert.equal(explicit.strategy.baseMint, quote); assert.equal(explicit.strategy.budgetSol, '5');
  assert.equal(explicit.rpcUrl, s.rpcUrl); assert.equal(explicit.heliusKey, s.heliusKey); assert.equal(explicit.prioritySol, s.prioritySol);
  const copy = strategyRunSettings(s, 'copy'); assert.deepEqual(copy, s); assert.notEqual(copy.wallets, s.wallets);
});

test('basic strategies use automatic fees; Advanced validates and retains manual priority and relay tips', () => {
  for (const kind of ['market', 'liquidity']) {
    let s = configured(kind, { prioritySol: '.0003', jitoSol: '.0003', heliusSol: '.0003', senderTier: 'swqos' });
    const basic = validateSettings(s, kind);
    assert.deepEqual(basic.fees, { priority: 50000n, jito: 0n, helius: 0n });
    assert.equal(basic.sendRpc, true);
    s = updateStrategy(s, kind, 'advanced', true);
    const custom = validateSettings(s, kind);
    assert.deepEqual(custom.fees, { priority: 300000n, jito: 300000n, helius: 300000n });
    assert.throws(() => validateSettings({ ...s, senderTier: 'max' }, kind), /0.001/);
    assert.throws(() => validateSettings({ ...s, jitoSol: '.000000001' }, kind), /0.000001/);
    const automatic = updateStrategy({ ...s, jitoSol: 'bad', heliusSol: 'bad' }, kind, 'advanced', false);
    assert.equal(validateSettings(automatic, kind).sendJito, false);
    assert.equal(automatic.jitoSol, 'bad');
  }
});

test('hosted endpoint checks remain active for both strategy modes, including unused WebSocket endpoints', () => {
  for (const kind of ['market', 'liquidity']) {
    for (const key of ['rpcUrl', 'jitoUrl', 'senderUrl']) assert.throws(() => validateSettings(configured(kind, { [key]: 'https://127.0.0.1/private' }), kind), /public/);
    assert.throws(() => validateSettings(configured(kind, { wsUrl: 'wss://localhost/' }), kind), /public/);
    const c = validateSettings(configured(kind, { rpcUrl: 'https://rpc.example/?api-key=test' }), kind);
    assert.equal(c.rpcUrl, 'https://rpc.example/?api-key=test');
  }
});
