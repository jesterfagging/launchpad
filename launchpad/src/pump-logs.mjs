import { PublicKey } from '@solana/web3.js';
import { PUMP_SDK, getPumpProgram, bondingCurvePda, pumpIdl } from '@pump-fun/pump-sdk';
import { PUMP, SOL } from './core.mjs';

const discriminator = Buffer.from(pumpIdl.events.find(e => e.name === 'TradeEvent').discriminator);
const coder = getPumpProgram(null).coder.types;
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const tokenPrograms = new Set([TOKEN, TOKEN_2022]);
const rejected = reason => ({ signal: null, reason });

// Only an actual Pump invocation may supply a trade event. A mention of a
// watched address, arbitrary Program data, or a lookalike Program log is not
// evidence of a lead trade. Ambiguous/incomplete cases use confirmed parsing.
export function pumpLogSignal(value, leads, mirrorFraction = true) {
  return inspectPumpLogs(value, leads, mirrorFraction).signal;
}

export function inspectPumpLogs(value, leads, mirrorFraction = true) {
  if (value?.err !== null || !Array.isArray(value.logs)) return rejected('failed or missing logs');
  const stack = [], trades = [], outsidePrograms = new Set();
  try {
    for (const line of value.logs) {
      if (typeof line !== 'string' || /log truncated/i.test(line)) return rejected('incomplete logs');
      const invoke = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
      if (invoke) {
        if (Number(invoke[2]) !== stack.length + 1) return rejected('incomplete invocation stack');
        if (tokenPrograms.has(invoke[1]) && !stack.some(f => f.program === PUMP) && !(stack.at(-1)?.program === ATA && trades.length === 0)) outsidePrograms.add(invoke[1]);
        stack.push({ program: invoke[1], transfers: new Set() }); continue;
      }
      const end = /^Program (\w+) (success|failed:.*)$/.exec(line);
      if (end) {
        if (stack.pop()?.program !== end[1] || end[2] !== 'success') return rejected('failed or incomplete invocation');
        continue;
      }
      // Authenticate the base transfer's program inside the SAME Pump call as
      // the event. Tokenkeg cannot move Token-2022 balances; Jupiter's wrap,
      // unwrap and SOL fee instructions therefore do not change that base leg.
      if (tokenPrograms.has(stack.at(-1)?.program) && stack.at(-2)?.program === PUMP && line === 'Program log: Instruction: TransferChecked')
        stack.at(-2).transfers.add(stack.at(-1).program);
      if (stack.at(-1)?.program !== PUMP || !line.startsWith('Program data: ')) continue;
      const encoded = line.slice(14);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length > 6000) return rejected('invalid Pump event encoding');
      const bytes = Buffer.from(encoded, 'base64');
      if (!bytes.subarray(0, 8).equals(discriminator)) continue;
      const body = bytes.subarray(8), event = PUMP_SDK.decodeTradeEventBc(body);
      // The deployed layout may omit the SDK's final two holder-reward u64s.
      // Re-encoding rejects partial fields/default padding and unknown layouts.
      const canonical = coder.encode('tradeEvent', event);
      if (![canonical.length, canonical.length - 16].includes(body.length) || !canonical.subarray(0, body.length).equals(body)) return rejected('unsupported Pump event layout');
      trades.push({ event, transfers: new Set(stack.at(-1).transfers) });
    }
    if (stack.length) return rejected('incomplete invocation stack');
    if (trades.length !== 1) return rejected(trades.length ? 'multiple Pump trades in one transaction' : 'no supported Pump trade event');
    const { event: e, transfers } = trades[0], lead = e.user.toBase58(), mint = e.mint.toBase58();
    const quote = e.quoteMint.equals(PublicKey.default) ? SOL : e.quoteMint.toBase58();
    if (!leads.includes(lead)) return rejected('Pump event belongs to a different trader');
    if (quote !== SOL || mint === SOL) return rejected('pair needs full transaction parsing');
    const baseTokenProgram = transfers.size === 1 && transfers.has(TOKEN_2022) ? TOKEN_2022 : undefined;
    if ([...outsidePrograms].some(program => program !== TOKEN || baseTokenProgram !== TOKEN_2022))
      return rejected('token operations outside the supported Pump base leg');
    const amount = BigInt(e.tokenAmount.toString()), quoteAmount = BigInt(e.quoteAmount.toString() || '0') || BigInt(e.solAmount.toString());
    if (amount <= 0n || quoteAmount <= 0n) return rejected('empty trade amount');
    if (e.isBuy ? !['buy', 'buy_exact_sol_in', 'buy_exact_quote_in', 'buy_v2', 'buy_exact_quote_in_v2'].includes(e.ixName) : !['sell', 'sell_v2'].includes(e.ixName)) return rejected('unsupported Pump instruction');
    // ATA initialization before a buy is normal. The full parser remains the
    // path for proportional sells: a TradeEvent has no pre-trade user balance.
    if (!e.isBuy && mirrorFraction) return rejected('proportional sell needs the lead pre-trade balance');
    return { reason: null, signal: { lead, inputMint: e.isBuy ? SOL : mint, outputMint: e.isBuy ? mint : SOL,
      inputAmount: e.isBuy ? quoteAmount : amount, outputAmount: e.isBuy ? amount : quoteAmount,
      inputDecimals: e.isBuy ? 9 : undefined, outputDecimals: e.isBuy ? undefined : 9, quoteDecimals: 9,
      sellNumerator: e.isBuy ? 0n : amount, sellDenominator: e.isBuy ? 1n : amount,
      venue: { type: 'pump', pool: bondingCurvePda(e.mint).toBase58(), baseMint: mint, quoteMint: SOL, lookupTables: [], ...(baseTokenProgram ? { baseTokenProgram } : {}) },
      source: 'pump-processed-logs' } };
  } catch { return rejected('unrecognized or incomplete Pump event'); }
}
