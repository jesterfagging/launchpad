import { createHash, randomInt } from 'node:crypto';
import { PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import * as client from './pump-public-client.mjs';
import { verifyPublicDeployment } from './pump-public-deployment-service.mjs';
import { PUMP_TEST_PAIR_PROVENANCE } from './pump-test-pairs.mjs';
import { launchpadEnv } from './brand-env.mjs';
import { LaunchChain } from './launchpad-chain.mjs';

const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const MAX_PACKET = 1232, SUPPLY = 1000000000000000n;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, statusCode = 409) => { throw Object.assign(Error(message), { statusCode }); };
const ensure = (condition, message) => { if (!condition) fail(message); };
const json = value => JSON.parse(JSON.stringify(value, (_, x) => typeof x === 'bigint' ? String(x) : x));
const phases = ['trading', 'bonded', 'migrated'];
const keys = a => Object.fromEntries(Object.entries(a).filter(([, value]) => value?.toBase58).map(([key, value]) => [key, value.toBase58()]));

/** Require the actual mint and burn instructions and zero custody LP at receipt. */
export function verifyPublicLpBurn(receipt, state, a) {
  ensure(state.phase === 2 && state.pool === a.pool.toBase58() && BigInt(state.burnedLp) > 0n, 'The finalized state does not prove migration.');
  const instructions = (receipt.meta?.innerInstructions || []).flatMap(row => row.instructions || []);
  const amount = row => row.parsed?.info?.amount ?? row.parsed?.info?.tokenAmount?.amount;
  const burns = instructions.filter(row => String(row.programId) === TOKEN_2022_PROGRAM_ID.toBase58() && ['burn','burnChecked'].includes(row.parsed?.type) && row.parsed.info.mint === a.lpMint.toBase58() && row.parsed.info.authority === a.authority.toBase58());
  const mints = instructions.filter(row => String(row.programId) === TOKEN_2022_PROGRAM_ID.toBase58() && ['mintTo','mintToChecked'].includes(row.parsed?.type) && row.parsed.info.mint === a.lpMint.toBase58());
  ensure(burns.length === 1 && burns[0].parsed.info.account === a.authorityLp.toBase58() && BigInt(amount(burns[0])) === BigInt(state.burnedLp), 'The migration receipt does not prove the expected LP burn.');
  const issued = mints.reduce((sum, row) => sum + BigInt(amount(row)), 0n);
  ensure(issued === BigInt(state.burnedLp) && mints.every(row => row.parsed.info.account === a.authorityLp.toBase58() && row.parsed.info.mintAuthority === a.pool.toBase58()), 'The LP tokens issued and burned do not match.');
  const accountKeys = receipt.transaction.message.accountKeys.map(key => typeof key === 'string' ? key : key.pubkey.toString());
  const index = accountKeys.indexOf(a.authorityLp.toBase58());
  const balance = receipt.meta.postTokenBalances?.find(row => row.accountIndex === index && row.mint === a.lpMint.toBase58());
  ensure(index >= 0 && balance?.owner === a.authority.toBase58() && balance.uiTokenAmount.amount === '0', 'The migration receipt does not show zero retained LP.');
  return { issuedLpAtoms: issued.toString(), burnedLpAtoms: state.burnedLp, retainedLpAtoms: '0', graduationPaidLamports: state.graduationPaid, lpMint: a.lpMint.toBase58(), poolId: a.pool.toBase58() };
}

/** Read-only construction and exact signed-wire submission. Signers live in service. */
export class PumpPublicClientAdapter {
  constructor({ connection, rpcUrl, rpcGate, now = Date.now, deploymentVerifier = verifyPublicDeployment, randomPoolIndex = () => randomInt(65536) } = {}) {
    if (!connection) this.transport = new LaunchChain({ network: 'mainnet-beta', rpcUrl: rpcUrl || launchpadEnv('PUMP_PUBLIC_RPC_URL') || launchpadEnv('PUBLIC_RPC_URL') || 'https://api.mainnet-beta.solana.com', rpcGate });
    this.connection = connection || this.transport.c;
    this.now = now; this.deploymentVerifier = deploymentVerifier; this.randomPoolIndex = randomPoolIndex;
  }
  close() { this.transport?.close?.(); }
  async verifyDeployment(config) { const result = await this.deploymentVerifier({ connection: this.connection, config }); return { ...result, enabled: result.chainEnabled === true }; }
  async verifyPump() {
    const program = await this.connection.getAccountInfo(new PublicKey(client.PUBLIC_PUMP), 'finalized');
    ensure(program?.executable && program.owner.toBase58() === LOADER && program.data.length === 36 && program.data.readUInt32LE(0) === 2, 'PumpSwap program is unavailable.');
    const dataKey = new PublicKey(program.data.subarray(4,36));
    const header = await this.connection.getAccountInfo(dataKey, { commitment: 'finalized', dataSlice: { offset: 0, length: 45 } });
    ensure(header?.owner.toBase58() === LOADER && header.data.length === 45 && header.data.readUInt32LE(0) === 3, 'PumpSwap ProgramData is unavailable.');
    const identity = `${dataKey.toBase58()}:${header.data.toString('hex')}`;
    if (this.pumpIdentity === identity) return;
    const account = await this.connection.getAccountInfo(dataKey, 'finalized');
    ensure(account?.owner.toBase58() === LOADER && account.data.readUInt32LE(0) === 3 && hash(account.data.subarray(45)) === PUMP_TEST_PAIR_PROVENANCE.programSha256, 'PumpSwap changed since compatibility verification. Existing curve holders can sell while the new version is reviewed.');
    ensure(account.data.subarray(0,45).equals(header.data), 'PumpSwap changed during compatibility verification.');
    this.pumpIdentity = identity;
  }
  async deriveMint(wallet, seed) { return (await PublicKey.createWithSeed(new PublicKey(wallet), seed, TOKEN_PROGRAM_ID)).toBase58(); }
  async balance(_config, wallet) { return String(await this.connection.getBalance(new PublicKey(wallet), 'confirmed')); }
  async rawState(config, launch, commitment = 'confirmed', minContextSlot) {
    const a = client.addresses({ programId: config.programId, mint: launch.mint });
    const result = await this.connection.getAccountInfoAndContext(a.state, { commitment, ...(minContextSlot === undefined ? {} : { minContextSlot }) });
    if (!result.value) return { state: null, slot: result.context.slot, addresses: a };
    const state = client.decodeState(result.value, config.programId);
    ensure(state.mint === launch.mint && state.creator === launch.creatorWallet && state.solUsdMicros === launch.priceSnapshot.solUsdMicros, 'The curve does not match the registered launch.');
    return { state, slot: result.context.slot, addresses: a };
  }
  async state(config, launch) { const { state } = await this.rawState(config, launch, 'finalized'); return state ? { ...state, phase: phases[state.phase], poolId: state.phase === 2 ? state.pool : null } : null; }
  async wallet(config, launch, wallet) {
    const a = client.addresses({ programId: config.programId, mint: launch.mint, user: wallet });
    const [nativeBalanceLamports, token] = await Promise.all([this.balance(config, wallet), this.connection.getAccountInfo(a.userAta, 'confirmed')]);
    if (token) ensure(token.owner.equals(TOKEN_PROGRAM_ID) && token.data.length >= 165 && new PublicKey(token.data.subarray(0,32)).equals(a.mint) && new PublicKey(token.data.subarray(32,64)).toBase58() === wallet, 'Token account identity mismatch.');
    return { wallet, nativeBalanceLamports, baseBalanceRaw: token ? token.data.readBigUInt64LE(64).toString() : '0', baseDecimals: 6 };
  }
  async creatorFeesReady(config, launch, state) {
    const recipient=await this.connection.getAccountInfo(new PublicKey(launch.creatorWallet),'confirmed');
    const rent=await this.connection.getMinimumBalanceForRentExemption(recipient?.data.length||0,'confirmed');
    return BigInt(recipient?.lamports||0)+BigInt(state.creatorFeesPending||'0')>=BigInt(rent);
  }
  async cleanPool(config, launch) {
    for (let n = 0; n < 8; n++) { const index = this.randomPoolIndex(), a = client.addresses({ programId: config.programId, mint: launch.mint, poolIndex: index }); const rows = await this.connection.getMultipleAccountsInfo([a.pool,a.lpMint,a.authorityLp,a.poolBase,a.poolQuote], 'finalized'); if (rows.every(row => row === null)) return { index, addresses: a }; }
    fail('An unused PumpSwap pool address could not be selected. Graduation will retry automatically.');
  }
  async prepare(config, { action, wallet, launch, amountRaw = '0', slippageBps = 100, relayer, now = this.now() }) {
    await this.verifyDeployment(config); if (['initialize','buy','migrate'].includes(action)) await this.verifyPump();
    const programId = config.programId, user = new PublicKey(wallet), instructions = [], review = {}, amount = BigInt(amountRaw);
    let a = client.addresses({ programId, mint: launch.mint, user: wallet }), poolIndex = 0, debit = 0n, trade = null;
    const model = client.publicModel(launch.priceSnapshot.solUsdMicros);
    if (action === 'initialize') {
      ensure(!await this.connection.getAccountInfo(a.state, 'finalized') && !await this.connection.getAccountInfo(a.mint, 'finalized'), 'This mint was already initialized.');
      const [mintRent, stateRent, tokenRent, metadataRent, vaultFloor] = await Promise.all([82,320,165,607,0].map(size => this.connection.getMinimumBalanceForRentExemption(size, 'confirmed')));
      const plan = await client.initializeIxs({ programId, creator: wallet, relayer, mintSeed: launch.mintSeed, solUsdMicros: launch.priceSnapshot.solUsdMicros, expiresUnix: String(Math.floor(now / 1000) + 120), mintRentLamports: String(mintRent), name: launch.name, symbol: launch.symbol, metadataUri: launch.metadataUri });
      ensure(plan.mint === launch.mint, 'The mint changed during review.'); instructions.push(...plan.instructions); a = plan.addresses;
      debit = BigInt(mintRent + stateRent + tokenRent + metadataRent + vaultFloor) + 10000000n + BigInt(client.PUBLIC_POLICY.migrationRentLamports);
      const launchFees = debit;
      if (amount > 0n) {
        const initialState = { phase: 0, virtualBase: client.PUBLIC_POLICY.virtualBaseRaw, virtualQuote: model.virtualQuoteRaw, sold: '0', cap: client.PUBLIC_POLICY.soldCapRaw, quote: '0' };
        trade = client.quoteTrade(initialState, { side: 'buy', amount: amountRaw, slippageBps });
        ensure(BigInt(trade.output) <= SUPPLY / 10n, 'The first buy cannot exceed 10% of the token supply. Reduce the first buy.');
        instructions.push(...client.tradeIxs({ programId, mint: launch.mint, user: wallet, creator: launch.creatorWallet, side: 'buy', amount: amountRaw, minimum: trade.minimum })); debit += BigInt(trade.charged) + BigInt(tokenRent);
      }
      Object.assign(review, { launchFeeLamports: launchFees.toString(), firstBuyLamports: trade ? (BigInt(trade.charged)-BigInt(trade.creatorFee)).toString() : '0', tokenAmountRaw: trade?.output || '0', minOutputRaw: trade?.minimum || '0', migrationRentLamports: client.PUBLIC_POLICY.migrationRentLamports, ...model });
      if (launch.creationFee && BigInt(launch.creationFee.lamports) > 0n) { instructions.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: new PublicKey(launch.creationFee.recipient), lamports: BigInt(launch.creationFee.lamports) })); debit += BigInt(launch.creationFee.lamports); review.creationFeeLamports = launch.creationFee.lamports; review.creationFeeRecipient = launch.creationFee.recipient; }
    } else if (action === 'buy' || action === 'sell') {
      const snapshot = await this.rawState(config, launch), state = snapshot.state; ensure(state && state.phase !== 2, 'This token has graduated to PumpSwap. Refresh its page to trade.');
      trade = client.quoteTrade(state, { side: action, amount: amountRaw, slippageBps });
      instructions.push(...client.tradeIxs({ programId, mint: launch.mint, user: wallet, creator: launch.creatorWallet, side: action, amount: amountRaw, minimum: trade.minimum }));
      if (action === 'buy') debit = BigInt(trade.charged);
      const balances = await this.wallet(config, launch, wallet);
      if (action === 'sell') ensure(BigInt(balances.baseBalanceRaw) >= amount, 'Your wallet does not have enough tokens.');
      const token = await this.connection.getAccountInfo(a.userAta, 'confirmed'); if (!token) debit += BigInt(await this.connection.getMinimumBalanceForRentExemption(165, 'confirmed'));
      Object.assign(review, { side: action, inputRaw: amountRaw, chargedRaw: trade.charged, expectedOutputRaw: trade.output, minOutputRaw: trade.minimum, tradeFeeLamports: trade.fee, protocolFeeLamports: trade.protocolFee, creatorFeeLamports: trade.creatorFee, creatorFeeRecipient: launch.creatorWallet, slippageBps, quoteSlot: snapshot.slot });
    } else if (action === 'creator-fees') {
      ensure(wallet === relayer && relayer === config.relayer, 'Only the managed relayer may prepare automatic creator payouts.');
      const { state } = await this.rawState(config, launch, 'finalized');
      ensure(state && BigInt(state.creatorFeesPending) > 0n, 'No pending creator fees.');
      instructions.push(client.creatorFeesIx({ programId, mint: launch.mint, payer: wallet, creator: launch.creatorWallet }));
      Object.assign(review, {creatorFeeRecipient:launch.creatorWallet,creatorFeeLamports:state.creatorFeesPending});
    } else {
      ensure(action === 'migrate' && wallet === relayer && relayer === config.relayer, 'Only the managed graduation relayer may prepare migration.');
      const { state } = await this.rawState(config, launch, 'finalized'); ensure(state?.phase === 1, 'This launch is not ready to graduate.');
      const selected = await this.cleanPool(config, launch); poolIndex = selected.index; a = selected.addresses;
      instructions.push(client.migrateIx({ programId, mint: launch.mint, relayer, poolIndex }));
      Object.assign(review, { poolIndex, quoteBeforeLamports: state.quote, poolBaseRaw: (SUPPLY - BigInt(state.sold)).toString(), lpPolicy: 'All LP received by the custody PDA is burned atomically.' });
    }
    const units = action === 'migrate' ? 1200000 : action === 'initialize' ? 600000 : 200000;
    const latest = await this.connection.getLatestBlockhash('confirmed');
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: latest.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ...instructions] }).compileToV0Message());
    const bytes = Buffer.from(tx.serialize()); ensure(bytes.length <= MAX_PACKET, 'This launch metadata is too large for one transaction. Shorten the name or image metadata URI.');
    const fee = await this.connection.getFeeForMessage(tx.message, 'confirmed'); ensure(Number.isSafeInteger(fee.value) && fee.value >= 0, 'The transaction network fee is unavailable.'); debit += BigInt(fee.value);
    const balance = BigInt(await this.balance(config, wallet)); ensure(balance >= debit, action === 'migrate' ? 'The graduation relayer needs SOL for transaction gas.' : 'Your wallet needs more SOL for this transaction, account deposits, and network fees.');
    const simulation = await this.connection.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [wallet] } });
    if (simulation.value.err) fail(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}. No transaction was submitted.`);
    const postPayer = simulation.value.accounts?.[0];
    ensure(postPayer && Number.isSafeInteger(postPayer.lamports) && postPayer.lamports >= 0, 'The simulation did not return the payer balance needed to verify your budget.');
    const balanceAfter = await this.connection.getBalance(user, { commitment: 'confirmed', minContextSlot: simulation.context.slot });
    ensure(BigInt(balanceAfter) === balance, 'Your wallet balance changed during review. Refresh the review.');
    const simulatedDebit = balance - BigInt(postPayer.lamports);
    // Sell proceeds may exceed fees. Their required SOL budget is account/rent
    // plus the transaction fee, rather than a negative number.
    if (action !== 'sell') { ensure(simulatedDebit >= BigInt(fee.value), 'The simulation returned an invalid transaction debit.'); debit = simulatedDebit; }
    if (action === 'initialize' && trade && postPayer.lamports === 0) review.firstBuyLamports = trade.charged;
    if (action === 'initialize') review.launchFeeLamports = (debit - BigInt(review.firstBuyLamports) - BigInt(fee.value)).toString();
    Object.assign(review, { maxWalletDebitLamports: debit.toString(), totalSolBudgetLamports: debit.toString(), walletBalanceLamports: balance.toString(), networkFeeLamports: String(fee.value), route: 'curve-pump-public', tokenDecimals: 6 });
    return { unsignedTransaction: bytes.toString('base64'), blockhash: latest, needsRelayer: action === 'initialize', action, poolIndex, addresses: keys(a), review, trade, amountRaw, preparedAt: now };
  }
  send(_config, encoded) { return this.connection.sendRawTransaction(Buffer.from(encoded, 'base64'), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 }); }
  async reconcile(config, op, launch) {
    let status = (await this.connection.getSignatureStatuses([op.signature], { searchTransactionHistory: true })).value[0];
    // Creation can be shown after a verified confirmed receipt; custody and
    // graduation accounting still wait for the immutable finalized receipt.
    const confirmedInitialization = op.action === 'initialize' && status?.confirmationStatus === 'confirmed' && !status.err;
    if (status?.confirmationStatus !== 'finalized' && !confirmedInitialization) {
      const height = await this.connection.getBlockHeight('finalized');
      if (height <= op.bundle.blockhash.lastValidBlockHeight) return { state: 'pending', signature: op.signature };
      const valid = await this.connection.isBlockhashValid(op.bundle.blockhash.blockhash, { commitment: 'finalized' });
      if (valid.value) return { state: 'pending', signature: op.signature };
      status = (await this.connection.getSignatureStatuses([op.signature], { searchTransactionHistory: true })).value[0];
      if (status && status.confirmationStatus !== 'finalized') return { state: 'pending', signature: op.signature };
      if (!status) { if (op.action === 'migrate') { const { state } = await this.rawState(config, launch, 'finalized'); if (state?.phase === 2) return { state: 'pending', signature: op.signature, notice: 'Graduation is complete on-chain; its exact burn receipt is still being indexed.' }; } return { state: 'expired', signature: op.signature }; }
    }
    if (status.err) return { state: 'failed', signature: op.signature, error: 'The on-chain transaction failed. Its transfers were rolled back.' };
    const commitment = confirmedInitialization ? 'confirmed' : 'finalized';
    const wire = await this.connection._rpcRequest('getTransaction', [op.signature, { encoding: 'base64', commitment, maxSupportedTransactionVersion: 0 }]);
    ensure(!wire.error && wire.result?.meta?.err === null && wire.result.transaction?.[0] === op.signedTransaction, 'The receipt does not match the saved signed transaction.');
    const receipt = await this.connection.getParsedTransaction(op.signature, { commitment, maxSupportedTransactionVersion: 0 });
    ensure(receipt?.meta && receipt.meta.err === null, 'The transaction receipt is unavailable.');
    const { state, slot } = await this.rawState(config, launch, commitment, receipt.slot); ensure(state && slot >= receipt.slot, 'The curve state predates the transaction receipt.');
    let result = { state: commitment, signature: op.signature, phase: phases[state.phase], slot: receipt.slot, poolId: state.phase === 2 ? state.pool : null, creatorFeesPending: state.creatorFeesPending, creatorFeesPaid: state.creatorFeesPaid };
    if (op.action === 'migrate') { const a = client.addresses({ programId: config.programId, mint: launch.mint, poolIndex: op.bundle.poolIndex }); Object.assign(result, verifyPublicLpBurn(receipt, state, a)); }
    if (op.action === 'initialize') {
      const mint = await this.connection.getAccountInfo(new PublicKey(launch.mint), {commitment, minContextSlot: receipt.slot});
      const issuance = (receipt.meta.innerInstructions || []).flatMap(row => row.instructions || []).filter(ix => String(ix.programId) === TOKEN_PROGRAM_ID.toBase58() && ['mintTo','mintToChecked'].includes(ix.parsed?.type) && ix.parsed.info.mint === launch.mint);
      const issued = issuance.reduce((sum,ix) => sum + BigInt(ix.parsed.info.amount ?? ix.parsed.info.tokenAmount.amount), 0n);
      ensure(issued === SUPPLY && issuance.every(ix => ix.parsed.info.account === client.addresses({ programId: config.programId, mint: launch.mint }).baseAta.toBase58()), 'The initialization receipt does not prove the expected vault supply.');
      ensure(mint?.owner.equals(TOKEN_PROGRAM_ID) && mint.data.length === 82 && mint.data.readBigUInt64LE(36) <= SUPPLY && mint.data.readUInt32LE(0) === 0 && mint.data.readUInt32LE(46) === 0, 'The mint supply and revoked authorities could not be verified.');
    }
    if (['buy','sell'].includes(op.action) || op.action === 'initialize' && op.bundle.trade) {
      const side = op.action === 'sell' ? 'sell' : 'buy', accountKeys = receipt.transaction.message.accountKeys.map(k => k.pubkey.toString());
      const a = client.addresses({ programId: config.programId, mint: launch.mint, user: op.wallet }), tokenIndex = accountKeys.indexOf(a.userAta.toBase58());
      const pre = receipt.meta.preTokenBalances?.find(row => row.accountIndex === tokenIndex && row.mint === launch.mint)?.uiTokenAmount.amount || '0', post = receipt.meta.postTokenBalances?.find(row => row.accountIndex === tokenIndex && row.mint === launch.mint)?.uiTokenAmount.amount || '0';
      const tokens = BigInt(post) - BigInt(pre), absolute = tokens < 0n ? -tokens : tokens;
      const transferRows = (receipt.meta.innerInstructions || []).flatMap(row => row.instructions || []).filter(ix => ix.parsed?.type === 'transfer' && ix.program === 'system');
      let quote = 0n;
      if (side === 'buy') quote = transferRows.filter(ix => ix.parsed.info.source === op.wallet && [a.authority.toBase58(),a.state.toBase58(),client.PUBLIC_TREASURY].includes(ix.parsed.info.destination)).reduce((total,ix) => total + BigInt(ix.parsed.info.lamports),0n);
      else { const userIndex = accountKeys.indexOf(op.wallet); quote = BigInt(receipt.meta.postBalances[userIndex]) - BigInt(receipt.meta.preBalances[userIndex]) + BigInt(receipt.meta.fee); }
      if (op.action === 'initialize') quote = BigInt(op.bundle.trade.charged); // Init's reserve transfer is separate from its reviewed first buy.
      ensure(absolute > 0n && quote > 0n && (side === 'buy' ? tokens > 0n : tokens < 0n), 'The trade receipt does not show the expected wallet token movement.');
      result.trade = { side, amount: Number(absolute) / 1e6, quote: Number(quote) / 1e9, amountRaw: absolute.toString(), quoteRaw: quote.toString(), time: receipt.blockTime || Math.floor(this.now()/1000) };
    }
    return json(result);
  }
  async marketSnapshot(config, launch, quote) {
    const { state, slot } = await this.rawState(config, launch); if (!state) return null;
    const priceQuote = Number(state.virtualQuote) / 1e9 / (Number(state.virtualBase) / 1e6), model = client.publicModel(launch.priceSnapshot.solUsdMicros);
    const price = quote && Number.isFinite(Number(quote.usd)) && quote.at <= this.now() + 5000 && this.now() - quote.at <= 60000 ? Number(quote.usd) : null;
    return { mint: launch.mint, curve: launch.stateAddress, status: state.phase === 0 ? 'curve' : state.phase === 1 ? 'migrating' : 'migrated', slot, at: this.now(), supply: 1e9, priceQuote, fdvQuote: priceQuote * 1e9, priceUsd: price === null ? null : priceQuote * price, fdvUsd: price === null ? null : priceQuote * price * 1e9, quote: { mint: client.PUBLIC_POLICY.quoteMint, symbol: 'SOL', usd: price, at: price === null ? null : quote.at, stale: price === null }, raisedQuote: Number(state.quote)/1e9, targetQuote: Number(model.grossQuoteRaw)/1e9, progressPercent: Number(state.sold) / Number(state.cap) * 100, phase: phases[state.phase], poolId: state.phase === 2 ? state.pool : null };
  }
}
