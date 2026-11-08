import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, SystemProgram, TransactionMessage } from '@solana/web3.js';
import { validatePlatformContext, platformFeePlan, preparePlatformFee, settlePlatformFee, verifyPlatformFee, recordPlatformFee } from '../src/platform-fees.mjs';
import { makeTransaction, prepareTransaction } from '../src/providers.mjs';
import { SOL, validateConfig } from '../src/core.mjs';
import { key1, key2, mint, quote, config, build } from './fixtures.mjs';
const wallet={publicKey:key1.publicKey.toBase58(),keypair:key1};
const context=validatePlatformContext({accountId:'settlement-account',recipient:key2.publicKey.toBase58(),mainWallet:quote,cashbackBps:2000,settlement:'sol'});
const signal=new AbortController().signal;
async function setup(outputMint=SOL, amount=1000000n) {
 const order={kind:'sell',inputMint:mint,outputMint,amount,receivedAt:Date.now()};
 const fee=await preparePlatformFee(platformFeePlan(context,'copy',mint,amount,wallet.publicKey),{},signal,{order});
 const routeOrder={...order,amount:BigInt(fee.plan.swapAmount)};
 return {order,fee,routeOrder,route:{...build(routeOrder,wallet),outAmount:'100000000',otherAmountThreshold:'98000000'}};
}
test('token-to-SOL full exits collect native SOL after the swap without another quote or token debit',async()=>{
 const {fee,routeOrder,route}=await setup(); assert.equal(routeOrder.amount,1000000n);
 const result=await settlePlatformFee(route,fee,{jupiterBuild(){throw Error('unexpected second quote');}},routeOrder,wallet,signal);
 assert.equal(fee.plan.mint,SOL); assert.equal(fee.plan.chargedAmount,'245000'); assert.equal(fee.plan.sourceFeeAmount,'2500');
 assert.equal(result.otherAmountThreshold,'97755000'); assert.equal(result.outAmount,'99755000');
 assert.equal(result.platformFeeAfterInstructions.length,1); assert.deepEqual(result.platformFeeInstructions,[]);
 const c=validateConfig(config({mode:'live'})), packed=makeTransaction(result,wallet,c,[]); packed.tx.sign([key1]);
 const ixs=TransactionMessage.decompile(packed.tx.message).instructions;
 const transfers=ixs.filter(ix=>ix.programId.equals(SystemProgram.programId));
 assert(transfers.length>=2);
 const last=ixs.findIndex(ix=>ix.keys.some(k=>k.pubkey.equals(key2.publicKey)));
 const main=ixs.findIndex(ix=>ix.keys.some(k=>k.pubkey.toBase58()===quote)); assert(last>main);
});
test('token-to-token fees use only their carved input, convert to SOL and transfer in the same transaction',async()=>{
 const {fee,routeOrder,route}=await setup(quote); assert.equal(routeOrder.amount,997500n);
 let requested; const provider={async jupiterBuild(order,w){requested=order; return {...build(order,w),outAmount:'12300',otherAmountThreshold:'12000'};}};
 const result=await settlePlatformFee(route,fee,provider,routeOrder,wallet,signal);
 assert.equal(requested.inputMint,mint); assert.equal(requested.outputMint,SOL); assert.equal(requested.amount,2500n);
 assert.equal(requested.amount+routeOrder.amount,1000000n); assert.equal(fee.plan.chargedAmount,'12000'); assert.equal(fee.plan.destination,context.recipient);
 assert.equal(result.platformFeeInstructions.length,2); assert.equal(result.requiresSimulation,true); assert.equal(result.feeSettlementLocked,true);
 assert(!result.platformFeeInstructions.some(ix=>ix.programId.toBase58()==='ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'));
});
test('conversion errors stop the whole build, with no token collection fallback',async()=>{
 const {fee,routeOrder,route}=await setup(quote);
 await assert.rejects(settlePlatformFee(route,fee,{async jupiterBuild(){throw Object.assign(Error('No fee conversion route'),{routeUnavailable:true});}},routeOrder,wallet,signal),/No fee conversion route/);
 assert.deepEqual(fee.instructions,[]); assert.equal(fee.plan.mint,mint);
});
test('cashback records only the independently verifiable native SOL received',async()=>{
 const {fee,routeOrder,route}=await setup(); await settlePlatformFee(route,fee,{},routeOrder,wallet,signal);
 const pending={signature:'receipt-signature',wallet:wallet.publicKey,createdAt:Date.now(),order:{platformFee:fee.plan}};
 const tx={transaction:{signatures:[pending.signature],message:{accountKeys:[wallet.publicKey,context.recipient],instructions:[{programId:SystemProgram.programId.toBase58(),parsed:{type:'transfer',info:{source:wallet.publicKey,destination:context.recipient,lamports:245000}}}]}},meta:{err:null,preBalances:[10000000,1000000],postBalances:[1000000,1245000]}};
 const receipt=verifyPlatformFee(pending,tx); assert.equal(receipt.mint,SOL); assert.equal(receipt.amount,'245000'); assert.equal(receipt.cashbackAmount,'49000');
 const ledger={data:{}}; recordPlatformFee(ledger,pending,receipt); recordPlatformFee(ledger,pending,receipt); assert.equal(ledger.data.feeReceipts.length,1);
 tx.meta.postBalances[1]--; assert.throws(()=>verifyPlatformFee(pending,tx),/differs/);
 tx.meta.err='failed'; assert.throws(()=>verifyPlatformFee(pending,tx),/successful/);
});
test('sub-lamport proceeds fees round down without blocking a tiny full exit',async()=>{
 const {fee,routeOrder,route}=await setup(); const result=await settlePlatformFee({...route,outAmount:'101',otherAmountThreshold:'100'},fee,{},routeOrder,wallet,signal);
 assert.equal(fee.plan,null); assert.equal(result.otherAmountThreshold,'100'); assert.equal(routeOrder.amount,1000000n);
});
test('an oversized atomic settlement never requotes the trade while retaining a stale SOL fee',async()=>{
 const {fee,routeOrder,route}=await setup(); let result=await settlePlatformFee(route,fee,{},routeOrder,wallet,signal);
 result.nativeInstructions=[{programId:SystemProgram.programId,keys:Array.from({length:70},(_,i)=>({pubkey:new PublicKey(new Uint8Array(32).fill(i+1)),isSigner:false,isWritable:true})),data:Buffer.alloc(4)}];
 let quotes=0;
 await assert.rejects(prepareTransaction(result,routeOrder,wallet,validateConfig(config({mode:'live'})),{jitoTips:[],jupiterBuild(){quotes++;}},signal),/atomic SOL fee conversion exceeds/);
 assert.equal(quotes,0);
});

test('sniper token exits settle 1% in SOL while copy exits retain 0.25%', async () => {
  for (const [kind, expected] of [['sniper','980000'],['copy','245000']]) {
    const order={kind:'sell',inputMint:mint,outputMint:SOL,amount:1000000n};
    const fee=await preparePlatformFee(platformFeePlan(context,kind,mint,order.amount,wallet.publicKey),{},signal,{order});
    const result=await settlePlatformFee({...build(order,wallet),outAmount:'100000000',otherAmountThreshold:'98000000'},fee,{},order,wallet,signal);
    assert.equal(fee.plan.chargedAmount,expected); assert.equal(fee.plan.kind,kind);
    assert.equal(result.otherAmountThreshold,String(98000000n-BigInt(expected)));
  }
});
