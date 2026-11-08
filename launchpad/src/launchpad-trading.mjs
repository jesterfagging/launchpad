import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PublicKey, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { acquireProcessLock } from './process-lock.mjs';
import { LaunchTradingChain } from './launchpad-trading-chain.mjs';
import { operatorCapacity } from './operator-capacity.mjs';

const JOURNAL = 'launchpad-trades';
const ACTIVE = new Set(['awaiting_signature', 'prepared', 'pending']);
// Outcomes that are final: cancelled before broadcast, proven expired, or a verified receipt.
const FINISHED = new Set(['cancelled', 'expired', 'confirmed', 'failed']);
const JOURNAL_LIMIT = 5000, JOURNAL_KEEP = 4000, JOURNAL_RETAIN_MS = 86400000;
// The journal file is bounded. When it is full, the oldest finished trades
// that have not changed for a day are dropped (nothing else reads them; their
// outcome is onchain). Active trades and recent outcomes are always kept.
function pruneFinishedTrades(journal, now) {
  if (journal.trades.length < JOURNAL_LIMIT) return false;
  const removable = journal.trades.filter(trade => FINISHED.has(trade?.state) && Number.isSafeInteger(trade.updatedAt ?? trade.createdAt) && now - (trade.updatedAt ?? trade.createdAt) >= JOURNAL_RETAIN_MS)
    .sort((a, b) => (a.updatedAt ?? a.createdAt) - (b.updatedAt ?? b.createdAt)).slice(0, journal.trades.length - JOURNAL_KEEP);
  if (!removable.length) return false;
  const drop = new Set(removable);
  journal.trades = journal.trades.filter(trade => !drop.has(trade));
  return true;
}
const sendQueues = new Map();
const fail = (message, statusCode = 400) => { throw Object.assign(Error(message), { statusCode }); };
const busy = (message = 'Trading capacity is busy. Try again in a few seconds.') => Object.assign(Error(message), { statusCode: 503, retryAfterMs: 3000 });
const capacityValue = (value, fallback, minimum, maximum) => Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
const validId = value => { if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) fail('Invalid account.', 401); return value; };
const requestId = value => { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_-]{15,79}$/.test(value)) fail('A unique trade request ID is required.'); return value; };
const address = value => { try { if (typeof value !== 'string') throw Error(); const key = new PublicKey(value); if (key.toBase58() !== value || !PublicKey.isOnCurve(key.toBytes())) throw Error(); return value; } catch { fail('Choose a valid Solana wallet.'); } };
const mintAddress = value => { try { if (typeof value !== 'string' || new PublicKey(value).toBase58() !== value) throw Error(); return value; } catch { fail('Choose a valid token mint.'); } };
const errorText = error => String(error?.message || 'The trade could not be completed.').replace(/https?:\/\/[^\s]+/g, '[RPC]').slice(0, 500);
const hash = value => createHash('sha256').update(value).digest('hex');
const quoteFields = ['wallet', 'side', 'amount', 'amountRaw', 'inputMint', 'outputMint', 'inputSymbol', 'outputSymbol', 'inputDecimals', 'outputDecimals', 'expectedOutputRaw', 'minimumOutputRaw', 'expectedOutput', 'minimumOutput', 'slippageBps', 'slot', 'expiresAt', 'balanceRaw', 'nativeBalanceLamports', 'market', 'pool', 'networkFeeLamports', 'rentLamports', 'warning', 'residualQuotePossible', 'quoteSymbol'];
const quoteView = quote => Object.fromEntries(quoteFields.filter(key => quote[key] !== undefined).map(key => [key, quote[key]]));
const balanceFields = ['nativeBalanceLamports', 'baseBalanceRaw', 'baseDecimals', 'quoteBalanceRaw', 'quoteDecimals', 'baseSymbol', 'quoteSymbol'];
const balanceView = balance => Object.fromEntries(balanceFields.filter(key => balance?.[key] !== undefined).map(key => [key, balance[key]]));
const observationRank = status => ({ unknown: 0, processed: 1, confirmed: 2, finalized: 3 }[status?.confirmationStatus] ?? 0);

/** Main-wallet trading only. The per-account encrypted journal is separate from
 * launch/reward and toolkit ledgers. No creator signing key enters a trade. */
export class LaunchpadTrading {
  constructor({ accounts, explore, resolveCoin, chainFactory, rpcUrl = '', jupiterKey = '', rpcGate, capacities = {}, now = Date.now, random = Math.random, walletOnly = false } = {}) {
    if (!accounts?.get || !accounts?.storeFor || (!explore?.find && !resolveCoin)) throw Error('Trading requires account and coin discovery services.');
    Object.assign(this, { accounts, explore, resolveCoin, chainFactory, rpcUrl, jupiterKey, rpcGate, now, random, walletOnly });
    const provider = operatorCapacity({ rpcUrl, jupiterKey });
    this.capacities = {
      rpcRequestsPerSecond: capacityValue(capacities.rpcRequestsPerSecond, provider.rpcRequestsPerSecond, 1, 1000),
      sendRequestsPerSecond: capacityValue(capacities.sendRequestsPerSecond, provider.sendRequestsPerSecond, 1, 1000),
      maxSendQueue: capacityValue(capacities.maxSendQueue, Math.max(1, Math.min(provider.maxProviderQueue, Math.floor(provider.sendRequestsPerSecond * provider.requestDeadlineMs / 1000))), 1, 1000),
      sendDeadlineMs: capacityValue(capacities.sendDeadlineMs, Math.min(18000, provider.requestDeadlineMs), 100, 18000),
      maxQuoteJobs: capacityValue(capacities.maxQuoteJobs, Math.max(1, Math.min(128, Math.floor(provider.jupiterRequestsPerSecond * provider.requestDeadlineMs / 1000))), 1, 1000),
      maxQuoteReviews: capacityValue(capacities.maxQuoteReviews, 2048, 1000, 100000),
    };
    this.sendClient = randomUUID();
    this.sendKey = 'launchpad-send:' + hash(rpcUrl || 'https://api.mainnet-beta.solana.com');
    this.quotes = new Map(); this.quoteJobs = new Map(); this.preparing = 0; this.closed = false;
    this.pending = new Map(); this.retryAuthorizations = new Map(); this.workerStarted = false;
  }
  async authorize(id, context = {}) {
    validId(id);
    if (this.closed) fail('Trading is restarting. Try again shortly.', 503);
    if (typeof context.sessionToken !== 'string' || !context.sessionToken || typeof context.authorize !== 'function') fail('Sign in before trading.', 401);
    await context.authorize();
    const account = await this.accounts.get(id);
    if (!account || account.banned) fail('This account cannot trade.', 403);
    await this.accounts.assertWalletAllowed?.(account.mainWallet);
    return account;
  }
  binding(context) { return hash(context.sessionToken); }
  async chain() {
    if (!this.chainPromise) this.chainPromise = (async () => {
      const chain = this.chainFactory ? await this.chainFactory() : new LaunchTradingChain({ network: 'mainnet-beta', rpcUrl: this.rpcUrl, jupiterKey: this.jupiterKey, rpcGate: this.rpcGate, rpcScope: 'launchpad-trading', rpcRequestsPerSecond: this.capacities.rpcRequestsPerSecond });
      if (!this.chainFactory) { try { await chain.init(); } catch (error) { chain.close?.(); throw error; } }
      return chain;
    })().catch(error => { this.chainPromise = null; throw error; });
    return this.chainPromise;
  }
  async coin(mint) {
    mintAddress(mint);
    let found;
    if (this.resolveCoin) found = await this.resolveCoin(mint);
    else if (this.explore.findForTrade) found = await this.explore.findForTrade(mint);
    else {
      // Do not authorize spending using a potentially stale moderation cache.
      if (this.explore.pendingRegistry) await this.explore.pendingRegistry;
      this.explore.registryLoaded = false;
      found = await this.explore.find(mint);
      if (this.explore.registryStale) fail('Coin availability cannot be verified. Try again shortly.', 503);
    }
    if (!found?.coin || found.coin.mint !== mint || !found.chainRecord || found.coin.moderation?.hidden || found.coin.hidden) fail('This coin is unavailable for trading.', 404);
    // Field-by-field copy also protects against an accidental private record
    // being supplied by a future discovery implementation.
    const source = found.chainRecord, keys = {};
    for (const key of ['mint', 'wallet', 'payer', 'platform']) if (source.keys?.[key]?.address) keys[key] = { address: source.keys[key].address };
    const review = {};
    for (const key of ['configId', 'cpConfigId', 'supply', 'sell', 'raise', 'virtualBase', 'virtualQuote', 'quoteDecimals', 'quoteProgram', 'publicProgramId', 'stateAddress', 'custodyAuthority', 'poolId']) if (source.review?.[key] !== undefined) review[key] = source.review[key];
    review.quoteSymbol = found.coin.quote.symbol;
    return { coin: found.coin, launch: { curve: source.curve, input: { route: source.input?.route === 'pumpswap' && found.coin.platform === 'pumpswap' ? 'pumpswap' : 'raydium', network: 'mainnet-beta', quoteMint: found.coin.quote.mint, name: found.coin.name, symbol: found.coin.symbol, taxBps: found.coin.taxBps || 0, feeMode: found.coin.feeMode }, review, keys } };
  }
  async selected(account, body) {
    if(this.walletOnly && body?.mode !== 'external') fail('Connect your wallet to trade. Stored account wallets are disabled.',403);
    if (!['external', 'default'].includes(body?.mode)) fail('Choose the connected wallet or your default account wallet.');
    if (body.mode === 'external') {
      const wallet = address(body.wallet); await this.accounts.assertWalletAllowed?.(wallet);
      return { mode: 'external', address: wallet, available: true, requiresConnection: false };
    }
    if (body.wallet !== undefined && body.wallet !== '' && body.wallet !== account.mainWallet) fail('The default trading wallet must be your account main wallet.');
    const wallet = address(account.mainWallet); await this.accounts.assertWalletAllowed?.(wallet);
    const external = account.authType === 'wallet';
    return { mode: 'default', address: wallet, available: !external, requiresConnection: external };
  }
  async wallet(id, body, context) {
    const deadline = Date.now() + 18000;
    const account = await this.authorize(id, context), selected = await this.selected(account, body), { launch } = await this.coin(body.mint);
    const chain = await this.chain(), work = () => chain.walletBalances(launch, { wallet: selected.address });
    const balances = await (chain.withRpcContext ? chain.withRpcContext({ deadline }, work) : work());
    await this.authorize(id, context); await this.accounts.assertWalletAllowed?.(selected.address);
    return { wallet: { ...selected, ...balanceView(balances) } };
  }
  async quote(id, body, context) {
    const deadline = Date.now() + 18000;
    const account = await this.authorize(id, context), selected = await this.selected(account, body);
    if (selected.requiresConnection) fail('Connect your account wallet to approve this trade.');
    if (!['buy', 'sell'].includes(body.side)) fail('Choose Buy or Sell.');
    if (typeof body.amount !== 'string' || !/^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/.test(body.amount)) fail('Enter a positive amount using plain decimal notation.');
    const slippageBps = body.slippageBps === undefined ? 100 : body.slippageBps;
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10000) fail('Slippage must be between 0% and 100%, in increments of 0.01%.');
    for (const [key, row] of this.quotes) if (row.quote.expiresAt <= this.now()) this.quotes.delete(key);
    const jobKey = id + ':' + this.binding(context), fingerprint = hash(JSON.stringify([body.mint, selected.mode, selected.address, body.side, body.amount, slippageBps]));
    const prior = this.quoteJobs.get(jobKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw busy('A quote is already being prepared for this sign-in. Wait for it before requesting another.');
      const result = await prior.promise; await this.authorize(id, context); return structuredClone(result);
    }
    // Reserve both work and review storage before any market/provider request.
    // A review already shown to a user survives until its actual expiry.
    if ([...this.quotes.values()].filter(row => row.accountId === id).length >= 4) throw busy('Your existing trade reviews are still valid. Use one or wait for it to expire.');
    // Reserve one slot for a user who has already reviewed and confirmed.
    if (this.quoteJobs.size + this.preparing >= Math.max(1, this.capacities.maxQuoteJobs - 1) || this.quotes.size + this.quoteJobs.size >= this.capacities.maxQuoteReviews) throw busy();
    const promise = (async () => {
      const { launch } = await this.coin(body.mint), chain = await this.chain();
      const work = () => chain.quote(launch, { wallet: selected.address, side: body.side, amount: body.amount, slippageBps });
      const quote = await (chain.withRpcContext ? chain.withRpcContext({ deadline }, work) : work());
      if (Date.now() >= deadline) throw busy('The quote could not be completed in time. Please try again.');
      if (quote.wallet !== selected.address || quote.side !== body.side || !Number.isFinite(quote.expiresAt) || quote.expiresAt <= this.now()) fail('The trade quote is unavailable. Refresh the quote.', 409);
      await this.authorize(id, context); await this.accounts.assertWalletAllowed?.(selected.address);
      const quoteId = randomUUID(), view = { id: quoteId, mint: body.mint, mode: selected.mode, ...quoteView(quote) };
      this.quotes.set(quoteId, { accountId: id, binding: this.binding(context), mint: body.mint, mode: selected.mode, wallet: selected.address, quote, view });
      return { quote: structuredClone(view) };
    })();
    this.quoteJobs.set(jobKey, { fingerprint, promise });
    try { return await promise; } finally { this.quoteJobs.delete(jobKey); }
  }
  async journalLocked(id, callback, waitMs = 30000) {
    validId(id);
    const store = this.accounts.storeFor(id); await mkdir(store.dir, { recursive: true, mode: 0o700 });
    const release = await acquireProcessLock(join(store.dir, 'launchpad-trades.lock'), waitMs);
    try {
      const journal = await store.read(JOURNAL, { version: 1, trades: [] });
      if (journal?.version !== 1 || !Array.isArray(journal.trades)) fail('The trade journal cannot be read. No trade was sent.', 503);
      return await callback(journal, () => store.write(JOURNAL, journal));
    } finally { await release(); }
  }
  async locked(id, context, callback) {
    await this.authorize(id, context);
    return this.journalLocked(id, async (journal, save) => {
      await this.authorize(id, context);
      return callback(journal, save);
    });
  }
  view(trade) {
    if (!trade) return null;
    const pendingAge = this.now() - (trade.submittedAt || this.now());
    return { id: trade.id, requestId: trade.requestId, mint: trade.mint, mode: trade.mode, wallet: trade.wallet, state: trade.state, quote: structuredClone(trade.quote), createdAt: trade.createdAt, updatedAt: trade.updatedAt, signature: trade.operation?.signature || null, explorerUrl: trade.operation?.signature ? 'https://solscan.io/tx/' + trade.operation.signature : null, error: trade.error || '', ...(trade.state === 'pending' ? { pollAfterMs: pendingAge < 30000 ? 3000 : pendingAge < 180000 ? 10000 : 30000 } : {}), ...(trade.state === 'awaiting_signature' ? { unsignedTransaction: trade.operation.unsignedRaw } : {}) };
  }
  find(journal, tradeId) { const trade = journal.trades.find(row => row.id === tradeId); if (!trade) fail('This trade was not found.', 404); return trade; }
  sameSession(trade, context) { if (trade.binding !== this.binding(context)) fail('This trade belongs to an earlier sign-in session. Check its status, then create a new quote.', 409); }
  async prepare(id, body, context) {
    const deadline = Date.now() + 18000;
    const rid = requestId(body?.requestId);
    return this.locked(id, context, async (journal, save) => {
      const prior = journal.trades.find(row => row.requestId === rid);
      if (prior) {
        this.sameSession(prior, context);
        if (prior.quote.id !== body.quoteId) fail('This request ID was already used for another trade.', 409);
        if(this.walletOnly && prior.mode !== 'external' && ['prepared','awaiting_signature'].includes(prior.state))fail('This older trade uses a stored account wallet. Cancel it and connect your wallet for a new trade.',403);
        return { trade: this.view(prior) };
      }
      if (journal.trades.some(row => ACTIVE.has(row.state))) fail('Resolve or cancel the previous trade before preparing another.', 409);
      pruneFinishedTrades(journal, this.now());
      if (journal.trades.length >= JOURNAL_LIMIT) fail('The account trade journal is full. Contact support before trading.', 503);
      const cached = this.quotes.get(body.quoteId);
      if (!cached || cached.accountId !== id || cached.binding !== this.binding(context) || cached.quote.expiresAt <= this.now()) fail('This quote expired. Get a new quote before trading.', 409);
      if (this.preparing + this.quoteJobs.size >= this.capacities.maxQuoteJobs) throw busy('Trade preparation is busy. Your review is still saved; try confirming again shortly.');
      this.preparing++;
      try {
      const account = await this.authorize(id, context), selected = await this.selected(account, { mode: cached.mode, wallet: cached.wallet });
      if (!selected.available) fail('Connect your wallet to approve this trade.');
      const { launch } = await this.coin(cached.mint), chain = await this.chain();
      await this.authorize(id, context); await this.accounts.assertWalletAllowed?.(cached.wallet);
      let secret;
      if (cached.mode === 'default') {
        const saved = await this.accounts.storeFor(id).read('main-wallet');
        let key;
        try {
          key = Keypair.fromSecretKey(bs58.decode(saved?.privateKey || ''));
          if (saved.publicKey !== account.mainWallet || key.publicKey.toBase58() !== account.mainWallet) throw Error();
          secret = saved.privateKey;
        } catch { fail('Your default wallet is unavailable. Connect a wallet to trade.', 409); }
        finally { key?.secretKey.fill(0); }
      }
      let operation;
      try {
        await this.authorize(id, context); await this.accounts.assertWalletAllowed?.(cached.wallet);
        const work = () => chain.prepareTrade(launch, cached.quote, { external: cached.mode === 'external', secret, authorize: async () => {
          await this.authorize(id, context); await this.accounts.assertWalletAllowed?.(cached.wallet);
          if (Date.now() >= deadline) throw busy('The trade could not be prepared before its deadline. Get a new quote.');
        } });
        operation = await (chain.withRpcContext ? chain.withRpcContext({ deadline }, work) : work());
      }
      finally { secret = undefined; }
      await this.authorize(id, context); await this.accounts.assertWalletAllowed?.(cached.wallet);
      if (!operation || (cached.mode === 'external' ? !operation.needsSignature || !operation.unsignedRaw || operation.signature || operation.raw : operation.needsSignature || !operation.raw || !operation.signature)) fail('The prepared trade could not be verified.', 503);
      const trade = { id: randomUUID(), requestId: rid, mint: cached.mint, mode: cached.mode, wallet: cached.wallet, binding: cached.binding, quote: cached.view, state: cached.mode === 'external' ? 'awaiting_signature' : 'prepared', createdAt: this.now(), updatedAt: this.now(), operation, error: '' };
      journal.trades.push(trade); await save(); this.quotes.delete(body.quoteId);
      return { trade: this.view(trade) };
      } finally { this.preparing--; }
    });
  }
  async reconcile(trade, chain, save, { observation, allowExpiry = true } = {}) {
    if (trade.state !== 'pending' || !trade.operation?.signature) return;
    if (!observation && trade.lastCheckedAt && this.now() - trade.lastCheckedAt < 3000) return;
    trade.lastCheckedAt = this.now();
    try {
      const observedBefore = JSON.stringify(trade.operation.observedSignatureStatus || null);
      let receipt;
      try {
        if (observation) {
          const observed = observation.operation.observedSignatureStatus;
          if (observed && (!trade.operation.observedSignatureStatus || observationRank(observed) >= observationRank(trade.operation.observedSignatureStatus))) trade.operation.observedSignatureStatus = observed;
          if (observation.error) throw observation.error;
          receipt = observation.receipt;
        } else receipt = await chain.receipt(trade.operation);
      }
      finally {
        // Persist a positive status even when the subsequent archival lookup
        // fails. A later cache miss must never erase evidence that it landed.
        if (JSON.stringify(trade.operation.observedSignatureStatus || null) !== observedBefore) await save();
      }
      if (receipt) {
        if (receipt.transaction?.signatures?.[0] !== trade.operation.signature || !receipt.meta || !Number.isSafeInteger(receipt.slot) || receipt.slot <= 0) fail('The transaction receipt could not be verified.', 503);
        trade.state = receipt.meta.err ? 'failed' : 'confirmed';
        trade.error = receipt.meta.err ? 'The transaction failed onchain. Network fees may still apply.' : '';
        trade.slot = receipt.slot; trade.confirmedAt = this.now();
        delete trade.operation.raw; delete trade.operation.unsignedRaw;
      } else {
        trade.error = 'Confirmation is still pending. Check the saved transaction; do not submit a replacement.';
        if (allowExpiry && this.now() - trade.submittedAt > 180000 && typeof chain.pendingTransactionState === 'function') await this.checkExpired(trade, chain, save);
      }
    } catch { trade.error = 'Confirmation is temporarily unavailable. Your saved transaction will be checked again; no replacement was sent.'; }
    trade.updatedAt = this.now(); await save();
  }
  async checkExpired(trade, chain, save) {
    const op = trade.operation;
    if (op.observedSignatureStatus) { delete op.expiryCheck; trade.error = 'This transaction was observed onchain. Its exact receipt must be recovered before another trade can be submitted.'; return; }
    const observedBefore = JSON.stringify(op.observedSignatureStatus || null);
    let result;
    try { result = await chain.pendingTransactionState(op); }
    finally { if (JSON.stringify(op.observedSignatureStatus || null) !== observedBefore) await save(); }
    if (op.observedSignatureStatus || result?.state !== 'expired') {
      delete op.expiryCheck;
      trade.error = result?.reason || 'The transaction outcome is not yet verified. No replacement was sent.';
      return;
    }
    const checkpoint = result.checkpoint, prior = op.expiryCheck;
    if (result.signature !== op.signature || !Number.isSafeInteger(checkpoint?.height) || !Number.isSafeInteger(checkpoint?.slot) || checkpoint.height <= op.lastValidBlockHeight || checkpoint.slot < checkpoint.height || !Number.isSafeInteger(result.historyFromSlot) || result.historyFromSlot < 0) {
      delete op.expiryCheck; return;
    }
    if (!prior || prior.signature !== op.signature) {
      op.expiryCheck = { signature: op.signature, at: this.now(), ...checkpoint };
      trade.error = 'The transaction appears expired. Waiting for a second finalized checkpoint before allowing a new trade.';
      return;
    }
    if (this.now() - prior.at < 10000 || checkpoint.slot <= prior.slot || checkpoint.height <= prior.height) {
      trade.error = 'Waiting for a second advancing finalized checkpoint. No replacement was sent.';
      return;
    }
    trade.state = 'expired'; trade.expiredAt = this.now();
    op.expiryProof = { first: prior, second: { ...checkpoint, at: this.now() }, historyFromSlot: result.historyFromSlot };
    delete op.expiryCheck; delete op.raw;
    trade.error = 'This transaction expired without landing. Get a fresh quote and review a new trade to try again.';
  }
  async sendSlot(callback, { deadline = Date.now() + this.capacities.sendDeadlineMs } = {}) {
    if (this.closed || Date.now() >= deadline) throw busy('Trade submission capacity was unavailable before its deadline. Nothing new was sent.');
    let queue = sendQueues.get(this.sendKey);
    if (!queue) { queue = { running: 0, entries: [], concurrency: Math.min(16, this.capacities.sendRequestsPerSecond) }; sendQueues.set(this.sendKey, queue); }
    if (queue.running + queue.entries.length >= this.capacities.maxSendQueue) throw busy('Trade submission is busy. Your saved trade has not been submitted; try again shortly.');
    return new Promise((resolve, reject) => {
      const restoreContext = AsyncLocalStorage.snapshot();
      const entry = { client: this.sendClient, service: this, deadline, callback: slot => restoreContext(callback, slot), resolve, reject };
      entry.timer = setTimeout(() => {
        const index = queue.entries.indexOf(entry);
        if (index < 0) return;
        queue.entries.splice(index, 1); reject(busy('Trade submission capacity was unavailable before its deadline. Nothing new was sent.'));
        this.drainSends(queue);
      }, Math.max(1, deadline - Date.now()));
      queue.entries.push(entry); this.drainSends(queue);
    });
  }
  drainSends(queue) {
    while (queue.entries.length && queue.running < queue.concurrency) {
      const entry = queue.entries.shift(); clearTimeout(entry.timer);
      if (entry.service.closed || Date.now() >= entry.deadline) { entry.reject(busy('Trade submission expired in the queue. Nothing new was sent.')); continue; }
      queue.running++;
      // The RPC transport owns the single provider send permit. This queue
      // bounds admission and waiting without consuming a second send permit.
      Promise.resolve().then(() => entry.callback({ deadline: entry.deadline })).then(entry.resolve, entry.reject).finally(() => {
        queue.running--; this.drainSends(queue);
      });
    }
    if (!queue.running && !queue.entries.length && sendQueues.get(this.sendKey) === queue) sendQueues.delete(this.sendKey);
  }
  async submit(id, body, context) {
    const deadline = Date.now() + this.capacities.sendDeadlineMs;
    if (body?.confirm !== true) fail('Confirm the trade before submitting.');
    return this.locked(id, context, async (journal, save) => {
      const trade = this.find(journal, body.tradeId); this.sameSession(trade, context);
      const chain = await this.chain();
      const execute = async () => {
      if (trade.state === 'pending') { this.trackPending(id, trade, context); if (!this.workerStarted) await this.reconcile(trade, chain, save); return { trade: this.view(trade) }; }
      if (!['prepared', 'awaiting_signature'].includes(trade.state)) return { trade: this.view(trade) };
      await this.coin(trade.mint);
      const account = await this.authorize(id, context);
      const selected = await this.selected(account, { mode: trade.mode, wallet: trade.wallet });
      if (!selected.available) fail('Connect your wallet to approve this trade.');
      if (trade.state === 'awaiting_signature') trade.operation = await chain.acceptSigned(trade.operation, body.signedTransaction);
      else {
        if (body.signedTransaction !== undefined) fail('A connected-wallet transaction cannot replace a default-wallet trade.');
        const height = await chain.c.getBlockHeight('finalized');
        if (!Number.isSafeInteger(height) || height < 0) fail('Transaction validity cannot be verified. Try again.', 503);
        if (height > trade.operation.lastValidBlockHeight) {
          trade.state = 'expired'; trade.error = 'The prepared trade expired before submission. Get a new quote.'; trade.updatedAt = this.now(); delete trade.operation.raw; await save(); return { trade: this.view(trade) };
        }
      }
      return this.sendSlot(async () => {
        // Provider pacing can wait: re-check expiry, moderation and session
        // after the wait, then persist the exact transaction before sending.
        const height = await chain.c.getBlockHeight('finalized');
        if (!Number.isSafeInteger(height) || height < 0) fail('Transaction validity cannot be verified. Try again.', 503);
        if (height > trade.operation.lastValidBlockHeight) {
          trade.state = 'expired'; trade.error = 'The prepared trade expired before submission. Get a new quote.'; trade.updatedAt = this.now(); delete trade.operation.raw; delete trade.operation.unsignedRaw; await save(); return { trade: this.view(trade) };
        }
        await this.coin(trade.mint);
        await this.authorize(id, context); await this.accounts.assertWalletAllowed?.(trade.wallet);
        if (Date.now() >= deadline) throw busy('Trade preparation took too long to submit. Nothing new was sent. Review the saved trade before retrying.');
        // The exact signed transaction and signature must survive a crash before
        // the first network send. Pending operations never build replacement txs.
        trade.state = 'pending'; trade.updatedAt = this.now(); trade.submittedAt = this.now(); trade.error = '';
        trade.operation.broadcastRawHash = hash(Buffer.from(trade.operation.raw, 'base64'));
        trade.broadcastAttempts = 1; trade.lastBroadcastAt = this.now();
        await save();
        this.trackPending(id, trade, context);
        try {
          await this.authorize(id, context); await this.accounts.assertWalletAllowed?.(trade.wallet);
          if (this.closed || Date.now() >= deadline) throw busy('The submission deadline passed before sending. No trade was sent.');
        } catch (error) {
          // No broadcast has happened in this branch, so cancellation is known.
          trade.state = 'cancelled'; trade.error = 'Submission stopped before broadcast. No trade was sent. Get a fresh quote.'; delete trade.operation.raw; await save(); throw error;
        }
        try { await chain.broadcast(trade.operation, { deadline, authorize: async () => {
          await this.coin(trade.mint); await this.authorize(id, context); await this.accounts.assertWalletAllowed?.(trade.wallet);
          // Moderation may await disk reads. Recheck the session after that
          // work, immediately before the transport's synchronous send checks.
          await context.authorize();
          if (this.closed || Date.now() >= deadline) throw busy('The submission deadline passed before sending.');
        } }); }
        catch (error) { trade.error = 'The send result is uncertain. Check the saved transaction before trying again. ' + errorText(error); }
        trade.updatedAt = this.now(); await save();
        this.trackPending(id, trade, context);
        return { trade: this.view(trade) };
      }, { deadline });
      };
      return chain.withRpcContext ? chain.withRpcContext({ deadline }, execute) : execute();
    });
  }
  async status(id, body = {}, context) {
    return this.locked(id, context, async (journal, save) => {
      const trade = body.tradeId ? this.find(journal, body.tradeId) : [...journal.trades].reverse().find(row => (!body.mint || row.mint === body.mint) && ACTIVE.has(row.state)) || null;
      if (trade?.state === 'pending') {
        this.trackPending(id, trade, context);
        if (!this.workerStarted) await this.reconcile(trade, await this.chain(), save);
      }
      await this.authorize(id, context);
      return { trade: this.view(trade) };
    });
  }
  async cancel(id, body, context) {
    return this.locked(id, context, async (journal, save) => {
      const trade = this.find(journal, body.tradeId);
      if (trade.state === 'pending') fail('This trade may already be onchain. Check its saved signature instead of cancelling.', 409);
      if (['prepared', 'awaiting_signature'].includes(trade.state)) {
        trade.state = 'cancelled'; trade.updatedAt = this.now(); trade.error = ''; delete trade.operation.raw; delete trade.operation.unsignedRaw;
        await this.authorize(id, context); await save();
      }
      return { trade: this.view(trade) };
    });
  }
  trackPending(id, trade, context) {
    if (trade?.state !== 'pending' || !trade.operation?.signature) return;
    const key = id + ':' + trade.id, prior = this.pending.get(key);
    if (prior) prior.operation = structuredClone(trade.operation);
    else this.pending.set(key, { id, tradeId: trade.id, operation: structuredClone(trade.operation), nextAt: this.now() + 1000, failures: 0 });
    // A session token is never written to the transaction journal. After a
    // restart we recover receipts, but cannot silently renew spending authority.
    if (context && trade.binding === this.binding(context) && (!this.walletOnly || trade.mode === 'external')) this.retryAuthorizations.set(key, context);
    if(this.walletOnly && trade.mode !== 'external')this.retryAuthorizations.delete(key);
  }
  async discoverPending() {
    if (typeof this.accounts.list !== 'function' || this.closed) return;
    const accounts = await this.accounts.list();
    for (let offset = 0; offset < accounts.length && !this.closed; offset += 8) {
      await Promise.all(accounts.slice(offset, offset + 8).map(async account => {
        try {
          const journal = await this.accounts.storeFor(validId(account.id)).read(JOURNAL, { version: 1, trades: [] });
          if (journal?.version !== 1 || !Array.isArray(journal.trades)) throw Error('Invalid trade journal.');
          for (const trade of journal.trades) if (trade.state === 'pending') this.trackPending(account.id, trade);
        } catch { this.discoveryIncomplete = true; }
      }));
    }
  }
  start() {
    if (this.startPromise) return this.startPromise;
    if (this.closed) return Promise.resolve();
    this.workerStarted = true;
    const schedule = () => {
      if (this.closed) return;
      this.workerTimer = setTimeout(async () => {
        try { await this.runReconciliation(); } catch { /* Pending journals remain authoritative; retry with backoff. */ }
        schedule();
      }, 1000 + Math.floor(this.random() * 500));
      this.workerTimer.unref?.();
    };
    this.startPromise = this.discoverPending().catch(() => { this.discoveryIncomplete = true; }).finally(() => {
      this.nextDiscoveryAt = this.now() + (this.discoveryIncomplete ? 30000 : 300000); schedule();
    });
    return this.startPromise;
  }
  async runReconciliation() {
    if (this.closed || this.workerPromise) return this.workerPromise;
    this.workerPromise = this.reconciliationPass();
    try { await this.workerPromise; } finally { this.workerPromise = null; }
  }
  async reconciliationPass() {
    if (this.workerStarted && this.now() >= this.nextDiscoveryAt) {
      this.discoveryIncomplete = false;
      await this.discoverPending().catch(() => { this.discoveryIncomplete = true; });
      this.nextDiscoveryAt = this.now() + (this.discoveryIncomplete ? 30000 : 300000);
    }
    const entries = [...this.pending].filter(([, entry]) => entry.nextAt <= this.now()).sort((a, b) => a[1].nextAt - b[1].nextAt).slice(0, 100);
    if (!entries.length || this.closed) return;
    const chain = await this.chain(), operations = entries.map(([, entry]) => structuredClone(entry.operation));
    let observations;
    try {
      observations = typeof chain.receiptBatch === 'function' ? await chain.receiptBatch(operations, { maxReceiptReads: 8 }) : await Promise.all(operations.map(async operation => {
        try { return { operation, receipt: await chain.receipt(operation), error: null }; } catch (error) { return { operation, receipt: null, error }; }
      }));
      if (!Array.isArray(observations) || observations.length !== entries.length) throw Error('Incomplete confirmation batch.');
    } catch {
      for (const [, entry] of entries) { entry.failures++; entry.nextAt = this.now() + Math.min(30000, 3000 * 2 ** Math.min(4, entry.failures)) + Math.floor(this.random() * 1000); }
      return;
    }
    let expiryBudget = 2, rebroadcastBudget = 2;
    for (let index = 0; index < entries.length && !this.closed; index++) {
      const [key, entry] = entries[index], observation = observations[index];
      try {
        await this.journalLocked(entry.id, async (journal, save) => {
          const trade = journal.trades.find(row => row.id === entry.tradeId);
          if (trade?.state !== 'pending' || trade.operation?.signature !== entry.operation.signature) { this.pending.delete(key); this.retryAuthorizations.delete(key); return; }
          if (!observation?.operation || observation.operation.signature !== trade.operation.signature) throw Error('Confirmation batch identity changed.');
          const allowExpiry = expiryBudget > 0 && this.now() - (trade.lastExpiryCheckAt || 0) > 60000 && this.now() - trade.submittedAt > 180000;
          if (allowExpiry) { expiryBudget--; trade.lastExpiryCheckAt = this.now(); }
          await this.reconcile(trade, chain, save, { observation, allowExpiry });
          if (trade.state !== 'pending') { this.pending.delete(key); this.retryAuthorizations.delete(key); return; }
          if (rebroadcastBudget > 0 && !observation.error && !trade.operation.observedSignatureStatus && this.retryAuthorizations.has(key)) {
            rebroadcastBudget--; await this.rebroadcastSaved(entry.id, trade, chain, save, key);
          }
          entry.operation = structuredClone(trade.operation);
          entry.failures = observation.error ? entry.failures + 1 : 0;
          const age = this.now() - trade.submittedAt;
          entry.nextAt = this.now() + (observation.error ? Math.min(30000, 3000 * 2 ** Math.min(4, entry.failures)) : age < 30000 ? 3000 : age < 180000 ? 10000 : 30000) + Math.floor(this.random() * 1000);
        }, 250);
      } catch { entry.failures++; entry.nextAt = this.now() + Math.min(30000, 3000 * 2 ** Math.min(4, entry.failures)) + Math.floor(this.random() * 1000); }
    }
  }
  async rebroadcastSaved(id, trade, chain, save, key) {
    if(this.walletOnly && trade.mode !== 'external')return;
    const context = this.retryAuthorizations.get(key), op = trade.operation;
    if (!context || this.closed || typeof chain.verifyBroadcastOperation !== 'function' || !op.raw || !op.broadcastRawHash || op.observedSignatureStatus || (trade.broadcastAttempts || 1) >= 3 || this.now() - trade.submittedAt >= 60000 || this.now() - (trade.lastBroadcastAt || trade.submittedAt) < 8000) return;
    // Foreground submissions have priority over background network retries.
    const queue = sendQueues.get(this.sendKey); if (queue?.running || queue?.entries.length) return;
    try {
      await this.authorize(id, context); await this.accounts.assertWalletAllowed?.(trade.wallet); await this.coin(trade.mint);
      chain.verifyBroadcastOperation(op, trade.wallet);
      const height = await chain.c.getBlockHeight('finalized');
      if (!Number.isSafeInteger(height) || !Number.isSafeInteger(op.lastValidBlockHeight) || height + 10 >= op.lastValidBlockHeight) return;
      await this.sendSlot(async ({ deadline }) => {
        await this.authorize(id, context); await this.accounts.assertWalletAllowed?.(trade.wallet);
        if (Date.now() >= deadline || this.closed) return;
        chain.verifyBroadcastOperation(op, trade.wallet);
        trade.broadcastAttempts = (trade.broadcastAttempts || 1) + 1; trade.lastBroadcastAt = this.now(); await save();
        await this.authorize(id, context); await this.accounts.assertWalletAllowed?.(trade.wallet);
        await chain.broadcast(op, { deadline, authorize: async () => {
          await this.coin(trade.mint); await this.authorize(id, context); await this.accounts.assertWalletAllowed?.(trade.wallet);
          await context.authorize();
          if (this.closed || Date.now() >= deadline) throw busy('The saved transaction retry expired before sending.');
          chain.verifyBroadcastOperation(op, trade.wallet);
        } });
      });
    } catch (error) {
      if ([401, 403].includes(error?.statusCode)) this.retryAuthorizations.delete(key);
      // Exact signature remains pending on any failure. A retry never builds,
      // signs, edits, or substitutes a transaction, and never clears a receipt.
    }
  }
  async close() {
    this.closed = true; clearTimeout(this.workerTimer); this.quotes.clear(); this.retryAuthorizations.clear();
    const queue = sendQueues.get(this.sendKey);
    if (queue) for (const entry of [...queue.entries]) if (entry.client === this.sendClient) { clearTimeout(entry.timer); queue.entries.splice(queue.entries.indexOf(entry), 1); entry.reject(busy('Trading is restarting. No queued transaction was sent.')); }
    if (this.workerPromise) await this.workerPromise.catch(() => {});
    if (this.chainPromise) (await this.chainPromise.catch(() => null))?.close?.();
    this.pending.clear();
  }
}
