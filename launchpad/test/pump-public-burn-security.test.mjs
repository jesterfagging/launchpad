import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import { verifyPublicLpBurn } from '../src/pump-public-adapter.mjs';
const address={pool:new PublicKey('9RZpWPugeURMhLicm5Yxbaew74w6g4ZqrFpceuNe5iKj'),lpMint:new PublicKey('54fP5QXhRZg9VjFSGpdBQ77vp3TjfqkKWdVsPS6YCTPJ'),authority:new PublicKey('EjfXi19N8FdK3yiCAuQNozjqcxA6vRyBPSChvHV1pk1S'),authorityLp:new PublicKey('GywfwbCducHpM1u6a7BadWi85hetoyCPmA329gXbwBKW')};
const state={phase:2,pool:address.pool.toBase58(),burnedLp:'512870391664',graduationPaid:'398214659'};
// The receipt shape of a finalized migration: the pool mints LP to the authority and the same transaction burns all of it.
function receipt(){const shared={account:address.authorityLp.toBase58(),amount:state.burnedLp,mint:address.lpMint.toBase58()};return{transaction:{message:{accountKeys:[address.authorityLp.toBase58()]}},meta:{err:null,innerInstructions:[{instructions:[{programId:'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',parsed:{type:'mintTo',info:{...shared,mintAuthority:address.pool.toBase58()}}},{programId:'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',parsed:{type:'burn',info:{...shared,authority:address.authority.toBase58()}}}]}],postTokenBalances:[{accountIndex:0,mint:address.lpMint.toBase58(),owner:address.authority.toBase58(),uiTokenAmount:{amount:'0'}}]}};}
test('finalized LP receipt structure verifies matching issuance, burn and zero retention',()=>{
 const result=verifyPublicLpBurn(receipt(),state,address);assert.equal(result.burnedLpAtoms,'512870391664');assert.equal(result.retainedLpAtoms,'0');
});
test('burn proof rejects incomplete burns, retained LP and a different authority',()=>{
 const short=receipt();short.meta.innerInstructions[0].instructions[1].parsed.info.amount='1';assert.throws(()=>verifyPublicLpBurn(short,state,address));
 const retained=receipt();retained.meta.postTokenBalances[0].uiTokenAmount.amount='1';assert.throws(()=>verifyPublicLpBurn(retained,state,address));
 const other=receipt();other.meta.innerInstructions[0].instructions[1].parsed.info.authority=PublicKey.default.toBase58();assert.throws(()=>verifyPublicLpBurn(other,state,address));
 const noMint=receipt();noMint.meta.innerInstructions[0].instructions.shift();assert.throws(()=>verifyPublicLpBurn(noMint,state,address));
});
test('burn proof rejects an ungraduated state or another pool even with matching token events',()=>{
 assert.throws(()=>verifyPublicLpBurn(receipt(),{...state,phase:1},address));
 assert.throws(()=>verifyPublicLpBurn(receipt(),{...state,pool:PublicKey.default.toBase58()},address));
});
