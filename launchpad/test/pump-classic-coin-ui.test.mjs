// The Pump.fun coin panel shows distributed creator fees in the coin's pair
// asset (SOL, or the Pump.fun pair it launched on), the creator-chosen creator
// fee on custom pairs, what Launchpad converted to SOL (Gotchi) or paid to holders
// in the pair asset (Holders, v71.24), never a platform share or Launchpad's
// internal activity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createPumpClassicPanel } from '../public/pump-classic-coin.mjs';

const MINT = '9J7iw6jVxqPoiBMXWsWRNAsgFT9qkkkVHyAS26euwoBq', W = c => c.repeat(44), USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const coin = (extra = {}) => ({ mint: MINT, name: 'Orbit', symbol: 'ORBIT', mode: 'creator', modeLabel: 'Creator', venue: 'curve', pumpUrl: 'https://pump.fun/coin/' + MINT, liveAt: 1790668800000, developerWallet: W('D'), feeState: 'verified', feeLink: '/docs#revenue',
  pair: { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9, kind: 'sol' }, creatorFeeBps: 0,
  recipients: [{ role: 'platform', label: 'Launchpad platform share', address: W('P') }, { role: 'developer', label: 'Creator wallet', address: W('D') }],
  fees: { symbol: 'SOL', distributed: '1.5', platform: '0.15', recipient: '1.35', convertedSol: null, distributedSol: '1.5', platformSol: '0.15', recipientSol: '1.35' }, strategy: null, rewards: null, events: [], ...extra });
async function panel(data) {
  const { document } = parseHTML('<html><body><section id="host"></section></body></html>'), root = document.getElementById('host');
  const p = createPumpClassicPanel({ document, root, api: async () => data, mint: MINT, clock: () => 1 });
  await p.refresh(true); return { root, text: () => root.textContent, p };
}

test('a SOL coin shows its fees in SOL and no creator-fee choice', async () => {
  const { text } = await panel(coin());
  assert.match(text(), /Paired withSOL/); assert.match(text(), /Creator fees distributed1\.5 SOL/); assert.match(text(), /Paid to the creator wallet1\.35 SOL/);
  assert.doesNotMatch(text(), /Creator fee\d|converted to SOL/i); assert.doesNotMatch(text(), /\d\s*%/);
});

test('a coin on another pair shows its pair, fees in that pair, the chosen creator fee and the SOL Launchpad converted', async () => {
  const { text } = await panel(coin({ mode: 'gotchi', modeLabel: 'Gotchi', pair: { mint: USDC, symbol: 'USDC', decimals: 6, kind: 'listed' }, creatorFeeBps: 0, recipients: [{ role: 'platform', label: 'Launchpad platform share', address: W('P') }, { role: 'gotchi', label: 'Gotchi pot relay', address: W('G') }], fees: { symbol: 'USDC', distributed: '250', platform: '25', recipient: '225', convertedSol: '1.2' } }));
  assert.match(text(), /Paired withUSDC/); assert.match(text(), /Creator fees distributed250 USDC/); assert.match(text(), /Paid to the Gotchi pot225 USDC/); assert.match(text(), /Converted to SOL by Launchpad1\.2 SOL/);
  assert.match(text(), /Creator fees are paid in USDC\. Launchpad converts the shares it holds to SOL before paying them out\./);
  const custom = await panel(coin({ pair: { mint: W('X'), symbol: 'EXMx', decimals: 8, kind: 'custom' }, creatorFeeBps: 250, fees: { symbol: 'EXMx', distributed: '10', platform: '1', recipient: '9', convertedSol: '0' } }));
  assert.match(custom.text(), /Creator fee2\.5% · chosen at launch/); assert.match(custom.text(), /the creator’s share is paid in EXMx directly/);
  const hostile = await panel(coin({ pair: { mint: W('X'), symbol: '<img src=x>', decimals: 8, kind: 'custom' }, fees: { symbol: '<b>x</b>', distributed: 'NaN', recipient: '9' } }));
  assert.equal(hostile.root.querySelector('img'), null); assert.match(hostile.text(), /Paired withSOL/, 'an unexpected symbol is never rendered'); assert.match(hostile.text(), /Creator fees distributed—/);
});

test('holder rewards on another pair are shown in that asset; Launchpad’s internal activity is never shown', async () => {
  const data = coin({ mode: 'holders', modeLabel: 'Holders', pair: { mint: W('A'), symbol: 'AMD', decimals: 6, kind: 'custom' }, recipients: [{ role: 'platform', label: 'Launchpad platform share', address: W('P') }, { role: 'rewards', label: 'Holder rewards wallet', address: W('R') }],
    fees: { symbol: 'AMD', distributed: '3', platform: '0.3', recipient: '2.7', convertedSol: null, paidToHolders: '2.65', paidToHoldersSymbol: 'AMD' },
    holderRewards: { asset: 'AMD', thresholdUsd: 100, topHolders: 100 }, rewards: [{ state: 'complete', asset: 'AMD', amount: '2.65', paid: '2.65', recipients: 41, at: 1790668800000 }, { state: 'paying', asset: 'AMD', amount: '1.2', paid: '0.4', recipients: 12, at: 1790665200000 }],
    events: [{ kind: 'refund', title: 'Funding refunded', body: 'Internal', at: 1 }, { kind: 'alert', title: 'Token account closed', body: 'Internal', at: 2 }] });
  const { text, root } = await panel(data);
  assert.match(text(), /Paid to holder rewards2\.7 AMD/); assert.match(text(), /Paid out to holders2\.65 AMD/); assert.doesNotMatch(text(), /Converted to SOL/);
  assert.match(text(), /Launchpad pays holder rewards in AMD\. It sells only a small part for holders’ new AMD accounts and network fees\./);
  assert.match(text(), /Paid in AMD to the top 100 holders by minimum balance over the last hour, whenever the holders’ share reaches \$100\./);
  assert.match(text(), /2\.65 AMD of 2\.65 AMD · 41 holders · paid/); assert.match(text(), /0\.4 AMD of 1\.2 AMD · 12 holders · paying/);
  assert.doesNotMatch(text(), /Activity|Funding refunded|Token account closed/, 'internal activity stays private'); assert.equal(root.querySelector('.pc-events'), null);
  const sol = await panel(coin({ mode: 'holders', modeLabel: 'Holders', fees: { symbol: 'SOL', distributed: '1', platform: '0.1', recipient: '0.9', paidToHolders: '0.85' }, holderRewards: { asset: 'SOL', thresholdUsd: 100, topHolders: 100 }, rewards: [{ state: 'complete', asset: 'SOL', amount: '0.85', paid: '0.85', amountSol: '0.85', paidSol: '0.85', recipients: 6, at: 1 }] }));
  assert.match(sol.text(), /Paid in SOL to the top 100 holders/); assert.match(sol.text(), /0\.85 SOL of 0\.85 SOL · 6 holders · paid/); assert.doesNotMatch(sol.text(), /sells only a small part/);
});

test('Diamond Hands, Earned and Insured coins show their rules, their lifecycle and their money without any secret or share percentage (v71.35)', async () => {
  const diamond = await panel(coin({ mode: 'diamond_hands', modeLabel: 'Diamond Hands', recipients: [{ role: 'platform', label: 'Launchpad platform share', address: W('P') }, { role: 'rewards', label: 'Holder rewards wallet', address: W('R') }], fees: { symbol: 'SOL', distributed: '2', platform: '0.2', recipient: '1.8', paidToHolders: '1.7', paidToHoldersSymbol: 'SOL', distributedSol: '2', platformSol: '0.2', recipientSol: '1.8' },
    rewards: [{ state: 'complete', asset: 'SOL', amount: '0.9', paid: '0.9', amountSol: '0.9', paidSol: '0.9', recipients: 2, at: 1790700000000 }], holderRewards: { asset: 'SOL', thresholdUsd: 100, topHolders: 100 },
    option: { kind: 'diamond_hands', label: 'Diamond Hands', phase: 'active', phaseLabel: 'Active', settings: { streakBonusPercent: 10, maxBonusPercent: 100 }, description: 'Payouts skip any wallet that sold since its last payout. Each consecutive payout a wallet holds through adds 10% to its share, up to 100% (reached at a streak of 11).', capStreak: 11, payouts: 2, lastPayout: { at: 1790700000000, paid: 2, skipped: 1 }, holding: 2, streaks: [{ owner: W('A'), streak: 2, multiplierBps: 11000 }, { owner: W('C'), streak: 2, multiplierBps: 11000 }] } }));
  assert.match(diamond.text(), /Diamond Hands.*Active/s); assert.match(diamond.text(), /Payouts so far2/); assert.match(diamond.text(), /Wallets on a streak2/); assert.match(diamond.text(), /2 paid · 1 skipped for selling/); assert.match(diamond.text(), /Full bonus from streak11/);
  assert.match(diamond.text(), /Longest streaks/); assert.match(diamond.text(), /streak 2 · 110% share weight/); assert.match(diamond.text(), /a wallet that sold since its last payout is skipped/); assert.match(diamond.text(), /Paid out to holders1\.7 SOL/);
  assert.equal(diamond.root.querySelector('.pc-option').dataset.phase, 'active');
  const earned = await panel(coin({ mode: 'earned', modeLabel: 'Earned', recipients: [{ role: 'platform', label: 'Launchpad platform share', address: W('P') }, { role: 'escrow', label: 'Creator escrow wallet', address: W('E') }], fees: { symbol: 'SOL', distributed: '2', platform: '0.2', recipient: '1.8', distributedSol: '2', platformSol: '0.2', recipientSol: '1.8' }, rewards: null, holderRewards: null,
    option: { kind: 'earned', label: 'Earned', phase: 'probation', phaseLabel: 'In probation', settings: { probationDays: 30, floorPercent: 50 }, description: 'Creator fees stay in escrow for 30 days from launch.', baselineSol: '27.95', floorSol: '13.975', latestSol: '31.2', latestAt: 1790755200000, probationEndsAt: 1793260800000, daysLeft: 29, nextCheckAt: 1790841600000, checks: [{ at: 1790755200000, marketCapSol: '27.95', ok: true }], escrowSol: '1.8', releasedSol: '0', paidToHoldersSol: '0', decidedAt: null } }));
  assert.match(earned.text(), /Earned.*In probation/s); assert.match(earned.text(), /Escrow waiting1\.8 SOL/); assert.match(earned.text(), /Baseline market cap27\.95 SOL/); assert.match(earned.text(), /Floor13\.975 SOL/); assert.match(earned.text(), /29 days left/); assert.match(earned.text(), /Daily records/); assert.match(earned.text(), /27\.95 SOL · above the floor/); assert.match(earned.text(), /Paid into the creator escrow1\.8 SOL/);
  const insured = await panel(coin({ mode: 'insured', modeLabel: 'Insured', recipients: [{ role: 'platform', label: 'Launchpad platform share', address: W('P') }, { role: 'insured', label: 'Creator share and refund pot wallet', address: W('I') }], fees: { symbol: 'SOL', distributed: '1', platform: '0.1', recipient: '0.9', distributedSol: '1', platformSol: '0.1', recipientSol: '0.9' }, rewards: [], holderRewards: { asset: 'SOL', thresholdUsd: 100, topHolders: 100 },
    option: { kind: 'insured', label: 'Insured', phase: 'holders', phaseLabel: 'Deadline missed · the pot pays holders', settings: { coveragePercent: 40, deadlineDays: 7, onGraduation: 0 }, description: '40% of the creator’s fee share is kept as a refund pot.', target: 'developer', deadlineAt: 1791273600000, daysLeft: 0, graduated: false, potSol: '0.0025', potCreditedSol: '0.36', potPaidSol: '0.3575', potReleasedSol: '0', creatorPaidSol: '0.54', developerDueSol: '0', decidedAt: 1791273600000 } }));
  assert.match(insured.text(), /Insured.*Deadline missed · the pot pays holders/s); assert.match(insured.text(), /Refund pot0\.0025 SOL/); assert.match(insured.text(), /Coverage40% of the creator’s fee share/); assert.match(insured.text(), /The pot is released to the creator/); assert.match(insured.text(), /Paid to holders from the pot0\.3575 SOL/); assert.match(insured.text(), /Creator share paid0\.54 SOL/); assert.match(insured.text(), /Refund pot paid to holders/);
  for (const { text } of [diamond, earned, insured]) { assert.doesNotMatch(text(), /secret|platformShareBps/); assert.doesNotMatch(text(), /\b(10|20)\s*%\s*(platform|share of creator)/i); }
});

test('a reward-basket coin (v71.35) names every asset holders are paid in, each extra asset’s paid and waiting amounts, the round in progress and the asset of every cycle', async () => {
  const data = coin({ mode: 'holders', modeLabel: 'Holders', recipients: [{ role: 'platform', label: 'Launchpad platform share', address: W('P') }, { role: 'rewards', label: 'Holder rewards wallet', address: W('R') }],
    fees: { symbol: 'SOL', distributed: '3', platform: '0.3', recipient: '2.7', paidToHolders: '0.9', paidToHoldersSymbol: 'SOL', distributedSol: '3', platformSol: '0.3', recipientSol: '2.7' },
    holderRewards: { asset: 'SOL', thresholdUsd: 100, topHolders: 100 },
    basket: { version: 1, shares: 'equal', count: 3, description: 'SOL, TSLAx and NVDAx', stage: 'pay', assets: [{ mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9 }, { mint: W('T'), symbol: 'TSLAx', decimals: 8, pending: '0', distributed: '1798.33', payments: 1 }, { mint: W('N'), symbol: 'NVDAx', decimals: 8, pending: '44.95', distributed: '0', payments: 0 }] },
    rewards: [{ state: 'frozen', asset: 'NVDAx', amount: '44.95', paid: '0', recipients: 3, at: 1790668900000, basketAsset: true, mint: W('N') }, { state: 'complete', asset: 'TSLAx', amount: '1798.33', paid: '1798.33', recipients: 3, at: 1790668800000, basketAsset: true, mint: W('T') }] });
  const { text, root } = await panel(data);
  assert.match(text(), /Paid in SOL, TSLAx and NVDAx \(equal shares; the extra shares are bought at market from the rewards wallet each round\) to the top 100 holders by minimum balance over the last hour, whenever the holders’ share reaches \$100\./);
  assert.match(text(), /TSLAx1798\.33 TSLAx paid out · 0 TSLAx waiting · 1 round/); assert.match(text(), /NVDAx0 NVDAx paid out · 44\.95 NVDAx waiting/);
  assert.match(text(), /A reward round is in progress: paying holders asset by asset\./);
  assert.match(text(), /0 NVDAx of 44\.95 NVDAx · 3 holders · scheduled/); assert.match(text(), /1798\.33 TSLAx of 1798\.33 TSLAx · 3 holders · paid/);
  assert.ok(root.querySelector('.pc-basket'), 'the basket table'); assert.doesNotMatch(root.querySelector('.pc-basket').textContent, /[A-Za-z0-9]{44}/, 'the basket shows tickers, never mints');
  // Without a basket nothing of this appears.
  const plain = await panel(coin({ mode: 'holders', modeLabel: 'Holders', holderRewards: { asset: 'SOL', thresholdUsd: 100, topHolders: 100 }, rewards: [], basket: null }));
  assert.match(plain.text(), /Paid in SOL to the top 100 holders/); assert.equal(plain.root.querySelector('.pc-basket'), null); assert.doesNotMatch(plain.text(), /reward round/);
});
