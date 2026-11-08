import { decodeEventLog, decodeFunctionData, encodeFunctionData, parseAbi } from 'viem';
import { CONTRACTS } from './robinhood-contracts.mjs';
import { tokenDelta } from './robinhood-executor.mjs';

const abi = parseAbi(['function deposit() payable', 'function withdraw(uint256 wad)', 'event Deposit(address indexed dst,uint256 wad)', 'event Withdrawal(address indexed src,uint256 wad)']);
export function wrappedEthPlan(buy, amount) {
  return { to: CONTRACTS.weth, data: encodeFunctionData({ abi, functionName: buy ? 'deposit' : 'withdraw', args: buy ? [] : [amount] }), value: buy ? amount : 0n, approvals: [] };
}
export function verifyWrappedEth(pending, receipt) {
  const buy = pending.context.side === 'buy', amount = BigInt(pending.context.amount), decoded = decodeFunctionData({ abi, data: pending.data });
  if (pending.to !== CONTRACTS.weth || decoded.functionName !== (buy ? 'deposit' : 'withdraw') || BigInt(pending.value) !== (buy ? amount : 0n) || !buy && decoded.args[0] !== amount) throw Error('Wrapped ETH receipt does not match its signed conversion.');
  const expected = buy ? amount : -amount;
  if (tokenDelta(receipt, pending.wallet, CONTRACTS.weth) === expected) return amount;
  const name = buy ? 'Deposit' : 'Withdrawal';
  const events = (receipt.logs || []).filter(log => log.address.toLowerCase() === CONTRACTS.weth.toLowerCase()).flatMap(log => {
    try { const event = decodeEventLog({ abi, eventName: name, topics: log.topics, data: log.data }); return event.args[buy ? 'dst' : 'src'].toLowerCase() === pending.wallet.toLowerCase() ? [event.args.wad] : []; } catch { return []; }
  });
  if (events.length !== 1 || events[0] !== amount) throw Error('Wrapped ETH conversion has no matching deposit or withdrawal receipt.');
  return amount;
}
