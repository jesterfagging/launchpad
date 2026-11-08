/** Real production launch instruction bridge; offline account snapshot only. */
import {readFileSync} from 'node:fs';
import {PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, AddressLookupTableAccount, SystemProgram} from '@solana/web3.js';
import {createAssociatedTokenAccountIdempotentInstruction,createSyncNativeInstruction,createCloseAccountInstruction,NATIVE_MINT} from '@solana/spl-token';
import {DammPumpTestClientAdapter} from '../../../src/damm-pump-test-chain.mjs';
import {mintSetupIxs,addresses,initializeIx} from '../../../src/damm-pump-client.mjs';
import {dammPumpFeeCurveAtGraduationTarget} from '../../../src/damm-pump-fee-policy.mjs';
import {dammPumpAdminTestCurveAtGraduationTarget} from '../../../src/damm-pump-admin-test-policy.mjs';
const input=JSON.parse(readFileSync(0,'utf8'));
const pk=x=>new PublicKey(x),model=(input.mode==='public'?dammPumpFeeCurveAtGraduationTarget:dammPumpAdminTestCurveAtGraduationTarget)(input),a=addresses(input);
const connection={getMinimumBalanceForRentExemption:async size=>size===82?input.mintRent:input.nativeRent,getAccountInfo:async()=>{if(input.nativeBefore)return {...input.nativeBefore,owner:pk(input.nativeBefore.owner),data:Buffer.from(input.nativeBefore.data,'base64')};if(input.variant==='legacy-ata'){const data=Buffer.alloc(165);NATIVE_MINT.toBuffer().copy(data);pk(input.creator).toBuffer().copy(data,32);data[108]=1;data.writeUInt32LE(1,109);data.writeBigUInt64LE(BigInt(input.nativeRent),113);return {owner:a.quoteTokenProgram,lamports:input.nativeRent,data};}return null;}};
const adapter=new DammPumpTestClientAdapter({connection});
const setup=await mintSetupIxs({...input,mintRentLamports:String(input.mintRent),name:input.name||'Trace Test',symbol:input.symbol||'TRACETEST',metadataUri:input.metadataUri||`https://launch.example.com/token-metadata/${input.mint}.json`});
const init=[...setup.instructions,initializeIx({...input,model})];
let instructions=init,trade;
if(input.pool){
 const p=adapter.cp._program.coder.accounts.decode('pool',Buffer.from(input.pool,'base64'));
 const snapshot={state:{phase:0,sqrtMaxPrice:model.sqrtMaxPrice},addresses:a,pool:p,slot:input.slot};
 const built=await adapter.dammTrade({},input,input.creator,'buy',BigInt(input.amountRaw),100,snapshot);
 trade=built.trade;
 if(input.variant==='legacy-ata'){
  const user=pk(input.creator),ata=a.userQuoteAta,swap=built.instructions.find(ix=>ix.programId.equals(a.dammProgram));
  const originalQuote=pk(built.trade.quoteAccount);
  const patched=swap.keys.map(k=>({...k,pubkey:k.pubkey.equals(originalQuote)?ata:k.pubkey}));
  swap.keys=patched;
  instructions=[...init,createAssociatedTokenAccountIdempotentInstruction(user,a.userAta,user,a.mint),createAssociatedTokenAccountIdempotentInstruction(user,ata,user,NATIVE_MINT),SystemProgram.transfer({fromPubkey:user,toPubkey:ata,lamports:BigInt(input.amountRaw)}),createSyncNativeInstruction(ata),swap,...(input.nativeBefore?[]:[createCloseAccountInstruction(ata,user,user)])];
 }else instructions=[...init,...built.instructions];
}
if(input.forceSlippageFailure){const swap=instructions.find(ix=>ix.programId.equals(a.dammProgram));swap.data.writeBigUInt64LE(18446744073709551615n,16);}
if(BigInt(input.creationFee||0)>0n)instructions.push(SystemProgram.transfer({fromPubkey:pk(input.creator),toPubkey:pk('HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF'),lamports:BigInt(input.creationFee)}));
const compute=ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),all=[compute,...instructions];
const addressesSet=await adapter.lookupAddresses({programId:input.programId},{...input,creatorWallet:input.creator});
const table=new AddressLookupTableAccount({key:pk('6naEzKeUuFh1Jeeu51NXQgr5qkXgXtc9WKNct4xynVJc'),state:{deactivationSlot:18446744073709551615n,lastExtendedSlot:0,lastExtendedSlotStartIndex:0,authority:undefined,addresses:addressesSet}});
const message=new TransactionMessage({payerKey:pk(input.creator),recentBlockhash:input.blockhash,instructions:all}).compileToV0Message([table]);
adapter.lookupTables=async()=>[table];
const production=await adapter.buildTransaction({programId:input.programId},input,input.creator,instructions,'initialize',{blockhash:input.blockhash});
const wire=(input.variant==='legacy-ata'?new VersionedTransaction(message):production).serialize(),packetBytes=wire.length;
const enc=ix=>({program:String(ix.programId),data:ix.data.toString('base64'),keys:ix.keys.map(k=>({key:String(k.pubkey),writable:k.isWritable,signer:k.isSigner}))});
process.stdout.write(JSON.stringify({instructions:instructions.map(enc),packetBytes,wire:Buffer.from(wire).toString('base64'),lookupTable:{key:String(table.key),addresses:addressesSet.map(String)},trade,model,mint:setup.mint}));
