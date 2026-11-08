import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { MintLayout, AccountLayout, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, NATIVE_MINT, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, getMintLen, ExtensionType, TransferFeeConfigLayout } from '@solana/spl-token';
import BN from 'bn.js';
import bs58 from 'bs58';
import { ray } from '../src/launchpad-chain.mjs';
import { LaunchTradingChain } from '../src/launchpad-trading-chain.mjs';
import { JUPITER } from '../src/core.mjs';
import { transactionSize } from '../src/providers.mjs';

const bn=x=>new BN(String(x));
function rayAccount(layout,name,fields,owner=ray.LAUNCHPAD_PROGRAM){const data=Buffer.alloc(layout.span);layout.encode({...layout.decode(data),...fields},data);createHash('sha256').update(`account:${name}`).digest().copy(data,0,0,8);return {data,owner,lamports:1e7,executable:false};}
function mintAccount(decimals,supply=1000000000000000n,fee){
  const data=Buffer.alloc(fee?getMintLen([ExtensionType.TransferFeeConfig]):MintLayout.span);
  MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply,decimals,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},data);
  if(fee){data[165]=1;data.writeUInt16LE(ExtensionType.TransferFeeConfig,166);data.writeUInt16LE(TransferFeeConfigLayout.span,168);TransferFeeConfigLayout.encode(fee,data.subarray(170));}
  return {data,owner:fee?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,lamports:1e7,executable:false};
}
function tokenAccount(mint,owner,amount=1000000000000000n,program=TOKEN_PROGRAM_ID){const data=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint,owner,amount,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);return {data,owner:program,lamports:2039280,executable:false};}
function harness({native=false,graduated=false,quoteTax=false,quoteMint=null,quoteDecimals=null,walletAddress=null}={}){
  const m=Keypair.generate().publicKey,q=native?NATIVE_MINT:quoteMint?new PublicKey(quoteMint):Keypair.generate().publicKey,w=Keypair.generate().publicKey,trader=walletAddress?{publicKey:new PublicKey(walletAddress)}:Keypair.generate(),program=ray.LAUNCHPAD_PROGRAM;
  const config=ray.getPdaLaunchpadConfigId(program,q,0,2).publicKey,platform=ray.getPdaPlatformId(program,w).publicKey,pool=ray.getPdaLaunchpadPoolId(program,m,q).publicKey,auth=ray.getPdaLaunchpadAuth(program);
  const va=ray.getPdaLaunchpadVaultId(program,pool,m).publicKey,vb=ray.getPdaLaunchpadVaultId(program,pool,q).publicKey,cpConfig=ray.getCpmmPdaAmmConfigId(ray.CREATE_CPMM_POOL_PROGRAM,3).publicKey;
  const [a,b]=[m,q].sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer())),cp=ray.getCpmmPdaPoolId(ray.CREATE_CPMM_POOL_PROGRAM,cpConfig,a,b).publicKey,cpAuth=ray.getPdaPoolAuthority(ray.CREATE_CPMM_POOL_PROGRAM),cpVa=ray.getPdaVault(ray.CREATE_CPMM_POOL_PROGRAM,cp,a).publicKey,cpVb=ray.getPdaVault(ray.CREATE_CPMM_POOL_PROGRAM,cp,b).publicKey;
  const qProgram=quoteTax?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,qDecimals=quoteDecimals??(native?9:6);
  const state={bump:auth.nonce,status:graduated?2:0,mintDecimalsA:6,mintDecimalsB:qDecimals,mintProgramFlag:quoteTax?2:0,migrateType:1,supply:bn('1000000000000000'),totalSellA:bn('800000000000000'),totalFundRaisingB:bn('100000000000'),virtualA:bn('1100000000000000'),virtualB:bn('22000000000'),realA:bn('100000000000000'),realB:bn('10000000000'),configId:config,platformId:platform,mintA:m,mintB:q,vaultA:va,vaultB:vb,creator:w};
  const cpState={configId:cpConfig,poolCreator:w,vaultA:cpVa,vaultB:cpVb,mintLp:ray.getPdaLpMint(ray.CREATE_CPMM_POOL_PROGRAM,cp).publicKey,mintA:a,mintB:b,mintProgramA:a.equals(m)?TOKEN_PROGRAM_ID:qProgram,mintProgramB:b.equals(m)?TOKEN_PROGRAM_ID:qProgram,observationId:ray.getPdaObservationId(ray.CREATE_CPMM_POOL_PROGRAM,cp).publicKey,bump:cpAuth.nonce,status:0,mintDecimalA:a.equals(m)?6:qDecimals,mintDecimalB:b.equals(m)?6:qDecimals,openTime:bn(1),enableCreatorFee:true,feeOn:0,creatorFeesMintA:bn(0),creatorFeesMintB:bn(0)};
  const launch={input:{network:'mainnet-beta',route:'raydium',symbol:'TEST',quoteMint:q.toBase58(),taxBps:0},curve:pool.toBase58(),keys:{wallet:{address:w.toBase58(),secret:'creator-secret-must-not-sign'},mint:{address:m.toBase58()}},review:{configId:config.toBase58(),cpConfigId:cpConfig.toBase58(),quoteProgram:qProgram.toBase58(),quoteDecimals:qDecimals,quoteSymbol:'QUOTE',supply:state.supply.toString(),sell:state.totalSellA.toString(),raise:state.totalFundRaisingB.toString(),virtualBase:state.virtualA.toString(),virtualQuote:state.virtualB.toString()}};
  const accounts=new Map(),put=(key,account)=>accounts.set(key.toBase58(),account),ataA=getAssociatedTokenAddressSync(m,trader.publicKey),ataB=getAssociatedTokenAddressSync(q,trader.publicKey,false,qProgram),calls=[];
  const reset=()=>{
    put(pool,rayAccount(ray.LaunchpadPool,'PoolState',state));put(config,rayAccount(ray.LaunchpadConfig,'GlobalConfig',{mintB:q,index:2,curveType:0,tradeFeeRate:bn(1000)}));
    put(platform,rayAccount(ray.PlatformConfig,'PlatformConfig',{cpConfigId:cpConfig,platformClaimFeeWallet:w,feeRate:bn(10000),creatorFeeRate:bn(10000)}));
    put(m,mintAccount(6));put(q,mintAccount(qDecimals,1000000000000000n,quoteTax?{transferFeeConfigAuthority:w,withdrawWithheldAuthority:w,withheldAmount:0n,olderTransferFee:{epoch:0n,maximumFee:1000000000000000n,transferFeeBasisPoints:100},newerTransferFee:{epoch:101n,maximumFee:1000000000000000n,transferFeeBasisPoints:9000}}:undefined));
    put(va,tokenAccount(m,auth.publicKey));put(vb,tokenAccount(q,auth.publicKey,1000000000000000n,qProgram));
    put(cpConfig,rayAccount(ray.CpmmConfigInfoLayout,'AmmConfig',{index:3,tradeFeeRate:bn(1000),creatorFeeRate:bn(1000),protocolFeeRate:bn(120000),fundFeeRate:bn(40000)},ray.CREATE_CPMM_POOL_PROGRAM));
    if(graduated){put(cp,rayAccount(ray.CpmmPoolInfoLayout,'PoolState',cpState,ray.CREATE_CPMM_POOL_PROGRAM));put(cpVa,tokenAccount(a,cpAuth.publicKey,1000000000000000n,cpState.mintProgramA));put(cpVb,tokenAccount(b,cpAuth.publicKey,1000000000000000n,cpState.mintProgramB));}
    put(trader.publicKey,{data:Buffer.alloc(0),owner:SystemProgram.programId,lamports:5000000000,executable:false});put(ataA,tokenAccount(m,trader.publicKey));put(ataB,tokenAccount(q,trader.publicKey,1000000000000000n,qProgram));
  };reset();
  const connection={getMultipleAccountsInfoAndContext:async(keys,opts)=>{calls.push({keys,opts});return {context:{slot:999999999},value:keys.map(k=>accounts.get(k.toBase58())||null)};},getEpochInfo:async()=>({epoch:100}),getMinimumBalanceForRentExemption:async()=>2039280};
  const chain=new LaunchTradingChain({network:'mainnet-beta',connection});
  return {chain,launch,trader,w,m,q,pool,platform,config,state,cpState,cp,cpConfig,va,vb,cpVa,cpVb,ataA,ataB,accounts,put,reset,calls};
}

test('buy and sell quotes preserve original creator vault while only the trader signs',async()=>{
  const h=harness();
  for(const side of ['buy','sell']){
    const quote=await h.chain.quotePaired(h.launch,{wallet:h.trader.publicKey.toBase58(),side,amount:'1',slippageBps:100});
    const ixs=await h.chain.tradeInstructions(quote),swap=ixs.find(ix=>ix.programId.equals(ray.LAUNCHPAD_PROGRAM));
    const creatorVault=ray.getPdaCreatorVault(ray.LAUNCHPAD_PROGRAM,h.w,h.q).publicKey;
    assert(swap.keys.some(k=>k.pubkey.equals(creatorVault)));assert(!swap.keys.some(k=>k.pubkey.equals(ray.getPdaCreatorVault(ray.LAUNCHPAD_PROGRAM,h.trader.publicKey,h.q).publicKey)));
    assert.deepEqual(ixs.flatMap(ix=>ix.keys.filter(k=>k.isSigner).map(k=>k.pubkey.toBase58())),[h.trader.publicKey.toBase58()]);
    assert(BigInt(quote.minimumOutputRaw)>0n);assert(!JSON.stringify(quote).includes('secret'));
  }
});

test('trading preflight accepts a revoked base tax config while retaining its 2% fee and withdrawal authority',async()=>{
  for(const revoked of [false,true]){
    const h=harness(),fee={epoch:0n,maximumFee:18446744073709551615n,transferFeeBasisPoints:200};
    h.launch.input.taxBps=200;h.state.mintProgramFlag=1;h.reset();
    h.put(h.m,mintAccount(6,1000000000000000n,{transferFeeConfigAuthority:revoked?PublicKey.default:h.w,withdrawWithheldAuthority:h.w,withheldAmount:0n,olderTransferFee:fee,newerTransferFee:fee}));
    const authority=ray.getPdaLaunchpadAuth(ray.LAUNCHPAD_PROGRAM).publicKey;
    h.put(h.va,tokenAccount(h.m,authority,1000000000000000n,TOKEN_2022_PROGRAM_ID));
    const state=await h.chain.tradingState(h.launch);
    assert.equal(state.baseFee.olderTransferFee.transferFeeBasisPoints,200);
    assert.equal(state.baseFee.newerTransferFee.transferFeeBasisPoints,200);
    assert(state.baseFee.withdrawWithheldAuthority.equals(h.w));
  }
});

test('exact decimal input and bounded slippage reject rounding and invalid values',async()=>{
  const h=harness(),base={wallet:h.trader.publicKey.toBase58(),side:'buy',amount:'1',slippageBps:100};
  for(const change of [{amount:'1.0000001'},{amount:'0'},{amount:'1e3'},{amount:'-1'},{slippageBps:-1},{slippageBps:10001},{slippageBps:10.5},{side:'transfer'}])await assert.rejects(h.chain.quotePaired(h.launch,{...base,...change}));
});

test('unrecognized launch identities, vaults, mint authority and frozen trader accounts fail closed',async()=>{
  const mutations=[h=>{h.state.creator=Keypair.generate().publicKey;h.reset();},h=>{h.state.vaultA=h.q;h.reset();},h=>{h.launch.review.cpConfigId=h.q.toBase58();},h=>{h.accounts.get(h.ataA.toBase58()).data[108]=2;},h=>{h.accounts.get(h.m.toBase58()).data.writeUInt32LE(1,0);}];
  for(const mutate of mutations){const h=harness();mutate(h);await assert.rejects(h.chain.quotePaired(h.launch,{wallet:h.trader.publicKey.toBase58(),side:'buy',amount:'1',slippageBps:100}));}
});

test('wallet balances use only trader holdings and check both input and SOL costs',async()=>{
  const h=harness(),wallet=h.trader.publicKey.toBase58(),balance=await h.chain.walletBalances(h.launch,{wallet});assert.equal(balance.baseBalanceRaw,'1000000000000000');
  h.put(h.ataB,tokenAccount(h.q,h.trader.publicKey,1n));await assert.rejects(h.chain.quotePaired(h.launch,{wallet,side:'buy',amount:'1',slippageBps:100}),/Insufficient/);
  h.reset();h.accounts.get(wallet).lamports=1;await assert.rejects(h.chain.quotePaired(h.launch,{wallet,side:'sell',amount:'1',slippageBps:100}),/Insufficient SOL/);
});

test('native SOL wraps exactly the buy input and unwraps into the same wallet without closing an existing ATA',async()=>{
  for(const side of ['buy','sell']){
    const h=harness({native:true}),quote=await h.chain.quotePaired(h.launch,{wallet:h.trader.publicKey.toBase58(),side,amount:side==='buy'?'0.01':'100',slippageBps:100}),ixs=await h.chain.tradeInstructions(quote);
    const close=ixs.at(-1);assert.equal(close.data[0],9);assert(close.keys[1].pubkey.equals(h.trader.publicKey));assert(!close.keys[0].pubkey.equals(h.ataB));
    assert.equal(quote[side==='buy'?'inputSymbol':'outputSymbol'],'SOL');
    const swap=ixs.find(ix=>ix.programId.equals(ray.LAUNCHPAD_PROGRAM));assert(swap.keys.some(k=>k.pubkey.equals(close.keys[0].pubkey)));
  }
});

test('graduated CPMM trades verify derived config, vaults, observation and original creator',async()=>{
  const h=harness({graduated:true}),quote=await h.chain.quotePaired(h.launch,{wallet:h.trader.publicKey.toBase58(),side:'buy',amount:'1',slippageBps:100});assert.equal(quote.market,'cpmm');
  const ixs=await h.chain.tradeInstructions(quote);assert(ixs.some(ix=>ix.programId.equals(ray.CREATE_CPMM_POOL_PROGRAM)));
  for(const field of ['configId','vaultA','observationId','poolCreator','mintProgramA']){
    const x=harness({graduated:true});x.cpState[field]=Keypair.generate().publicKey;x.reset();await assert.rejects(x.chain.quotePaired(x.launch,{wallet:x.trader.publicKey.toBase58(),side:'buy',amount:'1',slippageBps:100}));
  }
});

test('both trade directions use the actual epoch and do not activate future transfer fees from slot division',async()=>{
  for(const graduated of [false,true])for(const side of ['buy','sell']){
    const h=harness({quoteTax:true,graduated}),params={wallet:h.trader.publicKey.toBase58(),side,amount:'10',slippageBps:100};
    const older=await h.chain.quotePaired(h.launch,params);h.chain.c.getEpochInfo=async()=>({epoch:101});const newer=await h.chain.quotePaired(h.launch,params);
    assert(BigInt(older.expectedOutputRaw)>BigInt(newer.expectedOutputRaw)*2n);
  }
});

test('prepare requires an authentic quote, refreshes price and substitutes signer only after instructions are built',async()=>{
  const h=harness({native:true}),params={wallet:h.trader.publicKey.toBase58(),side:'buy',amount:'1',slippageBps:100},quote=await h.chain.quote(h.launch,params);
  await assert.rejects(h.chain.prepareTrade(h.launch,{...quote},{external:true}),/quote/);
  h.chain.verifyTradeSimulation=async()=>{};let selected;h.chain.prepare=async(launch,ixs)=>{selected=launch;assert(ixs.some(ix=>ix.keys.some(k=>k.pubkey.equals(ray.getPdaCreatorVault(ray.LAUNCHPAD_PROGRAM,h.w,h.q).publicKey))));return {needsSignature:true};};
  const result=await h.chain.prepareTrade(h.launch,quote,{external:true});assert(result.needsSignature);assert.equal(selected.keys.wallet.address,params.wallet);assert.equal(h.launch.keys.wallet.address,h.w.toBase58());
  await assert.rejects(h.chain.prepareTrade(h.launch,quote,{external:true}),/quote/);
});

test('recently confirmed SOL funding is used by both unsigned trade simulations at the quoted slot',async()=>{
  const h=harness({native:true}),wallet=h.trader.publicKey.toBase58(),quote=await h.chain.quote(h.launch,{wallet,side:'buy',amount:'0.1',slippageBps:100}),simulations=[];
  h.chain.c.getLatestBlockhash=async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:123456});
  h.chain.c.simulateTransaction=async(tx,config)=>{
    simulations.push(config);
    // A finalized bank predating the deposit has insufficient SOL. The quote
    // and both simulations must read confirmed state at least as new as it.
    if(config.commitment!=='confirmed'||config.minContextSlot<quote.slot){const index=tx.message.compiledInstructions.findIndex(ix=>tx.message.staticAccountKeys[ix.programIdIndex].equals(SystemProgram.programId));return{context:{slot:quote.slot-1},value:{err:{InstructionError:[index,{Custom:1}]}}};}
    if(config.accounts)return simulatedBalances(h,quote);
    return{context:{slot:quote.slot},value:{err:null,unitsConsumed:100000}};
  };
  h.chain.c.sendRawTransaction=()=>assert.fail('review must not broadcast');
  const op=await h.chain.prepareTrade(h.launch,quote,{external:true});assert.equal(op.needsSignature,true);assert.equal(simulations.length,2);assert(simulations.every(config=>config.commitment==='confirmed'&&config.minContextSlot===quote.slot&&config.sigVerify===false));assert.equal(op.preparedSlot,quote.slot);
});

test('trade simulation labels insufficient SOL only for SystemProgram custom 1',async()=>{
  for(const program of [SystemProgram.programId,TOKEN_PROGRAM_ID,ray.LAUNCHPAD_PROGRAM]){
    const h=harness({native:true}),wallet=h.trader.publicKey.toBase58(),selected={address:wallet,external:true},launch={...h.launch,keys:{...h.launch.keys,wallet:selected,payer:selected}};
    const instruction=program.equals(SystemProgram.programId)?SystemProgram.transfer({fromPubkey:h.trader.publicKey,toPubkey:h.w,lamports:1}):new TransactionInstruction({programId:program,keys:[],data:Buffer.alloc(0)});
    h.chain.c.getLatestBlockhash=async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:123456});h.chain.c.simulateTransaction=async()=>({context:{slot:123},value:{err:{InstructionError:[2,{Custom:1}]}}});
    await assert.rejects(h.chain.prepare(launch,[instruction],[],'trade',{minContextSlot:123}),error=>program.equals(SystemProgram.programId)?error.code==='TRADE_INSUFFICIENT_SOL'&&/Reduce the amount or add SOL/.test(error.message)&&/Nothing was submitted/.test(error.message):error.code===undefined&&/during trade/.test(error.message)&&!/^Insufficient SOL/.test(error.message));
  }
});

test('trade preparation rejects missing snapshot context and never changes fee-processing finality',async()=>{
  const h=harness({native:true}),wallet=h.trader.publicKey.toBase58(),selected={address:wallet,external:true},launch={...h.launch,keys:{...h.launch.keys,wallet:selected,payer:selected}},instruction=SystemProgram.transfer({fromPubkey:h.trader.publicKey,toPubkey:h.w,lamports:1}),configs=[];
  h.chain.c.getLatestBlockhash=async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:123456});h.chain.c.simulateTransaction=async(_tx,config)=>{configs.push(config);return{value:{err:null}};};
  await assert.rejects(h.chain.prepare(launch,[instruction],[],'trade'),/reviewed trading snapshot/);assert.equal(configs.length,0);
  await assert.rejects(h.chain.prepare(launch,[instruction],[],'trade',{minContextSlot:123}),/omitted the trading simulation context/);
  assert.equal((await h.chain.prepare(launch,[instruction])).needsSignature,true);assert.equal(configs.at(-1).commitment,'finalized');assert.equal(configs.at(-1).minContextSlot,undefined);
});

test('a price move below the reviewed minimum cannot silently produce a worse transaction',async()=>{
  const h=harness({native:true}),quote=await h.chain.quote(h.launch,{wallet:h.trader.publicKey.toBase58(),side:'buy',amount:'1',slippageBps:10});
  h.state.realA=bn('790000000000000');h.reset();h.chain.prepare=()=>assert.fail('must not sign');
  await assert.rejects(h.chain.prepareTrade(h.launch,quote,{external:true}),/price or market moved/);
});

function stubRoutes(chain) {
  const calls=[];
  chain.tradeRoutes={
    quoteConversion:async(_chain,args)=>{
      calls.push(args);const buy=args.inputMint===NATIVE_MINT.toBase58();
      return {amountRaw:args.amountRaw,inputMint:args.inputMint,outputMint:args.outputMint,expectedRaw:buy?'1000000':'10000000',minimumRaw:buy?'990000':'9900000',rentLamports:'2039280',expiresAt:Date.now()+30000};
    },
    buildConversion:async()=>({instructions:[],lookupTables:[],rentLamports:'2039280'}),
  };
  return calls;
}

test('public buy spends SOL and feeds only guaranteed conversion proceeds into the paired curve',async()=>{
  const h=harness(),calls=stubRoutes(h.chain),wallet=h.trader.publicKey.toBase58();h.accounts.delete(h.ataB.toBase58());
  const quote=await h.chain.quote(h.launch,{wallet,side:'buy',amount:'0.1',slippageBps:100});
  assert.equal(quote.amountRaw,'100000000');assert.equal(quote.inputSymbol,'SOL');assert.equal(quote.inputMint,NATIVE_MINT.toBase58());assert.equal(calls[0].amountRaw,'100000000');assert.equal(calls[0].slippageBps,50);
  assert(quote.residualQuotePossible);assert.match(quote.warning,/unused paired assets/);
  let instructions;h.chain.prepare=async(_launch,ixs)=>{instructions=ixs;return {needsSignature:true};};h.chain.verifyTradeSimulation=async()=>{};
  await h.chain.prepareTrade(h.launch,quote,{external:true});
  const swap=instructions.find(ix=>ix.programId.equals(ray.LAUNCHPAD_PROGRAM));assert.equal(swap.data.readBigUInt64LE(8),990000n);
});

test('public sell converts only the paired proceeds guaranteed by its native sell leg back to SOL',async()=>{
  const h=harness(),calls=stubRoutes(h.chain),wallet=h.trader.publicKey.toBase58();
  const quote=await h.chain.quote(h.launch,{wallet,side:'sell',amount:'100',slippageBps:100});
  assert.equal(quote.inputSymbol,'TEST');assert.equal(quote.outputSymbol,'SOL');assert.equal(quote.outputMint,NATIVE_MINT.toBase58());assert.equal(quote.minimumOutputRaw,'9900000');assert.equal(calls[0].inputMint,h.q.toBase58());assert.equal(calls[0].outputMint,NATIVE_MINT.toBase58());
  const paired=await h.chain.quotePaired(h.launch,{wallet,side:'sell',amount:'100',slippageBps:50});assert.equal(calls[0].amountRaw,paired.minimumOutputRaw);
});

test('a connected wallet never falls back to signing with a managed secret',async()=>{
  const h=harness({native:true}),quote=await h.chain.quote(h.launch,{wallet:h.trader.publicKey.toBase58(),side:'buy',amount:'0.1',slippageBps:100});
  await assert.rejects(h.chain.prepareTrade(h.launch,quote,{external:true,secret:'unexpected'}),/selected trading wallet/);
});

function unsignedOperation(wallet,instructions=[]) {
  const blockhash=SystemProgram.programId.toBase58(),tx=new VersionedTransaction(new TransactionMessage({payerKey:wallet,recentBlockhash:blockhash,instructions}).compileToV0Message());
  return {unsignedRaw:Buffer.from(tx.serialize()).toString('base64'),blockhash,lastValidBlockHeight:123456,preparedSlot:123400,state:'awaiting_signature',needsSignature:true,externalSigner:wallet.toBase58(),messageHash:'server-proof',createdAt:Date.now()};
}
function simulatedBalances(h,quote,{quoteDelta=0n,baseDelta,extraSpend=0n}={}) {
  const beforeBase=1000000000000000n,beforeQuote=1000000000000000n;
  const buy=quote.side==='buy',tokenChange=baseDelta??(buy?BigInt(quote.expectedOutputRaw):-BigInt(quote.amountRaw));
  const native=5000000000n+(buy?-BigInt(quote.amountRaw):BigInt(quote.expectedOutputRaw))-19000n-extraSpend;
  const accounts=[{...h.accounts.get(h.trader.publicKey.toBase58()),lamports:Number(native)},tokenAccount(h.m,h.trader.publicKey,beforeBase+tokenChange),tokenAccount(h.q,h.trader.publicKey,beforeQuote+quoteDelta)];
  return {context:{slot:999999999},value:{err:null,accounts:accounts.map(x=>({...x,owner:x.owner.toBase58(),data:[x.data.toString('base64'),'base64']}))}};
}

test('composite simulation rejects spending previous paired holdings, extra SOL, or missing minimum output',async()=>{
  const h=harness(),wallet=h.trader.publicKey.toBase58();stubRoutes(h.chain);
  const quote=await h.chain.quote(h.launch,{wallet,side:'buy',amount:'0.1',slippageBps:100}),op=unsignedOperation(h.trader.publicKey);
  h.chain.simulatePrepared=async()=>simulatedBalances(h,quote);await h.chain.verifyTradeSimulation(quote,op,[]);
  for(const [mutation,message] of [[{quoteDelta:-1n},/existing paired/],[{extraSpend:1000000000n},/reviewed SOL/],[{baseDelta:0n},/minimum tokens/]]){
    h.chain.simulatePrepared=async()=>simulatedBalances(h,quote,mutation);await assert.rejects(h.chain.verifyTradeSimulation(quote,op,[]),message);
  }
});

test('default wallet signing follows authorization, produces one valid signature and retains send context',async()=>{
  const h=harness({native:true}),wallet=h.trader.publicKey.toBase58(),quote=await h.chain.quote(h.launch,{wallet,side:'buy',amount:'0.1',slippageBps:100});
  let authorized=false;h.chain.prepare=async(_launch,ixs)=>unsignedOperation(h.trader.publicKey,ixs);h.chain.simulatePrepared=async()=>simulatedBalances(h,quote);
  const op=await h.chain.prepareTrade(h.launch,quote,{external:false,secret:bs58.encode(h.trader.secretKey),authorize:async()=>{authorized=true;}});
  assert(authorized);assert.equal(op.preparedSlot,999999999);assert.equal(op.state,'pending');assert.equal(op.needsSignature,undefined);assert.equal(op.unsignedRaw,undefined);assert.equal(op.externalSigner,undefined);
  const signed=VersionedTransaction.deserialize(Buffer.from(op.raw,'base64'));assert.equal(signed.signatures.length,1);assert.equal(bs58.encode(signed.signatures[0]),op.signature);assert.equal(signed.message.staticAccountKeys[0].toBase58(),wallet);
});

test('revoked authorization prevents default signing and increased setup costs demand another review',async()=>{
  const h=harness({native:true}),wallet=h.trader.publicKey.toBase58(),quote=await h.chain.quote(h.launch,{wallet,side:'buy',amount:'0.1',slippageBps:100});
  h.chain.prepare=async(_launch,ixs)=>unsignedOperation(h.trader.publicKey,ixs);h.chain.simulatePrepared=async()=>simulatedBalances(h,quote);
  await assert.rejects(h.chain.prepareTrade(h.launch,quote,{external:false,secret:bs58.encode(h.trader.secretKey),authorize:async()=>{throw Error('Session revoked');}}),/Session revoked/);
  h.accounts.delete(h.ataA.toBase58());h.chain.prepare=()=>assert.fail('must re-review costs before preparing');
  await assert.rejects(h.chain.prepareTrade(h.launch,quote,{external:false,secret:bs58.encode(h.trader.secretKey)}),/setup cost increased/);
});

test('intermediate wallet holdings and permissions survive the complete SOL conversion simulation',async()=>{
  const h=harness(),wallet=h.trader.publicKey.toBase58();stubRoutes(h.chain);
  const quote=await h.chain.quote(h.launch,{wallet,side:'buy',amount:'0.1',slippageBps:100}),op=unsignedOperation(h.trader.publicKey),mint=Keypair.generate().publicKey,address=getAssociatedTokenAddressSync(mint,h.trader.publicKey);
  const audit=[{address:address.toBase58(),mint:mint.toBase58(),program:TOKEN_PROGRAM_ID.toBase58(),minimumAmountRaw:'1000000',minimumLamports:2039280}];
  const simulate=(mutation={})=>{
    const result=simulatedBalances(h,quote),extra=tokenAccount(mint,h.trader.publicKey,1000000n);
    const {lamports,...fields}=mutation;if(lamports!==undefined)extra.lamports=lamports;
    AccountLayout.encode({...AccountLayout.decode(extra.data),...fields},extra.data);
    result.value.accounts.push({...extra,owner:extra.owner.toBase58(),data:[extra.data.toString('base64'),'base64']});return result;
  };
  h.chain.simulatePrepared=async()=>simulate();await h.chain.verifyTradeSimulation(quote,op,[],audit);
  for(const mutation of [{amount:999999n},{delegateOption:1,delegate:Keypair.generate().publicKey},{delegatedAmount:1n},{closeAuthorityOption:1,closeAuthority:Keypair.generate().publicKey},{isNativeOption:1,isNative:2039280n},{lamports:2039279},{owner:Keypair.generate().publicKey}]){
    h.chain.simulatePrepared=async()=>simulate(mutation);await assert.rejects(h.chain.verifyTradeSimulation(quote,op,[],audit),/intermediate wallet|invalid mint, owner/);
  }
});

test('trading broadcast uses the confirmed simulation context and never skips preflight',async()=>{
  const h=harness(),calls=[];h.chain.c.sendRawTransaction=async(raw,options)=>{calls.push({raw,options});return 'saved-signature';};
  await h.chain.broadcast({raw:Buffer.from('opaque').toString('base64'),signature:'saved-signature',preparedSlot:12345});
  assert.deepEqual(calls[0].options,{skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0,minContextSlot:12345});
});

// Public mainnet bytes captured on 2026-09-25. Keep these fixtures inline so
// the regression runs offline and never depends on an RPC or the probe files.
const LIVE_AMD_MINT = 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES';
const LIVE_AMD_MINT_BYTES = "AQAAAKMIZS3X6GqT9Sfb2lcBjNsXVve1tRoNxepgqTPObQ4fqwFtFwAAAAAGAQEAAAAX80uXa+rt4TKHeP4P0KXOfYzd/VZdEzYuovU7eFMWDwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARIAQAAX80uXa+rt4TKHeP4P0KXOfYzd/VZdEzYuovU7eFMWD4rmg4n/HyM8dyM8GGQ0zGVKsB1CIvdda9OvZ8Qlczw/DAAgABfzS5dr6u3hMod4/g/Qpc59jN39Vl0TNi6i9Tt4UxYPBgABAAEaACEAF/NLl2vq7eEyh3j+D9Clzn2M3f1WXRM2LqL1O3hTFg8ABABBABfzS5dr6u3hMod4/g/Qpc59jN39Vl0TNi6i9Tt4UxYPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgBAABfzS5dr6u3hMod4/g/Qpc59jN39Vl0TNi6i9Tt4UxYPAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAZADgAowhlLdfoapP1J9vaVwGM2xdW97W1Gg3F6mCpM85tDh8AAAAAAADwPwAAAAAAAAAAAAAAAAAA8D8TALwAF/NLl2vq7eEyh3j+D9Clzn2M3f1WXRM2LqL1O3hTFg+K5oOJ/x8jPHcjPBhkNMxlSrAdQiL3XWvTr2fEJXM8PywAAABBZHZhbmNlZCBNaWNybyBEZXZpY2VzIC0gQmFja3BhY2sgU2VjdXJpdGllcwMAAABBTUQ9AAAAaHR0cHM6Ly90cmVrLWxhYnMuZ2l0aHViLmlvL2hlYXJ0LW1ldGFkYXRhL3N0b2Nrcy9hbWQudXMuanNvbgAAAAA=";
const LIVE_DELTA_MINT_BYTES = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIDGpH6NAwAGAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const LIVE_AMD_REGISTRY_BYTES = "hii3TwxwojX9iuaDif8fIzx3IzwYZDTMZUqwHUIi911r069nxCVzPD8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
function amdHarness({graduated=false}={}) {
  const h=harness({quoteTax:true,quoteMint:LIVE_AMD_MINT,graduated});
  h.put(h.q,{...h.accounts.get(h.q.toBase58()),data:Buffer.from(LIVE_AMD_MINT_BYTES,'base64')});
  h.put(h.m,{...h.accounts.get(h.m.toBase58()),data:Buffer.from(LIVE_DELTA_MINT_BYTES,'base64')});
  h.registry=ray.getPdaMintExAccountCp(ray.CREATE_CPMM_POOL_PROGRAM,h.q).publicKey;
  h.put(h.registry,{owner:ray.CREATE_CPMM_POOL_PROGRAM,data:Buffer.from(LIVE_AMD_REGISTRY_BYTES,'base64'),lamports:1183640,executable:false});
  h.launch.input.symbol='DELTA';h.launch.review.quoteSymbol='AMD';return h;
}
// OpenAI PreStocks mainnet mint and exact Raydium registration captured at
// finalized slot 450503670 (2026-09-25). Extension 16 is not in the pinned
// SPL JS enum. Keep the full byte fixture to catch both allowlist and ATA-rent
// sizing failures for first-time buyers with no existing quote account.
const LIVE_OPENAI_MINT = "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF";
const LIVE_OPENAI_MINT_BYTES = "AQAAAAeNqqeCA9d7yCO5aGPaTYZRxkP8EOtsvluXh+BW2kvdAYKRy7oBAAAJAQEAAAAHjaqnggPXe8gjuWhj2k2GUcZD/BDrbL5bl4fgVtpL3QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQwAIAAHjaqnggPXe8gjuWhj2k2GUcZD/BDrbL5bl4fgVtpL3QYAAQABAQBsAAeNqqeCA9d7yCO5aGPaTYZRxkP8EOtsvluXh+BW2kvdB42qp4ID13vII7loY9pNhlHGQ/wQ62y+W5eH4FbaS90ZoMQKAgAAAA8EAAAAAAAA//////////9kABMEAAAAAAAA//////////8sAQQAQQAHjaqnggPXe8gjuWhj2k2GUcZD/BDrbL5bl4fgVtpL3QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAgQAHjaqnggPXe8gjuWhj2k2GUcZD/BDrbL5bl4fgVtpL3WCB1W7kKtMQ71vIPL1tXp2iAcSHa5u7/uxMhIjGhw5jAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAEAAB42qp4ID13vII7loY9pNhlHGQ/wQ62y+W5eH4FbaS90AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABkAOAAHjaqnggPXe8gjuWhj2k2GUcZD/BDrbL5bl4fgVtpL3QAAAAAAAPA/iFhaagAAAABcNt8tNcf3PxIAQAAHjaqnggPXe8gjuWhj2k2GUcZD/BDrbL5bl4fgVtpL3QXa7AUp5Su/Z/b/HhRqnras5/xOoxykvJ8V4Q/jcZcoGgAhAAeNqqeCA9d7yCO5aGPaTYZRxkP8EOtsvluXh+BW2kvdABMAkAAHjaqnggPXe8gjuWhj2k2GUcZD/BDrbL5bl4fgVtpL3QXa7AUp5Su/Z/b/HhRqnras5/xOoxykvJ8V4Q/jcZcoEAAAAE9wZW5BSSBQcmVTdG9ja3MGAAAAT1BFTkFJKgAAAGh0dHBzOi8vcHJlc3RvY2tzLmNvbS9tZXRhZGF0YS9vcGVuYWkuanNvbgAAAAA=";
const LIVE_OPENAI_REGISTRY_BYTES = "hii3TwxwojX+BdrsBSnlK79n9v8eFGqetqzn/E6jHKS8nxXhD+NxlygAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
function openaiHarness({graduated=false}={}) {
  const h=harness({quoteTax:true,quoteMint:LIVE_OPENAI_MINT,quoteDecimals:9,graduated});
  h.put(h.q,{...h.accounts.get(h.q.toBase58()),data:Buffer.from(LIVE_OPENAI_MINT_BYTES,'base64')});
  h.registry=ray.getPdaMintExAccountCp(ray.CREATE_CPMM_POOL_PROGRAM,h.q).publicKey;
  h.put(h.registry,{owner:ray.CREATE_CPMM_POOL_PROGRAM,data:Buffer.from(LIVE_OPENAI_REGISTRY_BYTES,'base64'),lamports:1621680,executable:false});
  h.launch.input.symbol='GAMMA';h.launch.review.quoteSymbol='OPENAI';return h;
}

function mintExtension(account,type) {
  for(let offset=166;offset+4<=account.data.length;) {
    const kind=account.data.readUInt16LE(offset),size=account.data.readUInt16LE(offset+2);
    if(kind===type)return account.data.subarray(offset+4,offset+4+size);
    offset+=4+size;
  }
  assert.fail(`Missing fixture extension ${type}`);
}
function appendMintExtension(account,type,data) {
  const header=Buffer.alloc(4);header.writeUInt16LE(type,0);header.writeUInt16LE(data.length,2);
  const prefix=account.data.length===MintLayout.span?Buffer.concat([account.data,Buffer.alloc(165-MintLayout.span),Buffer.from([1])]):account.data;
  account.data=Buffer.concat([prefix,header,data]);account.owner=TOKEN_2022_PROGRAM_ID;
}
function withConfidentialAccount(account,{allow=1,length=295}={}) {
  const extra=Buffer.alloc(length),header=Buffer.alloc(4);if(length>262)extra[262]=allow;
  header.writeUInt16LE(ExtensionType.ConfidentialTransferAccount,0);header.writeUInt16LE(length,2);
  return {...account,data:Buffer.concat([account.data.subarray(0,AccountLayout.span),Buffer.from([2]),header,extra])};
}

test('captured AMD issuer extensions allow public wallet balances and SOL trades with no AMD holdings',async()=>{
  for(const graduated of [false,true]) {
    const h=amdHarness({graduated}),wallet=h.trader.publicKey.toBase58(),routes=stubRoutes(h.chain);
    h.accounts.delete(h.ataB.toBase58());
    const balances=await h.chain.walletBalances(h.launch,{wallet});
    assert.equal(balances.quoteSymbol,'AMD');assert.equal(balances.quoteBalanceRaw,'0');assert.equal(balances.nativeBalanceLamports,'5000000000');
    assert.equal(balances.baseBalanceRaw,'1000000000000000');
    for(const side of ['buy','sell']) {
      const quote=await h.chain.quote(h.launch,{wallet,side,amount:side==='buy'?'0.1':'100',slippageBps:100});
      assert.equal(quote.market,graduated?'cpmm':'curve');assert(BigInt(quote.minimumOutputRaw)>0n);
      assert.equal(quote[side==='buy'?'inputMint':'outputMint'],NATIVE_MINT.toBase58());
      assert.equal(quote[side==='buy'?'inputSymbol':'outputSymbol'],'SOL');
      assert.equal(routes.at(-1)[side==='buy'?'outputMint':'inputMint'],LIVE_AMD_MINT);
      assert.equal(routes.at(-1)[side==='buy'?'outputProgram':'inputProgram'],TOKEN_2022_PROGRAM_ID.toBase58());
    }
    const states=h.calls.filter(call=>call.keys.some(key=>key.equals(h.pool)));
    assert(states.length>0);assert(states.every(call=>call.keys.length===12&&call.keys.some(key=>key.equals(h.q))&&call.keys.at(-1).equals(h.registry)));
  }
});

test('captured OpenAI PreStocks extension 16 supports first-time SOL buy and sell quotes before and after graduation',async()=>{
  for(const graduated of [false,true]) {
    const h=openaiHarness({graduated}),wallet=h.trader.publicKey.toBase58(),routes=stubRoutes(h.chain),sizes=[];
    h.accounts.delete(h.ataB.toBase58());
    h.chain.c.getMinimumBalanceForRentExemption=async size=>{sizes.push(size);return 2039280;};
    const balance=await h.chain.walletBalances(h.launch,{wallet});
    assert.equal(balance.quoteSymbol,'OPENAI');assert.equal(balance.quoteDecimals,9);assert.equal(balance.quoteBalanceRaw,'0');
    for(const side of ['buy','sell']) {
      const quote=await h.chain.quote(h.launch,{wallet,side,amount:side==='buy'?'0.1':'100',slippageBps:100});
      assert.equal(quote.market,graduated?'cpmm':'curve');assert(BigInt(quote.minimumOutputRaw)>0n);
      assert.equal(quote[side==='buy'?'inputSymbol':'outputSymbol'],'SOL');
      assert.equal(routes.at(-1)[side==='buy'?'outputMint':'inputMint'],LIVE_OPENAI_MINT);
      assert.equal(routes.at(-1)[side==='buy'?'outputProgram':'inputProgram'],TOKEN_2022_PROGRAM_ID.toBase58());
    }
    assert(sizes.length>0);assert(sizes.every(size=>Number.isSafeInteger(size)&&size>165));
    const paired=await h.chain.quotePaired(h.launch,{wallet,side:'buy',amount:'0.001',slippageBps:100},1000000n);
    const instructions=await h.chain.tradeInstructions(paired);
    const ata=instructions.find(ix=>ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
    assert(ata);assert(ata.keys.some(k=>k.pubkey.equals(TOKEN_2022_PROGRAM_ID)));assert(ata.keys.some(k=>k.pubkey.equals(h.q)));
  }
});

test('OpenAI public-transfer fees still reduce output and use the actual fee epoch',async()=>{
  for(const graduated of [false,true])for(const side of ['buy','sell']) {
    const h=openaiHarness({graduated}),params={wallet:h.trader.publicKey.toBase58(),side,amount:side==='buy'?'1':'10000',slippageBps:100};
    h.chain.c.getEpochInfo=async()=>({epoch:1039});const older=await h.chain.quotePaired(h.launch,params);
    h.chain.c.getEpochInfo=async()=>({epoch:1043});const newer=await h.chain.quotePaired(h.launch,params);
    assert(BigInt(older.expectedOutputRaw)>BigInt(newer.expectedOutputRaw),`${graduated}:${side} ${older.expectedOutputRaw} -> ${newer.expectedOutputRaw}`);
  }
});

test('confidential fee support remains registered-quote-only and rejects malformed or unknown extensions',async()=>{
  const mutations=[
    [h=>h.accounts.delete(h.registry.toBase58()),/unsupported token extensions/],
    [h=>{h.accounts.get(h.registry.toBase58()).data[9]^=1;},/unsupported token extensions/],
    [h=>{h.accounts.get(h.registry.toBase58()).owner=TOKEN_2022_PROGRAM_ID;},/unsupported token extensions/],
    [h=>{mintExtension(h.accounts.get(h.q.toBase58()),16)[64]=2;},/invalid confidential transfer fee/],
    [h=>{appendMintExtension(h.accounts.get(h.q.toBase58()),16,Buffer.alloc(129));},/invalid confidential transfer fee/],
    [h=>{const a=h.accounts.get(h.q.toBase58()),extra=mintExtension(a,16),offset=extra.byteOffset-a.data.byteOffset-4; a.data=Buffer.concat([a.data.subarray(0,offset+4),extra.subarray(0,128),a.data.subarray(offset+4+129)]);a.data.writeUInt16LE(128,offset+2);},/invalid confidential transfer fee/],
    [h=>{const a=h.accounts.get(h.q.toBase58()),extra=mintExtension(a,ExtensionType.TransferFeeConfig),offset=extra.byteOffset-a.data.byteOffset-4; a.data=Buffer.concat([a.data.subarray(0,offset),a.data.subarray(offset+4+extra.length)]);},/invalid confidential transfer fee/],
    [h=>{const a=h.accounts.get(h.q.toBase58()),extra=mintExtension(a,ExtensionType.ConfidentialTransferMint),offset=extra.byteOffset-a.data.byteOffset-4; a.data=Buffer.concat([a.data.subarray(0,offset),a.data.subarray(offset+4+extra.length)]);},/invalid confidential transfer fee/],
    [h=>appendMintExtension(h.accounts.get(h.q.toBase58()),65535,Buffer.alloc(0)),/unsupported token extensions/],
    [h=>appendMintExtension(h.accounts.get(h.m.toBase58()),16,Buffer.alloc(129)),/unsupported token extensions/],
    [h=>{mintExtension(h.accounts.get(h.q.toBase58()),ExtensionType.DefaultAccountState)[0]=2;},/requires frozen token accounts/],
    [h=>{mintExtension(h.accounts.get(h.q.toBase58()),ExtensionType.PausableConfig)[32]=1;},/paired asset is paused/],
    [h=>{Keypair.generate().publicKey.toBuffer().copy(mintExtension(h.accounts.get(h.q.toBase58()),ExtensionType.TransferHook),32);},/active transfer hook/],
    [h=>h.put(h.ataB,withConfidentialAccount(h.accounts.get(h.ataB.toBase58()),{allow:0})),/does not allow ordinary token transfers/,1],
  ];
  for(const [mutate,message,routeCalls=0] of mutations) {
    const h=openaiHarness(),routes=stubRoutes(h.chain);mutate(h);
    await assert.rejects(h.chain.walletBalances(h.launch,{wallet:h.trader.publicKey.toBase58()}),message);
    await assert.rejects(h.chain.quote(h.launch,{wallet:h.trader.publicKey.toBase58(),side:'buy',amount:'0.1',slippageBps:100}),message);
    assert.equal(routes.length,routeCalls);
  }
});

test('issuer-controlled quote mints require an authentic support registry at the exact PDA',async()=>{
  const mutations=[
    h=>h.accounts.delete(h.registry.toBase58()),
    h=>{const account=h.accounts.get(h.registry.toBase58());h.accounts.delete(h.registry.toBase58());h.put(Keypair.generate().publicKey,account);},
    h=>{h.accounts.get(h.registry.toBase58()).owner=TOKEN_2022_PROGRAM_ID;},
    h=>{h.accounts.get(h.registry.toBase58()).executable=true;},
    h=>{const a=h.accounts.get(h.registry.toBase58());a.data=a.data.subarray(0,104);},
    h=>{const a=h.accounts.get(h.registry.toBase58());a.data=Buffer.concat([a.data,Buffer.from([0])]);},
    h=>{h.accounts.get(h.registry.toBase58()).data[0]^=1;},
    h=>{h.accounts.get(h.registry.toBase58()).data[8]^=1;},
    h=>{h.accounts.get(h.registry.toBase58()).data[9]^=1;},
  ];
  for(const mutate of mutations) {
    const h=amdHarness(),routes=stubRoutes(h.chain);mutate(h);
    await assert.rejects(h.chain.walletBalances(h.launch,{wallet:h.trader.publicKey.toBase58()}),/unsupported token extensions/);
    await assert.rejects(h.chain.quote(h.launch,{wallet:h.trader.publicKey.toBase58(),side:'buy',amount:'0.1',slippageBps:100}),/unsupported token extensions/);
    assert.equal(routes.length,0);
  }
});

test('registered quotes still reject frozen defaults, paused transfers, active hooks and unknown extensions',async()=>{
  const changes=[
    [a=>{mintExtension(a,ExtensionType.DefaultAccountState)[0]=2;},/requires frozen token accounts/],
    [a=>{mintExtension(a,ExtensionType.DefaultAccountState)[0]=0;},/requires frozen token accounts/],
    [a=>{mintExtension(a,ExtensionType.PausableConfig)[32]=1;},/paired asset is paused/],
    [a=>{Keypair.generate().publicKey.toBuffer().copy(mintExtension(a,ExtensionType.TransferHook),32);},/active transfer hook/],
    [a=>appendMintExtension(a,65535,Buffer.alloc(0)),/unsupported token extensions/],
    [a=>appendMintExtension(a,ExtensionType.NonTransferable,Buffer.alloc(0)),/unsupported token extensions/],
  ];
  for(const [mutate,message] of changes) {
    const h=amdHarness();mutate(h.accounts.get(h.q.toBase58()));
    await assert.rejects(h.chain.walletBalances(h.launch,{wallet:h.trader.publicKey.toBase58()}),message);
  }
});

test('the registered quote exception never admits extra issuer controls on the launched base token',async()=>{
  const h=amdHarness();appendMintExtension(h.accounts.get(h.m.toBase58()),ExtensionType.PermanentDelegate,h.w.toBuffer());
  const registry=ray.getPdaMintExAccountCp(ray.CREATE_CPMM_POOL_PROGRAM,h.m),data=Buffer.from(LIVE_AMD_REGISTRY_BYTES,'base64');
  data[8]=registry.nonce;h.m.toBuffer().copy(data,9);h.put(registry.publicKey,{owner:ray.CREATE_CPMM_POOL_PROGRAM,data,lamports:1183640,executable:false});
  await assert.rejects(h.chain.walletBalances(h.launch,{wallet:h.trader.publicKey.toBase58()}),/unsupported token extensions/);
});

test('optional confidential accounts must explicitly allow ordinary credits in both wallets and pool vaults',async()=>{
  for(const graduated of [false,true])for(const location of ['wallet','vault']) {
    const h=amdHarness({graduated}),key=location==='wallet'?h.ataB:graduated?(h.cpState.mintA.equals(h.q)?h.cpVa:h.cpVb):h.vb;
    const original=h.accounts.get(key.toBase58()),wallet=h.trader.publicKey.toBase58();
    h.put(key,withConfidentialAccount(original));
    const balance=await h.chain.walletBalances(h.launch,{wallet});assert.equal(balance.quoteBalanceRaw,'1000000000000000');
    const quote=await h.chain.quotePaired(h.launch,{wallet,side:'buy',amount:'1',slippageBps:100});assert(BigInt(quote.minimumOutputRaw)>0n);
    for(const option of [{allow:0},{allow:2},{length:294},{length:296}]) {
      h.put(key,withConfidentialAccount(original,option));
      await assert.rejects(h.chain.walletBalances(h.launch,{wallet}),/does not allow ordinary token transfers/);
    }
  }
});


// Exercise the real route validator/builder with the wallet duplication used
// by Jupiter's Manifest leg. Provider and simulation results remain offline.
function useWritableWalletRoute(h,{expectedForBudget=()=>1000000n,onRequest=()=>{},extraRouteAccountsForBudget=()=>[],setupInstructionsForRequest=()=>[]}={}) {
  const jupiter=new PublicKey(JUPITER),event=PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],jupiter)[0];
  const meta=(key,isWritable=false,isSigner=false)=>({pubkey:key.toBase58(),isWritable,isSigner});
  let requests=0;const budgets=[];
  h.chain.jupiterGate={async acquire(){},cooldown(){}};
  h.chain.fetcher=async url=>{
    requests++;const query=new URL(url).searchParams,input=new PublicKey(query.get('inputMint')),output=new PublicKey(query.get('outputMint'));
    const trader=new PublicKey(query.get('taker')),amount=BigInt(query.get('amount')),slippage=Number(query.get('slippageBps')),maxAccounts=Number(query.get('maxAccounts')),expected=expectedForBudget(maxAccounts);
    budgets.push(maxAccounts);onRequest({maxAccounts,query});
    assert(trader.equals(h.trader.publicKey));assert(input.equals(NATIVE_MINT));assert(output.equals(h.q));
    const data=Buffer.alloc(39);createHash('sha256').update('global:route_v2').digest().copy(data,0,0,8);
    data.writeBigUInt64LE(amount,8);data.writeBigUInt64LE(expected,16);data.writeUInt16LE(slippage,24);data.writeUInt32LE(1,30);data[34]=3;data.writeUInt16LE(10000,35);data[38]=1;
    const accounts=[meta(trader,false,true),meta(getAssociatedTokenAddressSync(input,trader),true),meta(getAssociatedTokenAddressSync(output,trader),true),meta(input),meta(output),meta(TOKEN_PROGRAM_ID),meta(TOKEN_PROGRAM_ID),meta(jupiter),meta(event),meta(jupiter)];
    // The fixed authority remains readonly; a DEX remaining account repeats
    // the same reviewed wallet as writable at the observed index 26.
    while(accounts.length<26)accounts.push(meta(event));accounts.push(meta(trader,true));accounts.push(...extraRouteAccountsForBudget(maxAccounts).map(key=>meta(key)));
    return {ok:true,status:200,json:async()=>({inputMint:input.toBase58(),outputMint:output.toBase58(),inAmount:amount.toString(),outAmount:expected.toString(),otherAmountThreshold:(expected*BigInt(10000-slippage)/10000n).toString(),swapMode:'ExactIn',slippageBps:slippage,priceImpactPct:'0.001',routePlan:[{}],setupInstructions:setupInstructionsForRequest({input,output,trader}),swapInstruction:{programId:JUPITER,accounts,data:data.toString('base64')},cleanupInstruction:null,otherInstructions:[],tipInstruction:null,addressesByLookupTableAddress:{}})};
  };
  return {jupiter,budgets,get requests(){return requests;}};
}

test('a writable wallet in a real composed SOL route remains unsigned until the complete spend simulation passes',async()=>{
  const cases=[
    {name:'valid',change:()=>({})},
    {name:'one lamport over budget',change:q=>({extraSpend:BigInt(q.rentLamports)+1n}),message:/exceeds the reviewed SOL spend/},
    {name:'spends existing paired tokens',change:()=>({quoteDelta:-1n}),message:/existing paired-asset balance/},
    {name:'one token unit below minimum',change:q=>({baseDelta:BigInt(q.minimumOutputRaw)-1n}),message:/reviewed minimum tokens/},
  ];
  for(const scenario of cases) {
    const h=harness(),route=useWritableWalletRoute(h),wallet=h.trader.publicKey.toBase58(),events=[];
    const quote=await h.chain.quote(h.launch,{wallet,side:'buy',amount:'0.1',slippageBps:100});
    h.chain.prepare=async(selected,instructions)=>{
      events.push('prepare');assert.equal(selected.keys.wallet.address,wallet);assert.equal(selected.keys.wallet.external,true);
      const swap=instructions.find(ix=>ix.programId.equals(route.jupiter));assert(swap);assert(instructions.some(ix=>ix.programId.equals(ray.LAUNCHPAD_PROGRAM)));
      assert.equal(swap.keys[0].isWritable,false);assert.equal(swap.keys[0].isSigner,true);
      assert(swap.keys[26].pubkey.equals(h.trader.publicKey));assert.equal(swap.keys[26].isWritable,true);assert.equal(swap.keys[26].isSigner,false);
      const operation=unsignedOperation(h.trader.publicKey,instructions),tx=VersionedTransaction.deserialize(Buffer.from(operation.unsignedRaw,'base64'));
      const index=tx.message.staticAccountKeys.findIndex(key=>key.equals(h.trader.publicKey));assert.equal(index,0);assert(tx.message.isAccountWritable(index));assert(tx.message.isAccountSigner(index));
      return operation;
    };
    h.chain.simulatePrepared=async(tx,options)=>{
      events.push('simulate');assert.equal(options.sigVerify,false);assert.equal(options.accounts.addresses[0],wallet);
      assert(tx.message.compiledInstructions.some(ix=>tx.message.staticAccountKeys[ix.programIdIndex].equals(route.jupiter)));
      assert(tx.message.compiledInstructions.some(ix=>tx.message.staticAccountKeys[ix.programIdIndex].equals(ray.LAUNCHPAD_PROGRAM)));
      return simulatedBalances(h,quote,scenario.change(quote));
    };
    const pending=h.chain.prepareTrade(h.launch,quote,{external:true,authorize:async()=>{events.push('authorize');}});
    if(scenario.message) {
      await assert.rejects(pending,scenario.message,scenario.name);assert.deepEqual(events,['prepare','simulate'],scenario.name);
    }else {
      const operation=await pending;assert.equal(operation.needsSignature,true);assert.equal(operation.state,'awaiting_signature');
      assert.equal(operation.raw,undefined);assert.equal(operation.signature,undefined);assert.equal(operation.externalSigner,wallet);
      const transaction=VersionedTransaction.deserialize(Buffer.from(operation.unsignedRaw,'base64'));assert(transaction.signatures.every(signature=>signature.every(byte=>byte===0)));
      assert.deepEqual(events,['prepare','simulate','authorize']);
    }
    assert.equal(route.requests,2); // Initial review plus fresh prepare quote.
  }
});


test('an oversized atomic trade retries a smaller route with the same SOL amount and original minimum before signing',async()=>{
  const h=harness(),amounts=[],route=useWritableWalletRoute(h,{onRequest:({query})=>amounts.push(query.get('amount'))}),wallet=h.trader.publicKey.toBase58();
  const quote=await h.chain.quote(h.launch,{wallet,side:'buy',amount:'0.1',slippageBps:100}),prepared=[],events=[];
  h.chain.prepare=async(_selected,instructions)=>{
    const budget=route.budgets.at(-1);prepared.push(budget);
    if(budget===32)throw Object.assign(Error('1529 bytes'),{code:'LAUNCH_TRANSACTION_TOO_LARGE'});
    return unsignedOperation(h.trader.publicKey,instructions);
  };
  h.chain.simulatePrepared=async()=>{events.push('simulate');return simulatedBalances(h,quote);};
  const operation=await h.chain.prepareTrade(h.launch,quote,{external:true,authorize:async()=>{events.push('authorize');}});
  assert.deepEqual(route.budgets,[32,32,24]);assert.deepEqual(prepared,[32,24]);assert(amounts.every(amount=>amount==='100000000'));
  assert.deepEqual(events,['simulate','authorize']);assert.equal(operation.needsSignature,true);assert.equal(operation.raw,undefined);
  assert.equal(operation.trade.minimumOutputRaw,quote.minimumOutputRaw);assert.equal(operation.trade.amountRaw,quote.amountRaw);
});

test('oversized routes stop after four budgets and never simulate, authorize or split a trade',async()=>{
  const h=harness(),route=useWritableWalletRoute(h),wallet=h.trader.publicKey.toBase58();
  const quote=await h.chain.quote(h.launch,{wallet,side:'buy',amount:'0.1',slippageBps:100}),prepared=[];
  h.chain.prepare=async()=>{prepared.push(route.budgets.at(-1));throw Object.assign(Error('still oversized'),{code:'LAUNCH_TRANSACTION_TOO_LARGE'});};
  h.chain.simulatePrepared=()=>assert.fail('Oversized transactions must not reach simulation.');
  await assert.rejects(h.chain.prepareTrade(h.launch,quote,{external:true,authorize:()=>assert.fail('Nothing should be authorized.')}),e=>e.code==='LAUNCH_TRANSACTION_TOO_LARGE');
  assert.deepEqual(route.budgets,[32,32,24,20,16]);assert.deepEqual(prepared,[32,24,20,16]);
});

test('a smaller route cannot loosen the original output floor or increase the reviewed setup cost',async()=>{
  for(const worse of ['output','cost']) {
    const h=harness(),route=useWritableWalletRoute(h,{
      expectedForBudget:budget=>worse==='output'&&budget<32?900000n:1000000n,
      onRequest:({maxAccounts})=>{if(worse==='cost'&&maxAccounts<32)h.accounts.delete(h.ataA.toBase58());},
    }),wallet=h.trader.publicKey.toBase58();
    const quote=await h.chain.quote(h.launch,{wallet,side:'buy',amount:'0.1',slippageBps:100});let prepares=0;
    h.chain.prepare=async()=>{prepares++;throw Object.assign(Error('oversized'),{code:'LAUNCH_TRANSACTION_TOO_LARGE'});};
    h.chain.simulatePrepared=()=>assert.fail('A worse route must not be simulated for signing.');
    await assert.rejects(h.chain.prepareTrade(h.launch,quote,{external:true,authorize:()=>assert.fail('A worse route must not be authorized.')}),worse==='output'?/beyond your reviewed minimum/:/setup cost increased/);
    assert.equal(prepares,1);assert.deepEqual(route.budgets,[32,32,24]);
  }
});

test('smaller-route fallback never retries unrelated preparation failures or native SOL pairs',async()=>{
  for(const native of [false,true]) {
    const h=harness({native}),route=native?null:useWritableWalletRoute(h),wallet=h.trader.publicKey.toBase58();
    if(native)h.chain.tradeRoutes={quoteConversion:()=>assert.fail('Native pairs need no conversion.')};
    const quote=await h.chain.quote(h.launch,{wallet,side:'buy',amount:'0.1',slippageBps:100});let prepares=0;
    const error=Object.assign(Error(native?'Native packet too large':'RPC unavailable'),native?{code:'LAUNCH_TRANSACTION_TOO_LARGE'}:{});
    h.chain.prepare=async()=>{prepares++;throw error;};
    await assert.rejects(h.chain.prepareTrade(h.launch,quote,{external:true}),e=>e===error);assert.equal(prepares,1);
    if(route)assert.deepEqual(route.budgets,[32,32]);
  }
});


test('quote preflight selects a fitting smaller route and publishes its price before establishing the immutable minimum',async()=>{
  const h=harness(),extra=Array.from({length:16},()=>Keypair.generate().publicKey),route=useWritableWalletRoute(h,{
    expectedForBudget:budget=>budget===32?1000000n:992800n,
    extraRouteAccountsForBudget:budget=>budget===32?extra:[],
  }),wallet=h.trader.publicKey.toBase58(),sizes=[];
  const walletMessage=h.chain.walletMessage.bind(h.chain);
  h.chain.walletMessage=async(...args)=>{
    try{const message=await walletMessage(...args);sizes.push({budget:route.budgets.at(-1),bytes:transactionSize(message)});return message;}
    catch(error){sizes.push({budget:route.budgets.at(-1),bytes:error.transactionBytes});throw error;}
  };
  h.chain.prepare=()=>assert.fail('A quote must never prepare or sign a transaction.');
  h.chain.simulatePrepared=()=>assert.fail('A quote must never simulate a transaction.');
  const quote=await h.chain.quote(h.launch,{wallet,side:'buy',amount:'0.1',slippageBps:100});
  assert.deepEqual(route.budgets,[32,24]);assert(sizes[0].bytes>1232);assert(sizes[1].bytes<=1232);
  const largeRoutePrice=await h.chain.quotePaired(h.launch,{wallet,side:'buy',amount:'0.995',slippageBps:50});
  assert(BigInt(quote.expectedOutputRaw)<BigInt(largeRoutePrice.expectedOutputRaw));
  assert(BigInt(quote.minimumOutputRaw)<BigInt(largeRoutePrice.minimumOutputRaw));
  assert.equal(quote.amountRaw,'100000000');assert.equal(quote.slippageBps,100);
  let simulations=0,authorizations=0;
  h.chain.prepare=async(_launch,instructions)=>unsignedOperation(h.trader.publicKey,instructions);
  h.chain.simulatePrepared=async()=>{simulations++;return simulatedBalances(h,quote);};
  const operation=await h.chain.prepareTrade(h.launch,quote,{external:true,authorize:async()=>{authorizations++;}});
  assert.deepEqual(route.budgets,[32,24,24]);assert.equal(simulations,1);assert.equal(authorizations,1);
  assert.equal(operation.trade.minimumOutputRaw,quote.minimumOutputRaw);assert.equal(operation.trade.amountRaw,quote.amountRaw);assert.equal(operation.needsSignature,true);
});

test('the minimum from a size-selected quote still rejects a worse subsequent price without returning to the oversized route',async()=>{
  const h=harness(),extra=Array.from({length:16},()=>Keypair.generate().publicKey);let selectedPrice=992800n;
  const route=useWritableWalletRoute(h,{expectedForBudget:budget=>budget===32?1000000n:selectedPrice,extraRouteAccountsForBudget:budget=>budget===32?extra:[]}),wallet=h.trader.publicKey.toBase58();
  const quote=await h.chain.quote(h.launch,{wallet,side:'buy',amount:'0.1',slippageBps:100});selectedPrice=900000n;
  h.chain.prepare=()=>assert.fail('A worse price must not reach preparation.');
  await assert.rejects(h.chain.prepareTrade(h.launch,quote,{external:true,authorize:()=>assert.fail('A worse price must not be authorized.')}),/beyond your reviewed minimum/);
  assert.deepEqual(route.budgets,[32,24,24]);
});

test('quote packet preflight is bounded and does not retry non-size validation errors',async()=>{
  const h=harness(),extra=Array.from({length:16},()=>Keypair.generate().publicKey),route=useWritableWalletRoute(h,{extraRouteAccountsForBudget:()=>extra});
  h.chain.prepare=()=>assert.fail('Quotes must not prepare transactions.');h.chain.simulatePrepared=()=>assert.fail('Quotes must not simulate transactions.');
  await assert.rejects(h.chain.quote(h.launch,{wallet:h.trader.publicKey.toBase58(),side:'buy',amount:'0.1',slippageBps:100}),error=>error.code==='LAUNCH_TRANSACTION_TOO_LARGE');
  assert.deepEqual(route.budgets,[32,24,20,16]);
  const other=harness(),otherRoute=useWritableWalletRoute(other),failure=Error('Lookup table validation failed.');other.chain.walletMessage=async()=>{throw failure;};
  await assert.rejects(other.chain.quote(other.launch,{wallet:other.trader.publicKey.toBase58(),side:'buy',amount:'0.1',slippageBps:100}),error=>error===failure);
  assert.deepEqual(otherRoute.budgets,[32]);
});

test('a recent fitting budget avoids oversized retries but every request gets a fresh quote and expired hints reset',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const h=harness(),extra=Array.from({length:16},()=>Keypair.generate().publicKey);let price=1000000n;
  const route=useWritableWalletRoute(h,{expectedForBudget:()=>price,extraRouteAccountsForBudget:budget=>budget===32?extra:[]});
  const request={wallet:h.trader.publicKey.toBase58(),side:'buy',amount:'0.1',slippageBps:100};
  const first=await h.chain.quote(h.launch,request);assert.deepEqual(route.budgets,[32,24]);
  price=900000n;const second=await h.chain.quote(h.launch,request);
  assert.deepEqual(route.budgets,[32,24,24]);assert(BigInt(second.minimumOutputRaw)<BigInt(first.minimumOutputRaw));
  now+=120001;await h.chain.quote(h.launch,request);assert.deepEqual(route.budgets,[32,24,24,32,24]);
});

test('a provider rate limit stops fallback immediately and a new action resumes at the next size budget',async()=>{
  const h=harness(),extra=Array.from({length:16},()=>Keypair.generate().publicKey),route=useWritableWalletRoute(h,{extraRouteAccountsForBudget:budget=>budget===32?extra:[]});
  const fetcher=h.chain.fetcher;let limited=true;
  h.chain.fetcher=async url=>{const response=await fetcher(url);return limited&&new URL(url).searchParams.get('maxAccounts')==='24'?{ok:false,status:429,headers:{get:()=>null},json:async()=>({})}:response;};
  const request={wallet:h.trader.publicKey.toBase58(),side:'buy',amount:'0.1',slippageBps:100};
  await assert.rejects(h.chain.quote(h.launch,request),error=>error.code==='SOL_ROUTE_RATE_LIMITED');
  assert.deepEqual(route.budgets,[32,24]);limited=false;
  await h.chain.quote(h.launch,request);assert.deepEqual(route.budgets,[32,24,24]);
});

test('unavailable smaller routes retain the packet error and an unavailable cached budget can recover',async()=>{
  const h=harness(),extra=Array.from({length:16},()=>Keypair.generate().publicKey),route=useWritableWalletRoute(h,{extraRouteAccountsForBudget:budget=>budget===32?extra:[]});
  const fetcher=h.chain.fetcher;let missing=new Set([24,20,16]);
  h.chain.fetcher=async url=>{const response=await fetcher(url);return missing.has(Number(new URL(url).searchParams.get('maxAccounts')))?{ok:false,status:400,json:async()=>({errorCode:'COULD_NOT_FIND_ANY_ROUTE'})}:response;};
  const request={wallet:h.trader.publicKey.toBase58(),side:'buy',amount:'0.1',slippageBps:100};
  await assert.rejects(h.chain.quote(h.launch,request),error=>error.code==='LAUNCH_TRANSACTION_TOO_LARGE'&&error.transactionBytes>1232);
  assert.deepEqual(route.budgets,[32,24,20,16]);
  missing=new Set([24]);await h.chain.quote(h.launch,request);
  assert.deepEqual(route.budgets,[32,24,20,16,24,32,20]);
});


test('quote and preparation remove only byte-identical idempotent ATA creation duplicates',async()=>{
  const h=harness(),wire=ix=>({programId:ix.programId.toBase58(),data:ix.data.toString('base64'),accounts:ix.keys.map(meta=>({...meta,pubkey:meta.pubkey.toBase58()}))});
  useWritableWalletRoute(h,{setupInstructionsForRequest:()=>[wire(createAssociatedTokenAccountIdempotentInstruction(h.trader.publicKey,h.ataB,h.trader.publicKey,h.q))]});
  h.accounts.delete(h.ataB.toBase58());
  const tradeInstructions=h.chain.tradeInstructions.bind(h.chain);
  h.chain.tradeInstructions=async(...args)=>{
    const instructions=await tradeInstructions(...args),differentFlags=createAssociatedTokenAccountIdempotentInstruction(h.trader.publicKey,h.ataB,h.trader.publicKey,h.q);
    differentFlags.keys[0].isWritable=false;
    const transfer=SystemProgram.transfer({fromPubkey:h.trader.publicKey,toPubkey:h.trader.publicKey,lamports:0});
    return [...instructions,differentFlags,transfer,transfer];
  };
  const inspect=instructions=>{
    const creations=instructions.filter(ix=>ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)&&ix.keys[1].pubkey.equals(h.ataB));
    assert.equal(creations.length,2);assert.equal(creations.filter(ix=>ix.keys[0].isWritable).length,1);
    const transfers=instructions.filter(ix=>ix.programId.equals(SystemProgram.programId)&&ix.data.readUInt32LE(0)===2);
    assert.equal(transfers.length,2);
  };
  let preflights=0;const walletMessage=h.chain.walletMessage.bind(h.chain);
  h.chain.walletMessage=async(payer,blockhash,instructions,...rest)=>{preflights++;inspect(instructions);return walletMessage(payer,blockhash,instructions,...rest);};
  const quote=await h.chain.quote(h.launch,{wallet:h.trader.publicKey.toBase58(),side:'buy',amount:'0.1',slippageBps:100});
  assert.equal(preflights,1);h.chain.prepare=async(_launch,instructions)=>{inspect(instructions);return unsignedOperation(h.trader.publicKey,instructions);};
  h.chain.simulatePrepared=async()=>simulatedBalances(h,quote);
  const operation=await h.chain.prepareTrade(h.launch,quote,{external:true});assert.equal(operation.needsSignature,true);
});


for(const graduated of [false,true])for(const side of ['buy','sell'])test(`${graduated?'CPMM':'curve'} ${side} encodes full custom slippage without changing input or signer`,async()=>{
  const h=harness({native:true,graduated}),wallet=h.trader.publicKey.toBase58();
  for(const slippageBps of [0,1,2537,10000]){
    const q=await h.chain.quote(h.launch,{wallet,side,amount:side==='buy'?'0.01':'100',slippageBps});
    const expected=BigInt(q.expectedOutputRaw),minimum=expected*BigInt(10000-slippageBps)/10000n;
    assert.equal(q.minimumOutputRaw,minimum.toString());assert.equal(q.slippageBps,slippageBps);assert(expected>0n);
    const instructions=await h.chain.tradeInstructions(q),swap=instructions.find(ix=>ix.programId.equals(graduated?ray.CREATE_CPMM_POOL_PROGRAM:ray.LAUNCHPAD_PROGRAM));
    assert.equal(swap.data.readBigUInt64LE(8),BigInt(q.amountRaw));assert.equal(swap.data.readBigUInt64LE(16),minimum);assert(swap.keys.filter(key=>key.isSigner).every(key=>key.pubkey.equals(h.trader.publicKey)));
  }
});
for(const side of ['buy','sell'])test(`composed SOL ${side} keeps its intermediate funded at100 percent and final minimum zero`,async()=>{
  const h=harness(),calls=stubRoutes(h.chain),original=h.chain.tradeRoutes.quoteConversion;
  h.chain.tradeRoutes.quoteConversion=async(chain,args)=>{const q=await original(chain,args);return {...q,minimumRaw:(BigInt(q.expectedRaw)*BigInt(10000-args.slippageBps)/10000n).toString()};};
  const q=await h.chain.quote(h.launch,{wallet:h.trader.publicKey.toBase58(),side,amount:side==='buy'?'0.1':'100',slippageBps:10000});
  assert.equal(q.slippageBps,10000);assert.equal(q.minimumOutputRaw,'0');assert(BigInt(q.expectedOutputRaw)>0n);assert.equal(calls[0].slippageBps,side==='buy'?5000:10000);assert(BigInt(calls[0].amountRaw)>0n);
  let instructions;h.chain.prepare=async(_launch,ixs)=>{instructions=ixs;return {needsSignature:true};};h.chain.verifyTradeSimulation=async()=>{};
  await h.chain.prepareTrade(h.launch,q,{external:true});const swap=instructions.find(ix=>ix.programId.equals(ray.LAUNCHPAD_PROGRAM));
  assert(swap.data.readBigUInt64LE(8)>0n);if(side==='buy')assert.equal(swap.data.readBigUInt64LE(16),0n);else assert(swap.data.readBigUInt64LE(16)>0n);
});
test('zero-minimum buy still rejects spending another wallet token or exceeding the entered SOL budget',async()=>{
  const h=harness({native:true}),q=await h.chain.quote(h.launch,{wallet:h.trader.publicKey.toBase58(),side:'buy',amount:'0.1',slippageBps:10000}),operation=unsignedOperation(h.trader.publicKey);
  for(const [change,error] of [[{quoteDelta:-1n},/existing paired/],[{extraSpend:1000000000n},/reviewed SOL/]]){
    h.chain.simulatePrepared=async()=>simulatedBalances(h,q,change);await assert.rejects(h.chain.verifyTradeSimulation(q,operation,[]),error);
  }
});

test('zero-minimum sell still enforces the exact token input and preserves pre-existing paired holdings',async()=>{
  const h=harness({native:true}),q=await h.chain.quote(h.launch,{wallet:h.trader.publicKey.toBase58(),side:'sell',amount:'100',slippageBps:10000}),operation=unsignedOperation(h.trader.publicKey);
  h.chain.simulatePrepared=async()=>simulatedBalances(h,q);await h.chain.verifyTradeSimulation(q,operation,[]);
  for(const [change,error] of [[{quoteDelta:-1n},/existing paired/],[{baseDelta:-BigInt(q.amountRaw)-1n},/different token amount/],[{extraSpend:1000000000n},/minimum SOL/]]){
    h.chain.simulatePrepared=async()=>simulatedBalances(h,q,change);await assert.rejects(h.chain.verifyTradeSimulation(q,operation,[]),error);
  }
});
