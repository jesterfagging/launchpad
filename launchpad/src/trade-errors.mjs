import { PUMP, SOL, decimal } from './core.mjs';

// Custom codes are program-specific. Decode only an actual Pump instruction
// and an Anchor error emitted while that program owns the runtime log stack.
function pumpError(logs, code) {
  const name = { 6002:'TooMuchSolRequired', 6003:'TooLittleSolReceived' }[code];
  if (!name) return null;
  const stack = []; let found;
  for (const line of logs) {
    const invoke = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      if (Number(invoke[2]) !== stack.length+1) return null;
      stack.push(invoke[1]); continue;
    }
    const end = /^Program (\w+) (success|failed:.*)$/.exec(line);
    if (end) {
      if (stack.at(-1) !== end[1]) return null;
      if (end[1] === PUMP && found && end[2] === `failed: custom program error: 0x${code.toString(16)}`) return found;
      stack.pop(); continue;
    }
    if (stack.at(-1) !== PUMP) continue;
    if (line.startsWith('Program log: AnchorError ') && line.includes(`Error Code: ${name}. Error Number: ${code}.`)) found = { name };
    const value = /^Program log: (Left|Right): ([0-9]{1,20})$/.exec(line);
    if (found && value) found[value[1].toLowerCase()] = value[2];
  }
  return null;
}

export function describeTradeFailure(order, error, tx) {
  const instruction = error?.InstructionError;
  const index = Array.isArray(instruction) && Number.isSafeInteger(instruction[0]) ? instruction[0] : null;
  const code = Number.isSafeInteger(instruction?.[1]?.Custom) ? instruction[1].Custom : null;
  const programId = index !== null ? String(tx?.transaction?.message?.instructions?.[index]?.programId || '') : '';
  const logs = Array.isArray(tx?.meta?.logMessages) ? tx.meta.logMessages.filter(l => typeof l === 'string') : [];
  const decoded = programId === PUMP && JSON.stringify(tx?.meta?.err) === JSON.stringify(error) ? pumpError(logs, code) : null;
  const failure = { error, instructionIndex:index, programId:programId || null, code, name:decoded?.name || null,
    slippageBps:order.executionLimits?.slippageBps ?? null,
    feeLamports:Number.isSafeInteger(tx?.meta?.fee) ? tx.meta.fee : null };
  let message = `Transaction failed on chain: ${JSON.stringify(error).slice(0,160)}. Inventory unchanged.`;
  if (decoded?.name === 'TooMuchSolRequired' && order.kind === 'buy') {
    message = 'Pump buy failed: slippage limit hit. No tokens bought. Review Slippage (%) in Pair settings & execution limits.';
    if (order.venue?.quoteMint === SOL && decoded.left && decoded.right && BigInt(decoded.right) > BigInt(decoded.left)) {
      failure.quoteCapRaw = decoded.left; failure.quoteRequiredRaw = decoded.right; failure.quoteMint = SOL;
      message = `Pump buy failed: slippage limit hit. Required ${decimal(decoded.right,9)} SOL; cap ${decimal(decoded.left,9)} SOL. No tokens bought. Review Slippage (%) in Pair settings & execution limits.`;
    }
  } else if (decoded?.name === 'TooLittleSolReceived' && order.kind === 'sell')
    message = 'Pump sell failed: minimum proceeds not met (slippage). Position remains open. Review Slippage (%) in Pair settings & execution limits.';
  return { message, details:{ failure, programLogs:logs.slice(-24).map(l => l.slice(0,500)) } };
}
