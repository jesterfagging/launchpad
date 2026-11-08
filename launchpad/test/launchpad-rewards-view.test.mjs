import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey,SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,MintLayout,AccountLayout,ExtensionType,TransferFeeConfigLayout,getMintLen,getAccountLen} from '@solana/spl-token';
import {LaunchRewardsView} from '../src/launchpad-rewards-view.mjs';
import {ray} from '../src/launchpad-chain.mjs';
import {USDC_MINT} from '../public/launchpad-model.mjs';

const address=()=>Keypair.generate().publicKey.toBase58(),pk=value=>new PublicKey(value);
const launch=()=>({id:'a'.repeat(32),keys:{wallet:{address:address(),secret:'PRIVATE-FEE-KEY'},mint:{address:address(),secret:'PRIVATE-MINT-KEY'}},input:{route:'raydium',network:'mainnet-beta',feeMode:'holders',quoteMint:USDC_MINT,taxBps:0},authorizedAt:1,createdAt:1,state:'live',autoFees:true,curve:address(),review:{quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals:6,price:{usd:'1'}},credits:{quote:'500000',base:'12000000'},operations:[]});
function mintInfo(decimals,program=TOKEN_PROGRAM_ID,fee=null){
  const data=Buffer.alloc(fee?getMintLen([ExtensionType.TransferFeeConfig]):MintLayout.span);
  MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1000000000000000n,decimals,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},data);
  if(fee){data[165]=1;data.writeUInt16LE(ExtensionType.TransferFeeConfig,166);data.writeUInt16LE(TransferFeeConfigLayout.span,168);TransferFeeConfigLayout.encode(fee,data,170);}
  return{owner:program,lamports:2039280,data,executable:false};
}
function tokenInfo(mint,owner,amount,program=TOKEN_PROGRAM_ID,withheld=null){
  const data=Buffer.alloc(withheld===null?AccountLayout.span:getAccountLen([ExtensionType.TransferFeeAmount]));AccountLayout.encode({mint:pk(mint),owner:pk(owner),amount:BigInt(amount),delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);
  if(withheld!==null){data[165]=2;data.writeUInt16LE(ExtensionType.TransferFeeAmount,166);data.writeUInt16LE(8,168);data.writeBigUInt64LE(BigInt(withheld),170);}
  return{owner:program,lamports:2039280,data,executable:false};
}
function harness(t,l=launch()){
  let now=1700000000000,slot=100,calls=0,closes=0,error=null,deferred=null,scanError=null,scanRows=[];
  const scopes=[],requests=[],values=[{owner:SystemProgram.programId,lamports:10000000,data:Buffer.alloc(0),executable:false},mintInfo(6),mintInfo(6),tokenInfo(l.input.quoteMint,l.keys.wallet.address,'9000000'),tokenInfo(l.keys.mint.address,l.keys.wallet.address,'15000000'),null];
  const view=new LaunchRewardsView({now:()=>now,chainFor:async(account,network)=>{scopes.push([account,network]);return{c:{getProgramAccounts:async(program,options)=>{assert(program.equals(TOKEN_2022_PROGRAM_ID));assert.equal(options.commitment,'finalized');assert.equal(options.withContext,true);assert.deepEqual(options.filters,[{memcmp:{offset:0,bytes:l.keys.mint.address}}]);if(scanError)throw scanError;return{context:{slot},value:scanRows};},getMultipleAccountsInfoAndContext:async(keys,options)=>{calls++;requests.push({keys:keys.map(String),options});if(deferred)await deferred;if(error)throw error;return{context:{slot},value:values};}},close(){closes++;}};}});t.after(()=>view.close());
  return{l,view,values,scopes,requests,get calls(){return calls;},get closes(){return closes;},get now(){return now;},set error(value){error=value;},set deferred(value){deferred=value;},set slot(value){slot=value;},set scanRows(value){scanRows=value;},set scanError(value){scanError=value;},advance(ms=30000){now+=ms;slot++;}};
}
test('finalized balances remain separate from receipt-backed earned rewards and native fee reserves',async t=>{
  const h=harness(t),v=await h.view.read('account-a',h.l);
  assert.equal(v.wallet.quoteBalance,'9');assert.equal(v.earned.quote,'0.5');assert.equal(v.wallet.unconvertedTaxTokens,'15');assert.equal(v.earned.unconvertedTaxTokens,'12');assert.equal(v.wallet.nativeSol,'0.01');assert.equal(v.wallet.quoteSymbol,'USDC');assert.equal(v.asOf,h.now);assert.equal(v.slot,100);assert.equal(v.stale,false);assert.equal(v.error,null);
  assert.equal(v.taxes.withheldTokens,'0');assert.equal(v.totals.distributedQuote,'0');assert.equal(v.unclaimedCreatorQuote,'0');assert.equal(h.calls,1);assert.equal(h.closes,1);assert.equal(h.requests[0].options.commitment,'finalized');assert.equal(h.requests[0].keys.length,6);
  assert(!JSON.stringify(v).includes('PRIVATE'));assert.equal(v.schedule.pendingQuote,'0.5');assert.equal(v.refreshMs,30000);
});
test('cached chain balances still report fresh verified payout totals and latest earned credits',async t=>{
  const h=harness(t);await h.view.read('a',h.l);
  h.l.operations=[{kind:'payout',state:'confirmed',signature:'paid',slot:99,amount:'200000',payouts:[{owner:address(),amount:'200000'}],createdAt:h.now-1000,confirmedAt:h.now},{kind:'payout',state:'pending',signature:'pending',amount:'999000000',payouts:[{owner:address(),amount:'999000000'}]}];
  h.l.credits.quote='300000';
  const v=await h.view.read('a',h.l);assert.equal(h.calls,1);assert.equal(v.earned.quote,'0.3');assert.equal(v.totals.distributedQuote,'0.2');assert.equal(v.totals.payments,1);assert.equal(v.totals.lastDistributionAt,h.now);assert.equal(v.totals.lastDistributionQuote,'0.2');
  v.schedule.minimumQuote='999';assert.notEqual((await h.view.read('a',h.l)).schedule.minimumQuote,'999');
});
test('concurrent reads coalesce and every account has an independent cache scope',async t=>{
  const h=harness(t);let finish;h.deferred=new Promise(resolve=>{finish=resolve;});
  const first=h.view.read('a',h.l),second=h.view.read('a',h.l);await new Promise(resolve=>setImmediate(resolve));assert.equal(h.calls,1);finish();await Promise.all([first,second]);h.deferred=null;
  await h.view.read('b',h.l);assert.equal(h.calls,2);assert.deepEqual(h.scopes,[['a','mainnet-beta'],['b','mainnet-beta']]);
});
test('failed RPC reads retain verified balances with an explicit stale flag and never reveal provider credentials',async t=>{
  const h=harness(t),first=await h.view.read('a',h.l);h.advance();h.error=Error('https://rpc.example/PRIVATE-API-KEY');
  const stale=await h.view.read('a',h.l);assert.equal(stale.stale,true);assert.equal(stale.asOf,first.asOf);assert.equal(stale.wallet.quoteBalance,'9');assert(stale.error);assert(!JSON.stringify(stale).includes('API-KEY'));
  await h.view.read('a',h.l);assert.equal(h.calls,2);h.advance();h.error=null;assert.equal((await h.view.read('a',h.l)).stale,false);
});
test('an initial RPC failure returns unknown balances, and a changed wallet cannot inherit another wallet snapshot',async t=>{
  const h=harness(t);h.error=Error('provider failure');let v=await h.view.read('a',h.l);assert.equal(v.wallet.quoteBalance,null);assert.equal(v.wallet.nativeSol,null);assert.equal(v.asOf,null);assert.equal(v.stale,true);assert.equal(v.earned.quote,'0.5');
  h.advance();h.error=null;await h.view.read('a',h.l);h.l.keys.wallet.address=address();h.error=Error('provider failure');v=await h.view.read('a',h.l);assert.equal(v.wallet.address,h.l.keys.wallet.address);assert.equal(v.wallet.quoteBalance,null);assert.equal(v.asOf,null);
});
test('wrong owners, mint programs, decimals and regressed slots cannot replace the last verified balances',async t=>{
  const h=harness(t);await h.view.read('a',h.l);const original=h.values[3];
  h.advance();h.values[3]=tokenInfo(h.l.input.quoteMint,address(),'999999999');assert.equal((await h.view.read('a',h.l)).wallet.quoteBalance,'9');
  h.advance();h.values[3]=original;h.values[1]=mintInfo(9);assert.equal((await h.view.read('a',h.l)).stale,true);
  h.advance();h.values[1]=mintInfo(6,TOKEN_2022_PROGRAM_ID);assert.equal((await h.view.read('a',h.l)).stale,true);
  h.advance();h.values[1]=mintInfo(6);h.slot=99;assert.equal((await h.view.read('a',h.l)).stale,true);assert.equal(h.requests.at(-1).options.minContextSlot,100);
});
test('withheld fees combine the mint and complete bounded token account scan without creating earned credits',async t=>{
  const h=harness(t);h.l.input.taxBps=300;const schedule={epoch:1n,maximumFee:18446744073709551615n,transferFeeBasisPoints:300};
  h.values[2]=mintInfo(6,TOKEN_2022_PROGRAM_ID,{transferFeeConfigAuthority:pk(h.l.keys.wallet.address),withdrawWithheldAuthority:pk(h.l.keys.wallet.address),withheldAmount:123000000n,olderTransferFee:schedule,newerTransferFee:schedule});h.values[4]=tokenInfo(h.l.keys.mint.address,h.l.keys.wallet.address,'15000000',TOKEN_2022_PROGRAM_ID);
  h.scanRows=[{pubkey:pk(address()),account:tokenInfo(h.l.keys.mint.address,address(),'100000000',TOKEN_2022_PROGRAM_ID,'2000000')}];
  const v=await h.view.read('a',h.l);assert.equal(v.stale,false);assert.equal(v.taxes.mintWithheldTokens,'123');assert.equal(v.taxes.accountWithheldTokens,'2');assert.equal(v.taxes.withheldTokens,'125');assert.equal(v.taxes.accountsScanned,1);assert.equal(v.taxes.claimableNow,true);assert.equal(v.taxes.availableAfterGraduation,false);assert.equal(v.earned.unconvertedTaxTokens,'12');assert.equal(h.requests[0].keys.length,6);
  h.advance();h.scanError=Error('private provider key');const stale=await h.view.read('a',h.l);assert.equal(stale.stale,false);assert.equal(stale.taxes.stale,true);assert.equal(stale.taxes.withheldTokens,'125');assert.equal(stale.taxes.asOf,v.taxes.asOf);assert(!JSON.stringify(stale).includes('provider key'));
  h.advance();h.scanError=null;h.scanRows=Array(50001).fill({});const oversized=await h.view.read('a',h.l);assert.equal(oversized.taxes.stale,true);assert.equal(oversized.taxes.withheldTokens,'125');
});
test('a verified create receipt can show balances while curve verification is catching up',async t=>{
  const h=harness(t);h.l.curve=null;h.l.operations=[{kind:'create',state:'confirmed',signature:'create-signature',slot:99}];const v=await h.view.read('a',h.l);assert.equal(v.wallet.quoteBalance,'9');assert.equal(h.calls,1);
});
test('unclaimed curve fees verify the canonical vault authority and remain distinct from earned wallet credits',async t=>{
  const h=harness(t),authority=ray.getPdaCreatorFeeVaultAuth(ray.LAUNCHPAD_PROGRAM).publicKey.toBase58();h.l.feeCustody='relay';
  h.values[5]=tokenInfo(h.l.input.quoteMint,authority,'24267844');
  const v=await h.view.read('a',h.l);assert.equal(v.unclaimedCreatorQuote,'24.267844');assert.equal(v.unclaimedCreatorScope,'curve');assert.equal(v.unclaimedCreatorShared,false);assert.equal(v.earned.quote,'0.5');assert.equal(v.wallet.quoteBalance,'9');
  assert.equal(h.requests[0].keys[5],ray.getPdaCreatorVault(ray.LAUNCHPAD_PROGRAM,pk(h.l.keys.wallet.address),pk(h.l.input.quoteMint)).publicKey.toBase58());
  delete h.l.feeCustody;assert.equal((await h.view.read('a',h.l)).unclaimedCreatorShared,true);
  h.advance();h.values[5]=tokenInfo(address(),authority,'123');const invalid=await h.view.read('a',h.l);assert.equal(invalid.stale,true);assert.equal(invalid.unclaimedCreatorQuote,'24.267844');
  const firstBad=harness(t);firstBad.values[5]=tokenInfo(firstBad.l.input.quoteMint,address(),'123');const unavailable=await firstBad.view.read('a',firstBad.l);assert.equal(unavailable.stale,true);assert.equal(unavailable.unclaimedCreatorQuote,null);
});
test('missing associated accounts are zero, but unconfirmed and non-holder launches never query the chain',async t=>{
  const h=harness(t);h.values[0]=null;h.values[3]=null;h.values[4]=null;const v=await h.view.read('a',h.l);assert.equal(v.wallet.quoteBalance,'0');assert.equal(v.wallet.unconvertedTaxTokens,'0');assert.equal(v.wallet.nativeSol,'0');
  for(const patch of [{curve:null},{authorizedAt:null},{input:{...h.l.input,feeMode:'creator'}},{input:{...h.l.input,network:'devnet'}}])await assert.rejects(h.view.read('a',{...h.l,...patch}),/confirmed holder-reward/);
  assert.equal(h.calls,1);await h.view.close();await assert.rejects(h.view.read('a',h.l),/restarting/);
});

test('existing SV151 holder launches repair a saved QUOTE label without changing financial terms',async t=>{
  const l=launch();l.input.quoteMint='SV151D5pjygAKA8aJJcKzm4wFnRX5G92Fye94jQJk7g';l.review.quoteSymbol='QUOTE';const saved=JSON.stringify(l.review),h=harness(t,l);
  const data=await h.view.read('a',l);assert.equal(data.wallet.quoteSymbol,'SV151');assert.equal(data.schedule.quoteSymbol,'SV151');assert.equal(data.wallet.quoteBalance,'9');assert.equal(data.earned.quote,'0.5');assert.equal(JSON.stringify(l.review),saved);
});

test('unresolved custom reward quotes use their mint instead of a generic QUOTE unit',async t=>{
  const l=launch();l.input.quoteMint=address();l.review.quoteSymbol='QUOTE';const h=harness(t,l),data=await h.view.read('a',l);
  assert.equal(data.wallet.quoteSymbol,l.input.quoteMint.slice(0,5)+'…'+l.input.quoteMint.slice(-5));assert.equal(data.schedule.quoteSymbol,data.wallet.quoteSymbol);assert.equal(data.stale,false);
});

test('activation changes the observed owner without reusing creator balance cache or changing creator vault',async t=>{
  const h=harness(t),first=await h.view.read('a',h.l),creator=h.l.keys.wallet.address,reward=address();
  h.l.keys.rewards={address:reward};h.l.rewardsWallet={version:1,status:'active',address:reward};
  const originalWallet=h.values[0],originalQuote=h.values[3],originalBase=h.values[4];
  h.values[0]={...originalWallet,lamports:2000000};h.values[3]=tokenInfo(h.l.input.quoteMint,reward,'4000000');h.values[4]=tokenInfo(h.l.keys.mint.address,reward,'5000000');h.values.push(originalWallet,originalQuote,originalBase);
  const data=await h.view.read('a',h.l);assert.equal(h.calls,2);assert.equal(data.wallet.address,reward);assert.equal(data.wallet.role,'reward_conversion');assert.equal(data.wallet.quoteBalance,'4');assert.equal(data.wallet.nativeSol,'0.002');assert.equal(data.creatorWallet.address,creator);assert.equal(data.creatorWallet.quoteBalance,first.wallet.quoteBalance);assert.equal(data.creatorWallet.nativeSol,'0.01');assert.equal(data.earned.quote,'0.5');assert.equal(data.rewardsWallet.creatorAddress,creator);assert.equal(data.stale,false);
  assert.equal(h.requests[1].keys[0],reward);assert.equal(h.requests[1].keys[5],ray.getPdaCreatorVault(ray.LAUNCHPAD_PROGRAM,pk(creator),pk(h.l.input.quoteMint)).publicKey.toBase58());assert.equal(h.requests[1].keys[6],creator);
  h.advance();h.values[7]=tokenInfo(h.l.input.quoteMint,reward,'999999999');assert.equal((await h.view.read('a',h.l)).stale,true);assert.equal((await h.view.read('a',h.l)).creatorWallet.quoteBalance,'9');
});

test('separate reward destination does not become the transfer-tax withdrawal authority',async t=>{
  const h=harness(t),creator=h.l.keys.wallet.address,reward=address();h.l.input.taxBps=300;h.l.keys.rewards={address:reward};h.l.rewardsWallet={version:1,status:'active',address:reward};
  const schedule={epoch:1n,maximumFee:18446744073709551615n,transferFeeBasisPoints:300};h.values[2]=mintInfo(6,TOKEN_2022_PROGRAM_ID,{transferFeeConfigAuthority:pk(creator),withdrawWithheldAuthority:pk(creator),withheldAmount:0n,olderTransferFee:schedule,newerTransferFee:schedule});
  h.values[3]=tokenInfo(h.l.input.quoteMint,reward,'4000000');h.values[4]=tokenInfo(h.l.keys.mint.address,reward,'5000000',TOKEN_2022_PROGRAM_ID);h.values.push(null,null,null);
  const data=await h.view.read('a',h.l);assert.equal(data.taxes.claimableNow,true);assert.match(data.taxes.note,/original collection wallet holds withdrawal authority/);assert.equal(data.wallet.address,reward);assert.equal(data.stale,false);
});

test('migrating wallets do not switch reads early and invalid active roles cannot expose unrelated balances',async t=>{
  const h=harness(t),reward=address();h.l.keys.rewards={address:reward};h.l.rewardsWallet={version:1,status:'migrating',address:reward};assert.equal((await h.view.read('a',h.l)).wallet.address,h.l.keys.wallet.address);
  h.l.rewardsWallet.status='active';h.l.rewardsWallet.address=address();await assert.rejects(h.view.read('a',h.l),/could not be verified/);assert.equal(h.calls,1);
});
