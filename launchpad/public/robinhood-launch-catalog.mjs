// The launchpad's own launch contracts on Robinhood Chain: the options shared by the launch page, the coin page and the server.
// Browser-safe: no Node imports. Fee percentages live in /docs#revenue; the launch flow links there.
export const ROBINHOOD_LAUNCH_VENUE = 'robinhood';
export const ROBINHOOD_LAUNCH_LABEL = 'Launchpad on Robinhood Chain';
export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_EXPLORER = 'https://robinhoodchain.blockscout.com';
export const ROBINHOOD_NATIVE = '0x0000000000000000000000000000000000000000';
/** The options a Robinhood launch can take now. Gotchi, AI Agent, the bots and baskets follow on this chain. */
export const ROBINHOOD_MODES = Object.freeze(['creator', 'holders', 'diamond_hands', 'earned', 'insured']);
export const ROBINHOOD_LATER_MODES = Object.freeze(['gotchi', 'agent', 'market_maker', 'lp_manager']);
export const ROBINHOOD_OPTION_MODES = Object.freeze(['diamond_hands', 'earned', 'insured']);
export const ROBINHOOD_HOLDER_MODES = Object.freeze(['holders', 'diamond_hands']);
export const ROBINHOOD_MODE_LABELS = Object.freeze({ creator: 'Creator', holders: 'Holders', diamond_hands: 'Diamond Hands', earned: 'Earned', insured: 'Insured' });
export const ROBINHOOD_MODE_SUMMARIES = Object.freeze({
  creator: 'Your share of trading fees accrues on chain under your wallet; claim it whenever you like.',
  holders: 'Your share of trading fees funds rewards for the top 100 holders, paid by Launchpad in the coin’s pair asset whenever the holders’ share reaches about $100.',
  diamond_hands: 'Holder rewards like Holders, but a payout skips any wallet that sold since the last one; every payout a wallet holds through grows its streak and its share.',
  earned: 'Your share of trading fees is held by Launchpad and released to you only if the coin holds its value through a probation period; if it collapses, the escrow and every later fee pay holders instead.',
  insured: 'A share of your trading fees builds a refund pot while the rest is paid to you. If the coin has not graduated by the deadline, the pot refunds holders.',
});
/** The two curve tiers, Solana's: where a coin starts and where it graduates into its Uniswap pool. */
export const ROBINHOOD_TIERS = Object.freeze([
  Object.freeze({ id: '4k', startUsd: 4000, graduationUsd: 50000, label: '$4k start', summary: 'Starts at a $4,000 market cap and graduates at $50,000: a steep curve, 78% of the supply sold on the way.' }),
  Object.freeze({ id: '20k', startUsd: 20000, graduationUsd: 50000, label: '$20k start', summary: 'Starts at a $20,000 market cap and graduates at $50,000: a gentler curve, 61% of the supply sold on the way.' }),
]);
export const ROBINHOOD_DEFAULT_TIER = '20k';
export const robinhoodTier = id => ROBINHOOD_TIERS.find(t => t.id === id) || null;
export const ROBINHOOD_LIMITS = Object.freeze({ minTaxBps: 100, maxTaxBps: 300, defaultTaxBps: 200, maxRules: 4, supply: '1000000000', decimals: 18 });
/**
 * The fee shape (v71.41), Launchpad's Raydium launches' numbers on a Uniswap v4 pool. On the curve pool: 1.25% for the
 * platform (the 1% Launchpad protocol fee plus the 0.25% a Raydium launch pays Raydium, which has no counterpart here)
 * and, for a Creator-mode coin, the flat 0.5% creator fee; a holder-reward coin (Holders, Diamond Hands) carries a
 * 1–3% holder tax in its place, 95% of it for the holders and 5% for the platform. At graduation the liquidity moves
 * into the graduation pool: 0.25% LP fee (the platform's; the whole position is locked) plus 0.25% creator fee, plus
 * the tax. Earned and Insured coins take the creator shape (their fee wallet holds the creator's share).
 */
export const ROBINHOOD_FEES = Object.freeze({ curveProtocolBps: 125, curveCreatorBps: 50, poolProtocolBps: 25, poolCreatorBps: 25, taxPlatformShareBps: 500 });
export const ROBINHOOD_TAX_MODES = Object.freeze(['holders', 'diamond_hands']);
export const robinhoodTaxed = mode => ROBINHOOD_TAX_MODES.includes(mode);
/** A launch's fee numbers from its tax (0 for the creator shape): both stages' total fees and the platform's share of each, in bps. */
export function robinhoodFeesFor(taxBps = 0) {
  const tax = Number(taxBps) || 0, f = ROBINHOOD_FEES;
  const curveTotal = f.curveProtocolBps + (tax > 0 ? tax : f.curveCreatorBps), poolTotal = f.poolProtocolBps + f.poolCreatorBps + tax;
  const platformTax = Math.floor(tax * f.taxPlatformShareBps / 10000);
  return {
    taxBps: tax, curveTotalBps: curveTotal, poolTotalBps: poolTotal,
    curvePlatformBps: f.curveProtocolBps + platformTax, curveOptionBps: curveTotal - f.curveProtocolBps - platformTax,
    poolPlatformBps: f.poolProtocolBps + platformTax, poolOptionBps: poolTotal - f.poolProtocolBps - platformTax,
    curveShareBps: Math.floor((f.curveProtocolBps + platformTax) * 10000 / curveTotal), poolShareBps: Math.floor((f.poolProtocolBps + platformTax) * 10000 / poolTotal),
  };
}
export const bpsText = bps => (Number(bps) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + '%';
export const ROBINHOOD_FEE_LINK = '/docs#revenue';
/**
 * Where else a Robinhood coin trades from its first block (v71.41: every coin is a plain Uniswap v4 pool, so the
 * trading terminals and the Uniswap app list it on their own). The pages show these next to the trade box. The
 * patterns are the platforms' own (the Uniswap app's token page and GMGN's token page both use the `robinhood`
 * chain slug; DEX Screener's chain page is /robinhood); confirm them on the first real coin.
 */
export function robinhoodTradeLinks(token) {
  const t = String(token || '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) return [];
  return [
    { id: 'uniswap', label: 'Uniswap', url: `https://app.uniswap.org/explore/tokens/robinhood/${t}` },
    { id: 'gmgn', label: 'GMGN', url: `https://gmgn.ai/robinhood/token/${t}` },
    { id: 'dexscreener', label: 'DexScreener', url: `https://dexscreener.com/robinhood/${t}` },
  ];
}
export const ROBINHOOD_STATES = Object.freeze({
  draft: 'Draft', awaiting_funding: 'Waiting for funding', funding_pending: 'Confirming funding', funded: 'Funded',
  creating: 'Creating on Robinhood Chain', created: 'Live on Robinhood Chain', failed: 'Failed', refunding: 'Refunding', refunded: 'Refunded', cancelled: 'Cancelled', expired: 'Quote expired',
});
export const ROBINHOOD_VENUE_STATES = Object.freeze({ curve: 'On the curve', graduating: 'Graduating', graduated: 'Graduated', deferred: 'Graduation waiting' });

/** Pair kinds in the order the launch page shows them. */
export const ROBINHOOD_PAIR_KINDS = Object.freeze({ native: 'ETH', stable: 'Stablecoin', stock: 'Stock', etf: 'ETF', custom: 'Launchpad-added token', other: 'Token' });

/**
 * Short, number-free disclosure lines shown before funding. `pair` is the symbol of the pair asset ('ETH' for ETH
 * coins); `creatorFeeBps` > 0 when the creator added a creator fee; `tier` is the chosen tier id.
 */
export function robinhoodDisclosure(mode, { pair = 'ETH', taxBps = 0, tier = ROBINHOOD_DEFAULT_TIER, rules = 0 } = {}) {
  const chosen = robinhoodTier(tier) || ROBINHOOD_TIERS[1], fees = robinhoodFeesFor(taxBps);
  const lines = [
    'Your coin is created by Launchpad’s own launch contracts on Robinhood Chain from a Launchpad launch wallet made only for this coin. You fund that wallet once from your connected wallet; your dev-buy tokens are delivered to the wallet you fund from.',
    pair === 'ETH' ? `Your coin is a Uniswap v4 ETH pool from its first block, so it trades on Launchpad, Uniswap, GMGN and any wallet; at about $${chosen.graduationUsd.toLocaleString('en-US')} it graduates into its ${bpsText(fees.poolTotalBps)} pool. The liquidity is locked for good at both stages.`
      : `Your coin is a Uniswap v4 ${pair} pool from its first block, so it trades on Launchpad, Uniswap, GMGN and any wallet; at about $${chosen.graduationUsd.toLocaleString('en-US')} it graduates into its ${bpsText(fees.poolTotalBps)} pool. The liquidity is locked for good at both stages. Dollar values move with ${pair}.`,
    taxBps > 0 ? `The curve pool charges ${bpsText(fees.curveTotalBps)} on every swap: ${bpsText(ROBINHOOD_FEES.curveProtocolBps)} for Launchpad and your ${bpsText(taxBps)} holder tax (95% to the holders, 5% to Launchpad); after graduation ${bpsText(fees.poolTotalBps)}. See Fees & revenue in the docs.`
      : `The curve pool charges ${bpsText(fees.curveTotalBps)} on every swap: ${bpsText(ROBINHOOD_FEES.curveProtocolBps)} for Launchpad and a ${bpsText(ROBINHOOD_FEES.curveCreatorBps)} creator fee; after graduation ${bpsText(fees.poolTotalBps)} (${bpsText(ROBINHOOD_FEES.poolProtocolBps)} for Launchpad, ${bpsText(ROBINHOOD_FEES.poolCreatorBps)} creator fee). See Fees & revenue in the docs.`,
  ];
  if (taxBps > 0) lines.push('The holder tax is written on the coin at launch and cannot change afterwards.');
  if (rules > 0) lines.push('Your transfer rules run inside the coin until graduation, enforced by Launchpad’s rule engine on every transfer; the coin is a plain token afterwards.');
  if (mode === 'creator') lines.push(`Your share of fees accrues under your funding wallet in Launchpad’s fee escrow on chain, in ${pair}. You claim it yourself from the coin page; Launchpad never holds it.`);
  else if (mode === 'earned') lines.push('Your share of fees accrues under a Launchpad escrow wallet made for this coin. Launchpad releases it to your funding wallet only if the coin passes its probation; if the coin fails, the escrow and every later fee pay holders. The settings are permanent.');
  else if (mode === 'insured') lines.push('Your share of fees accrues under a Launchpad wallet made for this coin. Launchpad keeps the coverage share as the refund pot and sends you the rest. If the coin has not graduated by the deadline, the pot pays holders and the coverage share keeps paying them. The settings are permanent.');
  else lines.push('You do not receive a creator-fee payout for this option; fees fund the option you choose, and that choice is permanent.');
  if (mode === 'holders') lines.push(`Holder rewards go to the top 100 holders by minimum balance over the last hour, paid in ${pair}, whenever the holders’ share reaches about $100.`);
  if (mode === 'diamond_hands') lines.push(`Holder rewards go to the top 100 holders by minimum balance over the last hour, paid in ${pair}, whenever the holders’ share reaches about $100, except a wallet whose balance dropped since its last payout: it is skipped and its streak starts over. A streak held through consecutive payouts raises a wallet’s share up to the cap you set.`);
  if (mode === 'earned') lines.push('Probation starts at launch. Launchpad records the coin’s market cap once a day; the first record, a day after launch, is the baseline. A record below the floor you set fails the coin. Surviving the probation period releases the escrow to you and every later fee follows it.');
  if (mode === 'insured') lines.push('Holder refunds and bonuses are paid like holder rewards: to the top 100 holders by minimum balance over the last hour. A refund is started as soon as the deadline passes.');
  if (pair !== 'ETH') lines.push(`Everything settles in ${pair} except network fees, which are ETH; your funding covers a small ETH reserve for them.`);
  return lines;
}
