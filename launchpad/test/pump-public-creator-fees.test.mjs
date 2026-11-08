import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {quoteTrade,PUBLIC_POLICY} from '../src/pump-public-client.mjs';
const proof=JSON.parse(await readFile(new URL('../contracts/curve-pump-public/creator-fees-vm-results.json',import.meta.url),'utf8'));
for(const example of proof.quotes)test(`public ${example.side} quote matches actual VM creator and protocol payouts`,()=>{
 const s=example.before;
 const quote=quoteTrade({phase:s.phase,virtualBase:String(s.vb),virtualQuote:String(s.vq),sold:String(s.sold),quote:String(s.quote),cap:PUBLIC_POLICY.soldCapRaw},{side:example.side,amount:example.amount,slippageBps:0});
 for(const field of ['output','charged','creatorFee','protocolFee'])assert.equal(quote[field],example[field],field);
 assert.equal(BigInt(quote.fee),BigInt(quote.creatorFee)+BigInt(quote.protocolFee));
});
