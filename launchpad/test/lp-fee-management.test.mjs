import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, parseAbiParameters, encodeEventTopics, decodeAbiParameters, decodeFunctionData } from 'viem';
import { PortfolioEngine } from '../src/portfolio.mjs';
import { SOL } from '../src/core.mjs';
import { cleanStrategy } from '../public/strategy-settings.mjs';
import { createRobinhoodAccount } from '../src/robinhood-settings.mjs';
import { RobinhoodEngine } from '../src/robinhood-engine.mjs';
import { buildFeeClaim } from '../src/robinhood-lp-fees.mjs';
import { CONTRACTS, erc20Abi, EVM_NATIVE, positionAbi } from '../src/robinhood-contracts.mjs';
import { showTutorial } from '../src/telegram-tutorial.mjs';
const token = '0x1111111111111111111111111111111111111111', quote = '0x2222222222222222222222222222222222222222';
const book = () => ({ data: { lots: [], pending: [], seen: [], events: [], feeReceipts: [], trades: 0 }, async save() {}, addEvent(e) { this.data.events.unshift(e); } });
const transfer = (mint, from, to, amount) => ({ address: mint, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } }), data: encodeAbiParameters(parseAbiParameters('uint256'), [amount]) });
test('manual Solana fee claims leave LP principal and allocation unchanged apart from gas', async () => {
  const ledger = book(), e = new PortfolioEngine({ live: ledger, paper: book() }); e.ledger = ledger; e.c = { mode: 'live' };
  const position = { venue: 'Meteora DLMM', position: 'nft' }, row = { id: 'lp', wallet: 'wallet', tokens: { [SOL]: '100000', asset: '50' }, baseMint: 'asset', quoteMint: SOL, fees: '0', turnover: '0', position, exiting: 'claimFees' }; ledger.data.lots.push(row);
  const pending = { wallet: 'wallet', signature: 'claim', order: { kind: 'lp-claim', recordId: 'lp', compound: false, feeMaximums: { [SOL]: '10000', asset: '25' } } }; ledger.data.pending.push(pending);
  await e.applyDeltas(pending, { [SOL]: 5000n, asset: 25n }, 5000n);
  assert.deepEqual(row.tokens, { [SOL]: '95000', asset: '50' }); assert.deepEqual(row.claimedFees, { [SOL]: '10000', asset: '25' }); assert.equal(row.position, position); assert.equal(row.exiting, null);
  await e.applyDeltas(pending, { [SOL]: 5000n, asset: 25n }, 5000n); assert.equal(row.claimedFees.asset, '25');
});
test('Solana compounding can consume only recorded earnings, never unrelated allocation tokens', async () => {
  const ledger = book(), e = new PortfolioEngine({ live: ledger, paper: book() }); e.ledger = ledger; e.c = { mode: 'live' };
  const row = { id: 'lp', wallet: 'wallet', tokens: { [SOL]: '100000', asset: '500' }, feeCredits: { [SOL]: '10000', asset: '20' }, baseMint: 'asset', quoteMint: SOL, fees: '0', turnover: '0', position: { venue: 'Meteora DAMM v2' } }; ledger.data.lots.push(row);
  const pending = { wallet: 'wallet', signature: 'compound', order: { kind: 'lp-compound', recordId: 'lp', maxInputs: { [SOL]: '5000', asset: '20' } } }; ledger.data.pending.push(pending);
  await assert.rejects(e.applyDeltas(pending, { [SOL]: -10000n, asset: -21n }, 5000n), /tracked fee/); assert.equal(row.tokens.asset, '500'); assert.equal(row.feeCredits.asset, '20');
  await e.applyDeltas(pending, { [SOL]: -10000n, asset: -20n }, 5000n); assert.equal(row.tokens.asset, '480'); assert.equal(row.feeCredits.asset, '0'); assert.equal(row.feeCredits[SOL], '5000'); assert(row.position);
});
test('Solana fee claims do not reinvest unrelated wrapped SOL or rent returned by account closure', async () => {
  for (const compound of [false, true]) {
    const ledger = book(), e = new PortfolioEngine({ live: ledger, paper: book() }); e.ledger = ledger; e.c = { mode: 'live' };
    const row = { id: 'lp', wallet: 'wallet', tokens: { [SOL]: '100000', asset: '50' }, baseMint: 'asset', quoteMint: SOL, fees: '0', turnover: '0', position: { venue: 'Meteora DLMM' } }; ledger.data.lots.push(row);
    const pending = { wallet: 'wallet', signature: 'claim-extra-native', order: { kind: 'lp-claim', recordId: 'lp', compound, feeMaximums: { [SOL]: '10000', asset: '25' } } }; ledger.data.pending.push(pending);
    await e.applyDeltas(pending, { [SOL]: 1005000n, asset: 30n }, 5000n);
    assert.equal(row.claimedFees[SOL], '10000'); assert.equal(row.tokens[SOL], compound ? '105000' : '95000'); assert.equal(row.tokens.asset, compound ? '75' : '50');
    assert.equal(row.feeCredits[SOL] || '0', compound ? '10000' : '0');
  }
});
test('Robinhood manual claiming does not adopt earned tokens into the investment budget', () => {
  const ledger = book(), wallet = createRobinhoodAccount().settings.wallets[0].publicKey, e = new RobinhoodEngine(ledger, {}, 'liquidity');
  const lot = { id: 'lp', wallet, token, quote, tokenId: '1', liquidity: '100', pool: { currency0: token, currency1: quote, protocol: 'v3' } }; ledger.data.lots.push(lot);
  ledger.data.lpFunds = { [wallet]: { token, quote, tokenAvailable: '0', quoteAvailable: '0' } };
  const pending = { wallet, signature: 'claim', context: { operation: 'lp-claim', lotId: 'lp', compound: false } };
  const receipt = { logs: [transfer(token, CONTRACTS.v3PositionManager, wallet, 30n), transfer(quote, CONTRACTS.v3PositionManager, wallet, 50n)] };
  e.confirmed(pending, receipt); e.confirmed(pending, receipt); const result = ledger.data.lots[0];
  assert.deepEqual(result.claimedFees, { [token]: '30', [quote]: '50' }); assert.deepEqual(result.feeCredits, {}); assert.equal(result.liquidity, '100'); assert.equal(ledger.data.lpFunds[wallet].quoteAvailable, '0'); clearInterval(e.reconcileTimer);
});
test('Robinhood auto-compound rejects an asset debit larger than its earned-fee credits', () => {
  const ledger = book(), wallet = createRobinhoodAccount().settings.wallets[0].publicKey, e = new RobinhoodEngine(ledger, {}, 'liquidity');
  ledger.data.lots.push({ id: 'lp', wallet, token, quote, liquidity: '100', pool: { currency0: token, currency1: quote }, feeCredits: { [token]: '30', [quote]: '50' } });
  const pending = { wallet, signature: 'reinvest', context: { operation: 'lp-compound', lotId: 'lp', liquidity: '10', maximums: ['30', '50'] } };
  const before = structuredClone(ledger.data);
  assert.throws(() => e.confirmed(pending, { logs: [transfer(token, wallet, CONTRACTS.positionManager, 31n)] }), /tracked fee/); assert.deepEqual(ledger.data, before); clearInterval(e.reconcileTimer);
});
test('v4 claiming keeps the position and enforces the native fee receipt minimum on-chain', async () => {
  const wallet = createRobinhoodAccount().settings.wallets[0].publicKey, lot = { tokenId: '7', wallet, liquidity: '100', lower: -60, upper: 60, pool: { currency0: EVM_NATIVE, currency1: token, fee: 3000, tickSpacing: 60, hooks: EVM_NATIVE } };
  const rpc = { client: { readContract: async ({ functionName }) => functionName === 'ownerOf' ? wallet : functionName === 'getPositionLiquidity' ? 100n : functionName === 'getPositionInfo' ? [100n, 0n, 0n] : [2n ** 128n, 2n ** 128n] } };
  const plan = await buildFeeClaim({ rpc, lot, wallet, slippageBps: 100 });
  const { args } = decodeFunctionData({ abi: positionAbi, data: plan.data }), [actions, inputs] = decodeAbiParameters(parseAbiParameters('bytes,bytes[]'), args[0]);
  assert.equal(actions, '0x010e0e11'); assert.equal(decodeAbiParameters(parseAbiParameters('uint256,uint256,uint128,uint128,bytes'), inputs[0])[1], 0n);
  assert.equal(decodeAbiParameters(parseAbiParameters('address,address,uint256'), inputs[1])[2], 99n); assert.deepEqual(plan.minimumAmounts, ['99','99']); assert.equal(plan.value, 0n);
  await assert.rejects(buildFeeClaim({ rpc, lot: { ...lot, pool: { ...lot.pool, protocol: 'v2' } }, wallet }), /retains trading fees/);
});
test('auto-compound is opt-in and Telegram tutorial is available without credentials', () => {
  assert.equal(cleanStrategy().autoCompoundFees, false); assert.equal(cleanStrategy({ autoCompoundFees: true }).autoCompoundFees, true); assert.throws(() => cleanStrategy({ autoCompoundFees: 'yes' }));
  let result; const bot = { say(ctx, text, rows) { result = { text, rows }; }, homeButton() { return { text: 'Home', callback_data: 'home' }; } };
  showTutorial(bot, { navigation: 0, prompt: { input: 'secret' } }); assert(result.text.length < 4096); assert(result.rows.flat().some(r => r.url === 'https://developers.jup.ag/portal')); assert(!/operator.*(?:access|decrypt)/i.test(result.text));
});
