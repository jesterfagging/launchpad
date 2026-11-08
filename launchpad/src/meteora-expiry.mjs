import { createPublicKey, verify } from 'node:crypto';
import { PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { validateWalletMessage } from './launchpad-wallet-guards.mjs';

export const METEORA_EXPIRY_LIMITS = Object.freeze({ blockHeightBuffer:32, slotWindow:2048, maxBlocks:512, historyPageSize:1000, maxHistoryPages:20, maxBlockSignatures:10000, maxTotalSignatures:500000, deadlineMs:30000, blockConcurrency:4 });
const safe = value => Number.isSafeInteger(value) && value >= 0;
const assert = condition => { if (!condition) throw Error('Unproven Meteora transaction absence.'); };
function base58(value, length) {
  if(typeof value!=='string'||value.length>(length===64?88:44)||!value.length)return false;
  try{const bytes=bs58.decode(value);return bytes.length===length&&bs58.encode(bytes)===value;}catch{return false;}
}
function identity(op, validateReviewedMessage) {
  const bundle=op?.bundle,slot=bundle?.preparedAtSlot,height=bundle?.blockhash?.lastValidBlockHeight??bundle?.lastValidBlockHeight;
  assert(safe(slot)&&slot>0&&safe(height)&&height>0&&height<=Number.MAX_SAFE_INTEGER-METEORA_EXPIRY_LIMITS.blockHeightBuffer);
  if(bundle.lastValidBlockHeight!==undefined)assert(bundle.lastValidBlockHeight===height);
  assert(base58(op.signature,64)&&typeof op.wallet==='string'&&new PublicKey(op.wallet).toBase58()===op.wallet);
  assert(typeof op.signedTransaction==='string'&&op.signedTransaction.length<=1644);
  const bytes=Buffer.from(op.signedTransaction,'base64');assert(bytes.length<=1232&&bytes.toString('base64')===op.signedTransaction);
  const tx=VersionedTransaction.deserialize(bytes),payer=tx.message.staticAccountKeys?.[0];
  assert(tx.version===0&&payer?.toBase58()===op.wallet&&bs58.encode(tx.signatures[0])===op.signature);
  // The caller may supply its own strict reviewed-message validator for v0
  // lookup tables and wallet assertion suffixes. It must return every resolved
  // account key; the finalized-block proof itself is identical for both modes.
  let accountKeys=tx.message.staticAccountKeys;
  if(validateReviewedMessage){accountKeys=validateReviewedMessage(tx,bundle);assert(Array.isArray(accountKeys)&&accountKeys.length>=tx.message.staticAccountKeys.length);}
  else assert(!tx.message.addressTableLookups.length);
  // Durable-nonce transactions do not expire at recent-blockhash height.
  assert(!tx.message.compiledInstructions.some(ix=>accountKeys[ix.programIdIndex]?.equals(SystemProgram.programId)&&ix.data.length>=4&&Buffer.from(ix.data).readUInt32LE(0)===4));
  assert(base58(bundle.blockhash?.blockhash,32)&&tx.message.recentBlockhash===bundle.blockhash.blockhash);
  const publicKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),payer.toBuffer()]),format:'der',type:'spki'});
  assert(verify(null,tx.message.serialize(),publicKey,tx.signatures[0]));
  if(bundle.unsignedTransaction&&!validateReviewedMessage){
    const unsigned=VersionedTransaction.deserialize(Buffer.from(bundle.unsignedTransaction,'base64'));
    // Wallets may have set their own bounded compute budget or appended
    // Lighthouse assertions; every reviewed instruction must still match.
    if(!Buffer.from(unsigned.message.serialize()).equals(Buffer.from(tx.message.serialize()))){
      let ok=false;try{ok=validateWalletMessage(unsigned.message,tx.message,{allowComputeBudget:true}).changed===true;}catch{}
      assert(ok);
    }
  }
  return {slot,height,blockhash:tx.message.recentBlockhash,payer};
}
function checkpoint(value) {
  assert(safe(value?.absoluteSlot)&&safe(value?.blockHeight)&&value.absoluteSlot>=value.blockHeight);
  return {slot:value.absoluteSlot,height:value.blockHeight};
}
async function absent(connection, signature, slot) {
  const result=await connection.getSignatureStatuses([signature],{searchTransactionHistory:true});
  assert(safe(result?.context?.slot)&&result.context.slot>=slot&&Array.isArray(result.value)&&result.value.length===1);
  if(result.value[0]!==null)return false;
  // Undefined, malformed, pending, failed or finalized responses all retain the
  // existing journal. Only an explicit null is an absent historical receipt.
  return await connection.getTransaction(signature,{commitment:'finalized',maxSupportedTransactionVersion:0})===null;
}
async function addressHistoryAbsent(connection, signature, payer, preparedSlot, minContextSlot, alive) {
  const seen=new Set();let before,previousSlot=Number.MAX_SAFE_INTEGER;
  for(let page=0;page<METEORA_EXPIRY_LIMITS.maxHistoryPages;page++){
    alive();const rows=await connection.getSignaturesForAddress(payer,{limit:METEORA_EXPIRY_LIMITS.historyPageSize,minContextSlot,...(before?{before}:{})},'finalized');alive();
    assert(Array.isArray(rows)&&rows.length<=METEORA_EXPIRY_LIMITS.historyPageSize);
    if(!rows.length)return true;
    let crossed=false;
    for(const row of rows){
      assert(row&&base58(row.signature,64)&&safe(row.slot)&&row.slot<=previousSlot&&row.confirmationStatus==='finalized'&&Object.hasOwn(row,'err')&&(row.err===null||typeof row.err==='object'||typeof row.err==='string'));
      assert(!seen.has(row.signature));seen.add(row.signature);previousSlot=row.slot;
      if(row.signature===signature)return false;
      if(row.slot<preparedSlot)crossed=true;
    }
    if(crossed)return true;
    // A short page is not treated as an end marker. Read its explicit empty
    // successor so a provider's smaller per-page limit cannot truncate proof.
    before=rows.at(-1).signature;
  }
  return false;
}
async function readBlock(connection, slot) {
  // web3.js's signature-only return type omits blockHeight. Request the RPC
  // payload directly so expiry is tied to produced block height, not slots.
  const response=await connection._rpcRequest('getBlock',[slot,{commitment:'finalized',transactionDetails:'signatures',rewards:false,maxSupportedTransactionVersion:0}]);
  assert(response?.jsonrpc==='2.0'&&!response.error&&response.result&&typeof response.result==='object');
  return response.result;
}

/** Read-only, bounded non-execution evidence for one already-signed operation.
 *
 * Null signature/address indexes alone are insufficient: minContextSlot does
 * not certify that those indexes are complete. We also verify every produced
 * finalized block from the PRE-BROADCAST finalized anchor through the first
 * block beyond blockhash expiry, including parent-slot/hash/height continuity.
 * Missing anchors, pruned history, inconsistent RPCs and exhausted budgets all
 * return false. This assumes truthful finalized block data from the configured
 * RPC; it is not a cryptographic light-client proof or permission to force-clear.
 * The caller must preserve all journal data and retry only when true is returned.
 */
export async function proveExpiredAbsence(connection, op, {validateReviewedMessage}={}) {
  try{
    if(op?.observedSignatureStatus)return false;
    const anchor=identity(op,validateReviewedMessage),deadline=Date.now()+METEORA_EXPIRY_LIMITS.deadlineMs,alive=()=>assert(Date.now()<deadline);
    const first=checkpoint(await connection.getEpochInfo('finalized'));
    if(first.height<=anchor.height+METEORA_EXPIRY_LIMITS.blockHeightBuffer||first.slot<anchor.slot)return false;
    alive();const retained=await connection.getFirstAvailableBlock();assert(safe(retained)&&retained<=anchor.slot);
    if(!await absent(connection,op.signature,first.slot))return false;
    const valid=await connection.isBlockhashValid(anchor.blockhash,{commitment:'finalized',minContextSlot:first.slot});
    assert(valid?.value===false&&safe(valid?.context?.slot)&&valid.context.slot>=first.slot);
    if(!await addressHistoryAbsent(connection,op.signature,anchor.payer,anchor.slot,first.slot,alive))return false;
    const endSlot=Math.min(first.slot,anchor.slot+METEORA_EXPIRY_LIMITS.slotWindow);
    const slots=await connection.getBlocks(anchor.slot,endSlot,'finalized');alive();
    assert(Array.isArray(slots)&&slots.length>0&&slots.length<=METEORA_EXPIRY_LIMITS.slotWindow+1&&slots[0]===anchor.slot);
    for(let i=0;i<slots.length;i++)assert(safe(slots[i])&&slots[i]>=anchor.slot&&slots[i]<=endSlot&&(!i||slots[i]>slots[i-1]));
    const signatures=new Set();let previous=null,covered=false;
    const limit=Math.min(slots.length,METEORA_EXPIRY_LIMITS.maxBlocks);
    for(let offset=0;offset<limit&&!covered;offset+=METEORA_EXPIRY_LIMITS.blockConcurrency){
      alive();const group=slots.slice(offset,Math.min(offset+METEORA_EXPIRY_LIMITS.blockConcurrency,limit));
      const results=await Promise.allSettled(group.map(slot=>readBlock(connection,slot)));alive();
      assert(results.every(result=>result.status==='fulfilled'));const blocks=results.map(result=>result.value);
      for(let index=0;index<blocks.length;index++){
        const block=blocks[index],slot=group[index];
        assert(safe(block.blockHeight)&&safe(block.parentSlot)&&block.parentSlot<slot&&base58(block.blockhash,32)&&base58(block.previousBlockhash,32)&&block.blockhash!==block.previousBlockhash&&Array.isArray(block.signatures)&&block.signatures.length<=METEORA_EXPIRY_LIMITS.maxBlockSignatures);
        if(previous)assert(block.parentSlot===previous.slot&&block.previousBlockhash===previous.hash&&block.blockHeight===previous.height+1);
        else assert(block.blockHeight<=anchor.height);
        for(const signature of block.signatures){assert(base58(signature,64)&&!signatures.has(signature));signatures.add(signature);if(signature===op.signature)return false;}
        assert(signatures.size<=METEORA_EXPIRY_LIMITS.maxTotalSignatures);
        previous={slot,hash:block.blockhash,height:block.blockHeight};
        if(block.blockHeight>anchor.height+METEORA_EXPIRY_LIMITS.blockHeightBuffer){covered=true;break;}
      }
    }
    if(!covered)return false;
    alive();const final=checkpoint(await connection.getEpochInfo('finalized'));
    assert(final.slot>=first.slot&&final.height>=first.height&&final.height>anchor.height+METEORA_EXPIRY_LIMITS.blockHeightBuffer);
    if(!await absent(connection,op.signature,final.slot))return false;
    const retainedAfter=await connection.getFirstAvailableBlock();assert(safe(retainedAfter)&&retainedAfter<=anchor.slot);
    const finalValid=await connection.isBlockhashValid(anchor.blockhash,{commitment:'finalized',minContextSlot:final.slot});
    assert(finalValid?.value===false&&safe(finalValid?.context?.slot)&&finalValid.context.slot>=final.slot);alive();
    return true;
  }catch{return false;}
}
