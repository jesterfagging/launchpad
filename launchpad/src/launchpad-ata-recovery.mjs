import {PublicKey,SystemProgram} from '@solana/web3.js';
import {ASSOCIATED_TOKEN_PROGRAM_ID,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {SOL_MINT,isCurrentLaunch} from '../public/launchpad-model.mjs';

const ATA=ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),SYSTEM=SystemProgram.programId.toBase58(),U64=18446744073709551615n;
const saved=/^Onchain simulation failed during fee processing \(instruction (2|4|6), program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL\): \{"InstructionError":\[\1,\{"Custom":1\}\]\}\.$/;
export function savedAtaPayoutFailure(launch){
  try{
    const match=saved.exec(launch?.error||''),cycle=launch?.cycle;
    if(!match||launch.input?.feeMode!=='holders'||launch.input.quoteMint===SOL_MINT||!isCurrentLaunch(launch.input)||cycle?.stage!=='payout'||!Number.isSafeInteger(cycle.index)||cycle.index<0||!Array.isArray(cycle.payouts)||cycle.index>=cycle.payouts.length)return null;
    const instructionIndex=Number(match[1]),rowIndex=(instructionIndex-2)/2,payouts=cycle.payouts.slice(cycle.index,cycle.index+3),owners=new Set();let total=0n;
    for(const row of payouts){
      const key=new PublicKey(row?.owner);
      if(key.toBase58()!==row.owner||!PublicKey.isOnCurve(key.toBytes())||owners.has(row.owner)||typeof row.amount!=='string'||! /^[1-9]\d*$/.test(row.amount)||BigInt(row.amount)>U64)return null;
      owners.add(row.owner);total+=BigInt(row.amount);
    }
    if(rowIndex>=payouts.length||typeof launch.credits?.quote!=='string'||!/^\d+$/.test(launch.credits.quote)||total>BigInt(launch.credits.quote))return null;
    return {instructionIndex,rowIndex,cycleIndex:cycle.index,payouts:payouts.map(({owner,amount})=>({owner,amount}))};
  }catch{return null;}
}

// A custom error number alone cannot distinguish ATA ownership failures from
// a nested token or System failure. Require the exact PDA layout plus a full
// runtime call stack proving that System, directly invoked by ATA, lacked SOL.
export function ataFundingSimulationFailure(transaction,result){
  try{
    const failure=result?.err?.InstructionError,index=failure?.[0];
    if(!Number.isSafeInteger(index)||index<0||failure?.[1]?.Custom!==1)return null;
    const message=transaction?.message,ix=message?.compiledInstructions?.[index],keys=message?.staticAccountKeys;
    if(!ix||!Array.isArray(keys)||keys[ix.programIdIndex]?.toBase58()!==ATA)return null;
    const data=Buffer.from(ix.data),accounts=Array.from(ix.accountKeyIndexes||[]);
    if(!(data.length===0||data.length===1&&[0,1].includes(data[0]))||accounts.length!==6)return null;
    const [payer,account,owner,mint,system,program]=accounts.map(i=>keys[i]);
    if(![payer,account,owner,mint,system,program].every(key=>key instanceof PublicKey)||!system.equals(SystemProgram.programId)||![TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(id=>id.equals(program))||!getAssociatedTokenAddressSync(mint,owner,true,program).equals(account))return null;
    const payerIndex=accounts[0],required=message.header?.numRequiredSignatures,readonly=message.header?.numReadonlySignedAccounts;
    if(!Number.isSafeInteger(required)||!Number.isSafeInteger(readonly)||payerIndex>=required-readonly)return null;
    const stack=[];let evidence=null,failed=false,proved=false;
    for(const line of result.logs||[]){
      const invoke=/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/.exec(line);
      if(invoke){
        const depth=Number(invoke[2]);if(depth!==stack.length+1)return null;
        if(failed)return null;
        if(depth===1||depth===2&&invoke[1]===SYSTEM)evidence=null;
        stack.push(invoke[1]);continue;
      }
      const shortage=/^Transfer: insufficient lamports (\d{1,20}), need (\d{1,20})$/.exec(line);
      if(shortage&&stack.length===2&&stack[0]===ATA&&stack[1]===SYSTEM){
        const have=BigInt(shortage[1]),need=BigInt(shortage[2]);if(need>have&&need<=U64)evidence=need-have;
      }
      const finish=/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed: (.+))$/.exec(line);
      if(!finish)continue;
      if(stack.at(-1)!==finish[1])return null;
      if(finish[2]==='success'){if(failed)return null;if(finish[1]===SYSTEM||stack.length===1)evidence=null;stack.pop();continue;}
      const code=/^custom program error: (0x[0-9a-f]+|\d+)$/i.exec(finish[3]);
      if(!failed){if(stack.length!==2||stack[0]!==ATA||stack[1]!==SYSTEM||!evidence||!code||Number(code[1])!==1)return null;failed=true;}
      else if(stack.length===1&&stack[0]===ATA&&code&&Number(code[1])===1)proved=true;else return null;
      stack.pop();
    }
    return proved&&stack.length===0?{fundingWallet:payer.toBase58(),fundingShortfallLamports:evidence.toString()}:null;
  }catch{return null;}
}
