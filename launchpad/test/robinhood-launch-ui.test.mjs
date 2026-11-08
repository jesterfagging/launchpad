// The Robinhood launch page pieces: the market block (pairs with search, the tier, the rewards option and its
// settings, the fee shape — the flat creator fee or the 1–3% holder tax — and the first buy with its token estimate)
// and the launch flow (connect an EVM wallet → quote → fund from the wallet → the worker's states → live). The API and
// the wallet are scripted; nothing is signed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createRobinhoodMarket, createRobinhoodLaunch, parseAmount, formatUnits, expectedTokens, robinhoodFeeLines, ROBINHOOD_TAX_CHOICES } from '../public/robinhood-launch-ui.mjs';
import { curveForTargets, tierTargetsInPair } from '../public/robinhood-curve-math.mjs';

const ETH = '0x0000000000000000000000000000000000000000', USDG = '0x00000000000000000000000000000000000000d9', NVDA = '0x000000000000000000000000000000000000ab12', CREATOR = '0xC0ffee0000000000000000000000000000000001';
const status = (extra = {}) => ({ available: true, intakeOpen: true, pairsOpen: true, launchFeeEth: '0.001', blockers: [], reason: '', ...extra });
const pairs = () => ({ available: true, pairsOpen: true, pairs: [
  { address: NVDA, symbol: 'NVDA', name: 'NVIDIA', decimals: 18, kind: 'stock', native: false, usd: '180.25', halted: false, logo: 'https://cdn.example/nvda.png' },
  { address: ETH, symbol: 'ETH', name: 'Ether', decimals: 18, kind: 'native', native: true, usd: '4000', halted: false },
  { address: USDG, symbol: 'USDG', name: 'Global Dollar', decimals: 6, kind: 'stable', native: false, usd: '1', halted: false },
  { address: '0x000000000000000000000000000000000000ab13', symbol: 'SPY', name: 'SPDR S&P 500 ETF', decimals: 18, kind: 'etf', native: false, usd: '560', halted: true },
], notice: '' });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function page() { const { document } = parseHTML('<html><body><div id="market"></div><div id="flow"></div></body></html>'); return { document, market: document.getElementById('market'), flow: document.getElementById('flow') }; }

test('amount helpers and the token estimate', () => {
  assert.equal(parseAmount('0.5', 18), 5n * 10n ** 17n); assert.equal(parseAmount('', 6), 0n); assert.equal(parseAmount('1,000.25', 6), 1000250000n);
  assert.throws(() => parseAmount('1.1234567', 6), /at most 6 decimal/); assert.throws(() => parseAmount('abc', 18), /plain number/);
  assert.equal(formatUnits(1234567890000000000000n, 18, 4), '1,234.5678'); assert.equal(formatUnits(0n, 6), '0');
  const targets = tierTargetsInPair({ startUsd: 4000, graduationUsd: 50000 }, '4000', 18), curve = curveForTargets(targets.startFdv, targets.graduationFdv);
  const { tokens, supply } = expectedTokens({ virtualQuote: curve.virtualQuote, graduationQuote: curve.graduationQuote, devBuy: 5n * 10n ** 16n });
  assert.ok(tokens > 40n * 10n ** 24n && tokens < 50n * 10n ** 24n, 'about 4.6% of the supply for 0.05 ETH on the $4k tier: ' + tokens);
  assert.ok(supply.sellSupply > 0n);
  const taxed = expectedTokens({ virtualQuote: curve.virtualQuote, graduationQuote: curve.graduationQuote, devBuy: 5n * 10n ** 16n, tradeFeeBps: 425 });
  assert.ok(taxed.tokens < tokens, 'a 3% tax coin (4.25% curve fee) buys fewer tokens than the 1.75% creator shape');
  // The fee lines (v71.41, Raydium's shape): the flat creator fee, or the holder tax in its place.
  assert.deepEqual(ROBINHOOD_TAX_CHOICES, [100, 200, 300]);
  const creator = robinhoodFeeLines('creator');
  assert.equal(creator.curve, '1.75% per swap on the curve: 1.25% Launchpad + 0.5% creator fee'); assert.equal(creator.pool, '0.5% after graduation: 0.25% Launchpad + 0.25% creator fee'); assert.match(creator.who, /accrues under your wallet/);
  assert.match(robinhoodFeeLines('earned').who, /escrow/); assert.match(robinhoodFeeLines('insured').who, /refund pot/);
  const holders = robinhoodFeeLines('holders', 200);
  assert.equal(holders.curve, '3.25% per swap on the curve: 1.25% Launchpad + 2% holder tax'); assert.equal(holders.pool, '2.5% after graduation: 0.5% pool fee + 2% holder tax'); assert.match(holders.who, /95% of it funds the holder rewards, 5% is Launchpad’s/);
  assert.equal(robinhoodFeeLines('creator', 300).curve, creator.curve, 'a tax means nothing to the creator shape');
});

test('the market block offers ETH | USDG | Custom; the picker lists every pair with prices, searches, filters, and builds the quote input', async () => {
  const { document, market } = page(), calls = [];
  const block = createRobinhoodMarket({ document, root: market, request: async path => { calls.push(path); return path === '/status' ? status() : pairs(); }, clock: () => 1000 });
  block.setActive(true); await block.refresh(); await settle();
  const picker = block.picker;
  assert.deepEqual([...market.querySelectorAll('[data-rh-pair] .rh-pair-segment-label')].map(n => n.textContent), ['ETH', 'USDG', 'Custom'], 'the Solana layout: two native segments and Custom');
  assert.equal(market.querySelector('[data-rh-pair="eth"]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual([...picker.querySelectorAll('.rh-pair strong')].map(n => n.textContent), ['ETH', 'USDG', 'NVDA', 'SPY'], 'the picker lists ETH and USDG first, then the stocks and ETFs');
  assert.equal(picker.querySelector('.rh-pair[aria-selected=true] strong').textContent, 'ETH');
  // Badges: the stock's logo in a circle, a lettermark for a pair without one (the image falls back to the lettermark on error).
  const nvdaRow = picker.querySelector('[data-pair-address="' + NVDA + '"]'), ethRow = picker.querySelector('[data-pair-address="' + ETH + '"]');
  assert.equal(nvdaRow.querySelector('.rh-pair-badge img').getAttribute('src'), 'https://cdn.example/nvda.png'); assert.equal(nvdaRow.querySelector('.rh-pair-badge .rh-pair-mark').hidden, true);
  assert.equal(ethRow.querySelector('.rh-pair-badge img'), null); assert.equal(ethRow.querySelector('.rh-pair-badge .rh-pair-mark').textContent, 'Ξ', 'ETH wears the ether glyph (v71.41)');
  nvdaRow.querySelector('.rh-pair-badge img').dispatchEvent(new document.defaultView.Event('error'));
  assert.equal(nvdaRow.querySelector('.rh-pair-badge img'), null); assert.equal(nvdaRow.querySelector('.rh-pair-badge .rh-pair-mark').hidden, false, 'the lettermark shows when the logo fails');
  assert.match(picker.querySelector('.launch-asset-count').textContent, /4 pairs available · Includes ETH and USDG/);
  assert.equal(market.querySelector('.rh-availability').hidden, true, 'an available venue says nothing above the choices (v71.42)'); assert.equal(market.querySelector('.rh-availability').textContent, '');
  assert.match(market.querySelector('.rh-tier-note').textContent, /\$20,000 market cap/);
  const input = block.input();
  assert.deepEqual(input, { tier: '20k', pairToken: 'eth', mode: 'creator', taxBps: 0, devBuy: '0', option: undefined });
  // The fee shape: a Creator coin shows the fixed lines and no tax choice.
  const feeBlock = market.querySelector('.rh-fee');
  assert.equal(feeBlock.dataset.shape, 'creator'); assert.equal(feeBlock.querySelector('h3').textContent, 'Fees'); assert.equal(feeBlock.querySelector('.rh-tax-segments').hidden, true);
  assert.deepEqual([...feeBlock.querySelectorAll('.rh-fee-lines li')].map(n => n.textContent), ['1.75% per swap on the curve: 1.25% Launchpad + 0.5% creator fee', '0.5% after graduation: 0.25% Launchpad + 0.25% creator fee']);
  assert.match(feeBlock.querySelector('.rh-fee-help').textContent, /creator fee is fixed and accrues under your wallet.*See Fees & revenue\./); assert.equal(feeBlock.querySelector('.rh-fee-help a').getAttribute('href'), '/docs#revenue');
  assert.match(market.querySelector('.rh-summary').textContent, /1\.75% on the curve, 0\.5% after/);
  // Custom opens the picker; search narrows; a category filters; picking closes it and the segment shows the pick.
  market.querySelector('[data-rh-pair="custom"]').click(); assert.ok(picker.hasAttribute('open'));
  const search = picker.querySelector('input[type=search]'); search.value = 'nvid'; search.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  assert.deepEqual([...picker.querySelectorAll('.rh-pair strong')].map(n => n.textContent), ['NVDA']);
  search.value = ''; search.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  picker.querySelector('[data-rh-category="stocks"]').click();
  assert.deepEqual([...picker.querySelectorAll('.rh-pair strong')].map(n => n.textContent), ['NVDA', 'SPY'], 'the halted ETF goes last');
  assert.equal(picker.querySelector('.rh-pair[data-pair-address="0x000000000000000000000000000000000000ab13"] .rh-pair-side').textContent.includes('Halted'), true);
  picker.querySelector('.rh-pair[data-pair-address="' + NVDA + '"]').click();
  assert.equal(block.pair.symbol, 'NVDA'); assert.equal(picker.hasAttribute('open'), false, 'picking closes the picker');
  assert.equal(market.querySelector('[data-rh-pair="custom"] .rh-pair-segment-label').textContent, 'NVDA'); assert.equal(market.querySelector('[data-rh-pair="custom"]').getAttribute('aria-pressed'), 'true'); assert.equal(market.querySelector('[data-rh-pair="eth"]').getAttribute('aria-pressed'), 'false');
  assert.match(market.querySelector('.rh-pair-note').textContent, /trades against NVDA \(\$180\.25\)/);
  assert.equal(market.querySelector('.rh-buy .launch-sol-input span').textContent, 'NVDA');
  market.querySelector('[data-rh-pair="usdg"]').click(); assert.equal(block.pair.symbol, 'USDG'); assert.equal(market.querySelector('[data-rh-pair="custom"] .rh-pair-segment-label').textContent, 'Custom');
  market.querySelector('[data-rh-pair="eth"]').click(); assert.equal(block.pair.symbol, 'ETH');
  block.setPair(NVDA);
  // Tier, rewards and a first buy with the estimate.
  market.querySelector('[data-tier="4k"]').click(); assert.equal(block.tier, '4k');
  market.querySelector('[data-mode="holders"]').click(); assert.equal(block.mode, 'holders');
  assert.deepEqual([...market.querySelectorAll('[data-mode]')].map(b => b.dataset.mode), ['creator', 'holders', 'diamond_hands', 'earned', 'insured'], 'only the options that exist on Robinhood; no Soon buttons (v71.42)');
  assert.equal(block.feeText, '3.25% on the curve · 2.5% after graduation', 'the preview card’s fee line follows the option');
  const buy = market.querySelector('#rh-dev-buy'); buy.value = '0.5'; buy.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  assert.match(market.querySelector('.rh-buy-estimate').textContent, /About [\d,]+ tokens \(\d+\.\d+% of the supply\) at today’s price, after the 3\.25% fee\./);
  // Holders: the holder tax replaces the creator fee, 2% unless chosen; the segments pick 1–3%; the estimate follows the fee.
  assert.equal(feeBlock.dataset.shape, 'tax'); assert.equal(feeBlock.querySelector('h3').textContent, 'Holder tax'); assert.equal(feeBlock.querySelector('.rh-tax-segments').hidden, false);
  assert.deepEqual([...feeBlock.querySelectorAll('[data-tax]')].map(b => [b.textContent, b.getAttribute('aria-pressed')]), [['1%', 'false'], ['2%', 'true'], ['3%', 'false']]);
  assert.deepEqual(block.input(), { tier: '4k', pairToken: NVDA, mode: 'holders', taxBps: 200, devBuy: '0.5', option: undefined });
  assert.deepEqual([...feeBlock.querySelectorAll('.rh-fee-lines li')].map(n => n.textContent), ['3.25% per swap on the curve: 1.25% Launchpad + 2% holder tax', '2.5% after graduation: 0.5% pool fee + 2% holder tax']);
  const estimateAt2 = market.querySelector('.rh-buy-estimate').textContent;
  feeBlock.querySelector('[data-tax="300"]').click();
  assert.equal(block.taxBps, 300); assert.equal(block.input().taxBps, 300); assert.equal(block.fees.curveTotalBps, 425); assert.equal(block.fees.poolTotalBps, 350);
  assert.match(market.querySelector('.rh-buy-estimate').textContent, /after the 4\.25% fee\./); assert.notEqual(market.querySelector('.rh-buy-estimate').textContent, estimateAt2, 'a higher tax buys fewer tokens');
  assert.match(market.querySelector('.rh-fee-help').textContent, /replaces the creator fee: 95% of it funds the holder rewards/);
  assert.match(market.querySelector('.rh-summary').textContent, /Holders · \$4k start → \$50,000 graduation · pair NVDA · 4\.25% on the curve, 3\.5% after · launch fee 0\.001 ETH/);
  block.setTax(250); assert.equal(block.taxBps, 300, 'only the whole-percent choices');
  block.setMode('creator'); assert.equal(block.input().taxBps, 0, 'the creator shape carries no tax'); assert.equal(feeBlock.querySelector('.rh-tax-segments').hidden, true);
  block.setMode('diamond_hands'); assert.equal(block.input().taxBps, 300, 'the chosen tax is remembered for the other holder-reward option');
  // A halted pair cannot be quoted; an option mode carries its settings.
  block.setPair('0x000000000000000000000000000000000000ab13'); assert.match(block.problem(), /halted/);
  block.setPair(ETH); block.setMode('insured');
  const coverage = market.querySelector('#rh-insured-coveragepercent'); assert.ok(coverage, 'the Insured settings render'); coverage.value = '60'; coverage.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));
  const insured = block.input(); assert.equal(insured.mode, 'insured'); assert.equal(insured.option.coveragePercent, 60); assert.equal(insured.taxBps, 0);
  assert.match(market.querySelector('[data-pump-option="insured"] .launch-pump-option-help').textContent, /60%/);
  assert.match(market.querySelector('.rh-fee-help').textContent, /refund pot/);
  assert.match(market.querySelector('.rh-summary').textContent, /Insured · \$4k start → \$50,000 graduation · pair ETH · 1\.75% on the curve, 0\.5% after · launch fee 0.001 ETH/);
  block.dispose(); assert.equal(picker.isConnected, false, 'dispose removes the picker');
});

test('the Custom check: a pasted token address is checked on the chain; an available token can be picked, an unlisted one says it was requested, a non-token says why', async () => {
  const { document, market } = page(), CB = '0x' + 'cb'.repeat(20), DUST = '0x' + 'dd'.repeat(20), GHOST = '0x' + 'ee'.repeat(20), checked = [];
  const block = createRobinhoodMarket({ document, root: market, clock: () => 1000, request: async path => {
    if (path === '/status') return status(); if (path === '/pairs') return pairs();
    const address = decodeURIComponent(path.split('address=')[1] || ''); checked.push(address);
    if (address.toLowerCase() === CB) return { address: CB, symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', decimals: 8, kind: 'custom', usd: '65000', status: 'available', available: true, reason: 'cbBTC is available as a pair.' };
    if (address.toLowerCase() === DUST) return { address: DUST, symbol: 'DUST', name: 'Dust', decimals: 18, kind: 'custom', usd: '0.01', status: 'unlisted', available: false, compatible: true, requested: true, reason: 'DUST is a valid token with a Uniswap price on Robinhood Chain, but Launchpad has not added it yet. Your request has been sent to the operator.' };
    return { address, status: 'invalid', available: false, compatible: false, reason: 'This address is not an ERC-20 token (it does not answer symbol, name, decimals and totalSupply).' };
  } });
  await block.refresh(); await settle();
  const picker = block.picker, search = picker.querySelector('input[type=search]'), type = value => { search.value = value; search.dispatchEvent(new document.defaultView.Event('input', { bubbles: true })); };
  block.openPicker();
  type(CB);
  const offer = picker.querySelector('.rh-pair-check'); assert.ok(offer, 'an unknown address offers a check'); assert.match(offer.textContent, /Check this token/);
  offer.click(); await settle(); await settle();
  assert.deepEqual(checked, [CB]);
  const row = picker.querySelector('.rh-pair[data-pair-address="' + CB + '"]'); assert.ok(row); assert.equal(row.disabled, false); assert.match(row.textContent, /cbBTC/); assert.match(row.textContent, /Available/); assert.match(row.textContent, /\$65,000/);
  row.click(); assert.equal(block.pair.symbol, 'cbBTC'); assert.equal(block.input().pairToken, CB); assert.equal(market.querySelector('[data-rh-pair="custom"] .rh-pair-segment-label').textContent, 'cbBTC');
  assert.ok(block.pairs.some(p => p.address === CB), 'a checked, available token joins the list');
  block.openPicker(); type(DUST); picker.querySelector('.rh-pair-check').click(); await settle(); await settle();
  const dust = picker.querySelector('.rh-pair[data-pair-address="' + DUST + '"]'); assert.equal(dust.disabled, true); assert.match(dust.textContent, /Compatible · requested/); assert.match(dust.textContent, /sent to the operator/);
  type(GHOST); picker.querySelector('.rh-pair-check').click(); await settle(); await settle();
  const ghost = picker.querySelector('.rh-pair[data-pair-address="' + GHOST + '"]'); assert.equal(ghost.disabled, true); assert.match(ghost.textContent, /not an ERC-20/);
  type(GHOST); assert.equal(picker.querySelectorAll('.rh-pair-check').length, 0, 'a checked address is not re-offered'); assert.equal(checked.length, 3);
  block.dispose();
});

test('the market block reports a closed venue and a pair list that could not be loaded', async () => {
  const { document, market } = page();
  const closed = createRobinhoodMarket({ document, root: market, request: async path => path === '/status' ? status({ intakeOpen: false, reason: 'Launches are closed on the factory.' }) : pairs() });
  await closed.refresh(); assert.equal(closed.allowed(), false); assert.match(closed.problem(), /closed on the factory/); assert.match(market.querySelector('.rh-availability').textContent, /closed/); assert.equal(market.querySelector('.rh-availability').hidden, false, 'a closed venue is said on the form');
  closed.dispose();
  const broken = createRobinhoodMarket({ document, root: market, request: async () => { throw Error('offline https://rpc.example'); } });
  await broken.refresh(); assert.match(broken.problem(), /offline \[link\]/); assert.equal(broken.picker.querySelector('.rh-pair-results p').textContent.includes('offline'), true);
  assert.equal(market.querySelector('[data-rh-pair="eth"]').disabled, true, 'no list, no ETH segment');
  broken.dispose();
});

/** A scripted wallet in the shape of public/evm-wallet.mjs. */
function fakeWallet({ address = '' } = {}) {
  let state = { address, chainId: address ? 4663 : null, wallet: address ? 'MetaMask' : '', connecting: false, error: '' }; const listeners = new Set(), sent = [];
  return { sent, state: () => state, onChange(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); }, get connected() { return !!state.address; }, get onChain() { return state.chainId === 4663; },
    async connect() { state = { ...state, address: CREATOR, chainId: 4663, wallet: 'MetaMask' }; for (const fn of listeners) fn(state); return state; }, async ensureChain() { return true; },
    async sendTransaction(tx) { sent.push(tx); return '0x' + (sent.length + 'a').padStart(64, '0').slice(-64).replace(/[^0-9a-f]/g, '0'); } };
}
const launchView = (patch = {}) => ({ id: 'a1b2c3d4e5f60718293a4b5c', venue: 'robinhood', state: 'awaiting_funding', stateLabel: 'Waiting for funding', reason: '', mode: 'holders', modeLabel: 'Holders', name: 'Anvil Coin', symbol: 'ANV', token: null, predictedToken: '0x00000000000000000000000000000000000000aa', coinUrl: null,
  explorer: { token: null, curve: null, funding: null, create: null, refund: null }, dimensions: {}, hashes: {}, devTokens: '0', refundedEth: '0', pair: { address: ETH, symbol: 'ETH', decimals: 18, kind: 'native' }, tier: { id: '4k', label: '$4k start', startUsd: 4000, graduationUsd: 50000 },
  taxBps: 200, fees: { taxBps: 200, curveTotalBps: 325, poolTotalBps: 250, curvePlatformBps: 135, curveOptionBps: 190, poolPlatformBps: 35, poolOptionBps: 215, curveShareBps: 4153, poolShareBps: 1400, stage: 'curve', curveFeePips: 32500, poolFeePips: 25000, creatorShape: false, curvePoolId: null },
  rules: 1, disclosure: ['Your coin is created by Launchpad’s own launch contracts on Robinhood Chain.', 'A trading fee applies on the curve. See Fees & revenue in the docs.'], feeLink: '/docs#revenue', option: null,
  developerWallet: CREATOR, canCancel: true, canFund: true, quote: { tier: '4k', launchFeeEth: '0.001', devBuy: '0.05', devBuySymbol: 'ETH', gasBudgetEth: '0.0014', feeWalletGasEth: '0.001', totalEth: '0.0534', totalWei: '53400000000000000', expectedTokens: '46000000', expiresAt: 10 * 60 * 1000 + 1000 },
  fundingTransactions: [{ purpose: 'eth', to: '0x00000000000000000000000000000000000000bb', value: '0xbdbc41e0348b00', data: '0x63757276652d72683a', label: '0.0534 ETH to the launch wallet' }], ...patch });

test('the flow: connect first, quote, fund through the wallet, submit the hash, follow the worker to live', async () => {
  const { document, flow } = page(), calls = [], wallet = fakeWallet(); let clock = 1000, launch = null, polls = 0;
  const timers = []; const setTimer = (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer = () => {};
  const request = async (path, options = {}) => {
    calls.push({ path, body: options.body });
    if (path === '/launches') return { launches: [] };
    if (path === '/quote') { launch = launchView(); return launch; }
    if (path === '/fund/prepare') return { launchId: launch.id, transactions: launch.fundingTransactions };
    if (path === '/fund/submit') { launch = { ...launch, state: 'funding_pending', stateLabel: 'Confirming funding', canFund: false, canCancel: false, fundingTransactions: [], disclosure: [] }; return launch; }
    if (path.startsWith('/launch?')) { polls++; if (polls >= 2) launch = { ...launch, state: 'created', stateLabel: 'Live on Robinhood Chain', token: launch.predictedToken, coinUrl: '/coin?mint=' + launch.predictedToken + '&chain=robinhood', devTokens: '45999000', explorer: { ...launch.explorer, token: 'https://robinhoodchain.blockscout.com/address/' + launch.predictedToken, create: 'https://robinhoodchain.blockscout.com/tx/0x01' } }; return launch; }
    if (path === '/cancel') { launch = { ...launch, state: 'cancelled', stateLabel: 'Cancelled', canFund: false, canCancel: false, disclosure: [] }; return launch; }
    throw Error('unexpected ' + path);
  };
  const live = [], inputs = [];
  const ui = createRobinhoodLaunch({ document, window: document.defaultView, root: flow, request, wallet, getInput: ({ wallet: address }) => { inputs.push(address); return { name: 'Anvil Coin', symbol: 'ANV', image: '/token-images/' + 'a'.repeat(64) + '.png', tier: '4k', pairToken: 'eth', mode: 'holders', taxBps: 200, devBuy: '0.05', hooks: { rules: [{ id: 'max_per_wallet', settings: { maxPct: 40 } }] } }; }, onLive: l => live.push(l.id), clock: () => clock, setTimer, clearTimer });
  await ui.start();
  const buttons = () => [...flow.querySelectorAll('button')].filter(b => !b.hidden && !b.closest('[hidden]')).map(b => b.textContent);
  assert.deepEqual(buttons(), ['Connect EVM wallet'], 'the wallet comes before the quote');
  assert.match(flow.querySelector('.rh-wallet-line').textContent, /Connect the EVM wallet/);
  const click = text => { const b = [...flow.querySelectorAll('button')].find(b => b.textContent === text && !b.hidden); if (!b) throw Error('no visible button ' + text); b.click(); };
  click('Connect EVM wallet'); await settle(); await settle();
  assert.deepEqual(buttons(), ['Review launch']); assert.match(flow.querySelector('.rh-wallet-line').textContent, /0xC0ff…0001 \(MetaMask\) · Robinhood Chain/);
  click('Review launch'); await settle(); await settle();
  assert.deepEqual(inputs, [CREATOR]); assert.equal(calls[1].path, '/quote'); assert.equal(calls[1].body.wallet, CREATOR); assert.equal(calls[1].body.taxBps, 200); assert.match(calls[1].body.requestKey, /^rh-[0-9a-f]{32}$/);
  const facts = () => Object.fromEntries([...flow.querySelectorAll('.pump-classic-facts div')].map(d => [d.querySelector('dt').textContent, d.querySelector('dd').textContent]));
  assert.equal(facts().Coin, 'Anvil Coin · $ANV'); assert.equal(facts().Pair, 'ETH'); assert.equal(facts().Start, '$4k start → $50,000 graduation'); assert.equal(facts()['Transfer rules'], '1');
  assert.equal(facts()['Holder tax'], '2% · 95% to the holders, 5% to Launchpad'); assert.equal(facts()['Trading fee'], '3.25% on the curve · 2.5% after graduation'); assert.equal(facts()['Creator fee'], undefined, 'a holder-reward coin has no creator fee');
  assert.equal(facts()['First buy'], '0.05 ETH'); assert.equal(facts()['Tokens you receive'], '~46,000,000'); assert.equal(facts()['Total from your wallet'], '0.0534 ETH'); assert.equal(facts()['Quote valid for'], '10:00');
  assert.equal(flow.querySelectorAll('.pump-classic-disclosure li').length, 2); assert.equal(flow.querySelector('.pump-classic-disclosure a').getAttribute('href'), '/docs#revenue');
  assert.deepEqual(buttons(), ['Fund and launch', 'Cancel this quote']);
  assert.equal(ui.locked, true, 'a quoted launch holds the page');
  click('Fund and launch'); await settle(); await settle(); await settle();
  assert.equal(wallet.sent.length, 1); assert.deepEqual(wallet.sent[0], { to: '0x00000000000000000000000000000000000000bb', value: '0xbdbc41e0348b00', data: '0x63757276652d72683a' });
  const submit = calls.find(c => c.path === '/fund/submit'); assert.equal(submit.body.launchId, launch.id); assert.equal(submit.body.txHashes.length, 1);
  assert.equal(facts().Status, 'Confirming funding'); assert.match(flow.querySelector('.pump-classic-status').textContent, /Funding sent/);
  assert.deepEqual(buttons(), [], 'nothing to click while the worker runs');
  // The poll follows the worker: two ticks later the coin is live.
  for (let i = 0; i < 4 && !live.length; i++) { const t = timers.shift(); if (t) await t.fn(); await settle(); }
  assert.deepEqual(live, [launch.id]); assert.equal(facts().Status, 'Live on Robinhood Chain'); assert.equal(facts()['Tokens you receive'], '45,999,000');
  const coin = flow.querySelector('a.primary'); assert.equal(coin.hidden, false); assert.equal(coin.getAttribute('href'), '/coin?mint=' + launch.predictedToken + '&chain=robinhood');
  assert.ok([...flow.querySelectorAll('.pump-classic-links a')].some(a => a.textContent === 'Creation transaction ↗'));
  assert.equal(ui.locked, false);
  ui.dispose();
});

test('the flow resumes a pending launch, cancels a quote, and a wallet other than the quoted one cannot fund', async () => {
  const { document, flow } = page(), wallet = fakeWallet({ address: '0x9999999999999999999999999999999999999999' }); let launch = launchView();
  const request = async (path, options = {}) => { if (path === '/launches') return { launches: [launch] }; if (path.startsWith('/launch?')) return launch; if (path === '/cancel') { launch = { ...launch, state: 'cancelled', stateLabel: 'Cancelled', canFund: false, canCancel: false, disclosure: [] }; return launch; } throw Error('unexpected ' + path); };
  const ui = createRobinhoodLaunch({ document, window: document.defaultView, root: flow, request, wallet, getInput: () => ({}), clock: () => 1000, setTimer: () => 1, clearTimer: () => {} });
  await ui.start();
  const resume = flow.querySelector('.rh-resume button'); assert.match(resume.textContent, /Anvil Coin · \$ANV · Waiting for funding/);
  resume.click(); await settle(); await settle();
  assert.equal(ui.launch.id, launch.id);
  const visible = () => [...flow.querySelectorAll('button')].filter(b => !b.hidden).map(b => b.textContent);
  assert.deepEqual(visible(), ['Cancel this quote'], 'the connected wallet is not the quoted one: no funding button');
  assert.match(flow.querySelector('.rh-wallet-line').textContent, /this quote was made for 0xC0ff…0001/);
  [...flow.querySelectorAll('button')].find(b => b.textContent === 'Cancel this quote').click(); await settle(); await settle();
  assert.equal(launch.state, 'cancelled'); assert.equal(ui.launch, null, 'after the cancel the flow starts over');
  ui.dispose();
});
