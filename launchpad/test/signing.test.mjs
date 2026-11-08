import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { Keypair, TransactionMessage, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import bs58 from 'bs58';
import { parseWallet } from '../src/core.mjs';
import { verifySignedTransaction } from '../src/providers.mjs';
import { key1, key2, blockhash } from './fixtures.mjs';

function transaction() {
  return new VersionedTransaction(new TransactionMessage({
    payerKey:key1.publicKey, recentBlockhash:blockhash,
    instructions:[SystemProgram.transfer({fromPubkey:key1.publicKey,toPubkey:key2.publicKey,lamports:1})],
  }).compileToV0Message());
}
function independentVerify(tx) {
  const publicKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),key1.publicKey.toBuffer()]),format:'der',type:'spki'});
  return verify(null,tx.message.serialize(),publicKey,tx.signatures[0]);
}

test('all supported private-key formats still produce valid signatures after parser cleanup',()=>{
  const formats={
    base58:bs58.encode(key1.secretKey), json:JSON.stringify([...key1.secretKey]),
    seedBase58:'seed:'+bs58.encode(key1.secretKey.slice(0,32)), seedJson:'seed:'+JSON.stringify([...key1.secretKey.slice(0,32)]),
  };
  const expected=transaction();expected.sign([key1]);
  for(const [format,privateKey] of Object.entries(formats)){
    const row={privateKey},wallet=parseWallet(row,0,'live'),tx=transaction();
    assert.equal(row.privateKey,'');assert.equal(wallet.publicKey,key1.publicKey.toBase58());
    tx.sign([wallet.keypair]);
    assert(independentVerify(tx),`${format}: signature must verify after cleanup`);
    assert.deepEqual(tx.signatures[0],expected.signatures[0],`${format}: deterministic signature must match the original key`);
    assert.equal(verifySignedTransaction(tx.serialize(),wallet.publicKey).signature,bs58.encode(expected.signatures[0]));
  }
});

test('the original shared-buffer bug reproduces an invalid signature and the broadcast guard rejects it',()=>{
  const buffer=Uint8Array.from(key1.secretKey),signer=Keypair.fromSecretKey(buffer);
  buffer.fill(0); // Reproduces the old parseWallet finally block.
  assert(signer.publicKey.equals(key1.publicKey));
  const tx=transaction();tx.sign([signer]);
  assert.equal(independentVerify(tx),false);
  assert.throws(()=>verifySignedTransaction(tx.serialize()),/Local transaction signature verification failed/);
});

test('wire verification rejects unsigned, corrupted, changed-message, wrong-payer and noncanonical payloads',()=>{
  const valid=transaction();valid.sign([key1]);const bytes=valid.serialize();
  assert.doesNotThrow(()=>verifySignedTransaction(bytes,key1.publicKey.toBase58()));
  assert.throws(()=>verifySignedTransaction(bytes,key2.publicKey.toBase58()),/signature verification failed/);
  const changedSignature=VersionedTransaction.deserialize(bytes);changedSignature.signatures[0][0]^=1;
  const changedBlockhash=VersionedTransaction.deserialize(bytes);changedBlockhash.message.recentBlockhash=key2.publicKey.toBase58();
  const changedInstruction=VersionedTransaction.deserialize(bytes);changedInstruction.message.compiledInstructions[0].data[4]^=1;
  for(const payload of [transaction().serialize(),changedSignature.serialize(),changedBlockhash.serialize(),changedInstruction.serialize(),Buffer.concat([bytes,Buffer.from([0])]),Buffer.alloc(0),Buffer.alloc(1233)]){
    assert.throws(()=>verifySignedTransaction(payload),/signature verification failed/);
  }
});
