import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey,SystemProgram,SystemInstruction} from '@solana/web3.js';
import {AccountLayout,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,TransferFeeConfigLayout,ExtensionType,getAssociatedTokenAddressSync,decodeTransferCheckedInstruction} from '@solana/spl-token';
import {LaunchChain,newLaunchKeys,ray} from '../src/launchpad-chain.mjs';
import {receiptDeltas,rewardHandoffReceipt} from '../src/launchpad-receipts.mjs';
import {SOL_MINT,USDC_MINT} from '../public/launchpad-model.mjs';
import {provisionRewardsWallet,rewardsWalletSelection,rewardHandoffPlan} from '../src/launchpad-rewards-wallet.mjs';
import {verifySignedTransaction} from '../src/providers.mjs';

const pk=value=>new PublicKey(value),address=()=>Keypair.generate().publicKey.toBase58();
function launch(quoteMint=USDC_MINT){
  return {id:'a'.repeat(32),feeCustody:'relay',keys:{...newLaunchKeys(),rewards:newLaunchKeys().wallet,payer:newLaunchKeys().wallet},input:{route:'raydium',network:'mainnet-beta',quoteMint,feeMode:'holders',taxBps:100},review:{quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals:quoteMint===SOL_MINT?9:6},credits:{base:'20000',quote:'30000'}};
}
function token(mint,owner,amount,program=TOKEN_PROGRAM_ID){
  const data=Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({mint:pk(mint),owner:pk(owner),amount:BigInt(amount),delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);
  return {owner:program,data,lamports:2039280,executable:false};
}
function chain(connection={}){
  return new LaunchChain({network:'mainnet-beta',connection:{getMinimumBalanceForRentExemption:async()=>2039280,getMultipleAccountsInfoAndContext:async keys=>({context:{slot:41},value:keys.map(()=>({owner:SystemProgram.programId,data:Buffer.alloc(0),lamports:3000000,executable:false}))}),getLatestBlockhash:async()=>({blockhash:address(),lastValidBlockHeight:100}),simulateTransaction:async()=>({context:{slot:42},value:{err:null,unitsConsumed:10000}}),...connection}});
}

test('holder inventory excludes both retained creator inventory and dedicated rewards inventory',async()=>{
  const l=launch(),holder=address(),c=chain({getProgramAccounts:async()=>({context:{slot:100},value:[l.keys.wallet.address,l.keys.rewards.address,holder].map((owner,i)=>({pubkey:pk(address()),account:token(l.keys.mint.address,owner,BigInt(i+1))}))})});
  c.mintInfo=async()=>({program:TOKEN_PROGRAM_ID,mint:{decimals:6}});
  assert.deepEqual(await c.holderSnapshot(l),{slot:100,rows:[{owner:holder,amount:'3'}]});
  assert.equal(c.addresses(l).w.toBase58(),l.keys.wallet.address);
});

test('historical receipts without an execution snapshot retain original creator accounting',()=>{
  const l=launch(),owner=l.keys.wallet.address,rewards=l.keys.rewards.address;
  const row=(wallet,mint,amount,index)=>({accountIndex:index,owner:wallet,mint,uiTokenAmount:{amount:String(amount),decimals:6}});
  const tx={transaction:{message:{accountKeys:[pk(owner),pk(rewards)]}},meta:{err:null,fee:5000,preBalances:[1000000,1000000],postBalances:[995000,1000000],preTokenBalances:[row(owner,USDC_MINT,30,2),row(rewards,USDC_MINT,400,3)],postTokenBalances:[row(owner,USDC_MINT,100,2),row(rewards,USDC_MINT,999,3)]}};
  assert.deepEqual(receiptDeltas(tx,l),{quote:70n,base:0n,networkFee:5000n,gasAndRent:5000n});
});


function activate(l){provisionRewardsWallet(l,1);l.rewardsWallet.status='active';return l;}
const operation=(l,kind)=>({kind,rewardsWallet:rewardsWalletSelection(l,{kind})});

test('SOL and SPL payouts are built and signed only by the selected rewards wallet',async()=>{
  for(const quote of [SOL_MINT,USDC_MINT]){
    const l=activate(launch(quote)),c=chain(),op=operation(l,'payout'),owner=address(),ixs=await c.payoutInstructions(l,[{owner,amount:'1000'}],{operation:op});
    const transfer=quote===SOL_MINT?SystemInstruction.decodeTransfer(ixs.at(-1)):decodeTransferCheckedInstruction(ixs.at(-1));
    assert.equal((transfer.fromPubkey||transfer.keys.owner.pubkey).toBase58(),l.keys.rewards.address);
    const prepared=await c.prepare(l,ixs,[],false,{operation:op});
    verifySignedTransaction(Buffer.from(prepared.raw,'base64'),l.keys.rewards.address,[]);
    await assert.rejects(c.prepare(l,ixs),/signer mismatch/i,'omitting the operation cannot sign from the creator');
    const legacy={kind:'payout'};
    const old=await c.payoutInstructions(l,[{owner,amount:'1000'}],{operation:legacy});
    const previous=await c.prepare(l,old,[],false,{operation:legacy});
    verifySignedTransaction(Buffer.from(previous.raw,'base64'),l.keys.wallet.address,[]);
  }
});

test('tax harvest destination changes without changing withdrawal authority or transaction payer',async()=>{
  for(const revoked of [false,true]){
  const l=activate(launch()),c=chain({getProgramAccounts:async()=>({context:{slot:100},value:[]})}),{w}=c.addresses(l);
  const data=Buffer.alloc(TransferFeeConfigLayout.span+4);data.writeUInt16LE(ExtensionType.TransferFeeConfig);data.writeUInt16LE(TransferFeeConfigLayout.span,2);
  const fee={epoch:0n,maximumFee:18446744073709551615n,transferFeeBasisPoints:100};
  TransferFeeConfigLayout.encode({transferFeeConfigAuthority:revoked?PublicKey.default:w,withdrawWithheldAuthority:w,withheldAmount:30000n,olderTransferFee:fee,newerTransferFee:fee},data,4);
  c.mintInfo=async()=>({program:TOKEN_2022_PROGRAM_ID,mint:{tlvData:data}});
  const op=operation(l,'tax'),ixs=await c.claimInstructions(l,'tax',{operation:op}),withdraw=ixs.at(-1),destination=getAssociatedTokenAddressSync(pk(l.keys.mint.address),pk(l.keys.rewards.address),false,TOKEN_2022_PROGRAM_ID);
  assert(withdraw.keys[1].pubkey.equals(destination));assert(withdraw.keys[2].pubkey.equals(w));
  const prepared=await c.prepare(l,ixs,[],false,{operation:op});verifySignedTransaction(Buffer.from(prepared.raw,'base64'),l.keys.wallet.address,[]);
  const row={owner:l.keys.rewards.address,mint:l.keys.mint.address,accountIndex:1,uiTokenAmount:{amount:'30000',decimals:6}};
  // The rewards owner itself need not be in account keys once its ATA exists.
  const tx={transaction:{message:{accountKeys:[w,destination]}},meta:{err:null,fee:5000,preBalances:[1000000,2039280],postBalances:[995000,2039280],preTokenBalances:[{...row,uiTokenAmount:{amount:'0',decimals:6}}],postTokenBalances:[row]}};
  assert.deepEqual(receiptDeltas(tx,l,{operation:op}),{base:30000n,quote:0n,networkFee:5000n,gasAndRent:5000n});
  }
});

test('revoked tax configuration preserves schedule, program and withdrawal checks',()=>{
  const l=launch(),c=chain(),{w,auth}=c.addresses(l),fee={epoch:0n,maximumFee:18446744073709551615n,transferFeeBasisPoints:100};
  const mint=(change={},program=TOKEN_2022_PROGRAM_ID)=>{
    const data=Buffer.alloc(TransferFeeConfigLayout.span+4);data.writeUInt16LE(ExtensionType.TransferFeeConfig);data.writeUInt16LE(TransferFeeConfigLayout.span,2);
    TransferFeeConfigLayout.encode({transferFeeConfigAuthority:PublicKey.default,withdrawWithheldAuthority:w,withheldAmount:0n,olderTransferFee:fee,newerTransferFee:fee,...change},data,4);
    return {program,mint:{tlvData:data}};
  };
  assert(c.transferTax(l,mint()));
  assert(c.transferTax(l,mint({transferFeeConfigAuthority:auth,withdrawWithheldAuthority:auth})),'existing Raydium handover remains accepted');
  for(const change of [
    {transferFeeConfigAuthority:pk(address())},
    {withdrawWithheldAuthority:PublicKey.default},
    {withdrawWithheldAuthority:pk(address())},
    {olderTransferFee:{...fee,transferFeeBasisPoints:200}},
    {newerTransferFee:{...fee,epoch:999999n,transferFeeBasisPoints:200}},
    {olderTransferFee:{...fee,maximumFee:1n}},
    {newerTransferFee:{...fee,epoch:999999n,maximumFee:1n}}
  ])assert.throws(()=>c.transferTax(l,mint(change)),/tax (?:authority )?differs/);
  assert.throws(()=>c.transferTax(l,mint({},TOKEN_PROGRAM_ID)),/transfer tax is missing/);
  const truncated=mint();truncated.mint.tlvData=truncated.mint.tlvData.subarray(0,20);
  assert.throws(()=>c.transferTax(l,truncated),'malformed extension cannot be mistaken for revoked authority');
});

test('gas seeding preserves the creator reserve and native reward principal, capped at 0.01 SOL',async()=>{
  const l=activate(launch(SOL_MINT)),balances=new Map([[l.keys.wallet.address,50000000],[l.keys.rewards.address,0]]),c=chain({getBalance:async key=>balances.get(key.toBase58()),getAccountInfo:async()=>null});
  c.mintInfo=async mint=>({key:pk(mint),program:TOKEN_PROGRAM_ID,mint:{decimals:9,tlvData:Buffer.alloc(0)}});
  assert.equal((await c.rewardsGasFundingPlan(l)).gasLamports,'10000000');
  balances.set(l.keys.rewards.address,7500000);assert.equal((await c.rewardsGasFundingPlan(l)).gasLamports,'2500000');
  balances.set(l.keys.rewards.address,0);balances.set(l.keys.wallet.address,10030000);assert.equal((await c.rewardsGasFundingPlan(l)).ready,false,'native creator reserve and rent remain protected');
  balances.set(l.keys.wallet.address,24128560);l.rewardsWallet.creatorCredits.quote='500000000';l.credits.quote='500000000';assert.equal((await c.rewardsGasFundingPlan(l)).ready,true,'WSOL principal is separate from native wallet gas');
  l.input.route='pump';assert.equal((await c.rewardsGasFundingPlan(l)).ready,false,'legacy native quote principal is reserved');l.input.route='raydium';
  balances.set(l.keys.rewards.address,10000000);assert.equal((await c.rewardsGasFundingPlan(l)).gasLamports,'0');
});

function handoffFixture(){
  const l=activate(launch()),plan=rewardHandoffPlan(l,{gasLamports:'10000000'}),source=pk(l.keys.wallet.address),destination=pk(l.keys.rewards.address),m=pk(l.keys.mint.address),q=pk(l.input.quoteMint);
  const aa=getAssociatedTokenAddressSync(m,source,false,TOKEN_2022_PROGRAM_ID),ab=getAssociatedTokenAddressSync(m,destination,false,TOKEN_2022_PROGRAM_ID),ba=getAssociatedTokenAddressSync(q,source),bb=getAssociatedTokenAddressSync(q,destination),keys=[source,destination,aa,ab,ba,bb];
  const row=(owner,mint,amount,index)=>({accountIndex:index,owner:owner.toBase58(),mint:mint.toBase58(),uiTokenAmount:{amount:String(amount),decimals:6}});
  const tx={transaction:{message:{accountKeys:keys}},meta:{err:null,fee:5000,preBalances:[50000000,0,2039280,0,2039280,0],postBalances:[35916440,10000000,2039280,2039280,2039280,2039280],preTokenBalances:[row(source,m,120000n,2),row(source,q,100000n,4)],postTokenBalances:[row(source,m,100000n,2),row(destination,m,19800n,3),row(source,q,70000n,4),row(destination,q,30000n,5)]}};
  const accounts=new Map([[aa.toBase58(),token(m,source,120000n,TOKEN_2022_PROGRAM_ID)],[ba.toBase58(),token(q,source,100000n)]]),c=chain({getBalance:async key=>key.equals(source)?50000000:0,getAccountInfo:async key=>accounts.get(key.toBase58())||null,getAccountInfoAndContext:async(key,options)=>({context:{slot:Math.max(41,options?.minContextSlot||0)},value:accounts.get(key.toBase58())||null})});
  c.mintInfo=async mint=>({key:pk(mint),program:String(mint)===m.toBase58()?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,mint:{decimals:6,tlvData:Buffer.alloc(0)}});
  return {l,plan,c,tx,source,destination,accounts};
}

test('handoff transfers exact saved credits and measures taxed net receipt without sweeping donations',async()=>{
  const h=handoffFixture(),op={kind:'reward-handoff',rewardHandoff:h.plan,rewardsWallet:rewardsWalletSelection(h.l,{kind:'reward-handoff'})},ixs=await h.c.rewardHandoffInstructions(h.l,h.plan),base=decodeTransferCheckedInstruction(ixs[1],TOKEN_2022_PROGRAM_ID),quote=decodeTransferCheckedInstruction(ixs[3]);
  assert.equal(base.data.amount,20000n);assert.equal(quote.data.amount,30000n);assert.equal(SystemInstruction.decodeTransfer(ixs[4]).lamports,10000000n);
  const prepared=await h.c.prepare(h.l,ixs,[],false,{operation:op});verifySignedTransaction(Buffer.from(prepared.raw,'base64'),h.l.keys.wallet.address,[]);
  assert.deepEqual(rewardHandoffReceipt(h.tx,h.l,op),{baseDebit:20000n,baseCredit:19800n,quoteDebit:30000n,quoteCredit:30000n,gasAndRent:4083560n,networkFee:5000n});
  const wrong=structuredClone(h.plan);wrong.destinationAddress=address();await assert.rejects(h.c.rewardHandoffInstructions(h.l,wrong),/wallets differ/);
  await assert.rejects(h.c.rewardHandoffInstructions(h.l,{...h.plan,baseUnits:'120000'}),/exceeds saved/);
  const altered={...h.tx,meta:structuredClone(h.tx.meta)};altered.meta.postTokenBalances[0].uiTokenAmount.amount='99999';assert.throws(()=>rewardHandoffReceipt(altered,h.l,op),/different amount/);
  altered.meta.postTokenBalances[0].uiTokenAmount.amount='100000';altered.meta.postBalances[1]++;assert.throws(()=>rewardHandoffReceipt(altered,h.l,op),/gas funding differs/);
});

test('gas-only handoff creates no token transfer and requires exact native funding receipt',async()=>{
  const l=activate(launch());l.credits={base:'0',quote:'0'};l.rewardsWallet.creatorCredits={base:'0',quote:'0',protocolQuote:'0',taxBase:'0'};
  const plan=rewardHandoffPlan(l,{gasLamports:'10000000'}),c=chain({getBalance:async key=>key.toBase58()===l.keys.wallet.address?50000000:0}),ixs=await c.rewardHandoffInstructions(l,plan);assert.equal(ixs.length,1);
  const tx={transaction:{message:{accountKeys:[pk(l.keys.wallet.address),pk(l.keys.rewards.address)]}},meta:{err:null,fee:5000,preBalances:[50000000,0],postBalances:[39995000,10000000]}};
  const delta=rewardHandoffReceipt(tx,l,{rewardHandoff:plan});assert.equal(delta.gasAndRent,5000n);assert.equal(delta.quoteDebit,0n);
});

test('protocol payout keeps its own authority when holder rewards execution is active',async()=>{
  const l=activate(launch(SOL_MINT)),c=chain(),recipient=address();
  l.keys.protocol=newLaunchKeys().wallet;l.protocolFeeWallet={source:'protocol',address:l.keys.protocol.address};l.review.protocolFees={recipient};
  const ixs=await c.protocolPayoutInstructions(l,{quote:'1000'}),transfer=SystemInstruction.decodeTransfer(ixs.at(-1));
  assert.equal(transfer.fromPubkey.toBase58(),l.keys.protocol.address);assert.equal(transfer.toPubkey.toBase58(),recipient);
  assert(!ixs.flatMap(ix=>ix.keys.filter(key=>key.isSigner)).some(key=>key.pubkey.toBase58()===l.keys.rewards.address));
});

test('new holder budgets include both gas reserves and mint-specific rewards account rent',async()=>{
  const sizes=[],c=chain({getMinimumBalanceForRentExemption:async size=>{sizes.push(size);return 1000000+size*10;}}),tlv=Buffer.alloc(4+64);
  tlv.writeUInt16LE(ExtensionType.TransferHook,0);tlv.writeUInt16LE(64,2);
  const result=await c.fundingEstimate({feeMode:'holders',feeCustody:'relay',taxBps:200,walletMode:'external',quoteMint:USDC_MINT},{program:TOKEN_2022_PROGRAM_ID,mint:{tlvData:tlv}});
  assert(sizes.includes(182),'taxed base ATA requires TransferFeeAmount and ImmutableOwner account space');
  assert(sizes.includes(175),'quote transfer hook ATA length includes ImmutableOwner');
  assert.equal(result.serviceReserve,String(20000000+(1000000+182*10)+(1000000+175*10)+1000000));
  assert(BigInt(result.serviceReserve)>22000000n);assert(result.minimumSol);
  const creator=await c.fundingEstimate({feeMode:'creator',feeCustody:'relay',taxBps:0});assert.equal(creator.serviceReserve,'10000000');
});

test('confirmed handoffs reconcile after rewards custody loss while new signing stays blocked',async()=>{
  const h=handoffFixture(),op={kind:'reward-handoff',rewardHandoff:h.plan};
  h.l.keys.rewards.compromisedAt=123;delete h.l.keys.rewards.secret;
  const receipt=rewardHandoffReceipt(h.tx,h.l,op);assert.equal(receipt.baseCredit,19800n);
  await assert.rejects(h.c.rewardHandoffInstructions(h.l,h.plan),/separate managed/);
  const saved={kind:'payout',rewardsWallet:{version:1,source:'rewards',address:h.destination.toBase58(),signerSource:'rewards'}};
  const tx={transaction:{message:{accountKeys:[h.destination]}},meta:{err:null,fee:5000,preBalances:[10000000],postBalances:[9995000],preTokenBalances:[],postTokenBalances:[]}};
  assert.equal(receiptDeltas(tx,h.l,{operation:saved}).gasAndRent,5000n);
  await assert.rejects(h.c.payoutInstructions(h.l,[{owner:address(),amount:'100'}],{operation:saved}),/rewards wallet is unavailable/);
});

test('confirmed base and quote Token2022 dust can net zero only with exact transfer evidence',()=>{
  for(const quote of [false,true]){
    const l=activate(launch()),mint=quote?l.input.quoteMint:l.keys.mint.address;
    l.review.quoteProgram=TOKEN_2022_PROGRAM_ID.toBase58();l.credits={base:quote?'0':'1',quote:quote?'1':'0'};l.rewardsWallet.creatorCredits={...l.credits,protocolQuote:'0',taxBase:'0'};
    const plan=rewardHandoffPlan(l),source=pk(l.keys.wallet.address),destination=pk(l.keys.rewards.address),from=getAssociatedTokenAddressSync(pk(mint),source,false,TOKEN_2022_PROGRAM_ID),to=getAssociatedTokenAddressSync(pk(mint),destination,false,TOKEN_2022_PROGRAM_ID),data=Buffer.alloc(10);data[0]=12;data.writeBigUInt64LE(1n,1);data[9]=6;
    const row=(owner,index,amount)=>({owner:owner.toBase58(),mint,accountIndex:index,uiTokenAmount:{amount,decimals:6}}),instruction={programIdIndex:5,accountKeyIndexes:[2,4,3,0],data};
    const tx={transaction:{message:{accountKeys:[source,destination,from,to,pk(mint),TOKEN_2022_PROGRAM_ID],compiledInstructions:[instruction]}},meta:{err:null,fee:5000,preBalances:[50000000,0,2039280,0,1000000,1000000],postBalances:[47955720,0,2039280,2039280,1000000,1000000],preTokenBalances:[row(source,2,'10')],postTokenBalances:[row(source,2,'9'),row(destination,3,'0')]}};
    const delta=rewardHandoffReceipt(tx,l,{rewardHandoff:plan});assert.equal(quote?delta.quoteDebit:delta.baseDebit,1n);assert.equal(quote?delta.quoteCredit:delta.baseCredit,0n);
    tx.transaction.message.compiledInstructions=[];assert.throws(()=>rewardHandoffReceipt(tx,l,{rewardHandoff:plan}),/exact Token2022/);
    tx.transaction.message.compiledInstructions=[instruction];tx.meta.postTokenBalances.pop();assert.throws(()=>rewardHandoffReceipt(tx,l,{rewardHandoff:plan}),/missing a destination token balance/);
  }
});

function fundingHarness({creator=0,rewards=0,credits=true,initialized=false}={}){
  const l=activate(launch()),balances=new Map([[l.keys.wallet.address,creator],[l.keys.rewards.address,rewards]]),accounts=new Map(),c=chain({getBalance:async key=>balances.get(key.toBase58()),getAccountInfo:async key=>accounts.get(key.toBase58())||null,getAccountInfoAndContext:async(key,options)=>({context:{slot:Math.max(41,options?.minContextSlot||0)},value:accounts.get(key.toBase58())||null})});
  if(!credits){l.credits={base:'0',quote:'0'};l.rewardsWallet.creatorCredits={base:'0',quote:'0',protocolQuote:'0',taxBase:'0'};}
  if(initialized)l.rewardsWallet.gasInitializedAt=1;
  c.mintInfo=async mint=>({key:pk(mint),program:String(mint)===l.keys.mint.address?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,mint:{decimals:6,tlvData:Buffer.alloc(0)}});
  return {l,c,balances,accounts};
}

test('migration above ordinary refill thresholds reports exact independently fundable requirements',async()=>{
  for(const [creator,rewards,required,deficit] of [[7000000,20000000,14128560,7128560],[12000000,7000000,17128560,5128560]]){
    const h=fundingHarness({creator,rewards}),plan=await h.c.rewardsGasFundingPlan(h.l);
    assert.equal(plan.ready,false);assert.equal(plan.gasLamports,'0');assert.equal(plan.creatorRequiredLamports,String(required));assert.equal(plan.creatorDeficitLamports,String(deficit));assert.equal(plan.creatorDirectRequiredLamports,'14128560');assert.equal(plan.rewardsRequiredLamports,'10000000');assert.equal(plan.creatorPrincipalReserveLamports,'0');
    assert.deepEqual(plan.gasFundingNeed,{version:1,creatorAddress:h.l.keys.wallet.address,rewardsAddress:h.l.keys.rewards.address,creatorMinimumLamports:'14128560',rewardsMinimumLamports:'10000000',creatorPrincipalReserveLamports:'0'});
    h.balances.set(h.l.keys.wallet.address,Number(plan.gasFundingNeed.creatorMinimumLamports));h.balances.set(h.l.keys.rewards.address,Math.max(rewards,Number(plan.gasFundingNeed.rewardsMinimumLamports)));
    const after=await h.c.rewardsGasFundingPlan(h.l);assert.equal(after.ready,true);assert.equal(after.gasLamports,'0','central funding removes the seed requirement');assert.equal(after.creatorRequiredLamports,'14128560');
  }
});

test('direct funding permits transaction-free activation without an unused creator reserve',async()=>{
  const h=fundingHarness({creator:0,rewards:0,credits:false}),before=await h.c.rewardsGasFundingPlan(h.l);
  assert.equal(before.ready,false);assert.equal(before.creatorRequiredLamports,'20050000');assert.equal(before.creatorDirectRequiredLamports,'0');assert.equal(before.gasFundingNeed.creatorMinimumLamports,'0');assert.equal(before.gasLamports,'0');
  h.balances.set(h.l.keys.rewards.address,10000000);
  const after=await h.c.rewardsGasFundingPlan(h.l);assert.equal(after.ready,true);assert.equal(after.needsTransaction,false);assert.equal(after.creatorRequiredLamports,'0');assert.equal(after.handoffCostLamports,'0');assert.equal(after.gasLamports,'0');
  const funded=fundingHarness({creator:7000000,rewards:20000000,credits:false});assert.equal((await funded.c.rewardsGasFundingPlan(funded.l)).ready,true);
});

test('active creator-credit forwarding requires its own rent and fees without reseeding initialized rewards',async()=>{
  const h=fundingHarness({creator:12000000,rewards:7000000,initialized:true}),before=await h.c.rewardsGasFundingPlan(h.l);
  assert.equal(before.initializeGas,false);assert.equal(before.ready,false);assert.equal(before.creatorRequiredLamports,'14128560');assert.equal(before.rewardsRequiredLamports,'0');assert.equal(before.rewardsDeficitLamports,'0');assert.equal(before.gasFundingNeed.rewardsMinimumLamports,'0');assert.equal(before.gasLamports,'0');
  h.balances.set(h.l.keys.wallet.address,14128560);h.balances.set(h.l.keys.rewards.address,0);
  const after=await h.c.rewardsGasFundingPlan(h.l);assert.equal(after.ready,true);assert.equal(after.gasLamports,'0');assert.equal(after.handoffCostLamports,'4128560');
  const owner=pk(h.l.keys.rewards.address);
  for(const [mint,program] of [[h.l.keys.mint.address,TOKEN_2022_PROGRAM_ID],[h.l.input.quoteMint,TOKEN_PROGRAM_ID]])h.accounts.set(getAssociatedTokenAddressSync(pk(mint),owner,false,program).toBase58(),token(mint,owner,0,program));
  const existing=await h.c.rewardsGasFundingPlan(h.l);assert.equal(existing.handoffCostLamports,'50000');assert.equal(existing.creatorDirectRequiredLamports,'10050000');
});

test('central funding hints separate native principal from operational funding needs',async()=>{
  const h=fundingHarness({creator:7000000,rewards:20000000});h.l.input.route='pump';h.l.input.quoteMint=SOL_MINT;h.l.credits.quote='500000000';h.l.rewardsWallet.creatorCredits.quote='500000000';
  const plan=await h.c.rewardsGasFundingPlan(h.l);assert.equal(plan.ready,false);assert.equal(plan.creatorPrincipalReserveLamports,'500000000');assert.equal(plan.creatorDirectRequiredLamports,'514128560');assert.equal(plan.gasFundingNeed.creatorPrincipalReserveLamports,'500000000');assert.equal(plan.gasLamports,'0');
  assert.equal(BigInt(plan.gasFundingNeed.creatorMinimumLamports)-BigInt(plan.gasFundingNeed.creatorPrincipalReserveLamports),14128560n);
});

// Payout gas (v71.37): the sale of a little of the pair asset for the SOL a payout needs, priced and built through Jupiter.
const JUPITER='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
function jupiterFetcher({quotes={},build=null,status=200}={}){
  const calls=[];
  const fetcher=async(url,options)=>{
    const u=new URL(url);calls.push({path:u.pathname,params:Object.fromEntries(u.searchParams),headers:options?.headers||{}});
    const respond=(ok,body,code=ok?200:status)=>({ok,status:code,headers:{get:()=>null},json:async()=>body});
    if(u.pathname==='/swap/v1/quote'){const q=quotes[u.searchParams.get('swapMode')||'ExactIn'];return q?respond(true,typeof q==='function'?q(u.searchParams):q):respond(false,{error:'no route'},400);}
    if(u.pathname==='/swap/v2/build')return build?respond(true,typeof build==='function'?build(u.searchParams):build):respond(false,{error:'unavailable'},status);
    return respond(false,{},404);
  };
  return {fetcher,calls};
}
function payoutGasLaunch(){const l=activate(launch());l.input.feeMode='holders';l.input.quoteMint=USDC_MINT;l.review.quoteDecimals=6;return l;}

test('payout gas (v71.37): the sale size comes from an exact-out quote, or a one-token sample when the route has none',async()=>{
  const l=payoutGasLaunch();
  const exact=jupiterFetcher({quotes:{ExactOut:p=>({inputMint:USDC_MINT,outputMint:SOL_MINT,inAmount:'518416',outAmount:p.get('amount'),priceImpactPct:'0.001'})}});
  assert.equal(await new LaunchChain({network:'mainnet-beta',connection:{},fetcher:exact.fetcher,jupiterKey:'k'}).payoutGasSaleAmount(l,'2592080'),518416n);
  assert.equal(exact.calls.length,1);assert.deepEqual(exact.calls[0].params,{inputMint:USDC_MINT,outputMint:SOL_MINT,slippageBps:'100',amount:'2592080',swapMode:'ExactOut'});assert.equal(exact.calls[0].headers['x-api-key'],'k');
  // No exact-out route: 1 USDC buys 0.005 SOL, so 2592080 lamports need 518416 units (rounded up).
  const sample=jupiterFetcher({quotes:{ExactIn:p=>({inputMint:USDC_MINT,outputMint:SOL_MINT,inAmount:p.get('amount'),outAmount:'5000000',priceImpactPct:'0.0005'})}});
  assert.equal(await new LaunchChain({network:'mainnet-beta',connection:{},fetcher:sample.fetcher}).payoutGasSaleAmount(l,'2592080'),518416n);
  assert.deepEqual(sample.calls.map(call=>[call.params.swapMode,call.params.amount]),[['ExactOut','2592080'],['ExactIn','1000000']]);
  // A quote for the wrong pair, with a 3% impact, or none at all is not a price.
  for(const quotes of [{ExactIn:{inputMint:SOL_MINT,outputMint:USDC_MINT,inAmount:'1000000',outAmount:'5000000',priceImpactPct:'0'}},{ExactIn:{inputMint:USDC_MINT,outputMint:SOL_MINT,inAmount:'1000000',outAmount:'5000000',priceImpactPct:'0.03'}},{}]){
    await assert.rejects(new LaunchChain({network:'mainnet-beta',connection:{},fetcher:jupiterFetcher({quotes}).fetcher}).payoutGasSaleAmount(l,'2592080'),error=>error.code==='REWARD_MARKET_WAIT'&&/no SOL route/.test(error.message));
  }
  await assert.rejects(new LaunchChain({network:'mainnet-beta',connection:{},fetcher:exact.fetcher}).payoutGasSaleAmount({...l,input:{...l.input,quoteMint:SOL_MINT}},'1'),/pair asset other than SOL/);
});

test('payout gas (v71.37): the sale is built for the rewards wallet alone and refused when its worst case misses the shortfall',async()=>{
  const l=payoutGasLaunch(),taker=l.keys.rewards.address,operation={kind:'gas-sell',rewardsWallet:rewardsWalletSelection(l,{kind:'gas-sell'}),payoutGas:{shortfallLamports:'592080',targetLamports:'2592080'}};
  const swap=(threshold,extra={})=>p=>({inputMint:p.get('inputMint'),outputMint:p.get('outputMint'),inAmount:p.get('amount'),outAmount:'2700000',otherAmountThreshold:threshold,swapMode:'ExactIn',slippageBps:100,priceImpactPct:'0.002',routePlan:[{swapInfo:{label:'Raydium'}}],swapInstruction:{programId:JUPITER,accounts:[{pubkey:taker,isSigner:true,isWritable:true}],data:Buffer.from('01','hex').toString('base64')},setupInstructions:[],...extra});
  const good=jupiterFetcher({build:swap('2650000')}),c=new LaunchChain({network:'mainnet-beta',connection:{},fetcher:good.fetcher});
  const result=await c.payoutGasSaleInstructions(l,'648020',{operation});
  assert.equal(result.length,1);assert.equal(result[0].programId.toBase58(),JUPITER);assert.deepEqual(result.payoutGas,{expectedLamports:'2700000',minimumLamports:'2650000',dexes:['Raydium']});assert.equal(result.lookupTables,undefined);
  assert.equal(good.calls.length,1);assert.equal(good.calls[0].path,'/swap/v2/build');assert.equal(good.calls[0].params.inputMint,USDC_MINT);assert.equal(good.calls[0].params.outputMint,SOL_MINT);assert.equal(good.calls[0].params.amount,'648020');assert.equal(good.calls[0].params.taker,taker);assert.equal(good.calls[0].params.slippageBps,'100');
  // Worst case below the missing SOL: sized again next pass, nothing built.
  await assert.rejects(new LaunchChain({network:'mainnet-beta',connection:{},fetcher:jupiterFetcher({build:swap('500000')}).fetcher}).payoutGasSaleInstructions(l,'648020',{operation}),error=>error.code==='REWARD_MARKET_WAIT'&&/would not cover the missing SOL/.test(error.message));
  // A foreign signer, a tip, a 3% impact or an unavailable builder is refused like the launch funding purchase.
  const other=address();
  await assert.rejects(new LaunchChain({network:'mainnet-beta',connection:{},fetcher:jupiterFetcher({build:swap('2650000',{swapInstruction:{programId:JUPITER,accounts:[{pubkey:other,isSigner:true,isWritable:true}],data:'AQ=='}})}).fetcher}).payoutGasSaleInstructions(l,'648020',{operation}),/Unexpected signer/);
  await assert.rejects(new LaunchChain({network:'mainnet-beta',connection:{},fetcher:jupiterFetcher({build:swap('2650000',{tipInstruction:{programId:JUPITER,accounts:[],data:'AQ=='}})}).fetcher}).payoutGasSaleInstructions(l,'648020',{operation}),/route differs/);
  await assert.rejects(new LaunchChain({network:'mainnet-beta',connection:{},fetcher:jupiterFetcher({build:swap('2650000',{priceImpactPct:'0.03'})}).fetcher}).payoutGasSaleInstructions(l,'648020',{operation}),/moved too far/);
  await assert.rejects(new LaunchChain({network:'mainnet-beta',connection:{},fetcher:jupiterFetcher({status:503}).fetcher}).payoutGasSaleInstructions(l,'648020',{operation}),/could not be sold for network fees/);
  // Only the dedicated rewards wallet sells, only on a holder launch with a pair other than SOL.
  await assert.rejects(c.payoutGasSaleInstructions(l,'648020',{operation:{...operation,rewardsWallet:{version:1,source:'wallet',address:l.keys.wallet.address,signerSource:'wallet'}}}),/dedicated rewards wallet only/);
  await assert.rejects(c.payoutGasSaleInstructions({...l,input:{...l.input,feeMode:'creator'}},'648020',{operation}),/holder-rewards launch/);
  await assert.rejects(c.payoutGasSaleInstructions({...l,input:{...l.input,quoteMint:SOL_MINT}},'648020',{operation}),/pair asset other than SOL/);
});

test('payout gas (v71.37): the cycle rent read counts the recipients without a token account for the pair asset and adds a fee allowance per batch',async()=>{
  const l=payoutGasLaunch(),owners=[address(),address(),address(),address()],rows=[...owners.map(owner=>({owner,amount:'1'})),{owner:owners[0],amount:'1'}];
  const expected=owners.map(owner=>getAssociatedTokenAddressSync(pk(USDC_MINT),pk(owner),false,TOKEN_PROGRAM_ID).toBase58());const reads=[];
  const c=chain({getMultipleAccountsInfo:async keys=>{reads.push(keys.map(key=>key.toBase58()));return keys.map((key,index)=>index%2?null:token(USDC_MINT,owners[index],5n));},getAccountInfo:async()=>({owner:TOKEN_PROGRAM_ID,data:Buffer.alloc(0),lamports:1,executable:false}),getMinimumBalanceForRentExemption:async()=>2039280});
  c.mintInfo=async()=>({program:TOKEN_PROGRAM_ID,mint:{decimals:6,tlvData:Buffer.alloc(0)}});
  // Four distinct recipients (the duplicate is read once), two without an account, two batches of three rows.
  assert.deepEqual(await c.payoutRecipientRentLamports(l,rows),{recipients:4,missing:2,rentLamports:'4078560',lamports:'4178560'});
  assert.deepEqual(reads,[expected]);
  const none=chain({getMultipleAccountsInfo:async keys=>keys.map((key,index)=>token(USDC_MINT,owners[index],5n)),getMinimumBalanceForRentExemption:async()=>{throw Error('not needed');}});
  assert.deepEqual(await none.payoutRecipientRentLamports(l,rows.slice(0,4)),{recipients:4,missing:0,rentLamports:'0',lamports:'100000'});
  await assert.rejects(c.payoutRecipientRentLamports({...l,input:{...l.input,quoteMint:SOL_MINT}},rows),/pair asset other than SOL/);
  await assert.rejects(chain({getMultipleAccountsInfo:async()=>[null]}).payoutRecipientRentLamports(l,rows),/snapshot is incomplete/);
});
