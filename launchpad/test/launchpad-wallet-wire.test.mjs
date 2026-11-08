import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createLaunchpadWallet } from '../public/launchpad-wallet.mjs';

const SIGN='solana:signTransaction',CHAIN='solana:mainnet';
const encode=tx=>Buffer.from(tx.serialize()).toString('base64');

// Wallet Standard is one shared wire contract. These modeled registrations test
// Launchpad's handling of each name; they are not real extension integration tests.
for(const name of ['Solflare','Phantom','Backpack'])test(`${name} Wallet Standard preserves exactly the returned signed packet`,async()=>{
 const {window}=parseHTML('<html></html>'),payer=Keypair.generate(),recipient=Keypair.generate().publicKey;
 const account={address:String(payer.publicKey),publicKey:payer.publicKey.toBytes(),chains:[CHAIN],features:[SIGN]};
 const original=new VersionedTransaction(new TransactionMessage({payerKey:payer.publicKey,recentBlockhash:String(Keypair.generate().publicKey),instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:500000}),SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:recipient,lamports:1})]}).compileToV0Message());
 let mode='exact',returnedWire='',calls=0,broadcasts=0;
 const wallet={name,chains:[CHAIN],accounts:[account],features:{
  'standard:connect':{async connect(){return{accounts:[account]};}},
  'standard:events':{on(){return()=>{};}},
  'solana:signAndSendTransaction':{async signAndSendTransaction(){broadcasts++;throw Error('Unexpected broadcast');}},
  [SIGN]:{supportedTransactionVersions:[0],async signTransaction(input){
   calls++;assert.equal(input.account,account);assert.equal(input.chain,CHAIN);assert.equal(Buffer.from(input.transaction).toString('base64'),encode(original));
   const builder=TransactionMessage.decompile(VersionedTransaction.deserialize(input.transaction).message);
   if(mode==='price')builder.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({microLamports:1000}));
   if(mode==='guard')builder.instructions.push(new TransactionInstruction({programId:new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'),keys:[{pubkey:payer.publicKey,isSigner:false,isWritable:false}],data:Buffer.concat([Buffer.from([5,0,0]),Buffer.alloc(8),Buffer.from([4])])}));
   const signed=new VersionedTransaction(builder.compileToV0Message());signed.sign([payer]);returnedWire=encode(signed);
   // Providers may return a view with a nonzero offset into a larger buffer.
   const serialized=signed.serialize(),storage=new Uint8Array(serialized.length+12);storage.set(serialized,7);
   return[{signedTransaction:storage.subarray(7,7+serialized.length)}];
  }},
 }};
 const ui=createLaunchpadWallet({window});window.dispatchEvent(new window.CustomEvent('wallet-standard:register-wallet',{detail:api=>api.register(wallet)}));await ui.connect(ui.state().wallets[0].id);
 for(mode of ['exact','price','guard']){
  const result=await ui.sign({wallet:String(payer.publicKey),transaction:encode(original),operationId:'reviewed-launch'});
  assert.equal(result,returnedWire,'Launchpad must not recompile, remove or add instructions to wallet-signed bytes');
 }
 assert.equal(calls,3);assert.equal(broadcasts,0);ui.dispose();
});
