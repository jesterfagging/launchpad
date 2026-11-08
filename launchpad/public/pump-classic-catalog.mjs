// Pump.fun Classic launch options shared by the launch page and the server.
// Browser-safe: no Node imports. Platform-share percentages are documented in
// /docs#revenue only; the launch flow links there instead of repeating them.
export const PUMP_CLASSIC_VENUE = 'pump-classic';
export const PUMP_CLASSIC_LABEL = 'Pump.fun';
export const PUMP_CLASSIC_MODES = Object.freeze(['creator', 'holders', 'gotchi', 'agent', 'market_maker', 'lp_manager', 'diamond_hands', 'earned', 'insured']);
// Options that only exist on Pump.fun for now.
export const PUMP_CLASSIC_ONLY_MODES = Object.freeze(['market_maker', 'lp_manager', 'diamond_hands', 'earned', 'insured']);
// Options whose wallets trade or settle in SOL: they pair with SOL only (the server enforces it). Earned and Insured
// settle their escrow and refund pot with the developer and holders in SOL (v71.35).
export const PUMP_CLASSIC_SOL_ONLY_MODES = Object.freeze(['agent', 'market_maker', 'lp_manager', 'earned', 'insured']);
// Options that need a pair Launchpad can sell for SOL: Gotchi converts its share to SOL; Holders and Diamond Hands pay in
// the pair asset and sell a small part of it for holders' new token accounts and network fees.
export const PUMP_CLASSIC_CONVERT_MODES = Object.freeze(['holders', 'gotchi', 'diamond_hands']);
export const PUMP_CLASSIC_STRATEGY_MODES = Object.freeze(['market_maker', 'lp_manager']);
// Options with creator settings written on the launch (v71.35); see pump-option-catalog.mjs.
export const PUMP_CLASSIC_OPTION_MODES = Object.freeze(['diamond_hands', 'earned', 'insured']);
// Options whose holder payouts run through the Launchpad-run holder rewards: always for Holders and Diamond Hands; Earned
// after the coin fails its probation; Insured once the pot is owed to holders.
export const PUMP_CLASSIC_HOLDER_MODES = Object.freeze(['holders', 'diamond_hands']);
export const PUMP_CLASSIC_MODE_LABELS = Object.freeze({ creator: 'Creator', holders: 'Holders', gotchi: 'Gotchi', agent: 'AI Agent', market_maker: 'Market Maker', lp_manager: 'Liquidity Manager', diamond_hands: 'Diamond Hands', earned: 'Earned', insured: 'Insured' });
export const PUMP_CLASSIC_MODE_SUMMARIES = Object.freeze({
  creator: 'Creator fees are paid to your wallet by Pump.fun’s fee sharing.',
  holders: 'Creator fees fund rewards for the top 100 holders, paid by Launchpad in the coin’s pair asset whenever the holders’ share reaches about $100.',
  gotchi: 'Creator fees fill the prize pot of the Gotchi you pair with.',
  agent: 'Creator fees fund an AI agent that researches, posts updates and can propose capped treasury actions.',
  market_maker: 'Creator fees fund a rebalancing bot that buys and sells from its own wallet to keep a target mix of SOL and your coin.',
  lp_manager: 'Creator fees accumulate until PumpSwap graduation, then fund liquidity added to the canonical PumpSwap pool.',
  diamond_hands: 'Creator fees fund holder rewards like Holders, but a payout skips any wallet that sold since the last one; every payout a wallet holds through grows its streak and its share.',
  earned: 'Creator fees are held in escrow and released to you only if the coin holds its value through a probation period; if it collapses, the escrow and every later fee pay holders instead.',
  insured: 'A share of creator fees builds a refund pot while the rest is paid to you. If the coin has not graduated by the deadline, the pot refunds holders.',
});
export const PUMP_CLASSIC_LIMITS = Object.freeze({ maxDevBuySol: 25, maxSeedSol: 50 });
export const PUMP_CLASSIC_FEE_LINK = '/docs#revenue';
export const PUMP_CLASSIC_STATES = Object.freeze({
  draft: 'Draft', awaiting_funding: 'Waiting for funding', funding_pending: 'Confirming funding', funded: 'Funded',
  creating: 'Creating on Pump.fun', created: 'Live on Pump.fun', failed: 'Failed', refunding: 'Refunding', refunded: 'Refunded', cancelled: 'Cancelled', expired: 'Quote expired',
});
export const PUMP_CLASSIC_STRATEGY_STATES = Object.freeze({
  waiting_for_fees: 'Waiting for fees', waiting_for_graduation: 'Waiting for graduation', delivery_pending: 'Delivery pending',
  reconciling: 'Reconciling', paused: 'Paused', active: 'Active', retired: 'Retired', accumulating: 'Accumulating',
});
/**
 * Short, number-free disclosure lines shown before funding. `pair` is the
 * symbol of a quote asset other than SOL (empty for SOL coins);
 * `creatorFeeBps` > 0 when the creator chose the coin's creator fee.
 */
export function pumpClassicDisclosure(mode, { pair = '', creatorFeeBps = 0, devBuyInSol = false } = {}) {
  const lines = [
    'Your coin is created on Pump.fun from a Launchpad launch wallet made only for this coin. Your dev-buy tokens are delivered to the wallet you fund from.',
    pair ? `Your coin trades against ${pair} on Pump.fun’s curve for this pair; graduation moves it to a PumpSwap ${pair} pool.` : 'Pump.fun’s standard curve applies; graduation moves the coin to PumpSwap.',
    'A platform share of creator fees applies to every Pump.fun option. See Fees & revenue in the docs.',
  ];
  if (pair && devBuyInSol) lines.push(`You fund everything in SOL. For a dev buy, Launchpad buys ${pair} with that SOL through a verified swap once your funding is final, and the dev buy spends what it bought. Unused SOL and any ${pair} left over are refunded. If the coin is not created after that purchase, Launchpad sells the ${pair} back to SOL for your refund (or returns it if it cannot).`);
  else if (pair) lines.push(`Your dev buy is paid in ${pair} from your wallet; launch costs and reserves are paid in SOL. Unused ${pair} and SOL are refunded.`);
  if (creatorFeeBps > 0) lines.push('You chose this coin’s creator fee within Pump.fun’s limit for this pair. Pump.fun applies it to trades, and Launchpad does not change it after creation.');
  if (mode === 'creator') lines.push(pair ? `Your share of creator fees is paid by Pump.fun to your funding wallet in ${pair}. You do not receive any other creator payout.` : 'Your share of creator fees is paid by Pump.fun to your funding wallet. You do not receive any other creator payout.');
  else if (mode === 'earned') lines.push('Your share of creator fees is paid by Pump.fun to a Launchpad escrow wallet made for this coin. Launchpad releases it to your funding wallet only if the coin passes its probation; if the coin fails, the escrow and every later fee pay holders. The settings are permanent.');
  else if (mode === 'insured') lines.push('Your share of creator fees is paid by Pump.fun to a Launchpad wallet made for this coin. Launchpad keeps the coverage share as the refund pot and sends you the rest. If the coin has not graduated by the deadline, the pot pays holders and the coverage share keeps paying them. The settings are permanent.');
  else lines.push('You do not receive a creator-fee payout for this option; fees fund the option you choose, and that choice is permanent.');
  if (pair && (mode === 'holders' || mode === 'diamond_hands')) lines.push(`Creator fees arrive in ${pair}, and holder rewards are paid in ${pair}. Launchpad sells only a small part of the rewards through a verified swap for holders’ new ${pair} accounts and network fees, and converts its platform share to SOL.`);
  else if (pair && mode !== 'creator') lines.push(`Creator fees arrive in ${pair}. Launchpad converts the shares it holds to SOL through a verified swap before paying them out; swap prices move and a conversion can wait for a route.`);
  else if (pair) lines.push(`Creator fees arrive in ${pair}. Launchpad converts its platform share to SOL through a verified swap.`);
  if (mode === 'holders') lines.push(`Holder rewards go to the top 100 holders by minimum balance over the last hour, whenever the holders’ share reaches about $100.`);
  if (mode === 'diamond_hands') lines.push('Holder rewards go to the top 100 holders by minimum balance over the last hour, whenever the holders’ share reaches about $100, except a wallet whose balance dropped since its last payout: it is skipped and its streak starts over. A streak held through consecutive payouts raises a wallet’s share up to the cap you set.');
  if (mode === 'earned') lines.push('Probation starts at launch. Launchpad records the coin’s market cap once a day; the first record, a day after launch, is the baseline. A record below the floor you set fails the coin. Surviving the probation period releases the escrow to you and every later fee follows it.');
  if (mode === 'insured') lines.push('Holder refunds and bonuses are paid like holder rewards: to the top 100 holders by minimum balance over the last hour. A refund is started as soon as the deadline passes.');
  if (mode === 'market_maker' || mode === 'lp_manager') lines.push('The bot uses its own Launchpad-managed wallet, separate from the wallet that creates the coin. Its capital stays with this coin and cannot be withdrawn by you. Trading can lose value; nothing here promises price support, volume or profit.');
  if (mode === 'lp_manager') lines.push('Liquidity is added only after PumpSwap graduation; until then fees accumulate.');
  return lines;
}
