import { PublicKey } from '@solana/web3.js';
import { displayUnits, isCurrentLaunch, SOL_MINT } from '../public/launchpad-model.mjs';
import { quoteLabel } from '../public/quote-identity.mjs';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const REFRESH_MS = 30_000;
const fail = (message, statusCode = 503) => { throw Object.assign(Error(message), { statusCode }); };
const address = value => { try { return typeof value === 'string' && new PublicKey(value).toBase58() === value ? value : null; } catch { return null; } };
const wallet = value => { const key = address(value); return key && PublicKey.isOnCurve(new PublicKey(key).toBytes()) ? key : null; };
const unsigned = value => typeof value === 'string' && /^\d{1,40}$/.test(value) ? BigInt(value) : null;
const signed = value => typeof value === 'string' && /^-?\d{1,40}$/.test(value) ? BigInt(value) : null;
const signature = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(value) ? value : null;
const stamp = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const confirmed = op => op?.state === 'confirmed' && signature(op.signature) && Number.isSafeInteger(op.slot) && op.slot > 0;
// Gotchi launches pay their pot vault, never individual holders.
const category = launch => launch?.input?.feeMode === 'creator' ? 'creator' : launch?.input?.feeMode === 'holders' && !launch.input.gotchi ? 'holders' : null;
const blank = () => ({ amounts: new Map(), paymentCount: 0, lastPaymentAt: null });
const cleanText = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 24) : '';

// Called only after the launch worker has validated the payout transaction.
// Record recipient token credits while its existing receipt is in memory; no
// additional chain request is needed, including for transfer-tax quote tokens.
export function personalRewardReceipt(launch, op, tx) {
  if (!category(launch) || op?.kind !== 'payout' || !signature(op.signature) || !Number.isSafeInteger(tx?.slot) || tx.slot <= 0 || !tx.meta || tx.meta.err !== null || launch.input.quoteMint === SOL_MINT) return null;
  const mint = address(launch.input.quoteMint), decimals = launch.review?.quoteDecimals;
  if (!mint || !Number.isInteger(decimals) || !Array.isArray(op.payouts) || !op.payouts.length || op.payouts.length > 1000 || !Array.isArray(tx.meta.preTokenBalances) || !Array.isArray(tx.meta.postTokenBalances)) return null;
  if ([...tx.meta.preTokenBalances, ...tx.meta.postTokenBalances].some(row => !row || typeof row !== 'object' || Array.isArray(row))) return null;
  const seen = new Set(), payments = [];
  for (const payout of op.payouts) {
    const owner = wallet(payout?.owner), sent = unsigned(payout?.amount);
    if (!owner || sent === null || sent <= 0n || seen.has(owner)) return null;
    seen.add(owner);
    const pre = tx.meta.preTokenBalances.filter(row => row.owner === owner && row.mint === mint), post = tx.meta.postTokenBalances.filter(row => row.owner === owner && row.mint === mint);
    if (!post.length) return null;
    const sum = rows => {
      const indices = new Set(); let total = 0n;
      for (const row of rows) {
        const units = unsigned(row.uiTokenAmount?.amount);
        if (units === null || row.uiTokenAmount.decimals !== decimals || !Number.isSafeInteger(row.accountIndex) || row.accountIndex < 0 || indices.has(row.accountIndex)) return null;
        indices.add(row.accountIndex); total += units;
      }
      return total;
    };
    const before = sum(pre), after = sum(post);
    if (before === null || after === null || after < before || after - before > sent) return null;
    payments.push({ wallet: owner, amountUnits: (after - before).toString(), amountSentUnits: sent.toString() });
  }
  return { version: 1, mint, decimals, signature: op.signature, slot: tx.slot, payments };
}

function creditedAmount(launch, op, owner, sent) {
  if (launch.input.quoteMint === SOL_MINT || launch.review?.quoteProgram === TOKEN_PROGRAM) return sent;
  const receipt = op.personalRewardReceipt;
  if (receipt?.version !== 1 || receipt.mint !== launch.input.quoteMint || receipt.decimals !== launch.review.quoteDecimals || receipt.signature !== op.signature || receipt.slot !== op.slot || !Array.isArray(receipt.payments) || receipt.payments.length !== op.payouts.length) return null;
  const rows = receipt.payments.filter(row => row.wallet === owner), row = rows[0];
  if (rows.length !== 1 || unsigned(row.amountSentUnits) !== sent) return null;
  const credit = unsigned(row.amountUnits);
  return credit !== null && credit <= sent ? credit : null;
}

// Reduce a private journal to financial facts before retaining it in the shared
// cache. No account IDs, signing keys, provider credentials or transaction bytes
// are cached or returned. Current recipient settings never rewrite past payees.
function facts(launch) {
  const type = category(launch);
  if (!type || !isCurrentLaunch(launch.input) || !launch.curve) return null;
  const mint = address(launch.keys?.mint?.address), quoteMint = address(launch.input.quoteMint), source = wallet(launch.keys?.wallet?.address);
  const decimals = launch.review?.quoteDecimals;
  const valid = !!mint && !!quoteMint && mint !== quoteMint && !!source && Number.isInteger(decimals) && decimals >= 0 && decimals <= 12;
  const operations = Array.isArray(launch.operations) ? launch.operations : [];
  let complete = valid && Array.isArray(launch.operations) && launch.operationsTruncated !== true && launch.historyTruncated !== true && operations.some(op => ['create', 'launch-all'].includes(op?.kind) && confirmed(op));
  const results = [];
  if (!valid) return { type, complete: false, results };
  const quote = { mint: quoteMint, symbol: quoteLabel(quoteMint, launch.review?.quoteSymbol, launch.input.quoteSymbol), decimals };
  for (const op of operations) {
    if (!op || op.state !== 'confirmed' || !(op.kind === 'payout' || type === 'creator' && op.kind === 'claim')) continue;
    const row = { signature: signature(op.signature), id: typeof op.operationId === 'string' && op.operationId.length <= 100 ? `${mint}:${op.operationId}` : null, type, at: stamp(op.confirmedAt) || stamp(op.createdAt), events: [], valid: !!confirmed(op) };
    const q = signed(op.receipt?.quoteDelta), b = signed(op.receipt?.baseDelta);
    if (op.kind === 'claim') {
      // A managed fee vault is not the creator's personal receipt. Its claim is
      // indexed to the source wallet only; the beneficiary is credited on payout.
      row.valid &&= q !== null && b !== null && q >= 0n && b >= 0n;
      if (row.valid && q > 0n) row.events.push({ wallet: source, ...quote, amount: q });
      if (row.valid && b > 0n) row.events.push({ wallet: source, mint, symbol: cleanText(launch.input.symbol) || 'Token', decimals: 6, amount: b });
    } else {
      const amount = unsigned(op.amount), payouts = op.payouts;
      row.valid &&= amount !== null && amount > 0n && Array.isArray(payouts) && payouts.length > 0 && payouts.length <= 1000 && (!op.receipt || q === -amount && b === 0n);
      if (row.valid) {
        const seen = new Set(); let sum = 0n;
        for (const payout of payouts) {
          const owner = wallet(payout?.owner), units = unsigned(payout?.amount);
          if (!owner || units === null || units <= 0n || seen.has(owner)) { row.valid = false; break; }
          seen.add(owner); sum += units;
          // A creator's self-payout unwraps fees already credited by a claim.
          if (type === 'creator' && owner === source) continue;
          // Legacy Token-2022 quote payments retain their gross transfer budget,
          // not necessarily the recipient's net credit. Never call that income.
          const credit = creditedAmount(launch, op, owner, units);
          if (credit === null) { row.valid = false; break; }
          if (credit > 0n) row.events.push({ wallet: owner, ...quote, amount: credit });
        }
        if (sum !== amount) row.valid = false;
      }
    }
    if (!row.valid) complete = false;
    results.push(row);
  }
  return { type, complete, results };
}

function identity(row) {
  return JSON.stringify([row.type, row.events.map(event => [event.wallet, event.mint, event.decimals, event.amount.toString()]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
}

// Exported pure reduction supports replay tests without providers or mutations.
export function personalRewardIndex(launches = [], { inventoryComplete = true } = {}) {
  const complete = { creator: inventoryComplete, holders: inventoryComplete }, transactions = new Map(), operations = new Map();
  for (const launch of launches) {
    const record = facts(launch); if (!record) continue;
    complete[record.type] &&= record.complete;
    for (const row of record.results) {
      if (!row.signature) continue;
      const old = transactions.get(row.signature), fingerprint = identity(row);
      if (old) {
        if (!row.valid || fingerprint !== old.fingerprint) { old.valid = false; complete[old.type] = false; complete[row.type] = false; }
        continue;
      }
      row.fingerprint = fingerprint;
      const duplicate = row.id && operations.get(row.id);
      if (duplicate) { duplicate.valid = false; row.valid = false; complete[duplicate.type] = false; complete[row.type] = false; }
      if (row.id) operations.set(row.id, row);
      transactions.set(row.signature, row);
    }
  }
  const wallets = new Map();
  for (const row of transactions.values()) {
    if (!row.valid) continue;
    const paid = new Set();
    for (const event of row.events) {
      let person = wallets.get(event.wallet);
      if (!person) { person = { creator: blank(), holders: blank() }; wallets.set(event.wallet, person); }
      const metric = person[row.type], old = metric.amounts.get(event.mint);
      if (old && old.decimals !== event.decimals) { complete[row.type] = false; old.invalid = true; continue; }
      metric.amounts.set(event.mint, { mint: event.mint, symbol: event.symbol, decimals: event.decimals, amount: (old?.amount || 0n) + event.amount, invalid: old?.invalid || false });
      metric.lastPaymentAt = Math.max(metric.lastPaymentAt || 0, row.at || 0) || null;
      if (!paid.has(event.wallet)) { metric.paymentCount++; paid.add(event.wallet); }
    }
  }
  return { wallets, complete };
}

function money(metric, historyComplete, prices, now) {
  let observed = 0, priced = 0, unpriced = 0;
  const quoteTotals = [...metric.amounts.values()].filter(row => !row.invalid).sort((a, b) => a.mint.localeCompare(b.mint)).map(row => {
    const amount = displayUnits(row.amount, row.decimals), raw = prices instanceof Map ? prices.get(row.mint) : prices?.[row.mint];
    const price = raw && (!raw.mint || raw.mint === row.mint) && raw.stale !== true && stamp(raw.at) && raw.at <= now && now - raw.at <= 60_000 && ['number', 'string'].includes(typeof raw.usd) && (typeof raw.usd !== 'string' || /^\d+(?:\.\d+)?$/.test(raw.usd)) && Number.isFinite(Number(raw.usd)) && Number(raw.usd) > 0 ? raw : null;
    const usd = price ? Number(amount) * Number(price.usd) : null, usdEstimate = usd !== null && Number.isFinite(usd) ? usd : null;
    if (usdEstimate === null) unpriced++; else { observed += usdEstimate; priced++; }
    return { mint: row.mint, symbol: row.symbol, decimals: row.decimals, amountUnits: row.amount.toString(), amount, usdEstimate, priceAt: price?.at || null };
  });
  const valuationComplete = unpriced === 0 && Number.isFinite(observed), knownZero = historyComplete && metric.paymentCount === 0;
  return { quoteTotals, usdEstimate: historyComplete && valuationComplete ? observed : null, observedUsdEstimate: Number.isFinite(observed) && (priced > 0 || knownZero) ? observed : null,
    historyComplete, valuationComplete, valuationBasis: 'current_quote_prices', paymentCount: metric.paymentCount, lastPaymentAt: metric.lastPaymentAt };
}

export class PersonalRewards {
  constructor({ accounts, launchpad, prices = () => new Map(), now = Date.now, maxAccounts = 10000, maxLaunches = 100000, maxOperations = 1000000, maxPayouts = 1000000 } = {}) {
    Object.assign(this, { accounts, launchpad, prices, now, maxAccounts, maxLaunches, maxOperations, maxPayouts });
    this.index = null; this.at = null; this.attemptAt = null; this.pending = null;
  }
  async identity(actorId, context) {
    if (typeof context?.authorize !== 'function') fail('Sign in to see your rewards.', 401);
    const session = await context.authorize();
    if (!session || session.account?.id !== actorId) fail('Sign in again to see your rewards.', 401);
    const account = await this.accounts.get(actorId);
    if (!account || account.banned) fail('Sign in again to see your rewards.', 401);
    const bound = wallet(account.authType === 'wallet' ? account.mainWallet : account.signInWallet || account.mainWallet);
    if (session.authMethod === 'wallet' && (session.walletVerified !== true || wallet(session.walletAddress) !== bound)) fail('Your wallet session changed. Sign in again.', 401);
    if (account.authType === 'wallet' && session.authMethod !== 'wallet') fail('Sign in with your wallet to see your rewards.', 401);
    return { wallet: bound };
  }
  async refresh() {
    if (this.at !== null && this.now() - this.at < REFRESH_MS) return;
    if (this.pending) return this.pending;
    if (this.attemptAt !== null && this.now() - this.attemptAt < REFRESH_MS) fail('Reward history is temporarily unavailable.');
    this.attemptAt = this.now();
    this.pending = (async () => {
      let people;
      try { people = await this.accounts.list(); } catch { fail('Reward history is temporarily unavailable.'); }
      if (!Array.isArray(people) || people.length > this.maxAccounts) fail('Reward history exceeds its reporting limit.');
      const launches = []; let complete = true, operationCount = 0, payoutCount = 0;
      for (let index = 0; index < people.length; index += 8) {
        const books = await Promise.allSettled(people.slice(index, index + 8).map(person => this.launchpad.book(person.id)));
        for (const result of books) {
          if (result.status !== 'fulfilled' || !Array.isArray(result.value?.launches)) { complete = false; continue; }
          for (const launch of result.value.launches) {
            if (!launch || typeof launch !== 'object') { complete = false; continue; }
            launches.push(launch);
            operationCount += Array.isArray(launch.operations) ? launch.operations.length : 0;
            for (const op of Array.isArray(launch.operations) ? launch.operations : []) payoutCount += Array.isArray(op?.payouts) ? op.payouts.length : 0;
            if (launches.length > this.maxLaunches || operationCount > this.maxOperations || payoutCount > this.maxPayouts) fail('Reward history exceeds its reporting limit.');
          }
        }
      }
      this.index = personalRewardIndex(launches, { inventoryComplete: complete }); this.at = this.now();
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
  async read(actorId, context) {
    const initial = await this.identity(actorId, context);
    if (!initial.wallet) return { wallet: null, requiresWalletSignIn: true, updatedAt: null, refreshMs: 60000, stale: false, scope: 'confirmed_curve_payments', creator: null, holders: null };
    let stale = false;
    try { await this.refresh(); } catch { if (!this.index) fail('Reward history is temporarily unavailable.'); stale = true; }
    const current = await this.identity(actorId, context);
    if (current.wallet !== initial.wallet) fail('Your receiving wallet changed. Refresh to see your rewards.', 401);
    let prices; try { prices = this.prices(); } catch { prices = new Map(); }
    const person = this.index.wallets.get(current.wallet) || { creator: blank(), holders: blank() }, now = this.now();
    return { wallet: current.wallet, requiresWalletSignIn: false, updatedAt: this.at, refreshMs: 60000, stale, scope: 'confirmed_curve_payments',
      creator: money(person.creator, this.index.complete.creator, prices, now), holders: money(person.holders, this.index.complete.holders, prices, now) };
  }
}
