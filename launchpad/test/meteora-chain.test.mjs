import test from 'node:test';
import assert from 'node:assert/strict';
import { Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import { getPriceFromSqrtPrice, getMigrationThresholdPrice, TokenType, TokenAuthorityOption } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { MeteoraChainAdapter } from '../src/meteora-chain.mjs';
import { meteoraCurveConfig, meteoraPolicy, meteoraHookTokenOptions } from '../src/meteora-policy.mjs';
const key = () => Keypair.generate().publicKey;
test('Meteora uses the declared operator RPC allowance while retaining shared aggregate and send caps',async t=>{
 const names=['LAUNCHPAD_PUBLIC_RPC_URL','LAUNCHPAD_PUBLIC_RPC_RPS','LAUNCHPAD_PUBLIC_SEND_RPS'],previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 t.after(()=>{for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}});
 process.env.LAUNCHPAD_PUBLIC_RPC_URL='https://api.mainnet-beta.solana.com';process.env.LAUNCHPAD_PUBLIC_RPC_RPS='40';process.env.LAUNCHPAD_PUBLIC_SEND_RPS='4';
 const seen=[],gate={acquire:async(_key,_client,rate,options)=>{seen.push({rate,options});throw Error('test admission stops before network');},removeClient(){}};
 const adapter=new MeteoraChainAdapter({rpcGate:gate});t.after(()=>adapter.close());
 await assert.rejects(adapter.connection.getSlot(),/test admission/);assert.equal(seen[0].rate,40);assert.equal(seen[0].options.aggregateRate,40);assert.equal(seen[0].options.sendRate,4);
 const different=new MeteoraChainAdapter({rpcUrl:'https://example.com/solana',rpcGate:gate});t.after(()=>different.close());
 await assert.rejects(different.connection.getSlot(),/test admission/);assert.equal(seen[1].rate,8);assert.equal(seen[1].options.aggregateRate,undefined);assert.equal(seen[1].options.sendRate,1);
});
function fixture(){
 const connection=new Connection('https://api.mainnet-beta.solana.com');connection.getAccountInfo=async k=>k.equals(NATIVE_MINT)?{owner:TOKEN_PROGRAM_ID}:null;
 connection.getMinimumBalanceForRentExemption=async size=>890880+6960*size;connection.getBalance=async()=>10_000_000_000;
 const adapter=new MeteoraChainAdapter({connection}),wallet=key().toBase58();
 const launch={mint:key().toBase58(),configAddress:key().toBase58(),creatorAuthority:key().toBase58(),partnerAuthority:key().toBase58(),treasury:key().toBase58(),quoteMint:NATIVE_MINT.toBase58(),quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals:9,quoteSymbol:'SOL',priceSnapshot:{usd:150},name:'Meteora Test',symbol:'MTEST',metadataUri:'https://launchpad.example/api/launchpad/metadata/12345678901234567890123456789012345678901234',migrationPositionMints:[key().toBase58(),key().toBase58()]};
 launch.creationFee={lamports:'15000000',recipient:launch.treasury};
 const config={...adapter.expectedConfig(launch),quoteMint:NATIVE_MINT,quoteTokenFlag:0};
 adapter.config=async()=>config;adapter.rawState=async()=>null;adapter.verifyQuote=async()=>({tlvData:Buffer.alloc(0)});adapter.dbc.creator.getPoolConfigForNewPool=async()=>config;
 adapter.prepareTransaction=async args=>{const tx=new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey(args.wallet),recentBlockhash:key().toBase58(),instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:800000}),...args.instructions.filter(ix=>!ix.programId.equals(ComputeBudgetProgram.programId))]}).compileToV0Message());return {...args,tx,bytes:tx.serialize(),review:{...args.review,maxWalletDebitLamports:'10000000'}};};
 return {adapter,connection,launch,wallet,config};
}
test('Meteora curve preserves FDV endpoints, quote-only fees, fixed supply and permanent ownership shares',()=>{
 for(const [usd,decimals] of [[150,9],[1,6],[235,8],[.0001,6]]){
  const c=meteoraCurveConfig({quoteUsd:usd,quoteDecimals:decimals});
  const initial=Number(getPriceFromSqrtPrice(c.sqrtStartPrice,6,decimals))*1e9*usd;
  const end=Number(getPriceFromSqrtPrice(getMigrationThresholdPrice(c.migrationQuoteThreshold,c.sqrtStartPrice,c.curve),6,decimals))*1e9*usd;
  assert.ok(Math.abs(initial-20000)<.05);assert.ok(Math.abs(end-50000)<.1);
  assert.equal(c.poolFees.baseFee.cliffFeeNumerator.toString(),'18800000');assert.equal(c.poolFees.dynamicFee,null);
  assert.equal(c.collectFeeMode,0);assert.equal(c.migratedPoolFee.collectFeeMode,0);assert.equal(c.migratedPoolFee.poolFeeBps,188);
  assert.equal(c.creatorTradingFeePercentage,33);assert.equal(c.creatorPermanentLockedLiquidityPercentage,33);assert.equal(c.partnerPermanentLockedLiquidityPercentage,67);
  assert.equal(c.creatorLiquidityPercentage+c.partnerLiquidityPercentage,0);assert.equal(c.migrationFee.feePercentage,0);
  assert.equal(c.tokenSupply.preMigrationTokenSupply.toString(),'1000000000000000');assert.equal(c.tokenUpdateAuthority,1);
 }
 assert.throws(()=>meteoraPolicy({migrationFeePercentage:1}),/no graduation fee/);
 assert.throws(()=>meteoraCurveConfig({quoteUsd:0,quoteDecimals:9}),/verified quote/);
 assert.throws(()=>meteoraCurveConfig({quoteUsd:.0000025,quoteDecimals:6}),/Not enough liquidity/);
});
test('a hooked curve config (v71.28) is the same curve on a Token-2022 mint with the SDK’s Immutable token authority option, taken by name',()=>{
 // Meteora requires a revoked mint authority only for non-hook configs and allows Immutable for hook configs (its program source), so a
 // hooked coin is created exactly like a plain one: no mint authority from the first slot. The SDK exports TokenAuthorityOption (there is
 // no TokenUpdateAuthorityOption); both members are read by name so a renumbered enum can never change a launch.
 const options=meteoraHookTokenOptions();assert.equal(options.tokenType,TokenType.Token2022);assert.equal(options.tokenAuthorityOption,TokenAuthorityOption.Immutable);
 assert.notEqual(TokenType.Token2022,undefined);assert.notEqual(TokenAuthorityOption.Immutable,undefined);assert.equal(options.tokenUpdateAuthority,undefined,'the input option is tokenAuthorityOption; tokenUpdateAuthority is the on-chain field name');
 const plain=meteoraCurveConfig({quoteUsd:150,quoteDecimals:9}),hooked=meteoraCurveConfig({quoteUsd:150,quoteDecimals:9,hooked:true});
 assert.equal(plain.tokenType,0);assert.equal(plain.tokenUpdateAuthority,1,'ordinary launches stay SPL and immutable');
 assert.equal(hooked.tokenType,TokenType.Token2022);assert.equal(hooked.tokenUpdateAuthority,TokenAuthorityOption.Immutable);assert.equal(hooked.tokenUpdateAuthority,plain.tokenUpdateAuthority,'the same Immutable option as a plain launch');
 for(const k of ['sqrtStartPrice','migrationQuoteThreshold','collectFeeMode','migrationOption','creatorTradingFeePercentage','partnerPermanentLockedLiquidityPercentage','creatorPermanentLockedLiquidityPercentage'])assert.equal(String(hooked[k]),String(plain[k]),`${k} is unchanged by the hook`);
 assert.equal(hooked.poolFees.baseFee.cliffFeeNumerator.toString(),'18800000');assert.deepEqual(hooked.curve.map(p=>[String(p.sqrtPrice),String(p.liquidity)]),plain.curve.map(p=>[String(p.sqrtPrice),String(p.liquidity)]));
});
test('real SDK initializer fits one transaction with first buy and only wallet/mint/creator signers',async()=>{
 const {adapter,launch,wallet}=fixture();const result=await adapter.prepareLaunch({wallet,launch,firstBuyRaw:'1000000',slippageBps:100});
 assert.ok(result.bytes.length<=1232);assert.equal(result.executionVenue,undefined); // executionVenue is carried in extra until prepareTransaction serializes it.
 assert.deepEqual(new Set(result.tx.message.staticAccountKeys.slice(0,result.tx.message.header.numRequiredSignatures).map(x=>x.toBase58())),new Set([wallet,launch.mint,launch.creatorAuthority]));
 assert.equal(result.extra.executionVenue,'dbc');assert.ok(BigInt(result.extra.expectedTrade.minOutputRaw)>0n);
});
test('real SDK migration binds durable position keys and fits the packet limit',async()=>{
 const {adapter,launch,config}=fixture();const pool={baseMint:new PublicKey(launch.mint),config:new PublicKey(launch.configAddress),baseVault:key(),quoteVault:key(),quoteReserve:config.migrationQuoteThreshold,isMigrated:0};
 adapter.rawState=async()=>({pool,virtual:{poolState:pool},config,address:adapter.poolAddress(launch)});
 adapter.dbc.migration.getPoolWithConfig=async()=>({virtualPool:{poolState:pool},poolConfigState:config});
 const result=await adapter.prepareMigration({wallet:launch.partnerAuthority,launch});assert.ok(result.bytes.length<=1232);
 assert.deepEqual(new Set(result.tx.message.staticAccountKeys.slice(0,result.tx.message.header.numRequiredSignatures).map(x=>x.toBase58())),new Set([launch.partnerAuthority,...launch.migrationPositionMints]));
});
test('first buys cannot quietly exceed the ten-percent allocation cap',async()=>{
 const {adapter,launch,wallet}=fixture();await assert.rejects(adapter.prepareLaunch({wallet,launch,firstBuyRaw:'100000000000',slippageBps:100}),/10%|Insufficient Liquidity/);
});
test('transaction simulation failure cannot produce a signable bundle',async()=>{
 const {adapter,connection,launch,wallet}=fixture();delete adapter.prepareTransaction;
 connection.getEpochInfo=async()=>({absoluteSlot:99});connection.getLatestBlockhash=async()=>({blockhash:key().toBase58(),lastValidBlockHeight:100});connection.getFeeForMessage=async()=>({value:5000});
 connection.simulateTransaction=async()=>({value:{err:{InstructionError:[0,{Custom:1}]}}});
 await assert.rejects(adapter.prepareTransaction({wallet,launch,action:'buy',instructions:[SystemProgram.transfer({fromPubkey:new PublicKey(wallet),toPubkey:key(),lamports:1})]}),/simulation failed/);
});
test('missing expired payout receipt never authorizes a replacement payout',async()=>{
 const {adapter,connection,launch}=fixture();connection.getSignatureStatuses=async()=>({value:[null]});connection.getBlockHeight=async()=>101;connection.isBlockhashValid=async()=>({value:false});connection.getTransaction=async()=>null;
 const result=await adapter.reconcile({signature:'saved-signature',bundle:{action:'payout',blockhash:{blockhash:key().toBase58(),lastValidBlockHeight:100}}},launch);
 assert.equal(result.state,'pending');assert.match(result.notice,/No replacement payment/);
});
test('protocol claims cannot change the registered treasury',async()=>{
 const {adapter,launch,wallet}=fixture();await assert.rejects(adapter.preparePartnerClaim({wallet,launch,receiver:key().toBase58()}),/registered destination/);
});
function receiptFixture(f,{action='buy',bundle={},receipt}){
 const signature='saved',wire='exact-saved-wire';f.connection.getSignatureStatuses=async()=>({value:[{confirmationStatus:'finalized',err:null}]});
 f.connection._rpcRequest=async()=>({result:{meta:{err:null},transaction:[wire,'base64']}});f.connection.getParsedTransaction=async()=>receipt;
 f.adapter.state=async()=>({phase:'migrated',poolId:key().toBase58(),slot:receipt.slot});
 return {signature,signedTransaction:wire,wallet:f.wallet,bundle:{action,...bundle}};
}
test('a DBC last buy is proved against its saved execution venue after a keeper has migrated',async()=>{
 const f=fixture(),quoteVault=key(),slot=200;
 f.adapter.rawState=async()=>({pool:{isMigrated:1,quoteVault},slot});
 f.adapter.readDammPool=async()=>{throw Error('This historical DBC trade must not read the later DAMM vault.');};
 const receipt={slot,blockTime:10,transaction:{message:{accountKeys:[]}},meta:{err:null,preTokenBalances:[],postTokenBalances:[{mint:f.launch.mint,owner:f.wallet,uiTokenAmount:{amount:'5'}}],innerInstructions:[{instructions:[{programId:TOKEN_PROGRAM_ID,parsed:{type:'transfer',info:{source:key().toBase58(),destination:quoteVault.toBase58(),amount:'10'}}}]}]}};
 const op=receiptFixture(f,{bundle:{executionVenue:'dbc',side:'buy',amountRaw:'10',expectedTrade:{inputRaw:'10',minOutputRaw:'4'}},receipt});
 const result=await f.adapter.reconcile(op,f.launch);assert.equal(result.trade.quoteRaw,'10');assert.equal(result.trade.amountRaw,'5');
});
test('a fee receipt must prove both the registered vault source and exact receiver credit',async()=>{
 const f=fixture(),quoteVault=key(),recipient=f.launch.creatorAuthority,ata=key().toBase58();f.adapter.rawState=async()=>({pool:{isMigrated:0,quoteVault},slot:200});
 const receipt={slot:200,transaction:{message:{accountKeys:[]}},meta:{err:null,preTokenBalances:[],postTokenBalances:[{mint:f.launch.quoteMint,owner:recipient,uiTokenAmount:{amount:'25'}}],innerInstructions:[{instructions:[{programId:TOKEN_PROGRAM_ID,parsed:{type:'transfer',info:{source:key().toBase58(),destination:ata,amount:'25'}}}]}]}};
 const op=receiptFixture(f,{action:'creator-claim',bundle:{feeRole:'creator',receiver:recipient,receiverQuoteAta:ata},receipt});
 await assert.rejects(f.adapter.reconcile(op,f.launch),/fee credit does not match/);
});
test('registered permanent position references avoid arbitrary wallet NFT enumeration',async()=>{
 const f=fixture(),nftMint=key(),position=key();f.launch.position={creator:[{position:position.toBase58(),nftMint:nftMint.toBase58()}]};
 f.adapter.cp.getUserPositionByPool=async()=>{throw Error('Unsolicited wallet NFTs should not be scanned.');};
 f.adapter.readPosition=async()=>({pool:f.adapter.dammAddress(f.launch),nftMint,unlockedLiquidity:0,vestedLiquidity:0,permanentLockedLiquidity:1});
 const data=Buffer.alloc(165);nftMint.toBuffer().copy(data);new PublicKey(f.launch.creatorAuthority).toBuffer().copy(data,32);data.writeBigUInt64LE(1n,64);
 f.connection.getAccountInfo=async()=>({owner:(await import('@solana/spl-token')).TOKEN_2022_PROGRAM_ID,data});
 assert.equal((await f.adapter.positions(f.launch,f.launch.creatorAuthority)).length,1);
});

test('public readiness checks mainnet identity even if all program and gas checks pass',async()=>{
 const {adapter,connection,launch}=fixture();
 connection.getAccountInfo=async()=>({executable:true});
 connection.getBalance=async()=>120000000;
 adapter.migrationCheck=async()=>({supported:true});
 connection.getGenesisHash=async()=>'another-cluster';
 const blocked=await adapter.readiness({authority:launch.partnerAuthority,treasury:launch.treasury});
 assert.equal(blocked.ready,false);assert.ok(blocked.blockers.some(x=>/mainnet/.test(x)));
 connection.getGenesisHash=async()=>'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
 const ready=await adapter.readiness({authority:launch.partnerAuthority,treasury:launch.treasury});
 assert.equal(ready.ready,true);assert.equal(ready.balanceLamports,'120000000');
});

// ---- Reward baskets (v71.33): conversion receipts, per-asset payouts and the route check -------------------------------------
test('a basket conversion receipt must show the exact pair-asset debit and at least the minimum basket-asset credit on the creator authority', async () => {
  const f = fixture(), quoteVault = key(), asset = key().toBase58(), creator = f.launch.creatorAuthority;
  f.adapter.rawState = async () => ({ pool: { isMigrated: 0, quoteVault }, slot: 200 });
  const receiptOf = (spent, received) => ({ slot: 200, transaction: { message: { accountKeys: [] } }, meta: { err: null, preTokenBalances: [{ mint: f.launch.quoteMint, owner: creator, uiTokenAmount: { amount: '1000' } }, { mint: asset, owner: creator, uiTokenAmount: { amount: '5' } }], postTokenBalances: [{ mint: f.launch.quoteMint, owner: creator, uiTokenAmount: { amount: String(1000 - spent) } }, { mint: asset, owner: creator, uiTokenAmount: { amount: String(5 + received) } }], innerInstructions: [] } });
  const conversion = { inputMint: f.launch.quoteMint, outputMint: asset, inputRaw: '300', minimumRaw: '90', expectedRaw: '100' };
  const good = receiptFixture(f, { action: 'basket-convert', bundle: { conversion }, receipt: receiptOf(300, 95) });
  const result = await f.adapter.reconcile(good, f.launch);
  assert.deepEqual(result.conversion, { inputMint: f.launch.quoteMint, outputMint: asset, inputRaw: '300', outputRaw: '95' });
  await assert.rejects(f.adapter.reconcile(receiptFixture(f, { action: 'basket-convert', bundle: { conversion }, receipt: receiptOf(299, 95) }), f.launch), /spent a different amount/);
  await assert.rejects(f.adapter.reconcile(receiptFixture(f, { action: 'basket-convert', bundle: { conversion }, receipt: receiptOf(300, 89) }), f.launch), /less than its minimum output/);
});
test('a basket-asset payout receipt is checked against the basket asset, not the pair asset, and the plan names the asset', async () => {
  const f = fixture(), quoteVault = key(), asset = key().toBase58(), holder = key().toBase58(), sourceAta = key().toBase58();
  f.adapter.rawState = async () => ({ pool: { isMigrated: 0, quoteVault }, slot: 200 });
  const receipt = { slot: 200, transaction: { message: { accountKeys: [] } }, meta: { err: null, preTokenBalances: [{ mint: asset, owner: holder, uiTokenAmount: { amount: '0' } }], postTokenBalances: [{ mint: asset, owner: holder, uiTokenAmount: { amount: '40' } }], innerInstructions: [{ instructions: [{ programId: TOKEN_PROGRAM_ID, parsed: { type: 'transferChecked', info: { source: sourceAta, destination: key().toBase58(), tokenAmount: { amount: '40' } } } }] }] } };
  const payout = { quoteDebitRaw: '40', recipients: [{ owner: holder, amount: '40' }], source: f.launch.creatorAuthority, sourceQuoteAta: sourceAta, mint: asset, decimals: 6 };
  const result = await f.adapter.reconcile(receiptFixture(f, { action: 'payout', bundle: { payout }, receipt }), f.launch);
  assert.deepEqual(result.payout, { quoteDebitRaw: '40', recipients: [{ owner: holder, amount: '40' }], mint: asset });
  // The same receipt read as a pair-asset payout finds no holder credit in the pair asset and is refused.
  await assert.rejects(f.adapter.reconcile(receiptFixture(f, { action: 'payout', bundle: { payout: { ...payout, mint: undefined } }, receipt }), f.launch), /does not match its durable plan/);
  // preparePayout with an asset: only a saved basket asset, holders mode; the builder receives the asset's mint, decimals and program.
  let seen = null; f.adapter.prepareTransaction = async args => { seen = args; return { action: args.action, review: { ...args.review } }; };
  const helpers = await import('../src/meteora-rewards.mjs');
  const original = helpers.prepareHolderPayoutInstructions; let builderLaunch = null;
  f.adapter.preparePayoutBuilder = null;
  const launch = { ...f.launch, feeMode: 'holders', basket: { version: 1, assets: [{ mint: f.launch.quoteMint, symbol: 'SOL', decimals: 9 }, { mint: asset, symbol: 'XYZx', decimals: 6, program: TOKEN_PROGRAM_ID.toBase58() }] } };
  await assert.rejects(f.adapter.preparePayout({ wallet: f.wallet, launch, source: launch.creatorAuthority, payouts: [{ owner: holder, amount: '1' }], asset: { mint: key().toBase58(), decimals: 6 } }), /Only a saved reward-basket asset/);
  await assert.rejects(f.adapter.preparePayout({ wallet: f.wallet, launch: { ...launch, feeMode: 'creator' }, source: launch.creatorAuthority, payouts: [{ owner: holder, amount: '1' }], asset: { mint: asset, decimals: 6 } }), /Only a saved reward-basket asset/);
  assert.equal(typeof original, 'function');
});
test('the basket route check accepts a routable quote within the 2% impact guard and names every other outcome', async () => {
  const f = fixture(), asset = key().toBase58();
  const responses = []; f.adapter.transport = { fetcher: async url => { responses.push(url); const r = responses.shift ? null : null; return queue.shift(); }, jupiterGate: { acquire: async () => {}, cooldown() {} }, jupiterKey: 'k' };
  const queue = [];
  const quote = (over = {}) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ inputMint: NATIVE_MINT.toBase58(), outputMint: asset, inAmount: '1000', outAmount: '7', swapMode: 'ExactIn', priceImpactPct: '0.004', routePlan: [{}], ...over }) });
  queue.push(quote());
  assert.deepEqual(await f.adapter.basketRouteCheck({ inputMint: NATIVE_MINT.toBase58(), outputMint: asset, amountRaw: '1000' }), { outAmount: '7', priceImpactPct: '0.004' });
  assert.match(responses[0], /^https:\/\/api\.jup\.ag\/swap\/v1\/quote\?/); assert.match(responses[0], /slippageBps=100/); assert.match(responses[0], /amount=1000/);
  queue.push(quote({ priceImpactPct: '0.03' })); await assert.rejects(f.adapter.basketRouteCheck({ inputMint: NATIVE_MINT.toBase58(), outputMint: asset, amountRaw: '1000' }), /more than 2%/);
  queue.push({ ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) }); await assert.rejects(f.adapter.basketRouteCheck({ inputMint: NATIVE_MINT.toBase58(), outputMint: asset, amountRaw: '1000' }), /No swap route is available/);
  queue.push(quote({ outputMint: key().toBase58() })); await assert.rejects(f.adapter.basketRouteCheck({ inputMint: NATIVE_MINT.toBase58(), outputMint: asset, amountRaw: '1000' }), /unexpected quote/);
  f.adapter.transport = null; assert.equal(f.adapter.basketsAvailable(), false);
  await assert.rejects(f.adapter.basketRouteCheck({ inputMint: NATIVE_MINT.toBase58(), outputMint: asset, amountRaw: '1000' }), /not available on this host/);
});

// ---- Simulation failures in words (v71.34) -----------------------------------------------------------------------------------
import { describeSimulationFailure, simulationLogs, simulationFailure } from '../src/meteora-chain.mjs';
const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
function messageFor(wallet, programs) {
  // A v0 message whose instruction i is owned by programs[i]; the payer is the first key.
  return new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(wallet), recentBlockhash: key().toBase58(), instructions: programs.map(programId => ({ programId: new PublicKey(programId), keys: [], data: Buffer.alloc(0) })) }).compileToV0Message());
}
test('a simulation failure names the SOL or token shortfall of the payer from the runtime logs, with the amount and the step', () => {
  const wallet = key().toBase58(), tx = messageFor(wallet, [ComputeBudgetProgram.programId.toBase58(), 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', ATA_PROGRAM_ID, ATA_PROGRAM_ID, SystemProgram.programId.toBase58()]);
  const err = { InstructionError: [4, { Custom: 1 }] };
  assert.deepEqual(simulationFailure(tx, err), { index: 4, code: 1, kind: null, program: SystemProgram.programId.toBase58() });
  const logs = ['Program 11111111111111111111111111111111 invoke [1]', 'Transfer: insufficient lamports 12345678, need 512345678', 'Program 11111111111111111111111111111111 failed: custom program error: 0x1'];
  assert.equal(simulationLogs(logs).shortfallLamports, '500000000');
  const short = describeSimulationFailure({ tx, value: { err, logs }, action: 'initialize', firstBuy: true, quoteSymbol: 'SOL' });
  assert.equal(short.code, 'METEORA_GAS'); assert.equal(short.shortfallLamports, '500000000');
  assert.equal(short.message, 'Your wallet needs about 0.5 more SOL to create the coin and make the first buy (account rent, the first buy and network fees). Nothing was signed or spent.');
  // The worker's steps are paid by Launchpad's gas wallet: the sentence says so and tells the administrator what to do.
  const managed = describeSimulationFailure({ tx, value: { err, logs }, action: 'payout', managed: true });
  assert.match(managed.message, /^Launchpad’s Meteora gas wallet needs about 0\.5 more SOL to send these rewards \(recipient token-account rent and network fees\)\. Nothing was signed or spent\. Top it up from the Meteora admin page; this step retries on its own\.$/);
  // A first buy on a pair other than SOL is paid in that asset from the wallet: the Token program's own log line says it ran short.
  const tokenTx = messageFor(wallet, [ComputeBudgetProgram.programId.toBase58(), 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', ATA_PROGRAM_ID, ATA_PROGRAM_ID, 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN']);
  const tokenLogs = ['Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN invoke [1]', 'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]', 'Program log: Error: insufficient funds', 'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1', 'Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN failed: custom program error: 0x1'];
  const tokens = describeSimulationFailure({ tx: tokenTx, value: { err, logs: tokenLogs }, action: 'initialize', firstBuy: true, quoteSymbol: 'IREN', quoteMint: 'iRENmint111111111111111111111111111111111111' });
  assert.equal(tokens.code, 'METEORA_FUNDS');
  assert.equal(tokens.message, 'Your wallet does not hold enough IREN for the first buy. A Meteora first buy is paid in the pair asset from your wallet, so buy IREN (contract address iRENmint111111111111111111111111111111111111) into your wallet or launch without a first buy. Nothing was signed or spent.');
  assert.equal(describeSimulationFailure({ tx: tokenTx, value: { err, logs: tokenLogs }, action: 'sell', coinSymbol: 'ROCK', coinMint: 'RockMint', quoteSymbol: 'SOL' }).message, 'Your wallet does not hold enough ROCK for this trade. Nothing was signed or spent.');
  assert.equal(describeSimulationFailure({ tx: tokenTx, value: { err, logs: tokenLogs }, action: 'buy', quoteSymbol: 'USDC', quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }).message, 'Your wallet does not hold enough USDC for this trade. Buy USDC (contract address EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v) into your wallet and try again. Nothing was signed or spent.');
  // Without logs a custom error 1 of the System or Associated Token program still means SOL, of the Token programs tokens.
  assert.match(describeSimulationFailure({ tx, value: { err }, action: 'buy', quoteSymbol: 'SOL' }).message, /^Your wallet needs more SOL to complete this trade/);
  const ataTx = messageFor(wallet, [ComputeBudgetProgram.programId.toBase58(), ATA_PROGRAM_ID]);
  assert.equal(describeSimulationFailure({ tx: ataTx, value: { err: { InstructionError: [1, { Custom: 1 }] } }, action: 'creator-claim' }).code, 'METEORA_GAS');
  const splTx = messageFor(wallet, [ComputeBudgetProgram.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58()]);
  assert.equal(describeSimulationFailure({ tx: splTx, value: { err: { InstructionError: [1, { Custom: 1 }] } }, action: 'buy', quoteSymbol: 'USDC' }).message, 'Your wallet does not hold enough USDC for this trade. Buy USDC into your wallet and try again. Nothing was signed or spent.');
  // Meteora's own refusals are quoted; anything else names the instruction and its program, and keeps the raw error for support.
  const anchorLogs = ['Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN invoke [1]', 'Program log: AnchorError occurred. Error Code: ExceededSlippage. Error Number: 6004. Error Message: Exceeded slippage tolerance.', 'Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN failed: custom program error: 0x1774'];
  assert.equal(describeSimulationFailure({ tx: tokenTx, value: { err: { InstructionError: [4, { Custom: 6004 }] }, logs: anchorLogs }, action: 'buy' }).message, 'Meteora refused this transaction: Exceeded slippage tolerance. No transaction was submitted.');
  const other = describeSimulationFailure({ tx: tokenTx, value: { err: { InstructionError: [1, { Custom: 3 }] }, logs: ['Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN failed: custom program error: 0x3'] }, action: 'initialize' });
  assert.equal(other.code, 'METEORA_SIMULATION');
  assert.equal(other.message, 'Meteora simulation failed: {"InstructionError":[1,{"Custom":3}]} (instruction 1, Meteora’s bonding-curve program — custom program error: 0x3). No transaction was submitted.');
  assert.equal(describeSimulationFailure({ value: { err: 'BlockhashNotFound' } }).message, 'Meteora simulation failed: "BlockhashNotFound". No transaction was submitted.');
  assert.equal(describeSimulationFailure({ value: { err: { InstructionError: [2, { Custom: 7 }] } } }).message, 'Meteora simulation failed: {"InstructionError":[2,{"Custom":7}]}. No transaction was submitted.', 'without the transaction the raw error stands alone');
  assert.equal(describeSimulationFailure({ tx, value: { err: { InstructionError: [2, 'InvalidAccountData'] } } }).message, 'Meteora simulation failed: {"InstructionError":[2,"InvalidAccountData"]} (instruction 2, the Associated Token program). No transaction was submitted.');
});
test('a prepared Meteora step whose simulation runs short of SOL is refused with the amount, the step and a gas code the worker keeps', async () => {
  const { adapter, connection, launch, wallet } = fixture(); delete adapter.prepareTransaction;
  connection.getEpochInfo = async () => ({ absoluteSlot: 99 }); connection.getLatestBlockhash = async () => ({ blockhash: key().toBase58(), lastValidBlockHeight: 100 }); connection.getFeeForMessage = async () => ({ value: 5000 });
  connection.simulateTransaction = async () => ({ value: { err: { InstructionError: [1, { Custom: 1 }] }, logs: ['Program 11111111111111111111111111111111 invoke [1]', 'Transfer: insufficient lamports 1000, need 2039280', 'Program 11111111111111111111111111111111 failed: custom program error: 0x1'] } });
  const instructions = [SystemProgram.transfer({ fromPubkey: new PublicKey(wallet), toPubkey: key(), lamports: 1 })];
  await assert.rejects(adapter.prepareTransaction({ wallet, launch, action: 'initialize', instructions, review: { stage: 'initialize', firstBuyRaw: '0' } }), error => { assert.equal(error.message, 'Your wallet needs about 0.00203828 more SOL to create the coin (account rent and network fees). Nothing was signed or spent.'); assert.equal(error.code, 'METEORA_GAS'); assert.equal(error.shortfallLamports, '2038280'); assert.equal(error.statusCode, 409); return true; });
  await assert.rejects(adapter.prepareTransaction({ wallet, launch, action: 'initialize', instructions, review: { stage: 'initialize', firstBuyRaw: '1000' } }), /needs about 0\.00203828 more SOL to create the coin and make the first buy \(account rent, the first buy and network fees\)/);
  // The same shortfall on a worker step (payer = Launchpad's authority) addresses the administrator.
  await assert.rejects(adapter.prepareTransaction({ wallet: launch.partnerAuthority, launch, action: 'payout', instructions: [SystemProgram.transfer({ fromPubkey: new PublicKey(launch.partnerAuthority), toPubkey: key(), lamports: 1 })] }), error => { assert.match(error.message, /^Launchpad’s Meteora gas wallet needs about 0\.00203828 more SOL to send these rewards \(recipient token-account rent and network fees\)\. Nothing was signed or spent\. Top it up from the Meteora admin page; this step retries on its own\.$/); assert.equal(error.code, 'METEORA_GAS'); return true; });
  // A balance below the simulated debit is refused with both numbers.
  connection.simulateTransaction = async () => ({ context: { slot: 100 }, value: { err: null, accounts: [{ lamports: 0 }] } });
  connection.getBalance = async () => 900_000; connection.getFeeForMessage = async () => ({ value: 1_000_000 });
  await assert.rejects(adapter.prepareTransaction({ wallet, launch, action: 'buy', instructions }), error => { assert.equal(error.message, 'Your wallet has 0.0009 SOL; this step takes up to 0.001 SOL. Add 0.0001 SOL and try again.'); assert.equal(error.code, 'METEORA_GAS'); assert.equal(error.shortfallLamports, '100000'); return true; });
});
test('a first buy on a pair other than SOL must already be in the creator’s wallet, and the create stage must be affordable, before anything is built', async () => {
  const { adapter, connection, launch, wallet } = fixture();
  const usdc = key().toBase58(); Object.assign(launch, { quoteMint: usdc, quoteSymbol: 'USDC', quoteDecimals: 6, firstBuyRaw: '2500000' });
  adapter.createStageRent = async () => 25_000_000n;
  // Nothing of the pair asset in the wallet (no token account): refused in words before the configuration is paid for.
  await assert.rejects(adapter.requireLaunchFunds({ wallet, launch, quoteMintState: null, first: 2500000n, stage: 'configure' }), error => { assert.equal(error.message, `Your wallet holds 0 USDC; the first buy needs 2.5 USDC. A Meteora first buy is paid in the pair asset from your wallet, so buy 2.5 more USDC (contract address ${usdc}) into your wallet or launch without a first buy.`); assert.equal(error.statusCode, 409); return true; });
  adapter.wallet = async () => ({ nativeBalanceLamports: '30000000', quoteBalanceRaw: '1000000' });
  await assert.rejects(adapter.requireLaunchFunds({ wallet, launch, quoteMintState: null, first: 2500000n, stage: 'initialize' }), /holds 1 USDC; the first buy needs 2\.5 USDC\. .* so buy 1\.5 more USDC \(contract address/);
  // Enough of the pair asset but not enough SOL for the create stage: the SOL sentence carries the parts.
  adapter.wallet = async () => ({ nativeBalanceLamports: '30000000', quoteBalanceRaw: '3000000' });
  await assert.rejects(adapter.requireLaunchFunds({ wallet, launch, quoteMintState: null, first: 2500000n, stage: 'initialize' }), error => { assert.equal(error.message, 'Your wallet has 0.03 SOL; creating the coin needs about 0.04001 SOL (0.02501 SOL of account rent and network fees, the 0.015 SOL creation fee). Add 0.01001 SOL and try again.'); assert.equal(error.code, 'METEORA_GAS'); assert.equal(error.shortfallLamports, '10010000'); return true; });
  // With SOL as the pair the first buy is part of the SOL needed, and the advice includes lowering it.
  Object.assign(launch, { quoteMint: NATIVE_MINT.toBase58(), quoteSymbol: 'SOL', quoteDecimals: 9 });
  adapter.wallet = async () => ({ nativeBalanceLamports: '100000000', quoteBalanceRaw: '100000000' });
  await assert.rejects(adapter.requireLaunchFunds({ wallet, launch, quoteMintState: null, first: 500_000_000n, stage: 'initialize' }), /^Error: Your wallet has 0\.1 SOL; creating the coin needs about 0\.54001 SOL \(0\.02501 SOL of account rent and network fees, the 0\.5 SOL first buy, the 0\.015 SOL creation fee\)\. Add 0\.44001 SOL or lower the first buy and try again\.$/);
  const funds = await adapter.requireLaunchFunds({ wallet, launch, quoteMintState: null, first: 50_000_000n, stage: 'initialize' }); assert.equal(funds.nativeBalanceLamports, '100000000');
  assert.equal(connection.getBalance.length, 0);
});
