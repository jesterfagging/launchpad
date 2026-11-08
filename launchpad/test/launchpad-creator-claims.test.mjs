import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PublicKey } from '@solana/web3.js';
import { Launchpad, publicLaunch } from '../src/launchpad.mjs';
import { newLaunchKeys } from '../src/launchpad-receipts.mjs';
import { launchInput, SOL_MINT, USDC_MINT } from '../public/launchpad-model.mjs';

function live(number, overrides={}) {
  const keys=newLaunchKeys(),input=launchInput({name:'Claim '+number,symbol:'CLM',feeMode:'creator',quoteMint:USDC_MINT});
  input.recipient=keys.wallet.address;
  return {id:number.toString(16).padStart(32,'0'),keys,input,review:{minimumSol:'0.01',quoteDecimals:6,price:{usd:'1'}},state:'live',phase:'verify',curve:keys.mint.address,authorizedAt:1,createdAt:1,operations:[],credits:{quote:'0',base:'0'},autoFees:false,feesRequested:false,gas:{day:new Date().toISOString().slice(0,10),reserved:'0'},...overrides};
}
async function harness(t,launches) {
  const dir=await mkdtemp(join(tmpdir(),'launchpad-creator-claims-')),books=new Map([['a',{version:1,launches:structuredClone(launches)}]]),prepared=[],broadcasts=[];
  const accounts={dir,get:async()=>({mainWallet:launches[0]?.keys.wallet.address}),storeFor:id=>({dir:join(dir,id),read:async(_,fallback)=>structuredClone(books.get(id)||fallback),write:async(_,value)=>books.set(id,structuredClone(value))})};
  const chain={c:{getBlockHeight:async()=>1},claimInstructions:async()=>['claim'],payoutInstructions:async(_,payouts)=>payouts.map(x=>({to:x.owner,amount:x.amount})),receipt:async()=>null,
    prepare:async(l,instructions)=>{
      const index=prepared.length+1;prepared.push({launchId:l.id,instructions});
      return {createdAt:Date.now(),lastValidBlockHeight:100,...(l.keys.wallet.external?{state:'awaiting_signature',needsSignature:true,unsignedRaw:'unsigned-'+index,externalSigner:l.keys.wallet.address}:{state:'pending',signature:'signed-'+index,raw:'raw-'+index})};
    },broadcast:async op=>{assert([...books.values()].some(book=>book.launches.some(l=>l.operations.some(x=>x.signature===op.signature&&x.raw===op.raw))));broadcasts.push(op.signature);}};
  const manager=new Launchpad(accounts,null,{chainFactory:()=>chain});manager.kick=()=>{};
  t.after(async()=>{await manager.close();await rm(dir,{recursive:true,force:true});});
  return {manager,chain,books,prepared,broadcasts,get saved(){return books.get('a').launches;}};
}
function receipt(l,{quote=0n,base=0n,err=null}={}){
  const owner=l.keys.wallet.address,row=(mint,amount,index)=>({accountIndex:index,owner,mint,uiTokenAmount:{amount:String(amount)}});
  return {slot:99,transaction:{message:{accountKeys:[new PublicKey(owner)]}},meta:{err,fee:5000,preBalances:[100000000],postBalances:[99995000],preTokenBalances:[row(l.input.quoteMint,100000000n,1),row(l.keys.mint.address,100000000n,2)],postTokenBalances:[row(l.input.quoteMint,100000000n+quote,1),row(l.keys.mint.address,100000000n+base,2)]}};
}

test('claim all queues only confirmed creator launches owned by this account and recovers paused work',async t=>{
  const ready=live(1),paused=live(2,{state:'paused',error:'RPC offline'}),managed=live(3),draft=live(4,{state:'draft',curve:null}),archived=live(5);
  managed.input.feeMode='holders';archived.input.route='pump';
  const h=await harness(t,[ready,paused,managed,draft,archived]);
  h.books.set('b',{launches:[live(6)]});
  const first=await h.manager.claimAll('a');assert.deepEqual(first.queued,[ready.id,paused.id]);assert.equal(first.skipped.length,3);assert.equal(h.books.get('b').launches[0].feesRequested,false);
  assert.equal(h.saved[1].state,'live');assert.equal(h.saved[1].error,'');
  const second=await h.manager.claimAll('a');assert.deepEqual(second.queued,[]);assert.deepEqual(second.active,first.queued);
  assert.equal(h.prepared.length,0,'queueing does not broadcast inside the HTTP mutation');
  await assert.rejects(h.manager.action('b',ready.id,'fees'),/not found/);
  const output=JSON.stringify(first);for(const l of h.saved)assert(!output.includes(l.keys.wallet.secret));
});

test('repeated per-coin claims preserve pending signed bytes and never replace an unresolved transaction',async t=>{
  const l=live(1),h=await harness(t,[l]);
  await h.manager.action('a',l.id,'fees');await h.manager.process('a');
  const op=structuredClone(h.saved[0].operations[0]);
  await h.manager.action('a',l.id,'fees');await h.manager.claimAll('a');await h.manager.process('a');
  assert.equal(h.prepared.length,1);assert.deepEqual(h.saved[0].operations[0],op);assert.equal(h.broadcasts.length,1);
  assert.equal(publicLaunch(h.saved[0]).feeClaim.status,'pending');
});

test('legacy connected creator requests retain their required signer across claim-all retries',async t=>{
  const l=live(1);l.keys.wallet={address:l.keys.wallet.address,external:true};l.input.walletMode='external';l.input.externalWallet=l.keys.wallet.address;
  const h=await harness(t,[l]);await h.manager.claimAll('a');await h.manager.process('a');
  const first=publicLaunch(h.saved[0]);assert.equal(first.feeClaim.requiresSignature,true);assert.equal(first.feeClaim.scope,'wallet_quote');assert.equal(first.pendingSignature.wallet,l.keys.wallet.address);
  await h.manager.action('a',l.id,'fees');await h.manager.claimAll('a');await h.manager.process('a');
  assert.equal(h.prepared.length,1);assert.equal(h.broadcasts.length,0);assert.deepEqual(publicLaunch(h.saved[0]).pendingSignature,first.pendingSignature);
});

test('coins sharing a legacy creator and quote vault do not prepare overlapping fee claims',async t=>{
  const first=live(1),second=live(2);second.keys.wallet=first.keys.wallet;second.input.recipient=first.keys.wallet.address;
  const h=await harness(t,[first,second]);await h.manager.claimAll('a');await h.manager.process('a');
  assert.equal(h.prepared.length,1);assert.equal(h.prepared[0].launchId,first.id);assert.equal(h.saved[1].feesRequested,true);
  await h.manager.process('a');assert.equal(h.prepared.length,1);
  h.chain.receipt=async()=>receipt(h.saved[0],{quote:100n});await h.manager.process('a');
  assert.equal(h.prepared.length,2);assert.equal(h.prepared[1].launchId,second.id);
});

test('zero-fee claims complete without asking a wallet to sign or spending network fees',async t=>{
  const l=live(1),h=await harness(t,[l]);h.chain.claimInstructions=async()=>[];
  await h.manager.action('a',l.id,'fees');await h.manager.process('a');
  assert.equal(h.prepared.length,0);assert.equal(h.broadcasts.length,0);assert.equal(h.saved[0].feesRequested,false);assert.equal(h.saved[0].cycle,null);assert.equal(h.saved[0].lastFeeClaim.result,'empty');
});

test('SPL fees delivered directly to a legacy creator clear credits even below the managed-service floor',async t=>{
  const l=live(1),h=await harness(t,[l]);await h.manager.action('a',l.id,'fees');await h.manager.process('a');
  h.chain.receipt=async()=>receipt(h.saved[0],{quote:2500n,base:50n});await h.manager.process('a');await h.manager.process('a');
  assert.deepEqual(h.saved[0].credits,{quote:'0',base:'0'});assert.equal(h.saved[0].lastFeeClaim.quote,'2500');assert.equal(h.saved[0].lastFeeClaim.base,'50');assert.equal(h.saved[0].lastFeeClaim.result,'claimed');assert.equal(h.prepared.length,1,'fees are already in the creator wallet');
});

test('new per-coin fee wallets forward small creator claims and retain credit until a verified payout',async t=>{
  const l=live(1,{feeCustody:'relay'});l.keys.payer={address:newLaunchKeys().wallet.address,external:true};l.input.walletMode='external';l.input.recipient=l.keys.payer.address;
  const h=await harness(t,[l]);assert.equal(publicLaunch(l).feeClaim.requiresSignature,false);assert.equal(publicLaunch(l).feeClaim.scope,'coin');
  await h.manager.claimAll('a');await h.manager.process('a');h.chain.receipt=async()=>receipt(h.saved[0],{quote:500n});await h.manager.process('a');await h.manager.process('a');
  assert.equal(h.saved[0].credits.quote,'500');assert.equal(h.prepared.length,2);assert.equal(h.saved[0].operations[1].kind,'payout');assert.equal(h.saved[0].operations[1].amount,'500');assert.equal(h.prepared[1].instructions[0].to,l.input.recipient);
  h.chain.receipt=async()=>receipt(h.saved[0],{quote:-500n});await h.manager.process('a');await h.manager.process('a');assert.equal(h.saved[0].credits.quote,'0');assert.equal(h.saved[0].feesRequested,false);
});

test('manual creator SOL claims unwrap sub-dollar fees instead of retaining an invisible balance',async t=>{
  const l=live(1);l.input.quoteMint=SOL_MINT;l.review.quoteDecimals=9;l.review.price.usd='100';
  l.cycle={stage:'distribute',index:0};l.credits.quote='100000';l.feesRequested=true;
  const h=await harness(t,[l]);await h.manager.action('a',l.id,'fees');await h.manager.process('a');assert.equal(h.saved[0].operations[0].kind,'payout');assert.equal(h.saved[0].operations[0].amount,'100000');assert.equal(h.saved[0].credits.quote,'100000');
});

test('automatic creator forwarding retains dust until explicitly claimed instead of spending payout gas on it',async t=>{
  const l=live(1,{feeCustody:'relay',autoFees:true});l.input.recipient=newLaunchKeys().wallet.address;l.credits.quote='500';
  const h=await harness(t,[l]);h.chain.claimInstructions=async()=>[];await h.manager.process('a');
  assert.equal(h.saved[0].credits.quote,'500');assert.equal(h.prepared.length,0);assert.equal(h.saved[0].cycle,null);
  await h.manager.action('a',l.id,'fees');await h.manager.process('a');assert.equal(h.prepared.length,1);assert.equal(h.saved[0].operations[0].kind,'payout');
});

test('retrying a failed payout resumes its saved recipient batch and does not claim the vault again',async t=>{
  const l=live(1,{feeCustody:'relay',state:'paused',error:'Payout failed'}),recipient=newLaunchKeys().wallet.address;
  l.input.recipient=recipient;l.credits.quote='27';l.cycle={stage:'payout',index:1,payouts:[{owner:recipient,amount:'5'},{owner:recipient,amount:'27'}]};
  const h=await harness(t,[l]);h.chain.claimInstructions=async()=>{throw Error('Do not restart the fee claim');};
  await h.manager.action('a',l.id,'fees');await h.manager.process('a');assert.deepEqual(h.saved[0].operations[0].payouts,[{owner:recipient,amount:'27'}]);assert.equal(h.saved[0].operations[0].kind,'payout');
});
