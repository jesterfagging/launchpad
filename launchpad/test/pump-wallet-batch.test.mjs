import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {parseHTML} from 'linkedom';
import {Keypair,TransactionMessage,VersionedTransaction,SystemProgram} from '@solana/web3.js';
import {createLaunchpadWallet} from '../public/launchpad-wallet.mjs';

const OWNER='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',SIGN='solana:signTransaction',CHAIN='solana:mainnet';
async function harness(sign){
  const {window}=parseHTML('<html></html>');let changed;const calls=[];
  const account={address:OWNER,chains:[CHAIN],features:[SIGN]};
  const candidate={name:'Test wallet',chains:[CHAIN],features:{
    'standard:connect':{connect:async()=>({accounts:[account]})},
    'standard:events':{on:(_,fn)=>{changed=fn;return()=>{};}},
    [SIGN]:{supportedTransactionVersions:[0],signTransaction:async(...inputs)=>{calls.push(inputs);return sign?sign(inputs):inputs.map(()=>({signedTransaction:new Uint8Array([1,2,3])}));}}
  }};
  window.addEventListener('wallet-standard:app-ready',e=>e.detail.register(candidate));
  const wallet=createLaunchpadWallet({window});await wallet.connect(wallet.state().wallets[0].id);
  return {wallet,calls,change:address=>changed({accounts:[{...account,address}]})};
}
const batch=n=>Array.from({length:n},()=>({wallet:OWNER,transaction:'AQID'}));
test('wallet-standard batch uses one variadic request and preserves every returned transaction',async()=>{
  const h=await harness();assert.equal(h.wallet.state().batchSigning,true);
  assert.deepEqual(await h.wallet.signBatch(batch(3)),['AQID','AQID','AQID']);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].length,3);assert(h.calls[0].every(x=>x.chain===CHAIN&&x.account.address===OWNER));
  assert.equal(await h.wallet.sign(batch(1)[0]),'AQID');
});
test('wrong wallet, too many transactions and oversize packets never prompt the wallet',async()=>{
  const h=await harness();await assert.rejects(h.wallet.signBatch(batch(26)),/1–25/);
  const wrong=batch(2);wrong[1].wallet=Keypair.generate().publicKey.toBase58();await assert.rejects(h.wallet.signBatch(wrong),/configured test wallet/);
  await assert.rejects(h.wallet.signBatch([{wallet:OWNER,transaction:Buffer.alloc(1233).toString('base64')}]),/packet limit/);
  assert.equal(h.calls.length,0);
});
test('incomplete or oversized wallet results fail without returning a partial batch',async()=>{
  const partial=await harness(()=>[{signedTransaction:new Uint8Array([1])}]);await assert.rejects(partial.wallet.signBatch(batch(2)),/complete signed batch/);
  const large=await harness(()=>[{signedTransaction:new Uint8Array(1233)}]);await assert.rejects(large.wallet.signBatch(batch(1)),/invalid signed/);
});
test('account changes during wallet approval invalidate the entire result',async()=>{
  let finish;const h=await harness(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=h.wallet.signBatch(batch(2));h.change(Keypair.generate().publicKey.toBase58());
  finish([{signedTransaction:new Uint8Array([1])},{signedTransaction:new Uint8Array([2])}]);
  await assert.rejects(pending,/Wallet changed/);
});
test('injected Phantom uses signAllTransactions only for a supported batch',async()=>{
  const {window}=parseHTML('<html></html>'),key=Keypair.generate(),provider=new EventEmitter();let one=0,all=0;
  provider.isPhantom=true;provider.publicKey=key.publicKey;provider.connect=async()=>({publicKey:key.publicKey});
  provider.signTransaction=async tx=>{one++;tx.sign([key]);return tx;};
  provider.signAllTransactions=async txs=>{all++;for(const tx of txs)tx.sign([key]);return txs;};window.phantom={solana:provider};
  const wallet=createLaunchpadWallet({window});await wallet.connect(wallet.state().wallets[0].id);
  const transaction=new VersionedTransaction(new TransactionMessage({payerKey:key.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:[SystemProgram.transfer({fromPubkey:key.publicKey,toPubkey:key.publicKey,lamports:1})]}).compileToV0Message());
  const p={wallet:key.publicKey.toBase58(),transaction:Buffer.from(transaction.serialize()).toString('base64')};
  const out=await wallet.signBatch([p,p]);assert.equal(out.length,2);assert.equal(all,1);assert.equal(one,0);
  await wallet.sign(p);assert.equal(one,1);
});
test('injected wallet without batch signing is rejected before any individual signing',async()=>{
  const {window}=parseHTML('<html></html>'),key=Keypair.generate(),provider=new EventEmitter();let calls=0;
  provider.isPhantom=true;provider.publicKey=key.publicKey;provider.connect=async()=>({publicKey:key.publicKey});provider.signTransaction=async()=>{calls++;};window.phantom={solana:provider};
  const wallet=createLaunchpadWallet({window});await wallet.connect(wallet.state().wallets[0].id);
  assert.equal(wallet.state().batchSigning,false);await assert.rejects(wallet.signBatch([{wallet:key.publicKey.toBase58(),transaction:'AQID'},{wallet:key.publicKey.toBase58(),transaction:'AQID'}]),/does not support/);assert.equal(calls,0);
});
