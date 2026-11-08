import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { directBurnRecord, publicDirectBurnAnalytics, publicCombinedBurnAnalytics } from '../src/public-direct-burns.mjs';
import { PublicAnalytics } from '../src/public-analytics.mjs';
import { AdminVolume } from '../src/admin-volume.mjs';
import { ray } from '../src/launchpad-chain.mjs';
import { TAX_BURN_MINT, TAX_BURN_WALLET, TAX_BURN_POLICY } from '../src/launchpad-rewards-wallet.mjs';
import { SOL_MINT } from '../public/launchpad-model.mjs';
import { MANUAL_PROTOCOL_HISTORY } from '../src/protocol-manual-history.mjs';

const NOW = Date.UTC(2026,8,29,9), raw = '50000000000000';
const sig = n => bs58.encode(Buffer.alloc(64,n));
function launch() {
  const op = { kind:'tax-burn',state:'confirmed',taxBurnPolicy:TAX_BURN_POLICY,taxSource:'approved-initial-inventory',signature:sig(51),slot:451590000,confirmedAt:NOW-1000,amount:raw,raw:'PRIVATE_SIGNED_BYTES',receipt:{baseDelta:'-'+raw,quoteDelta:'0'},taxBurnReceipt:{policy:TAX_BURN_POLICY,mint:TAX_BURN_MINT,wallet:TAX_BURN_WALLET,baseUnits:raw,trackedTaxBaseUnits:'1000000',approvedLegacyBaseUnits:(BigInt(raw)-1000000n).toString(),source:'approved-initial-inventory'} };
  return {id:'private-id',state:'live',createdAt:NOW-100000,authorizedAt:NOW-100000,input:{route:'raydium',network:'mainnet-beta',feeMode:'holders',taxBps:200,quoteMint:SOL_MINT,name:'Launchpad',symbol:'LAUNCHPAD'},keys:{mint:{address:TAX_BURN_MINT},rewards:{address:TAX_BURN_WALLET},wallet:{address:'7CUgDFnBdso5L3BoD7PuNF5Dtfh75PJ1tLHVCZRh2tDY'},payer:{address:'7CUgDFnBdso5L3BoD7PuNF5Dtfh75PJ1tLHVCZRh2tDY'}},review:{quoteDecimals:9},credits:{base:'0',quote:'0'},operations:[{kind:'create',state:'confirmed',signature:sig(50),slot:100,confirmedAt:NOW-100000},op],taxBurn:{policy:TAX_BURN_POLICY,burnCount:1,initialInventory:{status:'burned',legacyBurnedBase:op.taxBurnReceipt.approvedLegacyBaseUnits}},taxProtocol:{burnedBase:'1000000'},curve:ray.getPdaLaunchpadPoolId(ray.LAUNCHPAD_PROGRAM,new PublicKey(TAX_BURN_MINT),new PublicKey(SOL_MINT)).publicKey.toBase58()};
}
const treasury = () => ({status:'available',complete:true,curveDecimals:6,curveBurned:'10000000',curveBought:'20000000',solSpent:'1000000000',history:[{kind:'burn',signature:sig(52),inputAmount:'10000000',outputAmount:'0',confirmedAt:NOW-2000}],updatedAt:NOW-2000});

test('official finalized inventory burn projects exact units without keys or purchase cost',()=>{
  const l=launch();Object.defineProperty(l.keys.rewards,'secret',{get(){assert.fail('report must not read a private key');}});
  const record=directBurnRecord(l,NOW);assert.equal(record.complete,true);assert.equal(record.history.length,1);assert.equal(record.history[0].inputAmount,raw);assert.equal(record.history[0].commitment,'finalized');
  assert.doesNotMatch(JSON.stringify(record),/PRIVATE|private-id|solSpent|curveBought|"wallet"|"keys"/);
  const result=publicDirectBurnAnalytics([record,record],{inventoryComplete:true});assert.equal(result.curveBurned,raw);assert.equal(result.history.length,1);
});

test('pending, failed, expired and authorized burns do not count',()=>{
  for(const state of ['pending','failed','expired','awaiting_signature']){const l=launch();l.operations[1].state=state;l.taxBurn.burnCount=0;l.taxBurn.initialInventory={status:'authorized',legacyBurnedBase:'0'};l.taxProtocol.burnedBase='0';const result=directBurnRecord(l,NOW);assert.equal(result.complete,true);assert.equal(result.history.length,0);}
});

test('wrong identities and unverified or inconsistent final receipts cannot inflate burns',()=>{
  for(const mutate of [l=>l.input.network='devnet',l=>l.keys.rewards.address=SOL_MINT,l=>l.operations[1].taxBurnReceipt.mint=SOL_MINT,l=>l.operations[1].taxBurnReceipt.wallet=SOL_MINT,l=>l.operations[1].receipt.baseDelta='-'+(BigInt(raw)-1n),l=>l.operations[1].receipt.quoteDelta='1',l=>l.operations[1].slot=0,l=>l.operations[1].confirmedAt=NOW+6000,l=>l.operations[1].signature='not-a-signature',l=>l.operations[1].taxBurnReceipt.approvedLegacyBaseUnits=raw]){
    const l=launch();mutate(l);const result=directBurnRecord(l,NOW);assert.equal(result.complete,false);assert.deepEqual(result.history,[]);
  }
  const unrelated=launch();unrelated.keys.mint.address=SOL_MINT;assert.equal(directBurnRecord(unrelated,NOW),null);
});

test('receipt totals are checked against saved burn count and tax versus legacy totals',()=>{
  for(const mutate of [l=>l.taxBurn.burnCount=2,l=>l.taxProtocol.burnedBase='2000000',l=>l.taxBurn.initialInventory.legacyBurnedBase='0']){const l=launch();mutate(l);const result=directBurnRecord(l,NOW);assert.equal(result.complete,false);assert.equal(result.history.length,1);}
  const l=launch();l.operations.push(structuredClone(l.operations[1]));assert.equal(directBurnRecord(l,NOW).complete,true);
  l.operations.at(-1).confirmedAt--;assert.equal(directBurnRecord(l,NOW).complete,false);assert.equal(directBurnRecord(l,NOW).history.length,0);
});

test('combined display adds direct burns once and never changes treasury spending or budgets',()=>{
  const managed=treasury(),before=structuredClone(managed),direct=publicDirectBurnAnalytics([directBurnRecord(launch(),NOW)],{inventoryComplete:true});
  const result=publicCombinedBurnAnalytics(managed,direct,[],NOW);assert.equal(result.curveBurned,(BigInt(raw)+10000000n).toString());assert.equal(result.directBurned,raw);assert.equal(result.complete,true);assert.equal(result.history[0].source,'direct');assert.deepEqual(managed,before);assert.equal(Object.hasOwn(result,'solSpent'),false);assert.equal(Object.hasOwn(result,'curveBought'),false);
});

test('full retained treasury receipts and verified manual receipts deduplicate even outside public history',()=>{
  const direct=publicDirectBurnAnalytics([directBurnRecord(launch(),NOW)],{inventoryComplete:true}),row=direct.history[0];
  const managed={...treasury(),curveBurned:raw,history:[]};
  const result=publicCombinedBurnAnalytics(managed,direct,[{...row,state:'confirmed'}],NOW);assert.equal(result.curveBurned,raw);assert.equal(result.directBurned,'0');assert.equal(result.history.length,1);
  const manual=MANUAL_PROTOCOL_HISTORY.find(row=>row.kind==='burn');const manualDirect={status:'available',complete:true,curveBurned:manual.inputAmount,history:[{...manual,source:'direct'}]};
  const manualManaged={...managed,manualIncluded:true,managedStatus:'unconfigured',curveBurned:manual.inputAmount};
  assert.equal(publicCombinedBurnAnalytics(manualManaged,manualDirect,[],NOW).curveBurned,manual.inputAmount);
  assert.equal(publicCombinedBurnAnalytics(managed,direct,[{...row,inputAmount:'1',state:'confirmed'}],NOW).status,'unavailable');
});

test('unknown records do not turn into zero and partial sources remain labelled',()=>{
  const unknown=publicDirectBurnAnalytics([],{inventoryComplete:false});assert.equal(publicCombinedBurnAnalytics({status:'unavailable'},unknown,[],NOW).curveBurned,null);
  const direct=publicDirectBurnAnalytics([directBurnRecord(launch(),NOW)],{inventoryComplete:false}),result=publicCombinedBurnAnalytics({status:'unavailable'},direct,[],NOW);assert.equal(result.curveBurned,raw);assert.equal(result.status,'partial');assert.equal(result.complete,false);
});

test('existing bounded inventory and anonymous minute refresh automatically pick up a completed burn',async()=>{
  const l=launch(),completed=structuredClone(l);l.operations=l.operations.slice(0,1);l.taxBurn.burnCount=0;l.taxBurn.initialInventory={status:'authorized',legacyBurnedBase:'0'};l.taxProtocol.burnedBase='0';
  let now=NOW,reads=0;const book={launches:[l]},accounts={list:async()=>[{id:'owner'}],storeFor:()=>({read:async()=>{reads++;return book;},write(){assert.fail('report cannot write');}}),hostStore:{read:async()=>null,write(){assert.fail('report cannot write');}}};
  const volume=new AdminVolume({accounts,now:()=>now,waitMs:0,maxRefresh:1,setTimer:()=>1,clearTimer(){},marketSnapshot:async()=>null,activity:{read:async()=>null},marketData:{pools:async()=>({pools:[]})}}),service=new PublicAnalytics({accounts,volume,now:()=>now});
  try{const first=await service.read(),before=BigInt(first.burns.curveBurned);assert.equal(first.burns.directBurned,'0');assert.equal(reads,1);book.launches=[completed];assert.equal((await service.read()).burns.curveBurned,first.burns.curveBurned);now+=60001;const next=await service.read();assert.equal(next.burns.directBurned,raw);assert.equal(BigInt(next.burns.curveBurned),before+BigInt(raw));assert.equal(next.burns.history.filter(row=>row.signature===sig(51)).length,1);assert.equal(next.treasury.solSpent,first.treasury.solSpent);assert.equal(next.treasury.curveBought,first.treasury.curveBought);assert.equal(reads,2);}finally{volume.close();service.close();}
});
