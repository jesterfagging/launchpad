import { WALLET_LIMITS } from '../public/wallet-limits.mjs';
import { randomInt, createHash } from 'node:crypto';
import { PublicKey, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export const SOL = 'So11111111111111111111111111111111111111112';
export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const LAUNCHLAB = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
export const SENDER_TIPS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
];
export const short = value => value ? `${value.slice(0, 5)}…${value.slice(-5)}` : '—';
export function invariant(ok, message) { if (!ok) throw new Error(message); }
export class DirectRouteUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'DirectRouteUnavailableError'; }
}
export function address(value, label = 'Address') {
  try { return new PublicKey(String(value).trim()).toBase58(); }
  catch { throw new Error(`${label} must be a valid Solana public address.`); }
}
export function units(value, decimals = 9) {
  invariant(Number.isInteger(decimals) && decimals >= 0 && decimals <= 18, 'Unsupported token decimals.');
  const s = String(value).trim();
  invariant(/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(s), 'Enter a positive decimal amount, without exponent notation.');
  const [whole = '', fraction = ''] = s.split('.');
  invariant(fraction.length <= decimals, `Amount supports at most ${decimals} decimal places.`);
  const result = BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  invariant(result <= 18446744073709551615n, 'Amount exceeds the token integer limit.');
  return result;
}
export function decimal(value, decimals = 9) {
  const n = BigInt(value), sign = n < 0n ? '-' : '', digits = (n < 0n ? -n : n).toString().padStart(decimals + 1, '0');
  if (!decimals) return sign + digits;
  return sign + (digits.slice(0, -decimals) + '.' + digits.slice(-decimals)).replace(/\.?0+$/, '');
}
export function chooseAmount(config, wallet, decimals) {
  if (config.amountMode === 'custom') return units(wallet.amount, decimals);
  if (config.amountMode === 'fixed') return units(config.buyAmount, decimals);
  const min = units(config.randomMin, decimals), max = units(config.randomMax, decimals);
  // Uniform to one million discrete steps, with integer token amounts throughout.
  return min + (max - min) * BigInt(randomInt(1_000_001)) / 1_000_000n;
}
export function priorityPricing(lamports, computeUnits) {
  const price = BigInt(lamports) * 1_000_000n / BigInt(computeUnits);
  return { microLamports: price, chargedLamports: (price * BigInt(computeUnits) + 999_999n) / 1_000_000n };
}
export function parseWallet(row, index, mode) {
  const label = String(row.label || `Wallet ${index + 1}`).slice(0, 40);
  let keypair, bytes;
  try {
    let raw = String(row.privateKey || '').trim();
    const isSeed = raw.startsWith('seed:');
    if (isSeed) raw = raw.slice(5).trim();
    if (raw) {
      if (raw.startsWith('[')) {
        const array = JSON.parse(raw);
        invariant(Array.isArray(array) && array.every(n => Number.isInteger(n) && n >= 0 && n <= 255), 'Invalid bytes.');
        bytes = Uint8Array.from(array);
      } else bytes = bs58.decode(raw);
      invariant(bytes.length === 32 || bytes.length === 64, 'Wrong secret length.');
      invariant(bytes.length === 64 || isSeed, '32-byte seeds must have a seed: prefix to avoid mistaking a public address for a private key.');
      // fromSecretKey retains the supplied array. Give the signer its own copy
      // before finally clears the temporary decoder buffer below.
      keypair = bytes.length === 32 ? Keypair.fromSeed(bytes) : Keypair.fromSecretKey(Uint8Array.from(bytes));
    }
    invariant(mode === 'paper' || keypair, 'Missing key.');
    const publicKey = keypair?.publicKey.toBase58() || address(row.publicKey);
    return { label, publicKey, keypair, amount: String(row.amount || '0.05') };
  } catch { throw new Error(`${label}: enter a 64-byte base58/JSON private key; prefix a 32-byte seed with seed:${mode === 'paper' ? ', or use a public address for paper mode' : ''}.`); }
  finally { bytes?.fill(0); row.privateKey = ''; }
}
function number(value, fallback, min, max, label) {
  const n = value === undefined || value === '' ? fallback : Number(value);
  invariant(Number.isFinite(n) && n >= min && n <= max, `${label} must be between ${min} and ${max}.`);
  return n;
}
function endpoint(value, fallback, websocket = false) {
  const u = new URL(String(value || fallback));
  invariant(websocket ? ['wss:', 'ws:'].includes(u.protocol) : ['https:', 'http:'].includes(u.protocol), 'Enter an HTTP(S) RPC URL or WS(S) stream URL.');
  invariant(!u.username && !u.password, 'Use provider API fields rather than URL user credentials.');
  return u.toString();
}
export function validateConfig(raw, { requireLeads = true, walletLimit = WALLET_LIMITS.copy } = {}) {
  const mode = raw.mode === 'live' ? 'live' : 'paper';
  const leads = [...new Set((Array.isArray(raw.leads) ? raw.leads : String(raw.leads || '').split(/[\s,]+/)).filter(Boolean).map(x => address(x, 'Lead wallet')))];
  invariant((!requireLeads || leads.length >= 1) && leads.length <= 100, 'Enter between 1 and 100 lead addresses.');
  invariant(Array.isArray(raw.wallets) && raw.wallets.length > 0 && raw.wallets.length <= walletLimit, `Add between 1 and ${walletLimit} wallets for this tool.`);
  const wallets = raw.wallets.map((r, i) => parseWallet(r, i, mode));
  invariant(new Set(wallets.map(w => w.publicKey)).size === wallets.length, 'Follower wallets must be unique.');
  invariant(!wallets.some(w => leads.includes(w.publicKey)), 'A follower cannot also be a lead (prevents copy loops).');
  const heliusKey = String(raw.heliusKey || '').trim(), jupiterKey = String(raw.jupiterKey || '').trim();
  invariant(heliusKey || raw.rpcUrl, 'Enter a Helius API key or a custom RPC URL.');
  const rpcUrl = endpoint(raw.rpcUrl, `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusKey)}`);
  const derivedWs = rpcUrl.replace(/^http/, 'ws');
  const wsUrl = endpoint(raw.wsUrl, heliusKey && raw.streamMode === 'helius' ? `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusKey)}` : derivedWs, true);
  const prioritySol = String(raw.prioritySol ?? '0.0001'), jitoSol = String(raw.jitoSol ?? '0'), heliusSol = String(raw.heliusSol ?? '0.001');
  const fees = { priority: units(prioritySol), jito: units(jitoSol), helius: units(heliusSol) };
  for (const v of Object.values(fees)) invariant(v <= 100_000_000_000n, 'A single fee cannot exceed 100 SOL.');
  const sendRpc = raw.sendRpc === true, sendJito = fees.jito > 0n, sendHelius = fees.helius > 0n;
  invariant(sendRpc || sendJito || sendHelius, 'Enable RPC submission or enter a Jito/Helius tip.');
  invariant(!sendJito || fees.jito >= 1000n, 'Jito tip must be at least 0.000001 SOL (or zero to disable).');
  const senderTier = raw.senderTier === 'swqos' ? 'swqos' : 'max';
  invariant(!sendHelius || fees.helius >= (senderTier === 'max' ? 1_000_000n : 5000n), senderTier === 'max' ? 'Sender Max requires at least 0.001 SOL Helius tip. Choose SWQOS-only for a smaller tip.' : 'SWQOS-only requires at least 0.000005 SOL Helius tip.');
  invariant(!sendHelius || fees.priority > 0n, 'Helius Sender also requires a nonzero priority fee.');
  const amountMode = ['fixed', 'random', 'custom'].includes(raw.amountMode) ? raw.amountMode : 'fixed';
  const buyAmount = String(raw.buyAmount || '0.05'), randomMin = String(raw.randomMin || '0.03'), randomMax = String(raw.randomMax || '0.07');
  for (const v of amountMode === 'random' ? [randomMin, randomMax] : amountMode === 'custom' ? wallets.map(w => w.amount) : [buyAmount]) invariant(/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(v) && Number(v) > 0 && Number(v) <= 1e12, 'Buy amounts must be positive decimal numbers below one trillion.');
  invariant(amountMode !== 'random' || Number(randomMin) <= Number(randomMax), 'Random minimum cannot exceed maximum.');
  const quoteMints = [...new Set([SOL, USDC, '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', ...(String(raw.quoteMints || '').split(/[\s,]+/).filter(Boolean).map(x => address(x, 'Quote mint')))])];
  const sellMode = ['mirror', 'percent', 'marketcap', 'hybrid-percent', 'hybrid-marketcap'].includes(raw.sellMode) ? raw.sellMode : 'mirror';
  const c = {
    mode, sniperMode: raw.sniperMode === true, leads, wallets, rpcUrl, wsUrl, jupiterKey, prioritySol, jitoSol, heliusSol, fees, sendRpc, sendJito, sendHelius, senderTier,
    jitoUrl: endpoint(raw.jitoUrl, 'https://mainnet.block-engine.jito.wtf/api/v1/transactions'),
    jitoAuth: String(raw.jitoAuth || '').trim(), senderUrl: endpoint(raw.senderUrl, 'https://sender.helius-rpc.com/fast'),
    commitment: raw.commitment === 'confirmed' ? 'confirmed' : 'processed',
    streamMode: raw.streamMode === 'helius' ? 'helius' : 'logs',
    fastPumpLogs: raw.fastPumpLogs === true,
    directLaunches: raw.directLaunches !== false,
    simulateBeforeSend: raw.simulateBeforeSend !== false,
    rpcRequestsPerSecond: Math.floor(number(raw.rpcRequestsPerSecond, 8, 1, 1000, 'RPC requests per second')),
    amountMode, buyAmount, randomMin, randomMax, quoteMints,
    funding: raw.funding === 'lead' ? 'lead' : 'sol', sellMode,
    mirrorFraction: raw.mirrorFraction !== false,
    percentStep: number(raw.percentStep, 25, 0.01, 1e6, 'Price step'),
    marketcapStep: number(raw.marketcapStep, 100_000, 1, 1e15, 'Market cap step'),
    sellPercent: number(raw.sellPercent, 25, 0.01, 100, 'Sell percentage'),
    slippageBps: Math.round(number(raw.slippagePercent, 2, 0.01, 50, 'Slippage') * 100),
    maxPriceImpact: number(raw.maxPriceImpact, 10, 0.01, 100, 'Maximum price impact'),
    computeUnits: Math.floor(number(raw.computeUnits, 1_400_000, 100_000, 1_400_000, 'Compute limit')),
    maxSignalAgeMs: number(raw.maxSignalAgeMs, 5000, 100, 120000, 'Signal age'),
    marketPollMs: number(raw.marketPollMs, 2000, 1000, 60000, 'Market polling interval'),
    reserve: units(raw.reserveSol ?? '0.01'), runBudget: units(raw.runBudgetSol ?? '0'),
  };
  if (c.sendHelius) {
    const u = new URL(c.senderUrl);
    if (senderTier === 'swqos') u.searchParams.set('swqos_only', 'true'); else u.searchParams.delete('swqos_only');
    c.senderUrl = u.toString();
    invariant(priorityPricing(c.fees.priority, c.computeUnits).microLamports > 0n, 'Priority fee is too small for the compute limit.');
  }
  return c;
}

const anchorSwaps = new Set(['swap', 'swap_v2', 'swap_base_input', 'swap_base_output', 'buy', 'buy_v2', 'buy_exact_quote_in_v2', 'buy_exact_in', 'buy_exact_out', 'buy_exact_sol_in', 'sell', 'sell_v2', 'sell_exact_in', 'sell_exact_out', 'route', 'route_with_token_ledger', 'shared_accounts_route', 'shared_accounts_route_with_token_ledger', 'exact_out_route', 'shared_accounts_exact_out_route'].map(name => createHash('sha256').update(`global:${name}`).digest('hex').slice(0, 16)));
export function swapEvidence(tx, knownPrograms) {
  const message = tx.transaction?.message;
  const ixs = [...(message?.instructions || []), ...(tx.meta?.innerInstructions || []).flatMap(x => x.instructions || [])];
  for (const ix of ixs) {
    if (!knownPrograms.has(String(ix.programId)) || !ix.data || typeof ix.data !== 'string') continue;
    try { if (anchorSwaps.has(Buffer.from(bs58.decode(ix.data)).subarray(0, 8).toString('hex'))) return true; } catch {}
  }
  const stack = [];
  for (const line of tx.meta?.logMessages || []) {
    const invoke = /^Program (\w+) invoke \[(\d+)\]/.exec(line);
    if (invoke) { stack.length = Number(invoke[2]) - 1; stack.push(invoke[1]); continue; }
    if (/^Program \w+ (?:success|failed)/.test(line)) { stack.pop(); continue; }
    if (!knownPrograms.has(stack.at(-1))) continue;
    if (/^Program log: Instruction: (?:Swap\w*|Buy\w*|Sell\w*|Route\w*|SharedAccounts\w*Route\w*|ExactOutRoute)\b/.test(line)) return true;
    const ray = /^Program log: ray_log: (\S+)/.exec(line);
    if (ray && [3, 4].includes(Buffer.from(ray[1], 'base64')[0])) return true;
  }
  return false;
}
export function tokenBalances(tx, owner) {
  const records = new Map();
  for (const side of ['pre', 'post']) {
    for (const b of tx.meta?.[`${side}TokenBalances`] || []) {
      const key = `${b.accountIndex}:${b.mint}`;
      const r = records.get(key) || { mint: b.mint, owner: b.owner, decimals: b.uiTokenAmount.decimals, pre: 0n, post: 0n };
      if (b.owner) r.owner = b.owner;
      r[side] = BigInt(b.uiTokenAmount.amount); records.set(key, r);
    }
  }
  const totals = new Map();
  for (const r of records.values()) if (r.owner === owner) {
    const t = totals.get(r.mint) || { mint: r.mint, decimals: r.decimals, pre: 0n, post: 0n };
    t.pre += r.pre; t.post += r.post; totals.set(r.mint, t);
  }
  return [...totals.values()].map(t => ({ ...t, delta: t.post - t.pre }));
}
export function detectSwap(tx, lead, knownPrograms) {
  if (!tx?.meta || tx.meta.err || !swapEvidence(tx, knownPrograms)) return null;
  const keys = tx.transaction?.message?.accountKeys || [];
  const leadIndex = keys.findIndex(k => (typeof k === 'string' ? k : k.pubkey) === lead);
  if (leadIndex < 0) return null;
  const key = keys[leadIndex];
  const isSigner = typeof key === 'object' ? key.signer : leadIndex < (tx.transaction.message.header?.numRequiredSignatures || 0);
  if (!isSigner) return null;
  const balances = tokenBalances(tx, lead), deltas = balances.filter(t => t.delta !== 0n);
  const pre = tx.meta.preBalances?.[leadIndex], post = tx.meta.postBalances?.[leadIndex];
  if (!Number.isSafeInteger(pre) || !Number.isSafeInteger(post)) return null;
  const native = BigInt(post) - BigInt(pre) + (leadIndex === 0 ? BigInt(tx.meta.fee || 0) : 0n);
  // A SOL→quote→launch buy can leave a positive quote remainder beside the acquired base token.
  const venues = deltas.map(d => detectVenue(tx, d.mint, d.mint)).filter(Boolean);
  const uniqueVenues = [...new Map(venues.map(v => [v.pool, v])).values()];
  const venueHint = uniqueVenues.length === 1 ? uniqueVenues[0] : null;
  const relevant = venueHint && native < -1000n && deltas.some(d => d.mint === venueHint.baseMint && d.delta > 0n)
    ? deltas.filter(d => !(d.mint === venueHint.quoteMint && d.delta > 0n)) : deltas;
  const negative = relevant.filter(t => t.delta < 0n), positive = relevant.filter(t => t.delta > 0n);
  if (negative.length > 1 || positive.length > 1) return null;
  let sold = negative[0], bought = positive[0];
  // Prefer explicit SPL deltas; native change also includes rent/tips, so use it only for the missing SOL leg.
  if (!sold && bought && native < -1000n) sold = { mint: SOL, decimals: 9, pre: BigInt(pre), post: BigInt(post), delta: native };
  if (!bought && sold && native > 1000n) bought = { mint: SOL, decimals: 9, pre: BigInt(pre), post: BigInt(post), delta: native };
  if (!sold || !bought || sold.mint === bought.mint) return null;
  const venue = detectVenue(tx, sold.mint, bought.mint);
  return { lead, venue, quoteDecimals: venue?.quoteMint === SOL ? 9 : balances.find(b => b.mint === venue?.quoteMint)?.decimals,
    inputMint: sold.mint, outputMint: bought.mint, inputDecimals: sold.decimals, outputDecimals: bought.decimals,
    inputAmount: -sold.delta, outputAmount: bought.delta, inputPre: sold.pre,
    sellNumerator: -sold.delta, sellDenominator: sold.pre || -sold.delta };
}
export function detectVenue(tx, inputMint, outputMint) {
  const ixs = [...(tx.transaction?.message?.instructions || []), ...(tx.meta?.innerInstructions || []).flatMap(x => x.instructions || [])];
  for (const ix of ixs) {
    const program = String(ix.programId), accounts = ix.accounts || [];
    if (!ix.data || ![PUMP, LAUNCHLAB].includes(program)) continue;
    let discriminator; try { discriminator = Buffer.from(bs58.decode(ix.data)).subarray(0, 8).toString('hex'); } catch { continue; }
    if (!anchorSwaps.has(discriminator)) continue;
    let baseMint, quoteMint, pool;
    if (program === LAUNCHLAB) { baseMint = accounts[9]; quoteMint = accounts[10]; pool = accounts[4]; }
    else {
      const v2 = ['buy_v2', 'sell_v2', 'buy_exact_quote_in_v2'].some(name => createHash('sha256').update(`global:${name}`).digest('hex').slice(0, 16) === discriminator);
      baseMint = accounts[v2 ? 1 : 2]; quoteMint = v2 ? accounts[2] : SOL; pool = accounts[v2 ? 10 : 3];
    }
    if (baseMint === inputMint || baseMint === outputMint) return { type: program === PUMP ? 'pump' : 'launchlab', baseMint, quoteMint, pool,
      lookupTables: (tx.transaction?.message?.addressTableLookups || []).map(t => String(t.accountKey)).filter(Boolean) };
  }
  return null;
}
export function ladderTarget(lot, market, config) {
  if (!market || market.receivedAt < Date.now() - Math.max(config.marketPollMs * 3, 10000)) return 0;
  let level = 0;
  if (config.sellMode.includes('percent') && lot.entryPrice > 0 && market.price > 0) level = Math.floor(((market.price / lot.entryPrice - 1) * 100 + 1e-8) / config.percentStep);
  if (config.sellMode.includes('marketcap') && lot.entryMarketCap > 0 && market.marketCap > 0) level = Math.floor((market.marketCap - lot.entryMarketCap) / config.marketcapStep);
  return Math.max(0, Math.min(10000, level));
}
export function ladderAmount(balance, sellPercent, crossed) {
  let remaining = BigInt(balance);
  const bps = BigInt(Math.round(sellPercent * 100));
  for (let i = 0; i < Math.min(crossed, 10000) && remaining > 0n; i++) remaining -= (remaining * bps + 9999n) / 10000n;
  return BigInt(balance) - remaining;
}
