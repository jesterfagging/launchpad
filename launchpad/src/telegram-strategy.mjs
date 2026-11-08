import { address, units } from './core.mjs';
import { cleanStrategy, profiles, strategyDefaults, tuningLimits } from '../public/strategy-settings.mjs';

const kinds = ['market', 'liquidity'];
const field = (label, type, extra = {}) => ({ label, type, group: 'basic', advanced: false, ...extra });
export const strategyFields = {
  baseMint: field('Token mint', 'address', { help: 'Send the Solana mint address of the token to manage.' }),
  quoteMint: field('Quote token mint', 'address', { help: 'Send the quote token’s Solana mint address. Wrapped SOL is selected by default.' }),
  budgetSol: field('Budget per wallet (SOL)', 'sol', { help: 'Total SOL budget for each wallet. Individual wallet budgets override this amount.' }),
  preset: field('Preset', 'choice', { options: Object.keys(profiles), help: 'Choose Conservative, Balanced, or Active. Changing preset resets custom tuning.' }),
  autoCompoundFees: field('Auto-compound fees', 'boolean', { kinds: ['liquidity'], help: 'Reinvest earned fees into the same LP position when fees cover network costs. PumpSwap and Raydium CPMM already compound in reserves.' }),
  advanced: field('Advanced settings', 'boolean'),
  pool: field('Pool address', 'address', { group: 'advanced', advanced: true, optional: true, kinds: ['liquidity'], help: 'Send a supported pool address, or - to choose a pool automatically.' }),
};
const labels = {
  deployPercent: 'Budget deployed %', targetPercent: 'Target token allocation %', bandPercent: 'Rebalance drift %', tradePercent: 'Maximum trade %',
  cooldownSeconds: 'Trade cooldown (seconds)', pollSeconds: 'Check interval (seconds)', slippagePercent: 'Slippage %', impactPercent: 'Maximum price impact %',
  turnoverMultiple: 'Daily turnover / budget', feePercent: 'Daily fee budget %', lossPercent: 'Loss pause %', rangeBins: 'Bins on each side', maxMoves: 'Daily range adjustments',
};
for (const [key, [min, max]] of Object.entries(tuningLimits)) {
  strategyFields[key] = field(labels[key], 'number', { group: 'advanced', advanced: true, tuning: true, min, max,
    integer: ['rangeBins', 'maxMoves', 'cooldownSeconds', 'pollSeconds'].includes(key),
    ...(['rangeBins', 'maxMoves'].includes(key) ? { kinds: ['liquidity'] } : {}),
  });
}

function requireKind(kind) {
  if (!kinds.includes(kind)) throw new Error('Choose LP management or Market Making.');
}
function fieldKey(key) { return typeof key === 'string' && key.startsWith('tuning.') ? key.slice(7) : key; }
function definition(kind, key) {
  requireKind(kind);
  const f = Object.hasOwn(strategyFields, key) ? strategyFields[key] : null;
  if (!f || (f.kinds && !f.kinds.includes(kind))) throw new Error('That setting is not available for this strategy.');
  return f;
}
function budget(value) {
  if (value.length > 30) throw new Error('Enter a positive SOL budget, up to 1,000,000 SOL.');
  const amount = units(value);
  if (amount <= 0n || amount > 1_000_000n * 1_000_000_000n) throw new Error('Enter a positive SOL budget, up to 1,000,000 SOL.');
  return value;
}
function walletIndex(settings, index) {
  if (!Number.isInteger(index) || index < 0 || index > 63 || index >= (settings.wallets?.length || 0)) throw new Error('Choose an imported wallet.');
}

export function normalizeStrategies(value) {
  if (value === undefined) return Object.fromEntries(kinds.map(kind => [kind, strategyDefaults()]));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid strategy presets.');
  return Object.fromEntries(kinds.map(kind => [kind, cleanStrategy(value[kind])]));
}
export function getStrategy(settings, kind) {
  requireKind(kind);
  return cleanStrategy(settings?.strategies?.[kind]);
}
export function strategyRunSettings(settings, kind = 'copy') {
  const raw = structuredClone(settings);
  if (['copy', 'sniper'].includes(kind)) return raw;
  requireKind(kind);
  // Explicit strategy is used for a selected run or a journal-backed withdrawal.
  const strategy = raw.strategy === undefined ? getStrategy(raw, kind) : cleanStrategy(raw.strategy);
  // Copy-only fields can be incomplete while somebody is setting up LP/MM.
  // Keep keys, providers and manual fees unchanged; portfolioConfig supplies
  // automatic fees when Advanced is off and always resolves strategy limits.
  return { ...raw, strategy, leads: [], funding: 'sol', amountMode: 'fixed', buyAmount: '1', randomMin: '0.03', randomMax: '0.07',
    sellMode: 'mirror', mirrorFraction: true, percentStep: '25', marketcapStep: '100000', sellPercent: '25', quoteMints: '',
    streamMode: 'logs', fastPumpLogs: false, directLaunches: false, simulateBeforeSend: true, runBudgetSol: '0',
    maxSignalAgeMs: '120000', marketPollMs: '10000' };
}
export function parseStrategyField(kind, key, input) {
  key = fieldKey(key);
  const f = definition(kind, key), value = String(input).trim();
  if (value.length > 100) throw new Error('That strategy value is too long.');
  if (f.type === 'address') {
    if (f.optional && (!value || value === '-')) return '';
    return address(value, f.label);
  }
  if (f.type === 'sol') return budget(value);
  if (f.type === 'choice') {
    if (!f.options.includes(value)) throw new Error(`Choose ${f.options.join(', ')}.`);
    return value;
  }
  if (f.type === 'boolean') {
    if (!['on', 'off', 'true', 'false'].includes(value)) throw new Error('Choose on or off.');
    return ['on', 'true'].includes(value);
  }
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)) || Number(value) < f.min || Number(value) > f.max || (f.integer && !Number.isInteger(Number(value)))) {
    throw new Error(`${f.label}: enter ${f.min}–${f.max}${f.integer ? ' as a whole number' : ''}.`);
  }
  return Number(value);
}
export function updateStrategy(settings, kind, key, input) {
  key = fieldKey(key);
  const f = definition(kind, key), strategy = getStrategy(settings, kind);
  if (f.advanced && !strategy.advanced) throw new Error('Turn on Advanced settings first.');
  const value = parseStrategyField(kind, key, input);
  if (f.tuning) strategy.tuning[key] = value;
  else strategy[key] = value;
  if (key === 'preset') strategy.tuning = {};
  return { ...structuredClone(settings), strategies: { ...normalizeStrategies(settings.strategies), [kind]: strategy } };
}
export function setWalletBudget(settings, kind, index, input) {
  requireKind(kind); walletIndex(settings, index);
  const strategy = getStrategy(settings, kind), value = String(input).trim();
  if (value === '-') delete strategy.walletBudgets[index];
  else strategy.walletBudgets[index] = budget(value);
  return { ...structuredClone(settings), strategies: { ...normalizeStrategies(settings.strategies), [kind]: strategy } };
}
export function removeWalletBudgets(settings, index) {
  walletIndex(settings, index);
  const next = structuredClone(settings);
  next.strategies = normalizeStrategies(settings.strategies);
  for (const strategy of Object.values(next.strategies)) {
    const budgets = {};
    for (const [key, value] of Object.entries(strategy.walletBudgets)) {
      const i = Number(key);
      if (i !== index) budgets[i > index ? i - 1 : i] = value;
    }
    strategy.walletBudgets = budgets;
  }
  return next;
}
