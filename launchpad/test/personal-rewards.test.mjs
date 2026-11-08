import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { PersonalRewards, personalRewardIndex, personalRewardReceipt } from '../src/personal-rewards.mjs';
import { SOL_MINT, USDC_MINT } from '../public/launchpad-model.mjs';

const NOW = 1790000000000, TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const key = () => Keypair.generate().publicKey.toBase58();
const OWNER = 'a'.repeat(32), USER = 'b'.repeat(32), OTHER = 'c'.repeat(32), WALLET = key(), OTHER_WALLET = key(), FEE_WALLET = key(), MINT = key();
const sig = n => '4'.repeat(70) + '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[n];
const op = (kind, n, extra = {}) => ({ kind, state: 'confirmed', signature: sig(n), slot: 100+n, operationId: `op-${n}`, confirmedAt: NOW-1000+n, ...extra });
const payout = (n, amount, owner = WALLET, extra = {}) => op('payout', n, { amount, payouts: [{owner,amount}], receipt: {quoteDelta:`-${amount}`,baseDelta:'0'}, ...extra });
const launch = (mode, operations, extra = {}) => ({ input: {route:'raydium',network:'mainnet-beta',feeMode:mode,quoteMint:SOL_MINT,symbol:'TEST',recipient:WALLET}, keys:{mint:{address:MINT},wallet:{address:FEE_WALLET,secret:'PRIVATE_KEY'}}, review:{quoteDecimals:9,quoteSymbol:'SOL',quoteProgram:TOKEN}, curve:key(), authorizedAt:NOW-5000, state:'live', operations:[op('create',0),...operations], ...extra });
const units = (index, address = WALLET, type = 'holders', mint = SOL_MINT) => index.wallets.get(address)?.[type].amounts.get(mint)?.amount || 0n;

test('personal holder income includes only its own confirmed payout portion, including hidden archived coins',()=>{
  const record=launch('holders',[payout(1,'3000',WALLET,{payouts:[{owner:WALLET,amount:'1000'},{owner:OTHER_WALLET,amount:'2000'}]}),payout(2,'9000',WALLET,{state:'pending'}),payout(3,'9000',WALLET,{state:'failed'}),op('tax-protocol-payout',4,{amount:'999999',payouts:[{owner:WALLET,amount:'999999'}]})],{moderation:{hidden:true},listArchive:{archived:true}});
  const before=structuredClone(record),index=personalRewardIndex([record]);
  assert.equal(units(index),1000n);assert.equal(units(index,OTHER_WALLET),2000n);assert.equal(index.wallets.get(WALLET).holders.paymentCount,1);assert.deepEqual(record,before);
});
test('creator fees count when paid, not while claimed into the managed fee vault',()=>{
  const l=launch('creator',[op('claim',1,{receipt:{quoteDelta:'3000',baseDelta:'0'}}),payout(2,'1000'),op('protocol-payout',3,{amount:'7000',payouts:[{owner:WALLET,amount:'7000'}]})],{credits:{quote:'2000',base:'0'}});
  assert.equal(units(personalRewardIndex([l]),WALLET,'creator'),1000n);
});
test('redirect changes never reassign historical payments or award the original owner all launch fees',()=>{
  const l=launch('creator',[payout(1,'1000',WALLET),payout(2,'2000',OTHER_WALLET)]);l.input.recipient=OTHER_WALLET;
  const index=personalRewardIndex([l]);assert.equal(units(index,WALLET,'creator'),1000n);assert.equal(units(index,OTHER_WALLET,'creator'),2000n);
});
test('direct personal wallet claims count once and self WSOL payouts do not count again',()=>{
  const l=launch('creator',[op('claim',1,{receipt:{quoteDelta:'3000',baseDelta:'1000000'}}),payout(2,'3000')]);l.keys.wallet.address=WALLET;
  const index=personalRewardIndex([l]);assert.equal(units(index,WALLET,'creator'),3000n);assert.equal(units(index,WALLET,'creator',MINT),1000000n);assert.equal(index.wallets.get(WALLET).creator.paymentCount,1);
});
test('duplicates across launch books and repeated signatures cannot inflate earnings',()=>{
  const l=launch('holders',[payout(1,'1000'),payout(1,'1000')]),index=personalRewardIndex([l,structuredClone(l)]);
  assert.equal(units(index),1000n);assert.equal(index.wallets.get(WALLET).holders.paymentCount,1);
});
test('contradictory duplicate signatures are excluded rather than choosing a traversal order',()=>{
  for(const reversed of [false,true]){
    const records=[launch('holders',[payout(1,'1000')]),launch('holders',[payout(1,'2000')])];
    const index=personalRewardIndex(reversed?records.reverse():records);assert.equal(units(index),0n);assert.equal(index.complete.holders,false);
  }
});
test('different confirmed signatures sharing one operation ID are excluded',()=>{
  const index=personalRewardIndex([launch('holders',[payout(1,'1000'),payout(2,'1000',WALLET,{operationId:'op-1'})])]);
  assert.equal(units(index),0n);assert.equal(index.complete.holders,false);
});
test('ambiguous payout recipients and contradictory amounts or receipts do not become income',()=>{
  const variants=[{payouts:undefined},{payouts:[{owner:WALLET,amount:'900'}]},{payouts:[{owner:WALLET,amount:'500'},{owner:WALLET,amount:'500'}]},{payouts:[{owner:'bad',amount:'1000'}]},{receipt:{quoteDelta:'-999',baseDelta:'0'}},{receipt:{quoteDelta:'-1000',baseDelta:'1'}},{slot:0},{amount:'1e3'}];
  for(const variant of variants){const index=personalRewardIndex([launch('holders',[payout(1,'1000',WALLET,variant)])]);assert.equal(units(index),0n);assert.equal(index.complete.holders,false);}
});
test('historic exact classic SPL payouts remain visible; missing claim receipts mark incomplete history',()=>{
  const l=launch('creator',[payout(1,'1000000',WALLET,{receipt:undefined}),op('claim',2)]);l.input.quoteMint=USDC_MINT;l.review={quoteDecimals:6,quoteSymbol:'USDC',quoteProgram:TOKEN};
  const index=personalRewardIndex([l]);assert.equal(units(index,WALLET,'creator',USDC_MINT),1000000n);assert.equal(index.complete.creator,false);
});
test('missing creation or truncated records do not produce falsely complete lifetime totals',()=>{
  for(const extra of [{operations:[payout(1,'1000')]},{historyTruncated:true},{operationsTruncated:true}]){const index=personalRewardIndex([launch('holders',[payout(1,'1000')],extra)]);assert.equal(units(index),1000n);assert.equal(index.complete.holders,false);}
  assert.equal(personalRewardIndex([],{inventoryComplete:false}).complete.creator,false);
});
test('buyback, setup, protocol, gas and unpaid credits are not personal creator or holder rewards',()=>{
  const index=personalRewardIndex([launch('buyback',[payout(1,'1000')]),launch('holders',[op('claim',2,{receipt:{quoteDelta:'8000',baseDelta:'0'}}),op('sell',3,{receipt:{quoteDelta:'5000',baseDelta:'-1000'}})],{credits:{quote:'99999'}})]);
  assert.equal(index.wallets.size,0);assert.equal(index.complete.holders,true);
});

function taxedFixture(){
  const l=launch('holders',[payout(1,'1000')]);l.input.quoteMint=USDC_MINT;l.review={quoteDecimals:6,quoteSymbol:'USDC',quoteProgram:TOKEN22};
  const operation=l.operations[1],balance=amount=>({owner:WALLET,mint:USDC_MINT,accountIndex:1,uiTokenAmount:{amount,decimals:6}}),tx={slot:operation.slot,meta:{err:null,preTokenBalances:[balance('50')],postTokenBalances:[balance('1020')]}};
  return {l,operation,tx};
}
test('future Token-2022 quote payouts preserve proven net credit rather than gross transfer amount',()=>{
  const {l,operation,tx}=taxedFixture();operation.personalRewardReceipt=personalRewardReceipt(l,operation,tx);
  assert.equal(operation.personalRewardReceipt.payments[0].amountUnits,'970');
  assert.equal(units(personalRewardIndex([l]),WALLET,'holders',USDC_MINT),970n);
});
test('older taxed quotes without recipient receipts remain explicitly incomplete',()=>{
  const {l}=taxedFixture(),index=personalRewardIndex([l]);assert.equal(units(index,WALLET,'holders',USDC_MINT),0n);assert.equal(index.complete.holders,false);
});
test('recipient receipt rejects missing owner, wrong decimals, excess credit and failed chain receipt',()=>{
  for(const change of [tx=>{delete tx.meta.postTokenBalances[0].owner;},tx=>{tx.meta.postTokenBalances[0].uiTokenAmount.decimals=9;},tx=>{tx.meta.postTokenBalances[0].uiTokenAmount.amount='1051';},tx=>{tx.meta.err={InstructionError:[0,'failed']};},tx=>{tx.meta.postTokenBalances.push(tx.meta.postTokenBalances[0]);},tx=>{tx.meta.postTokenBalances.push(null);},tx=>{tx.meta.preTokenBalances.push('malformed');},tx=>{delete tx.meta.postTokenBalances[0].uiTokenAmount;}]){
    const {l,operation,tx}=taxedFixture();change(tx);assert.equal(personalRewardReceipt(l,operation,tx),null);
  }
});
test('recipient credit metadata cannot be reused for another signature, slot or wallet',()=>{
  for(const change of [receipt=>{receipt.signature=sig(9);},receipt=>{receipt.slot++;},receipt=>{receipt.payments[0].wallet=OTHER_WALLET;},receipt=>{receipt.payments[0].amountUnits='1001';}]){
    const {l,operation,tx}=taxedFixture();operation.personalRewardReceipt=personalRewardReceipt(l,operation,tx);change(operation.personalRewardReceipt);
    const index=personalRewardIndex([l]);assert.equal(units(index,WALLET,'holders',USDC_MINT),0n);assert.equal(index.complete.holders,false);
  }
});

function harness({records=[launch('holders',[payout(1,'1000000000')])],prices=new Map([[SOL_MINT,{usd:'100',at:NOW}]])}={}){
  let now=NOW,reads=0;
  const people=new Map([[OWNER,{id:OWNER,authType:'password',mainWallet:OTHER_WALLET}],[USER,{id:USER,authType:'wallet',mainWallet:WALLET}],[OTHER,{id:OTHER,authType:'wallet',mainWallet:OTHER_WALLET}]]),books=new Map([[OWNER,{launches:records}],[USER,{launches:[]}],[OTHER,{launches:[]}]]);
  let session={account:people.get(USER),authMethod:'wallet',walletVerified:true,walletAddress:WALLET};
  const accounts={get:async id=>structuredClone(people.get(id)),list:async()=>structuredClone([...people.values()])},launchpad={book:async id=>{reads++;return structuredClone(books.get(id));}};
  const service=new PersonalRewards({accounts,launchpad,prices:()=>prices,now:()=>now}),context={authorize:async()=>structuredClone(session)};
  return {service,accounts,launchpad,people,books,context,prices,set session(value){session=value;},get session(){return session;},get reads(){return reads;},set now(value){now=value;}};
}
test('private result shows exact native units and current USD, and no other wallet or journal secrets',async()=>{
  const h=harness(),result=await h.service.read(USER,h.context);
  assert.equal(result.wallet,WALLET);assert.equal(result.holders.usdEstimate,100);assert.equal(result.holders.quoteTotals[0].amountUnits,'1000000000');assert.equal(result.holders.quoteTotals[0].amount,'1');assert.equal(result.creator.usdEstimate,0);
  const serialized=JSON.stringify(result);for(const forbidden of ['PRIVATE_KEY',OTHER_WALLET,FEE_WALLET,OWNER,USER,sig(1)])assert.equal(serialized.includes(forbidden),false);
});
test('shared scan is single-flight and reused by many accounts without provider calls',async()=>{
  const h=harness();await Promise.all(Array.from({length:12},()=>h.service.read(USER,h.context)));assert.equal(h.reads,3);
  h.session={account:h.people.get(OTHER),authMethod:'wallet',walletVerified:true,walletAddress:OTHER_WALLET};assert.equal((await h.service.read(OTHER,h.context)).holders.usdEstimate,0);assert.equal(h.reads,3);
  h.now=NOW+30001;await h.service.read(OTHER,h.context);assert.equal(h.reads,6);
});
test('unpriced and stale assets keep native values while withholding full USD totals',async()=>{
  for(const price of [undefined,{usd:'100',at:NOW-60001},{usd:'100',at:NOW+1},{usd:Infinity,at:NOW},{usd:true,at:NOW},{usd:'100',at:NOW,stale:true}]){
    const h=harness({prices:new Map([[SOL_MINT,price]])}),result=await h.service.read(USER,h.context);
    assert.equal(result.holders.usdEstimate,null);assert.equal(result.holders.observedUsdEstimate,null);assert.equal(result.holders.quoteTotals[0].amount,'1');assert.equal(result.holders.valuationComplete,false);
  }
});
test('historical partial totals are labeled recorded subtotal even when all retained payments have USD',async()=>{
  const h=harness({records:[launch('holders',[payout(1,'1000000000')],{historyTruncated:true})]}),result=await h.service.read(USER,h.context);
  assert.equal(result.holders.usdEstimate,null);assert.equal(result.holders.observedUsdEstimate,100);assert.equal(result.holders.historyComplete,false);
});
test('password sessions read their bound sign-in wallet; arbitrary actor or wallet sessions cannot override it',async()=>{
  const h=harness(),person=h.people.get(USER);person.authType='password';person.signInWallet=WALLET;person.mainWallet=OTHER_WALLET;h.session={account:person,authMethod:'password'};
  assert.equal((await h.service.read(USER,h.context)).holders.usdEstimate,100);
  await assert.rejects(h.service.read(OTHER,h.context),{statusCode:401});
  h.session={account:person,authMethod:'wallet',walletVerified:true,walletAddress:OTHER_WALLET};await assert.rejects(h.service.read(USER,h.context),{statusCode:401});
  h.session={account:person,authMethod:'wallet',walletVerified:false,walletAddress:WALLET};await assert.rejects(h.service.read(USER,h.context),{statusCode:401});
});
test('current account ban and session revocation are checked even on a cache hit',async()=>{
  const h=harness();await h.service.read(USER,h.context);h.people.get(USER).banned=true;await assert.rejects(h.service.read(USER,h.context),{statusCode:401});h.people.get(USER).banned=false;h.session=null;await assert.rejects(h.service.read(USER,h.context),{statusCode:401});
});
test('wallet binding changed while reading books never leaks the prior wallet result',async()=>{
  const h=harness(),original=h.launchpad.book;h.launchpad.book=async id=>{const book=await original(id);h.people.get(USER).mainWallet=OTHER_WALLET;return book;};
  await assert.rejects(h.service.read(USER,h.context),{statusCode:401});
});
test('failed refresh keeps a clearly stale previous snapshot and throttles repeated failed scans',async()=>{
  const h=harness();await h.service.read(USER,h.context);h.now=NOW+30001;let attempts=0;h.accounts.list=async()=>{attempts++;throw Error('PRIVATE_PROVIDER_SECRET');};
  const result=await h.service.read(USER,h.context);assert.equal(result.stale,true);assert.equal(result.holders.usdEstimate,100);assert.equal(result.updatedAt,NOW);await h.service.read(USER,h.context);assert.equal(attempts,1);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PROVIDER/);
});
test('unreadable books and reporting caps never report complete zero',async()=>{
  const h=harness();h.launchpad.book=async()=>{throw Error('PRIVATE_STORE');};const result=await h.service.read(USER,h.context);assert.equal(result.holders.usdEstimate,null);assert.equal(result.creator.usdEstimate,null);
  const limited=harness();limited.service.maxAccounts=1;await assert.rejects(limited.service.read(USER,limited.context),/temporarily unavailable/);
});

test('integrated payout reconciliation persists recipient net credit and never applies it twice',async()=>{
  const {Launchpad}=await import('../src/launchpad.mjs');
  for(const malformedRecipient of [false,true]){
    const {l,operation,tx}=taxedFixture();operation.state='pending';operation.createdAt=NOW;operation.reserve='0';
    l.credits={quote:'1000',base:'0'};l.cycle={stage:'payout',index:0,payouts:operation.payouts};l.gas={reserved:'0'};l.autoFees=true;
    const balance=(amount)=>({owner:FEE_WALLET,mint:USDC_MINT,accountIndex:2,uiTokenAmount:{amount,decimals:6}});
    tx.transaction={message:{accountKeys:[FEE_WALLET,WALLET]}};tx.meta.fee=5000;tx.meta.preBalances=[10000000,10000000];tx.meta.postBalances=[9995000,10000000];
    tx.meta.preTokenBalances.push(balance('1000'));tx.meta.postTokenBalances.push(balance('0'));
    // Recipient-only malformed metadata is irrelevant to the fee debit proof.
    if(malformedRecipient)delete tx.meta.postTokenBalances[0].uiTokenAmount;
    let writes=0;const manager=new Launchpad({},null,{now:()=>NOW});manager.save=async()=>{writes++;};
    const book={launches:[l]},chain={receipt:async()=>tx};await manager.reconcile(OWNER,book,l,chain,operation);
    assert.equal(operation.state,'confirmed');assert.equal(l.credits.quote,'0');assert.equal(l.cycle.index,1);assert.equal(writes,1);
    if(malformedRecipient)assert.equal(operation.personalRewardReceipt,undefined);else assert.equal(operation.personalRewardReceipt.payments[0].amountUnits,'970');
    await manager.reconcile(OWNER,book,l,chain,operation);assert.equal(l.credits.quote,'0');assert.equal(l.cycle.index,1);assert.equal(writes,1);await manager.close();
  }
});
