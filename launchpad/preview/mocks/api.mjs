// Mocked /api/* responses. Each handler mirrors the JSON shape of the real
// producer in src/ (paths noted inline) and the consumer in public/.
import { launchpadApi, launchpadAccount, LAUNCH_ASSETS, pumpClassicDisclosure, planPositions, quoteSwap, poolPrice, curveNumbers, tickAtSqrtPrice, plannedSupply, robinhoodTradeLinks, robinhoodFeesFor, graduationPositions } from '../src-public.mjs';
import { coins, coinByMint, publicCoin, creatorEarnings, nativeSnapshot, pool, rewards, trades, holders, candles, USERS, LAUNCHPAD_MINT, SOL, USDC, QUOTE_USD, quote, image, hookAllowlist, hookBlocklist } from './data.mjs';
import { address, signature, hex64, rng, avatarPng } from './util.mjs';
import { gotchiList, gotchiDetail, gotchiCoin, gotchiHoldings, gotchiAdmin } from './gotchi.mjs';
import { agentCatalog, agentPolicy, agentList, agentDetail, agentActivity, agentRuns, agentTreasury, agentReceipts, agentMemory, agentBrowser, agentMe, agentAdmin, agentHealth, SCREENSHOT_PNG } from './agents.mjs';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const FEATURES = Object.freeze({ toolkit: false, telegram: false, walletOnly: true, robinhood: process.env.PREVIEW_ROBINHOOD === '1' });
const CSRF = 'preview-csrf-' + hex64('csrf').slice(0, 24);
const err = (status, error, extra = {}) => ({ status, body: { error, ...extra } });
const ok = body => ({ status: 200, body });

// ------------------------------------------------------------------ sessions
// src/accounts.mjs publicAccount() + account-app launchpadAccount() projection.
function account(user, patch = {}) {
  return launchpadAccount({ bio: user.bio, avatar: user.avatar, avatarId: user.avatar ? user.avatar.split('/').at(-1) : '', usernameChangeAvailableAt: 0, authType: 'wallet', id: user.id, username: user.username, mainWallet: user.mainWallet, cashbackWallet: user.mainWallet, signInWallet: user.mainWallet, walletAccount: null, banned: false, cashbackBps: 0, role: 'user', createdAt: user.createdAt, telegramId: null, mfaEnabled: false, recoveryCodesRemaining: 0, ...patch });
}
export const SESSION_USER = USERS.find(u => u.username === 'mira_builds');
const ADMIN_USER = { id: hex64('acct:operator').slice(0, 32), username: 'operator', bio: 'Platform operations', avatar: image('avatar:operator'), mainWallet: address('wallet:operator'), createdAt: Date.UTC(2026, 8, 20) };
export function sessionFor(mode) {
  if (mode === 'user') return { mode, account: account(SESSION_USER), authMethod: 'wallet', walletVerified: true, walletAddress: SESSION_USER.mainWallet, monitorAllowed: false, pumpTestAllowed: false };
  if (mode === 'admin') return { mode, account: account(ADMIN_USER, { authType: 'password', signInWallet: '', role: 'admin', mfaEnabled: true, recoveryCodesRemaining: 8 }), authMethod: 'password', walletVerified: false, walletAddress: null, monitorAllowed: true, pumpTestAllowed: true };
  return null;
}
// src/account-app.mjs GET /api/session.
function sessionBody(session) {
  if (!session) return { accounts: true, authenticated: false, portfolio: false, features: FEATURES };
  return { accounts: true, authenticated: true, portfolio: false, token: CSRF, account: session.account, authMethod: session.authMethod, walletVerified: session.walletVerified, walletAddress: session.walletAddress, monitorAllowed: session.monitorAllowed, pumpTestAllowed: session.pumpTestAllowed, features: FEATURES };
}

// ------------------------------------------------------------------ explore
const STAGES = ['all', 'new', 'graduated', 'moving'];
function exploreList(params) {
  const limit = Math.min(40, Math.max(1, Number(params.get('limit') || 20))), offset = Math.max(0, Number(params.get('offset') || 0));
  const stage = STAGES.includes(params.get('stage')) ? params.get('stage') : 'all', sort = params.get('sort') || 'newest', search = (params.get('search') || '').trim().toLowerCase();
  const category = params.get('category') || 'all', launchMode = params.get('launchMode') || 'all', age = params.get('age') || 'all', chain = params.get('chain') || 'all', now = Date.now();
  const all = coins().map(publicCoin).concat(robinhoodExploreCoins());
  const matched = all.filter(c => (chain === 'all' || c.chain === chain) && (launchMode === 'all' || c.launchMode === launchMode) && (!search || [c.name, c.symbol, c.mint].some(t => t.toLowerCase().includes(search))) && (category === 'all' || c.quote.category === category) && (age === 'all' || c.createdAt >= now - (age === '24h' ? DAY : 7 * DAY)));
  const val = c => c.marketCapUsd ?? c.fdvUsd;
  const sorters = { newest: (a, b) => b.createdAt - a.createdAt, oldest: (a, b) => a.createdAt - b.createdAt, recentBuys: (a, b) => (b.lastBuyAt || 0) - (a.lastBuyAt || 0), marketCap: (a, b) => val(b) - val(a), volume: (a, b) => b.volume24h - a.volume24h, progress: (a, b) => (b.progressPercent ?? -1) - (a.progressPercent ?? -1) };
  matched.sort(sorters[sort] || sorters.newest);
  const counts = { all: matched.length, new: matched.filter(c => c.stage === 'new').length, graduated: matched.filter(c => c.stage === 'graduated').length, moving: matched.filter(c => c.movingReason).length };
  const staged = matched.filter(c => stage === 'all' || (stage === 'moving' ? c.movingReason !== null : c.stage === stage));
  const page = staged.slice(offset, offset + limit), quotes = [...new Map(all.map(c => [c.quote.mint, c.quote])).values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { coins: page, total: staged.length, offset, limit, nextOffset: offset + limit < staged.length ? offset + limit : null, counts, quotes, at: now, refreshing: false, refreshMs: 30000, stale: false, coverage: { observed: matched.length, total: matched.length }, scope: 'Launchpad launches on this host' };
}
function exploreCreator(username, offset = 0) {
  const user = USERS.find(u => u.username === username); if (!user) return err(404, 'Creator not found.');
  const rows = coins().filter(c => c.creator.username === username).sort((a, b) => b.createdAt - a.createdAt).map(publicCoin);
  return ok({ profile: { username: user.username, bio: user.bio, avatar: user.avatar }, coins: rows.slice(offset, offset + 24), total: rows.length, offset, limit: 24 });
}
function withCoin(mint, fn) { const coin = coinByMint(mint); if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint || '')) return err(400, 'Enter a valid token mint.'); if (!coin) return err(404, 'This Launchpad coin was not found.'); return fn(coin); }
const tokenCoin = coin => { const value = publicCoin(coin), earnings = creatorEarnings(coin); if (earnings) value.creatorEarnings = earnings; return value; };
function exploreApi(path, params) {
  if (path === '/api/explore') return ok(exploreList(params));
  if (path === '/api/explore/updates') return ok({ version: hex64('inventory:' + coins().map(c => c.mint).join()), total: coins().length, stale: false, refreshMs: 10000 });
  if (path === '/api/explore/users') {
    const q = (params.get('search') || '').trim().replace(/^@/, '').toLowerCase(), limit = Number(params.get('limit') || 12), offset = Number(params.get('offset') || 0);
    if (!q) return ok({ users: [], total: 0, offset, limit, nextOffset: null });
    const rows = USERS.filter(u => u.username.includes(q)).map(u => ({ username: u.username, bio: u.bio, avatar: u.avatar, launchCount: coins().filter(c => c.creator.username === u.username).length }));
    return ok({ users: rows.slice(offset, offset + limit), total: rows.length, offset, limit, nextOffset: offset + limit < rows.length ? offset + limit : null });
  }
  if (path === '/api/explore/creator') return exploreCreator((params.get('username') || '').toLowerCase(), Number(params.get('offset') || 0));
  const mint = params.get('mint');
  // src/launchpad-explore.mjs token()/market()/trades()/holders()/rewards().
  if (path === '/api/explore/token') return withCoin(mint, coin => ok({ coin: tokenCoin(coin), refreshing: false }));
  if (path === '/api/explore/market') return withCoin(mint, coin => ok({ coin: tokenCoin(coin), native: nativeSnapshot(coin), nativeError: null, pool: pool(coin), at: Date.now(), refreshMs: 30000, refreshing: false, stale: false }));
  if (path === '/api/explore/trades') return withCoin(mint, coin => ok({ mint: coin.mint, quote: coin.quote, at: Date.now() - 4000, trades: trades(coin), available: true, stale: false, refreshing: false, complete: false, source: coin.platform === 'raydium' ? 'Raydium launch curve' : coin.platform === 'meteora' ? 'Meteora recorded trades' : 'Launchpad trade history', note: 'Recent curve trades from the last 24 hours, up to 100 shown. Post-graduation pool trades are not included.', refreshMs: 30000 }));
  if (path === '/api/explore/holders') return withCoin(mint, coin => ok({ mint: coin.mint, available: true, stale: false, holders: holders(coin), at: Date.now() - 9000, refreshMs: 60000, note: 'Largest 20 token accounts, including verified LP vaults. One wallet can own multiple accounts; this is not a complete holder count.' }));
  if (path === '/api/explore/rewards') return withCoin(mint, coin => ok(rewards(coin)));
  return err(404, 'Market feed not found.');
}

// ------------------------------------------------------------------ analytics (src/public-analytics.mjs)
function analytics() {
  const now = Date.now(), day = d => new Date(now - d * DAY).toISOString().slice(0, 10);
  const days = []; for (let d = 0; d <= Math.min(29, Math.floor((now - Date.UTC(2026, 8, 24)) / DAY)); d++) days.unshift({ date: day(d), count: [3, 7, 4, 11, 9, 14, 6, 8, 12, 5][d % 10], observedCount: [3, 7, 4, 11, 9, 14, 6, 8, 12, 5][d % 10] });
  const burned = '41250000000000', price = coinByMint(LAUNCHPAD_MINT).priceUsd;
  return { version: 1, generatedAt: now - 5000, refreshMs: 60000,
    launches: { total: 214, last24h: 9, uniqueDevelopers: 131, uniqueDevelopers24h: 7, complete: true, observedTotal: 214, observedLast24h: 9, observedUniqueDevelopers: 131, observedUniqueDevelopers24h: 7 },
    dailyLaunches: { timezone: 'UTC', complete: true, days },
    volume: { usd: 1_284_310.55, observedUsd: 1_284_310.55, complete: true, lifetimeUsd: null, asOf: now - 20000, refreshing: false, coverage: { launches: 214, usdComplete: 209, inventoryComplete: true } },
    lifetime: { status: 'available', recordedVolumeUsdEstimate: 18_942_772.12, pricedVolumeUsdEstimate: 18_942_772.12, indexedHistoricalVolumeUsd: 14_210_400.5, curveVolumeUsdEstimate: 4_732_371.62, updatedAt: now - 60000,
      coverage: { historyComplete: true, backfillComplete: true, indexedHistoryComplete: true, indexedRecordedPools: 37, indexedPools: 37, postGraduationIncluded: true, backfilledLaunches: 214, launches: 214, headFreshLaunches: 211 },
      last24h: { recordedVolumeUsdEstimate: 1_190_220.4, pricedVolumeUsdEstimate: 1_190_220.4, historyComplete: true, tradeCount: 8231 },
      quoteTotals: [{ symbol: 'SOL', amount: '21844.214', usdEstimate: 3_328_412.1 }, { symbol: 'USDC', amount: '1022451.21', usdEstimate: 1_022_451.21 }, { symbol: 'NVDAx', amount: '1180.4', usdEstimate: 213_912.08 }, { symbol: 'SPYx', amount: '294.1', usdEstimate: 168_019.3 }] },
    revenue: { status: 'available', totalUsdEstimate: 186_420.77, pricedUsdEstimate: 186_420.77, complete: true, historyComplete: true, pricingComplete: true, coverage: { sources: ['raydium', 'meteora', 'damm-pump'] } },
    treasury: { status: 'available', buybackBps: 5000, solDecimals: 9, curveDecimals: 6, solSpent: '412750000000', curveBought: '45120000000000', curveBurned: '41250000000000', updatedAt: now - 120000, curvePrice: { mint: LAUNCHPAD_MINT, usd: String(price), at: now - 10000, stale: false, source: 'Current pool price' },
      history: [0, 1, 2, 3, 4, 5].map(i => ({ kind: i % 2 ? 'burn' : 'buy', signature: signature('treasury:' + i), inputAmount: i % 2 ? '6875000000000' : '68791666666', outputAmount: i % 2 ? '0' : '7520000000000', confirmedAt: now - (i + 1) * 3 * HOUR, source: i === 4 ? 'manual' : undefined })) },
    burns: { status: 'available', complete: true, curveDecimals: 6, curveBurned: '41250000000000', directBurned: '1250000000000', history: [0, 1, 2, 3, 4, 5].map(i => ({ kind: i % 2 ? 'burn' : 'buy', signature: signature('treasury:' + i), inputAmount: i % 2 ? '6875000000000' : '68791666666', outputAmount: i % 2 ? '0' : '7520000000000', confirmedAt: now - (i + 1) * 3 * HOUR })) },
    burnSupply: { status: 'available', mint: LAUNCHPAD_MINT, decimals: 6, originalSupply: '1000000000000000', currentSupply: (1000000000000000n - BigInt(burned)).toString(), totalBurned: burned, slot: 391204000, at: now - 15000, source: 'finalized-mint-supply', commitment: 'finalized' },
    rewards: { holders: { distributed: { usdEstimate: 48_211.32, observedUsdEstimate: 48_211.32, historyComplete: true, valuationComplete: true, quoteTotals: [{ symbol: 'SOL', amount: '214.8812', usdEstimate: 32_741.6, historyComplete: true }, { symbol: 'USDC', amount: '12840.22', usdEstimate: 12_840.22, historyComplete: true }, { symbol: 'SPYx', amount: '4.6', usdEstimate: 2_629.5, historyComplete: true }] }, uniqueWallets: 3_412, observedUniqueWallets: 3_412, walletsComplete: true, payments: 9_120 } } };
}

// ------------------------------------------------------------------ account launches (src/launchpad.mjs publicLaunch)
const userCoins = () => coins().filter(c => c.creator.username === SESSION_USER.username);
function launchRecord(coin, i) {
  const id = hex64('launch:' + coin.symbol).slice(0, 32), wallet = SESSION_USER.mainWallet;
  return { id, state: 'live', walletMode: 'external', developerWallet: wallet, wallet, mint: coin.mint, curve: coin.curve, createdAt: coin.createdAt, feeCustody: 'relay', autoFees: true, managedFees: true,
    // A Paycheck coin is saved as a holders launch with the paycheck-v1 policy (public/launchpad-model.mjs) and reports its ledger in holderRewards.paycheck.
    input: { name: coin.name, symbol: coin.symbol, description: coin.description, quoteMint: coin.quote.mint, feeMode: coin.feeMode === 'paycheck' ? 'holders' : coin.feeMode, ...(coin.feeMode === 'paycheck' ? { paycheck: { policy: 'paycheck-v1' }, recipient: wallet } : {}), targetUsd: 20000, taxBps: coin.taxBps, walletMode: 'external', imageId: coin.image?.split('/').at(-1), network: 'mainnet-beta', ...coin.links },
    ...(coin.feeMode === 'paycheck' ? { holderRewards: { intervalMinutes: 15, minimumUsd: 1, minimumPolicy: 'paycheck-v1', quoteSymbol: 'SOL', pendingQuote: '0.6421', unconvertedTaxTokens: '0', nextCheckAt: Date.now() + 8 * MIN, taxConversion: { enabled: false }, totalDistributedQuote: '13.4982', totalPayments: 412, lastDistributionAt: Date.now() - 7 * MIN, lastDistributionQuote: '0.0412', paycheck: rewards(coin).paycheck } } : {}),
    review: { actualUsd: 20000, graduationUsd: 69000, minimumSol: '0.0412', lp: 'Burned', quoteSymbol: coin.quote.symbol, devBuy: { gross: '0', net: '0', solBudget: '0' } }, reviewHash: hex64('review:' + coin.symbol), reviewExpires: Date.now() - DAY,
    operations: [{ kind: 'create', state: 'confirmed', signature: signature('create:' + coin.symbol), slot: 391100000 + i, confirmedAt: coin.createdAt }],
    feeClaim: { available: true, busy: false, wallet, requiresSignature: false, scope: 'coin', pendingQuote: '0.0841', quoteSymbol: coin.quote.symbol },
    feeRedirect: { allowed: true, used: false } };
}
function userLaunches() {
  const live = userCoins().filter(c => c.platform === 'raydium').map(launchRecord), wallet = SESSION_USER.mainWallet;
  const draft = { id: hex64('launch:draft').slice(0, 32), state: 'draft', walletMode: 'external', developerWallet: wallet, wallet, mint: address('mint:draft'), curve: null, createdAt: Date.now() - 2 * HOUR, autoFees: false, managedFees: false,
    input: { name: 'Glass Garden', symbol: 'GLASS', description: 'A greenhouse for small ideas.', quoteMint: SOL, feeMode: 'creator', targetUsd: 20000, taxBps: 0, walletMode: 'external', imageId: image('coin:GLASS').split('/').at(-1), network: 'mainnet-beta' },
    review: { actualUsd: 20000, minimumSol: '0.0412', lp: 'Burned', devBuy: { gross: '0', solBudget: '0' } }, reviewHash: hex64('review:draft'), reviewExpires: Date.now() - HOUR, operations: [] };
  const failed = { ...draft, id: hex64('launch:failed').slice(0, 32), state: 'failed', mint: address('mint:failed'), createdAt: Date.now() - 2 * DAY, input: { ...draft.input, name: 'Rusty Kettle', symbol: 'KETTL', imageId: image('coin:KETTL').split('/').at(-1) }, error: 'The launch wallet did not approve the creation transaction in time.', canReuseDraft: true, recovery: { status: 'complete', reason: 'Setup funds were returned to your wallet.', notice: 'You can edit the saved details and try again.' } };
  return [...live, draft, failed];
}
function launchMarket(launch) {
  const coin = coinByMint(launch.mint); if (!coin) return err(404, 'This launch has no market yet.');
  const n = nativeSnapshot(coin); return ok({ launchId: launch.id, ...n, points: n.points });
}
function liveTrades(coin) {
  const usd = QUOTE_USD[coin.quote.mint] ?? 1;
  return { chain: 'solana', tokenAddress: coin.mint, source: 'Solana RPC', at: Date.now(), refreshMs: 5000, quoteSymbol: coin.quote.symbol,
    trades: trades(coin, 25).map(t => ({ id: t.signature + ':' + t.side, signature: t.signature, side: t.side, at: t.time * 1000, tokenAmount: t.amount, quoteAmount: t.quote, quoteSymbol: coin.quote.symbol, amountUsd: t.quote * usd, fdvUsd: coin.fdvUsd * (0.97 + (t.time % 7) / 100), gasNative: 0.000105, gasSymbol: 'SOL', wallet: t.wallet })) };
}
function launchHolders(coin) {
  return { chain: 'solana', tokenAddress: coin.mint, source: 'Solana onchain', at: Date.now() - 6000, supply: '1000000000', listedSupplyPercent: 62.4, historyAvailable: true,
    rows: holders(coin).map(h => ({ address: h.wallet, amount: String(Math.round(h.percent * 1e7)), supplyPercent: h.percent, contract: h.isLp, ownerResolved: true, balanceCoverage: 'complete' })) };
}
const earningsSection = (amount, usd, count) => ({ quoteTotals: [{ mint: SOL, symbol: 'SOL', decimals: 9, amountUnits: String(Math.round(amount * 1e9)), amount: String(amount), usdEstimate: usd, priceAt: Date.now() - 30000 }], usdEstimate: usd, observedUsdEstimate: usd, historyComplete: true, valuationComplete: true, valuationBasis: 'current_quote_prices', paymentCount: count, lastPaymentAt: Date.now() - 2 * HOUR });
// Account launch rows (src/meteora-service.mjs accountLaunch): the creator's own view, with `platform` (the My Tokens Meteora
// section filters on it), the fee ledger and, for a hooked coin, `hook` with the recorded allowlist (v71.28).
const nativeLaunch = coin => ({ platform: coin.platform, route: coin.platform, launchMode: coin.platform, mint: coin.mint, name: coin.name, symbol: coin.symbol, status: coin.stage === 'graduated' ? 'migrated' : 'trading', curveStatus: coin.curveStatus, stage: coin.stage, quoteMint: coin.quote.mint, quoteSymbol: coin.quote.symbol, quoteDecimals: coin.quote.decimals, quote: coin.quote, baseDecimals: 6, image: coin.image, createdAt: coin.createdAt, feeMode: coin.feeMode, creatorId: SESSION_USER.id, creatorWallet: SESSION_USER.mainWallet, creatorRecipient: SESSION_USER.mainWallet, creatorFeesPending: '0', creatorRewards: { pendingRaw: '84100000', totalClaimedRaw: '412000000', totalPaidRaw: '412000000', quoteSymbol: coin.quote.symbol, quoteDecimals: coin.quote.decimals, at: Date.now() - 60000, historyComplete: true }, feeRedirect: { used: false, canRedirect: coin.feeMode === 'creator', recipient: SESSION_USER.mainWallet }, archived: false, hidden: false, ...(coin.hook ? { hook: { ...coin.hook, hasAllowlist: coin.hook.rules.some(rule => rule.id === 'allowlist'), hasBlocklist: coin.hook.rules.some(rule => rule.id === 'blocklist'), allowlist: hookAllowlist(coin), allowlistCount: hookAllowlist(coin).length, allowlistUpdatedAt: Date.now() - 3 * HOUR } } : {}) });
// v71.28: prepared `hook-allow` operations, by id, so submit/reconcile echo the same unsigned transaction like the other Meteora actions.
const hookOperations = new Map();

function launchpadApiMock(method, path, params, session, body) {
  if (path === '/api/launchpad' && method === 'GET') return ok({ developerWallet: SESSION_USER.mainWallet, launches: session.mode === 'user' ? userLaunches() : [] });
  if (path === '/api/launchpad/quotes') return ok({ assets: LAUNCH_ASSETS.map(a => ({ ...a, supported: ['crypto', 'stocks', 'preipo'].includes(a.category) || a.launchpadOrigin === 'pump' || a.launchpadOrigin === 'stonk' })), canViewComingSoon: session.mode === 'admin' });
  if (path === '/api/launchpad/earnings') return ok({ wallet: session.account.mainWallet, requiresWalletSignIn: false, updatedAt: Date.now() - 20000, refreshMs: 60000, stale: false, scope: 'confirmed_curve_payments', creator: earningsSection(3.4127, 520.01, 41), holders: earningsSection(0.8812, 134.27, 12) });
  if (path === '/api/launchpad/image') return method === 'POST' ? ok({ imageId: hex64('preview-upload') + '.png' }) : err(405, 'Method not allowed.');
  if (path === '/api/launchpad/fee-assignments') return ok({ wallet: session.account.mainWallet, assignments: [], refreshMs: 30000 });
  if (path === '/api/launchpad/pump/launches') return ok({ launches: session.mode === 'user' ? userCoins().filter(c => c.platform === 'pumpswap').map(nativeLaunch) : [] });
  if (path === '/api/launchpad/damm-pump/launches') return ok({ launches: session.mode === 'user' ? userCoins().filter(c => c.platform === 'damm-pump').map(nativeLaunch) : [] });
  if (path === '/api/launchpad/meteora/launches') return ok({ launches: session.mode === 'user' ? userCoins().filter(c => c.platform === 'meteora').map(nativeLaunch) : [] });
  if (/^\/api\/launchpad\/(meteora|damm-pump|pump)\/operations$/.test(path)) return ok({ operations: [] });
  // Venue trade panels read the connected wallet's balances once a wallet connects (src/meteora-service.mjs walletBalances).
  if (/^\/api\/launchpad\/(meteora|damm-pump|pump)\/wallet$/.test(path) && method === 'POST') return ok({ wallet: { address: body?.expectedWallet || session.account.mainWallet, nativeBalanceLamports: '4211000000', quoteBalanceRaw: '4211000000', baseBalanceRaw: '0', baseDecimals: 6, at: Date.now() } });
  // v71.28: the creator's allowlist (GET) and the `hook-allow` action through the Meteora prepare/submit flow (an unsigned transaction to sign).
  // GET /api/launchpad/meteora/hook-allowlist?mint= (src/meteora-service.mjs hookAllowlist): the recorded allowlist; `wallets` mirrors `allowlist`.
  if (path === '/api/launchpad/meteora/hook-allowlist') { const coin = coinByMint(params.get('mint')); if (!coin?.hook) return err(404, 'Coin not found.'); const list = hookAllowlist(coin); return ok({ mint: coin.mint, hooked: true, hasAllowlist: list.length > 0 || coin.hook.rules.some(rule => rule.id === 'allowlist'), program: coin.hook.program, configPda: address('hook-config:' + coin.symbol), active: coin.hook.active, ended: coin.hook.ended, wallets: list, source: process.env.PREVIEW_ALLOWLIST_SOURCE === 'curve' ? 'curve' : 'chain', recorded: Date.now() - 3 * HOUR, allowlist: list }); }
  if (path === '/api/launchpad/meteora/prepare' && method === 'POST' && body?.action === 'hook-allow') {
    const coin = coinByMint(body.mint); if (!coin?.hook?.rules?.some(rule => rule.id === 'allowlist')) return err(409, 'This coin has no allowlist rule.');
    if (coin.creator.username !== session.account.username) return err(403, 'Only the coin’s creator can change its allowlist.');
    const add = Array.isArray(body.add) ? body.add : [], remove = Array.isArray(body.remove) ? body.remove : [];
    if (!add.length && !remove.length) return err(400, 'Add or remove at least one wallet.'); if (add.length + remove.length > 20) return err(400, 'Change at most 20 wallets per transaction.');
    const wallet = body.expectedWallet || session.account.mainWallet; if (wallet !== SESSION_USER.mainWallet) return err(403, 'Only the coin’s creator wallet can change its allowlist.');
    const operation = { id: 'hook-allow-' + hex64('hook:' + coin.symbol + ':' + add.join() + remove.join() + ':' + Date.now()).slice(0, 16), action: 'hook-allow', wallet, mint: coin.mint, state: 'awaiting_signature', transaction: Buffer.from('preview-unsigned-hook-allow:' + coin.symbol + ':' + add.length + ':' + remove.length).toString('base64'), expiresAt: Date.now() + 120000, createdAt: Date.now(), signature: null, review: { add, remove, program: coin.hook.program, maxWalletDebitLamports: String(add.length * 1002240 + 5000), quoteMint: SOL, quoteSymbol: 'SOL', quoteDecimals: 9, hook: { rules: coin.hook.rules, gateMint: coin.hook.gateMint, program: coin.hook.program } } };
    hookOperations.set(operation.id, operation); return ok({ operation });
  }
  // GET /api/launchpad/meteora/hook-blocklist?mint= (src/meteora-service.mjs hookBlocklist): the sealed blocklist, read from chain.
  if (path === '/api/launchpad/meteora/hook-blocklist') { const coin = coinByMint(params.get('mint')); if (!coin?.hook) return err(404, 'Coin not found.'); const list = hookBlocklist(coin); return ok({ mint: coin.mint, hooked: true, hasBlocklist: list.length > 0, program: coin.hook.program, blocklistPda: address('hook-block:' + coin.symbol), active: coin.hook.active, ended: coin.hook.ended, wallets: list, count: list.length, source: process.env.PREVIEW_BLOCKLIST_SOURCE === 'curve' ? 'curve' : 'chain', recorded: Date.now() - 18 * HOUR }); }
  if (/^\/api\/launchpad\/meteora\/(submit|reconcile|cancel)$/.test(path) && method === 'POST' && hookOperations.has(String(body?.operationId || ''))) {
    const saved = hookOperations.get(body.operationId), action = path.split('/').at(-1);
    const next = action === 'cancel' ? { ...saved, state: 'cancelled', transaction: undefined } : action === 'submit' ? { ...saved, state: 'confirmed', transaction: undefined, signature: signature(saved.action + ':' + saved.id) } : saved.state === 'confirmed' ? { ...saved, state: 'finalized', finalizedAt: Date.now() } : saved;
    hookOperations.set(saved.id, next); const { transaction, ...rest } = next; return ok({ operation: next.state === 'awaiting_signature' ? next : rest });
  }
  if (path === '/api/launchpad/rewards') {
    const launch = userLaunches().find(l => l.id === params.get('id')); if (!launch) return err(404, 'Launch not found.');
    return ok({ launchId: launch.id, mint: launch.mint, asOf: Date.now(), stale: false, refreshMs: 30000, schedule: launch.holderRewards, wallet: { address: SESSION_USER.mainWallet, quoteBalance: '0.4211', quoteSymbol: 'SOL' }, earned: { quote: '0.0841', unconvertedTaxTokens: '0' }, totals: { distributedQuote: '0', payments: 0, lastDistributionAt: null, lastDistributionQuote: null }, taxes: { note: 'Unclaimed transfer fees are not included.' } });
  }
  const launch = userLaunches().find(l => l.id === params.get('id')), coin = launch && coinByMint(launch.mint);
  if (path === '/api/launchpad/market') return launch ? launchMarket(launch) : err(404, 'Launch not found.');
  if (path === '/api/launchpad/market/pools') return ok({ chain: 'solana', tokenAddress: launch?.mint, pools: coin && pool(coin) ? [pool(coin)] : [], at: Date.now(), refreshMs: 60000 });
  if (path === '/api/launchpad/trades' || path === '/api/launchpad/market/live-trades') return coin ? ok(liveTrades(coin)) : err(404, 'Launch not found.');
  if (path === '/api/launchpad/market/holders') return coin ? ok(launchHolders(coin)) : err(404, 'Launch not found.');
  if (path === '/api/launchpad/market/holder-history') return ok({ wallet: params.get('wallet'), rows: [], at: Date.now(), historyAvailable: true });
  if (path === '/api/launchpad/trading/status') return ok({ trade: null });
  if (path === '/api/launchpad/trading/wallet') return ok({ wallet: { mode: 'external', address: SESSION_USER.mainWallet, available: true, nativeBalanceLamports: '4211000000', baseBalanceRaw: '0', baseDecimals: 6 } });
  return null;
}
// src/*-service.mjs publicStatus(): unauthenticated previews are allowed.
// v71.41: a Robinhood coin's pool (src/robinhood-launch/service.mjs coinView(): the state the tracking pass stores from the
// PoolManager and the numbers the shared pool maths derive from it). The preview coin is an ETH pair on the $4k tier with a
// few buys and one sell behind it; its price history is the sequence of swaps.
const RH = Object.freeze({ token: '0x5a3b7c9d1e2f4a6b8c0d2e4f6a8b0c2d4e6f8a1b', router: '0x4a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3e', poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951', locker: '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9', factory: '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0', escrow: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512', ethUsd: 3980.12 });
const RH_SUPPLY = 10n ** 27n, RH_VQ = 1086956521739130434n, RH_R = 2756015115144280021n;
let rhPoolCache = null;
function robinhoodPool() {
  if (rhPoolCache) return rhPoolCache;
  const supply = plannedSupply(RH_SUPPLY, RH_VQ, RH_R);
  const planned = planPositions({ tokenIs0: false, virtualQuote: RH_VQ, graduationQuote: RH_R, sellSupply: supply.sellSupply, lpSupply: supply.lpSupply, virtualToken: supply.virtualToken, tickSpacing: 10 });
  let pool = { ...planned, fee: 32500, tickSpacing: 10, crossed: false, graduated: false }, sqrt = planned.sqrtPriceX96;
  const now = Date.now(), wallets = ['0x9a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d', '0x7f6e5d4c3b2a19087f6e5d4c3b2a19087f6e5d4c', '0x1234567890abcdef1234567890abcdef12345678', '0x9a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d'];
  const swaps = [[true, 20n * 10n ** 16n], [true, 15n * 10n ** 16n], [true, 9n * 10n ** 16n], [false, 15n * 10n ** 24n], [true, 12n * 10n ** 16n], [true, 6n * 10n ** 16n]];
  const trades = [], history = [];
  swaps.forEach(([buy, amountIn], i) => {
    const q = quoteSwap({ ...pool, sqrtPriceX96: sqrt }, { buy, amountIn }); sqrt = q.sqrtPriceAfter;
    const at = now - (swaps.length - i) * 17 * 60000, block = 1200 + i * 7, price = poolPrice(sqrt, false);
    trades.push({ side: buy ? 'buy' : 'sell', wallet: wallets[i % wallets.length], quote: buy ? amountIn : q.amountOut, tokens: buy ? q.amountOut : amountIn, tx: '0x' + String(i + 1).padStart(64, 'a'), block, at, price: String(price) });
    history.push({ at, block, price: String(price) });
  });
  pool = { ...pool, sqrtPriceX96: sqrt, tick: tickAtSqrtPrice(sqrt), at: now - 20000 };
  const numbers = curveNumbers(pool, supply.sellSupply);
  rhPoolCache = { pool, supply, numbers, trades: trades.reverse(), history, price: poolPrice(sqrt, false) };
  return rhPoolCache;
}
const rhAmount = (raw, decimals = 18) => { const s = BigInt(raw).toString().padStart(decimals + 1, '0'); return (s.slice(0, -decimals) + '.' + s.slice(-decimals)).replace(/\.?0+$/, '') || '0'; };
// The public rows Explore shows (src/launchpad-explore.mjs robinhoodDiscoveryRecord() + robinhoodCoin()): two live coins,
// one graduated.
function robinhoodExploreCoins() {
  const { numbers, price, trades } = robinhoodPool(), now = Date.now(), usd = RH.ethUsd, priceUsd = Number(price) / 1e18 * usd;
  const links = token => robinhoodTradeLinks(token);
  const row = (token, name, symbol, quote, patch) => ({ mint: token, name, symbol, description: patch.description || '', image: image('coin:' + symbol), createdAt: patch.createdAt, chain: 'robinhood', platform: 'robinhood', launchMode: 'robinhood', quote, feeMode: patch.feeMode || 'creator', gotchi: null, agent: null, creatorFeeBps: patch.taxBps ? 0 : 50, creatorFeePolicy: null, postGradCreatorFeeBps: patch.taxBps ? 0 : 25, taxBps: patch.taxBps || 0, links: {}, curve: RH.poolManager, poolId: patch.poolId, href: '/coin?mint=' + token + '&chain=robinhood', coinUrl: '/coin?mint=' + token + '&chain=robinhood', explorerUrl: 'https://robinhoodchain.blockscout.com/token/' + token, tradeLinks: links(token), tier: patch.tier || '4k', rules: patch.rules || 0, status: patch.graduated ? 'graduated' : 'trading', creator: { username: patch.creator || 'orbit_gardener', href: '/u/' + (patch.creator || 'orbit_gardener') },
    trackedAthFdvUsd: patch.graduated ? Math.round(patch.marketCapUsd * 1.3) : null, trackedAthMarketCapUsd: patch.graduated ? Math.round(patch.marketCapUsd * 1.3) : null, athTrackedSince: patch.createdAt + 60000, athComplete: false, stage: patch.graduated ? 'graduated' : 'new', curveStatus: patch.graduated ? 'migrated' : 'curve', movingReason: !patch.graduated && patch.progressPercent >= 35 ? 'progress' : null, volumeAcceleration: null, lastBuyAt: patch.lastBuyAt, marketCapUsd: patch.marketCapUsd, fdvUsd: patch.marketCapUsd, priceUsd: patch.priceUsd, priceQuote: patch.priceQuote, fdvQuote: null,
    volume24h: patch.volume24h, volume24hQuote: patch.volume24hQuote, volumeObserved: null, volumeObservedQuote: null, volumeUsdEstimate: false, volumeSource: 'Launchpad trade journal', volumeAt: now - 12000, volumeComplete: true, buys24h: patch.buys24h, sells24h: patch.sells24h, liquidityUsd: null, priceChange24h: null, progressPercent: patch.graduated ? 100 : patch.progressPercent, holders: patch.holders, marketAt: now - 8000, marketSource: 'Uniswap v4 pool', stale: false, stageStale: false });
  const eth = { mint: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'Ether', category: 'crypto', kind: 'native', decimals: 18, logo: null };
  const pairs = robinhoodPairs(), tsla = pairs.find(p => p.symbol === 'TSLA') || pairs[1];
  const stockQuote = p => ({ mint: p.address, symbol: p.symbol, name: p.name, category: p.kind === 'stock' || p.kind === 'etf' ? 'stocks' : 'crypto', kind: p.kind, decimals: p.decimals, logo: p.logo || null });
  const volQuote = trades.reduce((sum, t) => sum + Number(rhAmount(t.quote)), 0);
  return [
    row(RH.token, 'Orbit Garden', 'ORBIT', eth, { description: 'A garden that grows with every trade on Robinhood Chain.', createdAt: now - 3 * HOUR, feeMode: 'holders', taxBps: 200, poolId: '0x' + hex64('pool:ORBIT'), progressPercent: numbers.progressBps / 100, marketCapUsd: Math.round(priceUsd * 1e9), priceUsd, priceQuote: Number(price) / 1e18, volume24h: Math.round(volQuote * usd), volume24hQuote: volQuote, buys24h: trades.filter(t => t.side === 'buy').length, sells24h: trades.filter(t => t.side === 'sell').length, holders: 3, lastBuyAt: trades.find(t => t.side === 'buy')?.at || now - 17 * MIN, rules: 1 }),
    row('0x' + hex64('rh:HOODIE').slice(0, 40), 'Hoodie Season', 'HOODIE', stockQuote(tsla), { description: 'Paired with tokenized TSLA.', createdAt: now - 26 * HOUR, poolId: '0x' + hex64('pool:HOODIE'), progressPercent: 61.4, marketCapUsd: 31200, priceUsd: 0.0000312, priceQuote: 0.0000312 / 412, volume24h: 9400, volume24hQuote: 9400 / 412, buys24h: 41, sells24h: 12, holders: 58, lastBuyAt: now - 6 * MIN, creator: 'hoodlum', tier: '20k' }),
    row('0x' + hex64('rh:GRADS').slice(0, 40), 'Graduates', 'GRADS', eth, { description: 'The first coin to fill its pool on Robinhood Chain.', createdAt: now - 4 * DAY, graduated: true, poolId: '0x' + hex64('pool:GRADS'), progressPercent: 100, marketCapUsd: 184000, priceUsd: 0.000184, priceQuote: 0.000184, volume24h: 22600, volume24hQuote: 22600, buys24h: 120, sells24h: 77, holders: 214, lastBuyAt: now - 2 * MIN, creator: 'dean' }),
  ];
}
function robinhoodPairs() {
  const stock = (symbol, name, usd, kind = 'stock') => { const address = '0x' + (symbol.toLowerCase().padEnd(40, '0')).replace(/[^0-9a-f]/g, 'a').slice(0, 40); return { address, symbol, name, decimals: 18, kind, native: false, usd, halted: false, logo: '/robinhood-pairs/logo/' + address }; };
  return [
    { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'Ether', decimals: 18, kind: 'native', native: true, usd: '3980.12', halted: false, logo: '' },
    { address: '0xe343167631d89b6ffc58b88d6b7fb0228795491d', symbol: 'USDG', name: 'Global Dollar', decimals: 6, kind: 'stable', native: false, usd: '1', halted: false, logo: '' },
    stock('NVDA', 'NVIDIA', '181.4'), stock('AAPL', 'Apple', '258.02'), stock('TSLA', 'Tesla', '429.83'), stock('MSFT', 'Microsoft', '517.95'), stock('AMZN', 'Amazon', '219.51'), stock('META', 'Meta Platforms', '710.52'), stock('GOOGL', 'Alphabet', '245.3'), stock('AMD', 'Advanced Micro Devices', '164.67'),
    stock('SPY', 'SPDR S&P 500 ETF', '669.21', 'etf'), stock('QQQ', 'Invesco QQQ Trust', '602.4', 'etf'), stock('IWM', 'iShares Russell 2000 ETF', '241.9', 'etf'), { ...stock('GME', 'GameStop', '27.1'), halted: true },
    { address: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', decimals: 8, kind: 'custom', native: false, usd: '112430', halted: false, logo: '' },
  ];
}
// v71.40: the Custom check (src/robinhood-launch/service.mjs pairCheck()).
function robinhoodPairCheck(address) {
  const a = String(address || '').toLowerCase(), listed = robinhoodPairs().find(p => p.address.toLowerCase() === a);
  if (listed) return { ...listed, status: listed.halted ? 'halted' : 'available', available: !listed.halted, reason: listed.halted ? listed.symbol + ' trading is halted right now.' : listed.symbol + ' is available as a pair.' };
  if (a.startsWith('0xaaaa')) return { address, symbol: 'WLFI', name: 'World Liberty Financial', decimals: 18, kind: 'custom', usd: '0.1842', priceSource: 'uniswap-v4 via USDG', status: 'unlisted', available: false, compatible: true, requested: true, reason: 'WLFI is a valid token with a Uniswap price on Robinhood Chain, but Launchpad has not added it yet. Your request has been sent to the operator.' };
  if (a.startsWith('0xbbbb')) return { address, symbol: 'DUST', name: 'Dust', decimals: 18, kind: 'custom', usd: null, status: 'unlisted', available: false, compatible: false, requested: true, reason: 'DUST is a valid token, but no Uniswap pool on Robinhood Chain prices it against USDG or ETH — Launchpad cannot run a market-cap tier on it until it has a price.' };
  return { address, status: 'invalid', available: false, compatible: false, reason: 'This address is not an ERC-20 token (it does not answer symbol, name, decimals and totalSupply).' };
}
function venueStatus(path) {
  if (path.endsWith('/damm-pump/status')) return ok({ available: false, publicEnabled: false, newLaunchesClosed: true, ownerPreview: false, reason: 'New Meteora → PumpSwap launches are closed. Launch on Pump.fun, Raydium or Meteora. Existing coins keep trading, and unfinished paid launches can still be completed.', blockers: [], pairs: [] });
  // v71.28: hooksEnabled + hookProgramId say that the host has deployed Launchpad's transfer hook program (LAUNCHPAD_HOOK_PROGRAM_ID).
  if (path.endsWith('/meteora/status')) return ok({ available: true, publicEnabled: true, ownerPreview: false, reason: '', blockers: [], hooksEnabled: process.env.PREVIEW_HOOKS !== 'off', hookProgramId: address('program:curve-hook') });
  // v71.18: native Pump.fun launches (src/pump-classic/service.mjs status()).
  if (path.endsWith('/pump-classic/status')) return ok({ available: true, venue: 'pump-classic', intakeOpen: true, pairsOpen: true, signedIn: true, modes: ['creator', 'holders', 'gotchi', 'agent', 'market_maker', 'lp_manager'].map(id => ({ id, label: id })), limits: { maxDevBuySol: 25, maxSeedSol: 50 }, feeLink: '/docs#revenue', quoteTtlMs: 600000, reason: '' });
  if (path.endsWith('/pump/status')) return ok({ available: false, publicEnabled: false, ownerPreview: false, reason: 'PumpSwap launches are paused for new coins.' });
  // v71.19: Pump.fun's own pairs (src/pump-classic/service.mjs pairs()): SOL, the listed quote and custom pairs, with Launchpad's support.
  if (path.endsWith('/pump-classic/pairs')) return ok({ available: true, solOnlyModes: ['agent', 'market_maker', 'lp_manager'], convertModes: ['holders', 'gotchi'], stale: false, at: Date.now(), pairs: pumpClassicPairs() });
  const venueAssets = LAUNCH_ASSETS.filter(a => ['crypto', 'stocks'].includes(a.category) && Number.isInteger(a.decimals ?? 6)).slice(0, 60).map(a => ({ ...a, decimals: a.decimals ?? (a.mint === SOL ? 9 : 8), launchReady: true, availability: 'available', compatibilityVerified: true }));
  if (path.endsWith('/pairs')) return ok({ pairs: [...venueAssets] });
  return null;
}

/** Sample Pump.fun pair list: SOL, USDC (listed) and tokenized stocks from the asset list as custom pairs. */
export function pumpClassicPairs() {
  const stocks = LAUNCH_ASSETS.filter(a => a.category === 'stocks' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a.mint)).slice(0, 8);
  return [
    { mint: SOL, symbol: 'SOL', name: 'Solana', issuer: 'Native', category: 'crypto', decimals: 9, program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', kind: 'sol', launchReady: true, convertible: true, supportReason: '', maxDevBuy: '25', creatorFee: null, pumpClassic: true },
    { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', name: 'USD Coin', issuer: 'Circle', category: 'crypto', decimals: 6, program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', kind: 'listed', launchReady: true, convertible: true, supportReason: '', maxDevBuy: '3750', creatorFee: null, pumpClassic: true },
    ...stocks.map((a, i) => ({ mint: a.mint, symbol: a.symbol, name: a.name, issuer: a.issuer || '', category: 'stocks', decimals: 8, program: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', kind: 'custom', launchReady: i !== 7, convertible: i < 5, supportReason: i === 7 ? 'This pair’s token runs a transfer hook program.' : '', maxDevBuy: i === 7 ? '0' : '1000', creatorFee: { maxBps: 500 }, pumpClassic: true })),
  ];
}

// ------------------------------------------------------------------ admin
function adminAccounts() {
  const rows = [...USERS.map(u => account(u, u.username === 'launchpad' ? { authType: 'password', signInWallet: '', role: 'admin', mfaEnabled: true } : {})), sessionFor('admin').account];
  for (let i = 0; i < 26; i++) { const name = ['nova', 'quill', 'birch', 'atlas', 'sable', 'juniper', 'orbit', 'cinder', 'marlow'][i % 9] + '_' + (100 + i * 7); rows.push(account({ id: hex64('acct:' + name).slice(0, 32), username: name, bio: '', avatar: null, mainWallet: address('wallet:' + name), createdAt: Date.UTC(2026, 8, 25) + i * HOUR }, i % 4 === 0 ? { authType: 'password', signInWallet: '' } : i === 7 ? { banned: true } : {})); }
  return rows;
}
const adminLaunchRows = () => coins().map((c, i) => {
  const route = c.platform === 'raydium' ? undefined : c.platform, u = USERS.find(x => x.username === c.creator.username);
  return { accountId: u.id, id: hex64('launch:' + c.symbol).slice(0, 32), route, name: c.name, symbol: c.symbol, mint: c.mint, username: u.username, recipient: u.mainWallet, feeMode: c.feeMode === 'none' ? 'creator' : c.feeMode, state: 'live', hidden: i === 12, manuallyArchived: false, canArchive: false, canRestore: false,
    eligibility: c.feeMode === 'creator' && c.platform === 'raydium' ? { allowed: true, reason: '' } : { allowed: false, reason: c.feeMode === 'holders' ? 'Creator fees are paid to holders.' : c.feeMode === 'buyback' ? 'Creator fees fund automatic buybacks.' : 'Recipient changes are not available for this launch mode.' }, history: [],
    ...(c.feeMode === 'holders' && c.platform === 'raydium' ? { rewardsAction: { kind: 'distribute', allowed: true, autoFees: true, reason: '' }, rewardsAutomation: { allowed: true, enabled: true, reason: '', needed: false, pending: false } } : {}),
    // v71.24 preview: the official LAUNCHPAD coin keeps its collected tax for a manual burn.
    ...(c.symbol === 'LAUNCHPAD' ? { feeMode: 'holders', quoteSymbol: 'SOL', rewardsAction: { kind: 'distribute', allowed: true, autoFees: true, reason: '' }, rewardsAutomation: { allowed: true, enabled: true, reason: '', needed: false, pending: false, pauseAllowed: true }, rewardsWallet: { status: 'active', address: 'Bz3zS37oQ3vm8itxXxsXGJPKyQnHii3xMroaA9hZCwEb' }, credits: { quote: '0.84', base: '1234.5' },
      taxBurn: { policy: 'official-token-tax-burn-v1', selected: true, enabled: true, automatic: false, manual: true, manualRequested: false, paused: false, tokensBurned: '50000000', pendingTaxTokens: '1234.5', unattributedTokens: '0', completedBurns: 3, lastBurnSignature: null, lastBurnAt: null, accountingUnavailable: false, initialInventory: { approvedTokens: '50000000', status: 'burned', completedAt: Date.now() - 86400000, signature: null } }, taxMaintenance: { version: 1, nextAt: Date.now() + 45000 } } : {}) };
});
function adminLaunches(params) {
  const view = params.get('view') || 'active', search = (params.get('search') || '').toLowerCase(), offset = Number(params.get('offset') || 0);
  const all = adminLaunchRows().filter(r => !search || `${r.name} ${r.symbol} ${r.mint} ${r.username}`.toLowerCase().includes(search)), archived = r => r.hidden || r.manuallyArchived;
  const rows = all.filter(r => archived(r) === (view === 'archived'));
  return { launches: rows.slice(offset, offset + 10).map(r => ({ ...r, listArchived: archived(r) })), view, counts: { active: all.filter(r => !archived(r)).length, archived: all.filter(archived).length }, total: rows.length, offset, nextOffset: offset + 10 < rows.length ? offset + 10 : null };
}
const POLICY = () => ({ recipient: address('wallet:protocol'), curveFeeBps: 100, creationFeeSol: '0.015', autoHarvest: true, configured: true, lpPolicy: 'platform_locked', platformLpPercent: 75 });
const protocolCoins = () => coins().filter(c => c.platform === 'raydium').map((c, i) => ({ policyTarget: { upgradeVersion: 3, curveFeeBps: 100, lpPolicy: 'platform_locked', platformLpPercent: 75, creatorFeePolicy: 'flat-0.5-v2', creatorFeeRatePpm: 5000 }, accountId: USERS.find(u => u.username === c.creator.username).id, id: hex64('launch:' + c.symbol).slice(0, 32), name: c.name, symbol: c.symbol, mint: c.mint, quoteSymbol: c.quote.symbol, platformFeeBps: 100, recipient: POLICY().recipient, eligibility: { allowed: true, reason: '' }, activation: { allowed: false, reason: 'Already active.' }, policyCurrent: i % 4 !== 1, creatorFeeRatePpm: 5000, lpPolicy: i % 4 !== 1 ? { lpPolicy: 'platform_locked', platformLpPercent: 75 } : { lpPolicy: 'burn' }, collecting: (12.5 / (i + 1)).toFixed(4), claimed: (40 * (i + 1) / 3).toFixed(4), paid: (27.5 * (i + 1) / 3).toFixed(4), operations: [] }));
function adminVolume() {
  const all = coins(), now = Date.now();
  const rows = all.map((c, i) => ({ mint: c.mint, name: c.name, symbol: c.symbol, quote: { mint: c.quote.mint, symbol: c.quote.symbol }, hidden: i === 12, archived: false, volume24hUsd: c.volume24h, observedVolumeUsd: c.volume24h, volume24hQuote: c.volume24h / (QUOTE_USD[c.quote.mint] || 1), observedVolumeQuote: c.volume24h / (QUOTE_USD[c.quote.mint] || 1), complete: true, status: 'available', source: c.volumeSource }));
  const byQuote = new Map(); for (const r of rows) { const q = byQuote.get(r.quote.mint) || { mint: r.quote.mint, symbol: r.quote.symbol, volume24hQuote: 0, observedVolumeQuote: 0, coins: 0, complete: true }; q.volume24hQuote += r.volume24hQuote; q.observedVolumeQuote += r.observedVolumeQuote; q.coins++; byQuote.set(r.quote.mint, q); }
  const total = rows.reduce((s, r) => s + r.volume24hUsd, 0);
  // src/admin-volume.mjs + public-lifetime-volume.mjs `lifetime` projection.
  const lifetime = { status: 'available', period: 'lifetime', scope: 'launch-curves', recordedVolumeUsdEstimate: 18_942_772.12, pricedVolumeUsdEstimate: 18_942_772.12, tradeCount: 184_220, refreshing: false, updatedAt: now - 60000,
    quoteTotals: [{ symbol: 'SOL', amount: '21844.214112', usdEstimate: 3_328_412.1, priced: true }, { symbol: 'USDC', amount: '1022451.21', usdEstimate: 1_022_451.21, priced: true }, { symbol: 'NVDAx', amount: '1180.4', usdEstimate: 213_912.08, priced: true }, { symbol: 'SPYx', amount: '294.1', usdEstimate: 168_019.3, priced: true }],
    coverage: { launches: 214, backfilledLaunches: 214, recordedLaunches: 214, unpricedQuotes: 0, inventoryComplete: true, historyComplete: true, postGraduationIncluded: true } };
  return { at: now - 15000, refreshMs: 60000, period: '24h', lifetime, volumeUsd: total, observedVolumeUsd: total, lifetimeVolumeUsd: 18_942_772.12, coverage: { launches: rows.length, complete: rows.length, usdComplete: rows.length, partial: 0, unavailable: 0, unpriced: 0, inventoryComplete: true }, quoteTotals: [...byQuote.values()], coins: rows };
}
const solAsset = (gross, net, paid) => ({ scope: 'launchpad', chain: 'solana', symbol: 'SOL', mint: SOL, decimals: 9, grossAmount: gross, cashbackAmount: '0', netAmount: net, paidAmount: paid, pendingAmount: String(BigInt(net) - BigInt(paid)), cashbackPendingAmount: '0' });
function adminRevenue() {
  const total = solAsset('1224500000000', '1224500000000', '1198200000000'), usdc = { ...solAsset('0', '0', '0'), symbol: 'USDC', mint: USDC, decimals: 6, grossAmount: '84211000000', netAmount: '84211000000', paidAmount: '80100000000', pendingAmount: '4111000000' };
  return { at: Date.now() - 30000, coverage: 'recorded-confirmed-history', note: 'Confirmed receipts only. Fees still accruing onchain appear after collection.', totals: [total, usdc],
    products: [{ id: 'creation', scope: 'launchpad', label: 'Creation fee', feeLabel: '0.015 SOL', feeBasis: 'per completed launch', status: 'available', totals: [solAsset('3210000000', '3210000000', '3210000000')] },
      { id: 'swap', scope: 'launchpad', label: 'Launchpad protocol fee', feeLabel: '1%', feeBasis: 'of bonding-curve buys and sells', status: 'available', totals: [solAsset('884100000000', '884100000000', '871000000000'), usdc] },
      { id: 'tax', scope: 'launchpad', label: 'Transfer tax', feeLabel: '5%', feeBasis: 'of collected transfer taxes', status: 'partial', totals: [{ ...solAsset('41200000000', '41200000000', '41200000000'), paidAmount: null, pendingAmount: null }], note: 'Historical receipts may be incomplete.' },
      { id: 'lp', scope: 'launchpad', label: 'Locked LP yield', feeLabel: '75%', feeBasis: 'of the launchpad LP fee entitlement', status: 'available', totals: [solAsset('295990000000', '295990000000', '282790000000')] }] };
}
function adminRevenueAudit() {
  const wallet = POLICY().recipient, now = Date.now();
  return { version: 1, generatedAt: now - 45000, evidence: 'saved-records', liveChainVerified: false, policy: { recipient: wallet, creationFeeSol: '0.015', curveFeeBps: 100, taxRevenueShareBps: 500, autoHarvest: true, lpPolicy: 'locked-75-burned-25', platformLpPercent: 75 }, treasury: { configured: true, enabled: true, address: address('wallet:treasury'), recipientMatches: true, previousRecipients: [], pending: null },
    summary: { launches: coins().length, legacyLaunches: 1, pendingOperations: 1, untrackedCreationReceipts: 0, attentionCount: 1 }, totals: [{ mint: SOL, symbol: 'SOL', decimals: 9, recipient: wallet, kind: 'tax-protocol-payout', amount: '41200000000', receipts: 38, currentRecipient: true }, { mint: SOL, symbol: 'SOL', decimals: 9, recipient: wallet, kind: 'creation', amount: '3210000000', receipts: 214, currentRecipient: true }],
    coins: coins().filter(c => c.platform === 'raydium').map((c, i) => ({ id: hex64('launch:' + c.symbol).slice(0, 32), accountId: 'owner', name: c.name, symbol: c.symbol, mint: c.mint, quoteMint: c.quote.mint, quoteSymbol: c.quote.symbol, quoteDecimals: c.quote.decimals, baseDecimals: 6, platformFeeBps: 100, protocolWallet: wallet, recipient: wallet, autoHarvest: true, lpPolicy: 'locked-75-burned-25', protocolCredit: String(10000000 * (i + 1)), protocolBaseCredit: '0', taxProtocolCredit: c.taxBps ? '2500000' : '0', pending: i === 0 ? [{ kind: 'tax-protocol-payout', signature: signature('audit:pending'), state: 'pending', createdAt: now - 4 * MIN }] : [], issues: i === 1 ? ['legacy_launch'] : [] })),
    issues: [{ code: 'legacy_launch', scope: 'coin', count: 1 }] };
}
function adminTreasury() {
  const wallet = address('wallet:treasury'), now = Date.now();
  return { version: 1, configured: true, enabled: true, address: wallet, recipient: POLICY().recipient, expectedRecipient: POLICY().recipient, previousRecipients: [], curveMint: LAUNCHPAD_MINT, curveDecimals: 6,
    totals: { receivedSol: '1224500000000', convertedSol: '1182000000000', buybackAvailable: '8420000000', retainedSol: '591000000000', buybackSpent: '412750000000', curveBurned: '41250000000000', burnAvailable: '3870000000000', networkSpent: '18250000', withdrawnSol: '6800000000' },
    availableRetainedSol: '584200000000', pendingWithdrawal: null,
    assets: [{ symbol: 'USDC', mint: USDC, decimals: 6, received: '84211000000', credit: '4111000000', converted: '80100000000', error: '', nextAttemptAt: now + 6 * MIN }, { symbol: 'NVDAx', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', decimals: 8, received: '42100000', credit: '0', converted: '42100000', error: '', nextAttemptAt: null }],
    recognitionAssets: [{ mint: SOL, symbol: 'SOL', decimals: 9 }, { mint: USDC, symbol: 'USDC', decimals: 6 }], pending: null,
    history: [0, 1, 2, 3].map(i => ({ kind: i % 2 ? 'burn' : 'buy', signature: signature('treasury:' + i), state: 'confirmed', confirmedAt: now - (i + 1) * 3 * HOUR })), updatedAt: now - 60000,
    walletBalance: { status: 'available', address: wallet, lamports: '618420000000', observedAt: now - 5000, slot: 391204000, commitment: 'finalized' },
    // A white-label launchpad's managed treasury (src/tenant/treasury.mjs view): the platform share and no buybacks.
    ...(process.env.PREVIEW_PRODUCT === 'tenant' ? { managed: true, signerOrigin: 'server-generated', ownerControlled: false, totals: { receivedSol: '84250000000', convertedSol: '12100000000', buybackAvailable: '0', retainedSol: '75791000000', buybackSpent: '0', curveBurned: '0', burnAvailable: '0', networkSpent: '34000', withdrawnSol: '20000000000' }, availableRetainedSol: '55776000000', history: [0, 1, 2].map(i => ({ kind: i ? 'convert' : 'withdraw', signature: signature('tenant:' + i), state: 'confirmed', confirmedAt: now - (i + 1) * 5 * HOUR })), platform: { wallet: address('wallet:platform'), bps: 1000, minimumLamports: '50000000', accrued: '8425000000', paid: '8400000000', owed: '25000000', payouts: [0, 1, 2].map(i => ({ signature: signature('payout:' + i), amount: String(2800000000), recipient: address('wallet:platform'), at: now - (i + 1) * 86400000 })), retry: null } } : {}) };
}
function adminGas() {
  const now = Date.now(), wallet = address('wallet:gas');
  return { version: 1, configured: true, address: wallet, enabled: true, policy: { lowWaterLamports: '5000000', targetLamports: '20000000', maxRefillLamports: '20000000', dailyLimitLamports: '100000000', dailyNetworkLimitLamports: '20000000', cooldownMs: 3600000, reserveLamports: '10000000', maximumOperationCostLamports: '5000000' },
    balanceLamports: '2840000000', balanceAt: now - 40000, lowBalance: false, error: '', pending: null, totals: { refilledLamports: '845000000', networkSpentLamports: '210000' }, day: { date: new Date(now).toISOString().slice(0, 10), spentLamports: '38000000', reservedLamports: '0', networkSpentLamports: '10000', reservedNetworkLamports: '0' },
    targets: [{ address: address('wallet:rewards'), roles: ['rewards'], balanceLamports: '18500000', checkedAt: now - 50000, lastRefillAt: now - 5 * HOUR, nextEligibleAt: null, status: 'ready' }, { address: address('wallet:relayer'), roles: ['relayer'], balanceLamports: '4200000', checkedAt: now - 50000, lastRefillAt: now - 26 * HOUR, nextEligibleAt: now + 12 * MIN, status: 'cooldown' }, { address: address('wallet:treasury'), roles: ['treasury'], balanceLamports: '91000000', checkedAt: now - 50000, lastRefillAt: null, nextEligibleAt: null, status: 'ready' }],
    history: [0, 1, 2].map(i => ({ signature: signature('gas:' + i), recipient: address(i ? 'wallet:relayer' : 'wallet:rewards'), amountLamports: '19000000', state: 'confirmed', at: now - (i + 1) * 5 * HOUR })) };
}
function adminBurnHistory() { const now = Date.now(); return { history: [{ kind: 'burn', signature: signature('admin-burn:1'), inputAmount: '50000000000000', outputAmount: '0', curveDecimals: 6, confirmedAt: now - 2 * DAY, source: 'admin' }, { kind: 'buy', signature: signature('admin-buy:1'), inputAmount: '9120000000', outputAmount: '91521348000001', curveDecimals: 6, confirmedAt: now - 2 * DAY - 60000, source: 'admin' }] }; }
function adminPairs() { return { revision: 4, assets: ['STONK', 'FARTCOIN', 'CATE'].map(s => LAUNCH_ASSETS.find(a => a.symbol === s)).filter(Boolean).map(a => ({ ...a, supported: true })).concat([{ mint: address('mint:custompair'), name: 'Lumen Index', symbol: 'LUMEN', category: 'custom', logoPath: image('pair:LUMEN'), supported: true }]) }; }
function adminBranding() { return { brand: { name: 'Launchpad', web: 'https://launchpad.example', img: 'https://launchpad.example/brand-avatar.png' }, requiresPublishedLogo: true, coins: coins().filter(c => c.platform === 'raydium').slice(0, 4).map((c, i) => ({ accountId: USERS.find(u => u.username === c.creator.username).id, id: hex64('launch:' + c.symbol).slice(0, 32), name: c.name, symbol: c.symbol, mint: c.mint, currentBrand: i ? { name: 'Launchpad', web: 'https://launchpad.example' } : { name: 'Previous name', web: 'https://previous.example' }, status: ['legacy', 'updated', 'pending', 'updated'][i], signature: i ? signature('brand:' + i) : undefined, eligibility: i ? { allowed: false, reason: 'Already uses Launchpad attribution.' } : { allowed: true, reason: '' } })) }; }
function adminHealth() {
  return { requests: { active: 7, failed: 12, p95Ms: 251 }, eventLoop: { p95Ms: 23, maxMs: 190 }, memory: { rssBytes: 412 * 1048576 }, services: { tradeRecovery: 'ok' }, capacity: { rpcRequestsPerSecond: 200, sendRequestsPerSecond: 50, jupiterRequestsPerSecond: 10 },
    data: { market: { responses: 18421, unavailable: 3, stale: 8 }, holders: { responses: 2210, unavailable: 2, stale: 5 } }, routes: { meteoraStatus: { completed: 880, failed: 4, rateLimited: 2, unavailable: 1, p95Ms: 412, sampleSize: 880 } }, maxUsers: 1000 };
}
function dammPumpAdmin(path) {
  // public/admin-pump-deployment-ui.mjs only accepts its hard-coded owner wallet.
  const A = '7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS', R = address('wallet:relayer'), programId = address('program:damm-controller');
  if (path.endsWith('/deployment/status')) return { operator: A, stage: 'deployed', verifiedDeployment: true, uploadedChunks: 48, totalChunks: 48, estimatedRentLamports: '2841920000', programId };
  if (path.includes('/configuration/')) return { operator: A, configured: true, chainEnabled: true, canPrepare: true, programId, relayer: R };
  return { configured: true, publicEnabled: true, ready: true, programId, relayer: R, relayerBalanceLamports: '30000000', relayerMinimumBalanceLamports: '1000000', recommendedBalanceLamports: '30000000', blockers: [] };
}
const meteoraAdmin = () => ({ configured: true, publicEnabled: true, canEnable: true, authority: address('wallet:meteora-authority'), treasury: address('wallet:treasury'), balanceLamports: '120000000', minimumBalanceLamports: '100000000', pairSummary: { available: 432, complete: true }, blockers: [] });

// v71.20: src/vanity-pool.mjs snapshot() — addresses only, never keys.
const adminVanity = () => {
  const now = Date.now(), vanity = seed => address('vanity:' + seed).slice(0, 39) + 'pump', named = coins().slice(0, 3);
  const pool = Array.from({ length: 9 }, (_, i) => ({ address: vanity('pool:' + i), scope: i < 4 ? 'pump' : 'all', addedAt: now - 86400000 + i * 1000, state: i === 0 ? 'reserved' : 'available', ...(i === 0 ? { venue: 'raydium', until: now + 420000 } : {}) }));
  const used = named.map((c, i) => ({ address: vanity('used:' + i), scope: 'all', addedAt: now - 172800000, state: 'used', venue: ['pump', 'raydium', 'meteora'][i % 3], at: now - (i + 1) * 3600000, name: c.name, symbol: c.symbol, reason: '', onChain: i !== 2 }));
  used.push({ address: vanity('skipped'), scope: 'all', addedAt: now - 172800000, state: 'skipped', venue: 'pump', at: now - 7200000, name: '', symbol: '', reason: 'An account already exists at this address, so it cannot become a coin.' });
  return { version: 1, at: now, lowWater: 10, labels: { all: 'Every launch', pump: 'Pump.fun', raydium: 'Raydium', meteora: 'Meteora' }, scopes: ['all', 'pump', 'raydium', 'meteora'],
    counts: { available: 8, byScope: { all: 5, pump: 3, raydium: 0, meteora: 0 }, forVenue: { pump: 8, raydium: 5, meteora: 5 }, reserved: 1, used: 3, skipped: 1 }, low: ['pump', 'raydium', 'meteora'],
    fallbacks: { total: 1, sinceImport: 0, lastAt: now - 90000000, lastVenue: 'meteora' }, pool, poolTotal: pool.length, used, usedTotal: used.length,
    events: [{ at: now - 3600000, kind: 'used', text: `${used[0].address} used by $${used[0].symbol} on Pump.fun.` }, { at: now - 86400000, kind: 'import', text: '12 addresses added for every launch.' }] };
};

function adminApi(method, path, params) {
  if (method !== 'GET') return null;
  const map = {
    '/api/admin/overview': () => ({ counts: { accounts: adminAccounts().length, launches: 214, holderLaunches: 38, buybackLaunches: 6 } }),
    '/api/admin/volume': adminVolume, '/api/admin/health': adminHealth, '/api/admin/accounts': () => ({ accounts: adminAccounts() }),
    '/api/admin/protocol-fees': POLICY, '/api/admin/protocol-fees/coins': () => ({ coins: protocolCoins() }),
    '/api/admin/protocol-treasury': adminTreasury, '/api/admin/protocol-gas-funding': adminGas, '/api/admin/burn-history': adminBurnHistory, '/api/admin/gotchi': gotchiAdmin,
    '/api/admin/revenue': adminRevenue, '/api/admin/revenue-audit': adminRevenueAudit, '/api/admin/pairs': adminPairs, '/api/admin/branding': adminBranding,
    '/api/admin/agents': agentAdmin, '/api/admin/agents/health': agentHealth, '/api/admin/vanity': adminVanity,
    // v71.39: src/robinhood-launch/service.mjs adminOverview().
    '/api/admin/robinhood': () => { const now = Date.now(), token = '0x5a3b7c9d1e2f4a6b8c0d2e4f6a8b0c2d4e6f8a1b'; return { available: true, configured: true, flags: { intake: true, pairs: false, collection: true, routing: true, holders: true }, effective: { master: true, intake: true, pairs: false, collection: true, routing: true, holders: true }, policy: { version: 'robinhood-launch-v1', hash: 'ab12', tiers: ['4k', '20k'] },
      contracts: { factory: '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0', escrow: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512', locker: '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9', engine: '0xdc64a140aa3e981100a9beca4e685f962f0cf6c9', payouts: '0xa513e6e4b8f2a923d98304ec87f64353c4d5c853' }, treasury: '0x00000000000000000000000000000000000000fe',
      host: { owner: '0x1111111111111111111111111111111111111111', platform: '0x2222222222222222222222222222222222222222', balances: { owner: '0.4821', platform: '0.0512', platformEscrow: '0.0073' } },
      factory: { owner: '0x1111111111111111111111111111111111111111', pendingOwner: '0x0000000000000000000000000000000000000000', ownerIsHost: true, launchesOpen: true, launchFee: '0.001', platformRecipient: '0x2222222222222222222222222222222222222222', platformIsHost: true, config: { totalSupply: '1000000000000000000000000000', curveProtocolFeeBps: 125, curveCreatorFeeBps: 50, poolProtocolFeeBps: 25, poolCreatorFeeBps: 25, taxPlatformShareBps: 500, minTaxBps: 100, maxTaxBps: 300, defaultTaxBps: 200, tickSpacing: 10, enabled: true }, blockers: [] }, factoryError: '',
      pairRequests: [{ address: '0xAaAa0000000000000000000000000000000000Aa', symbol: 'WLFI', name: 'World Liberty Financial', decimals: 18, usd: '0.1842', compatible: true, count: 3, accounts: ['acct1', 'acct2'], firstAt: now - 7200000, lastAt: now - 600000 }, { address: '0xBbBb0000000000000000000000000000000000Bb', symbol: 'DUST', name: 'Dust', decimals: 18, usd: null, compatible: false, count: 1, accounts: ['acct3'], firstAt: now - 3600000, lastAt: now - 3600000 }],
      pairs: [{ address: '0xCbB7C0000aB88b473B1F5aFd9EF808440eEd33Bf', symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', kind: 'custom', decimals: 8, approved: false, enabled: false }, { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', name: 'Ether', kind: 'native', decimals: 18, approved: true, enabled: true, approved_at: now - 86400000 }, { address: '0xE343167631d89B6fFc58B88d6b7FB0228795491D', symbol: 'USDG', name: 'Global Dollar', kind: 'stable', decimals: 6, approved: true, enabled: true, approved_at: now - 86400000 }, { address: '0xAaAa000000000000000000000000000000000001', symbol: 'NVDA', name: 'NVIDIA', kind: 'stock', decimals: 18, approved: true, enabled: false, approved_at: now - 3600000 }, { address: '0xAaAa000000000000000000000000000000000002', symbol: 'AAPL', name: 'Apple', kind: 'stock', decimals: 18, approved: false, enabled: false, approved_at: null }],
      lastPassAt: now - 12000, lastError: null, passes: 412, db: { version: 1, ok: true }, counts: { created: 1, awaiting_funding: 1 }, total: 2, offset: 0, limit: 25,
      rows: [{ id: 'ab12cd34ef56ab12cd34ef56', state: 'created', stateLabel: 'Live on Robinhood Chain', reason: '', mode: 'holders', modeLabel: 'Holders', paysHolders: true, name: 'Orbit Garden', symbol: 'ORBIT', token, predictedToken: token, curve: '0x1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d', dimensions: { launch: 'live', fees: 'verified', venue: 'curve', refund: 'complete' }, pair: { symbol: 'ETH', decimals: 18, kind: 'native' }, tier: { id: '4k', label: '$4k start' }, taxBps: 200, fees: { ...robinhoodFeesFor(200), stage: 'curve', curveFeePips: 32500, poolFeePips: 25000, creatorShape: false, curvePoolId: null }, rules: 1, liveAt: now - 3 * 3600000, createdAt: now - 3 * 3600000 - 120000, venueState: 'curve', hidden: false, archived: false, createAttempts: 1, holders: 3,
          developerWallet: '0x9a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d', launchWallet: '0x3333333333333333333333333333333333333333', feeWallet: '0x4444444444444444444444444444444444444444', quote: { launchFeeEth: '0.001', devBuy: '0.05', devBuySymbol: 'ETH', gasBudgetEth: '0.0014', feeWalletGasEth: '0.001', totalEth: '0.0534', pairUsd: '3980.12' },
          balances: [{ role: 'rewards', asset: '0x0000000000000000000000000000000000000000', available: '0.0028', credited: '0.0091' }, { role: 'gas', asset: '0x0000000000000000000000000000000000000000', available: '0.00094', credited: '0.001' }], openOperations: [], events: [{ at: now - 50 * 60000, title: 'Holder rewards paid', body: '0.0063 ETH to 3 holders.', txHash: '0x' + 'c'.repeat(64) }, { at: now - 3 * 3600000, title: 'Coin created on Robinhood Chain', body: 'ORBIT trades on its curve against ETH.', txHash: '0x' + 'd'.repeat(64) }],
          holderPayout: { asset: 'ETH', thresholdUsd: 100, held: '0.0028', open: null, last: { at: now - 50 * 60000, source: 'auto', state: 'frozen', recipients: 3, amount: '6300000000000000' } }, feeClaims: [{ kind: 'escrow-claim', role: 'rewards', amount: '0.0091', tx: '0x' + 'e'.repeat(64), block: 1210 }] },
        { id: 'ab12cd34ef56ab12cd34ef57', state: 'awaiting_funding', stateLabel: 'Waiting for funding', reason: '', mode: 'creator', modeLabel: 'Creator', paysHolders: false, name: 'Harbor Light', symbol: 'HARBR', token: null, predictedToken: '0x6b4c7d9e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c', dimensions: { launch: 'awaiting_funding', fees: 'pending', venue: 'none', refund: 'none' }, pair: { symbol: 'NVDA', decimals: 18, kind: 'stock' }, tier: { id: '20k', label: '$20k start' }, taxBps: 0, fees: { ...robinhoodFeesFor(0), stage: 'curve', curveFeePips: 17500, poolFeePips: 5000, creatorShape: true, curvePoolId: null }, rules: 0, liveAt: null, createdAt: now - 4 * 60000, venueState: 'none', hidden: false, archived: false, createAttempts: 0, holders: 0,
          developerWallet: '0x7f6e5d4c3b2a19087f6e5d4c3b2a19087f6e5d4c', launchWallet: '0x5555555555555555555555555555555555555555', feeWallet: null, quote: { launchFeeEth: '0.001', devBuy: '2', devBuySymbol: 'NVDA', gasBudgetEth: '0.0014', feeWalletGasEth: '0', totalEth: '0.0024', pairUsd: '181.4' }, balances: [], openOperations: [], events: [{ at: now - 4 * 60000, title: 'Launch quoted', body: '$20k start on NVDA, Creator.' }], holderPayout: null, feeClaims: [] }] }; },
    // v71.18: src/pump-classic/service.mjs adminOverview() (no key material, no share percentages shown).
    '/api/admin/pump-classic': () => { const now = Date.now(), c = coins().find(x => x.platform === 'pump-classic'); return { available: true, flags: { intake: true, collection: true, routing: true, holders: false, strategies: true }, flagLabels: { intake: 'New launches and coin creation', collection: 'Creator-fee collection', routing: 'Sweeps to the treasury, Gotchi pots and agents', holders: 'Holder reward payouts', strategies: 'Market Maker and Liquidity Manager trading' }, effective: { master: true, intake: true, collection: true, routing: true, holders: false, strategies: true }, policy: { version: 'pump-classic-policy-v1', hash: hex64('policy') }, lastPassAt: now - 12000, lastError: '', database: { ok: true, version: 1 },
      launches: c ? [{ id: 'c0ffee'.repeat(4), state: 'created', stateLabel: 'Live on Pump.fun', reason: '', mode: 'market_maker', modeLabel: 'Market Maker', name: c.name, symbol: c.symbol, mint: c.mint, dimensions: { launch: 'created', delivery: 'complete', fees: 'verified', venue: 'curve', refund: 'complete' }, developerWallet: address('dev:' + c.symbol), launchWallet: address('launchw:' + c.symbol), protocolWallet: address('platform:' + c.symbol), modeWallet: address('strategy:' + c.symbol), recipient: address('strategy:' + c.symbol), hidden: false, policyVersion: 'pump-classic-policy-v1', createAttempts: 1,
        balances: { protocol: { credited: '0.2568', debited: '0.2', costs: '0.00001' }, strategy: { credited: '1.0272', debited: '0', costs: '0.00041' } }, feeTotals: { protocol: '0.2568', strategy: '1.0272' }, strategy: { kind: 'market_maker', label: 'Market Maker', status: 'active', statusLabel: 'Active', wallet: address('strategy:' + c.symbol), cashSol: '1.4021', tokens: '41000000000000', lp: '0', contributedSol: '2.0272', equitySol: '2.0911', resultSol: '0.0639', feesSpentSol: '0.00041', lastActionAt: now - 540000, pauseReason: '' }, openOperations: [], events: [{ kind: 'strategy', title: 'Market Maker sold', body: '1,204,331.5 ORBIT for 0.0412 SOL.', signature: signature('mm1:' + c.symbol), at: now - 540000 }, { kind: 'fees', title: 'Creator fees distributed', body: 'Collected by Launchpad.', signature: signature('fee1:' + c.symbol), at: now - 2400000 }] }] : [] }; },
    '/api/admin/holder-distributions': () => ({ job: null }), '/api/admin/reward-sweeps': () => ({ job: null }), '/api/admin/failed-launch-archive': () => ({ preview: { count: 0, reasons: [] } }),
    '/api/admin/launches': () => adminLaunches(params), '/api/admin/launchpad/capabilities': () => ({ adjustableMarketCap: true }),
    '/api/admin/meteora/status': meteoraAdmin, '/api/admin/meteora/pairs': () => ({ pairs: [] }),
    '/api/admin/pump-public/status': () => ({ configured: true, publicEnabled: false, ready: true, canEnable: true, relayer: address('wallet:relayer'), relayerBalanceLamports: '10000000', relayerMinimumBalanceLamports: '1000000', recommendedBalanceLamports: '10000000' }),
    '/api/admin/pump-test': () => ({ mode: 'local-test', network: 'none', fundedLaunchEnabled: false, publicLaunchEnabled: false, verification: { model: 'passed', custody: 'passed', migration: 'passed', lpBurn: 'passed', independentAudit: 'pending' }, blockers: ['An independent audit has not been recorded.'] }),
    '/api/admin/pump-test/pairs': () => ({ mode: 'local-test', pairs: [] }),
  };
  if (map[path]) return ok(map[path]());
  if (path.startsWith('/api/admin/damm-pump/')) return ok(dammPumpAdmin(path));
  // Legacy owner tools (Launch modes → "Existing Pump launches and owner test tools"
  // and "Admin test"), shapes from test/admin-pump-*-ui and admin-damm-pump-test-ui.
  const OWNER = '7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS', R = address('wallet:relayer'), programId = address('program:pump-public');
  if (/^\/api\/admin\/(pump-test|pump-public|damm-pump-test)\/deployment\/status$/.test(path)) return ok({ operator: OWNER, stage: 'deployed', verifiedDeployment: true, uploadedChunks: 189, totalChunks: 189, estimatedRentLamports: '863523800', programId });
  if (/^\/api\/admin\/(pump-public|damm-pump-test)\/configuration\/status$/.test(path)) return ok({ operator: OWNER, configured: true, chainEnabled: path.includes('pump-public'), canPrepare: true, programId, relayer: R });
  if (path === '/api/admin/pump-test/funded/status') return ok({ enabled: true, verifiedDeployment: true, operator: OWNER, treasury: address('wallet:treasury'), quoteMint: SOL, preset: 'micro-test', cluster: 'mainnet-beta', phase: 'uninitialized', actions: ['initialize'], activeOperation: null, blockers: [] });
  if (path === '/api/admin/damm-pump-test/status') return ok({ adminTest: true, available: true, publicEnabled: true, configured: true, defaults: { graduationFeeNumerator: '322369073', graduationFeeDenominator: '1000000000', initialFdvUsd: 50, graduationFdvUsd: 100 }, pairs: [{ mint: SOL, decimals: 9, symbol: 'SOL', launchReady: true }, { mint: USDC, decimals: 6, symbol: 'USDC', launchReady: true }], ownerWallet: OWNER, programId, relayer: R, relayerBalanceLamports: '50000000', recommendedBalanceLamports: '50000000' });
  if (path === '/api/admin/damm-pump-test/launches') return ok([]);
  if (path === '/api/admin/damm-pump-test/operations') return ok({ operations: [] });
  return null;
}

// ------------------------------------------------------------------ dispatch
/** Returns {status, body} or null when the route is not mocked. Mirrors the
 * real gate order in src/account-app.mjs (allowlist → public → session → admin). */
export function handleApi({ method, path, params, mode, body }) {
  const session = sessionFor(mode);
  if (!launchpadApi(path)) return err(404, 'Not found.');
  if (path === '/api/analytics') return method === 'GET' ? ok(analytics()) : err(405, 'Public analytics is read-only.');
  if (path === '/api/explore' || path.startsWith('/api/explore/')) return method === 'GET' ? exploreApi(path, params) : err(405, 'This market feed is read-only.');
  if (path === '/api/gotchi' || path.startsWith('/api/gotchi/')) { if (method !== 'GET') return err(405, 'Gotchi pages are read-only.'); if (path === '/api/gotchi') return ok(gotchiList()); if (path === '/api/gotchi/detail') { const detail = gotchiDetail(params.get('id')); return detail ? ok(detail) : err(404, 'Gotchi not found.'); } if (path === '/api/gotchi/coin') return ok(gotchiCoin(params.get('mint'))); return err(404, 'Gotchi page not found.'); }
  // v71.39: Robinhood Chain launch venue (src/robinhood-launch/service.mjs status() / pairs() / coinView()).
  if (path === '/api/launchpad/robinhood/status') return ok({ available: true, venue: 'robinhood', chainId: 4663, explorer: 'https://robinhoodchain.blockscout.com', intakeOpen: true, pairsOpen: true, ownerPreview: false, launchFeeEth: '0.001', blockers: [], reason: '', quoteTtlMs: 600000 });
  if (path === '/api/launchpad/robinhood/pairs') return ok({ available: true, pairsOpen: true, at: Date.now(), notice: '', pairs: robinhoodPairs() });
  if (path.startsWith('/api/launchpad/robinhood/pair-check')) return ok(robinhoodPairCheck(params?.address || params?.get?.('address') || new URL(path, 'http://x').searchParams.get('address')));
  if (path.startsWith('/api/launchpad/robinhood/')) {
    const action = path.slice('/api/launchpad/robinhood/'.length), id = 'ab12cd34ef56ab12cd34ef56', token = '0x5a3b7c9d1e2f4a6b8c0d2e4f6a8b0c2d4e6f8a1b';
    const b = body || {}, pair = robinhoodPairs().find(p => b.pairToken === 'eth' ? p.native : p.address.toLowerCase() === String(b.pairToken || '').toLowerCase()) || robinhoodPairs()[0];
    const view = (state, extra = {}) => ({ id, venue: 'robinhood', chainId: 4663, state, stateLabel: { awaiting_funding: 'Waiting for funding', funding_pending: 'Confirming funding', created: 'Live on Robinhood Chain', cancelled: 'Cancelled' }[state] || state, reason: '', mode: b.mode || 'creator', modeLabel: { creator: 'Creator', holders: 'Holders', diamond_hands: 'Diamond Hands', earned: 'Earned', insured: 'Insured' }[b.mode || 'creator'],
      name: b.name || 'Preview Coin', symbol: b.symbol || 'PREV', image: b.image || null, token: state === 'created' ? token : null, predictedToken: token, curve: '0x1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d', coinUrl: state === 'created' ? '/coin?mint=' + token + '&chain=robinhood' : null,
      explorer: { token: state === 'created' ? 'https://robinhoodchain.blockscout.com/address/' + token : null, curve: null, funding: null, create: null, refund: null }, dimensions: {}, hashes: {}, devTokens: '0', refundedEth: '0', refundedPair: '0',
      pair: { address: pair.address, symbol: pair.symbol, decimals: pair.decimals, kind: pair.kind }, tier: b.tier === '4k' ? { id: '4k', label: '$4k start', startUsd: 4000, graduationUsd: 50000 } : { id: '20k', label: '$20k start', startUsd: 20000, graduationUsd: 50000 },
      taxBps: Number(b.taxBps || 0), fees: { ...robinhoodFeesFor(Number(b.taxBps || 0)), stage: 'curve', curveFeePips: robinhoodFeesFor(Number(b.taxBps || 0)).curveTotalBps * 100, poolFeePips: robinhoodFeesFor(Number(b.taxBps || 0)).poolTotalBps * 100, creatorShape: !(Number(b.taxBps) > 0), curvePoolId: null }, rules: Array.isArray(b.hooks?.rules) ? b.hooks.rules.length : 0, disclosure: state === 'awaiting_funding' ? ['Your coin is created by Launchpad’s own launch contracts on Robinhood Chain from a Launchpad launch wallet made only for this coin.', 'The curve pool charges ' + (Number(b.taxBps) > 0 ? (1.25 + Number(b.taxBps) / 100) + '% on every swap: 1.25% for Launchpad and your ' + Number(b.taxBps) / 100 + '% holder tax (95% to the holders, 5% to Launchpad)' : '1.75% on every swap: 1.25% for Launchpad and a 0.5% creator fee') + '; after graduation ' + (Number(b.taxBps) > 0 ? (0.5 + Number(b.taxBps) / 100) + '%' : '0.5% (0.25% for Launchpad, 0.25% creator fee)') + '. See Fees & revenue in the docs.'] : [], feeLink: '/docs#revenue',
      option: null, developerWallet: b.wallet || '0x1111111111111111111111111111111111111111', launchWallet: '0x2222222222222222222222222222222222222222', feeWallet: null, canCancel: state === 'awaiting_funding', canFund: state === 'awaiting_funding',
      quote: { tier: b.tier || '20k', launchFeeEth: '0.001', devBuy: b.devBuy || '0', devBuySymbol: pair.symbol, gasBudgetEth: '0.0014', feeWalletGasEth: b.mode === 'creator' ? '0' : '0.001', totalEth: '0.0534', totalWei: '53400000000000000', expectedTokens: '46000000', expiresAt: Date.now() + 600000 },
      fundingTransactions: state === 'awaiting_funding' ? [{ purpose: 'eth', to: '0x2222222222222222222222222222222222222222', value: '0xbdbc41e0348b00', data: '0x63757276652d72683a', label: '0.0534 ETH to the launch wallet' }] : [], ...extra });
    if (action === 'coin') {
      const mint = String(params.get('mint') || '').toLowerCase(), row = robinhoodExploreCoins().find(c => c.mint.toLowerCase() === mint); if (!row) return err(404, 'This Robinhood Chain coin was not found.');
      const now = Date.now(), { pool: curvePool, supply, numbers, trades, history, price } = robinhoodPool(), graduated = row.status === 'graduated';
      // The fee shape of this coin (v71.41): the 2% holder tax of ORBIT, the flat creator fee otherwise; a graduated coin's
      // pool is the graduation pool (the curve pool's positions moved into one full-range position plus slivers).
      const shape = robinhoodFeesFor(row.taxBps || 0), curvePoolId = '0x' + hex64('curve-pool:' + row.symbol);
      const feeShape = { ...shape, stage: graduated ? 'pool' : 'curve', curveFeePips: shape.curveTotalBps * 100, poolFeePips: shape.poolTotalBps * 100, creatorShape: !(row.taxBps > 0), curvePoolId: graduated ? curvePoolId : null };
      const pool = graduated ? graduationPositions({ ...curvePool, fee: shape.curveTotalBps * 100 }, { fee: shape.poolTotalBps * 100, tickSpacing: 10 }) : { ...curvePool, fee: shape.curveTotalBps * 100 };
      // v71.41: coinView() — the pool is the market from the first block; `curve` keeps its keys for the page's progress and
      // estimate (the numbers come off the pool's two positions), `pool` carries the state the quotes run on.
      return ok({ venue: 'robinhood', chainId: 4663, id, token: row.mint, routerAddress: RH.router, name: row.name, symbol: row.symbol, image: row.mint === token ? null : row.image, description: row.description, links: { website: 'https://orbit.example', twitter: 'https://x.com/orbit', telegram: '' }, creatorId: 'acct1', mode: row.feeMode === 'holders' ? 'holders' : 'creator', modeLabel: row.feeMode === 'holders' ? 'Holders' : 'Creator',
        pair: { address: row.quote.mint, symbol: row.quote.symbol, decimals: row.quote.decimals, kind: row.quote.kind, usd: row.quote.symbol === 'ETH' ? String(RH.ethUsd) : row.quote.symbol === 'USDG' ? '1' : '429.83' }, ethUsd: String(RH.ethUsd), tier: row.tier === '20k' ? { id: '20k', label: '$20k start', startUsd: 20000, graduationUsd: 50000 } : { id: '4k', label: '$4k start', startUsd: 4000, graduationUsd: 50000 },
        contracts: { escrow: RH.escrow, locker: RH.locker, factory: RH.factory, router: RH.router, poolManager: RH.poolManager }, explorerBase: 'https://robinhoodchain.blockscout.com', totalSupply: String(RH_SUPPLY),
        venueState: graduated ? 'graduated' : 'curve', graduatedAt: graduated ? now - 2 * DAY : null, poolId: row.poolId, liveAt: row.createdAt, explorer: { token: 'https://robinhoodchain.blockscout.com/address/' + row.mint, pool: 'https://robinhoodchain.blockscout.com/address/' + RH.poolManager, locker: 'https://robinhoodchain.blockscout.com/address/' + RH.locker },
        tradeLinks: robinhoodTradeLinks(row.mint),
        curve: { virtualQuote: String(RH_VQ), graduationQuote: String(numbers.fullRaise), virtualToken: String(supply.virtualToken), sellSupply: String(numbers.fullCoins), lpSupply: String(supply.lpSupply), realQuote: String(graduated ? numbers.fullRaise : numbers.raised), sold: String(graduated ? numbers.fullCoins : numbers.sold), progressBps: graduated ? 10000 : numbers.progressBps, price: String(price), tradeFeeBps: graduated ? shape.poolTotalBps : shape.curveTotalBps, creatorTaxBps: 0, graduated, at: curvePool.at },
        pool: { id: row.poolId, curvePoolId: graduated ? curvePoolId : row.poolId, sqrtPriceX96: String(pool.sqrtPriceX96), tick: pool.tick, liquidity: String(graduated ? pool.positions[0].liquidity : curvePool.liquidity), tokenIs0: false, startTick: pool.startTick, graduationTick: pool.graduationTick, curve: graduated ? null : { tickLower: curvePool.curve.tickLower, tickUpper: curvePool.curve.tickUpper, liquidity: String(curvePool.curve.liquidity) }, upper: graduated ? null : { tickLower: curvePool.upper.tickLower, tickUpper: curvePool.upper.tickUpper, liquidity: String(curvePool.upper.liquidity) }, positions: (graduated ? pool.positions : [curvePool.curve, curvePool.upper]).map(p => ({ tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: String(p.liquidity) })), fee: pool.fee, tickSpacing: 10, crossed: graduated, graduated, at: curvePool.at },
        recipients: { creatorFeeRecipient: '0x2222222222222222222222222222222222222222', creatorClaims: row.feeMode !== 'holders', owed: row.feeMode !== 'holders' ? '1500000000000000' : null, platformShareBps: graduated ? shape.poolShareBps : shape.curveShareBps },
        feeShape, taxBps: row.taxBps || 0,
        fees: { claimed: { 'rewards:0x0000000000000000000000000000000000000000': '0.0091' }, paidToHolders: '0.0063', paidSymbol: 'ETH' }, rules: row.rules ? [{ kind: 7, params: ['4000'] }] : [], option: null,
        holderRewards: row.feeMode === 'holders' ? { thresholdUsd: 100, held: '0.0028', symbol: 'ETH', cycles: [{ state: 'complete', asset: 'ETH', amount: '0.0063', paid: '0.0063', recipients: 3, skipped: 0, at: now - 50 * 60000 }], streaks: null } : null, holders: row.holders || 3,
        trades: trades.map(t => ({ ...t, quote: rhAmount(t.quote), tokens: rhAmount(t.tokens) })), priceHistory: history,
        events: [] });
    }
    if (action === 'launches') return ok({ launches: [] });
    if (action === 'launch') return ok(view('awaiting_funding'));
    if (method !== 'POST') return err(405, 'Method not allowed.');
    if (action === 'quote') return ok(view('awaiting_funding'));
    if (action === 'fund/prepare') return ok({ launchId: id, chainId: 4663, transactions: view('awaiting_funding').fundingTransactions });
    if (action === 'fund/submit') return ok(view('funding_pending'));
    if (action === 'cancel') return ok(view('cancelled'));
    return err(404, 'Robinhood launch action not found.');
  }
  if (/^\/api\/launchpad\/(damm-pump|pump|meteora|pump-classic)\/(status|pairs)$/.test(path)) return venueStatus(path);
  if (path === '/api/launchpad/agents' || /^\/api\/launchpad\/agents\/(catalog|policy|agent|activity|treasury|runs|receipts|memory|browser|screenshot|stream)$/.test(path)) {
    if (method !== 'GET') return err(405, 'Method not allowed.');
    // PREVIEW_AGENTS=off mirrors a host without LAUNCHPAD_AGENTS_ENABLED (src/agent/service.mjs ensure()).
    if (process.env.PREVIEW_AGENTS === 'off') return err(503, 'AI Agent mode is not enabled on this host.');
    const mint = params.get('mint');
    if (path === '/api/launchpad/agents') return ok(agentList());
    if (path.endsWith('/catalog')) return ok(agentCatalog());
    if (path.endsWith('/policy')) return ok(agentPolicy());
    if (path.endsWith('/screenshot')) return params.get('id') === '88' ? { status: 200, binary: SCREENSHOT_PNG, type: 'image/png' } : err(404, 'Screenshot not found.');
    if (path.endsWith('/stream')) { const detail = agentDetail(mint); return detail ? { status: 200, sse: { mint, browser: agentBrowser(mint) } } : err(404, 'Agent not found.'); }
    const fn = { agent: agentDetail, activity: agentActivity, treasury: agentTreasury, runs: agentRuns, receipts: agentReceipts, memory: agentMemory, browser: agentBrowser }[path.split('/').at(-1)];
    const value = fn(mint, params); return value ? ok(value) : err(404, 'Agent not found.');
  }
  if (path === '/api/session' && method === 'GET') return ok(sessionBody(session));
  if (['/api/wallet/challenge', '/api/wallet/verify'].includes(path)) return err(403, 'Wallet sign-in is unavailable in the preview harness.');
  // v71.28: a hooked coin's allowlist and blocklist are public, read-only (src/account-app.mjs serves them before the session gate).
  if (/^\/api\/launchpad\/meteora\/hook-(allowlist|blocklist)$/.test(path)) return method === 'GET' ? launchpadApiMock(method, path, params, session || { mode: 'anon', account: {} }, body) : err(405, 'The list is read-only here.');
  if (!session) return err(401, 'Sign in to your Launchpad account.');
  const account = session.account;
  if (account.authType === 'wallet' && !(path === '/api/launchpad' || path.startsWith('/api/launchpad/') || path === '/api/account/logout' || path === '/api/account' && method === 'GET' || ['/api/account/profile', '/api/account/avatar', '/api/account/cashback-wallet', '/api/account/cashback-wallet/challenge'].includes(path) && method === 'POST')) return err(403, 'This wallet session is limited to launching and managing coins.');
  if (path.startsWith('/api/admin/')) {
    if (account.role !== 'admin') return err(403, 'Administrator access required.');
    if (!session.monitorAllowed) return err(403, 'Enable two-factor authentication in Account → Security before using administration.');
    return adminApi(method, path, params);
  }
  if (path === '/api/account' && method === 'GET') return ok({ account });
  if (path === '/api/account/security' && method === 'GET') return ok({ account, sessions: [{ id: 'current', current: true, createdAt: Date.now() - HOUR, lastSeenAt: Date.now(), authMethod: session.authMethod }] });
  if (path === '/api/account/logout') return ok({ authenticated: false });
  if (path === '/api/launchpad/gotchi/holdings') return method === 'GET' ? ok(gotchiHoldings(session.walletAddress || account.mainWallet)) : err(405, 'Method not allowed.');
  if (path === '/api/launchpad/agents/me') return method === 'GET' ? ok(agentMe(session)) : err(405, 'Method not allowed.');
  if (path === '/api/launchpad/agents/revise' || path === '/api/launchpad/agents/pause') { if (method !== 'POST') return err(405, 'Method not allowed.'); const mine = agentMe(session).agents.find(agent => agent.mint === body?.mint); if (!mine) return err(403, 'Only the creator account can manage this agent.'); return ok(path.endsWith('/pause') ? { ...mine, creatorPaused: !!body.paused } : { ...mine, mission: body.mission || mine.mission, personalityPreset: body.personalityPreset || mine.personalityPreset, personality: body.personality ?? mine.personality, model: body.model || mine.model, objective: body.objective || mine.objective, objectiveSettings: body.objectiveSettings && typeof body.objectiveSettings === 'object' ? { ...(body.objective && body.objective !== mine.objective ? {} : mine.objectiveSettings), ...body.objectiveSettings } : mine.objectiveSettings, revision: mine.revision + 1 }); }
  if (path.startsWith('/api/launchpad/agents/fund/')) return err(503, 'Funding deposits are unavailable in the preview harness.');
  if (path.startsWith('/api/launchpad/pump-classic/')) {
    const action = path.slice('/api/launchpad/pump-classic/'.length), id = 'c0ffee'.repeat(4), mint = 'PumpC1assicPreview1111111111111111111111111';
    const view = (state, b = {}) => ({ id, state, stateLabel: { awaiting_funding: 'Waiting for funding', cancelled: 'Cancelled' }[state] || state, reason: '', mode: b.mode || 'creator', modeLabel: { creator: 'Creator', holders: 'Holders', gotchi: 'Gotchi', agent: 'AI Agent', market_maker: 'Market Maker', lp_manager: 'Liquidity Manager' }[b.mode || 'creator'], venueLabel: 'Pump.fun', name: b.name || 'Preview', symbol: b.symbol || 'PREVIEW', image: b.image || null, mint, pumpUrl: 'https://pump.fun/coin/' + mint, coinUrl: '/coin?mint=' + mint, dimensions: { launch: state }, signatures: { funding: null, create: null, refund: null }, devTokens: '0', refundedSol: '0', createdAt: Date.now(), liveAt: null,
      disclosure: pumpClassicDisclosure(b.mode || 'creator'), feeLink: '/docs#revenue',
      developerWallet: session.account.mainWallet, launchWallet: 'LaunchPreview111111111111111111111111111111', quote: { devBuySol: b.devBuySol || '0', expectedTokens: String(Math.round(Number(b.devBuySol || 0) * 34_000_000) * 1e6), setupBudgetSol: '0.05', operatingReserveSol: ['market_maker', 'lp_manager', 'holders'].includes(b.mode) ? '0.025' : b.mode === 'creator' ? '0.005' : '0.008', seedSol: b.seedSol || '0', totalSol: (Number(b.devBuySol || 0) + Number(b.seedSol || 0) + 0.075).toFixed(3), totalLamports: String(Math.round((Number(b.devBuySol || 0) + Number(b.seedSol || 0) + 0.075) * 1e9)), expiresAt: Date.now() + 600000 }, memo: 'pump-launch:' + id, canCancel: state === 'awaiting_funding', canFund: state === 'awaiting_funding' });
    if (action === 'coin') { const c = coinByMint(params.get('mint')); if (!c || c.platform !== 'pump-classic') return err(404, 'Not found.'); const now = Date.now();
      return ok({ mint: c.mint, name: c.name, symbol: c.symbol, image: c.image, mode: c.feeMode, modeLabel: { creator: 'Creator', holders: 'Holders', gotchi: 'Gotchi', agent: 'AI Agent', market_maker: 'Market Maker', lp_manager: 'Liquidity Manager' }[c.feeMode], venue: c.stage === 'graduated' ? 'amm' : 'curve', pool: null, pumpUrl: 'https://pump.fun/coin/' + c.mint, liveAt: now - 2 * 3600000, developerWallet: address('dev:' + c.symbol), createSignature: signature('create:' + c.symbol), devTokens: '17000000000000', feeState: 'verified', feeLink: '/docs#revenue',
        recipients: [{ role: 'platform', label: 'Launchpad platform share', address: address('platform:' + c.symbol) }, { role: 'strategy', label: 'Strategy wallet', address: address('strategy:' + c.symbol) }], fees: { distributedSol: '1.284', platformSol: '0.2568', recipientSol: '1.0272' },
        strategy: c.feeMode === 'market_maker' || c.feeMode === 'lp_manager' ? { kind: c.feeMode, label: c.feeMode === 'market_maker' ? 'Market Maker' : 'Liquidity Manager', status: 'active', statusLabel: 'Active', wallet: address('strategy:' + c.symbol), cashSol: '1.4021', tokens: '41000000000000', lp: '0', contributedSol: '2.0272', equitySol: '2.0911', resultSol: '0.0639', feesSpentSol: '0.00041', lastActionAt: now - 9 * 60000, lastSide: 'sell', pauseReason: '', valuedAt: now - 60000 } : null, rewards: c.feeMode === 'holders' ? [] : null, gotchi: null, agent: null,
        events: [{ kind: 'strategy', title: 'Market Maker sold', body: '1,204,331.5 ORBIT for 0.0412 SOL.', signature: signature('mm1:' + c.symbol), at: now - 9 * 60000 }, { kind: 'fees', title: 'Creator fees distributed', body: 'Collected by Launchpad.', signature: signature('fee1:' + c.symbol), at: now - 40 * 60000 }, { kind: 'fees', title: 'Fee recipients verified', body: 'Pump.fun fee sharing is set to this coin’s recorded recipients and can no longer be changed by its admin.', signature: null, at: now - 2 * 3600000 + 60000 }, { kind: 'live', title: 'Live on Pump.fun', body: 'Coin created and dev-buy tokens delivered in one transaction.', signature: signature('create:' + c.symbol), at: now - 2 * 3600000 }] }); }
    if (action === 'launches') return ok({ launches: [] });
    if (action === 'quote') {
      if (method !== 'POST') return err(405, 'Method not allowed.');
      const b = body || {}, pair = b.quoteMint ? pumpClassicPairs().find(x => x.mint === b.quoteMint) : null;
      if (b.quoteMint && (!pair || !pair.launchReady)) return err(409, 'Launchpad cannot handle this pair yet.');
      if (pair && ['agent', 'market_maker', 'lp_manager'].includes(b.mode)) return err(400, 'AI Agent, Market Maker and Liquidity Manager launches pair with SOL only.');
      if (pair && ['holders', 'gotchi'].includes(b.mode) && !pair.convertible) return err(409, 'Launchpad cannot convert this pair’s fees to SOL yet, so Holders and Gotchi launches are unavailable on it. Creator launches still work.');
      const base = view('awaiting_funding', b);
      if (!pair) return ok(base);
      const devBuy = String(b.devBuyAmount || '0'), raw = String(Math.round(Number(devBuy) * 10 ** pair.decimals)), total = ['holders'].includes(b.mode) ? 0.097 : b.mode === 'gotchi' ? 0.08 : 0.072;
      return ok({ ...base, pair: { mint: pair.mint, symbol: pair.symbol, decimals: pair.decimals, kind: pair.kind }, creatorFeeBps: Number(b.creatorFeeBps || 0),
        disclosure: pumpClassicDisclosure(b.mode || 'creator', { pair: pair.symbol, creatorFeeBps: Number(b.creatorFeeBps || 0) }),
        quote: { ...base.quote, devBuySol: '0', devBuy, devBuyRaw: raw, devBuySymbol: pair.symbol, pairAmount: devBuy, pairAmountRaw: raw, expectedTokens: String(Math.round(Number(devBuy) * (pair.mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ? 226_000 : 52_000_000)) * 1e6), setupBudgetSol: '0.06', operatingReserveSol: (total - 0.06).toFixed(3), seedSol: '0', totalSol: total.toFixed(3), totalLamports: String(Math.round(total * 1e9)) } });
    }
    if (action === 'cancel') return ok(view('cancelled'));
    if (action === 'fund/prepare' || action === 'fund/submit') return err(503, 'Funding is unavailable in the preview harness.');
    return err(404, 'Pump.fun launch action not found.');
  }
  if (path === '/api/launchpad' || path.startsWith('/api/launchpad/')) return launchpadApiMock(method, path, params, session, body);
  return null;
}
