// The Robinhood coin page's trade box (v71.41, pool-native): trades go through Launchpad's swap router into the coin's
// Uniswap v4 pool. A sell approves the router on the coin's token when the allowance is short and waits for that
// approval to confirm before the sell goes out; a sell with an allowance is one transaction; an ERC-20 pair's buy waits
// for its approval the same way; an ETH buy carries the value; the 25% / 50% / MAX presets write exact amounts. The
// wallet is a scripted EIP-1193 provider: nothing is signed, nothing leaves the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import { createRobinhoodCoinPage, SELECTORS } from '../public/robinhood-coin.mjs';
import { createEvmWallet } from '../public/evm-wallet.mjs';
import { planPositions, quoteSwap } from '../public/robinhood-pool-math.mjs';
import { plannedSupply } from '../public/robinhood-curve-math.mjs';

const ME = '0x1111111111111111111111111111111111111111', TOKEN = '0x5321d3645F2EC860a9986b9906885C054C61b50D', ROUTER = '0x554Eb5B747eA085b8915262B65060bDdEc6Fd070', USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', ESCROW = '0x28e91A4313F80e45933c03c5C22f836157D4eaCE';
const POOL_ID = '0x' + '7a'.repeat(32), LOCKER = '0x8f351b33E7001c84117C68f569e00Ac28f76A905';
const ETH = '0x0000000000000000000000000000000000000000';
const hex = v => '0x' + v.toString(16).padStart(64, '0');
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await settle(); };

/** The server's fee view (service.feeView) of a creator-shape coin and of a 2% holder-tax coin (v71.41). */
const CREATOR_FEES = { taxBps: 0, curveTotalBps: 175, poolTotalBps: 50, curvePlatformBps: 125, curveOptionBps: 50, poolPlatformBps: 25, poolOptionBps: 25, curveShareBps: 7142, poolShareBps: 5000, stage: 'curve', curveFeePips: 17500, poolFeePips: 5000, creatorShape: true, curvePoolId: null };
const HOLDER_FEES = { taxBps: 200, curveTotalBps: 325, poolTotalBps: 250, curvePlatformBps: 135, curveOptionBps: 190, poolPlatformBps: 35, poolOptionBps: 215, curveShareBps: 4153, poolShareBps: 1400, stage: 'curve', curveFeePips: 32500, poolFeePips: 25000, creatorShape: false, curvePoolId: null };
function coin({ pair = 'eth' } = {}) {
  const native = pair === 'eth';
  return {
    token: TOKEN, routerAddress: ROUTER, poolId: POOL_ID, name: 'Test coin', symbol: 'TEST', description: '', image: '', venueState: 'live', mode: 'creator', modeLabel: 'Creator', taxBps: 0, feeShape: CREATOR_FEES, liveAt: 1700000000000, holders: 3, trades: [], rules: [],
    pair: native ? { address: ETH, symbol: 'ETH', decimals: 18, usd: '2700' } : { address: USDG, symbol: 'USDG', decimals: 6, usd: '1' },
    curve: { virtualQuote: native ? '1000000000000000000' : '1000000000', virtualToken: '1073000000000000000000000000', realQuote: native ? '200000000000000000' : '200000000', sold: '150000000000000000000000000', sellSupply: '800000000000000000000000000', graduationQuote: native ? '12000000000000000000' : '12000000000', tradeFeeBps: 175, creatorTaxBps: 0, graduated: false, at: 1700000000000 },
    tier: { label: '$4k start', graduationUsd: 50000 }, totalSupply: '1000000000000000000000000000', contracts: { escrow: ESCROW, locker: LOCKER, router: ROUTER, poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951' }, recipients: { creatorClaims: false, platformShareBps: 7142 }, explorerBase: 'https://robinhoodchain.blockscout.com',
    tradeLinks: [{ id: 'uniswap', label: 'Uniswap', url: 'https://app.uniswap.org/explore/tokens/robinhood/' + TOKEN }, { id: 'gmgn', label: 'GMGN', url: 'https://gmgn.ai/robinhood/token/' + TOKEN }], priceHistory: [],
  };
}

/** A scripted wallet provider: balances and allowances answer from `chain`, sent transactions are recorded and mined when the test says so. */
function provider(chain) {
  const sent = [], receipts = new Map(), allowanceReads = [];
  const p = {
    sent, receipts, allowanceReads,
    mine(hash, status = '0x1') { receipts.set(hash, { blockNumber: '0x10', status, transactionHash: hash }); },
    async request({ method, params }) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [ME];
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'wallet_switchEthereumChain') return null;
      if (method === 'eth_getBalance') return hex(chain.eth);
      if (method === 'eth_call') {
        const { to, data } = params[0], selector = data.slice(0, 10), target = to.toLowerCase();
        if (selector === SELECTORS.balanceOf) return hex(target === TOKEN.toLowerCase() ? chain.token : target === ESCROW.toLowerCase() ? (chain.owed ?? 0n) : chain.pair);
        if (selector === SELECTORS.allowance) { allowanceReads.push({ token: target, owner: '0x' + data.slice(34, 74), spender: '0x' + data.slice(98, 138) }); return hex(target === TOKEN.toLowerCase() ? chain.tokenAllowance : chain.pairAllowance); }
        return hex(0n);
      }
      if (method === 'eth_sendTransaction') { const tx = params[0], hash = '0x' + (sent.length + 1).toString(16).padStart(64, '0'); sent.push({ ...tx, hash, minedBefore: [...receipts.keys()] }); if (tx.data.startsWith(SELECTORS.approve)) { const onApprove = chain.onApprove; if (onApprove) onApprove(tx, hash); } return hash; }
      if (method === 'eth_getTransactionReceipt') return receipts.get(params[0]) || null;
      throw Error('unexpected ' + method);
    },
    on() {}, removeListener() {},
  };
  return p;
}

/** The pool block of a fresh ETH launch on the fixture's curve numbers (the coin is currency1 against ETH). */
function poolBlock() {
  const vq = 10n ** 18n, r = 12n * 10n ** 18n, supply = plannedSupply(10n ** 27n, vq, r);
  const plan = planPositions({ tokenIs0: false, virtualQuote: vq, graduationQuote: r, sellSupply: supply.sellSupply, lpSupply: supply.lpSupply, virtualToken: supply.virtualToken, tickSpacing: 10 });
  const curve = { ...plan.curve, liquidity: String(plan.curve.liquidity) }, upper = { ...plan.upper, liquidity: String(plan.upper.liquidity) };
  return { id: POOL_ID, curvePoolId: POOL_ID, sqrtPriceX96: String(plan.sqrtPriceX96), tick: plan.tick, liquidity: '0', tokenIs0: false, startTick: plan.startTick, graduationTick: plan.graduationTick, curve, upper, positions: [curve, upper], fee: 17500, tickSpacing: 10, crossed: false, graduated: false, at: 1700000000000 };
}

async function mount({ pair = 'eth', chain, pool = null, patch = {} }) {
  const html = await readFile(new URL('../public/coin.html', import.meta.url), 'utf8');
  const { document, window } = parseHTML(html);
  const prov = provider(chain);
  // The wallet module discovers providers through EIP-6963 announcements on the page's window; its receipt poll is
  // shortened to a few milliseconds here. The page keeps real timers (its refresh never fires within a test).
  const walletWindow = { Event: window.Event, addEventListener: (...a) => window.addEventListener(...a), dispatchEvent: e => window.dispatchEvent(e), localStorage: null, setTimeout: (fn, ms) => window.setTimeout(fn, Math.min(ms, 5)), clearTimeout: id => window.clearTimeout(id) };
  const wallet = createEvmWallet({ window: walletWindow, clock: Date.now });
  window.dispatchEvent(new window.CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'test-wallet', name: 'TestWallet', icon: 'data:image/svg+xml,', rdns: 'test.wallet' }, provider: prov } }));
  const data = { ...coin({ pair }), ...(pool ? { pool } : {}), ...patch };
  const page = createRobinhoodCoinPage({ document, window, request: async () => data, walletFactory: async () => wallet, token: TOKEN });
  await flush();
  const trade = document.querySelector('#coin-trade');
  trade.querySelector('[data-rh-connect]').click(); await flush(10);
  return { document, window, page, trade, prov, data, wallet };
}

/** The amount argument of a router call: buy(token, quoteIn, …) / sell(token, tokensIn, …) — the second word. */
const amountOf = tx => BigInt('0x' + tx.data.slice(74, 138));
const tokenOf = tx => '0x' + tx.data.slice(34, 74);
const recipientOf = tx => '0x' + tx.data.slice(10 + 64 * 3 + 24, 10 + 64 * 4);

test('a sell with no allowance approves the curve on the coin, waits for the approval, then sends the sell', async () => {
  const chain = { eth: 10n ** 18n, pair: 0n, token: 5n * 10n ** 24n, tokenAllowance: 0n, pairAllowance: 0n };
  const { trade, prov, page } = await mount({ chain });
  assert.match(trade.querySelector('[data-rh-wallet]').textContent, /0x1111…1111/, 'connected');
  trade.querySelector('[data-rh-side="sell"]').click(); await flush();
  assert.match(trade.querySelector('[data-rh-balance]').textContent, /Balance 5,000,000 TEST/);
  trade.querySelector('[data-rh-amount]').value = '1000000'; trade.querySelector('[data-rh-amount]').dispatchEvent(new trade.ownerDocument.defaultView.Event('input')); await flush();
  assert.match(trade.querySelector('[data-rh-quote]').textContent, /About .* ETH · pool fee/);
  // The approval is mined a moment after it is sent; the allowance then reads as unlimited.
  chain.onApprove = (tx, hash) => { assert.equal(tx.to.toLowerCase(), TOKEN.toLowerCase(), 'the approval is on the coin'); setTimeout(() => { chain.tokenAllowance = (1n << 256n) - 1n; prov.mine(hash); }, 20); };
  assert.match(trade.ownerDocument.querySelector('#coin-trade-links').textContent, /Also trades on.*Uniswap.*GMGN/, 'the other venues are linked');
  trade.querySelector('[data-rh-action]').click();
  await flush(4);
  assert.match(trade.querySelector('[data-rh-note]').textContent, /Step 1 of 2 · approve TEST|Approval sent/, 'the approval step is named');
  await new Promise(resolve => setTimeout(resolve, 80)); await flush(10);
  assert.equal(prov.sent.length, 2, 'approve, then sell');
  const [approve, sell] = prov.sent;
  assert.equal(approve.to.toLowerCase(), TOKEN.toLowerCase()); assert.equal(approve.data.slice(0, 10), SELECTORS.approve);
  assert.equal(approve.data.slice(34, 74).toLowerCase(), ROUTER.slice(2).toLowerCase(), 'the router is the spender');
  assert.equal(sell.to.toLowerCase(), ROUTER.toLowerCase(), 'the sell goes to the router'); assert.equal(sell.data.slice(0, 10), SELECTORS.sell);
  assert.equal(tokenOf(sell).toLowerCase(), TOKEN.toLowerCase(), 'the coin is the first argument');
  assert.equal(amountOf(sell), 10n ** 24n, 'one million tokens');
  assert.equal(recipientOf(sell).toLowerCase(), ME.toLowerCase(), 'sold to the wallet');
  assert.ok(BigInt('0x' + sell.data.slice(10 + 64 * 4, 10 + 64 * 5)) > BigInt(Math.floor(Date.now() / 1000)), 'a deadline in the future');
  assert.ok(sell.minedBefore.includes(approve.hash), 'the sell went out only after the approval was mined');
  assert.ok(prov.allowanceReads.every(r => r.spender.toLowerCase() === ROUTER.toLowerCase() && r.owner.toLowerCase() === ME.toLowerCase()), 'allowances are read for the wallet and the router');
  assert.ok(prov.allowanceReads.some(r => r.token === TOKEN.toLowerCase()), 'the coin allowance is read');
  assert.match(trade.querySelector('[data-rh-note]').textContent, /Sell sent/);
  page.destroy();
});

test('a sell with an allowance is one transaction; a failed approval stops the sell', async () => {
  const chain = { eth: 10n ** 18n, pair: 0n, token: 5n * 10n ** 24n, tokenAllowance: (1n << 256n) - 1n, pairAllowance: 0n };
  const { trade, prov, page, window } = await mount({ chain });
  trade.querySelector('[data-rh-side="sell"]').click(); await flush();
  trade.querySelector('[data-rh-amount]').value = '250000'; trade.querySelector('[data-rh-amount]').dispatchEvent(new window.Event('input')); await flush();
  trade.querySelector('[data-rh-action]').click(); await flush(10);
  assert.equal(prov.sent.length, 1, 'no approval needed'); assert.equal(prov.sent[0].data.slice(0, 10), SELECTORS.sell);
  assert.match(trade.querySelector('[data-rh-note]').textContent, /Sell sent/);
  // A second wallet whose approval reverts: the sell never goes out and the note says why.
  chain.tokenAllowance = 0n; trade.querySelector('[data-rh-refresh]').click(); await flush(6);
  chain.onApprove = (tx, hash) => setTimeout(() => prov.mine(hash, '0x0'), 10);
  trade.querySelector('[data-rh-amount]').value = '1'; trade.querySelector('[data-rh-amount]').dispatchEvent(new window.Event('input')); await flush();
  trade.querySelector('[data-rh-action]').click(); await new Promise(resolve => setTimeout(resolve, 60)); await flush(10);
  assert.equal(prov.sent.length, 2, 'the approval went out, the sell did not');
  assert.equal(prov.sent[1].data.slice(0, 10), SELECTORS.approve);
  assert.match(trade.querySelector('[data-rh-note]').textContent, /failed on the chain/);
  page.destroy();
});

test('the presets write exact amounts: MAX sells every token; MAX on an ETH buy keeps gas; 25% and 50% are shares', async () => {
  const chain = { eth: 2n * 10n ** 18n + 123n, pair: 0n, token: 123456789012345678901234567n, tokenAllowance: 0n, pairAllowance: 0n };
  const { trade, page, window } = await mount({ chain });
  const amount = trade.querySelector('[data-rh-amount]');
  assert.deepEqual([...trade.querySelectorAll('[data-rh-percent]')].map(b => b.textContent), ['25%', '50%', 'MAX']);
  trade.querySelector('[data-rh-side="sell"]').click(); await flush();
  trade.querySelector('[data-rh-max]').click(); await flush();
  assert.equal(amount.value, '123456789.012345678901234567', 'every unit, no rounding');
  trade.querySelector('[data-rh-percent="50"]').click(); await flush();
  assert.equal(amount.value, '61728394.506172839450617283', 'half, rounded down to the wei');
  trade.querySelector('[data-rh-side="buy"]').click(); await flush();
  trade.querySelector('[data-rh-max]').click(); await flush();
  assert.equal(amount.value, '1.999500000000000123', 'the ETH balance less 0.0005 ETH for gas');
  trade.querySelector('[data-rh-percent="25"]').click(); await flush();
  assert.equal(amount.value, '0.49987500000000003', 'a quarter of the tradable balance');
  page.destroy();
});

test('an ETH buy carries the value and needs no approval; a USDG buy approves the pair and waits', async () => {
  const chain = { eth: 10n ** 18n, pair: 0n, token: 0n, tokenAllowance: 0n, pairAllowance: 0n };
  const { trade, prov, page, window } = await mount({ chain });
  trade.querySelector('[data-rh-amount]').value = '0.1'; trade.querySelector('[data-rh-amount]').dispatchEvent(new window.Event('input')); await flush();
  trade.querySelector('[data-rh-action]').click(); await flush(10);
  assert.equal(prov.sent.length, 1); assert.equal(prov.sent[0].data.slice(0, 10), SELECTORS.buy); assert.equal(BigInt(prov.sent[0].value), 10n ** 17n);
  assert.equal(prov.sent[0].to.toLowerCase(), ROUTER.toLowerCase(), 'bought through the router');
  assert.equal(recipientOf(prov.sent[0]).toLowerCase(), ME.toLowerCase(), 'bought to the wallet'); assert.equal(amountOf(prov.sent[0]), 10n ** 17n);
  page.destroy();
  const usdg = { eth: 10n ** 18n, pair: 500n * 10n ** 6n, token: 0n, tokenAllowance: 0n, pairAllowance: 0n };
  const second = await mount({ pair: 'usdg', chain: usdg });
  second.trade.querySelector('[data-rh-amount]').value = '100'; second.trade.querySelector('[data-rh-amount]').dispatchEvent(new second.window.Event('input')); await flush();
  usdg.onApprove = (tx, hash) => { assert.equal(tx.to.toLowerCase(), USDG.toLowerCase(), 'the approval is on the pair token'); setTimeout(() => { usdg.pairAllowance = (1n << 256n) - 1n; second.prov.mine(hash); }, 15); };
  second.trade.querySelector('[data-rh-action]').click(); await new Promise(resolve => setTimeout(resolve, 70)); await flush(10);
  assert.deepEqual(second.prov.sent.map(t => t.data.slice(0, 10)), [SELECTORS.approve, SELECTORS.buy], 'approve the pair, then buy');
  assert.ok(second.prov.sent[1].minedBefore.includes(second.prov.sent[0].hash), 'the buy waited for the approval');
  assert.equal(amountOf(second.prov.sent[1]), 100n * 10n ** 6n);
  assert.equal(second.prov.sent[1].value, '0x0');
  second.page.destroy();
});

test('with the pool state the quote comes from the pool maths: a buy, a sell, and a sell past the liquidity', async () => {
  const chain = { eth: 10n ** 18n, pair: 0n, token: 10n ** 27n, tokenAllowance: 0n, pairAllowance: 0n }, pool = poolBlock();
  const { trade, window, page } = await mount({ chain, pool });
  const amount = trade.querySelector('[data-rh-amount]');
  amount.value = '0.5'; amount.dispatchEvent(new window.Event('input')); await flush();
  const expected = quoteSwap(pool, { buy: true, amountIn: 5n * 10n ** 17n });
  const text = trade.querySelector('[data-rh-quote]').textContent;
  assert.match(text, /pool fee 0\.00875 ETH/, 'the 1.75% curve-pool fee on 0.5 ETH: ' + text);
  assert.ok(text.includes(Math.round(Number(expected.amountOut / 10n ** 18n)).toLocaleString('en-US').slice(0, 4)), 'the coins the pool gives: ' + text);
  trade.querySelector('[data-rh-side="sell"]').click(); await flush();
  trade.querySelector('[data-rh-max]').click(); await flush();
  const sellText = trade.querySelector('[data-rh-quote]').textContent;
  assert.match(sellText, /the pool’s liquidity ends there; the rest stays yours/, 'selling the whole supply into an empty pool is limited: ' + sellText);
  assert.match(sellText, /pool fee .* TEST/, 'a sell’s fee is in coins');
  page.destroy();
});

/** The details list as label → text. */
const details = document => Object.fromEntries([...document.querySelectorAll('#coin-details > div')].map(d => [d.querySelector('dt').textContent, d.querySelector('dd').textContent]));

test('the details show the fee shape (v71.41): a creator coin’s flat fee by stage, a holder-reward coin’s tax; the pool rows follow the stage', async () => {
  const chain = { eth: 10n ** 18n, pair: 0n, token: 0n, tokenAllowance: 0n, pairAllowance: 0n, owed: 1500000000000000n };
  const { document, page } = await mount({ chain, pool: poolBlock(), patch: { recipients: { creatorClaims: true, creatorFeeRecipient: ME, owed: '1500000000000000', platformShareBps: 7142 } } });
  const rows = details(document);
  assert.equal(rows['Trading fee'], '1.75% on the curve (now) · 0.5% after graduation');
  assert.equal(rows['Creator fee'], '0.5% on the curve · 0.25% after graduation'); assert.equal(rows['Holder tax'], undefined);
  assert.equal(rows['Launchpad’s fee'], '1.25% on the curve · 0.25% after graduation');
  assert.match(rows.Liquidity, /locked in Launchpad’s locker; at graduation they move into the 0\.5% pool, locked for good/);
  assert.equal(rows['Uniswap v4 pool'], POOL_ID.slice(0, 8) + '…' + POOL_ID.slice(-6) + ' ↗'); assert.equal(rows['Graduation pool'], undefined); assert.equal(rows['Launchpad pool (retired)'], undefined);
  assert.equal(document.querySelector('#coin-progress-wrap').hidden, false);
  assert.match(document.querySelector('#coin-market-note').textContent, /Prices come from the pool state/);
  assert.match(document.querySelector('[data-rh-claim] p').textContent, /Your creator fee \(0\.5% of every swap on the curve, 0\.25% after graduation\) accrues in Launchpad’s fee escrow under 0x1111…1111: 0\.0015 ETH claimable\./);
  page.destroy();
  // A Holders coin with a 2% tax: the tax row replaces the creator fee.
  const holders = await mount({ chain, pool: { ...poolBlock(), fee: 32500 }, patch: { mode: 'holders', modeLabel: 'Holders', taxBps: 200, feeShape: HOLDER_FEES, curve: { ...coin().curve, tradeFeeBps: 325 }, recipients: { creatorClaims: false, platformShareBps: 4153 } } });
  const taxed = details(holders.document);
  assert.equal(taxed['Trading fee'], '3.25% on the curve (now) · 2.5% after graduation');
  assert.equal(taxed['Holder tax'], '2% of every swap · 95% to the holders, 5% to Launchpad · no creator fee'); assert.equal(taxed['Creator fee'], undefined);
  assert.equal(holders.document.querySelector('[data-rh-claim]').hidden, true, 'no creator claim on a holder-reward coin');
  holders.page.destroy();
});

test('a graduated coin: the graduation pool trades now at 0.5%, the curve pool is listed as retired, the progress bar is gone and the note says what moved', async () => {
  const chain = { eth: 10n ** 18n, pair: 0n, token: 0n, tokenAllowance: 0n, pairAllowance: 0n }, GRAD_POOL = '0x' + '9b'.repeat(32);
  const base = poolBlock(), full = { tickLower: -887270, tickUpper: 887270, liquidity: '123456789012345678901' };
  const pool = { ...base, id: GRAD_POOL, curvePoolId: POOL_ID, curve: null, upper: null, positions: [full], liquidity: full.liquidity, fee: 5000, crossed: true, graduated: true };
  const { document, page, trade, window } = await mount({ chain, pool, patch: { poolId: GRAD_POOL, venueState: 'graduated', graduatedAt: 1700003600000, curve: { ...coin().curve, tradeFeeBps: 50, graduated: true, progressBps: 10000 }, feeShape: { ...CREATOR_FEES, stage: 'pool', curvePoolId: POOL_ID }, recipients: { creatorClaims: false, platformShareBps: 5000 } } });
  const rows = details(document);
  assert.equal(rows['Trading fee'], '1.75% on the curve · 0.5% (now) after graduation');
  assert.equal(rows['Graduation pool'], GRAD_POOL.slice(0, 8) + '…' + GRAD_POOL.slice(-6) + ' ↗'); assert.equal(rows['Launchpad pool (retired)'], POOL_ID.slice(0, 8) + '…' + POOL_ID.slice(-6) + ' ↗'); assert.equal(rows['Uniswap v4 pool'], undefined);
  assert.match(rows.Liquidity, /in the 0\.5% graduation pool, locked for good/);
  assert.equal(document.querySelector('#coin-stage').textContent, 'Graduated'); assert.equal(document.querySelector('#coin-stage').dataset.stage, 'graduated');
  assert.equal(document.querySelector('#coin-progress-wrap').hidden, true);
  assert.match(document.querySelector('#coin-market-note').textContent, /moved into the 0\.5% graduation pool \(locked for good\)/);
  // The trade box quotes the graduation pool's single full-range position at its 0.5% fee.
  trade.querySelector('[data-rh-amount]').value = '0.2'; trade.querySelector('[data-rh-amount]').dispatchEvent(new window.Event('input')); await flush();
  const text = trade.querySelector('[data-rh-quote]').textContent;
  assert.match(text, /pool fee 0\.001 ETH/, 'the 0.5% fee on 0.2 ETH: ' + text);
  const expected = quoteSwap(pool, { buy: true, amountIn: 2n * 10n ** 17n });
  assert.ok(expected.amountOut > 0n && text.includes(Math.round(Number(expected.amountOut / 10n ** 18n)).toLocaleString('en-US').slice(0, 3)), 'quoted from the full-range position: ' + text);
  page.destroy();
});
