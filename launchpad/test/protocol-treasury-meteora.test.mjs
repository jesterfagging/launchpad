import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,PublicKey,SystemProgram} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,MintLayout,ExtensionType,TransferHookLayout,TransferFeeConfigLayout} from '@solana/spl-token';
import {ProtocolTreasuryChain,PROTOCOL_TOKEN_MINT} from '../src/protocol-treasury-chain.mjs';
import {METEORA_DBC_PROGRAM,meteoraTokenBadgeAddress} from '../src/meteora-quotes.mjs';

const owner=Keypair.generate().publicKey,authority=Keypair.generate().publicKey;
function mintAccount(extensions=[]) {
  const data=Buffer.alloc(extensions.length?166+extensions.reduce((sum,e)=>sum+4+e.data.length,0):82);
  MintLayout.encode({mintAuthorityOption:0,mintAuthority:PublicKey.default,supply:1000000000000n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:PublicKey.default},data);
  if(extensions.length){data[165]=1;let offset=166;for(const e of extensions){data.writeUInt16LE(e.type,offset);data.writeUInt16LE(e.data.length,offset+2);e.data.copy(data,offset+4);offset+=4+e.data.length;}}
  return{data,owner:TOKEN_2022_PROGRAM_ID,lamports:10000000,executable:false};
}
function hook(programId=PublicKey.default) {const data=Buffer.alloc(TransferHookLayout.span);TransferHookLayout.encode({programId,authority},data);return{type:ExtensionType.TransferHook,data};}
function fee(older=0,newer=0,epoch=20n) {const data=Buffer.alloc(TransferFeeConfigLayout.span);TransferFeeConfigLayout.encode({transferFeeConfigAuthority:authority,withdrawWithheldAuthority:authority,withheldAmount:0n,olderTransferFee:{epoch:0n,maximumFee:100n,transferFeeBasisPoints:older},newerTransferFee:{epoch,maximumFee:100n,transferFeeBasisPoints:newer}},data);return{type:ExtensionType.TransferFeeConfig,data};}
function fixture({extensions=[hook(),fee()],kind='convert'}={}) {
  const mint=kind==='convert'?Keypair.generate().publicKey:new PublicKey(PROTOCOL_TOKEN_MINT),badgeAddress=meteoraTokenBadgeAddress(mint);
  const h={mint,kind,epoch:10,slot:500,epochSlot:501,account:mintAccount(extensions),reads:[],badge:{owner:METEORA_DBC_PROGRAM,executable:false,lamports:1000000,data:Buffer.concat([Buffer.from([116,219,204,229,249,116,255,150]),mint.toBuffer(),Buffer.alloc(128)])}};
  h.chain=new ProtocolTreasuryChain({connection:{
    getMultipleAccountsInfoAndContext:async(keys,options)=>{h.reads.push({keys,options});return{context:{slot:h.slot},value:keys.map(key=>key.equals(mint)?h.account:key.equals(badgeAddress)?h.badge:key.equals(owner)?{owner:SystemProgram.programId,lamports:100000000,data:Buffer.alloc(0),executable:false}:null)};},
    getEpochInfo:async options=>{h.epochOptions=options;return{epoch:h.epoch,absoluteSlot:h.epochSlot};}
  }});
  h.read=()=>h.chain.readOperationMint(kind,mint,owner);return h;
}
test('Meteora-only stock conversion independently verifies finalized mint/badge/epoch with no Raydium registration',async()=>{
  const h=fixture(),result=await h.read();assert(result.info.program.equals(TOKEN_2022_PROGRAM_ID));assert.equal(result.info.mint.decimals,6);assert.equal(h.reads.length,2);
  assert.equal(h.reads[1].options.commitment,'finalized');assert.equal(h.reads[1].options.minContextSlot,500);assert(h.reads[1].keys[1].equals(meteoraTokenBadgeAddress(h.mint)));
  assert.deepEqual(h.epochOptions,{commitment:'finalized',minContextSlot:500});
});
test('Meteora conversion rejects absent, wrong-owner, wrong-mint or malformed badges',async()=>{
  for(const change of [h=>h.badge=null,h=>h.badge.owner=TOKEN_PROGRAM_ID,h=>authority.toBuffer().copy(h.badge.data,8),h=>h.badge.data[0]^=1]){const h=fixture();change(h);await assert.rejects(h.read(),/unsupported extensions/);}
});
test('Meteora conversion rejects current/scheduled tax and active hooks despite valid badge',async()=>{
  for(const extensions of [[hook(),fee(10,0)],[hook(),fee(0,10)],[hook(authority),fee()]]){const h=fixture({extensions});await assert.rejects(h.read(),/unsupported extensions/);}
  // The existing quote policy checks both stored schedules, including an
  // expired nonzero fee. Treasury conversion retains that same restriction.
  const historical=fixture({extensions:[hook(),fee(10,0)]});historical.epoch=20;await assert.rejects(historical.read(),/unsupported extensions/);
});
test('Meteora fallback does not widen official LAUNCHPAD buy/burn permissions',async()=>{
  for(const kind of ['buy','burn']){const h=fixture({kind});await assert.rejects(h.read(),/unsupported extensions/);assert.equal(h.reads.length,1);assert.equal(h.epochOptions,undefined);}
});
test('Meteora conversion rejects missing/stale epoch and stale badge snapshots',async()=>{
  for(const change of [h=>h.epoch=undefined,h=>h.epochSlot=499]){const h=fixture();change(h);await assert.rejects(h.read(),/finalized treasury mint epoch/);}
  const h=fixture(),read=h.chain.c.getMultipleAccountsInfoAndContext;h.chain.c.getMultipleAccountsInfoAndContext=async(...args)=>{const result=await read(...args);if(h.reads.length>1)result.context.slot=499;return result;};await assert.rejects(h.read(),/incomplete treasury snapshot/);
});
test('legacy ordinary conversion validation remains independent of Meteora availability',async()=>{
  const h=fixture({extensions:[]});h.badge=null;assert.equal((await h.read()).info.mint.decimals,6);assert.equal(h.reads.length,1);assert.equal(h.epochOptions,undefined);
});
