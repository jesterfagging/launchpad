import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import bs58 from 'bs58';
import { TelegramStore } from '../src/telegram-store.mjs';
import { AdminBurnHistory, burnHistorySignature } from '../src/admin-burn-history.mjs';
import { MANUAL_PROTOCOL_HISTORY, MANUAL_PROTOCOL_MINT as mint } from '../src/protocol-manual-history.mjs';

const clone = value => structuredClone(value), now = 1800000000000;
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const files = ['buy-1','burn-1','buy-2','burn-2','contribution-burn-1','buy-3','burn-3','excluded-other-mint-burn'];
const receipts = Object.fromEntries(await Promise.all(files.map(async name => [name, JSON.parse(await readFile(new URL(`./fixtures/manual-protocol-history/${name}.json`, import.meta.url),'utf8')).result])));
const sig = name => receipts[name].transaction.signatures[0];
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'launchpad-admin-burn-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const store = new TelegramStore(dir, randomBytes(32), 'relay-accounts-host');
  const actor = {id:'admin',role:'admin',mfaEnabled:true,banned:false};
  const transactions = new Map(Object.values(receipts).map(tx => [tx.transaction.signatures[0], clone(tx)]));
  const h = {dir,store,actor,transactions,writes:0,calls:[],closes:0,statusOverrides:new Map()};
  const write = store.write.bind(store);
  store.write = async (name,value) => { h.writes++; if (h.failWrite) throw Error('secret RPC password'); assert.equal(name,'admin-burn-history'); return write(name,value); };
  h.accounts = {dir,hostStore:store,get:async id => id === actor.id ? {...actor} : null};
  h.factory = async ({actorId}) => {
    assert.equal(actorId,'admin');
    if(h.factoryError)throw Error('https://secret-rpc-api-key');
    return {connection:{
      getParsedTransaction:async (signature,options) => {h.calls.push(['tx',signature,options]); if(h.rpcError)throw Error('https://secret-rpc-api-key'); return clone(transactions.get(signature) || null);},
      getSignatureStatuses:async (signatures,options) => {h.calls.push(['status',signatures,options]); const tx=transactions.get(signatures[0]);return {value:[h.statusOverrides.has(signatures[0]) ? h.statusOverrides.get(signatures[0]) : tx ? {slot:tx.slot,err:tx.meta.err,confirmationStatus:'finalized'} : null]};},
    },close:async()=>{h.closes++;}};
  };
  h.manager = new AdminBurnHistory({accounts:h.accounts,connectionFactory:h.factory,now:()=>now});
  h.add = (burn,buy,options) => h.manager.add('admin',{burnLink:sig(burn),buybackLink:buy?sig(buy):undefined},options);
  return h;
}

test('burn-only imports all actual pinned inner burns and stores only receipt facts in its own encrypted journal',async t=>{
  const h=await fixture(t);assert.deepEqual(await h.manager.readPublic(),{status:'available',complete:true,history:[]});
  for(const name of ['burn-1','burn-2','contribution-burn-1','burn-3']) {
    const out=await h.add(name),row=out.history.find(r=>r.signature===sig(name)),expected=MANUAL_PROTOCOL_HISTORY.find(r=>r.signature===sig(name));
    assert.equal(row.inputAmount,expected.inputAmount);assert.equal(row.outputAmount,'0');assert.equal(row.wallet,expected.wallet);assert.equal(row.source,'admin');assert.equal(row.mint,mint);assert.equal(row.buybackSignature,undefined);assert.equal(out.added,1);
  }
  assert.equal(h.closes,4);assert.equal(h.writes,4);
  const ciphertext=await readFile(join(h.dir,'admin-burn-history.enc'),'utf8');assert(!ciphertext.includes(sig('burn-1')));assert(!ciphertext.includes('inputAmount'));
  assert.equal((await h.manager.read('admin')).history.length,4);
  for(const call of h.calls) if(call[0]==='tx')assert.deepEqual(call[2],{commitment:'finalized',maxSupportedTransactionVersion:0});else assert.deepEqual(call[2],{searchTransactionHistory:true});
});

test('three real buy fixtures record exact WSOL including routing fees and net LAUNCHPAD after transfer tax',async t=>{
  const h=await fixture(t);
  for(const index of [1,2,3]){
    const out=await h.add(`burn-${index}`,`buy-${index}`),row=out.history.find(r=>r.kind==='buy'&&r.signature===sig(`buy-${index}`)),expected=MANUAL_PROTOCOL_HISTORY.find(r=>r.signature===sig(`buy-${index}`));
    assert.equal(row.inputAmount,expected.inputAmount);assert.equal(row.outputAmount,expected.outputAmount);assert.equal(out.added,2);
    assert.equal(out.history.find(r=>r.signature===sig(`burn-${index}`)).buybackSignature,row.signature);
  }
  assert.equal((await h.manager.readPublic()).history.length,6);assert.equal(h.writes,3);
});

test('duplicate re-adds are idempotent, burn-only can be enriched later, reused purchases count once',async t=>{
  const h=await fixture(t);await h.add('burn-1');
  const duplicate=await h.add('burn-1');assert.equal(duplicate.alreadyRecorded,true);assert.equal(h.writes,1);
  const enriched=await h.add('burn-1','buy-1');assert.equal(enriched.added,1);assert.equal(enriched.updated,true);assert.equal(enriched.history.length,2);assert.equal(h.writes,2);
  await h.add('burn-1');assert.equal(h.writes,2);assert.equal((await h.manager.readPublic()).history.find(r=>r.kind==='burn').buybackSignature,sig('buy-1'));
  const reused=await h.add('burn-2','buy-1');assert.equal(reused.added,1);assert.equal(reused.history.length,3);
  const before=await h.manager.readPublic();await assert.rejects(h.add('burn-2','buy-2'),/different buyback/);assert.deepEqual(await h.manager.readPublic(),before);assert.equal(h.writes,3);
});

test('accepts only Solscan mainnet links or valid signatures; rejects arbitrary URL, account link and oversized input',()=>{
  assert.equal(burnHistorySignature(` https://solscan.io/tx/${sig('burn-1')}?cluster=mainnet-beta `),sig('burn-1'));
  assert.equal(burnHistorySignature(sig('burn-1')),sig('burn-1'));assert.equal(burnHistorySignature(' ',{optional:true}),null);
  for(const value of [undefined,'',42,'https://evil.example/tx/'+sig('burn-1'),'https://solscan.io/account/'+mint,'https://solscan.io.evil.example/tx/'+sig('burn-1'),'https://user@solscan.io/tx/'+sig('burn-1'),'https://solscan.io/tx/'+sig('burn-1')+'?cluster=devnet','http://solscan.io/tx/'+sig('burn-1'),'x'.repeat(301),mint])assert.throws(()=>burnHistorySignature(value));
});

test('failed, pending, missing and identity-mismatched receipts never write; wrong token and ordinary transfers are not burns',async t=>{
  const h=await fixture(t),signature=sig('burn-1'),original=clone(h.transactions.get(signature));
  for(const status of [{slot:original.slot,err:null,confirmationStatus:'confirmed'},{slot:original.slot,err:{InstructionError:[0,'Custom']},confirmationStatus:'finalized'},{slot:original.slot+1,err:null,confirmationStatus:'finalized'},null]){
    h.statusOverrides.set(signature,status);await assert.rejects(h.add('burn-1'));assert.equal(h.writes,0);
  }
  h.statusOverrides.clear();
  for(const change of [tx=>{tx.meta.err={InstructionError:[0,'Custom']};},tx=>{tx.transaction.signatures[0]=sig('burn-2');},tx=>{tx.blockTime=Math.floor(now/1000)+10;},tx=>{tx.blockTime=null;},tx=>{tx.meta=null;}]){
    const tx=clone(original);change(tx);h.transactions.set(signature,tx);await assert.rejects(h.add('burn-1'));assert.equal(h.writes,0);
  }
  h.transactions.set(signature,original);await assert.rejects(h.add('excluded-other-mint-burn'),/no completed burn/);await assert.rejects(h.add('buy-1'),/no completed burn/);assert.equal(h.writes,0);
});

test('top-level raw BurnChecked and inner burn sum exactly; non-token programs and incorrect decimals cannot spoof burn',async t=>{
  const h=await fixture(t),tx=h.transactions.get(sig('burn-1')),burn=tx.meta.innerInstructions.flatMap(g=>g.instructions).find(i=>i.parsed?.type==='burn');
  const bytes=Buffer.alloc(10);bytes[0]=15;bytes.writeBigUInt64LE(7n,1);bytes[9]=6;
  tx.transaction.message.instructions.push({programId:TOKEN_2022,accounts:[burn.parsed.info.account,mint,burn.parsed.info.authority],data:bs58.encode(bytes)});
  const out=await h.add('burn-1');assert.equal(out.history[0].inputAmount,(BigInt(burn.parsed.info.amount)+7n).toString());
  bytes[9]=9;tx.transaction.message.instructions.at(-1).data=bs58.encode(bytes);await assert.rejects(h.add('burn-1'),/burn amount/);
  const wrong=clone(receipts['burn-2']);for(const i of wrong.meta.innerInstructions.flatMap(g=>g.instructions))if(i.parsed?.type==='burn')i.programId='11111111111111111111111111111111';h.transactions.set(sig('burn-2'),wrong);
  await assert.rejects(h.add('burn-2'),/no completed burn/);assert.equal(h.writes,1);
});

test('one transaction may buy and burn with separate operation identities and the net acquired amount restored from its real burn',async t=>{
  const h=await fixture(t),tx=h.transactions.get(sig('buy-1')),balance=tx.meta.postTokenBalances.find(b=>b.mint===mint&&b.owner===tx.transaction.message.accountKeys[0].pubkey);
  tx.transaction.message.instructions.push({programId:TOKEN_2022,parsed:{type:'burnChecked',info:{account:tx.transaction.message.accountKeys[balance.accountIndex].pubkey,mint,authority:balance.owner,tokenAmount:clone(balance.uiTokenAmount)}}});
  balance.uiTokenAmount.amount='0';
  const out=await h.manager.add('admin',{burnLink:sig('buy-1'),buybackLink:sig('buy-1')});assert.equal(out.history.length,2);assert.equal(out.history.find(r=>r.kind==='buy').outputAmount,MANUAL_PROTOCOL_HISTORY[0].outputAmount);assert.equal(out.history.find(r=>r.kind==='burn').inputAmount,MANUAL_PROTOCOL_HISTORY[0].outputAmount);
  assert.equal(h.calls.filter(c=>c[0]==='tx').length,1);assert.equal((await h.manager.add('admin',{burnLink:sig('buy-1'),buybackLink:sig('buy-1')})).alreadyRecorded,true);
});

test('admin with MFA and current authorization are required, including after RPC and immediately before save',async t=>{
  const h=await fixture(t);for(const change of [{role:'user'},{mfaEnabled:false},{banned:true}]){
    Object.assign(h.actor,{role:'admin',mfaEnabled:true,banned:false},change);await assert.rejects(h.add('burn-1'),/Administrator/);assert.equal(h.calls.length,0);
  }
  Object.assign(h.actor,{role:'admin',mfaEnabled:true,banned:false});let checks=0;
  await assert.rejects(h.add('burn-1',null,{authorize:async()=>{checks++;if(checks===2)throw Error('Session expired');}}),/Session expired/);assert.equal(h.writes,0);
  checks=0;await assert.rejects(h.add('burn-1',null,{authorize:async()=>{checks++;if(checks===3)throw Error('Session expired');}}),/Session/);assert.equal(h.writes,0);
  // The production callback itself rejects a revoked session; account changes
  // during RPC are independently checked before any journal read or mutation.
  h.actor.banned=false;const original=h.factory;h.manager.connectionFactory=async value=>{const result=await original(value);h.actor.banned=true;return result;};
  await assert.rejects(h.add('burn-2'),/Administrator/);
});

test('separate service instances serialize encrypted journal writes and do not lose records or duplicate imports',async t=>{
  const h=await fixture(t),other=new AdminBurnHistory({accounts:h.accounts,connectionFactory:h.factory,now:()=>now});
  await Promise.all([h.add('burn-1'),other.add('admin',{burnLink:sig('burn-2')}),h.add('burn-1')]);
  const out=await other.readPublic();assert.equal(out.history.length,2);assert.equal(h.writes,2);
});

test('unreadable or malformed existing journals fail closed and are not overwritten',async t=>{
  const h=await fixture(t);await h.store.write('admin-burn-history',{version:1,history:[{kind:'burn',signature:sig('burn-1'),inputAmount:'no'}]});const bytes=await readFile(join(h.dir,'admin-burn-history.enc'));
  assert.deepEqual(await h.manager.readPublic(),{status:'unavailable',complete:false,history:[]});await assert.rejects(h.add('burn-2'),/Saved burn history is invalid/);assert.deepEqual(await readFile(join(h.dir,'admin-burn-history.enc')),bytes);assert.equal(h.writes,1);
});

test('optional invalid purchase writes neither receipt and RPC/storage errors expose no upstream details',async t=>{
  const h=await fixture(t);await assert.rejects(h.add('burn-1','burn-1'),/exact SOL-to-LAUNCHPAD/);assert.equal(h.writes,0);
  const buy=h.transactions.get(sig('buy-1'));buy.transaction.message.instructions.find(i=>i.programId==='JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4').data=bs58.encode(Buffer.alloc(20));
  // Removing all recognized swap invocations leaves matching transfers, which
  // must never suffice as proof of a purchase.
  for(const group of buy.meta.innerInstructions)for(const i of group.instructions)if(!i.parsed)i.data=bs58.encode(Buffer.alloc(20));
  await assert.rejects(h.add('burn-1','buy-1'),/exact SOL-to-LAUNCHPAD/);assert.equal(h.writes,0);
  h.rpcError=true;await assert.rejects(h.add('burn-1'),e=>e.statusCode===503&&!/secret/.test(e.message));h.rpcError=false;
  h.factoryError=true;await assert.rejects(h.add('burn-1'),e=>e.statusCode===503&&!/secret/.test(e.message));h.factoryError=false;
  h.failWrite=true;await assert.rejects(h.add('burn-1'),e=>e.statusCode===503&&!/secret/.test(e.message));assert.equal((await h.manager.readPublic()).history.length,0);
});

test('confirmed managed receipts retain their accounting marker permanently; pending or conflicting treasury receipts block import',async t=>{
  const h=await fixture(t),burn=MANUAL_PROTOCOL_HISTORY.find(row=>row.signature===sig('burn-1'));
  const seed=value=>TelegramStore.prototype.write.call(h.store,'protocol-treasury',value);
  const treasury={version:1,wallet:{address:burn.wallet},history:[],pending:{kind:'burn',signature:burn.signature}};
  await seed(treasury);await assert.rejects(h.add('burn-1'),/reconciliation/);assert.equal(h.writes,0);
  treasury.pending=null;treasury.history=[{...burn,state:'confirmed',confirmedAt:now-1000,inputAmount:'1'}];await seed(treasury);
  await assert.rejects(h.add('burn-1'),/conflicts with a confirmed treasury/);assert.equal(h.writes,0);
  treasury.history[0].inputAmount=burn.inputAmount;await seed(treasury);const before=await readFile(join(h.dir,'protocol-treasury.enc'));
  const out=await h.add('burn-1');assert.equal(out.history[0].accountingSource,'managed-treasury');assert.deepEqual(await readFile(join(h.dir,'protocol-treasury.enc')),before);
  treasury.history=[];await seed(treasury);assert.equal((await h.add('burn-1')).alreadyRecorded,true);assert.equal((await h.manager.readPublic()).history[0].accountingSource,'managed-treasury');
});

test('unknown treasury burns at the retained-history boundary are rejected, including burns from multiple wallets',async t=>{
  const h=await fixture(t),tx=clone(receipts['burn-1']),signature=bs58.encode(randomBytes(64));tx.transaction.signatures[0]=signature;h.transactions.set(signature,tx);
  const wallet=MANUAL_PROTOCOL_HISTORY[0].wallet;
  const treasury={version:1,wallet:{address:wallet},history:Array.from({length:500},()=>({kind:'convert',state:'confirmed',confirmedAt:tx.blockTime*1000})),pending:null};
  await TelegramStore.prototype.write.call(h.store,'protocol-treasury',treasury);
  const add=()=>h.manager.add('admin',{burnLink:signature});await assert.rejects(add(),/predates retained receipt history/);assert.equal(h.writes,0);
  const innerBurn=tx.meta.innerInstructions.flatMap(g=>g.instructions).find(i=>i.parsed?.type==='burn');
  tx.transaction.message.instructions.push({programId:TOKEN_2022,parsed:{type:'burn',info:{...clone(innerBurn.parsed.info),account:'GiPXcBwGGQuf8rih6iqeb8N9bJShRr8dSjjRTQn5YRax',authority:'GJwudKRPbZiwHPCSJZdLTPFaKdsHmKov9VMDbVCpqQEa',amount:'1'}}});
  await assert.rejects(add(),/predates retained receipt history/);assert.equal(h.writes,0);
  // The specifically verified pinned history remains safely deduplicable.
  assert.equal((await h.add('burn-1')).added,1);
});

test('standalone imports remain idempotent after treasury retention advances and extra token credits are never treated as purchases',async t=>{
  const h=await fixture(t),tx=clone(receipts['burn-1']),signature=bs58.encode(randomBytes(64));tx.transaction.signatures[0]=signature;h.transactions.set(signature,tx);
  await h.manager.add('admin',{burnLink:signature});
  await TelegramStore.prototype.write.call(h.store,'protocol-treasury',{version:1,wallet:{address:MANUAL_PROTOCOL_HISTORY[0].wallet},history:Array.from({length:500},()=>({kind:'convert',state:'confirmed',confirmedAt:now-1000})),pending:null});
  assert.equal((await h.manager.add('admin',{burnLink:signature})).alreadyRecorded,true);
  const buy=h.transactions.get(sig('buy-1')),output=buy.meta.postTokenBalances.find(row=>row.mint===mint&&row.owner===MANUAL_PROTOCOL_HISTORY[0].wallet);
  buy.transaction.message.instructions.push({programId:TOKEN_2022,parsed:{type:'mintTo',info:{mint,account:buy.transaction.message.accountKeys[output.accountIndex].pubkey,amount:'1'}}});
  output.uiTokenAmount.amount=(BigInt(output.uiTokenAmount.amount)+1n).toString();
  await assert.rejects(h.add('burn-1','buy-1'),/exact SOL-to-LAUNCHPAD/);assert.equal(h.writes,1);
});
