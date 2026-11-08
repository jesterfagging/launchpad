import bs58 from 'bs58';
import { SOL_MINT, units, requireValue as ok } from '../public/launchpad-model.mjs';

const SYSTEM='11111111111111111111111111111111';
const address=key=>String(key?.pubkey||key);

// Capture the reviewed destination alongside immutable signed bytes. Later
// treasury configuration changes cannot rewrite this operation's attribution.
export function creationFeeExpectation(launch,kind){
  if(!['create','launch-all'].includes(kind)||!launch.review?.protocolFees?.recipient)return null;
  return {amount:units(launch.review.protocolFees.creationFeeSol||'0').toString(),recipient:launch.review.protocolFees.recipient,payer:(launch.keys.payer||launch.keys.wallet).address};
}

export function creationFeeReceipt(tx,expected){
  if(!expected)return null;
  ok(tx.meta&&!tx.meta.err,'Creation fee transaction did not confirm successfully.');
  const amount=BigInt(expected.amount);
  ok(amount>=0n&&amount<=100000000n,'Invalid reviewed creation fee.');
  const receipt={amount:amount.toString(),recipient:expected.recipient,mint:SOL_MINT,decimals:9};
  if(amount===0n)return receipt;
  const message=tx.transaction?.message,staticKeys=message?.staticAccountKeys||message?.accountKeys||[];
  const keys=[...staticKeys,...(tx.meta.loadedAddresses?.writable||[]),...(tx.meta.loadedAddresses?.readonly||[])].map(address);
  const payerIndex=keys.indexOf(expected.payer),recipientIndex=keys.indexOf(expected.recipient);
  const signer=payerIndex>=0&&(staticKeys[payerIndex]?.signer===true||payerIndex<(message.header?.numRequiredSignatures||0));
  ok(signer&&recipientIndex>=0,'Creation fee receipt is missing its reviewed accounts.');
  let total=0n,count=0;
  for(const ix of message.compiledInstructions||message.instructions||[]){
    let from,to,value;
    if(ix.parsed){
      if(address(ix.programId)!==SYSTEM||ix.parsed.type!=='transfer')continue;
      const info=ix.parsed.info;
      if(!Number.isSafeInteger(info?.lamports)||info.lamports<0)continue;
      from=info.source;to=info.destination;value=BigInt(info.lamports);
    }else{
      if(keys[ix.programIdIndex]!==SYSTEM)continue;
      const data=typeof ix.data==='string'?Buffer.from(bs58.decode(ix.data)):Buffer.from(ix.data||[]),indexes=ix.accountKeyIndexes||ix.accounts||[];
      if(data.length!==12||data.readUInt32LE(0)!==2||indexes.length!==2)continue;
      from=keys[indexes[0]];to=keys[indexes[1]];value=data.readBigUInt64LE(4);
    }
    if(from===expected.payer&&to===expected.recipient){total+=value;count++;}
  }
  ok(count===1&&total===amount,'Creation fee transfer differs from the reviewed fee.');
  // Paying yourself produces no treasury revenue.
  if(expected.payer===expected.recipient)return {...receipt,amount:'0',selfPayment:true};
  const before=tx.meta.preBalances?.[recipientIndex],after=tx.meta.postBalances?.[recipientIndex];
  ok(Number.isSafeInteger(before)&&Number.isSafeInteger(after)&&BigInt(after)-BigInt(before)>=amount,'Creation fee did not reach its reviewed treasury.');
  return receipt;
}
