import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { LaunchChain } from '../src/launchpad-chain.mjs';
import { newLaunchKeys, signer } from '../src/launchpad-receipts.mjs';
import { verifySignedTransaction } from '../src/providers.mjs';
import { SOL_MINT } from '../public/launchpad-model.mjs';

function harness({external=true,extra=false,feeMode='creator'}={}) {
  const keys=newLaunchKeys(),payer=Keypair.generate(),platform=keys.wallet;
  keys.payer=external?{address:payer.publicKey.toBase58(),external:true}:{address:platform.address,secret:platform.secret};
  keys.platform=platform;
  if(feeMode==='creator')keys.wallet=keys.payer;
  const launch={keys,input:{network:'mainnet-beta',route:'raydium',quoteMint:SOL_MINT,feeMode},review:{storageWalletRent:'890880'},storage:{provider:'irys',budget:'10000',recipient:Keypair.generate().publicKey.toBase58()}};
  const from=new PublicKey(keys.payer.address),target=new PublicKey(keys.mint.address);
  const instructions=[extra?SystemProgram.createAccount({fromPubkey:from,newAccountPubkey:target,lamports:1000,space:0,programId:SystemProgram.programId}):SystemProgram.transfer({fromPubkey:from,toPubkey:target,lamports:1000})];
  const simulations=[],sent=[];let height=99;
  const c=new LaunchChain({network:'mainnet-beta',connection:{
    getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:100}),
    getBlockHeight:async()=>height,
    simulateTransaction:async(tx,config)=>{simulations.push({tx,config});return{value:{err:null,unitsConsumed:1000}};},
    sendRawTransaction:async bytes=>{const {signature}=verifySignedTransaction(bytes,keys.payer.address,extra?[keys.mint.address]:[]);sent.push(bytes);return signature;},
  }});
  return{c,launch,payer,instructions,extras:extra?[signer(keys.mint.secret)]:[],simulations,sent,setHeight(v){height=v;}};
}
const walletSign=(op,wallet)=>{const tx=VersionedTransaction.deserialize(Buffer.from(op.unsignedRaw,'base64'));tx.sign([wallet]);return Buffer.from(tx.serialize()).toString('base64');};
const withWalletGuard=(op,wallet,{clearCurveSignatures=false,extraInstruction,tables=[],outputTables=tables}={})=>{
  const original=VersionedTransaction.deserialize(Buffer.from(op.unsignedRaw,'base64')),value=Buffer.alloc(8);value.writeBigUInt64LE(1000n);
  const guard=new TransactionInstruction({programId:new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'),keys:[{pubkey:wallet.publicKey,isSigner:false,isWritable:false}],data:Buffer.concat([Buffer.from([5,0,0]),value,Buffer.from([0])])});
  const builder=TransactionMessage.decompile(original.message,{addressLookupTableAccounts:tables});builder.instructions.push(extraInstruction||guard);
  const tx=new VersionedTransaction(builder.compileToV0Message(outputTables));
  if(!clearCurveSignatures)for(let i=1;i<original.signatures.length;i++)tx.signatures[i]=original.signatures[i];
  tx.sign([wallet]);return Buffer.from(tx.serialize()).toString('base64');
};

test('a valid wallet guard is preserved, fully simulated, and does not broadcast or mutate the saved request',async()=>{
  const h=harness(),op=await h.c.prepare(h.launch,h.instructions,[],'setup'),before=structuredClone(op);let checks=0;
  h.c.verifyWalletGuardProgram=async()=>{checks++;};
  const input=withWalletGuard(op,h.payer),result=await h.c.acceptSigned(op,input);
  assert.equal(checks,1);assert.equal(result.raw,input);assert.equal(h.simulations.length,2);assert.equal(h.simulations[1].config.sigVerify,true);
  assert.equal(verifySignedTransaction(Buffer.from(result.raw,'base64'),op.externalSigner).signature,result.signature);
  assert.deepEqual(op,before);assert.equal(h.sent.length,0);
});

test('guard-compatible mint co-signing verifies external approval before resolving only required keys',async()=>{
  for(const clearCurveSignatures of [false,true]){
    const h=harness({extra:true}),op=await h.c.prepare(h.launch,h.instructions,h.extras,'create');let resolved=0,trusted=false;
    h.c.verifyWalletGuardProgram=async()=>{trusted=true;};
    const input=withWalletGuard(op,h.payer,{clearCurveSignatures}),external=VersionedTransaction.deserialize(Buffer.from(input,'base64')).signatures[0];
    const options={resolveAdditionalSigners:required=>{resolved++;assert(trusted);assert.deepEqual(required,[h.launch.keys.mint.address]);return h.extras;}};
    const invalid=VersionedTransaction.deserialize(Buffer.from(input,'base64'));invalid.signatures[0][0]^=1;
    await assert.rejects(h.c.acceptSigned(op,Buffer.from(invalid.serialize()).toString('base64'),options),e=>e.code==='WALLET_TRANSACTION_REJECTED');assert.equal(resolved,0);assert.equal(trusted,false);
    const malicious=withWalletGuard(op,h.payer,{extraInstruction:SystemProgram.transfer({fromPubkey:h.payer.publicKey,toPubkey:Keypair.generate().publicKey,lamports:1})});
    await assert.rejects(h.c.acceptSigned(op,malicious,options),e=>e.code==='WALLET_TRANSACTION_REJECTED');assert.equal(resolved,0);
    const result=await h.c.acceptSigned(op,input,options),tx=VersionedTransaction.deserialize(Buffer.from(result.raw,'base64'));
    assert.equal(resolved,1);assert.deepEqual(tx.signatures[0],external);assert.notDeepEqual(tx.signatures[1],VersionedTransaction.deserialize(Buffer.from(op.unsignedRaw,'base64')).signatures[1]);
    verifySignedTransaction(Buffer.from(result.raw,'base64'),op.externalSigner,[h.launch.keys.mint.address]);assert.equal(h.simulations.at(-1).config.sigVerify,true);assert.equal(h.sent.length,0);
  }
});

test('Phantom/Solflare priority-fee edits re-sign the mint after wallet approval and are fully simulated',async()=>{
  const h=harness({extra:true}),op=await h.c.prepare(h.launch,h.instructions,h.extras,'create');let resolved=0,guardChecks=0;
  h.c.verifyWalletGuardProgram=async()=>{guardChecks++;};
  const original=VersionedTransaction.deserialize(Buffer.from(op.unsignedRaw,'base64')),builder=TransactionMessage.decompile(original.message);
  builder.instructions[0]=ComputeBudgetProgram.setComputeUnitLimit({units:900000});builder.instructions[1]=ComputeBudgetProgram.setComputeUnitPrice({microLamports:200000});
  const tx=new VersionedTransaction(builder.compileToV0Message());tx.sign([h.payer]);
  const options={resolveAdditionalSigners:required=>{resolved++;assert.deepEqual(required,[h.launch.keys.mint.address]);return h.extras;}};
  const result=await h.c.acceptSigned(op,Buffer.from(tx.serialize()).toString('base64'),options),signed=VersionedTransaction.deserialize(Buffer.from(result.raw,'base64'));
  assert.equal(resolved,1);assert.equal(guardChecks,0);assert.deepEqual(signed.signatures[0],tx.signatures[0]);
  verifySignedTransaction(Buffer.from(result.raw,'base64'),op.externalSigner,[h.launch.keys.mint.address]);assert.equal(h.simulations.at(-1).config.sigVerify,true);assert.equal(h.sent.length,0);
  // The same edit with an unsigned wallet slot is still rejected.
  const unsigned=new VersionedTransaction(builder.compileToV0Message());
  await assert.rejects(h.c.acceptSigned(op,Buffer.from(unsigned.serialize()).toString('base64'),options),e=>e.code==='WALLET_TRANSACTION_REJECTED');
});

test('guard co-signing refuses missing, additional or unrelated server signers',async()=>{
  const h=harness({extra:true}),op=await h.c.prepare(h.launch,h.instructions,h.extras,'create'),input=withWalletGuard(op,h.payer);h.c.verifyWalletGuardProgram=async()=>{};
  await assert.rejects(h.c.acceptSigned(op,input),/cannot be co-signed/);
  for(const signers of [[],[Keypair.generate()],[...h.extras,Keypair.generate()],[h.payer]])await assert.rejects(h.c.acceptSigned(op,input,{resolveAdditionalSigners:()=>signers}),/invalid Launchpad signer set/);
  assert.equal(h.simulations.length,1);assert.equal(h.sent.length,0);
});

test('guard co-signing clears the service-owned private bytes after signing or invalid signer selection',async()=>{
  const h=harness({extra:true}),op=await h.c.prepare(h.launch,h.instructions,h.extras,'create'),input=withWalletGuard(op,h.payer);h.c.verifyWalletGuardProgram=async()=>{};
  const owned={publicKey:h.extras[0].publicKey,secretKey:h.extras[0].secretKey};
  const result=await h.c.acceptSigned(op,input,{resolveAdditionalSigners:()=>[owned]});assert(owned.secretKey.every(byte=>byte===0));verifySignedTransaction(Buffer.from(result.raw,'base64'),op.externalSigner,[h.launch.keys.mint.address]);
  const other=Keypair.generate(),wrong={publicKey:other.publicKey,secretKey:other.secretKey};
  await assert.rejects(h.c.acceptSigned(op,input,{resolveAdditionalSigners:()=>[wrong]}),/invalid Launchpad signer set/);assert(wrong.secretKey.every(byte=>byte===0));
});

test('program trust and RPC simulation failures preserve the same signed request for deterministic retries',async()=>{
  const h=harness({extra:true}),op=await h.c.prepare(h.launch,h.instructions,h.extras,'create'),before=structuredClone(op),input=withWalletGuard(op,h.payer);let resolutions=0;
  const options={resolveAdditionalSigners:()=>{resolutions++;return h.extras;}};
  h.c.verifyWalletGuardProgram=async()=>{throw Object.assign(Error('RPC unavailable'),{code:'ECONNRESET'});};
  await assert.rejects(h.c.acceptSigned(op,input,options),e=>e.code==='ECONNRESET');assert.equal(resolutions,0);assert.deepEqual(op,before);
  h.c.verifyWalletGuardProgram=async()=>{};const submitted=[];let attempt=0;
  h.c.c.simulateTransaction=async(tx,config)=>{submitted.push(Buffer.from(tx.serialize()));assert.equal(config.sigVerify,true);if(++attempt===1)throw Object.assign(Error('RPC timeout'),{code:'ETIMEDOUT'});if(attempt===2)return{value:{err:{InstructionError:[3,{Custom:1}]}}};return{value:{err:null}};};
  await assert.rejects(h.c.acceptSigned(op,input,options),e=>e.code==='ETIMEDOUT');assert.deepEqual(op,before);
  await assert.rejects(h.c.acceptSigned(op,input,options),e=>e.code==='WALLET_GUARD_SIMULATION_FAILED');assert.deepEqual(op,before);
  const result=await h.c.acceptSigned(op,input,options);assert.equal(submitted.length,3);assert(submitted.every(bytes=>bytes.equals(submitted[0])));assert.equal(result.raw,submitted[0].toString('base64'));assert.equal(h.sent.length,0);
});

test('unverified Lighthouse executable ownership is rejected before any added signer is accessed',async()=>{
  const h=harness({extra:true}),op=await h.c.prepare(h.launch,h.instructions,h.extras,'create');let resolved=0;
  h.c.c.getMultipleAccountsInfoAndContext=async()=>({context:{slot:450486111},value:[{owner:SystemProgram.programId,executable:true,data:Buffer.alloc(36)},null]});
  await assert.rejects(h.c.acceptSigned(op,withWalletGuard(op,h.payer),{resolveAdditionalSigners:()=>{resolved++;return h.extras;}}),/safety program could not be verified/);
  assert.equal(resolved,0);assert.equal(h.simulations.length,1);assert.equal(h.sent.length,0);
});

test('guarded lookup transactions resolve saved tables before co-signing and reject hidden introspection or aliases',async()=>{
  const h=harness({extra:true}),addresses=[Keypair.generate().publicKey,Keypair.generate().publicKey];
  const table=new AddressLookupTableAccount({key:Keypair.generate().publicKey,state:{deactivationSlot:18446744073709551615n,lastExtendedSlot:0,lastExtendedSlotStartIndex:0,addresses}});
  h.instructions.push(new TransactionInstruction({programId:SystemProgram.programId,keys:addresses.map(pubkey=>({pubkey,isSigner:false,isWritable:false})),data:Buffer.from([0])}));h.instructions.lookupTables=[table];
  const op=await h.c.prepare(h.launch,h.instructions,h.extras,'create'),input=withWalletGuard(op,h.payer,{tables:[table]});assert.equal(VersionedTransaction.deserialize(Buffer.from(op.unsignedRaw,'base64')).message.addressTableLookups.length,1);
  let checked=0,resolved=0,reads=0;h.c.verifyWalletGuardProgram=async()=>{checked++;};
  const options={resolveAdditionalSigners:()=>{resolved++;return h.extras;}};
  for(const unsafe of [h.payer.publicKey,new PublicKey('Sysvar1nstructions1111111111111111111111111'),new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'),addresses[1]]){
    h.c.lookupTables=async keys=>{reads++;assert.deepEqual(keys,[table.key.toBase58()]);return[new AddressLookupTableAccount({key:table.key,state:{...table.state,addresses:[unsafe,addresses[1]]}})];};
    await assert.rejects(h.c.acceptSigned(op,input,options),e=>e.code==='WALLET_TRANSACTION_REJECTED');assert.equal(resolved,0);assert.equal(checked,0);
  }
  h.c.lookupTables=async()=>{reads++;return[table];};
  const result=await h.c.acceptSigned(op,input,options);assert.equal(reads,5);assert.equal(resolved,1);assert.equal(checked,1);verifySignedTransaction(Buffer.from(result.raw,'base64'),op.externalSigner,[h.launch.keys.mint.address]);
});

async function repackedWalletFixture(){
  const h=harness({extra:true}),addresses=Array.from({length:4},()=>Keypair.generate().publicKey);
  const table=new AddressLookupTableAccount({key:Keypair.generate().publicKey,state:{deactivationSlot:18446744073709551615n,lastExtendedSlot:0,lastExtendedSlotStartIndex:0,addresses}});
  h.instructions.push(new TransactionInstruction({programId:SystemProgram.programId,keys:addresses.map((pubkey,index)=>({pubkey,isSigner:false,isWritable:index<2})),data:Buffer.from([0])}));h.instructions.lookupTables=[table];
  const op=await h.c.prepare(h.launch,h.instructions,h.extras,'create');
  assert.equal(VersionedTransaction.deserialize(Buffer.from(op.unsignedRaw,'base64')).message.addressTableLookups.length,1);
  const replacement=new AddressLookupTableAccount({key:Keypair.generate().publicKey,state:{...table.state,addresses:[...addresses].reverse()}});
  return{...h,op,table,replacement};
}

test('wallet-expanded and repacked lookup accounts preserve reviewed instructions and the exact signed message',async()=>{
  for(const variant of ['expanded','replacement']){
    const h=await repackedWalletFixture(),before=structuredClone(h.op),outputTables=variant==='expanded'?[]:[h.replacement];let reads=0,checks=0,resolved=0;
    const input=withWalletGuard(h.op,h.payer,{tables:[h.table],outputTables}),submitted=VersionedTransaction.deserialize(Buffer.from(input,'base64'));
    h.c.lookupTables=async keys=>{reads++;assert.deepEqual(keys,[h.table,...outputTables].map(table=>table.key.toBase58()));return[h.table,...outputTables];};
    h.c.verifyWalletGuardProgram=async()=>{checks++;};
    const result=await h.c.acceptSigned(h.op,input,{resolveAdditionalSigners:keys=>{resolved++;assert.equal(checks,1);assert.deepEqual(keys,[h.launch.keys.mint.address]);return h.extras;}});
    const accepted=VersionedTransaction.deserialize(Buffer.from(result.raw,'base64'));
    assert.deepEqual(accepted.message.serialize(),submitted.message.serialize());assert.deepEqual(accepted.signatures[0],submitted.signatures[0]);
    assert.equal(reads,1);assert.equal(resolved,1);assert.equal(h.simulations.at(-1).config.sigVerify,true);
    verifySignedTransaction(Buffer.from(result.raw,'base64'),h.op.externalSigner,[h.launch.keys.mint.address]);assert.deepEqual(h.op,before);assert.equal(h.sent.length,0);
  }
});

test('repacked lookup validation verifies the wallet signature before any RPC or private-key access',async()=>{
  const h=await repackedWalletFixture(),input=withWalletGuard(h.op,h.payer,{tables:[h.table],outputTables:[h.replacement]}),tx=VersionedTransaction.deserialize(Buffer.from(input,'base64'));tx.signatures[0][0]^=1;
  h.c.lookupTables=async()=>assert.fail('Unverified wallet must not resolve lookups');h.c.c.getBlockHeight=async()=>assert.fail('Unverified wallet must not read chain');
  await assert.rejects(h.c.acceptSigned(h.op,Buffer.from(tx.serialize()).toString('base64'),{resolveAdditionalSigners:()=>assert.fail('Must not access service keys')}),e=>e.code==='WALLET_TRANSACTION_REJECTED');
  assert.equal(h.sent.length,0);
});

test('repacked lookup RPC uncertainty preserves the request while address substitution is definitively rejected',async()=>{
  const h=await repackedWalletFixture(),before=structuredClone(h.op),input=withWalletGuard(h.op,h.payer,{tables:[h.table],outputTables:[h.replacement]});let resolutions=0,checks=0;
  const options={resolveAdditionalSigners:()=>{resolutions++;return h.extras;}};h.c.verifyWalletGuardProgram=async()=>{checks++;};
  h.c.lookupTables=async()=>{throw Object.assign(Error('RPC timeout'),{code:'ETIMEDOUT'});};
  await assert.rejects(h.c.acceptSigned(h.op,input,options),e=>e.code==='ETIMEDOUT');
  const wrong=new AddressLookupTableAccount({key:h.replacement.key,state:{...h.replacement.state,addresses:[Keypair.generate().publicKey,...h.replacement.state.addresses.slice(1)]}});
  h.c.lookupTables=async()=>[h.table,wrong];
  await assert.rejects(h.c.acceptSigned(h.op,input,options),e=>e.code==='WALLET_TRANSACTION_REJECTED');
  assert.equal(resolutions,0);assert.equal(checks,0);assert.equal(h.simulations.length,1);assert.deepEqual(h.op,before);assert.equal(h.sent.length,0);
});

test('valid wallet signatures cannot approve changed launch amounts hidden behind lookup repacking',async()=>{
  const h=await repackedWalletFixture(),input=withWalletGuard(h.op,h.payer,{tables:[h.table],outputTables:[h.replacement]}),tx=VersionedTransaction.deserialize(Buffer.from(input,'base64'));
  tx.message.compiledInstructions[2].data[4]^=1;tx.sign([h.payer]);h.c.lookupTables=async()=>[h.table,h.replacement];
  h.c.verifyWalletGuardProgram=async()=>assert.fail('Mutated instructions must fail before program verification');
  await assert.rejects(h.c.acceptSigned(h.op,Buffer.from(tx.serialize()).toString('base64'),{resolveAdditionalSigners:()=>assert.fail('Mutated instructions must not be co-signed')}),e=>e.code==='WALLET_TRANSACTION_REJECTED');
  assert.equal(h.simulations.length,1);assert.equal(h.sent.length,0);
});

test('external launch preparation needs the payer signature, preserves mint signature, and uses unsigned simulation',async()=>{
  const h=harness({extra:true}),op=await h.c.prepare(h.launch,h.instructions,h.extras,'create');
  assert.equal(op.state,'awaiting_signature');assert.equal(op.needsSignature,true);assert.equal(op.raw,undefined);assert.equal(op.signature,undefined);
  assert.equal(op.externalSigner,h.payer.publicKey.toBase58());assert.equal(op.blockhash,h.simulations[0].tx.message.recentBlockhash);
  assert.equal(h.simulations.length,1);assert.equal(h.simulations[0].config.sigVerify,false);
  const tx=VersionedTransaction.deserialize(Buffer.from(op.unsignedRaw,'base64'));
  assert.equal(tx.version,0);assert(tx.signatures[0].every(x=>x===0));assert(tx.signatures[1].some(x=>x!==0));
  assert(!JSON.stringify(op).includes(h.launch.keys.mint.secret));assert.equal(h.sent.length,0);
  const signed=await h.c.acceptSigned(op,walletSign(op,h.payer));
  assert.equal(signed.state,'pending');assert.equal(signed.needsSignature,false);assert.equal(signed.unsignedRaw,undefined);assert.equal(signed.messageHash,undefined);
  assert.equal(verifySignedTransaction(Buffer.from(signed.raw,'base64'),op.externalSigner,[h.launch.keys.mint.address]).signature,signed.signature);
  assert.equal(op.state,'awaiting_signature');assert.equal(op.raw,undefined);assert.equal(h.sent.length,0);
});

test('a browser signature cannot change launch instructions, recipient, amounts, blockhash or fee payer',async()=>{
  const h=harness(),op=await h.c.prepare(h.launch,h.instructions,[],'create');
  for(const [mutate,category] of [
    [tx=>{tx.message.compiledInstructions.at(-1).data[4]^=1;},'instructions'],
    [tx=>{tx.message.staticAccountKeys[1]=Keypair.generate().publicKey;},'account layout'],
    [tx=>{tx.message.recentBlockhash=Keypair.generate().publicKey.toBase58();},'blockhash'],
    [tx=>{tx.message.staticAccountKeys[0]=Keypair.generate().publicKey;},'account layout'],
    // Wallet fee edits are allowed only up to the 0.01 SOL priority-fee cap.
    [tx=>{tx.message.compiledInstructions[1].data[8]=0x7f;},'compute budget'],
    [tx=>{tx.message.header.numReadonlyUnsignedAccounts--;},'account permissions'],
    [tx=>{tx.message.addressTableLookups.push({accountKey:Keypair.generate().publicKey,writableIndexes:[0],readonlyIndexes:[]});},'address lookups'],
    [tx=>{tx.message.compiledInstructions.push(tx.message.compiledInstructions.at(-1));},'instructions'],
  ]){
    const tx=VersionedTransaction.deserialize(Buffer.from(op.unsignedRaw,'base64'));mutate(tx);
    await assert.rejects(h.c.acceptSigned(op,Buffer.from(tx.serialize()).toString('base64')),error=>{
      assert.equal(error.code,'WALLET_TRANSACTION_REJECTED');assert.match(error.message,/changed the reviewed transaction/);assert(error.message.includes('('+category+')'));
      for(const address of tx.message.staticAccountKeys.map(String))assert(!error.message.includes(address));
      return true;
    });
  }
  assert.equal(h.sent.length,0);
});

test('a rejected wallet result can be signed again without changing the saved operation',async()=>{
  const h=harness({extra:true}),op=await h.c.prepare(h.launch,h.instructions,h.extras,'create'),saved=structuredClone(op);
  const changed=VersionedTransaction.deserialize(Buffer.from(op.unsignedRaw,'base64'));
  changed.message.compiledInstructions[0].data[1]^=1;
  await assert.rejects(h.c.acceptSigned(op,Buffer.from(changed.serialize()).toString('base64')),error=>error.code==='WALLET_TRANSACTION_REJECTED');
  assert.deepEqual(op,saved);assert.equal(h.sent.length,0);
  const accepted=await h.c.acceptSigned(op,walletSign(op,h.payer));
  assert.equal(accepted.state,'pending');assert.equal(accepted.blockhash,saved.blockhash);
  assert.deepEqual(op,saved);assert.equal(h.sent.length,0);
});

test('saved-request corruption and RPC uncertainty are not classified as rejected wallet bytes',async()=>{
  const h=harness(),op=await h.c.prepare(h.launch,h.instructions,[],'create'),signed=walletSign(op,h.payer);
  await assert.rejects(h.c.acceptSigned({...op,messageHash:'f'.repeat(64)},signed),error=>!error.code&&/saved wallet-signing request changed/.test(error.message));
  h.c.c.getBlockHeight=async()=>{throw Object.assign(Error('RPC response unavailable'),{code:'ECONNRESET'});};
  await assert.rejects(h.c.acceptSigned(op,signed),error=>error.code==='ECONNRESET');
  assert.equal(h.sent.length,0);assert.equal(op.state,'awaiting_signature');
});

test('missing, wrong-wallet and tampered signatures are rejected before broadcast',async()=>{
  const h=harness({extra:true}),op=await h.c.prepare(h.launch,h.instructions,h.extras,'create');
  await assert.rejects(h.c.acceptSigned(op,op.unsignedRaw),/signature verification failed/);
  const signed=walletSign(op,h.payer),tx=VersionedTransaction.deserialize(Buffer.from(signed,'base64'));
  tx.signatures[0][0]^=1;
  await assert.rejects(h.c.acceptSigned(op,Buffer.from(tx.serialize()).toString('base64')),/signature verification failed/);
  const wrong=harness(),wrongOp=await wrong.c.prepare(wrong.launch,wrong.instructions,[],'create');
  const wrongTx=VersionedTransaction.deserialize(Buffer.from(walletSign(wrongOp,wrong.payer),'base64'));
  tx.signatures[0]=wrongTx.signatures[0];
  await assert.rejects(h.c.acceptSigned(op,Buffer.from(tx.serialize()).toString('base64')),/signature verification failed/);
  const missingMint=VersionedTransaction.deserialize(Buffer.from(signed,'base64'));missingMint.signatures[1].fill(0);
  await assert.rejects(h.c.acceptSigned(op,Buffer.from(missingMint.serialize()).toString('base64')),/signature verification failed/);
  assert.equal(h.sent.length,0);
});

test('expired or invalid block heights reject a valid external signature without accepting pending state',async()=>{
  const h=harness(),op=await h.c.prepare(h.launch,h.instructions,[],'create'),signed=walletSign(op,h.payer);
  for(const height of [101,NaN,'99']){h.setHeight(height);await assert.rejects(h.c.acceptSigned(op,signed),/expired/);}
  h.setHeight(100);assert.equal((await h.c.acceptSigned(op,signed)).state,'pending');
  assert.equal(op.state,'awaiting_signature');assert.equal(h.sent.length,0);
});

test('only canonical bounded v0 transaction input is accepted for a saved signing request',async()=>{
  const h=harness(),op=await h.c.prepare(h.launch,h.instructions,[],'create'),signed=walletSign(op,h.payer);
  for(const value of [undefined,'',signed+'\n','!!!!',Buffer.alloc(1233).toString('base64'),signed.replace(/=+$/,'')+'-']){
    await assert.rejects(h.c.acceptSigned(op,value),/Invalid signed transaction/);
  }
  const bytes=Buffer.concat([Buffer.from(signed,'base64'),Buffer.from([0])]);
  await assert.rejects(h.c.acceptSigned(op,bytes.toString('base64')),/canonical/);
  await assert.rejects(h.c.acceptSigned({...op,state:'pending'},signed),/not waiting/);
  await assert.rejects(h.c.acceptSigned({...op,signature:'unexpected'},signed),/not waiting/);
  await assert.rejects(h.c.acceptSigned({...op,messageHash:'f'.repeat(64)},signed),/changed/);
  await assert.rejects(h.c.acceptSigned({...op,externalSigner:Keypair.generate().publicKey.toBase58()},signed),/request is invalid/);
  await assert.rejects(h.c.acceptSigned({...op,blockhash:Keypair.generate().publicKey.toBase58()},signed),/request is invalid/);
});

test('default wallets still sign automatically and use full signature verification during simulation',async()=>{
  const h=harness({external:false,extra:true}),op=await h.c.prepare(h.launch,h.instructions,h.extras,'create');
  assert.equal(op.state,'pending');assert.equal(op.needsSignature,undefined);assert.equal(op.unsignedRaw,undefined);assert.equal(h.simulations[0].config.sigVerify,true);
  verifySignedTransaction(Buffer.from(op.raw,'base64'),h.launch.keys.payer.address,[h.launch.keys.mint.address]);
  await assert.rejects(h.c.acceptSigned(op,op.raw),/not waiting/);
});

test('external signer configurations reject secret storage and missing or additional server signers',async()=>{
  const h=harness({extra:true});
  await assert.rejects(h.c.prepare(h.launch,h.instructions,[],'create'),/signer mismatch/);
  await assert.rejects(h.c.prepare(h.launch,h.instructions,[...h.extras,Keypair.generate()],'create'),/signer mismatch/);
  await assert.rejects(h.c.prepare(h.launch,h.instructions,[...h.extras,h.payer],'create'),/signer mismatch/);
  h.launch.keys.payer.secret=h.launch.keys.platform.secret;
  await assert.rejects(h.c.prepare(h.launch,h.instructions,h.extras,'create'),/secrets must never/);
});

test('oversized connected-wallet launches fail clearly instead of becoming unsupported v1 transactions',async()=>{
  const h=harness(),instruction=new TransactionInstruction({programId:SystemProgram.programId,keys:[{pubkey:h.payer.publicKey,isSigner:true,isWritable:true}],data:Buffer.alloc(1200)});
  await assert.rejects(h.c.prepare(h.launch,[instruction],[],'create'),/above this wallet.*1,232-byte limit/);
  assert.equal(h.simulations.length,0);assert.equal(h.sent.length,0);
});

test('storage credit requires external approval, then the dedicated platform wallet funds its own Irys account',async()=>{
  const h=harness(),keys=h.launch.keys,credit=await h.c.launchInstructions(h.launch,'storage-credit'),fund=await h.c.launchInstructions(h.launch,'storage-fund');
  const creditDecoded=SystemProgram.programId.equals(credit[0].programId)&&credit[0].data.readBigUInt64LE(4);
  assert.equal(creditDecoded,925880n);assert.equal(credit[0].keys[0].pubkey.toBase58(),keys.payer.address);assert.equal(credit[0].keys[1].pubkey.toBase58(),keys.platform.address);
  assert.equal((await h.c.prepare(h.launch,credit,[],'storage-credit')).needsSignature,true);
  assert.equal(fund[0].keys[0].pubkey.toBase58(),keys.platform.address);assert.equal(fund[0].keys[1].pubkey.toBase58(),h.launch.storage.recipient);assert.equal(fund[0].data.readBigUInt64LE(4),10000n);
  const op=await h.c.prepare(h.launch,fund,[],'storage-fund');
  assert.equal(op.state,'pending');verifySignedTransaction(Buffer.from(op.raw,'base64'),keys.platform.address);
  const normal=harness({external:false}),normalFund=await normal.c.launchInstructions(normal.launch,'storage-fund');
  assert.equal(normalFund[0].keys[0].pubkey.toBase58(),normal.launch.keys.payer.address);
  await assert.rejects(normal.c.launchInstructions(normal.launch,'storage-credit'),/Invalid image-storage funding wallet/);
});

test('creator fee claims need their external creator signature while managed fees retain server signing',async()=>{
  for(const feeMode of ['creator','holders','buyback']){
    const h=harness({feeMode}),w=new PublicKey(h.launch.keys.wallet.address),ix=SystemProgram.transfer({fromPubkey:w,toPubkey:Keypair.generate().publicKey,lamports:1000});
    const op=await h.c.prepare(h.launch,[ix],[],false);
    assert.equal(op.needsSignature===true,feeMode==='creator');
    if(feeMode!=='creator')verifySignedTransaction(Buffer.from(op.raw,'base64'),w.toBase58());
  }
});

test('unsigned requests cannot be broadcast accidentally',async()=>{
  const h=harness(),op=await h.c.prepare(h.launch,h.instructions,[],'create');
  await assert.rejects(h.c.broadcast(op),/needs a wallet signature/);assert.equal(h.sent.length,0);
  const signed=await h.c.acceptSigned(op,walletSign(op,h.payer));await h.c.broadcast(signed);assert.equal(h.sent.length,1);
});

async function realLaunch(feeMode='creator',devBuyPercent='10'){
  const {readFile}=await import('node:fs/promises'),{TOKEN_PROGRAM_ID}=await import('@solana/spl-token'),{ray,decodeRay,rayCurveAtTarget}=await import('../src/launchpad-chain.mjs'),{launchInput}=await import('../public/launchpad-model.mjs');
  const fixture=JSON.parse(await readFile(new URL('./launchpad-accounts.json',import.meta.url),'utf8'));
  const config=decodeRay({...fixture.rayConfig.account,owner:new PublicKey(fixture.rayConfig.account.owner),data:Buffer.from(fixture.rayConfig.account.data[0],'base64')},ray.LAUNCHPAD_PROGRAM,ray.LaunchpadConfig,'GlobalConfig');
  const h=harness({feeMode});h.launch.input=launchInput({name:'i cant sell',symbol:'SELL',quoteMint:SOL_MINT,feeMode,taxPercent:feeMode==='holders'?'3':'0',devBuyPercent});
  h.launch.uri='https://gateway.irys.xyz/'+'a'.repeat(43);h.launch.input.image='https://gateway.irys.xyz/'+'b'.repeat(43);
  h.launch.review={...rayCurveAtTarget(config,9,'100'),configId:fixture.rayConfig.pubkey,cpConfigId:'D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2',quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals:9,price:{usd:'100'},minimumSol:'0.06',creatorFeeBps:25,protocolFeeBps:25,platformRent:'15000000',serviceReserve:feeMode==='creator'?'0':'20000000'};
  h.c.c.getMinimumBalanceForRentExemption=async()=>2039280;
  h.launch.review.devBuy=await h.c.devBuyEstimate(h.launch.input,h.launch.review,{mint:{tlvData:Buffer.alloc(0)}});
  return h;
}

test('real Raydium external 10% SOL buys stay atomic and fit v0 after separate dedicated WSOL setup',async()=>{
  const {ray}=await import('../src/launchpad-chain.mjs'),{TOKEN_PROGRAM_ID}=await import('@solana/spl-token');
  for(const feeMode of ['creator','holders','buyback']){
    const h=await realLaunch(feeMode),fund=await h.c.launchInstructions(h.launch,'quote-fund'),address=await h.c.externalNativeFundingAddress(h.launch);
    assert.equal(fund.length,2);assert.equal(fund[0].keys[1].pubkey.toBase58(),address.toBase58());assert(fund[1].programId.equals(TOKEN_PROGRAM_ID));
    assert.equal((await h.c.externalNativeFundingAddress(h.launch)).toBase58(),address.toBase58());
    await h.c.preflightWalletSize(h.launch);
    const instructions=await h.c.launchInstructions(h.launch,'create'),op=await h.c.prepare(h.launch,instructions,[signer(h.launch.keys.mint.secret)],'create');
    assert(Buffer.from(op.unsignedRaw,'base64').length<=1232);assert.equal(op.needsSignature,true);
    const rayInstructions=instructions.filter(ix=>ix.programId.equals(ray.LAUNCHPAD_PROGRAM));assert.equal(rayInstructions.length,2);
    const buy=rayInstructions[1];assert.equal(buy.data.readBigUInt64LE(8),BigInt(h.launch.review.devBuy.net));assert(buy.keys.some(k=>k.pubkey.equals(address)));
    assert.equal(instructions.filter(ix=>ix.programId.equals(SystemProgram.programId)).length,0);
    const close=instructions.at(-1);assert(close.programId.equals(TOKEN_PROGRAM_ID));assert.equal(close.data[0],9);assert(close.keys[0].pubkey.equals(address));assert(close.keys[1].pubkey.equals(h.payer.publicKey));
    const ready=await h.c.acceptSigned(op,walletSign(op,h.payer));verifySignedTransaction(Buffer.from(ready.raw,'base64'),h.payer.publicKey.toBase58(),[h.launch.keys.mint.address]);
  }
});

test('native developer setup simulates credited WSOL and bounded SOL spend before offering wallet signing',async()=>{
  const {AccountLayout,TOKEN_PROGRAM_ID}=await import('@solana/spl-token'),h=await realLaunch(),address=await h.c.externalNativeFundingAddress(h.launch),amount=BigInt(h.launch.review.devBuy.maxQuote);
  const data=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint:new PublicKey(SOL_MINT),owner:h.payer.publicKey,amount,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:1,isNative:2039280n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);
  h.c.c.getMultipleAccountsInfoAndContext=async keys=>{assert.equal(keys[1].toBase58(),address.toBase58());return{context:{slot:80},value:[{owner:SystemProgram.programId,lamports:100000000000},null]};};
  let debit=Number(amount)+2040000,delivered=data;
  h.c.c.simulateTransaction=async(tx,config)=>{assert.equal(config.sigVerify,false);assert.equal(config.minContextSlot,80);assert.equal(config.accounts.addresses[1],address.toBase58());return{value:{err:null,unitsConsumed:30000,accounts:[{owner:SystemProgram.programId.toBase58(),lamports:100000000000-debit},{owner:TOKEN_PROGRAM_ID.toBase58(),lamports:2039280+Number(amount),data:[delivered.toString('base64'),'base64']} ]}};};
  const ixs=await h.c.launchInstructions(h.launch,'quote-fund');assert.equal((await h.c.prepare(h.launch,ixs,[],'quote-fund')).needsSignature,true);
  delivered=Buffer.from(data);delivered.writeBigUInt64LE(amount-1n,64);await assert.rejects(h.c.prepare(h.launch,ixs,[],'quote-fund'),/does not deliver enough/);
  delivered=data;debit=Number(amount)+6000001;await assert.rejects(h.c.prepare(h.launch,ixs,[],'quote-fund'),/exceeds the reviewed SOL budget/);
});

test('oversized external platform details are detected during draft preflight before any signature or broadcast',async()=>{
  const h=await realLaunch();h.launch.publicOrigin='https://app.example/'+'a'.repeat(800);
  await assert.rejects(h.c.preflightWalletSize(h.launch),/above this wallet.*1,232-byte limit/);
  assert.equal(h.simulations.length,0);assert.equal(h.sent.length,0);
});

test('platform creation retains its server authority signature while external developer approval is missing',async()=>{
  for(const feeMode of ['creator','holders']){
    const h=await realLaunch(feeMode,'0'),instructions=await h.c.launchInstructions(h.launch,'platform');
    const op=await h.c.prepare(h.launch,instructions,[signer(h.launch.keys.platform.secret)],'platform');
    assert.equal(op.needsSignature,true);
    const accepted=await h.c.acceptSigned(op,walletSign(op,h.payer));
    verifySignedTransaction(Buffer.from(accepted.raw,'base64'),h.launch.keys.payer.address,[h.launch.keys.platform.address]);
  }
});

test('external storage signer rent comes from the RPC and is required in its funding instructions',async()=>{
  const calls=[],h=harness();h.c.c.getMinimumBalanceForRentExemption=async size=>{calls.push(size);return size===0?1234567:2039280;};
  const estimate=await h.c.fundingEstimate({walletMode:'external',feeMode:'creator',taxBps:0});
  assert.equal(estimate.storageWalletRent,'1234567');assert(calls.includes(0));
  h.launch.review.storageWalletRent=estimate.storageWalletRent;
  const credit=await h.c.launchInstructions(h.launch,'storage-credit');assert.equal(credit[0].data.readBigUInt64LE(4),1269567n);
  for(const rent of [undefined,'0','-1','x']){h.launch.review.storageWalletRent=rent;await assert.rejects(h.c.launchInstructions(h.launch,'storage-credit'),/reserve is missing/);}
  calls.length=0;const normal=await h.c.fundingEstimate({walletMode:'default',feeMode:'creator',taxBps:0});assert.equal(normal.storageWalletRent,undefined);assert.equal(calls.includes(0),false);
});

test('compact launch setup handles storage, fee platform and developer funding within one wallet approval',async()=>{
  const {AccountLayout,TOKEN_PROGRAM_ID}=await import('@solana/spl-token');
  for(const feeMode of ['creator','holders','buyback']){
    const h=await realLaunch(feeMode);h.launch.executionPlan='compact-v2';h.launch.publicOrigin='https://app.example/'+'x'.repeat(2000);h.launch.review.storageWalletRent='890880';
    h.launch.input.name='N'.repeat(32);h.launch.input.symbol='S'.repeat(10);h.launch.uri='https://gateway.irys.xyz/'+'a'.repeat(44);
    const review=await h.c.preflightWalletSize(h.launch);assert.equal(review.transactions,2);assert.equal(review.setupLamports,h.c.setupCost(h.launch));
    const address=await h.c.externalNativeFundingAddress(h.launch),data=Buffer.alloc(AccountLayout.span),amount=BigInt(h.launch.review.devBuy.maxQuote);
    AccountLayout.encode({mint:new PublicKey(SOL_MINT),owner:h.payer.publicKey,amount,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:1,isNative:2039280n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);
    h.c.c.getMultipleAccountsInfoAndContext=async()=>({context:{slot:80},value:[{owner:SystemProgram.programId,lamports:100000000000},null]});
    h.c.c.simulateTransaction=async(tx,config)=>{assert.equal(config.sigVerify,false);assert.equal(config.accounts.addresses[1],address.toBase58());return{value:{err:null,unitsConsumed:100000,accounts:[{owner:SystemProgram.programId.toBase58(),lamports:100000000000-Number(h.c.setupCost(h.launch))},{owner:TOKEN_PROGRAM_ID.toBase58(),lamports:2039280+Number(amount),data:[data.toString('base64'),'base64']} ]}};};
    const instructions=await h.c.launchInstructions(h.launch,'setup');assert.equal(instructions.length,5);assert(!instructions.some(ix=>ix.data.includes(Buffer.from(h.launch.publicOrigin))));
    const op=await h.c.prepare(h.launch,instructions,[signer(h.launch.keys.platform.secret)],'setup');assert(Buffer.from(op.unsignedRaw,'base64').length<=1232);
    const signed=await h.c.acceptSigned(op,walletSign(op,h.payer));verifySignedTransaction(Buffer.from(signed.raw,'base64'),h.launch.keys.payer.address,[h.launch.keys.platform.address]);
    await assert.rejects(h.c.launchInstructions(h.launch,'launch-all'),/needs its reviewed setup/);
  }
});

test('free metadata and no developer buy combine fee setup and launch into one v0 transaction',async()=>{
  const {ray}=await import('../src/launchpad-chain.mjs');
  for(const feeMode of ['creator','holders','buyback']){
    const h=await realLaunch(feeMode,'0');h.launch.executionPlan='compact-v2';h.launch.storage.budget='0';h.launch.publicOrigin='https://app.example/'+'x'.repeat(2000);
    h.launch.input.name='N'.repeat(32);h.launch.input.symbol='S'.repeat(10);h.launch.uri='https://gateway.irys.xyz/'+'a'.repeat(44);
    const review=await h.c.preflightWalletSize(h.launch);assert.equal(review.transactions,1);
    const instructions=await h.c.launchInstructions(h.launch,'launch-all'),op=await h.c.prepare(h.launch,instructions,[signer(h.launch.keys.platform.secret),signer(h.launch.keys.mint.secret)],'launch-all');
    assert(Buffer.from(op.unsignedRaw,'base64').length<=1232);assert.equal(instructions.filter(ix=>ix.programId.equals(ray.LAUNCHPAD_PROGRAM)).length,2);
    const signed=await h.c.acceptSigned(op,walletSign(op,h.payer));verifySignedTransaction(Buffer.from(signed.raw,'base64'),h.launch.keys.payer.address,[h.launch.keys.platform.address,h.launch.keys.mint.address]);
  }
});

test('SOL developer budgets include exact curve fees, preserve their spend cap, and never need a fixed token percentage',async()=>{
  const h=await realLaunch(),{launchInput}=await import('../public/launchpad-model.mjs');
  h.launch.input=launchInput({name:'SOL budget',symbol:'SOLBUY',walletMode:'external',externalWallet:h.payer.publicKey.toBase58(),quoteMint:SOL_MINT,feeMode:'creator',devBuySol:'0.01'});
  h.launch.review.devBuy=await h.c.devBuyEstimate(h.launch.input,h.launch.review,{mint:{tlvData:Buffer.alloc(0)}});
  const d=h.launch.review.devBuy;assert.equal(d.solBudget,'10000000');assert(BigInt(d.gross)>0n);assert(BigInt(d.gross)<1000000000000n);assert(BigInt(d.maxQuote)<=10000000n);
  await h.c.launchInstructions(h.launch,'create');
  const savedBudget=d.solBudget;d.solBudget='10000001';await assert.rejects(h.c.launchInstructions(h.launch,'create'),/reviewed supply limit/);d.solBudget=savedBudget;
  const maxQuote=d.maxQuote;d.maxQuote='10000001';await assert.rejects(h.c.launchInstructions(h.launch,'create'),/reviewed SOL budget/);d.maxQuote=maxQuote;
  h.launch.input.devBuyLamports='1000000000000000';await assert.rejects(h.c.devBuyEstimate(h.launch.input,h.launch.review,{mint:{tlvData:Buffer.alloc(0)}}),/Use at most .* SOL/);
});

const lookupSnapshot=(addresses,{owner=undefined,slot=100,lastExtendedSlot=50,deactivationSlot=18446744073709551615n}={})=>{
  const data=Buffer.alloc(56+32*addresses.length);data.writeUInt32LE(1);data.writeBigUInt64LE(deactivationSlot,4);data.writeBigUInt64LE(BigInt(lastExtendedSlot),12);addresses.forEach((address,index)=>new PublicKey(address).toBuffer().copy(data,56+32*index));
  return{context:{slot},value:{owner:owner||new PublicKey('AddressLookupTab1e1111111111111111111111111'),data}};
};

test('transaction compression uses only active onchain lookup-table contents and preserves required signer keys',async()=>{
  const h=harness(),addresses=Array.from({length:36},()=>Keypair.generate().publicKey),table=Keypair.generate().publicKey;
  h.c.c.getAccountInfoAndContext=async key=>{assert(key.equals(table)||key.toBase58()==='AcL1Vo8oy1ULiavEcjSUcwfBSForXMudcZvDZy5nzJkU');return lookupSnapshot(addresses);};
  const instructions=[new TransactionInstruction({programId:SystemProgram.programId,keys:[{pubkey:h.payer.publicKey,isSigner:true,isWritable:true},...addresses.map(pubkey=>({pubkey,isSigner:false,isWritable:false}))],data:Buffer.alloc(8)})];
  const op=await h.c.prepare(h.launch,instructions,[],'create'),tx=VersionedTransaction.deserialize(Buffer.from(op.unsignedRaw,'base64'));
  assert(tx.message.addressTableLookups.length>0);assert.equal(tx.message.staticAccountKeys[0].toBase58(),h.payer.publicKey.toBase58());assert(Buffer.from(op.unsignedRaw,'base64').length<=1232);
  await h.c.acceptSigned(op,walletSign(op,h.payer));
  for(const snapshot of [lookupSnapshot(addresses,{owner:SystemProgram.programId}),lookupSnapshot(addresses,{deactivationSlot:1n}),lookupSnapshot(addresses,{lastExtendedSlot:100})]){
    h.c.c.getAccountInfoAndContext=async()=>snapshot;await assert.rejects(h.c.lookupTables([table.toBase58()]),/unavailable|inactive|warming up/);
  }
});

test('non-SOL conversion is quoted inside the exact SOL budget and rejects mismatched or unsafe routes',async()=>{
  const {USDC_MINT,launchInput}=await import('../public/launchpad-model.mjs'),h=await realLaunch();
  h.launch.input=launchInput({name:'USD quote',symbol:'USD',quoteMint:USDC_MINT,feeMode:'creator',devBuySol:'0.05'});
  h.c.jupiterGate={acquire:async()=>{},cooldown:()=>{}};
  const good={inputMint:SOL_MINT,outputMint:USDC_MINT,inAmount:'50000000',outAmount:'1100000',otherAmountThreshold:'1000000',swapMode:'ExactIn',slippageBps:100,priceImpactPct:'.001',routePlan:[{}]};let body=good;
  h.c.fetcher=async url=>{const parsed=new URL(url);assert.equal(parsed.searchParams.get('amount'),'50000000');return new Response(JSON.stringify(body));};
  const d=await h.c.devBuyEstimate(h.launch.input,h.launch.review,{mint:{tlvData:Buffer.alloc(0)}});assert.equal(d.solBudget,'50000000');
  // v71.34: the reviewed pair budget keeps a 5% drift allowance under the route's guaranteed output.
  assert.equal(d.routeMinimumQuote,'1000000');assert.equal(d.quoteDriftBps,500);assert.equal(d.quoteBudget,'950000');assert(BigInt(d.maxQuote)<=950000n);
  for(const changed of [{inAmount:'50000001'},{inputMint:USDC_MINT},{otherAmountThreshold:'1200000'},{slippageBps:101},{priceImpactPct:'.5'},{routePlan:[]}]){body={...good,...changed};await assert.rejects(h.c.devBuyEstimate(h.launch.input,h.launch.review,{mint:{tlvData:Buffer.alloc(0)}}),/does not match your SOL budget/);}
});

test('lagging simulation backends retry the identical message and snapshot without sending funds',async()=>{
  const h=await realLaunch(),{AccountLayout,TOKEN_PROGRAM_ID}=await import('@solana/spl-token'),amount=BigInt(h.launch.review.devBuy.maxQuote),data=Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({mint:new PublicKey(SOL_MINT),owner:h.payer.publicKey,amount,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:1,isNative:2039280n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);
  h.c.c.getMultipleAccountsInfoAndContext=async()=>({context:{slot:12345},value:[{owner:SystemProgram.programId,lamports:100000000000},null]});
  const calls=[],delays=[];h.c.sleep=async ms=>{delays.push(ms);};
  h.c.c.simulateTransaction=async(tx,options)=>{
    calls.push({raw:Buffer.from(tx.serialize()).toString('base64'),options:structuredClone(options)});
    if(calls.length<3)throw Object.assign(Error('failed to simulate transaction: Minimum context slot has not been reached'),{code:-32016});
    return{context:{slot:12345},value:{err:null,unitsConsumed:10000,accounts:[{owner:SystemProgram.programId.toBase58(),lamports:100000000000-Number(amount)-2040000},{owner:TOKEN_PROGRAM_ID.toBase58(),lamports:Number(amount)+2039280,data:[data.toString('base64'),'base64']}]}};
  };
  const instructions=await h.c.launchInstructions(h.launch,'quote-fund'),op=await h.c.prepare(h.launch,instructions,[],'quote-fund');
  assert.equal(op.needsSignature,true);assert.equal(calls.length,3);assert.deepEqual(delays,[250,750]);
  assert(calls.every(call=>call.raw===calls[0].raw));assert(calls.every(call=>call.options.minContextSlot===12345&&call.options.commitment==='finalized'&&call.options.sigVerify===false));
  assert.equal(h.sent.length,0);
});

test('simulation lag has a bounded retry marker; stale results, expired blockhashes and other errors never weaken checks',async()=>{
  const h=harness(),delays=[];h.c.sleep=async ms=>delays.push(ms);let attempts=0;
  h.c.c.simulateTransaction=async()=>{attempts++;throw Error('Minimum context slot has not been reached');};
  await assert.rejects(h.c.prepare(h.launch,h.instructions,[],'create'),error=>error.code===-32016&&error.launchCode==='LAUNCH_RPC_CONTEXT_LAG'&&error.retryable===true);
  assert.equal(attempts,3);assert.deepEqual(delays,[250,750]);assert.equal(h.sent.length,0);
  attempts=0;h.setHeight(101);
  await assert.rejects(h.c.prepare(h.launch,h.instructions,[],'create'),error=>error.code==='LAUNCH_BLOCKHASH_EXPIRED'&&error.retryable===true);assert.equal(attempts,3,'unsigned preparation retries with a fresh blockhash at most three times');
  h.setHeight(99);attempts=0;
  h.c.c.simulateTransaction=async()=>{attempts++;throw Object.assign(Error('RPC authorization failed'),{code:-32002});};
  await assert.rejects(h.c.prepare(h.launch,h.instructions,[],'create'),/authorization failed/);assert.equal(attempts,1);
  attempts=0;h.c.c.simulateTransaction=async()=>{attempts++;return{context:{slot:99},value:{err:null}};};
  await assert.rejects(h.c.simulatePrepared({}, {minContextSlot:100},100),error=>error.launchCode==='LAUNCH_RPC_CONTEXT_LAG');assert.equal(attempts,3);
  assert.equal(h.sent.length,0);
});

test('v3 setup funds automatic platform initialization and rent while retaining two external approvals',async()=>{
  const {ray}=await import('../src/launchpad-chain.mjs');
  for(const budget of ['0','10000'])for(const feeMode of ['creator','holders','buyback']){
    const h=await realLaunch(feeMode,'0');h.launch.executionPlan='compact-v3';h.launch.storage.budget=budget;h.launch.review.storageWalletRent='890880';
    const setup=await h.c.launchInstructions(h.launch,'setup'),expected=15000000n+BigInt(h.launch.review.serviceReserve)+890880n+25000n+(BigInt(budget)?BigInt(budget)+25000n:0n);
    assert.equal(setup.length,1);assert.equal(setup[0].data.readBigUInt64LE(4),expected);
    const op=await h.c.prepare(h.launch,setup,[],'setup'),signed=await h.c.acceptSigned(op,walletSign(op,h.payer));
    verifySignedTransaction(Buffer.from(signed.raw,'base64'),h.launch.keys.payer.address,[]);
    const automatic=await h.c.launchInstructions(h.launch,'platform-setup');assert.equal(automatic.length,1);assert(automatic[0].programId.equals(ray.LAUNCHPAD_PROGRAM));
    const autoOp=await h.c.prepare(h.launch,automatic,[],'platform-setup');assert.equal(autoOp.needsSignature,undefined);
    verifySignedTransaction(Buffer.from(autoOp.raw,'base64'),h.launch.keys.platform.address,[]);
    assert.equal(h.simulations.at(-1).config.sigVerify,true);assert.equal(h.c.setupCost(h.launch),(expected+100000n).toString());
    assert.equal((await h.c.preflightWalletSize(h.launch)).transactions,budget==='0'?1:2);assert.equal(h.sent.length,0);
    h.launch.review.storageWalletRent='0';await assert.rejects(h.c.launchInstructions(h.launch,'setup'),/reserve is missing/);
  }
});

test('connected launches include a nonzero creation fee inside atomic creation and check packet size before paid setup',async()=>{
  const {ray}=await import('../src/launchpad-chain.mjs');
  for(const mode of ['creator','holders','buyback'])for(const buy of ['0','0.1']){
    const h=await realLaunch(mode,buy);h.launch.executionPlan='compact-v3';h.launch.review.storageWalletRent='890880';
    h.launch.review.platformFeeBps=100;h.launch.review.protocolFees={recipient:Keypair.generate().publicKey.toBase58(),curveFeeBps:100,creationFeeSol:'0.03',lpPolicy:'burn'};
    h.launch.review.devBuy=await h.c.devBuyEstimate(h.launch.input,h.launch.review,{mint:{tlvData:Buffer.alloc(0)}});
    const plan=await h.c.preflightWalletSize(h.launch);assert(plan.transactions>=1);assert.equal(h.sent.length,0);assert.equal(h.simulations.length,0);
    const instructions=await h.c.launchInstructions(h.launch,'create'),fee=instructions.at(-1);assert(fee.programId.equals(SystemProgram.programId));assert.equal(fee.data.readBigUInt64LE(4),30000000n);
    assert.equal(fee.keys[1].pubkey.toBase58(),h.launch.review.protocolFees.recipient);
    assert.equal(instructions.filter(ix=>ix.programId.equals(ray.LAUNCHPAD_PROGRAM)).length,buy==='0'?1:2);
    const op=await h.c.prepare(h.launch,instructions,[signer(h.launch.keys.mint.secret)],'create');assert(Buffer.from(op.unsignedRaw,'base64').length<=1232);
  }
});

test('verified lookup tables are reordered to avoid duplicate overhead without moving signers into lookup indexes',async()=>{
  const {AddressLookupTableAccount}=await import('@solana/web3.js'),h=harness(),addresses=Array.from({length:25},()=>Keypair.generate().publicKey);
  const table=items=>new AddressLookupTableAccount({key:Keypair.generate().publicKey,state:{deactivationSlot:18446744073709551615n,lastExtendedSlot:1,lastExtendedSlotStartIndex:0,addresses:items}});
  const instructions=[new TransactionInstruction({programId:SystemProgram.programId,keys:[{pubkey:h.payer.publicKey,isSigner:true,isWritable:true},...addresses.map(pubkey=>({pubkey,isSigner:false,isWritable:false}))],data:Buffer.alloc(250)})];
  instructions.lookupTables=[table([addresses[0]]),table(addresses)];
  const op=await h.c.prepare(h.launch,instructions,[],'create'),tx=VersionedTransaction.deserialize(Buffer.from(op.unsignedRaw,'base64'));
  assert.equal(tx.message.addressTableLookups.length,1);assert(tx.message.addressTableLookups[0].accountKey.equals(instructions.lookupTables[1].key));
  assert.equal(tx.message.staticAccountKeys[0].toBase58(),h.payer.publicKey.toBase58());await h.c.acceptSigned(op,walletSign(op,h.payer));
});
