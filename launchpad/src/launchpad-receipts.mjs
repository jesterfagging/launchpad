import { Keypair, ComputeBudgetProgram } from '@solana/web3.js';
import {getAssociatedTokenAddressSync,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {PublicKey} from '@solana/web3.js';
import {rewardsWalletSelection,rewardsWalletKey,rewardsReceiptWallet,requireTaxBurnWallet,TAX_BURN_MINT,TAX_BURN_WALLET,TAX_BURN_POLICY,validInitialTaxBurnApproval} from './launchpad-rewards-wallet.mjs';
import bs58 from 'bs58';
import { SOL_MINT, requireValue as ok } from '../public/launchpad-model.mjs';
export const signer = secret => Keypair.fromSecretKey(bs58.decode(secret));
export const newLaunchKeys = () => Object.fromEntries(['wallet','mint'].map(k=>{const key=Keypair.generate();return[k,{address:key.publicKey.toBase58(),secret:bs58.encode(key.secretKey)}];}));
export function receiptDeltas(tx,launch,{selfPayout=0n,operation}={}){
  const meta=tx.meta;ok(meta&&!meta.err,'Transaction failed onchain.');const selection=rewardsWalletSelection(launch,{operation,receipt:true}),owner=rewardsWalletKey(launch,selection,{receipt:true}).address,payer=rewardsWalletKey(launch,selection,{signer:true,receipt:true}).address,quote=launch.input.quoteMint,base=launch.keys.mint.address;
  const balance=(rows,mint)=>rows.filter(x=>x.owner===owner&&x.mint===mint).reduce((n,x)=>n+BigInt(x.uiTokenAmount.amount),0n);
  const pre=meta.preTokenBalances||[],post=meta.postTokenBalances||[];
  const keys=tx.transaction.message.staticAccountKeys||tx.transaction.message.accountKeys,idx=keys.findIndex(x=>String(x.pubkey||x)===payer);ok(idx>=0,'Fee receipt is missing the launch wallet.');
  const walletDebit=BigInt(meta.preBalances[idx])-BigInt(meta.postBalances[idx]);
  let quoteDelta=balance(post,quote)-balance(pre,quote);
  if(quote===SOL_MINT&&launch.input.route==='pump'){
    const owned=new Set([idx,...[...pre,...post].filter(x=>x.owner===owner).map(x=>x.accountIndex)]);
    quoteDelta=[...owned].reduce((n,i)=>n+BigInt(meta.postBalances[i])-BigInt(meta.preBalances[i]),BigInt(meta.fee));
  }
  const nativeQuote=quote===SOL_MINT&&launch.input.route==='pump',cost=walletDebit+(nativeQuote?quoteDelta:0n)+BigInt(selfPayout);
  return{quote:quoteDelta,base:balance(post,base)-balance(pre,base),networkFee:BigInt(meta.fee),gasAndRent:cost>0n?cost:0n};
}

// Verify a journaled, exact-amount handoff separately from earned revenue.
// Gross source debits and actual net destination credits remain distinct when
// Token2022 levies a transfer fee; neither pre-existing balance is swept.
export function rewardHandoffReceipt(tx,launch,operation){
  const meta=tx?.meta,plan=operation?.rewardHandoff;
  ok(meta&&!meta.err,'Rewards handoff failed onchain.');
  ok(rewardsReceiptWallet(launch)&&plan?.version===1&&plan.sourceAddress===launch.keys.wallet.address&&plan.destinationAddress===(launch.keys.rewards?.address||launch.rewardsWallet?.address),'The saved rewards handoff wallets differ from this launch.');
  const read=key=>{ok(typeof plan[key]==='string'&&/^\d+$/.test(plan[key]),'Invalid saved rewards handoff amount.');const n=BigInt(plan[key]);ok(n<=18446744073709551615n,'Rewards handoff exceeds token amount limits.');return n;};
  const base=read('baseUnits'),quote=read('quoteUnits'),holder=read('holderQuoteUnits'),protocol=read('protocolQuoteUnits'),tax=read('taxBaseUnits'),gas=read('gasLamports');
  ok(quote===holder+protocol&&tax<=base&&gas<=10000000n&&base+quote+gas>0n,'Invalid rewards handoff accounting.');
  const message=tx.transaction?.message,keys=[...(message?.staticAccountKeys||message?.accountKeys||[]),...(meta.loadedAddresses?.writable||[]),...(meta.loadedAddresses?.readonly||[])].map(x=>String(x.pubkey||x));
  const src=keys.indexOf(plan.sourceAddress),dst=keys.indexOf(plan.destinationAddress);
  ok(src===0&&dst>=0,'Rewards handoff receipt is missing its source or destination wallet.');
  const tokenDelta=(owner,mint,program,required=false)=>{
    const ata=getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(owner),false,program).toBase58(),index=keys.indexOf(ata);
    if(index<0){ok(!required,'Rewards handoff is missing a required token account.');return 0n;}
    if(required)ok((meta.postTokenBalances||[]).some(row=>row.accountIndex===index),'Rewards handoff is missing a destination token balance.');
    const balance=rows=>{const matches=(rows||[]).filter(row=>row.accountIndex===index);ok(matches.length<=1,'Rewards handoff contains duplicate token balances.');const row=matches[0];if(!row)return 0n;ok(row.owner===owner&&row.mint===mint&&/^\d+$/.test(row.uiTokenAmount?.amount||''),'Rewards handoff token account identity is invalid.');return BigInt(row.uiTokenAmount.amount);};
    return balance(meta.postTokenBalances)-balance(meta.preTokenBalances);
  };
  const m=launch.keys.mint.address,q=launch.input.quoteMint,baseProgram=launch.input.taxBps?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,quoteProgram=new PublicKey(launch.review.quoteProgram);
  const baseDebit=-tokenDelta(plan.sourceAddress,m,baseProgram),baseCredit=tokenDelta(plan.destinationAddress,m,baseProgram,base>0n),quoteDebit=-tokenDelta(plan.sourceAddress,q,quoteProgram),quoteCredit=tokenDelta(plan.destinationAddress,q,quoteProgram,quote>0n);
  ok(baseDebit===base&&quoteDebit===quote,'Rewards handoff spent a different amount than its saved credits.');
  ok(baseCredit>=0n&&baseCredit<=base&&quoteCredit>=0n&&quoteCredit<=quote,'Rewards handoff did not deliver its saved assets.');
  // Token2022 rounds transfer fees upward, so a one-unit dust transfer can
  // legitimately deliver zero. Corroborate that full loss with the actual
  // confirmed checked-transfer instruction, never a missing balance row or a
  // fee schedule guessed from today's epoch.
  for(const [mint,program,requested,received,decimals] of [[m,baseProgram,base,baseCredit,6],[q,quoteProgram,quote,quoteCredit,launch.review.quoteDecimals]]){
    if(requested===0n||received!==0n)continue;
    const sourceAta=getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(plan.sourceAddress),false,program).toBase58(),destinationAta=getAssociatedTokenAddressSync(new PublicKey(mint),new PublicKey(plan.destinationAddress),false,program).toBase58();
    const matches=(message.compiledInstructions||message.instructions||[]).filter(ix=>{
      try{const data=typeof ix.data==='string'?Buffer.from(bs58.decode(ix.data)):Buffer.from(ix.data),indices=ix.accountKeyIndexes||ix.accounts||[];
        return keys[ix.programIdIndex]===program.toBase58()&&data.length===10&&data[0]===12&&data.readBigUInt64LE(1)===requested&&data[9]===decimals&&indices.length===4&&keys[indices[0]]===sourceAta&&keys[indices[1]]===mint&&keys[indices[2]]===destinationAta&&keys[indices[3]]===plan.sourceAddress;
      }catch{return false;}
    });
    ok(program.equals(TOKEN_2022_PROGRAM_ID)&&matches.length===1,'Zero-net rewards transfer is missing its exact Token2022 checked-transfer evidence.');
  }
  const native=(balances,index)=>{const n=balances?.[index];ok(Number.isSafeInteger(n)&&n>=0,'Rewards handoff native balance is invalid.');return BigInt(n);};
  ok(native(meta.postBalances,dst)-native(meta.preBalances,dst)===gas,'Rewards gas funding differs from its saved amount.');
  const cost=native(meta.preBalances,src)-native(meta.postBalances,src)-gas;
  ok(cost>=0n&&Number.isSafeInteger(meta.fee)&&meta.fee>=0,'Rewards handoff network costs are invalid.');
  return {baseDebit,baseCredit,quoteDebit,quoteCredit,gasAndRent:cost,networkFee:BigInt(meta.fee)};
}

// Validate the exact operation before signing and again from its finalized
// receipt. A negative token delta alone is not evidence of burning: a transfer
// or swap can have the same delta. Only one direct Token2022 BurnChecked is
// accepted, plus bounded compute-budget instructions and no other programs.
export function validateTaxBurnInstructions(launch,operation,instructions){
  requireTaxBurnWallet(launch,{receipt:true});
  ok(operation?.kind==='tax-burn'&&operation.taxBurnPolicy===TAX_BURN_POLICY&&['withheld-tax','approved-initial-inventory'].includes(operation.taxSource),'Invalid saved LAUNCHPAD tax-burn policy.');
  ok(typeof operation.amount==='string'&&/^[1-9]\d*$/.test(operation.amount)&&BigInt(operation.amount)<=18446744073709551615n,'Invalid saved LAUNCHPAD tax-burn amount.');
  if(operation.taxSource==='approved-initial-inventory'){
    const valid=value=>typeof value==='string'&&/^(?:0|[1-9]\d*)$/.test(value)&&BigInt(value)<=18446744073709551615n;
    ok(validInitialTaxBurnApproval(operation.initialBurnPolicy,operation.amount)&&valid(operation.initialTaxBase)&&valid(operation.initialLegacyBase)&&BigInt(operation.initialTaxBase)+BigInt(operation.initialLegacyBase)===BigInt(operation.amount),'Initial LAUNCHPAD burn differs from the exact approved inventory allocation.');
  }
  const amount=BigInt(operation.amount),selection=rewardsWalletSelection(launch,{operation,receipt:true});
  ok(selection.source==='rewards'&&selection.signerSource==='rewards'&&selection.address===TAX_BURN_WALLET,'Tax burn authority differs from its saved rewards wallet.');
  const ata=getAssociatedTokenAddressSync(new PublicKey(TAX_BURN_MINT),new PublicKey(TAX_BURN_WALLET),false,TOKEN_2022_PROGRAM_ID).toBase58();
  ok(Array.isArray(instructions)&&instructions.length>0&&instructions.length<=3,'Tax burn contains an unexpected instruction count.');
  let burns=0;const budget=new Set();
  for(const instruction of instructions){
    const program=String(instruction.programId),data=Buffer.from(instruction.data||[]),keys=instruction.keys||[];
    if(program===ComputeBudgetProgram.programId.toBase58()){
      const tag=data[0];
      ok(keys.length===0&&!budget.has(tag)&&((tag===2&&data.length===5&&data.readUInt32LE(1)>0&&data.readUInt32LE(1)<=1400000)||(tag===3&&data.length===9&&data.readBigUInt64LE(1)<=10000n)),'Tax burn contains an unexpected compute budget.');
      budget.add(tag);continue;
    }
    ok(program===TOKEN_2022_PROGRAM_ID.toBase58()&&data.length===10&&data[0]===15&&data.readBigUInt64LE(1)===amount&&data[9]===6&&keys.length===3,'Tax burn is missing its exact checked-burn instruction.');
    ok(String(keys[0].pubkey)===ata&&keys[0].isWritable===true&&keys[0].isSigner===false&&String(keys[1].pubkey)===TAX_BURN_MINT&&keys[1].isWritable===true&&keys[1].isSigner===false&&String(keys[2].pubkey)===TAX_BURN_WALLET&&keys[2].isSigner===true,'Tax burn has an unexpected source, mint or authority.');
    burns++;
  }
  ok(burns===1,'Tax burn must contain exactly one checked-burn instruction.');
  return {amount,ata};
}

export function taxBurnReceipt(tx,launch,operation){
  const meta=tx?.meta,message=tx?.transaction?.message;
  // LaunchChain.receipt fetches this record with commitment:'finalized'. Some
  // adapters also supply a status; never accept an explicitly weaker one.
  ok(tx?.confirmationStatus===undefined||tx.confirmationStatus==='finalized','LAUNCHPAD tax burn has not finalized.');
  ok(meta&&meta.err===null&&Number.isSafeInteger(tx.slot)&&tx.slot>0,'LAUNCHPAD tax burn has no successful finalized receipt.');
  ok(typeof operation?.signature==='string'&&operation.signature.length>0&&tx.transaction.signatures?.length===1&&tx.transaction.signatures[0]===operation.signature,'LAUNCHPAD tax-burn receipt signature mismatch.');
  const staticKeys=message?.staticAccountKeys||message?.accountKeys||[],keys=staticKeys.map(key=>String(key.pubkey||key)),header=message?.header;
  ok(keys.length>=4&&keys.length<=5&&new Set(keys).size===keys.length&&keys[0]===TAX_BURN_WALLET&&header?.numRequiredSignatures===1&&header.numReadonlySignedAccounts===0&&Number.isInteger(header.numReadonlyUnsignedAccounts)&&header.numReadonlyUnsignedAccounts>=1&&header.numReadonlyUnsignedAccounts<keys.length,'LAUNCHPAD tax burn has an unexpected fee payer or signer set.');
  ok(!(meta.loadedAddresses?.writable?.length||meta.loadedAddresses?.readonly?.length||message.addressTableLookups?.length),'LAUNCHPAD tax burn cannot use hidden lookup accounts.');
  const compiled=message.compiledInstructions||message.instructions;
  ok(Array.isArray(compiled),'LAUNCHPAD tax burn is missing raw instruction evidence.');
  const instructions=compiled.map(ix=>{
    const indices=ix.accountKeyIndexes||ix.accounts;
    ok(Number.isInteger(ix.programIdIndex)&&ix.programIdIndex>=0&&ix.programIdIndex<keys.length&&Array.isArray(indices)&&indices.every(index=>Number.isInteger(index)&&index>=0&&index<keys.length),'LAUNCHPAD tax burn contains invalid instruction accounts.');
    let data;try{data=typeof ix.data==='string'?Buffer.from(bs58.decode(ix.data)):Buffer.from(ix.data);}catch{throw Error('LAUNCHPAD tax burn contains invalid instruction data.');}
    return {programId:keys[ix.programIdIndex],data,keys:indices.map(index=>({pubkey:keys[index],isSigner:index===0,isWritable:index===0||index<keys.length-header.numReadonlyUnsignedAccounts}))};
  });
  const {amount,ata}=validateTaxBurnInstructions(launch,operation,instructions),index=keys.indexOf(ata),allowed=new Set([TAX_BURN_WALLET,TAX_BURN_MINT,ata,TOKEN_2022_PROGRAM_ID.toBase58(),ComputeBudgetProgram.programId.toBase58()]);
  ok(index>0&&keys.every(key=>allowed.has(key)),'LAUNCHPAD tax burn contains an unexpected account.');
  const tokenAmount=rows=>{
    ok(Array.isArray(rows)&&rows.length===1,'LAUNCHPAD tax burn changed an unexpected token account.');
    const row=rows[0],raw=row.uiTokenAmount?.amount;
    ok(row.accountIndex===index&&row.owner===TAX_BURN_WALLET&&row.mint===TAX_BURN_MINT&&row.uiTokenAmount.decimals===6&&(!row.programId||row.programId===TOKEN_2022_PROGRAM_ID.toBase58())&&typeof raw==='string'&&/^\d+$/.test(raw)&&BigInt(raw)<=18446744073709551615n,'LAUNCHPAD tax burn token balance identity is invalid.');
    return BigInt(raw);
  };
  ok(tokenAmount(meta.preTokenBalances)-tokenAmount(meta.postTokenBalances)===amount,'LAUNCHPAD tax burn differs from its exact saved token debit.');
  ok(Number.isSafeInteger(meta.fee)&&meta.fee>=0&&Array.isArray(meta.preBalances)&&Array.isArray(meta.postBalances)&&meta.preBalances.length===keys.length&&meta.postBalances.length===keys.length,'LAUNCHPAD tax burn is missing network-cost evidence.');
  for(let i=0;i<keys.length;i++){
    const before=meta.preBalances[i],after=meta.postBalances[i];
    ok(Number.isSafeInteger(before)&&before>=0&&Number.isSafeInteger(after)&&after>=0&&BigInt(before)-BigInt(after)===(i===0?BigInt(meta.fee):0n),'LAUNCHPAD tax burn changed SOL beyond its network fee.');
  }
  ok(!(meta.innerInstructions||[]).some(group=>group.instructions?.length),'LAUNCHPAD tax burn contains unexpected inner instructions.');
  return {base:-amount,quote:0n,burnedBase:amount,networkFee:BigInt(meta.fee),gasAndRent:BigInt(meta.fee)};
}
