// Transfer hook rules (v71.28) smoke test for operators: runs a hooked Meteora
// launch end to end on DEVNET or a LOCAL TEST VALIDATOR through Launchpad's own
// server code (src/meteora-chain.mjs builds every transaction exactly as the
// site does), signed on this machine with the keypair file you name. It refuses
// mainnet (genesis hash check) and never prints a secret. Steps, in order:
//   launch   create the hooked curve config, run the hook setup (and blocklist
//            approvals), create the pool: the three (or more) approvals
//   buy      a small buy through Meteora's hook-aware swap (Launchpad route patching)
//   sell     a small sell (expected to be refused on a Holder vesting coin)
//   refuse   a trade that breaks a rule: must be refused in simulation, naming the rule
//   send     a wallet-to-wallet transfer with spl-token's own hook resolution
//   claim    a creator fee claim through the claim…TradingFee2 instruction
// Usage (from the unzipped source root, after `npm ci --omit=dev`):
//   node scripts/hook-smoke-test.mjs --rpc https://api.devnet.solana.com --wallet C:\path\devnet-wallet.json --program <HOOK_PROGRAM_ID> [--rules anti_dump,max_per_wallet,anti_bundle] [--usd 20000] [--buy-sol 0.001] [--state hook-smoke-state.json] [--step launch|buy|sell|refuse|send|claim|all]
//   --rules-json file.json   a full `{ rules: [{ id, settings }], gateMint?, blocklist?, titheRecipient? }` request instead of --rules
//   --usd N                  the SOL/USD price the curve is built from (20000 → 1 SOL starting FDV; 100000 makes the whole curve cost well under 1 SOL, for a faucet-funded devnet wallet)
// The state file keeps the generated launch keys (config, mint, creator, partner,
// positions) so the script can resume; it is test-network only. Delete it to start a new coin.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedWithTransferHookInstruction, unpackAccount } from '@solana/spl-token';
import { TransactionMessage, ComputeBudgetProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { MeteoraChainAdapter } from '../src/meteora-chain.mjs';
import { hookLaunchRequest, hookRuleById, describeHookRule, HOOK_ROUTES } from '../public/hook-catalog.mjs';

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback; };
if (args.includes('--help') || args.includes('-h') || !option('--wallet') || !option('--program')) {
  console.log('usage: node scripts/hook-smoke-test.mjs --rpc <url> --wallet <keypair.json> --program <hook program id> [--rules a,b,c | --rules-json file] [--usd 20000] [--buy-sol 0.001] [--state file] [--step all]');
  process.exit(option('--wallet') && option('--program') ? 0 : 2);
}
const rpcUrl = option('--rpc', 'https://api.devnet.solana.com');
if (/mainnet/i.test(rpcUrl)) { console.error('refusing: this smoke test never runs against mainnet'); process.exit(2); }
const walletFile = option('--wallet'), programId = new PublicKey(option('--program')), stateFile = option('--state', 'hook-smoke-state.json');
const usd = Number(option('--usd', '20000')), buySol = Number(option('--buy-sol', '0.001')), step = option('--step', 'all');
if (!(usd > 0) || !(buySol > 0)) { console.error('--usd and --buy-sol must be positive numbers'); process.exit(2); }

const keypairFromFile = file => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, 'utf8'))));
const wallet = keypairFromFile(walletFile);
const connection = new Connection(rpcUrl, 'confirmed');
const genesis = await connection.getGenesisHash();
if (genesis === MAINNET_GENESIS) { console.error('refusing: the RPC at ' + rpcUrl + ' is mainnet-beta'); process.exit(2); }
const cluster = genesis === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' ? 'devnet' : genesis === '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY' ? 'testnet' : 'custom';
const explorer = sig => `https://explorer.solana.com/tx/${sig}?cluster=${cluster === 'custom' ? 'custom&customUrl=' + encodeURIComponent(rpcUrl) : cluster}`;

const results = [];
const pass = (name, text) => { results.push([name, 'PASS', text]); console.log(`PASS ${name}: ${text}`); };
const fail = (name, text) => { results.push([name, 'FAIL', text]); console.error(`FAIL ${name}: ${text}`); };
const info = text => console.log('     ' + text);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- state: generated launch keys (test network only) --------------------------------------------------------------------------
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const keyNames = ['config', 'mint', 'creator', 'partner', 'positionOne', 'positionTwo', 'recipient', 'friend'];
state.keys ||= {};
for (const name of keyNames) if (!state.keys[name]) state.keys[name] = bs58.encode(Keypair.generate().secretKey);
const keys = Object.fromEntries(keyNames.map(name => [name, Keypair.fromSecretKey(bs58.decode(state.keys[name]))]));
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
save();
const signers = new Map([[wallet.publicKey.toBase58(), wallet], ...Object.values(keys).map(k => [k.publicKey.toBase58(), k])]);

// ---- the launch record, built like src/meteora-service.mjs builds it -------------------------------------------------------------
const adapter = new MeteoraChainAdapter({ connection });
let request;
if (option('--rules-json')) request = JSON.parse(readFileSync(option('--rules-json'), 'utf8'));
else request = { rules: option('--rules', 'anti_dump,max_per_wallet,anti_bundle').split(',').map(s => s.trim()).filter(Boolean).map(id => ({ id })) };
if (request.rules.some(r => (typeof r === 'string' ? r : r.id) === 'tithe') && !request.titheRecipient) request.titheRecipient = keys.recipient.publicKey.toBase58();
if (request.rules.some(r => (typeof r === 'string' ? r : r.id) === 'blocklist') && !request.blocklist?.length) request.blocklist = [keys.friend.publicKey.toBase58()];
const plan = hookLaunchRequest(request);
if (!plan) { console.error('choose at least one rule'); process.exit(2); }
let gate = null;
if (plan.gateMint) gate = await adapter.hookGateMint(plan.gateMint);
const addresses = await adapter.hookAddresses({ mint: keys.mint.publicKey.toBase58(), quoteMint: NATIVE_MINT.toBase58(), configAddress: keys.config.publicKey.toBase58(), program: programId.toBase58() });
const walletAddress = wallet.publicKey.toBase58(), partner = keys.partner.publicKey.toBase58();
const hook = { ...plan, gateDecimals: gate ? gate.decimals : 0, gateTokenProgram: gate ? gate.program : null, version: 2, program: programId.toBase58(), configPda: addresses.configPda, extraMetasPda: addresses.extraMetasPda, blocklistPda: plan.needsBlocklist ? addresses.blocklistPda : null, exempt: [walletAddress, partner, partner, addresses.dammPoolAuthority], venue: addresses.baseVault, tokenType: 'token2022', createdWithHook: true, allowlist: [], createdAt: state.createdAt || Date.now() };
state.createdAt ||= hook.createdAt; save();
const launch = {
  id: 'hook-smoke', mint: keys.mint.publicKey.toBase58(), configAddress: keys.config.publicKey.toBase58(), creatorAuthority: keys.creator.publicKey.toBase58(), partnerAuthority: partner, leftoverReceiver: partner,
  migrationPositionMints: [keys.positionOne.publicKey.toBase58(), keys.positionTwo.publicKey.toBase58()], name: 'Hook smoke', symbol: 'SMOKE', description: 'transfer hook smoke test', metadataUri: 'https://launchpad.invalid/hook-smoke.json',
  creatorWallet: walletAddress, creatorRecipient: walletAddress, creatorId: 'smoke', hook, quoteMint: NATIVE_MINT.toBase58(), quoteSymbol: 'SOL', quoteDecimals: 9, quoteProgram: TOKEN_PROGRAM_ID.toBase58(), feeMode: 'creator', status: 'draft', createdAt: hook.createdAt,
  priceSnapshot: { usd: String(usd), at: Date.now(), source: 'smoke test' }, creationFee: { lamports: '0', recipient: walletAddress }, firstBuyRaw: '0', slippageBps: 100, treasury: walletAddress, migrationFeePercentage: 0,
};

console.log(`Transfer hook smoke test on ${cluster} (${rpcUrl})`);
info(`wallet ${walletAddress}  balance ${(await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL} SOL`);
info(`hook program ${programId.toBase58()}  mint ${launch.mint}  config ${launch.configAddress}`);
info(`rules: ${plan.rules.map(r => hookRuleById(r.id).name).join(', ')}  route: ${HOOK_ROUTES[plan.route].name}`);
for (const r of plan.rules) info('  ' + describeHookRule(r.id, r.settings));

// ---- signing and sending what the adapter prepares ------------------------------------------------------------------------------
async function send(bundle, label) {
  const tx = VersionedTransaction.deserialize(Buffer.from(bundle.unsignedTransaction, 'base64'));
  const needed = bundle.requiredSigners.map(address => { const k = signers.get(address); if (!k) throw new Error(`${label}: no keypair for required signer ${address}`); return k; });
  tx.sign(needed);
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  info(`${label}: sent ${explorer(signature)}`);
  const confirmation = await connection.confirmTransaction({ signature, blockhash: bundle.blockhash.blockhash, lastValidBlockHeight: bundle.lastValidBlockHeight }, 'confirmed');
  if (confirmation.value.err) throw new Error(`${label}: transaction failed ${JSON.stringify(confirmation.value.err)}`);
  // The adapter reads chain state at `finalized`, so wait for that before the next step.
  await connection.confirmTransaction({ signature, blockhash: bundle.blockhash.blockhash, lastValidBlockHeight: bundle.lastValidBlockHeight }, 'finalized');
  return signature;
}
const want = name => step === 'all' || step === name;
const ruleName = id => hookRuleById(id).name;
const refusalNames = message => plan.rules.map(r => ruleName(r.id)).filter(name => message.includes(name));

// ---- launch: the three approvals (plus blocklist chunks) chosen from chain state, like the site's launch flow ------------------
if (want('launch')) {
  try {
    for (let round = 0; round < 12; round++) {
      if (await adapter.rawState(launch)) break;
      const bundle = await adapter.prepareLaunch({ wallet: walletAddress, launch });
      info(`stage ${bundle.review.stage}${bundle.review.step ? ' ' + bundle.review.step : ''} (${bundle.review.stages} stages), max debit ${Number(bundle.review.maxWalletDebitLamports) / LAMPORTS_PER_SOL} SOL`);
      await send(bundle, `launch ${bundle.review.stage}${bundle.review.step ? ' ' + bundle.review.step : ''}`);
    }
    const r = await adapter.rawState(launch);
    if (!r) throw new Error('the pool did not appear after the launch transactions');
    const setup = await adapter.hookSetupState(launch);
    const mint = await adapter.readHookedMint(launch);
    pass('launch', `pool ${r.address.toBase58()} live; hook config + extra-account metas ${setup.ready ? 'ready' : 'INCOMPLETE'}${setup.blocklist ? ` (blocklist ${setup.blocklist.count}/${setup.blocklist.total})` : ''}; mint authority ${mint.mintAuthority === null ? 'revoked at creation' : 'STILL SET: ' + mint.mintAuthority}; transfer hook program ${mint.transferHookProgram}`);
    if (!setup.ready) fail('launch:setup', 'the hook setup is incomplete');
    if (mint.mintAuthority !== null) fail('launch:supply', 'the mint authority should be revoked at creation (Immutable option)');
    if (mint.transferHookProgram !== programId.toBase58()) fail('launch:hook', `the mint's transfer hook program is ${mint.transferHookProgram}, expected ${programId.toBase58()}`);
  } catch (error) { fail('launch', error.message); if (step === 'all') { summary(); process.exit(1); } }
}

const baseAta = getAssociatedTokenAddressSync(new PublicKey(launch.mint), wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
const balance = async () => { const a = await connection.getAccountInfo(baseAta, 'confirmed'); return a ? unpackAccount(baseAta, a, TOKEN_2022_PROGRAM_ID).amount : 0n; };
const lamports = sol => String(BigInt(Math.round(sol * LAMPORTS_PER_SOL)));

// ---- buy ----------------------------------------------------------------------------------------------------------------------
if (want('buy')) {
  try {
    const before = await balance();
    const bundle = await adapter.prepareTrade({ wallet: walletAddress, launch, side: 'buy', amountRaw: lamports(buySol) });
    info(`buy ${buySol} SOL → expected ${bundle.review.expectedOutputRaw} base units; transferHook review ${JSON.stringify(bundle.review.transferHook)}`);
    await send(bundle, 'buy');
    const after = await balance();
    if (after > before) pass('buy', `received ${after - before} base units through swap2WithTransferHook with Launchpad's account patching`);
    else fail('buy', 'the balance did not grow');
  } catch (error) { fail('buy', error.message); }
}

// ---- sell ----------------------------------------------------------------------------------------------------------------------
if (want('sell')) {
  try {
    const held = await balance();
    if (held === 0n) throw new Error('nothing to sell (run the buy step first)');
    const amount = held / 10n > 0n ? held / 10n : held;
    const vesting = plan.rules.some(r => r.id === 'holder_vesting');
    try {
      const bundle = await adapter.prepareTrade({ wallet: walletAddress, launch, side: 'sell', amountRaw: String(amount) });
      await send(bundle, 'sell');
      if (vesting) fail('sell', 'a sell on a Holder vesting coin inside the cliff should have been refused'); else pass('sell', `sold ${amount} base units`);
    } catch (error) {
      if (vesting && /Holder vesting/.test(error.message)) pass('sell', `refused as expected inside the vesting cliff: ${error.message}`); else throw error;
    }
  } catch (error) { fail('sell', error.message); }
}

// ---- refuse: a trade that breaks a rule must be refused in simulation, naming the rule ---------------------------------------
if (want('refuse')) {
  try {
    const ids = new Set(plan.rules.map(r => r.id)), supply = 1_000_000_000_000_000n, bps = pct => BigInt(Math.round(pct * 100));
    const setting = (id, key) => plan.rules.find(r => r.id === id)?.settings?.[key];
    let attempt = null;
    const held = await balance();
    // A sell above the per-sell cap, when the bag is big enough to break it.
    const sellCap = ids.has('anti_dump') ? supply * bps(setting('anti_dump', 'maxSellPct')) / 10000n : ids.has('trade_guard') ? supply * bps(setting('trade_guard', 'maxTradePct')) / 10000n : ids.has('graduated_sell_caps') ? supply * bps(setting('graduated_sell_caps', 'smallCapPct')) / 10000n : null;
    if (sellCap !== null && held > sellCap) attempt = { side: 'sell', amountRaw: String(held), why: 'selling the whole bag at once' };
    // Otherwise a buy far above every cap (per-buy, per-wallet or per-trade).
    if (!attempt && ['max_per_wallet', 'chapters', 'rising_max_per_wallet', 'anti_dump', 'trade_guard', 'sliding_caps', 'breathing_cap', 'momentum', 'resonance', 'coupled_resonator'].some(id => ids.has(id))) attempt = { side: 'buy', amountRaw: lamports(Math.max(buySol * 100, 0.1)), why: 'a buy far above the caps' };
    if (!attempt) { info('refuse: no cap rule to provoke with this rule set; skipped'); }
    else {
      let message = null;
      try { const bundle = await adapter.prepareTrade({ wallet: walletAddress, launch, side: attempt.side, amountRaw: attempt.amountRaw }); message = 'ACCEPTED (not sent): ' + JSON.stringify(bundle.review); } catch (error) { message = error.message; }
      const named = refusalNames(message);
      if (named.length) pass('refuse', `${attempt.why} was refused naming ${named.join(', ')}: ${message}`);
      else fail('refuse', `${attempt.why}: ${message}`);
    }
  } catch (error) { fail('refuse', error.message); }
}

// ---- send: a wallet-to-wallet transfer, resolved by spl-token itself (real keys), not by Launchpad --------------------------------
if (want('send')) {
  try {
    const held = await balance();
    if (held === 0n) throw new Error('nothing to send (run the buy step first)');
    const friend = keys.friend.publicKey, friendAta = getAssociatedTokenAddressSync(new PublicKey(launch.mint), friend, false, TOKEN_2022_PROGRAM_ID);
    const amount = 1000n < held ? 1000n : held;
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, friendAta, friend, new PublicKey(launch.mint), TOKEN_2022_PROGRAM_ID),
      await createTransferCheckedWithTransferHookInstruction(connection, baseAta, new PublicKey(launch.mint), friendAta, wallet.publicKey, amount, 6, [], 'confirmed', TOKEN_2022_PROGRAM_ID)];
    const latest = await connection.getLatestBlockhash('confirmed');
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: latest.blockhash, instructions: ixs }).compileToV0Message());
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, commitment: 'confirmed' });
    const blocks = ['venue_locked', 'dex_only', 'p2p_only', 'allowlist', 'blocklist', 'trade_guard', 'anti_dump', 'market_hours', 'trading_hours'].some(id => plan.rules.some(r => r.id === id));
    if (sim.value.err) {
      const text = await adapter.simulationFailureMessage(launch, sim.value);
      if (blocks && refusalNames(text).length) pass('send', `wallet-to-wallet send refused as the rules say: ${text}`);
      else if (blocks) fail('send', `refused, but without a rule name: ${text}`);
      else fail('send', `a plain send should pass with these rules: ${text}`);
    } else {
      tx.sign([wallet]);
      const signature = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
      if (blocks) fail('send', `a wallet-to-wallet send should have been refused with these rules (${explorer(signature)})`); else pass('send', `wallet-to-wallet send of ${amount} base units went through spl-token's own resolution ${explorer(signature)}`);
    }
  } catch (error) { fail('send', error.message); }
}

// ---- claim: creator fees through claimCreatorTradingFee2 with the hook block ------------------------------------------------------
if (want('claim')) {
  try {
    const bundle = await adapter.prepareCreatorClaim({ wallet: walletAddress, launch, receiver: walletAddress });
    await send(bundle, 'claim');
    pass('claim', `creator fees claimed into ${bundle.receiverQuoteAta} (quoteDelivery ${bundle.review.quoteDelivery})`);
  } catch (error) { if (/No creator or protocol fees are ready/.test(error.message)) info('claim: no fees accrued yet (buy and sell first)'); else fail('claim', error.message); }
}

function summary() {
  console.log('\nSummary');
  for (const [name, status, text] of results) console.log(`  ${status.padEnd(4)} ${name.padEnd(14)} ${text.split('\n')[0].slice(0, 160)}`);
  const failed = results.filter(r => r[1] === 'FAIL').length;
  console.log(failed ? `\n${failed} step(s) failed. Send this output (no secrets are in it).` : '\nAll steps passed.');
}
summary();
process.exit(results.some(r => r[1] === 'FAIL') ? 1 : 0);
