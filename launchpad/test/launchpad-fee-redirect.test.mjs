import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Launchpad,publicLaunch} from '../src/launchpad.mjs';
import {LaunchFeeAssignments} from '../src/launchpad-fee-assignments.mjs';
import {LaunchpadAdmin} from '../src/launchpad-admin.mjs';
import {creatorFeeRedirectStatus,feeRecipientRedirectUsed} from '../src/launchpad-fee-routing.mjs';
import {newLaunchKeys} from '../src/launchpad-receipts.mjs';
import {USDC_MINT} from '../public/launchpad-model.mjs';

const OWNER='a'.repeat(32),RECEIVER='b'.repeat(32),OTHER='c'.repeat(32),LAUNCH='d'.repeat(32),START=1700000000000;
const address=()=>newLaunchKeys().wallet.address;
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return{promise,resolve};};
async function harness(t){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-fee-redirect-')),original=address(),recipient=address();
  const people=new Map([[OWNER,{id:OWNER,username:'originalcreator',authType:'wallet',mainWallet:original}],[RECEIVER,{id:RECEIVER,username:'recipient',authType:'wallet',mainWallet:recipient}],[OTHER,{id:OTHER,username:'admin',authType:'wallet',mainWallet:address(),role:'admin',mfaEnabled:true}]]);
  const launch={id:LAUNCH,keys:{...newLaunchKeys(),payer:{address:original,external:true}},input:{route:'raydium',network:'mainnet-beta',name:'Original coin',symbol:'COIN',quoteMint:USDC_MINT,feeMode:'creator',recipient:original,taxBps:0,walletMode:'external',externalWallet:original,dailyGasLamports:'50000000'},review:{minimumSol:'0.02',quoteDecimals:6,quoteSymbol:'USDC'},feeCustody:'relay',authorizedAt:START,createdAt:START,lastCycle:START,state:'live',curve:address(),credits:{quote:'0',base:'0'},operations:[],gas:{day:'2023-11-14',reserved:'0'},autoFees:false};
  const books=new Map([[OWNER,{version:1,launches:[launch]}],[RECEIVER,{version:1,launches:[]}],[OTHER,{version:1,launches:[]}]]),writes=[];
  const accounts={get:async id=>structuredClone(people.get(id)),list:async()=>structuredClone([...people.values()]),storeFor:id=>({dir:join(dir,id),read:async(_n,fallback)=>structuredClone(books.get(id)||fallback),write:async(_n,value)=>{writes.push(id);books.set(id,structuredClone(value));}})};
  const manager=new Launchpad(accounts,null,{now:()=>START});manager.kick=()=>{};
  const service=new LaunchFeeAssignments({accounts,launchpad:manager,now:()=>START}),admin=new LaunchpadAdmin({accounts,launchpad:manager,now:()=>START});
  let current=OWNER;
  const context={authorize:async()=>current?{account:structuredClone(people.get(current)),authMethod:'wallet',walletVerified:true,walletAddress:people.get(current).mainWallet}:null};
  const body=extra=>({id:LAUNCH,recipient,expectedRecipient:original,requestId:randomUUID(),...extra});
  t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});
  return{manager,service,admin,accounts,people,books,writes,context,original,recipient,body,get l(){return books.get(OWNER).launches[0];},login(id){current=id;}};
}

test('original verified creator redirects once while ownership, profile, authority and accounting remain unchanged',async t=>{
  const h=await harness(t),before=structuredClone(h.l),request=h.body(),result=await h.service.redirect(OWNER,request,h.context);
  assert.equal(result.alreadyRedirected,false);assert.equal(result.launch.input.recipient,h.recipient);assert.equal(result.launch.feeRedirect.used,true);assert.equal(result.launch.feeRedirect.allowed,false);
  assert.deepEqual(h.l.keys,before.keys);assert.deepEqual(h.l.credits,before.credits);assert.deepEqual(h.l.operations,before.operations);assert.deepEqual(h.l.gas,before.gas);assert.equal(h.l.input.feeMode,'creator');assert.equal(h.people.get(OWNER).username,'originalcreator');assert.equal(h.books.get(RECEIVER).launches.length,0);
  assert.equal(h.l.feeRecipientHistory.length,1);assert.equal(h.l.feeRecipientRedirect.originalWallet,h.original);assert.doesNotMatch(JSON.stringify(result),/secret|requestId|actorId/);
  await assert.rejects(h.service.redirect(OWNER,h.body({recipient:address(),expectedRecipient:h.recipient}),h.context),/one-time/);
  const retry=await h.service.redirect(OWNER,request,h.context);assert.equal(retry.alreadyRedirected,true);assert.equal(h.l.feeRecipientHistory.length,1);assert.equal(h.writes.length,1);
  await assert.rejects(h.service.redirect(OWNER,{...request,recipient:address()},h.context),/already used/);
});

test('recipient can claim after redirect but recipient and stranger cannot redirect or take launch ownership',async t=>{
  const h=await harness(t);await h.service.redirect(OWNER,h.body(),h.context);
  h.login(RECEIVER);assert.equal((await h.service.list(RECEIVER,h.context)).assignments[0].creator.username,'originalcreator');
  await h.service.claim(RECEIVER,{ownerAccountId:OWNER,id:LAUNCH,requestId:randomUUID()},h.context);assert.equal(h.l.feesRequested,true);
  for(const actor of [RECEIVER,OTHER]){h.login(actor);await assert.rejects(h.service.redirect(actor,h.body({ownerAccountId:OWNER,accountId:OWNER,originalWallet:h.original}),h.context),/Only the original creator/);}
  assert.equal(h.l.input.recipient,h.recipient);assert.equal(h.books.get(RECEIVER).launches.length,0);
});

test('creator redirect requires current original wallet proof, not password login or current owner account alone',async t=>{
  const h=await harness(t),before=structuredClone(h.l);
  await assert.rejects(h.service.redirect(OWNER,h.body(),{authorize:async()=>({account:h.people.get(OWNER),authMethod:'password',walletVerified:false})}),{statusCode:403});
  h.people.get(OWNER).mainWallet=address();await assert.rejects(h.service.redirect(OWNER,h.body(),h.context),/Only the original creator/);assert.deepEqual(h.l,before);
});

test('linked wallet sign-in can authorize only the retained original creator wallet',async t=>{
  const h=await harness(t),account=h.people.get(OWNER);account.authType='password';account.mainWallet=address();account.signInWallet=h.original;
  const context={authorize:async()=>({account,authMethod:'wallet',walletVerified:true,walletAddress:h.original})};
  await h.service.redirect(OWNER,h.body(),context);assert.equal(h.l.input.recipient,h.recipient);
});

test('legacy redirect history, durable marker and changed beneficiary all consume the one-time allowance',async t=>{
  for(const change of [l=>{l.feeRecipientHistory=[{from:l.input.recipient,to:l.input.recipient}];},l=>{l.feeRecipientHistory={corrupt:true};},l=>{l.feeRecipientRedirectedAt=0;},l=>{l.input.recipient=address();}]){
    const h=await harness(t);change(h.l);const before=structuredClone(h.l);assert.equal(feeRecipientRedirectUsed(h.l),true);
    await assert.rejects(h.service.redirect(OWNER,h.body({expectedRecipient:h.l.input.recipient}),h.context),/one-time/);assert.deepEqual(h.l,before);
  }
});

test('holder obligations, compromised custody and pending credits cannot be diverted',async t=>{
  const changes=[l=>{l.input.feeMode='holders';},l=>{l.input.feeMode='buyback';},l=>{l.input.taxBps=200;},l=>{l.keys.wallet.compromisedAt=START;},l=>{l.keys.wallet.exportedAt=START;},l=>{l.feeCustody='creator';},l=>{l.operations=[{state:'pending',raw:'saved-wire'}];},l=>{l.cycle={stage:'payout'};},l=>{l.feesRequested=true;},l=>{l.credits.quote='1';},l=>{l.credits.base='1';},l=>{delete l.keys.payer;},l=>{l.input.externalWallet=address();}];
  for(const change of changes){const h=await harness(t);change(h.l);const before=structuredClone(h.l);assert.equal(creatorFeeRedirectStatus(h.l).allowed,false);await assert.rejects(h.service.redirect(OWNER,h.body(),h.context));assert.deepEqual(h.l,before);}
});

test('cross-launch and personal fee wallet reuse are checked at commit',async t=>{
  const h=await harness(t);h.books.get(OTHER).launches.push({...structuredClone(h.l),id:'e'.repeat(32)});await assert.rejects(h.service.redirect(OWNER,h.body(),h.context),/shared or personal/);
  h.books.get(OTHER).launches=[];h.people.get(OTHER).signInWallet=h.l.keys.wallet.address;await assert.rejects(h.service.redirect(OWNER,h.body(),h.context),/shared or personal/);assert.equal(h.writes.length,0);
});

test('creator and preserved admin route share one durable redirect limit in either order',async t=>{
  for(const first of ['creator','admin']){
    const h=await harness(t),adminBody={accountId:OWNER,id:LAUNCH,recipient:h.recipient,expectedRecipient:h.original,expectedMode:'creator',reason:'Existing administrator takeover authorization.'};
    if(first==='creator')await h.service.redirect(OWNER,h.body(),h.context);else await h.admin.update(OTHER,adminBody);
    await assert.rejects(h.service.redirect(OWNER,h.body({recipient:address(),expectedRecipient:h.recipient}),h.context),/one-time/);
    await assert.rejects(h.admin.update(OTHER,{...adminBody,recipient:address(),expectedRecipient:h.recipient}),/one-time/);
    assert.equal(h.l.feeRecipientHistory.length,1);assert.equal(h.l.input.recipient,h.recipient);
  }
});

test('concurrent redirects serialize and commit exactly one recipient',async t=>{
  const h=await harness(t),requests=[h.body(),h.body({recipient:address()})];
  const results=await Promise.allSettled(requests.map(request=>h.service.redirect(OWNER,request,h.context)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/one-time/);assert.equal(h.l.feeRecipientHistory.length,1);assert.equal(h.writes.length,1);
});

test('simultaneous creator and admin redirects cannot bypass the shared lock',async t=>{
  const h=await harness(t),other=address();
  const results=await Promise.allSettled([h.service.redirect(OWNER,h.body(),h.context),h.admin.update(OTHER,{accountId:OWNER,id:LAUNCH,recipient:other,expectedRecipient:h.original,expectedMode:'creator',reason:'Existing administrator takeover authorization.'})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/one-time/);assert.equal(h.l.feeRecipientHistory.length,1);assert.ok([h.recipient,other].includes(h.l.input.recipient));assert.equal(h.writes.length,1);
});

test('invalid, internal and unchanged recipient addresses cannot consume the allowance',async t=>{
  const h=await harness(t);
  for(const recipient of ['invalid',h.original,h.l.keys.wallet.address,h.l.keys.mint.address])await assert.rejects(h.service.redirect(OWNER,h.body({recipient}),h.context),{statusCode:400});
  assert.equal(h.writes.length,0);assert.equal(creatorFeeRedirectStatus(h.l).used,false);
  h.l.input.route='pumpswap';assert.equal(creatorFeeRedirectStatus(h.l).allowed,false);assert.match(creatorFeeRedirectStatus(h.l).reason,/cannot redirect/);
});

test('logout or wallet unlink while waiting for lock is rechecked without mutation',async t=>{
  for(const revoke of [h=>h.login(null),h=>{h.people.get(OWNER).mainWallet=address();}]){
    const h=await harness(t),entered=deferred(),release=deferred(),seen=deferred();let calls=0;
    const context={authorize:async()=>{const session=await h.context.authorize();if(++calls===1)seen.resolve();return session;}};
    const blocker=h.manager.locked(OWNER,async()=>{entered.resolve();await release.promise;});await entered.promise;
    const request=h.service.redirect(OWNER,h.body(),context),denied=assert.rejects(request,{statusCode:401});await seen.promise;revoke(h);release.resolve();await Promise.all([blocker,denied]);assert.equal(h.writes.length,0);assert.equal(h.l.input.recipient,h.original);
  }
});

test('identity revocation during inventory prevents commit, and private state projection remains secret-free',async t=>{
  const h=await harness(t),list=h.accounts.list;h.accounts.list=async()=>{const rows=await list();h.people.get(OWNER).banned=true;return rows;};
  await assert.rejects(h.service.redirect(OWNER,h.body(),h.context),{statusCode:401});assert.equal(h.writes.length,0);
  assert.equal(publicLaunch(h.l).feeRedirect.originalWallet,h.original);assert.doesNotMatch(JSON.stringify(publicLaunch(h.l)),/secret|feeRecipientHistory/);
});
