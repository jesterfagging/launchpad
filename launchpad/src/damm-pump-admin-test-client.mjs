/** Fee-controller extension. Legacy public builders and state remain unchanged. */
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import * as legacy from './damm-pump-client.mjs';
export * from './damm-pump-client.mjs';
export const GRADUATION_FEE_NUMERATOR=322369073n;
export const GRADUATION_FEE_DENOMINATOR=1000000000n;
export function graduationFeeRaw(gross){return BigInt(gross)*GRADUATION_FEE_NUMERATOR/GRADUATION_FEE_DENOMINATOR;}
export function feeAddresses(args){const a=legacy.addresses(args),treasury=new PublicKey(legacy.PUBLIC_TREASURY);return {...a,treasury,treasuryQuote:getAssociatedTokenAddressSync(a.quoteMint,treasury,false,a.quoteTokenProgram)};}
export function migrateIx(args){
  const instruction=legacy.migrateIx(args),a=feeAddresses(args);
  return new TransactionInstruction({programId:instruction.programId,data:instruction.data,keys:[...instruction.keys,{pubkey:a.treasury,isWritable:false,isSigner:false},{pubkey:a.treasuryQuote,isWritable:true,isSigner:false}]});
}
export function decodeState(account,programId){
  const state=legacy.decodeState(account,programId);if(!state)return null;
  const paid=Buffer.from(account.data).readBigUInt64LE(440),expected=graduationFeeRaw(state.expectedQuote);
  if(state.phase===0?paid!==0n:paid!==expected||BigInt(state.quoteMigrated)!==BigInt(state.expectedQuote)-expected||state.baseMigrated!==state.reserveBase)throw Error('The fee-controller custody state differs from its fixed graduation policy.');
  return {...state,graduationFeePaidRaw:String(paid)};
}
