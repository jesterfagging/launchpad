/** Wallet-owned SOL funding for a saved DAMM launch; never signs or sends. */
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from '@solana/spl-token';
import { quoteConversion, buildConversion, SOL_ROUTE_ACCOUNT_BUDGETS } from './launchpad-trading-route.mjs';

const pk=value=>new PublicKey(value),str=value=>value?.toBase58?.()??String(value),MAX_U64=(1n<<64n)-1n;
const ensure=(value,message)=>{if(!value)throw Object.assign(Error(message),{statusCode:409});};
const raw=value=>{ensure(typeof value==='string'&&/^(0|[1-9]\d{0,19})$/.test(value)&&BigInt(value)<=MAX_U64,'Invalid launch funding amount.');return BigInt(value);};
const ceil=(a,b)=>(a+b-1n)/b;
export const DAMM_SEED_FUNDING_LAMPORTS='100000';
export const solQuoteFunding=launch=>launch.fundingMode==='sol'&&launch.quoteMint!==str(NATIVE_MINT);
export const pendingLaunchLamports=launch=>130000000n+raw(launch.creationFee?.lamports||'0');

// Ignore fees and round price movement/output upward. This is an upper bound
// on tokens a first buy can receive, before any irreversible quote purchase.
export function verifyFundingFirstBuy(model,firstBuyRaw){
  const input=raw(firstBuyRaw);if(!input)return;
  const low=BigInt(model.sqrtMinPrice),high=BigInt(model.sqrtMaxPrice),liquidity=BigInt(model.liquidity);
  const end=low+ceil(input*(1n<<128n),liquidity);
  ensure(end<=high&&ceil(liquidity*(end-low),low*end)<=BigInt(model.supply)/10n,'The first buy cannot exceed 10% of supply. Reduce the SOL amount.');
}
export function cappedFundingFirstBuy(model,requested){let low=0n,high=raw(requested);while(low<high){const mid=(low+high+1n)/2n;try{verifyFundingFirstBuy(model,String(mid));low=mid;}catch{high=mid-1n;}}return String(low);}
export function fundingReview(launch,plan){return {fundingMode:'sol',firstBuySolLamports:launch.firstBuySolLamports,quoteFundingInLamports:plan.solLamports,quoteFundingExpectedRaw:plan.expectedRaw,quoteFundingMinRaw:plan.minimumRaw,firstBuyRaw:plan.firstBuyRaw,quoteSeedRaw:'1',maxQuoteDebitRaw:String(raw(plan.firstBuyRaw)+1n),quoteMint:launch.quoteMint,quoteDecimals:launch.quoteDecimals,quoteSymbol:launch.quoteSymbol};}
export async function quoteLaunchFunding(adapter,launch,wallet,{maxAccounts=32}={}){
  ensure(solQuoteFunding(launch)&&wallet===launch.creatorWallet,'This launch cannot purchase quote assets for another wallet.');
  const entered=raw(launch.firstBuySolLamports),solLamports=entered>0n?entered.toString():DAMM_SEED_FUNDING_LAMPORTS;
  const chain=adapter.conversionChain;ensure(chain?.fetcher&&chain?.jupiterGate,'SOL conversion is not configured. Please try again shortly.');
  const routes=adapter.fundingRoutes||{quoteConversion,buildConversion};
  const route=await routes.quoteConversion(chain,{inputMint:str(NATIVE_MINT),outputMint:launch.quoteMint,inputProgram:str(TOKEN_PROGRAM_ID),outputProgram:launch.quoteTokenProgram,amountRaw:solLamports,slippageBps:100,wallet,maxAccounts});
  ensure(route.inputMint===str(NATIVE_MINT)&&route.outputMint===launch.quoteMint&&route.amountRaw===solLamports,'The funding route differs from the saved SOL budget.');
  const minimum=raw(route.minimumRaw),expected=raw(route.expectedRaw);ensure(minimum>=1n&&expected>=minimum,'The SOL amount is too small to acquire the pool seed. Choose a larger amount or another pair.');
  if(entered>0n)ensure(minimum>1n,'The SOL first buy is too small after conversion and pool initialization.');
  const plan={solLamports,firstBuyRaw:entered>0n?String(minimum-1n):'0',expectedRaw:expected.toString(),minimumRaw:minimum.toString()};
  verifyFundingFirstBuy(adapter.model(launch),plan.firstBuyRaw);return {route,plan,routes};
}


export async function previewLaunchFunding(adapter,launch,wallet){
  let failure;
  for(const maxAccounts of SOL_ROUTE_ACCOUNT_BUDGETS){
    let quoted;try{quoted=await quoteLaunchFunding(adapter,launch,wallet,{maxAccounts});}catch(error){if(failure&&error.code==='SOL_ROUTE_NOT_FOUND')continue;throw error;}
    const built=await quoted.routes.buildConversion(adapter.conversionChain,quoted.route);
    try{const tx=new VersionedTransaction(new TransactionMessage({payerKey:pk(wallet),recentBlockhash:str(PublicKey.default),instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:0}),...built.instructions]}).compileToV0Message(built.lookupTables));ensure(tx.serialize().length<=1232,'The funding route exceeds the network packet size.');return quoted;}
    catch(error){if(!/encoding overruns|packet size|too large|offset.*bounds/i.test(error.message))throw error;failure=error;}
  }
  throw failure||Error('No funding route fits this launch. Try again shortly.');
}

export async function simulateFunding(connection,tx,options,latest){let result=await connection.simulateTransaction(tx,options);if(result.value.err==='BlockhashNotFound'){const fresh=await connection.getLatestBlockhash('confirmed');Object.assign(latest,fresh);tx.message.recentBlockhash=fresh.blockhash;result=await connection.simulateTransaction(tx,options);}return result;}

function info(value){return value?{...value,owner:pk(value.owner),data:Array.isArray(value.data)?Buffer.from(value.data[0],'base64'):value.data}:null;}
function token(key,value,mint,program,wallet){
  if(!value)return null;const i=info(value);ensure(!i.executable&&Number.isSafeInteger(i.lamports)&&i.lamports>=0,'The funding token account is invalid.');
  const a=unpackAccount(key,i,program);ensure(a.owner.equals(wallet)&&a.mint.equals(mint)&&a.isInitialized&&!a.isFrozen&&!a.isNative&&!a.delegate&&!a.closeAuthority&&a.delegatedAmount===0n,'The funding token account has unexpected permissions.');return a;
}
const snapshots=tables=>tables.map(table=>({address:str(table.key),addresses:table.state.addresses.map(str)}));
export async function verifyFundingLookupTables(adapter,bundle){
  ensure(bundle.action==='fund-quote'&&Array.isArray(bundle.addressLookupTables)&&bundle.addressLookupTables.length<=20,'Invalid funding lookup table proof.');
  const rows=bundle.addressLookupTables;ensure(new Set(rows.map(r=>r.address)).size===rows.length,'Repeated funding lookup table.');
  if(!rows.length)return [];
  const tables=await adapter.conversionChain.lookupTables(rows.map(r=>r.address));
  ensure(tables.length===rows.length&&tables.every((t,i)=>t.key.toBase58()===rows[i].address&&Array.isArray(rows[i].addresses)&&t.state.addresses.length>=rows[i].addresses.length&&rows[i].addresses.every((a,n)=>str(t.state.addresses[n])===a)),'The funding lookup table changed after wallet review.');return tables;
}

const computeLimited=error=>Array.isArray(error?.simulation?.err?.InstructionError)&&['ComputationalBudgetExceeded','MaxInstructionTraceLengthExceeded'].includes(error.simulation.err.InstructionError[1]);
export async function prepareLaunchFunding(adapter,config,{launch,wallet,relayer=config.relayer,now=adapter.now(),atomic=false,slippageBps=100,preparedAttempt=null}){
  ensure(solQuoteFunding(launch)&&launch.fundingStatus!=='finalized'&&wallet===launch.creatorWallet,'This launch funding is already complete or belongs to another wallet.');
  await adapter.verifyQuote(launch);
  const owner=pk(wallet),mint=pk(launch.quoteMint),program=pk(launch.quoteTokenProgram),quoteAta=getAssociatedTokenAddressSync(mint,owner,false,program),nativeAta=getAssociatedTokenAddressSync(NATIVE_MINT,owner);
  let sizedError;
  for(const maxAccounts of preparedAttempt?[32]:SOL_ROUTE_ACCOUNT_BUDGETS){
    let quoted;try{quoted=preparedAttempt||await quoteLaunchFunding(adapter,launch,wallet,{maxAccounts});}catch(error){if(sizedError&&error.code==='SOL_ROUTE_NOT_FOUND')continue;throw error;}
    const {route,plan,routes}=quoted;
    const built=preparedAttempt?.built||await routes.buildConversion(adapter.conversionChain,route);
    ensure(Array.isArray(built.monitoredAccounts)&&built.monitoredAccounts.length<=32,'The funding account audit is unavailable.');
    // The controller's co-signer becomes globally privileged in a composite
    // message. Even a nonsigner alias in Jupiter's remaining keys is forbidden.
    ensure(!built.instructions.some(ix=>str(ix.programId)===relayer||ix.keys.some(key=>str(key.pubkey)===relayer)),'The conversion route references the graduation signer. No swap was submitted.');
    let candidate=null,latest,tx;
    if(atomic){
      // Validate the same route alone with its exact input and persistent rent
      // allowance. It cannot borrow the pool initialization rent budget.
      try{await prepareLaunchFunding(adapter,config,{launch,wallet,relayer,now,atomic:false,slippageBps,preparedAttempt:{route,plan,routes,built}});candidate=await adapter.prepare(config,{action:'initialize',wallet,relayer,launch:{...launch,firstBuyRaw:plan.firstBuyRaw},amountRaw:plan.firstBuyRaw,slippageBps,now,fundingContext:{instructions:built.instructions,lookupTables:built.lookupTables,plan}});latest=candidate.blockhash;tx=VersionedTransaction.deserialize(Buffer.from(candidate.unsignedTransaction,'base64'));}
      catch(error){if(error.code==='DAMM_PACKET_TOO_LARGE'||computeLimited(error)){sizedError=error;continue;}throw error;}
    }else{
      latest=await adapter.connection.getLatestBlockhash('confirmed');const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:0}),...built.instructions];
      try{tx=new VersionedTransaction(new TransactionMessage({payerKey:owner,recentBlockhash:latest.blockhash,instructions}).compileToV0Message(built.lookupTables));ensure(tx.serialize().length<=1232,'The funding route exceeds the network packet size.');}catch(error){if(!/encoding overruns|packet size|too large|offset.*bounds/i.test(error.message))throw error;sizedError=Object.assign(error,{code:'DAMM_PACKET_TOO_LARGE'});continue;}
    }
    const fee=await adapter.connection.getFeeForMessage(tx.message,'confirmed');ensure(Number.isSafeInteger(fee.value)&&fee.value>=0,'The funding network fee is unavailable.');
    const extras=built.monitoredAccounts;ensure(new Set(extras.map(row=>row.address)).size===extras.length&&extras.every(row=>![wallet,str(quoteAta),str(nativeAta),built.nativeAccount].includes(row.address)),'The funding account audit contains duplicate accounts.');
    const keys=[owner,quoteAta,nativeAta,...extras.map(row=>pk(row.address))],before=await adapter.connection.getMultipleAccountsInfoAndContext(keys,{commitment:'confirmed',minContextSlot:route.slot});
    ensure(Number.isSafeInteger(before.context?.slot)&&before.context.slot>=route.slot&&before.value?.length===keys.length,'The RPC omitted the funding wallet balances.');
    const payer=before.value[0];ensure(payer&&!payer.executable&&payer.owner.equals(SystemProgram.programId)&&Number.isSafeInteger(payer.lamports)&&payer.lamports>=0,'The funding wallet account is invalid.');
    const balance=BigInt(payer.lamports),beforeQuote=token(quoteAta,before.value[1],mint,program,owner),quoteRent=beforeQuote?0n:BigInt(await adapter.connection.getMinimumBalanceForRentExemption(program.equals(TOKEN_PROGRAM_ID)?165:170));
    const rent=quoteRent+extras.reduce((sum,row,i)=>sum+(before.value[i+3]?0n:BigInt(row.minimumLamports)),0n),peakRent=raw(built.rentLamports)+quoteRent,pending=pendingLaunchLamports(launch),maximum=raw(plan.solLamports)+rent+BigInt(fee.value)+(atomic?pending:0n);
    ensure(balance>=raw(plan.solLamports)+peakRent+BigInt(fee.value)+pending,'The wallet needs more SOL for conversion, token-account rent, and the remaining launch.');
    const baseAta=getAssociatedTokenAddressSync(pk(launch.mint),owner);
    const sim=await simulateFunding(adapter.connection,tx,{sigVerify:false,commitment:'confirmed',minContextSlot:before.context.slot,accounts:{encoding:'base64',addresses:[...keys.map(str),built.nativeAccount,...(atomic?[str(baseAta)]:[])]}},latest);
    if(sim.value.err){const error=Object.assign(Error(`Quote funding simulation failed: ${JSON.stringify(sim.value.err)}. No swap was submitted.`),{simulation:sim.value});if(atomic&&computeLimited(error)){sizedError=error;continue;}throw error;}
    const values=sim.value.accounts;ensure(Number.isSafeInteger(sim.context?.slot)&&sim.context.slot>=before.context.slot&&values?.length===keys.length+1+(atomic?1:0),'The RPC omitted funding simulation balances.');
    const afterPayer=values[0];ensure(afterPayer&&!afterPayer.executable&&afterPayer.owner===str(SystemProgram.programId)&&Number.isSafeInteger(afterPayer.lamports)&&afterPayer.lamports>=0,'The funding simulation omitted the wallet balance.');
    const consumed=atomic?raw(candidate.trade?.charged||'0')+1n:0n;
    const afterQuote=token(quoteAta,values[1],mint,program,owner);ensure(!beforeQuote||values[1]?.lamports>=before.value[1].lamports,'The conversion changed existing quote account rent.');ensure(afterQuote&&afterQuote.amount-(beforeQuote?.amount||0n)>=raw(plan.minimumRaw)-consumed,'The conversion does not deliver the reviewed minimum quote amount.');
    const debit=balance-BigInt(afterPayer.lamports);ensure(debit>=raw(plan.solLamports)+BigInt(fee.value)&&debit<=maximum,'The conversion exceeds its reviewed SOL spend.');
    // Existing wrapped SOL is excluded from every composed instruction.
    const wsolBefore=before.value[2],wsolAfter=info(values[2]);ensure(wsolBefore?!!wsolAfter&&str(wsolBefore.owner)===str(wsolAfter.owner)&&wsolBefore.lamports===wsolAfter.lamports&&wsolBefore.data.equals(wsolAfter.data):!wsolAfter,'The conversion would change existing wrapped SOL.');
    ensure(!values[keys.length],'The conversion would retain an unexpected wrapped SOL account.');
    if(atomic){const base=token(baseAta,values[keys.length+1],pk(launch.mint),TOKEN_PROGRAM_ID,owner);ensure(candidate.trade?base&&base.amount>=raw(candidate.trade.minimum):!base||base.amount===0n,'The launch does not deliver the reviewed first-buy tokens.');}
    for(let i=0;i<extras.length;i++){
      const row=extras[i],key=keys[i+3],m=pk(row.mint),p=pk(row.program),beforeExtra=token(key,before.value[i+3],m,p,owner),after=token(key,values[i+3],m,p,owner);
      ensure(after&&after.amount>=raw(row.minimumAmountRaw)&&after.amount>=(beforeExtra?.amount||0n)&&Number.isSafeInteger(row.minimumLamports)&&values[i+3].lamports>=row.minimumLamports&&values[i+3].lamports>=(before.value[i+3]?.lamports||0),'The conversion changed an intermediate wallet account.');
    }
    ensure(BigInt(await adapter.connection.getBalance(owner,{commitment:'confirmed',minContextSlot:sim.context.slot}))===balance,'The wallet balance changed during funding review.');
    const tables=built.lookupTables.filter(t=>tx.message.addressTableLookups.some(l=>l.accountKey.equals(t.key))),review={...candidate?.review,...fundingReview(launch,plan),stage:atomic?'initialize':'fund-quote',stages:atomic?2:3,networkFeeLamports:String(fee.value),rentLamports:rent.toString(),maxWalletDebitLamports:debit.toString(),totalSolBudgetLamports:debit.toString(),minimumWalletBalanceLamports:String(raw(plan.solLamports)+peakRent+BigInt(fee.value)+pending),totalLaunchMaxDebitLamports:String(raw(launch.lookupSetupDebitLamports||'0')+debit+(atomic?0n:pending)),totalLaunchBudgetEstimated:!atomic,budgetIncludesAccountRent:true,walletBalanceLamports:balance.toString(),...(atomic?{launchFeeLamports:String(debit-raw(plan.solLamports)-BigInt(fee.value))}:{})};
    return {...candidate,action:atomic?'initialize':'fund-quote',unsignedTransaction:Buffer.from(tx.serialize()).toString('base64'),blockhash:latest,needsRelayer:atomic,preparedAt:now,fundingPlan:plan,review,addressLookupTables:candidate?.addressLookupTables||snapshots(tables),fundingProof:{quoteAccount:str(quoteAta),minimumRaw:plan.minimumRaw,solLamports:plan.solLamports,maxWalletDebitLamports:maximum.toString()},addresses:candidate?.addresses||{}};
  }
  if(atomic&&sizedError)return prepareLaunchFunding(adapter,config,{launch,wallet,relayer,now,slippageBps,atomic:false});
  throw sizedError||Error('A funding route could not fit the network packet. Try again shortly.');
}

export function fundingReceipt(op,launch,receipt,quoteConsumedRaw=0n){
  const plan=op.bundle.fundingPlan,proof=op.bundle.fundingProof;
  ensure(solQuoteFunding(launch)&&plan&&proof&&plan.solLamports===proof.solLamports&&plan.minimumRaw===proof.minimumRaw,'The saved funding receipt proof is unavailable.');
  const keys=receipt.transaction.message.accountKeys.map(key=>str(key.pubkey||key)),walletIndex=keys.indexOf(op.wallet),quoteIndex=keys.indexOf(proof.quoteAccount);
  ensure(walletIndex===0&&quoteIndex>=0&&receipt.meta.preBalances?.length===keys.length&&receipt.meta.postBalances?.length===keys.length,'The funding receipt wallet accounts are invalid.');
  const tokenAmount=rows=>{const matches=(rows||[]).filter(row=>row.accountIndex===quoteIndex);ensure(matches.length<=1,'Duplicate funding receipt token balance.');if(!matches.length)return 0n;const row=matches[0];ensure(row.mint===launch.quoteMint&&row.owner===op.wallet&&(!row.programId||row.programId===launch.quoteTokenProgram),'The funding receipt quote account differs from this launch.');return raw(row.uiTokenAmount.amount);};
  ensure(Number.isSafeInteger(receipt.meta.fee)&&receipt.meta.fee>=0&&[receipt.meta.preBalances[0],receipt.meta.postBalances[0]].every(value=>Number.isSafeInteger(value)&&value>=0),'The funding receipt SOL balances are invalid.');
  const received=tokenAmount(receipt.meta.postTokenBalances)-tokenAmount(receipt.meta.preTokenBalances)+quoteConsumedRaw,debit=BigInt(receipt.meta.preBalances[0])-BigInt(receipt.meta.postBalances[0]);
  ensure(received>=raw(plan.minimumRaw)&&debit>=raw(plan.solLamports)+BigInt(receipt.meta.fee)&&debit-BigInt(receipt.meta.fee)<=raw(proof.maxWalletDebitLamports),'The finalized funding receipt does not match its reviewed spend and output.');
  return {state:'finalized',signature:op.signature,slot:receipt.slot,funding:{...plan,receivedRaw:received.toString(),debitLamports:debit.toString()}};
}
