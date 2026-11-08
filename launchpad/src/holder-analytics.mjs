import { formatUnits } from 'viem';

const unsigned = value => typeof value === 'string' && /^\d{1,100}$/.test(value);
const address = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const evm = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value);
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const number = value => { const n = Number(value); return value !== null && value !== '' && Number.isFinite(n) && n >= 0 ? n : null; };
const text = value => String(value || '').slice(0, 40);
const SOL = 'So11111111111111111111111111111111111111112';
const ETH = '0x0000000000000000000000000000000000000000';
const symbols = new Map([[SOL, 'SOL'], ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC'], ['Es9vMFrzaCERmJfrF4H2FYD5NpXeEkAFce95vbGVh7mV', 'USDT']]);

export function rawAmount(value, decimals) {
  const d = Number(decimals);
  if (!unsigned(value) || !Number.isInteger(d) || d < 0 || d > 36) return null;
  return formatUnits(BigInt(value), d);
}
export function supplyPercent(amount, supply) {
  if (!unsigned(amount) || !unsigned(supply) || BigInt(supply) <= 0n || BigInt(amount) > BigInt(supply)) return null;
  return Number(BigInt(amount) * 10000000000n / BigInt(supply)) / 100000000;
}

// Raw traces include the outer call. Count it once, preserve refunds, and
// ignore delegatecall's inherited value. A complete trace tree is required;
// transaction.value alone cannot establish the amount paid for a swap.
export function blockscoutNativeDelta(transaction, wallet) {
  const rows=transaction?.raw_trace;
  if(!Array.isArray(rows)||!rows.length||rows.length>300)return null;
  const paths=new Map();let delta=0n;
  try {
    for(const row of rows){
      if(!Array.isArray(row.traceAddress)||row.traceAddress.some(n=>!Number.isSafeInteger(n)||n<0)||!Number.isSafeInteger(row.subtraces)||row.subtraces<0||row.error)return null;
      const path=row.traceAddress.join('.');if(paths.has(path))return null;paths.set(path,row);
    }
    const root=paths.get('');
    if(root?.type!=='call'||lower(root.action?.from)!==lower(transaction.from?.hash)||lower(root.action?.to)!==lower(transaction.to?.hash)||BigInt(root.action?.value)!==BigInt(transaction.value))return null;
    for(const row of rows){
      const path=row.traceAddress.join('.');
      if(row.traceAddress.length&&!paths.has(row.traceAddress.slice(0,-1).join('.')))return null;
      const children=rows.filter(other=>other.traceAddress.length===row.traceAddress.length+1&&other.traceAddress.slice(0,-1).join('.')===path);
      if(children.length!==row.subtraces||children.some((_,i)=>!paths.has([...row.traceAddress,i].join('.'))))return null;
      let from,to,value;
      if(row.type==='call'){
        if(!['call','delegatecall','callcode','staticcall'].includes(row.action?.callType))return null;
        if(row.action.callType!=='call')continue;
        ({from,to,value}=row.action);
      }else if(row.type==='suicide'){from=row.action?.address;to=row.action?.refundAddress;value=row.action?.balance;}
      else if(row.type==='create'){from=row.action?.from;to=row.result?.address;value=row.action?.value;}
      else return null;
      if(!evm(from)||!evm(to)||typeof value!=='string'||! /^(?:0x[0-9a-f]+|\d+)$/i.test(value))return null;
      const amount=BigInt(value);if(lower(from)===lower(wallet))delta-=amount;if(lower(to)===lower(wallet))delta+=amount;
    }
    return delta.toString();
  }catch{return null;}
}

function summary(source, at, transactions, note) {
  const timestamps = transactions.map(row => row.at).filter(Number.isFinite);
  return { source, at, available: true, bought: { tokens: 0, usd: null, count: 0 }, sold: { tokens: 0, usd: null, count: 0 }, quotes: [], pnl: null,
    coverage: { complete: false, from: timestamps.length ? Math.min(...timestamps) : null, to: timestamps.length ? Math.max(...timestamps) : null, transactions: transactions.length, note } };
}
function aggregate(result, swaps) {
  const quotes = new Map();
  for (const swap of swaps) {
    const target = result[swap.side]; target.tokens += swap.amount; target.count++;
    const q = quotes.get(swap.mint) || { mint: swap.mint, symbol: swap.symbol, bought: 0, sold: 0, buyTokens: 0, sellTokens: 0 };
    q[swap.side] += swap.quote;
    q[swap.side === 'bought' ? 'buyTokens' : 'sellTokens'] += swap.amount;
    quotes.set(swap.mint, q);
  }
  result.quotes = [...quotes.values()].map(q => ({ mint: q.mint, symbol: q.symbol, bought: q.bought, sold: q.sold, averageEntry: q.buyTokens > 0 ? q.bought / q.buyTokens : null, averageExit: q.sellTokens > 0 ? q.sold / q.sellTokens : null }));
  return result;
}
function tokenLegs(rows, wallet) {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(row => {
    if (row?.userAccount !== wallet || !address(row?.mint)) return [];
    const amount = rawAmount(row.rawTokenAmount?.tokenAmount, row.rawTokenAmount?.decimals);
    return amount !== null && Number(amount) > 0 ? [{ mint: row.mint, symbol: symbols.get(row.mint) || `${row.mint.slice(0,4)}…${row.mint.slice(-4)}`, amount: Number(amount) }] : [];
  });
}
function combine(legs) {
  const result = new Map();
  for (const leg of legs) {
    const previous = result.get(leg.mint); result.set(leg.mint, previous ? { ...previous, amount: previous.amount + leg.amount } : leg);
  }
  return [...result.values()];
}

// Only provider-decoded SWAP events belonging to this wallet count as trades.
// Plain incoming/outgoing transfers, LP operations, and other wallets' route
// legs are never treated as buys or sells. No present-day USD prices are used.
export function heliusHolderHistory(records, token, wallet, at) {
  const seen = new Set();
  const rows = records.slice(0,100).filter(row => {
    if (typeof row?.signature !== 'string' || seen.has(row.signature)) return false;
    seen.add(row.signature); return true;
  });
  const result = summary('Helius', at, rows.map(row => ({ at: Number(row.timestamp) > 0 ? Number(row.timestamp) * 1000 : null })), 'Recent 100 wallet transactions at most. Only decoded swaps are included; this is not lifetime history. Entry and exit are weighted prices in the actual payment token. Historical USD and profit/loss are unavailable.');
  const swaps = [];
  for (const row of rows) {
    if (row.transactionError != null || row.type !== 'SWAP' || !row.events?.swap) continue;
    const event = row.events.swap;
    const inputs = tokenLegs(event.tokenInputs, wallet), outputs = tokenLegs(event.tokenOutputs, wallet);
    for (const [native, list] of [[event.nativeInput, inputs], [event.nativeOutput, outputs]]) {
      if (native?.account === wallet && (typeof native.amount === 'string' || Number.isSafeInteger(native.amount)) && unsigned(String(native.amount))) {
        const amount = Number(formatUnits(BigInt(native.amount),9));
        if (amount > 0) list.push({ mint: SOL, symbol: 'SOL', amount });
      }
    }
    const ins = combine(inputs), outs = combine(outputs);
    // Multiple outputs/inputs may be arbitrage, split recipients, or bundled
    // operations. Do not assign one guessed cost to their different assets.
    if (ins.length !== 1 || outs.length !== 1 || ins[0].mint === outs[0].mint) continue;
    const bought = outs[0].mint === token, sold = ins[0].mint === token;
    if (!bought && !sold) continue;
    const base = bought ? outs[0] : ins[0], quote = bought ? ins[0] : outs[0];
    if (![base.amount,quote.amount].every(n => Number.isFinite(n) && n > 0)) continue;
    swaps.push({ side: bought ? 'bought' : 'sold', amount: base.amount, mint: quote.mint, symbol: quote.symbol, quote: quote.amount });
  }
  result.coverage.decodedSwaps = swaps.length;
  return aggregate(result, swaps);
}

export function blockscoutHolderHistory(transfers, transactions, token, wallet, at) {
  token = lower(token); wallet = lower(wallet);
  const result = summary('Blockscout', at, transfers.map(row => ({ at: Date.parse(row.timestamp) || null })), 'Recent 50 token transfers at most; up to 6 related transactions are decoded. Only verified swaps with complete wallet movements are included. Native ETH amounts require a complete execution trace and exclude gas. Unsupported activity is omitted. Historical USD and profit/loss are unavailable.');
  result.transferred = { in: 0, out: 0, count: 0 };
  const seenTransfers = new Set();
  for (const row of transfers.slice(0,50)) {
    const key = `${row?.transaction_hash}:${row?.log_index}`;
    if (seenTransfers.has(key) || lower(row?.token?.address_hash) !== token || row?.token?.type !== 'ERC-20') continue;
    seenTransfers.add(key);
    const amount = number(rawAmount(row.total?.value, row.total?.decimals)); if (amount === null) continue;
    const from = lower(row.from?.hash), to = lower(row.to?.hash);
    if (from === to || ![from,to].includes(wallet)) continue;
    result.transferred[from === wallet ? 'out' : 'in'] += amount; result.transferred.count++;
  }
  const seenTx = new Set(), swaps = [];
  for (const row of transactions.slice(0,6)) {
    if (typeof row?.hash !== 'string' || seenTx.has(row.hash)) continue;
    seenTx.add(row.hash);
    if (row.status !== 'ok' || lower(row.from?.hash) !== wallet || row.has_error_in_internal_transactions || row.token_transfers_overflow !== false) continue;
    const decodedActions=Array.isArray(row.actions)&&row.actions.length>0&&row.actions.every(action=>action?.type==='swap');
    const evidence=row.relaySwapEvidence;
    if(!decodedActions&&!evidence)continue;
    if(Array.isArray(row.actions)&&row.actions.some(action=>action?.type!=='swap'))continue;
    if (!Array.isArray(row.token_transfers) || row.token_transfers.length > 100) continue;
    const net = new Map(); let valid = true;
    for (const transfer of row.token_transfers) {
      const from = lower(transfer.from?.hash), to = lower(transfer.to?.hash);
      if (from === to || ![from,to].includes(wallet)) continue;
      const mint = lower(transfer.token?.address_hash), amount = number(rawAmount(transfer.total?.value,transfer.total?.decimals));
      if (!evm(mint) || transfer.token?.type !== 'ERC-20' || amount === null) { valid = false; break; }
      const previous = net.get(mint) || { mint, symbol: text(transfer.token?.symbol) || `${mint.slice(0,6)}…`, amount: 0 };
      previous.amount += (to === wallet ? 1 : -1) * amount; net.set(mint, previous);
    }
    // When exactly one token changes hands (or ETH is explicitly sent), the
    // missing quote leg must be proven by a complete native execution trace.
    const tokenLegs=[...net.values()].filter(leg=>leg.amount!==0);
    if(String(row.value)!=='0'||tokenLegs.length===1||row.raw_trace){
      const native=blockscoutNativeDelta(row,wallet);
      if(native===null){if(String(row.value)!=='0'||tokenLegs.length===1)continue;}
      else if(BigInt(native)!==0n)net.set(ETH,{mint:ETH,symbol:'ETH',amount:Number(formatUnits(BigInt(native),18))});
    }
    const legs = [...net.values()].filter(leg => leg.amount !== 0), base = net.get(token);
    if (!valid || legs.length !== 2 || !base || base.amount === 0) continue;
    const quote = legs.find(leg => leg.mint !== token);
    if (Math.sign(base.amount) === Math.sign(quote.amount)) continue;
    // An undecoded explorer transaction is admitted only when one verified
    // pool swap exactly matches both wallet legs. Mixed routes stay unknown.
    if(!decodedActions&&(!evidence||lower(evidence.quoteMint)!==quote.mint||evidence.side!==(base.amount>0?'buy':'sell')||Number(evidence.tokenAmount)!==Math.abs(base.amount)||Number(evidence.quoteAmount)!==Math.abs(quote.amount)))continue;
    swaps.push({ side: base.amount > 0 ? 'bought' : 'sold', amount: Math.abs(base.amount), mint: quote.mint, symbol: quote.symbol, quote: Math.abs(quote.amount) });
  }
  result.coverage.decodedSwaps = swaps.length;
  result.coverage.inspectedTransactions = transactions.length;
  result.available = swaps.length > 0;
  if (!result.available) { result.bought = { tokens: null, usd: null, count: null }; result.sold = { tokens: null, usd: null, count: null }; }
  return aggregate(result, swaps);
}
