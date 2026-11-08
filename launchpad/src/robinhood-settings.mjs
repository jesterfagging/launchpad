import { getAddress, isAddress, parseUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ROBINHOOD, EVM_NATIVE, TOOL_NAMES } from '../public/chains.mjs';
import { WALLET_LIMITS, MAX_STORED_WALLETS, walletTool, checkWalletCaps } from '../public/wallet-limits.mjs';
import { publicEndpoint } from './telegram-network.mjs';
import { cleanExecutionPresets } from '../public/execution-presets.mjs';

export const evmAddress = value => {
  if (typeof value !== 'string' || !isAddress(value.trim(), { strict: false })) throw Error('Enter a Robinhood 0x wallet or token address.');
  return getAddress(value.trim().toLowerCase());
};
export function evmWallet(row, index = 0) {
  const hex = String(row?.privateKey || '').trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw Error(`Wallet ${index + 1}: enter a 64-character hexadecimal EVM private key (0x is optional). Solana keys and seed phrases are not supported here.`);
  const key = `0x${hex.toLowerCase()}`;
  let account; try { account = privateKeyToAccount(key); } catch { throw Error(`Wallet ${index + 1}: invalid EVM private key.`); }
  if (row.publicKey && evmAddress(row.publicKey) !== account.address) throw Error(`Wallet ${index + 1}: address does not match its key.`);
  return { label: String(row.label || `Wallet ${index + 1}`).slice(0, 64), privateKey: key, publicKey: account.address, amount: String(row.amount || ''), tool: walletTool(row.tool || 'copy') };
}
const decimal = (value, fallback, max = '1000000000000') => {
  const text = String(value ?? fallback).trim();
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(text) || text.length > 60 || (text.split('.')[1]?.length || 0) > 18 || parseUnits(text, 18) > parseUnits(max, 18)) throw Error('Enter a non-negative amount with at most 18 decimal places.');
  return text;
};
const integer = (value, fallback, low, high) => { const n = Number(value ?? fallback); if (!Number.isSafeInteger(n) || n < low || n > high) throw Error(`Enter a whole number from ${low} to ${high}.`); return n; };
const choice = (value, options, fallback) => { const v = value ?? fallback; if (!options.includes(v)) throw Error('Invalid setting choice.'); return v; };
export function addressList(value, cap = 100) {
  const rows = [...new Set((Array.isArray(value) ? value : String(value || '').split(/[\s,]+/)).filter(Boolean).map(evmAddress))];
  if (rows.length > cap) throw Error(`Maximum ${cap} addresses.`); return rows;
}
export const robinhoodDefaults = Object.freeze({ chain: 'robinhood', chainId: ROBINHOOD.id, mode: 'live', walletSchema: 1, wallets: [], defaultWallets: {}, runWallets: {}, rpcUrl: ROBINHOOD.rpc, wsUrl: '', rpcRequestsPerSecond: 10, pollMs: 1000, reserveEth: '0.003', maxGasGwei: '10', priorityGwei: '0', slippageBps: 200, maxSignalAgeMs: 15000, agreedFeeVersion: '', tools: {} });
export function cleanEvmTool(value = {}, kind = 'copy') {
  if (!(kind in TOOL_NAMES)) throw Error('Choose a trading tool.');
  if (value.autoCompoundFees != null && typeof value.autoCompoundFees !== 'boolean') throw Error('Auto-compound fees must be true or false.');
  const percent = Number(value.sellPercent ?? 100), step = Number(value.percentStep ?? 25), target = Number(value.targetPercent ?? 50), drift = Number(value.driftPercent ?? 15);
  if (![percent, step, target, drift].every(Number.isFinite) || percent <= 0 || percent > 100 || step <= 0 || step > 100000 || target < 5 || target > 95 || drift < 1 || drift > 40) throw Error('Invalid percentage setting.');
  return { leads: addressList(value.leads), developers: addressList(value.developers), token: value.token ? evmAddress(value.token) : '', quote: value.quote ? evmAddress(value.quote) : ['market', 'liquidity'].includes(kind) ? '' : EVM_NATIVE,
    // An old quote-token amount must never silently become the same number of ETH.
    ...(['market', 'liquidity'].includes(kind) ? { budgetEth: value.budgetEth === '' || value.budgetEth == null && value.budget != null ? '' : decimal(value.budgetEth, '0.1') } : {}),
    amountMode: choice(value.amountMode, ['fixed', 'random', 'custom'], 'fixed'), buyAmount: decimal(value.buyAmount, '0.01'), randomMin: decimal(value.randomMin, '0.005'), randomMax: decimal(value.randomMax, '0.01'),
    budget: decimal(value.budget, '0.1'), sellMode: choice(value.sellMode, ['mirror', 'percent', 'hybrid-percent'], 'mirror'), mirrorFraction: value.mirrorFraction !== false, sellPercent: percent, percentStep: step,
    preset: choice(value.preset, ['conservative', 'balanced', 'active', 'advanced'], 'balanced'), targetPercent: target, driftPercent: drift, intervalMs: integer(value.intervalMs, 30000, 10000, 3600000),
    pool: cleanPool(value.pool), feePool: cleanPool(value.feePool), rangeBps: integer(value.rangeBps, 2000, 100, 9000), maxPositions: integer(value.maxPositions, 1, 1, 20), autoCompoundFees: value.autoCompoundFees === true,
    launchSource: choice(value.launchSource, ['both', 'pons', 'long'], 'both') };
}
export function cleanPool(pool) {
  if (pool == null || pool === '') return null;
  if (typeof pool !== 'object' || Array.isArray(pool)) throw Error('Enter a Uniswap pool key.');
  const currency0 = evmAddress(pool.currency0), currency1 = evmAddress(pool.currency1);
  if (BigInt(currency0) >= BigInt(currency1)) throw Error('Pool currencies must be in canonical address order.');
  if (pool.protocol && pool.protocol !== 'v4') {
    const protocol = choice(pool.protocol, ['v2', 'v3', 'pons-curve']);
    const result = { protocol, address: evmAddress(pool.address), currency0, currency1 };
    if (protocol === 'pons-curve') return { ...result, token: evmAddress(pool.token), quote: evmAddress(pool.quote) };
    if (currency0 === EVM_NATIVE) throw Error('Uniswap v2/v3 pools use wrapped ETH; enter its token address.');
    return { ...result, fee: protocol === 'v2' ? 3000 : integer(pool.fee, 3000, 0, 1000000), tickSpacing: protocol === 'v2' ? 1 : integer(pool.tickSpacing, 60, 1, 32767) };
  }
  const fee = integer(pool.fee, 3000, 0, 8388608); if (fee > 1000000 && fee !== 8388608) throw Error('Invalid Uniswap pool fee.');
  return { currency0, currency1, fee, tickSpacing: integer(pool.tickSpacing, 60, 1, 32767), hooks: evmAddress(pool.hooks || EVM_NATIVE) };
}
export function cleanRobinhoodSettings(raw = {}, previous = null) {
  if (raw.chain && raw.chain !== 'robinhood' || raw.chainId != null && raw.chainId !== ROBINHOOD.id || raw.mode && raw.mode !== 'live') throw Error('This setup belongs to Robinhood mainnet (4663).');
  if (!Array.isArray(raw.wallets || []) || (raw.wallets || []).length > MAX_STORED_WALLETS) throw Error('Too many saved wallets.');
  const wallets = (raw.wallets || []).map(evmWallet);
  for (const wallet of wallets) if (wallet.amount) wallet.amount = decimal(wallet.amount, '0');
  if (new Set(wallets.map(w => w.publicKey)).size !== wallets.length) throw Error('Each wallet can only be imported once per chain.');
  const next = { ...structuredClone(robinhoodDefaults), wallets, rpcUrl: publicEndpoint(raw.rpcUrl || ROBINHOOD.rpc).toString(), wsUrl: raw.wsUrl ? publicEndpoint(raw.wsUrl, true).toString() : '',
    rpcRequestsPerSecond: integer(raw.rpcRequestsPerSecond, 10, 1, 1000), pollMs: integer(raw.pollMs, 1000, 250, 30000), maxSignalAgeMs: integer(raw.maxSignalAgeMs, 15000, 1000, 120000),
    reserveEth: decimal(raw.reserveEth, '0.003'), maxGasGwei: decimal(raw.maxGasGwei, '10', '100000'), priorityGwei: decimal(raw.priorityGwei, '0', '100000'), slippageBps: integer(raw.slippageBps, 200, 1, 5000),
    agreedFeeVersion: typeof raw.agreedFeeVersion === 'string' ? raw.agreedFeeVersion.slice(0, 64) : '', tools: {}, runWallets: {}, defaultWallets: {} };
  for (const kind of Object.keys(TOOL_NAMES)) {
    next.tools[kind] = cleanEvmTool(raw.tools?.[kind], kind);
    if (parseUnits(next.tools[kind].randomMin, 18) > parseUnits(next.tools[kind].randomMax, 18)) throw Error('Random maximum must be at least the minimum.');
    if (next.tools[kind].token && next.tools[kind].token === next.tools[kind].quote) throw Error('The token and quote addresses must be different.');
    const selection = raw.runWallets?.[kind];
    next.runWallets[kind] = selection == null ? wallets.filter(w => w.tool === walletTool(kind)).map(w => w.publicKey) : addressList(selection, WALLET_LIMITS[kind]);
    if (next.runWallets[kind].some(key => !wallets.some(w => w.publicKey === key && w.tool === walletTool(kind)))) throw Error('A selected wallet does not belong to this tool.');
    if (raw.defaultWallets?.[kind] && wallets.some(w => w.publicKey === evmAddress(raw.defaultWallets[kind]) && w.tool === walletTool(kind))) next.defaultWallets[kind] = evmAddress(raw.defaultWallets[kind]);
  }
  if (parseUnits(next.priorityGwei, 18) > parseUnits(next.maxGasGwei, 18)) throw Error('Priority gas cannot exceed the maximum gas price.');
  if ([next.priorityGwei, next.maxGasGwei].some(value => (value.split('.')[1]?.length || 0) > 9)) throw Error('Gas prices accept at most 9 decimal places in Gwei.');
  if (next.tools.copy.leads.some(a => next.runWallets.copy.includes(a)) || next.tools.sniper.developers.some(a => next.runWallets.sniper.includes(a))) throw Error('A trading wallet cannot also be its own lead or developer.');
  if (raw.executionPresets !== undefined || previous?.executionPresets !== undefined) next.executionPresets = cleanExecutionPresets('robinhood', raw.executionPresets ?? previous.executionPresets, next);
  checkWalletCaps(next, previous); return next;
}
export function generateEvmWallets(count, existing, kind) {
  if (!(kind in TOOL_NAMES)) throw Error('Choose a trading tool.');
  count = integer(count, 0, 1, WALLET_LIMITS[kind]); const tool = walletTool(kind), used = existing.filter(w => w.tool === tool).length;
  if (existing.length + count > MAX_STORED_WALLETS || used + count > WALLET_LIMITS[kind]) throw Error(`${TOOL_NAMES[kind]} supports at most ${WALLET_LIMITS[kind]} wallets${tool === 'copy' ? ' shared with Copy / Sniping' : ''}.`);
  return Array.from({ length: count }, (_, i) => evmWallet({ privateKey: generatePrivateKey(), label: `${TOOL_NAMES[kind]} ${used + i + 1}`, tool }));
}
export function createRobinhoodAccount() {
  const main = evmWallet({ privateKey: generatePrivateKey(), label: 'Main cashback wallet' });
  const raw = structuredClone(robinhoodDefaults);
  for (const kind of Object.keys(TOOL_NAMES)) {
    const [wallet] = generateEvmWallets(1, raw.wallets, kind); raw.wallets.push(wallet); raw.defaultWallets[kind] = wallet.publicKey; raw.runWallets[kind] = [wallet.publicKey];
  }
  return { version: 1, revision: 1, mainWallet: { publicKey: main.publicKey, privateKey: main.privateKey }, settings: cleanRobinhoodSettings(raw) };
}
export class ChainStore {
  constructor(store, prefix = 'robinhood-') { this.base = store; this.prefix = prefix; this.dir = store.dir; this.key = store.key; this.context = store.context; }
  read(name, fallback) { return this.base.read(this.prefix + name, fallback); }
  write(name, value) { return this.base.write(this.prefix + name, value); }
}
export async function ensureRobinhoodAccount(accounts, id) {
  const store = accounts.storeFor(id), saved = await store.read('robinhood-account');
  if (saved) { if (saved.version !== 1 || evmWallet(saved.mainWallet).publicKey !== saved.mainWallet.publicKey || !saved.settings) throw Error('Robinhood account data is damaged. Restore the matching backup.'); return saved; }
  return accounts.mutate(async registry => {
    if (!registry.accounts.some(a => a.id === id)) throw Error('Account unavailable.');
    const current = await store.read('robinhood-account'); if (current) return current;
    const created = createRobinhoodAccount(); await store.write('robinhood-account', created); return created;
  });
}
