import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {LaunchpadAdmin} from '../src/launchpad-admin.mjs';
import {Launchpad} from '../src/launchpad.mjs';
import {LaunchFeeAssignments} from '../src/launchpad-fee-assignments.mjs';
import {newLaunchKeys} from '../src/launchpad-receipts.mjs';
import {launchInput,USDC_MINT} from '../public/launchpad-model.mjs';

const OWNER='a'.repeat(32),RECEIVER='b'.repeat(32),OTHER='d'.repeat(32),LAUNCH='c'.repeat(32),START=1700000000000;
const address=()=>newLaunchKeys().wallet.address;
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
async function harness(t){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-assigned-fees-')),receiverWallet=address();
  const people=new Map([[OWNER,{id:OWNER,username:'originaldev',authType:'password',mainWallet:address()}],[RECEIVER,{id:RECEIVER,username:'recipient',authType:'wallet',mainWallet:receiverWallet}],[OTHER,{id:OTHER,username:'someoneelse',authType:'wallet',mainWallet:address()}]]);
  const launch={id:LAUNCH,keys:{...newLaunchKeys(),payer:newLaunchKeys().wallet},input:launchInput({name:'Assigned coin',symbol:'COIN',quoteMint:USDC_MINT,feeMode:'creator',recipient:receiverWallet}),review:{minimumSol:'0.02',quoteDecimals:6,quoteSymbol:'USDC',privateProvider:'SECRET_REVIEW'},feeCustody:'relay',authorizedAt:START,createdAt:START,lastCycle:START,state:'live',curve:address(),credits:{quote:'1230000',base:'0'},operations:[],gas:{day:'2023-11-14',reserved:'0'},autoFees:false,error:'SECRET_RPC_TOKEN'};
  const books=new Map([[OWNER,{version:1,launches:[launch]}],[RECEIVER,{version:1,launches:[]}],[OTHER,{version:1,launches:[]}]]),writes=[],kicks=[],storeRequests=[];
  const accounts={get:async id=>structuredClone(people.get(id)),list:async()=>structuredClone([...people.values()]),storeFor:id=>{storeRequests.push(id);return {dir:join(dir,id),read:async(_name,fallback)=>structuredClone(books.get(id)||fallback),write:async(_name,value)=>{writes.push(id);books.set(id,structuredClone(value));}};}};
  const manager=new Launchpad(accounts,null,{now:()=>START});manager.kick=id=>kicks.push(id);const service=new LaunchFeeAssignments({accounts,launchpad:manager,now:()=>START});
  let session={account:people.get(RECEIVER),authMethod:'wallet',walletVerified:true,walletAddress:receiverWallet};
  const context={authorize:async()=>structuredClone(session)},body=(extra={})=>({ownerAccountId:OWNER,id:LAUNCH,requestId:randomUUID(),...extra});
  t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});
  return {accounts,people,books,writes,kicks,storeRequests,manager,service,context,body,receiverWallet,get l(){return books.get(OWNER).launches[0];},get session(){return session;},set session(value){session=value;},async edit(fn){await manager.locked(OWNER,async book=>{fn(book.launches[0]);await manager.save(OWNER,book);});}};
}

test('assigned entries are private, sanitized, and keep original public attribution and book ownership',async t=>{
  const h=await harness(t),before=structuredClone(h.books),result=await h.service.list(RECEIVER,h.context),row=result.assignments[0];
  assert.equal(result.requiresWalletSignIn,false);assert.equal(row.creator.username,'originaldev');assert.equal(row.ownerAccountId,OWNER);assert.equal(row.collectedDisplay,'1.23');assert.equal(row.claim.available,true);assert.equal(row.claim.busy,false);
  assert.doesNotMatch(JSON.stringify(result),/SECRET|secret|privateProvider|unsignedRaw|rawHash|recipientFeeClaims/);assert.deepEqual(h.books,before);assert.deepEqual(h.writes,[]);
  assert.equal((await h.manager.read(RECEIVER)).launches.length,0);assert.equal((await h.manager.read(OWNER)).launches[0].id,LAUNCH);
  for(const action of ['fees','pause','resume'])await assert.rejects(h.manager.action(RECEIVER,LAUNCH,action),/not found in this account/);
  assert.equal(h.books.get(RECEIVER).launches.length,0);assert.equal(h.people.get(OWNER).username,'originaldev');
});

test('only current verified session wallet grants a claim; body wallet and account overrides are ignored',async t=>{
  const h=await harness(t);h.session={account:h.people.get(OTHER),authMethod:'wallet',walletVerified:true,walletAddress:h.people.get(OTHER).mainWallet};
  assert.equal((await h.service.list(OTHER,h.context)).assignments.length,0);
  await assert.rejects(h.service.claim(OTHER,h.body({wallet:h.receiverWallet,recipient:h.receiverWallet,accountId:RECEIVER}),h.context),{statusCode:403});assert.equal(h.l.feesRequested,undefined);
  h.session={account:h.people.get(RECEIVER),authMethod:'wallet',walletVerified:true,walletAddress:h.receiverWallet};
  const result=await h.service.claim(RECEIVER,h.body({wallet:address(),recipient:address()}),h.context);assert.equal(result.assignment.recipient,h.receiverWallet);assert.equal(h.l.input.recipient,h.receiverWallet);assert.equal(h.l.feesRequested,true);assert.deepEqual(h.kicks,[OWNER]);
});

test('password-only sessions cannot claim; linked-wallet sign-in uses proven signInWallet rather than account mainWallet',async t=>{
  const h=await harness(t),account=h.people.get(RECEIVER);account.authType='password';account.signInWallet=h.receiverWallet;account.mainWallet=address();h.session={account,authMethod:'password',walletVerified:false,walletAddress:null};
  assert.deepEqual(await h.service.list(RECEIVER,h.context),{wallet:null,assignments:[],requiresWalletSignIn:true,refreshMs:5000});await assert.rejects(h.service.claim(RECEIVER,h.body(),h.context),{statusCode:403});
  h.session={account,authMethod:'wallet',walletVerified:true,walletAddress:h.receiverWallet};assert.equal((await h.service.list(RECEIVER,h.context)).assignments.length,1);await h.service.claim(RECEIVER,h.body(),h.context);assert.equal(h.l.feesRequested,true);
  delete account.signInWallet;await assert.rejects(h.service.claim(RECEIVER,h.body(),h.context),{statusCode:401});
});

test('managed dedicated untaxed creator custody is required, including cross-launch and personal key exclusion',async t=>{
  const variants=[l=>{l.keys.wallet.exportedAt=START;},l=>{l.feeWalletExportedAt=START;},l=>{l.keys.wallet.external=true;},l=>{delete l.keys.wallet.secret;},l=>{l.keys.wallet.compromisedAt=START;},l=>{l.feeCustody='creator';},l=>{l.input.feeMode='holders';l.input.taxBps=200;},l=>{l.input.feeMode='buyback';},l=>{l.input.taxBps=200;},l=>{l.keys.payer=l.keys.wallet;}];
  for(const change of variants){const h=await harness(t);change(h.l);await assert.rejects(h.service.claim(RECEIVER,h.body(),h.context),{statusCode:403});assert.equal(h.l.feesRequested,undefined);}
  const shared=await harness(t);shared.books.get(OTHER).launches.push({...structuredClone(shared.l),id:'e'.repeat(32),keys:{...newLaunchKeys(),payer:structuredClone(shared.l.keys.wallet)}});await assert.rejects(shared.service.claim(RECEIVER,shared.body(),shared.context),{statusCode:403});
  const personal=await harness(t);personal.people.get(OTHER).signInWallet=personal.l.keys.wallet.address;await assert.rejects(personal.service.claim(RECEIVER,personal.body(),personal.context),{statusCode:403});
});

test('reassignment serialized ahead of a claim revokes the previous recipient before any write',async t=>{
  const h=await harness(t),entered=deferred(),release=deferred();
  const admin=h.manager.locked(OWNER,async book=>{entered.resolve();await release.promise;book.launches[0].input.recipient=h.people.get(OTHER).mainWallet;await h.manager.save(OWNER,book);});await entered.promise;
  const claim=h.service.claim(RECEIVER,h.body(),h.context),denied=assert.rejects(claim,{statusCode:403});release.resolve();await Promise.all([admin,denied]);assert.equal(h.l.feesRequested,undefined);assert.equal(h.l.recipientFeeClaims,undefined);assert.equal((await h.service.list(RECEIVER,h.context)).assignments.length,0);
});

test('logout and wallet unlink while waiting for original book lock are revalidated',async t=>{
  for(const revoke of [h=>{h.session=null;},h=>{h.people.get(RECEIVER).mainWallet=address();}]){
    const h=await harness(t),entered=deferred(),release=deferred(),checked=deferred();let calls=0;const context={authorize:async()=>{if(++calls===1)checked.resolve();return structuredClone(h.session);}};
    const blocker=h.manager.locked(OWNER,async()=>{entered.resolve();await release.promise;});await entered.promise;const claiming=h.service.claim(RECEIVER,h.body(),context),denied=assert.rejects(claiming,{statusCode:401});await checked.promise;revoke(h);release.resolve();await Promise.all([blocker,denied]);assert.equal(h.l.feesRequested,undefined);assert.equal(h.l.recipientFeeClaims,undefined);
  }
});

test('concurrent original-owner and recipient requests share one journal and preserve signed pending bytes',async t=>{
  const h=await harness(t),op={kind:'payout',state:'pending',signature:'2'.repeat(88),raw:'SAVED_SIGNED_BYTES',unsignedRaw:'SECRET_UNSIGNED',createdAt:START,payouts:[{owner:h.receiverWallet,amount:'1230000'}]},cycle={stage:'payout',index:0,payouts:op.payouts};h.l.operations=[op];h.l.cycle=cycle;
  const request=h.body();await Promise.all([h.manager.action(OWNER,LAUNCH,'fees'),h.service.claim(RECEIVER,request,h.context),h.service.claim(RECEIVER,request,h.context)]);
  assert.equal(h.l.operations.length,1);assert.deepEqual(h.l.operations[0],op);assert.equal(h.l.cycle.stage,'payout');assert.equal(h.l.cycle.index,0);assert.deepEqual(h.l.cycle.payouts,cycle.payouts);assert.equal(h.l.recipientFeeClaims.length,1);assert.equal(h.l.feesRequested,true);assert.equal(h.books.get(RECEIVER).launches.length,0);
  const row=(await h.service.list(RECEIVER,h.context)).assignments[0];assert.deepEqual(row.operations[0],{kind:'payout',state:'pending',signature:op.signature,createdAt:START,confirmedAt:null});assert.doesNotMatch(JSON.stringify(row),/SAVED_SIGNED|SECRET_UNSIGNED/);
});

test('request IDs remain idempotent after settlement and still require current assignment',async t=>{
  const h=await harness(t),request=h.body();await h.service.claim(RECEIVER,request,h.context);await h.edit(l=>{l.feesRequested=false;l.manualFeesRequested=false;l.lastCycle=START+1;l.lastFeeClaim={at:START+1,result:'empty'};});
  const retried=await h.service.claim(RECEIVER,request,h.context);assert.equal(retried.alreadyRequested,true);assert.equal(h.l.feesRequested,false);assert.equal(retried.assignment.lastClaimResult,'empty');assert.equal(h.l.recipientFeeClaims.length,1);
  await h.edit(l=>{l.input.recipient=address();});await assert.rejects(h.service.claim(RECEIVER,request,h.context),{statusCode:403});
});

test('a paused failed payout resumes its saved unpaid batch without re-claiming the vault',async t=>{
  const h=await harness(t),batch=[{owner:h.receiverWallet,amount:'1230000'}];h.l.state='paused';h.l.feesRequested=false;h.l.cycle={stage:'payout',index:0,payouts:batch};h.l.operations=[{kind:'claim',state:'confirmed',signature:'3'.repeat(88)},{kind:'payout',state:'failed',signature:'4'.repeat(88),payouts:batch}];
  const before=(await h.service.list(RECEIVER,h.context)).assignments[0];assert.equal(before.claim.available,true);assert.equal(before.claim.busy,false);assert.equal(before.claim.status,'paused');
  const result=await h.service.claim(RECEIVER,h.body(),h.context);assert.equal(result.alreadyRequested,false);assert.equal(h.l.state,'live');assert.equal(h.l.feesRequested,true);assert.deepEqual(h.l.cycle,{stage:'payout',index:0,payouts:batch,manual:true});assert.equal(h.l.operations.length,2);assert.equal(h.l.credits.quote,'1230000');assert.equal(h.l.error,'');
  const submissions=[],claims=[];let receipt=null;
  h.manager.chainFactory=()=>({close(){},claimInstructions:async()=>{claims.push('unexpected');throw Error('Existing payout must not re-claim');},payoutInstructions:async(_l,rows)=>{assert.deepEqual(rows,batch);return rows;},prepare:async()=>({kind:'payout',state:'pending',raw:'durable-payout',signature:'5'.repeat(88),createdAt:START,lastValidBlockHeight:100}),broadcast:async op=>{assert.equal(h.l.operations.at(-1).raw,op.raw);submissions.push(op.signature);},receipt:async()=>receipt,c:{getBlockHeight:async()=>1}});
  await h.manager.process(OWNER);assert.equal(h.l.operations.at(-1).kind,'payout');assert.deepEqual(h.l.operations.at(-1).payouts,batch);assert.equal(submissions.length,1);assert.deepEqual(claims,[]);
  const wallet=h.l.keys.wallet.address,row=units=>({owner:wallet,mint:USDC_MINT,accountIndex:1,uiTokenAmount:{amount:String(units)}});
  receipt={slot:42,transaction:{message:{accountKeys:[new PublicKey(wallet)]}},meta:{err:null,fee:5000,preBalances:[100000000],postBalances:[99995000],preTokenBalances:[row(1230000)],postTokenBalances:[row(0)]}};
  await h.manager.process(OWNER);assert.equal(h.l.operations.at(-1).state,'confirmed');assert.equal(h.l.credits.quote,'0');await h.manager.process(OWNER);assert.equal(h.l.cycle,null);assert.equal(h.l.feesRequested,false);assert.equal(h.l.lastFeeClaim.result,'claimed');assert.equal(submissions.length,1);assert.deepEqual(claims,[]);

});

test('community recipient remains eligible when original owner is banned, while recipient ban revokes access',async t=>{
  const h=await harness(t);h.people.get(OWNER).banned=true;assert.equal((await h.service.list(RECEIVER,h.context)).assignments.length,1);await h.service.claim(RECEIVER,h.body(),h.context);assert.equal(h.l.feesRequested,true);
  h.people.get(RECEIVER).banned=true;await assert.rejects(h.service.claim(RECEIVER,h.body(),h.context),{statusCode:401});await assert.rejects(h.service.list(RECEIVER,h.context),{statusCode:401});
});

test('unknown owners and malformed requests fail without creating private account stores',async t=>{
  const h=await harness(t);await assert.rejects(h.service.claim(RECEIVER,h.body({ownerAccountId:'f'.repeat(32)}),h.context),{statusCode:403});assert.deepEqual(h.storeRequests,[]);
  for(const body of [h.body({id:'../private'}),h.body({requestId:'same'}),h.body({ownerAccountId:null})])await assert.rejects(h.service.claim(RECEIVER,body,h.context),{statusCode:400});assert.deepEqual(h.storeRequests,[]);
});


test('queued recipient claims block actual admin reassignment until their saved payout completes',async t=>{
  const h=await harness(t);h.l.credits.quote='0';Object.assign(h.people.get(OTHER),{role:'admin',mfaEnabled:true});
  const admin=new LaunchpadAdmin({accounts:h.accounts,launchpad:h.manager,now:()=>START}),request={accountId:OWNER,id:LAUNCH,recipient:address(),expectedRecipient:h.receiverWallet,expectedMode:'creator',reason:'Verified community reassignment.'};
  await h.service.claim(RECEIVER,h.body(),h.context);await assert.rejects(admin.update(OTHER,request),/in progress/);assert.equal(h.l.input.recipient,h.receiverWallet);
  await h.edit(l=>{l.feesRequested=false;l.manualFeesRequested=false;l.cycle=null;});await admin.update(OTHER,request);assert.equal(h.l.input.recipient,request.recipient);await assert.rejects(h.service.claim(RECEIVER,h.body(),h.context),{statusCode:403});assert.equal((await h.service.list(RECEIVER,h.context)).assignments.length,0);
});
