import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,SystemProgram,TransactionMessage} from '@solana/web3.js';
import {creationFeeExpectation,creationFeeReceipt} from '../src/launchpad-creation-receipt.mjs';
const payer=Keypair.generate().publicKey,recipient=Keypair.generate().publicKey;
const expected={amount:'30000000',recipient:recipient.toBase58(),payer:payer.toBase58()};
function transaction({to=recipient,amount=30000000n,credit=30000000,twice=false}={}){
 const instruction=SystemProgram.transfer({fromPubkey:payer,toPubkey:to,lamports:amount});
 const message=new TransactionMessage({payerKey:payer,recentBlockhash:Keypair.generate().publicKey.toBase58(),instructions:twice?[instruction,instruction]:[instruction]}).compileToV0Message();
 const preBalances=message.staticAccountKeys.map(()=>1000000000),postBalances=[...preBalances];
 postBalances[message.staticAccountKeys.findIndex(k=>k.equals(to))]+=credit;
 return {transaction:{message},meta:{err:null,preBalances,postBalances,loadedAddresses:{writable:[],readonly:[]}}};
}
test('creation revenue counts only the exact confirmed transfer to the reviewed treasury',()=>{
 const receipt=creationFeeReceipt(transaction(),expected);assert.equal(receipt.amount,'30000000');assert.equal(receipt.recipient,expected.recipient);assert.equal(receipt.decimals,9);
 assert.throws(()=>creationFeeReceipt(transaction({amount:30000001n}),expected),/differs/);
 assert.throws(()=>creationFeeReceipt(transaction({credit:0}),expected),/did not reach/);
 assert.throws(()=>creationFeeReceipt(transaction({twice:true,credit:60000000}),expected),/differs/);
 assert.throws(()=>creationFeeReceipt(transaction({to:Keypair.generate().publicKey}),expected),/missing/);
 const failed=transaction();failed.meta.err={InstructionError:[0,'Custom']};assert.throws(()=>creationFeeReceipt(failed,expected),/confirm/);
});
test('creation expectations preserve signed destinations and exclude self-payment and untracked history',()=>{
 const launch={review:{protocolFees:{recipient:expected.recipient,creationFeeSol:'0.03'}},keys:{payer:{address:expected.payer},wallet:{address:'service'}}};
 const saved=creationFeeExpectation(launch,'launch-all');launch.review.protocolFees.recipient='new-treasury';assert.deepEqual(saved,expected);
 assert.equal(creationFeeExpectation(launch,'setup'),null);assert.equal(creationFeeReceipt(transaction(),null),null);
 assert.equal(creationFeeReceipt(transaction(),{...expected,amount:'0'}).amount,'0');
 assert.equal(creationFeeReceipt(transaction({to:payer,credit:0}),{...expected,recipient:expected.payer}).amount,'0');
});
