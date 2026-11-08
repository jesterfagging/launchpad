import { cleanSniper } from './sniper-settings.mjs';
import { cleanExecutionPresets } from './execution-presets.mjs';
import { cleanLiquidityPlans } from './liquidity-plans.mjs';
import { MAX_STORED_WALLETS, WALLET_TOOLS } from './wallet-limits.mjs';
export const settingIds = ['leads','funding','amountMode','buyAmount','randomMin','randomMax','sellMode','mirrorFraction','percentStep','marketcapStep','sellPercent','prioritySol','jitoSol','heliusSol','senderTier','sendRpc','heliusKey','jupiterKey','rpcUrl','streamMode','wsUrl','fastPumpLogs','quoteMints','directLaunches','simulateBeforeSend','rpcRequestsPerSecond','slippagePercent','maxPriceImpact','reserveSol','runBudgetSol','maxSignalAgeMs','marketPollMs','commitment','computeUnits','jitoUrl','jitoAuth','senderUrl','mode'];
import { cleanStrategy } from './strategy-settings.mjs';
import { cleanRunWallets } from './run-settings.mjs';
const booleanSettings = new Set(['mirrorFraction','sendRpc','directLaunches','simulateBeforeSend','fastPumpLogs']);
const walletFields = ['label','publicKey','privateKey','amount','tool'];
export const maxPresetBytes = 262144;

function settingsFrom(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.wallets) || value.wallets.length > MAX_STORED_WALLETS) throw new Error('Choose a valid settings preset.');
  if (value.format !== undefined && value.format !== 'relay-settings') throw new Error('This is not a Launchpad settings preset.');
  if (value.format === 'relay-settings' && ![2, 3].includes(value.version)) throw new Error('This preset version is not supported by this build.');
  const settings = {};
  for (const id of settingIds) {
    if (!Object.hasOwn(value, id)) continue;
    const field = value[id];
    if (booleanSettings.has(id)) {
      if (typeof field !== 'boolean') throw new Error(`Invalid preset field: ${id}.`);
      settings[id] = field;
    } else {
      if (!['string','number'].includes(typeof field) || String(field).length > 20000) throw new Error(`Invalid preset field: ${id}.`);
      settings[id] = String(field);
    }
  }
  if (settings.mode !== undefined && !['live','paper'].includes(settings.mode)) throw new Error('Invalid preset run mode.');
  // Legacy presets still load, but setup imports never start trading.
  settings.mode = 'live';
  settings.wallets = value.wallets.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid wallet in preset.');
    return Object.fromEntries(walletFields.filter(field => field !== 'tool' || row.tool !== undefined).map(field => {
      const entry = row[field] ?? '';
      if (typeof entry !== 'string' || entry.length > 10000) throw new Error(`Invalid wallet field: ${field}.`);
      return [field, entry];
    }));
  });
  if (value.walletSchema !== undefined && value.walletSchema !== 1) throw Error('Unsupported wallet groups.');
  if (value.walletSchema === 1) settings.walletSchema = 1;
  for (const row of settings.wallets) if (row.tool && !WALLET_TOOLS.includes(row.tool)) throw Error('Invalid wallet tool.');
  if (value.defaultWallets) settings.defaultWallets = Object.fromEntries(WALLET_TOOLS.flatMap(k => typeof value.defaultWallets[k] === 'string' && value.defaultWallets[k].length <= 44 ? [[k, value.defaultWallets[k]]] : []));
  if (value.sniper !== undefined) settings.sniper = cleanSniper(value.sniper);
  if (value.liquidityPlans !== undefined) settings.liquidityPlans = cleanLiquidityPlans(value.liquidityPlans);
  if (value.strategies !== undefined) {
    if (!value.strategies || typeof value.strategies !== 'object' || Array.isArray(value.strategies)) throw Error('Invalid strategy presets.');
    settings.strategies = Object.fromEntries(['market','liquidity'].filter(k => value.strategies[k] !== undefined).map(k => [k, cleanStrategy(value.strategies[k])]));
  }
  if (value.runWallets !== undefined) settings.runWallets = cleanRunWallets(value.runWallets);
  if (value.executionPresets !== undefined) settings.executionPresets = cleanExecutionPresets('solana', value.executionPresets, settings);
  return settings;
}

export function createPreset(settings) {
  return { format: 'relay-settings', version: 3, ...settingsFrom(settings) };
}
export function readPreset(text) {
  if (new TextEncoder().encode(text).length > maxPresetBytes) throw new Error('Preset is too large.');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('The preset is not valid JSON.'); }
  return settingsFrom(value);
}
