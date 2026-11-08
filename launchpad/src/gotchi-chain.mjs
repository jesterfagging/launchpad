import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, unpackMint, unpackAccount, getTransferFeeConfig, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction } from '@solana/spl-token';
import { LaunchChain } from './launchpad-chain.mjs';
import { ProtocolTreasuryChain } from './protocol-treasury-chain.mjs';
import { readMintTokenAccounts } from './launchpad-token-accounts.mjs';
import { associatedTokenAccountSize } from './launchpad-token-account-size.mjs';
import { verifySignedTransaction, transactionSize } from './providers.mjs';
import { requireValue as ok } from '../public/launchpad-model.mjs';

const SOL = NATIVE_MINT.toBase58(), MAX_U64 = 18446744073709551615n, FEE_LIMIT = 20000n, MAX_AIRDROP_RECIPIENTS = 4, EXTRA_COST_LIMIT = 15000000n;
const pk = value => new PublicKey(value), hash = value => createHash('sha256').update(value).digest('hex');
const quantity = (value, zero = false) => { ok(typeof value === 'string' && (zero ? /^(?:0|[1-9]\d{0,19})$/ : /^[1-9]\d{0,19}$/).test(value) && BigInt(value) <= MAX_U64, 'Invalid Gotchi raw amount.'); return BigInt(value); };
const lamports = value => { ok(Number.isSafeInteger(value) && value >= 0, 'The RPC returned an invalid SOL balance.'); return BigInt(value); };
const wallet = value => { const key = pk(value); ok(key.toBase58() === value && PublicKey.isOnCurve(key.toBytes()), 'Invalid Gotchi wallet.'); return key; };
function receiptKeys(tx) {
  const message = tx.transaction?.message, keys = message?.staticAccountKeys || message?.accountKeys;
  ok(Array.isArray(keys), 'The finalized Gotchi receipt is missing account keys.');
  const base = keys.map(value => String(value.pubkey || value));
  const result = base.length === tx.meta?.preBalances?.length ? base : [...base, ...(tx.meta?.loadedAddresses?.writable || []).map(String), ...(tx.meta?.loadedAddresses?.readonly || []).map(String)];
  ok(result.length === tx.meta?.preBalances?.length && result.length === tx.meta?.postBalances?.length && new Set(result).size === result.length, 'The finalized Gotchi receipt contains incomplete account balances.');
  return result;
}
function nativeDelta(tx, keys, address) { const index = keys.indexOf(address); ok(index >= 0, 'The finalized Gotchi receipt omitted an expected account.'); return lamports(tx.meta.postBalances[index]) - lamports(tx.meta.preBalances[index]); }
function tokenBalance(tx, keys, side, account) {
  const rows = tx.meta?.[side + 'TokenBalances']; ok(Array.isArray(rows), 'The finalized Gotchi receipt omitted token balances.');
  let total = 0n;
  for (const row of rows) { ok(Number.isSafeInteger(row.accountIndex) && row.accountIndex >= 0 && row.accountIndex < keys.length, 'The finalized Gotchi receipt contains invalid token-account indexes.'); if (keys[row.accountIndex] === account) total += quantity(String(row.uiTokenAmount?.amount ?? '0'), true); }
  return total;
}
// Token-2022 transfer fees apply to airdropped tokens; the worst case of the
// older and newer schedules bounds the recipient's net credit.
export function transferFeeBounds(amount, fee) {
  const value = quantity(String(amount), true);
  if (!fee) return { min: value, max: value };
  const schedules = [fee.olderTransferFee, fee.newerTransferFee].filter(Boolean);
  let worst = 0n;
  for (const row of schedules) { const bps = BigInt(row.transferFeeBasisPoints || 0), cap = BigInt(row.maximumFee || 0); let charge = (value * bps + 9999n) / 10000n; if (charge > cap) charge = cap; if (charge > worst) worst = charge; }
  return { min: value > worst ? value - worst : 0n, max: value };
}

/** Gotchi vault adapter: the protocol treasury's convert/acquire route plus a
 * verified multi-recipient airdrop. Keys are used only after simulation; the
 * service journals signed bytes before any broadcast. */
export class GotchiChain extends ProtocolTreasuryChain {
  // One reference read serves every Gotchi of a worker pass (adapters are
  // created per pass); a stale cache is never returned beyond 30 seconds.
  async solUsd() {
    if (this.solUsdCache && this.now() - this.solUsdCache.readAt < 30000) return this.solUsdCache.value;
    const info = await this.mintInfo(SOL), price = await this.referencePrice({ quoteMint: SOL }, info);
    const usd = Number(price?.usd), at = Number(price?.at);
    ok(Number.isFinite(usd) && usd > 0 && usd < 1e9 && Number.isSafeInteger(at) && at > 0 && price.stale !== true, 'A fresh SOL/USD reference is unavailable.');
    const value = { usd, at, source: String(price.source || 'Live market reference').slice(0, 120) };
    this.solUsdCache = { readAt: this.now(), value }; return value;
  }
  async mintSummary(mint) {
    const key = pk(mint), result = await this.c.getAccountInfoAndContext(key, { commitment: 'finalized' });
    ok(Number.isSafeInteger(result?.context?.slot) && result.value && !result.value.executable && [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(p => p.equals(result.value.owner)), 'The Gotchi coin mint was not found.');
    const decoded = unpackMint(key, result.value, result.value.owner);
    ok(decoded.isInitialized && decoded.decimals <= 12, 'The Gotchi coin mint is not initialized.');
    const fee = getTransferFeeConfig(decoded);
    return { mint, program: result.value.owner.toBase58(), decimals: decoded.decimals, supply: decoded.supply.toString(), slot: result.context.slot, transferFee: fee ? { older: { bps: fee.olderTransferFee.transferFeeBasisPoints, maximumFee: fee.olderTransferFee.maximumFee.toString() }, newer: { bps: fee.newerTransferFee.transferFeeBasisPoints, maximumFee: fee.newerTransferFee.maximumFee.toString() } } : null };
  }
  async vaultBalances({ address, mints = [] }) {
    const owner = wallet(address), keys = [owner];
    const atas = mints.map(row => { const key = pk(row.mint), program = pk(row.program); ok([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(p => p.equals(program)), 'Unsupported Gotchi token program.'); return { mint: row.mint, program, key, ata: getAssociatedTokenAddressSync(key, owner, false, program) }; });
    for (const row of atas) keys.push(row.ata);
    const snapshot = await this.c.getMultipleAccountsInfoAndContext(keys, { commitment: 'finalized' });
    ok(Number.isSafeInteger(snapshot?.context?.slot) && Array.isArray(snapshot.value) && snapshot.value.length === keys.length, 'The RPC returned an incomplete Gotchi vault snapshot.');
    const native = snapshot.value[0];
    ok(native === null || (!native.executable && native.owner.equals(SystemProgram.programId) && native.data.length === 0), 'The Gotchi vault must be an ordinary SOL wallet.');
    const tokens = atas.map((row, index) => {
      const info = snapshot.value[index + 1];
      if (!info) return { mint: row.mint, ata: row.ata.toBase58(), amount: '0', exists: false };
      ok(!info.executable && info.owner.equals(row.program), 'A Gotchi vault token account has the wrong program.');
      const account = unpackAccount(row.ata, info, row.program);
      ok(account.mint.equals(row.key) && account.owner.equals(owner) && account.isInitialized, 'A Gotchi vault token account has unexpected ownership.');
      return { mint: row.mint, ata: row.ata.toBase58(), amount: account.amount.toString(), exists: true, frozen: account.isFrozen };
    });
    return { address, slot: snapshot.context.slot, lamports: native ? lamports(native.lamports).toString() : '0', tokens };
  }
  // A complete finalized scan of one mint, aggregated by owner. Program-owned
  // (off-curve) holders, frozen accounts and the exclusion set never count.
  async holderSnapshot({ mint, program, exclude = [] }) {
    const key = pk(mint), owner = pk(program), excluded = new Set(exclude);
    const response = await readMintTokenAccounts(this, owner, key);
    const balances = new Map(); let scanned = 0, skipped = 0;
    for (const row of response.value) {
      scanned++;
      const account = unpackAccount(row.pubkey, row.account, owner), holder = account.owner.toBase58();
      if (!account.amount || account.isFrozen || excluded.has(holder) || excluded.has(row.pubkey.toBase58()) || !PublicKey.isOnCurve(account.owner.toBytes())) { skipped++; continue; }
      balances.set(holder, (balances.get(holder) || 0n) + account.amount);
    }
    return { mint, slot: response.context.slot, at: this.now(), rows: [...balances].sort(([a], [b]) => a.localeCompare(b)).map(([holder, amount]) => ({ owner: holder, amount: amount.toString() })), scanned, skipped, complete: true };
  }
  async prepareAirdrop({ wallet: signer, mint, payouts, minSolReserve = '0', maxNetworkCostLamports = '15000000' }) {
    const owner = wallet(signer?.address); ok(typeof signer?.secret === 'string' && signer.secret.length > 0, 'A managed Gotchi vault signer is required.');
    ok(Array.isArray(payouts) && payouts.length > 0 && payouts.length <= MAX_AIRDROP_RECIPIENTS, `Airdrops send to one to ${MAX_AIRDROP_RECIPIENTS} recipients per transaction.`);
    const maxCost = quantity(maxNetworkCostLamports), reserve = quantity(minSolReserve, true); ok(maxCost <= EXTRA_COST_LIMIT, 'The Gotchi network-cost limit is too large.');
    const rows = payouts.map(row => ({ owner: wallet(row.owner).toBase58(), lamports: quantity(String(row.lamports), true), tokens: quantity(String(row.tokens), true) }));
    ok(new Set(rows.map(row => row.owner)).size === rows.length && rows.every(row => row.owner !== owner.toBase58() && (row.lamports > 0n || row.tokens > 0n)), 'Airdrop recipients must be distinct wallets other than the vault with a positive share.');
    const totalLamports = rows.reduce((sum, row) => sum + row.lamports, 0n), totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0n);
    const summary = totalTokens > 0n ? await this.mintSummary(mint) : null, program = summary ? pk(summary.program) : TOKEN_PROGRAM_ID, mintKey = summary ? pk(mint) : null;
    const vaultAta = summary ? getAssociatedTokenAddressSync(mintKey, owner, false, program) : null;
    const recipientAtas = summary ? rows.map(row => getAssociatedTokenAddressSync(mintKey, pk(row.owner), false, program)) : [];
    const addresses = [owner.toBase58(), ...(vaultAta ? [vaultAta.toBase58()] : []), ...rows.map(row => row.owner), ...recipientAtas.map(String)];
    const before = await this.c.getMultipleAccountsInfoAndContext(addresses.map(pk), { commitment: 'finalized' });
    ok(Number.isSafeInteger(before?.context?.slot) && Array.isArray(before.value) && before.value.length === addresses.length, 'The RPC returned an incomplete airdrop snapshot.');
    const vaultInfo = before.value[0]; ok(vaultInfo && !vaultInfo.executable && vaultInfo.owner.equals(SystemProgram.programId) && vaultInfo.data.length === 0, 'The Gotchi vault must be an ordinary SOL wallet.');
    const vaultLamports = lamports(vaultInfo.lamports); let vaultTokens = 0n;
    if (summary) { const info = before.value[1]; ok(info && info.owner.equals(program), 'The Gotchi vault does not hold the winning coin.'); const account = unpackAccount(vaultAta, info, program); ok(account.mint.equals(mintKey) && account.owner.equals(owner) && !account.isFrozen, 'The Gotchi vault token account is unavailable.'); vaultTokens = account.amount; ok(vaultTokens >= totalTokens, 'The Gotchi vault holds fewer winning tokens than the airdrop plan.'); }
    const mintAccount = summary ? await this.c.getAccountInfo(mintKey, 'finalized') : null; ok(!summary || (mintAccount && mintAccount.owner.equals(program)), 'The winning coin mint is unavailable.');
    const rentSize = summary ? associatedTokenAccountSize({ mint: unpackMint(mintKey, mintAccount, program), program }) : 0;
    const ataRent = summary ? lamports(await this.c.getMinimumBalanceForRentExemption(rentSize, 'finalized')) : 0n;
    const instructions = [];
    let rentBudget = 0n;
    rows.forEach((row, index) => {
      if (row.lamports > 0n) instructions.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: pk(row.owner), lamports: row.lamports }));
      if (row.tokens > 0n) {
        const destination = recipientAtas[index], existing = before.value[(vaultAta ? 2 : 1) + rows.length + index];
        if (existing) { ok(existing.owner.equals(program), 'A recipient token account has the wrong program.'); const account = unpackAccount(destination, existing, program); ok(account.mint.equals(mintKey) && account.owner.equals(pk(row.owner)) && !account.isFrozen, 'A recipient token account is unavailable.'); }
        else rentBudget += ataRent;
        instructions.push(createAssociatedTokenAccountIdempotentInstruction(owner, destination, pk(row.owner), mintKey, program), createTransferCheckedInstruction(vaultAta, mintKey, destination, owner, row.tokens, summary.decimals, [], program));
      }
    });
    const block = await this.c.getLatestBlockhash('finalized'); ok(Number.isSafeInteger(block.lastValidBlockHeight) && block.lastValidBlockHeight >= 151, 'The RPC omitted airdrop transaction expiry.');
    const message = new TransactionMessage({ payerKey: owner, recentBlockhash: block.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }), ...instructions] }).compileToV0Message();
    ok(message.header.numRequiredSignatures === 1 && transactionSize(message) <= 1232, 'The airdrop transaction is too large or needs another signer.');
    const fee = lamports((await this.c.getFeeForMessage(message, 'finalized'))?.value); ok(fee > 0n && fee <= FEE_LIMIT, 'The airdrop network fee exceeds its limit.');
    ok(fee + rentBudget <= maxCost, 'The airdrop network and rent cost exceeds its operation limit.');
    ok(vaultLamports >= totalLamports + fee + rentBudget + reserve, 'The Gotchi vault cannot fund this airdrop and keep its reserve.');
    const tx = new VersionedTransaction(message);
    const sim = await this.simulatePrepared(tx, { sigVerify: false, commitment: 'finalized', minContextSlot: before.context.slot, accounts: { encoding: 'base64', addresses } }, block.lastValidBlockHeight);
    ok(!sim.value?.err, `Airdrop simulation failed: ${JSON.stringify(sim.value?.err)}.`);
    ok(Number.isSafeInteger(sim.context?.slot) && sim.context.slot >= before.context.slot && Array.isArray(sim.value.accounts) && sim.value.accounts.length === addresses.length, 'The RPC omitted airdrop simulation balances.');
    const simLamports = index => { const info = sim.value.accounts[index]; if (info === null) return 0n; ok(info && Number.isSafeInteger(info.lamports), 'The airdrop simulation omitted a balance.'); return BigInt(info.lamports); };
    ok(sim.value.accounts[0] !== null, 'The airdrop simulation omitted the vault balance.');
    const afterVault = simLamports(0), spent = vaultLamports - afterVault;
    ok(spent >= totalLamports + fee && spent <= totalLamports + fee + rentBudget && afterVault >= reserve, 'The airdrop simulation spent an unexpected amount from the vault.');
    rows.forEach((row, index) => { const previous = before.value[(vaultAta ? 2 : 1) + index], prior = previous ? lamports(previous.lamports) : 0n; ok(simLamports((vaultAta ? 2 : 1) + index) - prior === row.lamports, 'A recipient would not receive its exact SOL share.'); });
    const secret = bs58.decode(signer.secret); let bytes;
    try { const keypair = Keypair.fromSecretKey(secret); ok(keypair.publicKey.equals(owner), 'The Gotchi vault signer does not match its wallet.'); tx.sign([{ publicKey: keypair.publicKey, secretKey: secret }]); bytes = Buffer.from(tx.serialize()); verifySignedTransaction(bytes, owner.toBase58()); }
    finally { secret.fill(0); }
    const fees = summary?.transferFee ? { olderTransferFee: { transferFeeBasisPoints: summary.transferFee.older.bps, maximumFee: BigInt(summary.transferFee.older.maximumFee) }, newerTransferFee: { transferFeeBasisPoints: summary.transferFee.newer.bps, maximumFee: BigInt(summary.transferFee.newer.maximumFee) } } : null;
    return { kind: 'airdrop', mint: summary ? mint : SOL, wallet: owner.toBase58(), inputAmount: totalLamports.toString(), tokenAmount: totalTokens.toString(), minimumOutput: '0', expectedOutput: '0', payouts: rows.map((row, index) => ({ owner: row.owner, lamports: row.lamports.toString(), tokens: row.tokens.toString(), ata: recipientAtas[index]?.toBase58() || null, minTokens: transferFeeBounds(row.tokens.toString(), fees).min.toString() })), signature: bs58.encode(tx.signatures[0]), raw: bytes.toString('base64'), rawHash: hash(bytes), ...block, preparedSlot: sim.context.slot, createdAt: this.now(), accounting: { maxCostLamports: maxCost.toString(), rentBudgetLamports: rentBudget.toString(), networkFeeLamports: fee.toString(), monitoredAccounts: [], ata: vaultAta?.toBase58() || null, program: program.toBase58(), decimals: summary?.decimals ?? 9, minSolReserve: reserve.toString(), beforeSol: vaultLamports.toString(), beforeTokens: vaultTokens.toString(), transferFee: summary?.transferFee || null } };
  }
  async receipt(op, walletAddress = op?.wallet) {
    if (op?.kind !== 'airdrop') return super.receipt(op, walletAddress);
    const { tx: signed } = this.verifyOperation(op); ok(walletAddress === op.wallet, 'The airdrop receipt belongs to another wallet.');
    const tx = await LaunchChain.prototype.receipt.call(this, op); if (!tx) return null;
    ok(tx.transaction?.signatures?.[0] === op.signature && Number.isSafeInteger(tx.slot) && tx.slot >= 0 && tx.meta && Object.hasOwn(tx.meta, 'err'), 'The finalized airdrop receipt is incomplete or has the wrong signature.');
    ok(Buffer.from(tx.transaction.message.serialize()).equals(Buffer.from(signed.message.serialize())), 'The finalized airdrop differs from its saved message.');
    const keys = receiptKeys(tx), fee = lamports(tx.meta.fee), failed = tx.meta.err !== null, vaultDelta = nativeDelta(tx, keys, op.wallet), totalLamports = quantity(op.inputAmount, true), maxCost = quantity(op.accounting.maxCostLamports);
    const result = { state: failed ? 'failed' : 'confirmed', signature: op.signature, slot: tx.slot, feeLamports: fee.toString(), inputAmount: op.inputAmount, tokenAmount: op.tokenAmount, outputAmount: '0', solDelta: vaultDelta.toString(), tokenDelta: '0', actualSolCostLamports: fee.toString(), outputDecimals: op.accounting.decimals, recipients: [], error: failed ? tx.meta.err : null };
    if (failed) { ok(vaultDelta === -fee, 'A failed airdrop receipt changed unexpected balances.'); return result; }
    let tokensOut = 0n;
    for (const row of op.payouts) {
      const sol = nativeDelta(tx, keys, row.owner); ok(sol === quantity(row.lamports, true), 'A winner did not receive its exact SOL share.');
      let tokens = 0n;
      if (BigInt(row.tokens) > 0n) { tokens = tokenBalance(tx, keys, 'post', row.ata) - tokenBalance(tx, keys, 'pre', row.ata); ok(tokens >= quantity(row.minTokens, true) && tokens <= quantity(row.tokens), 'A winner did not receive its token share.'); tokensOut += quantity(row.tokens); }
      result.recipients.push({ owner: row.owner, lamports: sol.toString(), tokens: tokens.toString() });
    }
    if (op.accounting.ata) { const delta = tokenBalance(tx, keys, 'pre', op.accounting.ata) - tokenBalance(tx, keys, 'post', op.accounting.ata); ok(delta === quantity(op.tokenAmount, true), 'The vault token debit differs from the airdrop plan.'); result.tokenDelta = (-delta).toString(); }
    const cost = -vaultDelta - totalLamports; ok(cost >= fee && cost <= maxCost, 'The finalized airdrop cost exceeds its reserved amount.');
    result.actualSolCostLamports = cost.toString(); result.outputAmount = tokensOut.toString();
    ok(lamports(tx.meta.postBalances[keys.indexOf(op.wallet)]) >= quantity(op.accounting.minSolReserve, true), 'The vault balance fell below its reserve.');
    return result;
  }
}
