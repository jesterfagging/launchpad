/** Fee-aware migration with legacy launch terms preserved by controller identity. */
import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, unpackMint } from '@solana/spl-token';
import { DammPumpClientAdapter } from './damm-pump-chain.mjs';
import { DAMM_PUMP_DEFAULTS } from './damm-pump-service.mjs';
import { DAMM_PUMP_POLICY } from './damm-pump-policy.mjs';
import { DAMM_PUMP_FEE_POLICY, dammPumpFeeCurveAtGraduationTarget } from './damm-pump-fee-policy.mjs';
import { DAMM_PUMP_FEE_DEPLOYMENT_POLICY } from './damm-pump-fee-deployment.mjs';
import { verifyDammPumpFeeDeployment } from './damm-pump-fee-deployment-service.mjs';
import { verifyDammPumpDeployment } from './damm-pump-deployment-service.mjs';
import * as feeClient from './damm-pump-admin-test-client.mjs';

const str=value=>value?.toBase58?.()??String(value),pk=value=>new PublicKey(value);
const ensure=(condition,message)=>{if(!condition)throw Object.assign(Error(message),{statusCode:409});};
const json=value=>JSON.parse(JSON.stringify(value,(_,item)=>typeof item==='bigint'?String(item):item));
const keyMap=a=>Object.fromEntries(Object.entries(a).filter(([,v])=>v?.toBase58).map(([k,v])=>[k,str(v)]));
export const DAMM_PUMP_FEE_DEFAULTS=Object.freeze({...DAMM_PUMP_DEFAULTS,graduationFeeBps:3223.69073,graduationFeeNumerator:'322369073',graduationFeeDenominator:'1000000000',graduationFeePercent:32.2369073});

/** Receipt amounts come from this exact finalized transaction, not a pool that
 * can already have traded by the time the provider answers the next request. */
export function verifyDammPumpGraduationFee(receipt,state,addresses,model,signature,{atomicTrade}={}){
  const a=feeClient.feeAddresses({programId:str(addresses.program),mint:str(addresses.mint),quoteMint:str(addresses.quoteMint),quoteTokenProgram:str(addresses.quoteTokenProgram),poolIndex:state.poolIndex});
  const gross=BigInt(model.finalQuote),fee=feeClient.graduationFeeRaw(gross),net=gross-fee,base=BigInt(model.baseReserved);
  ensure(state.phase===2&&state.pool===str(a.pool)&&state.expectedQuote===String(gross)&&state.graduationFeePaidRaw===String(fee)&&state.quoteMigrated===String(net)&&state.baseMigrated===String(base)&&fee>0n,'The migration state does not prove the fixed graduation fee and pool deposits.');
  const keys=receipt.transaction.message.accountKeys.map(k=>typeof k==='string'?k:str(k.pubkey));
  const balance=(rows,key,mint,owner,optional=false)=>{const index=keys.indexOf(str(key)),row=rows?.find(r=>r.accountIndex===index&&r.mint===str(mint));if(!row&&optional)return 0n;ensure(index>=0&&row?.owner===str(owner)&&typeof row.uiTokenAmount?.amount==='string'&&/^(0|[1-9]\d*)$/.test(row.uiTokenAmount.amount),'The migration receipt omitted a verified token balance.');return BigInt(row.uiTokenAmount.amount);};
  const instructions=[...(receipt.transaction.message.instructions||[]),...(receipt.meta.innerInstructions||[]).flatMap(row=>row.instructions||[])];
  const transfers=instructions.filter(ix=>['transfer','transferChecked'].includes(ix.parsed?.type)&&[str(TOKEN_PROGRAM_ID),str(TOKEN_2022_PROGRAM_ID)].includes(str(ix.programId)));
  const amount=ix=>BigInt(ix.parsed.info.amount??ix.parsed.info.tokenAmount.amount);
  const exact=(source,destination,authority,program,expected)=>{const rows=transfers.filter(ix=>ix.parsed.info.source===str(source)&&ix.parsed.info.destination===str(destination));ensure(rows.length===1&&rows[0].parsed.info.authority===str(authority)&&str(rows[0].programId)===str(program)&&amount(rows[0])===expected,'The migration receipt does not prove the exact treasury fee and liquidity transfers.');};
  exact(a.quoteAta,a.treasuryQuote,a.authority,a.quoteTokenProgram,fee);
  exact(a.quoteAta,a.poolQuote,a.authority,a.quoteTokenProgram,net);
  exact(a.baseAta,a.poolBase,a.authority,TOKEN_PROGRAM_ID,base);
  ensure(transfers.filter(ix=>ix.parsed.info.source===str(a.quoteAta)).length===2&&transfers.filter(ix=>ix.parsed.info.source===str(a.baseAta)).length===1,'The migration contains an unexpected custody token transfer.');
  const supplyActions=instructions.filter(ix=>str(ix.programId)===str(TOKEN_PROGRAM_ID)&&['burn','burnChecked','mintTo','mintToChecked'].includes(ix.parsed?.type)&&ix.parsed.info.mint===str(a.mint));ensure(!supplyActions.length,'The migration changed the fixed token supply.');
  const treasuryBefore=balance(receipt.meta.preTokenBalances,a.treasuryQuote,a.quoteMint,a.treasury,true),treasuryAfter=balance(receipt.meta.postTokenBalances,a.treasuryQuote,a.quoteMint,a.treasury);
  let treasuryBuyDebit=0n;
  if(atomicTrade?.wallet===feeClient.PUBLIC_TREASURY&&atomicTrade.trade?.quoteAccount===str(a.treasuryQuote)){
    const trade=atomicTrade.trade,buys=transfers.filter(ix=>ix.parsed.info.source===str(a.treasuryQuote)&&ix.parsed.info.destination===str(a.dammQuoteVault));
    ensure(trade.side==='buy'&&trade.venue==='damm-v2'&&buys.length===1&&buys[0].parsed.info.authority===feeClient.PUBLIC_TREASURY&&str(buys[0].programId)===str(a.quoteTokenProgram),'The treasury final buy lacks its exact DAMM debit proof.');
    treasuryBuyDebit=amount(buys[0]);ensure(treasuryBuyDebit>0n&&treasuryBuyDebit<=BigInt(trade.input),'The treasury final buy exceeds its reviewed budget.');
  }
  ensure(treasuryAfter-treasuryBefore===fee-treasuryBuyDebit,'The treasury did not receive exactly the graduation fee.');
  ensure(balance(receipt.meta.preTokenBalances,a.poolBase,a.mint,a.pool,true)===0n&&balance(receipt.meta.preTokenBalances,a.poolQuote,a.quoteMint,a.pool,true)===0n&&balance(receipt.meta.postTokenBalances,a.poolBase,a.mint,a.pool)===base&&balance(receipt.meta.postTokenBalances,a.poolQuote,a.quoteMint,a.pool)===net,'The new pool balances differ from the recorded deposits.');
  const beforeBase=balance(receipt.meta.preTokenBalances,a.baseAta,a.mint,a.authority),afterBase=balance(receipt.meta.postTokenBalances,a.baseAta,a.mint,a.authority),beforeQuote=balance(receipt.meta.preTokenBalances,a.quoteAta,a.quoteMint,a.authority),afterQuote=balance(receipt.meta.postTokenBalances,a.quoteAta,a.quoteMint,a.authority);
  let syncedQuoteDonation=0n;
  if(a.quoteMint.equals(NATIVE_MINT)&&afterQuote>beforeQuote){
    const index=keys.indexOf(str(a.quoteAta)),syncs=instructions.filter(ix=>str(ix.programId)===str(TOKEN_PROGRAM_ID)&&ix.parsed?.type==='syncNative'&&ix.parsed.info.account===str(a.quoteAta)),beforeLamports=receipt.meta.preBalances?.[index],afterLamports=receipt.meta.postBalances?.[index];
    ensure(syncs.length===1&&Number.isSafeInteger(beforeLamports)&&beforeLamports>=0&&beforeLamports===afterLamports,'The native custody balance increase lacks an unchanged-lamport sync receipt.');
    syncedQuoteDonation=afterQuote-beforeQuote;
  }
  ensure(beforeBase>=base&&beforeBase-afterBase===base&&afterQuote-beforeQuote===syncedQuoteDonation,'The migration retained principal or consumed unrelated custody balances.');
  const endpoint=base*BigInt(model.sqrtMaxPrice)**2n,error=net*(1n<<128n)-endpoint;ensure((error<0n?-error:error)*2000n<=endpoint,'The migration did not preserve the reviewed graduation price.');
  return {graduationFee:{verified:true,quoteMint:str(a.quoteMint),amountRaw:String(fee),recipient:str(a.treasury),tokenAccount:str(a.treasuryQuote),signature},grossQuoteRaw:String(gross),graduationFeeRaw:String(fee),poolQuoteRaw:String(net),poolBaseRaw:String(base),retainedPrincipalBaseRaw:'0',retainedPrincipalQuoteRaw:'0',unrelatedCustodyBaseRaw:String(afterBase),unrelatedCustodyQuoteRaw:String(afterQuote),syncedQuoteDonationRaw:String(syncedQuoteDonation),priceContinuityVerified:true};
}

/** Shared only by new fee controllers and the separate owner test controller. */
export class DammPumpGraduationFeeAdapter extends DammPumpClientAdapter {
  feeApplies(){return true;}
  migrationInstruction(config,launch,wallet,poolIndex){return this.feeApplies(config,launch)?feeClient.migrateIx({programId:config.programId,payer:wallet,mint:launch.mint,quoteMint:launch.quoteMint,quoteTokenProgram:launch.quoteTokenProgram||launch.quoteProgram,poolIndex}):super.migrationInstruction(config,launch,wallet,poolIndex);}
  async atomicGraduation(config,launch,wallet,trade){const result=await super.atomicGraduation(config,launch,wallet,trade);if(result&&this.feeApplies(config,launch)){const model=this.model(launch);Object.assign(result.review,{graduationFeeRaw:model.graduationFeeRaw,graduationFeeRecipient:feeClient.PUBLIC_TREASURY,expectedLpQuoteRaw:model.migrationQuoteRaw,expectedLpBaseRaw:model.baseReserved});}return result;}
  async rawState(config,launch,commitment='confirmed',minContextSlot){
    if(!this.feeApplies(config,launch))return super.rawState(config,launch,commitment,minContextSlot);
    const a=this.launchAddresses(config,launch),r=await this.read(a.state,config.programId,commitment,minContextSlot);if(!r.value)return {state:null,addresses:a,slot:r.context.slot};
    const s=feeClient.decodeState(r.value,config.programId),m=this.model(launch);
    for(const [key,expected]of Object.entries({mint:launch.mint,creator:launch.creatorWallet,quoteMint:launch.quoteMint,quoteTokenProgram:str(a.quoteTokenProgram),dammPool:str(a.dammPool),position:str(a.position),nftMint:str(a.nftMint),nftAccount:str(a.nftAccount),quoteDecimals:launch.quoteDecimals,quoteUsdMicros:launch.priceSnapshot.quoteUsdMicros,sqrtMinPrice:m.sqrtMinPrice,sqrtMaxPrice:m.sqrtMaxPrice,liquidity:m.liquidity,saleBase:m.baseForSale,reserveBase:m.baseReserved,expectedQuote:m.finalQuote}))ensure(String(s[key])===String(expected),`The saved fee-controller ${key} differs from this launch.`);
    return {state:s,addresses:a,slot:r.context.slot};
  }
  async prepare(config,args){
    if(!this.feeApplies(config,args.launch))return super.prepare(config,args);
    const bundle=args.action==='migrate'?await this.prepareFeeMigration(config,args):await super.prepare(config,args);
    const model=this.model(args.launch);
    return {...bundle,review:{...bundle.review,graduationFeeNumerator:'322369073',graduationFeeDenominator:'1000000000',graduationFeeBps:3223.69073,graduationFeePercent:32.2369073,estimatedGrossQuoteRaw:model.finalQuote,estimatedGraduationFeeRaw:model.graduationFeeRaw,estimatedLpQuoteRaw:model.migrationQuoteRaw,estimatedGraduationFeeUsd:model.estimatedGraduationFeeUsd,estimatedMigrationLiquidityUsd:model.estimatedMigrationLiquidityUsd,treasury:feeClient.PUBLIC_TREASURY}};
  }
  async prepareFeeMigration(config,{wallet,relayer,launch,now=this.now()}){
    const preparedAtSlot=await this.preparedSlot();
    await this.verifyDeployment(config);await this.venueVerifier({connection:this.connection,now:this.now});ensure(wallet===relayer&&relayer===config.relayer,'Only the managed graduation relayer may prepare fee migration.');await this.verifyQuote(launch);
    const current=await this.dammSnapshot(config,launch,'confirmed');ensure(current.state.phase===0&&BigInt(str(current.pool.sqrtPrice))>=BigInt(current.state.sqrtMaxPrice),'This launch has not reached its graduation endpoint.');
    const selected=await this.cleanPool(config,launch),poolIndex=selected.index,a=feeClient.feeAddresses({programId:config.programId,mint:launch.mint,quoteMint:launch.quoteMint,quoteTokenProgram:launch.quoteTokenProgram,poolIndex}),model=this.model(launch);
    const latest=await this.connection.getLatestBlockhash('confirmed'),instruction=feeClient.migrateIx({programId:config.programId,payer:wallet,mint:launch.mint,quoteMint:launch.quoteMint,quoteTokenProgram:launch.quoteTokenProgram,poolIndex});
    const tx=await this.buildTransaction(config,launch,wallet,[instruction],'migrate',latest),fee=await this.connection.getFeeForMessage(tx.message,'confirmed');ensure(Number.isSafeInteger(fee.value)&&fee.value>=0,'The migration network fee is unavailable.');
    const balance=BigInt(await this.balance(config,wallet)),sim=await this.connection.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed',accounts:{encoding:'base64',addresses:[wallet]}});ensure(!sim.value.err,`Fee migration simulation failed: ${JSON.stringify(sim.value.err)}.`);const post=sim.value.accounts?.[0];ensure(post&&Number.isSafeInteger(post.lamports)&&post.lamports>=0,'Simulation omitted the migration payer balance.');ensure(BigInt(await this.connection.getBalance(pk(wallet),{commitment:'confirmed',minContextSlot:sim.context.slot}))===balance,'The migration payer balance changed during review.');
    const debit=balance>BigInt(post.lamports)?balance-BigInt(post.lamports):BigInt(fee.value);ensure(balance>=debit,'The graduation wallet needs more SOL for rent and transaction fees.');
    return {action:'migrate',unsignedTransaction:Buffer.from(tx.serialize()).toString('base64'),blockhash:latest,needsRelayer:false,poolIndex,addresses:keyMap(a),preparedAt:now,preparedAtSlot,addressLookupTables:json(launch.lookupTables||[]),review:{poolIndex,expectedPool:str(a.pool),graduationFeeRaw:model.graduationFeeRaw,graduationFeeRecipient:feeClient.PUBLIC_TREASURY,networkFeeLamports:String(fee.value),maxWalletDebitLamports:String(debit),totalSolBudgetLamports:String(debit),walletBalanceLamports:String(balance),quoteMint:launch.quoteMint,quoteDecimals:launch.quoteDecimals,quoteSymbol:launch.quoteSymbol,lpPolicy:'The fixed graduation fee is paid to Launchpad; all PumpSwap LP received by custody is burned atomically.'}};
  }
  async reconcile(config,op,launch){
    const result=await super.reconcile(config,op,launch);
    if(!this.feeApplies(config,launch)||!(op.action==='migrate'||op.bundle.atomicGraduation===true)||result.state!=='finalized')return result;
    const receipt=await this.connection.getParsedTransaction(op.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});ensure(receipt?.slot===result.slot&&receipt.meta?.err===null,'The finalized migration receipt changed during fee verification.');
    const r=await this.rawState(config,launch,'finalized',receipt.slot),a=this.launchAddresses(config,launch,{poolIndex:op.bundle.poolIndex}),verified=verifyDammPumpGraduationFee(receipt,r.state,a,this.model(launch),op.signature,{atomicTrade:op.bundle.atomicGraduation?{wallet:op.wallet,trade:op.bundle.trade}:undefined});
    const info=await this.connection.getAccountInfo(a.mint,{commitment:'finalized',minContextSlot:receipt.slot}),mint=unpackMint(a.mint,info,TOKEN_PROGRAM_ID);ensure(mint.decimals===6&&!mint.mintAuthority&&!mint.freezeAuthority&&mint.supply<=BigInt(feeClient.DAMM_PUMP_SUPPLY),'The fee migration token supply or revoked authorities changed.');
    const {graduationPaidLamports,...base}=result;return {...base,...verified,mintSupplyRaw:String(mint.supply),fixedMintSupplyRaw:feeClient.DAMM_PUMP_SUPPLY};
  }
}

export class DammPumpFeeClientAdapter extends DammPumpGraduationFeeAdapter {
  constructor(options={}){super({...options,deploymentVerifier:options.deploymentVerifier||(args=>args.config.programId===DAMM_PUMP_FEE_DEPLOYMENT_POLICY.programId?verifyDammPumpFeeDeployment(args):verifyDammPumpDeployment(args))});}
  feeApplies(config,launch){return (config?.programId||launch?.publicProgramId)===DAMM_PUMP_FEE_DEPLOYMENT_POLICY.programId;}
  supportsNewLaunch(config){return config?.programId===DAMM_PUMP_FEE_DEPLOYMENT_POLICY.programId;}
  launchTerms(config){return this.feeApplies(config)?{policyVersion:DAMM_PUMP_FEE_POLICY.version,defaults:DAMM_PUMP_FEE_DEFAULTS}:{policyVersion:DAMM_PUMP_POLICY.version,defaults:DAMM_PUMP_DEFAULTS};}
  model(launch){return this.feeApplies(null,launch)?dammPumpFeeCurveAtGraduationTarget({quoteDecimals:launch.quoteDecimals,quoteUsdMicros:launch.priceSnapshot.quoteUsdMicros}):super.model(launch);}
}
