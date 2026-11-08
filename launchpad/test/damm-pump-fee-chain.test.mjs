import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, AddressLookupTableAccount, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, MintLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { DammPumpFeeClientAdapter, verifyDammPumpGraduationFee } from '../src/damm-pump-fee-chain.mjs';
import { DammPumpTestClientAdapter } from '../src/damm-pump-test-chain.mjs';
import { DAMM_PUMP_FEE_DEPLOYMENT_POLICY as F } from '../src/damm-pump-fee-deployment.mjs';
import { dammPumpFeeCurveAtGraduationTarget } from '../src/damm-pump-fee-policy.mjs';
import * as legacy from '../src/damm-pump-client.mjs';
import * as client from '../src/damm-pump-admin-test-client.mjs';

const key=()=>Keypair.generate().publicKey,str=x=>x.toBase58();
function receiptFixture({native=false,token2022=false}={}){
  const quoteMint=native?NATIVE_MINT:key(),quoteTokenProgram=token2022?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,quoteDecimals=native?9:6,quoteUsdMicros=native?'100000000':'1000000';
  const model=dammPumpFeeCurveAtGraduationTarget({quoteDecimals,quoteUsdMicros}),a=client.feeAddresses({programId:F.programId,mint:key(),quoteMint,quoteTokenProgram,poolIndex:7});
  const state={phase:2,pool:str(a.pool),poolIndex:7,expectedQuote:model.finalQuote,graduationFeePaidRaw:model.graduationFeeRaw,quoteMigrated:model.migrationQuoteRaw,baseMigrated:model.baseReserved,burnedLp:'123'};
  const keys=[a.baseAta,a.quoteAta,a.treasuryQuote,a.poolBase,a.poolQuote,a.authorityLp];
  const row=(index,mint,owner,amount)=>({accountIndex:index,mint:str(mint),owner:str(owner),uiTokenAmount:{amount:String(amount),decimals:index===0||index===3?6:quoteDecimals}});
  const transfer=(source,destination,program,amount)=>({programId:program,parsed:{type:'transferChecked',info:{source:str(source),destination:str(destination),authority:str(a.authority),mint:str(source.equals(a.baseAta)?a.mint:a.quoteMint),tokenAmount:{amount:String(amount),decimals:source.equals(a.baseAta)?6:quoteDecimals}}}});
  const receipt={slot:100,transaction:{message:{accountKeys:keys.map(pubkey=>({pubkey})),instructions:[]}},meta:{err:null,preBalances:keys.map(()=>5000000),postBalances:keys.map(()=>5000000),preTokenBalances:[row(0,a.mint,a.authority,BigInt(model.baseReserved)+3n),row(1,a.quoteMint,a.authority,7),row(2,a.quoteMint,a.treasury,11)],postTokenBalances:[row(0,a.mint,a.authority,3),row(1,a.quoteMint,a.authority,7),row(2,a.quoteMint,a.treasury,11n+BigInt(model.graduationFeeRaw)),row(3,a.mint,a.pool,model.baseReserved),row(4,a.quoteMint,a.pool,model.migrationQuoteRaw),row(5,a.lpMint,a.authority,0)],innerInstructions:[{index:0,instructions:[transfer(a.quoteAta,a.treasuryQuote,a.quoteTokenProgram,model.graduationFeeRaw),transfer(a.quoteAta,a.poolQuote,a.quoteTokenProgram,model.migrationQuoteRaw),transfer(a.baseAta,a.poolBase,TOKEN_PROGRAM_ID,model.baseReserved)]}]} };
  return {model,a,state,receipt,verify:()=>verifyDammPumpGraduationFee(receipt,state,a,model,'signature')};
}

test('new fee controller terms and math are selected only by its pinned program, leaving legacy economics unchanged',()=>{
  const adapter=new DammPumpFeeClientAdapter({connection:{}}),launch={quoteDecimals:6,priceSnapshot:{quoteUsdMicros:'1000000'},publicProgramId:F.programId},newModel=adapter.model(launch),oldModel=adapter.model({...launch,publicProgramId:legacy.PUBLIC_PROGRAM_ID});
  assert.equal(adapter.supportsNewLaunch({programId:F.programId}),true);assert.equal(adapter.supportsNewLaunch({programId:legacy.PUBLIC_PROGRAM_ID}),false);assert.equal(adapter.launchTerms({programId:legacy.PUBLIC_PROGRAM_ID}).defaults.graduationFeeBps,0);assert.equal(adapter.launchTerms({programId:F.programId}).defaults.graduationFeeNumerator,'322369073');assert.equal(oldModel.graduationFeeRaw,'0');assert(BigInt(newModel.graduationFeeRaw)>0n);assert.equal(newModel.finalQuote,(BigInt(newModel.migrationQuoteRaw)+BigInt(newModel.graduationFeeRaw)).toString());assert.equal(newModel.supply,oldModel.supply);
});

test('fee migration appends only the fixed treasury and its canonical quote ATA to the legacy ABI',()=>{
  for(const quoteTokenProgram of [TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID]){
    const args={programId:F.programId,payer:key(),mint:key(),quoteMint:key(),quoteTokenProgram,poolIndex:37},old=legacy.migrateIx(args),fee=client.migrateIx(args),a=client.feeAddresses(args);assert.equal(old.keys.length,29);assert.equal(fee.keys.length,31);assert.deepEqual(fee.keys.slice(0,29),old.keys);assert.deepEqual(fee.data,old.data);assert.equal(str(fee.keys[29].pubkey),legacy.PUBLIC_TREASURY);assert.deepEqual(fee.keys[30],{pubkey:a.treasuryQuote,isWritable:true,isSigner:false});assert.equal(fee.keys.filter(k=>k.isSigner).length,1);
  }
});

test('exact treasury fee, post-fee LP deposits, unchanged unrelated custody and price continuity are proven for classic and Token-2022 quotes',()=>{
  for(const options of [{},{token2022:true},{native:true}]){
    const f=receiptFixture(options),proof=f.verify();assert.equal(proof.graduationFee.verified,true);assert.equal(proof.graduationFee.amountRaw,f.model.graduationFeeRaw);assert.equal(proof.graduationFee.recipient,legacy.PUBLIC_TREASURY);assert.equal(proof.graduationFee.signature,'signature');assert.equal(proof.poolQuoteRaw,f.model.migrationQuoteRaw);assert.equal(proof.poolBaseRaw,f.model.baseReserved);assert.equal(proof.retainedPrincipalBaseRaw,'0');assert.equal(proof.retainedPrincipalQuoteRaw,'0');assert.equal(proof.unrelatedCustodyBaseRaw,'3');assert.equal(proof.unrelatedCustodyQuoteRaw,'7');assert.equal(proof.priceContinuityVerified,true);assert.deepEqual(f.verify(),proof,'Re-reading a receipt verifies the same payment; it cannot issue another fee');
  }
});

test('underpayment, duplicate fee, wrong treasury, incorrect pool deposits, retained principal and base-supply changes fail closed',()=>{
  const cases=[
    f=>f.receipt.meta.innerInstructions[0].instructions[0].parsed.info.tokenAmount.amount='1',
    f=>{const ix=f.receipt.meta.innerInstructions[0].instructions[0];f.receipt.meta.innerInstructions[0].instructions.push({...ix,parsed:structuredClone(ix.parsed)});},
    f=>f.receipt.meta.innerInstructions[0].instructions[0].parsed.info.destination=str(key()),
    f=>f.receipt.meta.innerInstructions[0].instructions[0].parsed.info.authority=str(key()),
    f=>f.receipt.meta.postTokenBalances[2].uiTokenAmount.amount='11',
    f=>f.receipt.meta.postTokenBalances[4].uiTokenAmount.amount='1',
    f=>f.receipt.meta.postTokenBalances[0].uiTokenAmount.amount='4',
    f=>f.receipt.meta.postTokenBalances[1].uiTokenAmount.amount='8',
    f=>f.receipt.meta.innerInstructions[0].instructions.push({programId:TOKEN_PROGRAM_ID,parsed:{type:'burn',info:{mint:str(f.a.mint),amount:'1'}}}),
    f=>f.state.graduationFeePaidRaw='0',
    f=>f.state.quoteMigrated=f.state.expectedQuote,
  ];
  for(const mutate of cases){const f=receiptFixture();mutate(f);assert.throws(f.verify,/migration|treasury|pool|custody/i);}
});

test('native unsynced SOL donations are accepted only with their exact sync instruction and unchanged custody lamports',()=>{
  const f=receiptFixture({native:true});f.receipt.meta.postTokenBalances[1].uiTokenAmount.amount='17';f.receipt.meta.innerInstructions[0].instructions.unshift({programId:TOKEN_PROGRAM_ID,parsed:{type:'syncNative',info:{account:str(f.a.quoteAta)}}});const proof=f.verify();assert.equal(proof.syncedQuoteDonationRaw,'10');assert.equal(proof.unrelatedCustodyQuoteRaw,'17');assert.equal(proof.retainedPrincipalQuoteRaw,'0');
  f.receipt.meta.postBalances[1]++;assert.throws(f.verify,/unchanged-lamport/);f.receipt.meta.postBalances[1]--;f.receipt.meta.innerInstructions[0].instructions.shift();assert.throws(f.verify,/sync receipt/);
  const nonNative=receiptFixture();nonNative.receipt.meta.postTokenBalances[1].uiTokenAmount.amount='17';nonNative.receipt.meta.innerInstructions[0].instructions.unshift({programId:TOKEN_PROGRAM_ID,parsed:{type:'syncNative',info:{account:str(nonNative.a.quoteAta)}}});assert.throws(nonNative.verify,/retained principal/);
});

test('real serialized fee migrations fit Solana packets with existing frozen launch lookup tables and one signer',async()=>{
  for(const [Adapter,programId] of [[DammPumpFeeClientAdapter,F.programId],[DammPumpTestClientAdapter,key().toBase58()]])for(const quoteTokenProgram of [TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID]){
    const creator=key(),relayer=key(),mint=key(),quoteMint=key(),config={programId,relayer:str(relayer)},connection={};const adapter=new Adapter({connection,deploymentVerifier:async()=>({chainEnabled:true}),venueVerifier:async()=>({})}),launch={mint:str(mint),creatorWallet:str(creator),publicProgramId:programId,quoteMint:str(quoteMint),quoteTokenProgram:str(quoteTokenProgram),quoteDecimals:6,priceSnapshot:{quoteUsdMicros:'1000000'}};
    const addresses=await adapter.lookupAddresses(config,launch),table=new AddressLookupTableAccount({key:key(),state:{deactivationSlot:18446744073709551615n,lastExtendedSlot:90,lastExtendedSlotStartIndex:0,authority:undefined,addresses}});launch.lookupTables=[{address:str(table.key),addresses:addresses.map(str)}];connection.getAddressLookupTable=async()=>({context:{slot:100},value:table});
    const instruction=client.migrateIx({...config,payer:relayer,mint,quoteMint,quoteTokenProgram,poolIndex:37}),tx=await adapter.buildTransaction(config,launch,str(relayer),[instruction],'migrate',{blockhash:str(key()),lastValidBlockHeight:500});assert(tx.serialize().length<=1232);assert.equal(tx.message.header.numRequiredSignatures,1);assert.equal(tx.message.compiledInstructions.at(-1).accountKeyIndexes.length,31);assert.equal(VersionedTransaction.deserialize(tx.serialize()).message.staticAccountKeys[0].toBase58(),str(relayer));
  }
});

test('fee migration preparation requires the relayer and an unmigrated endpoint, and never prepares a second fee',async()=>{
  const relayer=key(),creator=key(),mint=key(),config={programId:F.programId,relayer:str(relayer)},launch={mint:str(mint),creatorWallet:str(creator),publicProgramId:F.programId,quoteMint:str(NATIVE_MINT),quoteTokenProgram:str(TOKEN_PROGRAM_ID),quoteDecimals:9,quoteSymbol:'SOL',priceSnapshot:{quoteUsdMicros:'100000000'}};let simulations=0;
  const connection={getSlot:async()=>100,getLatestBlockhash:async()=>({blockhash:str(key()),lastValidBlockHeight:500}),getFeeForMessage:async()=>({value:5000}),getBalance:async()=>1000000000,simulateTransaction:async tx=>{simulations++;assert.equal(tx.message.compiledInstructions.at(-1).accountKeyIndexes.length,31);return {context:{slot:101},value:{err:null,accounts:[{lamports:970000000}]}}}};
  const adapter=new DammPumpFeeClientAdapter({connection,deploymentVerifier:async()=>({chainEnabled:true}),venueVerifier:async()=>({})}),model=adapter.model(launch),state={phase:0,sqrtMaxPrice:model.sqrtMaxPrice};adapter.verifyQuote=async()=>({ready:true});adapter.dammSnapshot=async()=>({state,pool:{sqrtPrice:model.sqrtMaxPrice}});adapter.cleanPool=async()=>({index:7});
  const addresses=await adapter.lookupAddresses(config,launch),table=new AddressLookupTableAccount({key:key(),state:{deactivationSlot:18446744073709551615n,lastExtendedSlot:90,lastExtendedSlotStartIndex:0,authority:undefined,addresses}});launch.lookupTables=[{address:str(table.key),addresses:addresses.map(str)}];connection.getAddressLookupTable=async()=>({context:{slot:100},value:table});
  await assert.rejects(adapter.prepare(config,{action:'migrate',wallet:str(creator),relayer:str(relayer),launch}),/Only the managed graduation relayer/);assert.equal(simulations,0);
  const review=await adapter.prepare(config,{action:'migrate',wallet:str(relayer),relayer:str(relayer),launch});assert.equal(review.needsRelayer,false);assert.equal(review.preparedAtSlot,100);assert.equal(review.review.graduationFeeRaw,model.graduationFeeRaw);assert.equal(review.review.estimatedGraduationFeeRaw,model.graduationFeeRaw);assert.equal(review.review.estimatedGrossQuoteRaw,model.finalQuote);assert.equal(review.review.estimatedLpQuoteRaw,model.migrationQuoteRaw);assert.equal(simulations,1);assert.equal(Buffer.from(review.unsignedTransaction,'base64').length<=1232,true);
  state.phase=2;await assert.rejects(adapter.prepare(config,{action:'migrate',wallet:str(relayer),relayer:str(relayer),launch}),/graduation endpoint/);assert.equal(simulations,1,'A finalized fee cannot become another reviewed migration');
});

test('canonical treasury final-buyer quote debit is proven separately from the fee credit',()=>{
 const f=receiptFixture(),trade={side:'buy',venue:'damm-v2',quoteAccount:str(f.a.treasuryQuote),input:'10'},debit={programId:f.a.quoteTokenProgram,parsed:{type:'transferChecked',info:{source:str(f.a.treasuryQuote),destination:str(f.a.dammQuoteVault),authority:client.PUBLIC_TREASURY,mint:str(f.a.quoteMint),tokenAmount:{amount:'7',decimals:6}}}};
 f.receipt.meta.innerInstructions[0].instructions.unshift(debit);f.receipt.meta.postTokenBalances[2].uiTokenAmount.amount=String(11n+BigInt(f.model.graduationFeeRaw)-7n);
 const verify=()=>verifyDammPumpGraduationFee(f.receipt,f.state,f.a,f.model,'signature',{atomicTrade:{wallet:client.PUBLIC_TREASURY,trade}});assert.equal(verify().graduationFee.amountRaw,f.model.graduationFeeRaw);
 assert.throws(f.verify,/exactly the graduation fee/);debit.parsed.info.tokenAmount.amount='8';assert.throws(verify,/exactly the graduation fee/);debit.parsed.info.tokenAmount.amount='7';debit.parsed.info.authority=str(key());assert.throws(verify,/DAMM debit proof/);
});

test('atomic buy reconciliation requires finalized exact wire, buy output, fee payment and full LP burn together',async()=>{
 for(const treasury of [false,true]){
  const f=receiptFixture(),buyer=treasury?new PublicKey(client.PUBLIC_TREASURY):key(),userBase=getAssociatedTokenAddressSync(f.a.mint,buyer),userQuote=getAssociatedTokenAddressSync(f.a.quoteMint,buyer),config={programId:F.programId},launch={mint:str(f.a.mint),creatorWallet:str(key()),publicProgramId:F.programId,quoteMint:str(f.a.quoteMint),quoteTokenProgram:str(f.a.quoteTokenProgram),quoteDecimals:6,priceSnapshot:{quoteUsdMicros:'1000000'}};
  const trade={side:'buy',input:'10',charged:'7',output:'100',minimum:'90',venue:'damm-v2',quoteAccount:str(userQuote),nextSqrtPrice:f.model.sqrtMaxPrice,reachesGraduation:true},op={action:'buy',wallet:str(buyer),signature:'signature',signedTransaction:'exact-signed-wire',bundle:{atomicGraduation:true,poolIndex:7,trade}};
  const rows=f.receipt.meta.innerInstructions[0].instructions;
  rows.push({programId:TOKEN_2022_PROGRAM_ID,parsed:{type:'mintTo',info:{mint:str(f.a.lpMint),account:str(f.a.authorityLp),mintAuthority:str(f.a.pool),amount:'123'}}},{programId:TOKEN_2022_PROGRAM_ID,parsed:{type:'burn',info:{mint:str(f.a.lpMint),account:str(f.a.authorityLp),authority:str(f.a.authority),amount:'123'}}});
  const keys=f.receipt.transaction.message.accountKeys;keys.push({pubkey:userBase});f.receipt.meta.postTokenBalances.push({accountIndex:6,mint:str(f.a.mint),owner:str(buyer),uiTokenAmount:{amount:'100',decimals:6}});
  if(treasury)f.receipt.meta.postTokenBalances[2].uiTokenAmount.amount=String(11n+BigInt(f.model.graduationFeeRaw)-7n);
  else{keys.push({pubkey:userQuote});f.receipt.meta.preTokenBalances.push({accountIndex:7,mint:str(f.a.quoteMint),owner:str(buyer),uiTokenAmount:{amount:'1000',decimals:6}});f.receipt.meta.postTokenBalances.push({accountIndex:7,mint:str(f.a.quoteMint),owner:str(buyer),uiTokenAmount:{amount:'993',decimals:6}});}
  rows.unshift({programId:f.a.quoteTokenProgram,parsed:{type:'transferChecked',info:{source:str(userQuote),destination:str(f.a.dammQuoteVault),authority:str(buyer),mint:str(f.a.quoteMint),tokenAmount:{amount:'7',decimals:6}}}});
  const mintData=Buffer.alloc(82);MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1000000000000000n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},mintData);
  const connection={getSignatureStatuses:async()=>({value:[{confirmationStatus:'finalized',err:null}]}),_rpcRequest:async()=>({result:{meta:{err:null},transaction:['exact-signed-wire','base64']}}),getParsedTransaction:async()=>f.receipt,getAccountInfo:async()=>({owner:TOKEN_PROGRAM_ID,data:mintData,executable:false})},adapter=new DammPumpFeeClientAdapter({connection});
  adapter.rawState=async()=>({state:f.state,addresses:f.a,slot:100});adapter.pumpSnapshot=async()=>({addresses:f.a});adapter.read=async()=>({value:{data:Buffer.alloc(1)}});adapter.cp._program.coder.accounts.decode=()=>({unlockedLiquidity:'0',vestedLiquidity:'0',permanentLockedLiquidity:'0'});
  const result=await adapter.reconcile(config,op,launch);assert.equal(result.phase,'migrated');assert.equal(result.trade.quoteRaw,'7');assert.equal(result.trade.amountRaw,'100');assert.equal(result.graduationFee.verified,true);assert.equal(result.graduationFee.amountRaw,f.model.graduationFeeRaw);assert.equal(result.burnedLpAtoms,'123');assert.equal(result.retainedLpAtoms,'0');assert.equal(result.poolId,str(f.a.pool));assert.equal(result.signature,op.signature);
  assert.deepEqual(await adapter.reconcile(config,op,launch),result,'Same receipt cannot create another payment');
  rows.find(ix=>ix.parsed.type==='burn').parsed.info.amount='122';await assert.rejects(adapter.reconcile(config,op,launch),/LP burn/);rows.find(ix=>ix.parsed.type==='burn').parsed.info.amount='123';
  const payment=rows.find(ix=>ix.parsed.info.destination===str(f.a.treasuryQuote));payment.parsed.info.tokenAmount.amount='1';await assert.rejects(adapter.reconcile(config,op,launch),/exact treasury fee/);payment.parsed.info.tokenAmount.amount=f.model.graduationFeeRaw;
  connection.getSignatureStatuses=async()=>({value:[{confirmationStatus:'confirmed',err:null}]});connection.getBlockHeight=async()=>20;op.bundle.blockhash={lastValidBlockHeight:500};assert.equal((await adapter.reconcile(config,op,launch)).state,'pending');
 }
});
