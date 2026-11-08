import { MAX_STORED_WALLETS, WALLET_LIMITS, walletTool, checkWalletCaps } from '../public/wallet-limits.mjs';
import { cleanSniper, sniperRunSettings } from '../public/sniper-settings.mjs';
import { cleanLiquidityPlans } from '../public/liquidity-plans.mjs';
import { address, parseWallet, units, validateConfig } from './core.mjs';
import { publicEndpoint } from './telegram-network.mjs';
import { cleanRunWallets } from '../public/run-settings.mjs';
import { readPreset } from '../public/presets.mjs';
import { cleanExecutionPresets } from '../public/execution-presets.mjs';
import { portfolioConfig } from './portfolio-plan.mjs';
import { normalizeStrategies, strategyRunSettings } from './telegram-strategy.mjs';

export const defaults = {
  mode: 'live', wallets: [], leads: '', funding: 'sol', amountMode: 'fixed', buyAmount: '0.05', randomMin: '0.03', randomMax: '0.07',
  sellMode: 'mirror', mirrorFraction: true, percentStep: '25', marketcapStep: '100000', sellPercent: '25',
  prioritySol: '0.0003', jitoSol: '0', heliusSol: '0', senderTier: 'swqos', sendRpc: true,
  heliusKey: '', jupiterKey: '', rpcUrl: '', streamMode: 'logs', wsUrl: '', fastPumpLogs: true, quoteMints: '',
  directLaunches: true, simulateBeforeSend: true, rpcRequestsPerSecond: '8', slippagePercent: '2', maxPriceImpact: '10',
  reserveSol: '0.01', runBudgetSol: '0', maxSignalAgeMs: '5000', marketPollMs: '2000', commitment: 'processed',
  computeUnits: '1400000', jitoUrl: '', jitoAuth: '', senderUrl: '',
  strategies: normalizeStrategies(), sniper: cleanSniper(), liquidityPlans: [],
};
const field = (group, label, type, extra = {}) => ({ group, label, type, ...extra });
export const fields = {
  leads: field('leads', 'Target addresses', 'addresses', { help: 'Send 1–100 public target addresses separated by spaces or newlines. This replaces the target list.' }),
  mode: field('buy', 'Run mode', 'choice', { options: ['live'] }),
  funding: field('buy', 'Buy currency', 'choice', { options: ['sol', 'lead'], help: 'sol spends SOL; lead spends the quote token used by the target. Buy amounts use that currency.' }),
  amountMode: field('buy', 'Amount mode', 'choice', { options: ['fixed', 'random', 'custom'] }),
  buyAmount: field('buy', 'Fixed buy amount', 'amount', { help: 'Amount for each wallet in the selected buy currency. Used only in fixed mode.' }),
  randomMin: field('buy', 'Random minimum', 'amount'), randomMax: field('buy', 'Random maximum', 'amount'),
  sellMode: field('sell', 'Sell rule', 'choice', { options: ['mirror', 'percent', 'marketcap', 'hybrid-percent', 'hybrid-marketcap'], help: 'mirror follows target sells; percent/marketcap use a ladder; hybrid also follows target sells.' }),
  mirrorFraction: field('sell', 'Proportional target sells', 'boolean', { help: 'On copies the fraction sold by the target. Off exits the full copied position.' }),
  percentStep: field('sell', 'Price jump %', 'number', { min: 0.01, max: 1000000 }),
  marketcapStep: field('sell', 'Market cap jump (USD)', 'number', { min: 1, max: 1e15 }),
  sellPercent: field('sell', 'Position sold per jump %', 'number', { min: 0.01, max: 100 }),
  prioritySol: field('fees', 'Priority fee (SOL)', 'sol'), jitoSol: field('fees', 'Jito tip (SOL)', 'sol'),
  heliusSol: field('fees', 'Helius tip (SOL)', 'sol'),
  senderTier: field('fees', 'Helius Sender tier', 'choice', { options: ['swqos', 'max'], help: 'SWQOS minimum tip 0.000005 SOL. Max minimum in this build 0.001 SOL. Zero disables the relay.' }),
  sendRpc: field('fees', 'Submit through RPC', 'boolean'),
  heliusKey: field('connections', 'Helius API key', 'secret'), jupiterKey: field('connections', 'Jupiter API key', 'secret'),
  rpcUrl: field('connections', 'Custom RPC URL', 'url', { secret: true, help: 'Paste the complete public HTTPS URL, including its API key if required. Overrides Helius RPC.' }),
  streamMode: field('connections', 'Transaction stream', 'choice', { options: ['logs', 'helius'], help: 'logs uses standard RPC WebSockets. helius uses the full transaction stream; your provider plan must support it.' }),
  wsUrl: field('connections', 'Custom stream URL', 'ws', { secret: true, help: 'Public WSS URL, including credentials in its path/query if required. Use your paid LaserStream WebSocket endpoint with helius mode.' }),
  fastPumpLogs: field('connections', 'Fast Pump logs', 'boolean'),
  rpcRequestsPerSecond: field('connections', 'RPC requests / second', 'number', { min: 1, max: 1000, integer: true }),
  jitoUrl: field('connections', 'Custom Jito URL', 'url', { secret: true }), jitoAuth: field('connections', 'Jito authorization', 'secret'),
  senderUrl: field('connections', 'Custom Helius Sender URL', 'url', { secret: true }),
  quoteMints: field('limits', 'Additional quote mints', 'addresses', { help: 'Additional quote-token mint addresses, separated by spaces. SOL, USDC and the built-in BTC/ETH mints are already supported.' }),
  directLaunches: field('limits', 'Direct launch routing', 'boolean'), simulateBeforeSend: field('limits', 'Simulate before sending', 'boolean'),
  slippagePercent: field('limits', 'Slippage %', 'number', { min: 0.01, max: 50 }),
  maxPriceImpact: field('limits', 'Maximum price impact %', 'number', { min: 0.01, max: 100 }),
  reserveSol: field('limits', 'SOL reserve / wallet', 'sol'), runBudgetSol: field('limits', 'SOL run buy budget / wallet', 'sol', { help: 'Zero disables this limit. SOL funding only; applies to each wallet.' }),
  maxSignalAgeMs: field('limits', 'Maximum signal age (ms)', 'number', { min: 100, max: 120000 }),
  marketPollMs: field('limits', 'Market polling (ms)', 'number', { min: 1000, max: 60000 }),
  commitment: field('limits', 'RPC commitment', 'choice', { options: ['processed', 'confirmed'] }),
  computeUnits: field('limits', 'Compute unit limit', 'number', { min: 100000, max: 1400000, integer: true }),
};
export const isSecret = key => fields[key]?.type === 'secret' || fields[key]?.secret === true;
export function parseField(key, input) {
  const f = fields[key]; if (!f) throw new Error('Unknown setting. Use the Settings menu.');
  let value = String(input).trim(); if (value === '-') value = '';
  if (value.length > 20000) throw new Error('That value is too long.');
  if (f.type === 'boolean') { if (!['true', 'false', 'on', 'off'].includes(value)) throw new Error('Choose on or off.'); return ['true', 'on'].includes(value); }
  if (f.type === 'choice') { if (!f.options.includes(value)) throw new Error(`Choose ${f.options.join(', ')}.`); }
  if (['url', 'ws'].includes(f.type) && value) publicEndpoint(value, f.type === 'ws');
  if (f.type === 'addresses') {
    const values = [...new Set(value.split(/[\s,]+/).filter(Boolean))];
    if (values.length > 100 || (key === 'leads' && !values.length)) throw new Error('Enter 1–100 addresses.');
    value = values.map(v => address(v)).join('\n');
  }
  if (f.type === 'sol') { if (units(value) > 100_000_000_000n && !['reserveSol', 'runBudgetSol'].includes(key)) throw new Error('A fee cannot exceed 100 SOL.'); }
  if (f.type === 'amount') { if (!/^(?:\d+(?:\.\d{0,18})?|\.\d{1,18})$/.test(value) || !(Number(value) > 0 && Number(value) <= 1e12)) throw new Error('Enter a positive buy amount.'); }
  if (f.type === 'number') {
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || Number(value) < f.min || Number(value) > f.max || (f.integer && !Number.isInteger(Number(value)))) throw new Error(`${f.label}: enter ${f.min}–${f.max}${f.integer ? ' as a whole number' : ''}.`);
  }
  return value;
}
export function importWallets(text, existing = [], paper = false, kind = 'copy', { stored = false } = {}) {
  const cap = stored ? MAX_STORED_WALLETS : WALLET_LIMITS[walletTool(kind)];
  let rows;
  try {
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed) && parsed.every(n => typeof n === 'number') ? [text] : Array.isArray(parsed) ? parsed.map(v => Array.isArray(v) ? JSON.stringify(v) : v) : null;
  } catch {}
  rows ||= text.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
  if (!rows.length || rows.length > cap) throw new Error(`Import up to ${cap} wallets for this tool.`);
  const seen = new Set(), result = structuredClone(existing);
  for (const [index, value] of rows.entries()) {
    if (typeof value !== 'string' || value.length > 10000) throw new Error('Send one private key per line, or JSON byte arrays.');
    const row = { label: `Wallet ${existing.length + index + 1}`, tool: walletTool(kind), privateKey: paper ? '' : value.trim(), publicKey: paper ? value.trim() : '', amount: '' };
    const wallet = parseWallet({ ...row }, index, paper ? 'paper' : 'live');
    wallet.keypair = null;
    if (seen.has(wallet.publicKey)) throw new Error('A wallet is duplicated. Nothing was imported.');
    seen.add(wallet.publicKey);
    const current = result.find(w => w.publicKey === wallet.publicKey);
    if (current) {
      if (current.privateKey || !row.privateKey) throw new Error('A wallet is duplicated. Nothing was imported.');
      current.privateKey = row.privateKey;
    } else result.push({ ...row, publicKey: wallet.publicKey });
  }
  if (result.length > cap) throw new Error(`Import up to ${cap} wallets for this tool.`);
  return result;
}
export function importSettings(text) {
  const raw = readPreset(text), settings = structuredClone(defaults);
  for (const key of Object.keys(fields)) if (raw[key] !== undefined) {
    // A full LP/market setup can intentionally have no copytrading leads yet.
    settings[key] = key === 'mode' ? 'live' : key === 'leads' && !String(raw[key]).trim() ? '' : parseField(key, typeof raw[key] === 'boolean' ? String(raw[key]) : raw[key]);
  }
  settings.strategies = normalizeStrategies(raw.strategies);
  settings.runWallets = cleanRunWallets(raw.runWallets);
  if (raw.walletSchema === 1) settings.walletSchema = 1;
  if (raw.defaultWallets) settings.defaultWallets = raw.defaultWallets;
  settings.sniper = cleanSniper(raw.sniper);
  settings.liquidityPlans = cleanLiquidityPlans(raw.liquidityPlans);
  if (raw.executionPresets !== undefined) settings.executionPresets = cleanExecutionPresets('solana', raw.executionPresets, settings);
  for (const [key, value] of Object.entries(settings.sniper)) if (key !== 'developers') parseField(key, String(value));
  settings.wallets = [];
  for (const row of raw.wallets) {
    settings.wallets = importWallets(row.privateKey || row.publicKey, settings.wallets, !row.privateKey, row.tool || 'copy', { stored: true });
    const last = settings.wallets.at(-1); last.label = String(row.label).slice(0, 40) || last.label;
    last.amount = row.amount ? parseField('buyAmount', row.amount) : '';
    if (raw.walletSchema !== 1 && !row.tool) delete last.tool;
  }
  return settings;
}
export function validateSettings(settings, kind = 'copy') {
  if (!['copy', 'market', 'liquidity', 'sniper'].includes(kind)) throw new Error('Choose a Launchpad mode.');
  // validateConfig clears input private-key strings. Never pass the saved object.
  let config;
  if (kind === 'copy' || kind === 'sniper') {
    if (kind === 'sniper') settings = sniperRunSettings(settings);
    for (const key of Object.keys(fields)) if (settings[key] !== undefined) parseField(key, String(settings[key]));
    config = validateConfig(structuredClone(settings));
  } else {
    const raw = strategyRunSettings(settings, kind), strategy = raw.strategy;
    const shared = ['mode', 'heliusKey', 'jupiterKey', 'rpcUrl', 'rpcRequestsPerSecond', 'reserveSol', 'commitment', 'computeUnits', 'jitoUrl', 'jitoAuth', 'senderUrl'];
    if (strategy.advanced) shared.push('prioritySol', 'jitoSol', 'heliusSol', 'senderTier', 'sendRpc');
    // Validate every saved hosted endpoint even when it is not used by this mode.
    for (const key of [...new Set([...shared, 'wsUrl'])]) if (settings[key] !== undefined) parseField(key, String(settings[key]));
    config = portfolioConfig(raw, kind);
  }
  for (const wallet of config.wallets) wallet.keypair = null;
  return config;
}
export function displayValue(key, settings) {
  const value = settings[key];
  if (isSecret(key)) return value ? 'Saved ✓' : 'Not set';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (fields[key]?.type === 'addresses') return `${String(value || '').split(/\s+/).filter(Boolean).length} addresses`;
  return String(value || 'Default');
}
export function redact(text, settings) {
  let value = String(text || 'Operation failed.');
  const secrets = Object.keys(fields).filter(isSecret).map(key => settings?.[key]).filter(Boolean);
  for (const row of settings?.wallets || []) if (row.privateKey) secrets.push(row.privateKey);
  for (const raw of [...secrets]) {
    try { const url = new URL(raw); for (const v of url.searchParams.values()) if (v.length >= 4) secrets.push(v); } catch {}
  }
  for (const raw of secrets.sort((a, b) => b.length - a.length)) for (const s of [raw, encodeURIComponent(raw)]) if (s) value = value.split(s).join('[hidden]');
  return value.replace(/(?:https?|wss?):\/\/\S+/g, '[provider]').slice(0, 3500);
}
