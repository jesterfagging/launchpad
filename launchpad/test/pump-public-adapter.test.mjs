import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { PumpPublicClientAdapter } from '../src/pump-public-adapter.mjs';
import { PUBLIC_PROGRAM_ID, PUBLIC_TREASURY } from '../src/pump-public-client.mjs';

async function setup() {
  const creator=Keypair.generate(),relayer=Keypair.generate(),config={programId:PUBLIC_PROGRAM_ID,relayer:relayer.publicKey.toBase58()},balance=10000000000;
  let debit=58000000;
  const connection={getAccountInfo:async()=>null,getMinimumBalanceForRentExemption:async size=>({0:890880,82:1461600,165:2039280,320:3118080,607:5115600}[size]||5000000),getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:200}),getFeeForMessage:async()=>({value:10600}),getBalance:async()=>balance,simulateTransaction:async()=>({context:{slot:100},value:{err:null,accounts:[{lamports:balance-debit}]}})};
  const adapter=new PumpPublicClientAdapter({connection,deploymentVerifier:async()=>({chainEnabled:true})});adapter.verifyPump=async()=>{};
  const seed='curve-012345678901234567890123',mint=await adapter.deriveMint(creator.publicKey.toBase58(),seed);
  const launch={mint,mintSeed:seed,name:'T'.repeat(32),symbol:'T'.repeat(10),creatorWallet:creator.publicKey.toBase58(),metadataUri:`https://launchpad.example/token-metadata/${mint}.json`,priceSnapshot:{solUsdMicros:'100000000'},creationFee:{lamports:'15000000',recipient:PUBLIC_TREASURY}};
  return {adapter,creator,relayer,config,launch,setDebit:value=>{debit=value;},connection};
}
test('public atomic launch includes metadata, creation fee and first buy within wallet packet limit',async()=>{
  const f=await setup();f.setDebit(1058000000);
  const b=await f.adapter.prepare(f.config,{action:'initialize',wallet:f.creator.publicKey.toBase58(),relayer:f.relayer.publicKey.toBase58(),launch:f.launch,amountRaw:'1000000000',slippageBps:100,now:1790630000000});
  const raw=Buffer.from(b.unsignedTransaction,'base64'),tx=VersionedTransaction.deserialize(raw);
  assert.ok(raw.length<=1232);assert.equal(tx.message.header.numRequiredSignatures,2);assert.equal(b.needsRelayer,true);
  assert.equal(b.review.maxWalletDebitLamports,'1058000000');
  assert.equal(BigInt(b.review.launchFeeLamports)+BigInt(b.review.firstBuyLamports)+BigInt(b.review.networkFeeLamports),1058000000n);
  assert.equal(b.review.creationFeeLamports,'15000000');assert.equal(b.review.creationFeeRecipient,PUBLIC_TREASURY);
  assert.ok(tx.message.staticAccountKeys.some(key=>key.toBase58()===PUBLIC_TREASURY));
});
test('public review uses simulated actual payer debit including metadata protocol fee',async()=>{
  const f=await setup(),b=await f.adapter.prepare(f.config,{action:'initialize',wallet:f.creator.publicKey.toBase58(),relayer:f.relayer.publicKey.toBase58(),launch:f.launch,now:1790630000000});
  assert.equal(b.review.maxWalletDebitLamports,'58000000');assert.equal(b.review.launchFeeLamports,'57989400');assert.equal(b.review.firstBuyLamports,'0');
  f.connection.simulateTransaction=async()=>({context:{slot:100},value:{err:null,accounts:[]}});
  await assert.rejects(f.adapter.prepare(f.config,{action:'initialize',wallet:f.creator.publicKey.toBase58(),relayer:f.relayer.publicKey.toBase58(),launch:f.launch,now:1790630000000}),/payer balance/);
});
test('changing payer balance during preparation invalidates rather than understates review',async()=>{
  const f=await setup();let checks=0;f.connection.getBalance=async()=>++checks===1?10000000000:9999000000;
  await assert.rejects(f.adapter.prepare(f.config,{action:'initialize',wallet:f.creator.publicKey.toBase58(),relayer:f.relayer.publicKey.toBase58(),launch:f.launch,now:1790630000000}),/balance changed/);
});
test('missing signatures remain private to service; adapter only accepts a managed relayer for graduation',async()=>{
  const f=await setup();await assert.rejects(f.adapter.prepare(f.config,{action:'migrate',wallet:f.creator.publicKey.toBase58(),relayer:f.relayer.publicKey.toBase58(),launch:f.launch}),/managed graduation relayer/);
});
