import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram, AddressLookupTableAccount, AddressLookupTableProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, unpackMint, unpackAccount, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, createBurnCheckedInstruction, createWithdrawWithheldTokensFromAccountsInstruction, getTransferFeeAmount, getTransferFeeConfig, getExtensionTypes, ExtensionType, getEpochFee, getAccountLen } from '@solana/spl-token';
import BN from 'bn.js';
import bs58 from 'bs58';
import { createPublicFetcher, publicEndpoint } from './telegram-network.mjs';
import { localRequestGate, requestKey, requestInterval } from './request-pacing.mjs';
import { processRpcGate } from './shared-rpc-gate.mjs';
import { operatorCapacity, operatorRpcOptions, rpcEndpointHash } from './operator-capacity.mjs';
import { SOL_MINT, USDC_MINT, units, displayUnits, requireValue as ok, LAUNCH_CURVE_POLICY, LAUNCH_CURVE_POLICY_4K, newLaunchCurvePolicy } from '../public/launchpad-model.mjs';
import { rayCurveAtGraduationTarget } from './launchpad-curve-target.mjs';
import { JUPITER } from './core.mjs';
import { signer, validateTaxBurnInstructions } from './launchpad-receipts.mjs';
import {rewardsWalletSelection,rewardsWalletKey,dedicatedRewardsWallet,requireManagedRewardSource,rewardHandoffPlan} from './launchpad-rewards-wallet.mjs';
import { invertDeveloperBudget } from './launchpad-buy.mjs';
import { quoteLabel } from '../public/quote-identity.mjs';
import { readLaunchMarketSnapshot } from './launchpad-market.mjs';
import { readQuoteReference } from './launchpad-quote-price.mjs';
import { associatedTokenAccountSize } from './launchpad-token-account-size.mjs';
import { CREATOR_FEE_POLICY, CREATOR_FEE_RATE_PPM, HOLDER_CREATOR_FEE_POLICY, creatorFeeForLaunch, effectiveCreatorFeeRate, validCreatorFeeRate } from '../public/creator-fee-schedule.mjs';
import { paycheckLaunch } from './launchpad-paycheck.mjs';
import { taxBurnPlan, officialTaxBurnEnabled } from './launchpad-tax-burn.mjs';
import { taxConversionAmount, TAX_CONVERSION_MAX_IMPACT_BPS, TAX_CONVERSION_BURST_POLICY, TAX_CONVERSION_BACKLOG_UNITS, TAX_CONVERSION_BURST_MAX_IMPACT_BPS } from './launchpad-tax-conversion.mjs';
import { makeV1Transaction, deserializeTransaction } from './transactions-v1.mjs';
import { transactionSize, verifySignedTransaction } from './providers.mjs';
import { protocolLiquidityTerms, buildProtocolLiquidityClaim } from './launchpad-protocol-liquidity.mjs';
import { platformBrand, validPlatformBrandTarget } from './launchpad-branding.mjs';
// v71.34: a pair bought with SOL for a dev buy. The review commits only this much less than the route's guaranteed
// output, so the pair's price may move this far against the launch between the review and the purchase before the
// swap is refused (the Pump.fun flow keeps the same 5%). Wallets such as Phantom alter a transaction they sign (their
// protection instructions), and Launchpad never accepts an altered transaction that reads the instruction list, so a
// connected wallet is never asked to sign a purchase route that carries the Instructions sysvar.
const PAIR_FUNDING_DRIFT_BPS=500n,INSTRUCTIONS_SYSVAR='Sysvar1nstructions1111111111111111111111111';
const pairFundingIntrospectionText=(symbol,stage)=>stage==='review'
  ?`Launchpad can’t buy ${symbol} for this launch with a swap your connected wallet signs: every route to ${symbol} right now reads the transaction’s own instruction list, and wallets such as Phantom change that list when they add their protection instructions, so the swap could not be verified after signing. Launch without a dev buy, or pair with SOL or another asset.`
  :`The current swap route to ${symbol} reads the transaction’s own instruction list, which your wallet cannot be allowed to change. Nothing was signed or spent. Try again in a few minutes (routes change), or edit this launch to drop the dev buy or change the pair.`;
import { currentHolderRewardMinimum } from './launchpad-holder-rewards.mjs';
import { readMintTokenAccounts } from './launchpad-token-accounts.mjs';
import {validProtocolPolicyTarget} from './launchpad-policy-upgrade.mjs';
import {protocolWalletKey,protocolWalletView,protocolActivationWallet} from './launchpad-protocol-wallet.mjs';
import { ACCOUNT_SIZE, createInitializeAccount3Instruction, createCloseAccountInstruction, createWithdrawWithheldTokensFromMintInstruction } from '@solana/spl-token';
import { validateWalletMessage, validateWalletLookupAccounts } from './launchpad-wallet-guards.mjs';
import {savedAtaPayoutFailure,ataFundingSimulationFailure} from './launchpad-ata-recovery.mjs';
import {inspectNativeRewardRecipients,recipientRentSimulationError} from './launchpad-recipient-rent.mjs';
const require = createRequire(import.meta.url);
export const ray = require('@raydium-io/raydium-sdk-v2');
const bn = n => new BN(String(n)), pk = n => new PublicKey(n), zero = () => bn(0);
const GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
// Official Lighthouse mainnet deployment, read at finalized slot 450486111.
// This ProgramData has no upgrade authority. Pin the entire account (including
// its loader metadata), not just a mutable program address or source label.
const WALLET_GUARD_PROGRAM='L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
const WALLET_GUARD_DATA='CJ5WEjifs4d77pEA9DpewppByFjHcAkNv3YYSuSoDk7c';
const WALLET_GUARD_LOADER='BPFLoaderUpgradeab1e11111111111111111111111';
const WALLET_GUARD_HASH='94aee62cffe609a6a676b0b71281c49f1aa7ed3f388bae7dcb88d3b8ca412f9a';
let verifiedImmutableWalletGuard=false;
const compactPlan = launch => ['compact-v2','compact-v3'].includes(launch.executionPlan);
const contextLag = error => Number(error?.code) === -32016 || /minimum context slot has not been reached/i.test(error?.message || '');
const taxConversionReady = (ready,message) => {if(!ready)throw Object.assign(new Error(message),{code:'TAX_CONVERSION_DEFERRED'});};
const platformFeeHash = state => createHash('sha256').update(JSON.stringify(Object.entries(state).filter(([key])=>!['epoch','creatorFeeRate'].includes(key)).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,value?.toString?.()??value]))).digest('hex');
const platformPolicyHash = state => createHash('sha256').update(JSON.stringify(Object.entries(state).filter(([key])=>key!=='epoch').sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,value?.toString?.()??value]))).digest('hex');
const platformBrandHash = state => createHash('sha256').update(JSON.stringify(Object.entries(state).filter(([key])=>!['epoch','name','web','img'].includes(key)).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,value?.toString?.()??value]))).digest('hex');
const platformText = value => {const data=Buffer.from(value),end=data.indexOf(0),bytes=end<0?data:data.subarray(0,end);ok(end<0||data.subarray(end).every(byte=>byte===0),'The platform text contains unsupported padding.');return new TextDecoder('utf-8',{fatal:true}).decode(bytes);};
function platformPolicyUpdateInstruction(program,admin,platform,state,ratePpm){
  return ray.updatePlatformConfig(program,admin,platform,{type:'updateAll',value:{
    platformClaimFeeWallet:state.platformClaimFeeWallet,platformLockNftWallet:state.platformLockNftWallet,platformVestingWallet:state.platformVestingWallet,cpConfigId:state.cpConfigId,
    migrateCpLockNftScale:{platformScale:state.platformScale,creatorScale:state.creatorScale,burnScale:state.burnScale},feeRate:state.feeRate,
    name:platformText(state.name),web:platformText(state.web),img:platformText(state.img),transferFeeExtensionAuth:state.transferFeeExtensionAuth,creatorFeeRate:bn(ratePpm),platformVestingScale:state.platformVestingScale,
  }});
}

function compactWalletMessage(base, tables) {
  // Loading a single key costs more than leaving it static. Prefer the table
  // covering the most remaining keys, without changing any onchain indexes.
  const available=new Set(base.instructions.flatMap(ix=>ix.keys.map(key=>key.pubkey.toBase58())));
  available.delete(base.payerKey.toBase58());
  for(const ix of base.instructions){available.delete(ix.programId.toBase58());for(const key of ix.keys)if(key.isSigner)available.delete(key.pubkey.toBase58());}
  const remaining=[...new Map(tables.map(table=>[table.key.toBase58(),table])).values()],chosen=[];
  while(remaining.length){
    let best=-1,hits=[];
    for(let i=0;i<remaining.length;i++){const found=remaining[i].state.addresses.filter(key=>available.has(key.toBase58()));if(found.length>hits.length){best=i;hits=found;}}
    if(hits.length<2)break;
    chosen.push(remaining.splice(best,1)[0]);for(const key of hits)available.delete(key.toBase58());
  }
  return [[],tables,chosen].map(value=>base.compileToV0Message(value)).reduce((best,next)=>transactionSize(next)<transactionSize(best)?next:best);
}
function changedWalletMessageParts(expected, actual) {
  // Raw-layout diagnostics only; the separate semantic validator decides
  // whether the difference is a supported assertion suffix. Return fixed
  // categories, never transaction contents, addresses, or signatures.
  const parts=[],same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  if(expected.recentBlockhash!==actual.recentBlockhash)parts.push('blockhash');
  if(!same(expected.header,actual.header))parts.push('account permissions');
  if(!same(expected.staticAccountKeys.map(String),actual.staticAccountKeys.map(String)))parts.push('account layout');
  const lookups=message=>message.addressTableLookups.map(table=>[String(table.accountKey),Array.from(table.writableIndexes),Array.from(table.readonlyIndexes)]);
  if(!same(lookups(expected),lookups(actual)))parts.push('address lookups');
  const instruction=ix=>ix?[ix.programIdIndex,Array.from(ix.accountKeyIndexes),Array.from(ix.data)]:null;
  const changed=Array.from({length:Math.max(expected.compiledInstructions.length,actual.compiledInstructions.length)},(_,i)=>i).filter(i=>!same(instruction(expected.compiledInstructions[i]),instruction(actual.compiledInstructions[i])));
  if(changed.length){
    const computeOnly=changed.every(i=>[expected,actual].every(message=>message.staticAccountKeys[message.compiledInstructions[i]?.programIdIndex]?.equals(ComputeBudgetProgram.programId)));
    parts.push(computeOnly?'compute budget':'instructions');
  }
  return parts.length?parts.join(', '):'message encoding';
}
function validWalletSignature(message, signature, address) {
  try {
    const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),pk(address).toBuffer()]),format:'der',type:'spki'});
    return signature?.length===64&&verify(null,message,key,signature);
  } catch {return false;}
}
export function launchSimulationError(transaction,result,stage) {
  const failure=result.err?.InstructionError,index=failure?.[0],custom=failure?.[1]?.Custom;
  const instruction=Number.isSafeInteger(index)&&index>=0?transaction.message.compiledInstructions?.[index]:null;
  const program=instruction?transaction.message.staticAccountKeys?.[instruction.programIdIndex]?.toBase58():null;
  // SystemProgram custom 1 is ResultWithNegativeLamports. The same number
  // from a token, swap or other program has a different meaning.
  if(stage==='trade'&&program===SystemProgram.programId.toBase58()&&custom===1){
    return Object.assign(Error('Insufficient SOL to fund this trade and its token-account costs. Reduce the amount or add SOL, then review a fresh quote. Nothing was submitted.'),{code:'TRADE_INSUFFICIENT_SOL'});
  }
  // A direct System transfer/create failure is native SOL, not a quote-token
  // balance. Identify its actual debited wallet; it need not be the fee payer.
  // Do not interpret custom 1 from Token/Jupiter or an unresolved lookup key.
  const data=instruction?Buffer.from(instruction.data):null,systemDebit=program===SystemProgram.programId.toBase58()&&custom===1&&data?.length>=4&&[0,2,3,11].includes(data.readUInt32LE(0));
  const fundingWallet=result.err==='InsufficientFundsForFee'?transaction.message.staticAccountKeys?.[0]?.toBase58():systemDebit?transaction.message.staticAccountKeys?.[instruction.accountKeyIndexes?.[0]]?.toBase58():null;
  if(!stage&&fundingWallet){
    const shortfall=systemDebit?(result.logs||[]).map(line=>/^Transfer: insufficient lamports (\d{1,20}), need (\d{1,20})$/.exec(line)).find(match=>match&&BigInt(match[2])>BigInt(match[1])):null;
    const detail=shortfall?`Add at least ${displayUnits(BigInt(shortfall[2])-BigInt(shortfall[1]),9)} SOL for this fee-processing step.`:'Add SOL for transaction fees and account rent, then retry.';
    return Object.assign(Error(`Insufficient SOL in wallet ${fundingWallet}. ${detail} Nothing was submitted.`),{code:'REWARD_NATIVE_FUNDS',retryable:true,fundingWallet,...(shortfall?{fundingShortfallLamports:(BigInt(shortfall[2])-BigInt(shortfall[1])).toString()}: {})});
  }
  const ataFunding=!stage&&ataFundingSimulationFailure(transaction,result);
  if(ataFunding)return Object.assign(Error(`Insufficient SOL in wallet ${ataFunding.fundingWallet}. Add at least ${displayUnits(ataFunding.fundingShortfallLamports,9)} SOL for recipient token-account rent. Nothing was submitted.`),{code:'REWARD_NATIVE_FUNDS',retryable:true,...ataFunding});
  // Custom numbers are program-specific. A CPI can propagate its own 6001
  // through Jupiter, so require the runtime's original failure as well as the
  // actual top-level instruction. Missing/truncated logs remain unclassified.
  const original=(result.logs||[]).map(line=>/^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed: (.+)$/.exec(line)).find(Boolean);
  const originalCode=original&&/^custom program error: (0x[0-9a-f]+|\d+)$/i.exec(original[2]);
  const funding=['setup','quote-fund'].includes(stage);
  if(funding&&program===JUPITER&&custom===6001&&original?.[1]===JUPITER&&originalCode&&Number(originalCode[1])===6001){
    return Object.assign(Error('The pairing-asset swap moved beyond the 1% price limit. No swap was submitted.'),{code:'LAUNCH_FUNDING_SLIPPAGE',retryable:true});
  }
  const detail=(result.logs||[]).filter(line=>/Error Message:|Error:/.test(line)).at(-1)||'';
  const location=instruction?` during ${stage||'fee processing'} (instruction ${index}, program ${program||'unresolved'})`:'';
  return Error(`Onchain simulation failed${location}: ${JSON.stringify(result.err)}. ${detail}`.trim());
}
export function programIds(network) { ok(network === 'mainnet-beta','Launches use Solana mainnet.'); return ray; }
export function decodeRay(account, owner, layout, name) {
  ok(account?.owner.equals(owner), `${name} has the wrong program owner.`);
  ok(account.data.subarray(0,8).equals(createHash('sha256').update(`account:${name}`).digest().subarray(0,8)), `${name} discriminator mismatch.`);
  return layout.decode(account.data);
}
export function rayCurveAtTarget(config, quoteDecimals, quoteUsd, targetUsd='20000') {
  const supply=bn('1000000000000000'),sell=supply.muln(80).divn(100),price=units(quoteUsd,8),target=units(targetUsd,2)*1000000n;
  const curve=ray.Launchpad.getCurve(0),scale=10n**BigInt(quoteDecimals),m=BigInt(config.migrateFee.toString());
  const evaluate=q=>{const c=curve.getInitParam({supply,totalSell:sell,totalLockedAmount:zero(),totalFundRaising:bn(q),migrateFee:config.migrateFee});return{...c,usd:BigInt(supply.toString())*BigInt(c.b.toString())*price/(BigInt(c.a.toString())*scale)};};
  let low=BigInt(config.minFundRaisingB.toString()); if(low<=2n*m)low=2n*m+1n;
  ok(evaluate(low).usd<=target,`This pair currently needs a starting market cap of at least $${Math.ceil(Number(displayUnits(evaluate(low).usd,8))).toLocaleString('en-US')}. Choose another asset for this starting market cap.`);
  let high=low||1n;while(evaluate(high).usd<target){high*=2n;ok(high<18446744073709551615n,'The target curve exceeds onchain integer limits.');}
  while(low<high){const mid=(low+high)/2n;if(evaluate(mid).usd<target)low=mid+1n;else high=mid;}
  const result=evaluate(low);
  ok(result.usd-target<=target/2000n,'This quote is too coarse to represent the requested starting FDV.');
  ray.Launchpad.checkParam({supply,totalFundRaising:bn(low),totalSell:sell,totalLockedAmount:zero(),decimals:6,config,migrateType:'cpmm'});
  return {supply:supply.toString(),sell:sell.toString(),raise:low.toString(),virtualBase:result.a.toString(),virtualQuote:result.b.toString(),actualUsd:displayUnits(result.usd,8),graduationUsd:displayUnits(BigInt(supply.toString())*(low-m)*price/(BigInt(supply.sub(sell).toString())*scale),8)};
}
export function rayCurveForLaunch(config, quoteDecimals, quoteUsd, input) {
  // Already approved launches retain the original curve parameters. Never
  // infer a new policy from a version number, ticker, or current UI default.
  if (input.curvePolicy == null && input.graduationTargetUsd == null) return rayCurveAtTarget(config, quoteDecimals, quoteUsd, input.targetUsd);
  const terms = newLaunchCurvePolicy(input);
  ok([LAUNCH_CURVE_POLICY, LAUNCH_CURVE_POLICY_4K].includes(input.curvePolicy) && input.curvePolicy === terms.curvePolicy && input.graduationTargetUsd === terms.graduationTargetUsd, 'The launch curve policy is invalid. Prepare a new review.');
  return {...rayCurveAtGraduationTarget(config, quoteDecimals, quoteUsd, input.targetUsd, terms.graduationTargetUsd), ...terms};
}
export class LaunchChain {
  constructor({network,rpcUrl,connection,fetcher,rpcGate,rpcScope='',rpcRequestsPerSecond=8,jupiterKey='',sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
    rpcGate ||= processRpcGate;
    // Saved account settings use strings, while the shared RPC scheduler accepts
    // numbers only. Normalize once at the transport boundary, including older
    // accounts without a saved cap; never turn an invalid explicit cap into 8.
    const rawRate=rpcRequestsPerSecond==null||typeof rpcRequestsPerSecond==='string'&&!rpcRequestsPerSecond.trim()?8:rpcRequestsPerSecond;
    const validRateType=typeof rawRate==='number'||typeof rawRate==='string'&&/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(rawRate.trim());
    const rate=validRateType?Number(rawRate):NaN;
    ok(Number.isInteger(rate)&&rate>=1&&rate<=1000,'RPC requests per second must be a whole number from 1 to 1000. Update the RPC limit in Connections.');
    this.network=network;this.ids=programIds(network);this.jupiterKey=jupiterKey;this.sleep=sleep;this.rpcContext=new AsyncLocalStorage();const client=randomUUID();
    this.jupiterGate=rpcGate?.requests?{acquire:(config,signal,deadline)=>{const capacity=operatorCapacity(config);return rpcGate.requests.acquire('jupiter:'+requestKey(config,'jupiter'),client,requestInterval(config,'jupiter'),{signal,deadline,maxQueue:capacity.maxProviderQueue,requestDeadlineMs:capacity.requestDeadlineMs});},cooldown:(config,wait)=>rpcGate.requests.cooldown('jupiter:'+requestKey(config,'jupiter'),wait)}:localRequestGate('jupiter');
    if(connection){this.c=connection;this.fetcher=fetcher;}
    else {const url=publicEndpoint(rpcUrl||'https://api.mainnet-beta.solana.com').href,endpointHash=rpcEndpointHash(url),key=`rpc:${endpointHash}`,g=createPublicFetcher();this.close=()=>{rpcGate?.removeClient(client);g.close();};this.fetcher=g.fetcher;
      const rpcFetch=async(u,o={})=>{
        const capacity=operatorRpcOptions(endpointHash),context=this.rpcContext.getStore(),deadline=Math.min(Date.now()+capacity.requestDeadlineMs,context?.deadline??Infinity);
        ok(deadline>Date.now(),'RPC request deadline expired before submission.');
        const timeout=AbortSignal.timeout(Math.max(1,Math.ceil(Math.min(20000,deadline-Date.now())))),signal=o.signal?AbortSignal.any([o.signal,timeout]):timeout,call=JSON.parse(o.body||'{}');
        ok(!Array.isArray(call),'Batched RPC transport requires individual request admission.');
        await rpcGate.acquire(key,client,rate,{...capacity,method:call.method,signal,deadline});
        if(call.method==='sendTransaction')await context?.authorizeBeforeSend?.();
        signal.throwIfAborted();ok(Date.now()<deadline,'RPC request deadline expired before submission.');
        const result=await g.fetcher(u,{...o,signal});if(result.status===429)rpcGate.cooldown(key,Math.max(1000,(Number(result.headers.get('retry-after'))||1)*1000));return result;
      };
      this.c=new Connection(url,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:rpcFetch});}
  }
  withRpcContext(context,task){const previous=this.rpcContext.getStore();return this.rpcContext.run({...previous,...context,deadline:Math.min(previous?.deadline??Infinity,context?.deadline??Infinity)},task);}
  async init(){ok(await this.c.getGenesisHash()===GENESIS,'RPC network does not match the launch network. Nothing was submitted.');return this;}
  async mintInfo(address){const key=pk(address),info=await this.c.getAccountInfo(key);ok(info&&[TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>p.equals(info.owner)),'Quote mint was not found on this Solana network.');const mint=unpackMint(key,info,info.owner);ok(mint.isInitialized&&mint.decimals<=12,'Unsupported quote mint.');return{key,program:info.owner,mint,extensions:getExtensionTypes(mint.tlvData)};}
  async approvedQuotes() {
    const rows=await this.c.getProgramAccounts(this.ids.LAUNCHPAD_PROGRAM,{filters:[{dataSize:ray.LaunchpadConfig.span}]});
    ok(Array.isArray(rows)&&rows.length<=4096,'Invalid quote configuration list.');
    const mints=new Set(),seen=new Set();
    for(const row of rows){
      ok(row?.pubkey&&row.account&&!row.account.executable&&Buffer.isBuffer(row.account.data)&&row.account.data.length===ray.LaunchpadConfig.span,'Invalid quote configuration account.');
      const config=decodeRay(row.account,this.ids.LAUNCHPAD_PROGRAM,ray.LaunchpadConfig,'GlobalConfig');
      const expected=ray.getPdaLaunchpadConfigId(this.ids.LAUNCHPAD_PROGRAM,config.mintB,config.curveType,config.index).publicKey;
      ok(expected.equals(row.pubkey)&&!seen.has(expected.toBase58())&&!config.mintB.equals(PublicKey.default),'Quote configuration address mismatch.');
      seen.add(expected.toBase58());
      if(config.curveType===0)mints.add(config.mintB.toBase58());
    }
    return [...mints];
  }
  async referencePrice(input, mint) {
    return readQuoteReference({fetcher:this.fetcher,jupiterGate:this.jupiterGate,jupiterKey:this.jupiterKey},input,mint);
  }
  async fundingEstimate(input,quoteInfo) {
    const sizes=[ray.PlatformConfig.span,ray.LaunchpadPool.span,input.taxBps?1024:82,165,165,...(input.taxBps?[]:[679])];
    const rents=new Map(await Promise.all([...new Set([...sizes,...(input.walletMode==='external'?[0]:[])])].map(async size=>[size,BigInt(await this.c.getMinimumBalanceForRentExemption(size))])));
    const rent=sizes.reduce((n,size)=>n+rents.get(size),0n);
    // Include a margin for rent/priority fees plus an initial automation reserve.
    let serviceReserve=input.feeMode==='creator'&&input.feeCustody!=='relay'?0n:10000000n;
    if(input.feeMode==='holders'){
      const quote=quoteInfo||await this.mintInfo(input.quoteMint),baseSize=input.taxBps?getAccountLen([ExtensionType.TransferFeeAmount,ExtensionType.ImmutableOwner]):ACCOUNT_SIZE,quoteSize=associatedTokenAccountSize(quote);
      for(const size of new Set([baseSize,quoteSize]))if(!rents.has(size)){const value=await this.c.getMinimumBalanceForRentExemption(size);ok(Number.isSafeInteger(value)&&value>=0,'The rewards account rent estimate is invalid.');rents.set(size,BigInt(value));}
      // Two independent 0.01 SOL reserves, actual reward ATA rents and a
      // network-cost margin are included in the reviewed first-launch budget.
      serviceReserve=20000000n+rents.get(baseSize)+rents.get(quoteSize)+1000000n;
    }
    return {minimumSol:displayUnits((rent*120n+99n)/100n+1000000n+serviceReserve+units(input.protocolFees?.creationFeeSol||'0')),platformRent:rents.get(ray.PlatformConfig.span).toString(),serviceReserve:serviceReserve.toString(),...(input.walletMode==='external'?{storageWalletRent:rents.get(0).toString()}: {})};
  }
  async preview(input){
    ok(input.route==='raydium'&&input.network==='mainnet-beta','Launches use Raydium on Solana mainnet.');
    const q=await this.mintInfo(input.quoteMint),quoteDecimals=q.mint.decimals;
    const program=this.ids.LAUNCHPAD_PROGRAM;
    const rows=await this.c.getProgramAccounts(program,{filters:[{dataSize:ray.LaunchpadConfig.span},{memcmp:{offset:ray.LaunchpadConfig.offsetOf('mintB'),bytes:q.key.toBase58()}}]});
    const configs=rows.map(x=>({key:x.pubkey,config:decodeRay(x.account,program,ray.LaunchpadConfig,'GlobalConfig')})).filter(x=>x.config.curveType===0).sort((a,b)=>a.config.index-b.config.index);
    ok(configs.length,'Raydium does not support this asset for bonding-curve launches yet. Choose an available pairing asset.');
    const [price,funding]=await Promise.all([this.referencePrice(input,q),this.fundingEstimate(input,q)]);
    const common={quoteProgram:q.program.toBase58(),quoteDecimals,price,quoteFreezeAuthority:q.mint.freezeAuthority?.toBase58()||null,...funding,targetUsd:input.targetUsd};
    const accepted=new Set([ExtensionType.MetadataPointer,ExtensionType.TokenMetadata,ExtensionType.TransferFeeConfig,ExtensionType.InterestBearingConfig,ExtensionType.ScaledUiAmountConfig]);
    if(q.extensions.some(x=>!accepted.has(x))){const support=ray.getPdaMintExAccountCp(this.ids.CREATE_CPMM_POOL_PROGRAM,q.key).publicKey;const registry=await this.c.getAccountInfo(support);ok(registry?.owner.equals(this.ids.CREATE_CPMM_POOL_PROGRAM),'This quote cannot migrate to Raydium CPMM: its Token-2022 extensions are not registered.');}
    const cps=await this.c.getProgramAccounts(this.ids.CREATE_CPMM_POOL_PROGRAM,{filters:[{dataSize:ray.CpmmConfigInfoLayout.span}]});
    const cp=cps.map(x=>({key:x.pubkey,c:decodeRay(x.account,this.ids.CREATE_CPMM_POOL_PROGRAM,ray.CpmmConfigInfoLayout,'AmmConfig')})).filter(x=>!x.c.disableCreatePool&&x.c.creatorFeeRate.gtn(0)).sort((a,b)=>a.c.tradeFeeRate.add(a.c.creatorFeeRate).cmp(b.c.tradeFeeRate.add(b.c.creatorFeeRate)))[0];
    ok(cp,'No active Raydium migration fee tier with creator rewards is available on this network.');
    let selected,lastError;for(const x of configs){try{selected={...x,curve:rayCurveForLaunch(x.config,quoteDecimals,price.usd,input)};break;}catch(e){lastError=e;}}
    if(!selected)throw lastError;
    let creatorFeeRatePpm=input.creatorFeeBps*100,creatorFeePolicy;
    if(input.creatorFeePolicy===CREATOR_FEE_POLICY){creatorFeeRatePpm=CREATOR_FEE_RATE_PPM;creatorFeePolicy=CREATOR_FEE_POLICY;}
    else if(input.creatorFeePolicy===HOLDER_CREATOR_FEE_POLICY){const target=creatorFeeForLaunch(input);ok(target.policy===HOLDER_CREATOR_FEE_POLICY&&input.creatorFeeBps===0,'The zero creator fee applies only to taxed holder-reward launches.');creatorFeeRatePpm=target.ratePpm;creatorFeePolicy=target.policy;}
    ok(validCreatorFeeRate(creatorFeeRatePpm),'The creator fee exceeds the supported curve limit.');
    const review={...common,...selected.curve,platformFeeBps:input.protocolFees?.curveFeeBps||0,protocolFees:input.protocolFees||null,configId:selected.key.toBase58(),cpConfigId:cp.key.toBase58(),protocolFeeRate:selected.config.tradeFeeRate.toString(),protocolFeeBps:Number(selected.config.tradeFeeRate.toString())/100,creatorFeeBps:input.creatorFeeBps,migrationFee:displayUnits(selected.config.migrateFee.toString(),quoteDecimals),postGradTradeBps:Number(cp.c.tradeFeeRate.toString())/100,postGradCreatorBps:Number(cp.c.creatorFeeRate.toString())/100,postGradCreatorProtocolShare:Number(cp.c.creatorFeeShareRate.toString())/10000,lp:'100% of migration LP is burned; creator fees remain separately claimable',warnings:['USD valuation uses the displayed price reference and moves with the quote asset.','Graduation is performed by Raydium’s configured migration authority.',...(input.taxBps?['Transfer tax applies to every token transfer. Launchpad collects tax tokens when the onchain withdrawal authority permits, then sells them: 5% of realized tax proceeds goes to Launchpad and 95% funds holder rewards. '+(creatorFeeRatePpm?'Creator trading fees can also fund holder rewards during the curve.':'No creator trading fee is added on this bonding curve; the selected CPMM creator-fee tier still applies after graduation.')+' The onchain authorities determine collection availability.']:[])]};
    review.creatorFeeRatePpm=creatorFeeRatePpm;review.creatorFeeBps=creatorFeeRatePpm/100;if(creatorFeePolicy)review.creatorFeePolicy=creatorFeePolicy;
    review.lp=protocolLiquidityTerms(review.protocolFees).description;
    review.devBuy=await this.devBuyEstimate(input,review,q);
    review.minimumSol=displayUnits(units(review.minimumSol)+BigInt(review.devBuy.solBudget));
    return review;
  }
  async developerQuoteBudget(input,amount) {
    const signal=AbortSignal.timeout(15000),config={jupiterKey:this.jupiterKey};
    await this.jupiterGate.acquire(config,signal,Date.now()+15000);
    const query=new URLSearchParams({inputMint:SOL_MINT,outputMint:input.quoteMint,amount:String(amount),swapMode:'ExactIn',slippageBps:'100',maxAccounts:'32'});
    const response=await this.fetcher('https://api.jup.ag/swap/v1/quote?'+query,{headers:this.jupiterKey?{'x-api-key':this.jupiterKey}:{},signal});
    if(response.status===429)this.jupiterGate.cooldown(config,Math.max(1000,(Number(response.headers.get('retry-after'))||1)*1000));
    ok(response.ok,'The developer-buy SOL conversion is unavailable. Check your Jupiter connection or try another paired asset.');
    const q=await response.json();
    ok(q.inputMint===SOL_MINT&&q.outputMint===input.quoteMint&&String(q.inAmount)===String(amount)&&q.swapMode==='ExactIn'&&/^[1-9]\d*$/.test(q.otherAmountThreshold)&&/^[1-9]\d*$/.test(q.outAmount)&&BigInt(q.otherAmountThreshold)<=BigInt(q.outAmount)&&Number.isInteger(q.slippageBps)&&q.slippageBps<=100&&Number.isFinite(Number(q.priceImpactPct))&&Math.abs(Number(q.priceImpactPct))<=.02&&q.routePlan?.length,'The developer-buy conversion does not match your SOL budget. Choose another paired asset or try again.');
    return BigInt(q.otherAmountThreshold);
  }
  async devBuyEstimate(input,review,quote) {
    const solMode=input.devBuyMode==='sol',solBudget=solMode?BigInt(input.devBuyLamports||'0'):0n,legacyGross=BigInt(input.devBuyRaw||'0');
    ok(legacyGross>=0n&&legacyGross<=100000000000000n,'Developer buys cannot exceed 100 million tokens.');
    if(solMode?solBudget===0n:legacyGross===0n)return{gross:'0',net:'0',maxQuote:'0',solBudget:'0'};
    const poolInfo={virtualA:bn(review.virtualBase),virtualB:bn(review.virtualQuote),realA:zero(),realB:zero()},quoteFee=getTransferFeeConfig(quote.mint);
    const activeFee=quoteFee?getEpochFee(quoteFee,BigInt((await this.c.getEpochInfo()).epoch)):null;
    if(activeFee)ok(activeFee.transferFeeBasisPoints<10000,'This pairing asset has an unsupported transfer fee.');
    const quoteCost=gross=>{
      // Price the gross curve debit directly: the SDK exact-out convenience
      // helper applies the base transfer fee twice in the pinned SDK version.
      const curveCost=ray.Launchpad.getCurve(0).buyExactOut({poolInfo,amount:bn(gross)});
      const vaultCost=ray.Launchpad.calculatePreFee({postFeeAmount:curveCost,feeRate:bn(BigInt(review.protocolFeeRate||String(Math.round(review.protocolFeeBps*100)))+BigInt(review.creatorFeeRatePpm??input.creatorFeeBps*100)+BigInt((review.platformFeeBps||0)*100))});
      let amount=BigInt(vaultCost.toString());
      if(activeFee){const extra=(amount*BigInt(activeFee.transferFeeBasisPoints)+BigInt(9999-activeFee.transferFeeBasisPoints))/BigInt(10000-activeFee.transferFeeBasisPoints);amount+=extra<activeFee.maximumFee?extra:activeFee.maximumFee;}
      return amount;
    };
    let result;
    if(solMode){
      let quoteBudget=solBudget,drift={};
      if(input.quoteMint!==SOL_MINT){
        // The reviewed pair budget is the route's guaranteed output less the drift allowance, so the purchase still
        // covers the reviewed minimum after a move of up to that much; the rest of what the swap buys stays in the wallet.
        const routeMinimum=await this.developerQuoteBudget(input,solBudget);
        quoteBudget=routeMinimum*(10000n-PAIR_FUNDING_DRIFT_BPS)/10000n;
        ok(quoteBudget>0n,'The developer-buy SOL amount is too small for this pair. Increase the SOL amount.');
        drift={routeMinimumQuote:routeMinimum.toString(),quoteDriftBps:Number(PAIR_FUNDING_DRIFT_BPS)};
        // A connected wallet signs the purchase itself: refuse now, before anything is paid, a pair whose every route needs instruction introspection.
        if(input.walletMode==='external'&&typeof input.externalWallet==='string'&&input.externalWallet){const route=await this.pairFundingRoute({quoteMint:input.quoteMint,lamports:solBudget,taker:input.externalWallet});ok(!route.introspection,pairFundingIntrospectionText(quoteLabel(input.quoteMint),'review'));}
      }
      try{result={...invertDeveloperBudget({quoteBudget,quoteCost,taxBps:input.taxBps}),solBudget:solBudget.toString(),...drift};}
      catch(error){if(input.quoteMint===SOL_MINT&&error.code==='DEV_BUY_SUPPLY_CAP')error.message=`This developer buy exceeds 10% of supply (100 million tokens). Use at most ${displayUnits(error.maxQuoteBudget)} SOL for this launch.`;throw error;}
    }else{
      const maxQuote=(quoteCost(legacyGross)*101n+99n)/100n;
      let amount=maxQuote;
      if(input.quoteMint!==SOL_MINT){const native=await this.mintInfo(SOL_MINT),solPrice=await this.referencePrice({quoteMint:SOL_MINT},native);amount=(maxQuote*units(review.price.usd,8)*1000000000n*105n+10n**BigInt(review.quoteDecimals)*units(solPrice.usd,8)*100n-1n)/(10n**BigInt(review.quoteDecimals)*units(solPrice.usd,8)*100n);}
      result={gross:legacyGross.toString(),net:(legacyGross-(legacyGross*BigInt(input.taxBps)+9999n)/10000n).toString(),maxQuote:maxQuote.toString(),solBudget:amount.toString()};
    }
    // Rent and transaction fees are separate from the developer-buy spend cap.
    review.minimumSol=displayUnits(units(review.minimumSol)+6000000n);
    return result;
  }
  addresses(launch){const w=pk(launch.keys.wallet.address),p=pk((launch.keys.payer||launch.keys.wallet).address),admin=pk((launch.keys.platform||launch.keys.wallet).address),m=pk(launch.keys.mint.address),q=pk(launch.input.quoteMint),program=this.ids.LAUNCHPAD_PROGRAM;return{w,p,admin,m,q,program,platform:ray.getPdaPlatformId(program,admin).publicKey,pool:ray.getPdaLaunchpadPoolId(program,m,q).publicKey,auth:ray.getPdaLaunchpadAuth(program).publicKey};}
  async marketSnapshot(launch, options = {}) { return readLaunchMarketSnapshot({connection:this.c,addresses:this.addresses(launch),ray,decodeRay,referencePrice:(input,mint)=>this.referencePrice(input,mint)},launch,options); }
  async verifyCreatorFeeUpdate(launch,decision,receiptSlot){
    ok(validCreatorFeeRate(decision?.ratePpm)&&typeof decision.platformHash==='string'&&/^[a-f0-9]{64}$/.test(decision.platformHash)&&Number.isSafeInteger(receiptSlot)&&receiptSlot>0,'The creator fee receipt evidence is invalid.');
    const {platform,program}=this.addresses(launch),minimum=Math.max(receiptSlot,decision.platformSlot||0);
    const result=await this.c.getAccountInfoAndContext(platform,{commitment:'finalized',minContextSlot:minimum});
    ok(Number.isSafeInteger(result?.context?.slot)&&result.context.slot>=minimum&&result.value&&!result.value.executable,'The RPC has not confirmed the creator fee update.');
    const state=decodeRay(result.value,program,ray.PlatformConfig,'PlatformConfig');
    ok(state.creatorFeeRate.eqn(decision.ratePpm)&&platformFeeHash(state)===decision.platformHash,'The confirmed creator fee or other platform settings differ from the signed update.');
    return true;
  }
  async preflightLaunch(launch){
    const r=launch.review,i=launch.input,program=this.ids.LAUNCHPAD_PROGRAM;
    const [configAccount,cpAccount]=await Promise.all([this.c.getAccountInfo(pk(r.configId)),this.c.getAccountInfo(pk(r.cpConfigId))]);
    const config=decodeRay(configAccount,program,ray.LaunchpadConfig,'GlobalConfig'),cp=decodeRay(cpAccount,this.ids.CREATE_CPMM_POOL_PROGRAM,ray.CpmmConfigInfoLayout,'AmmConfig');
    ok(config.mintB.toBase58()===i.quoteMint&&config.curveType===0&&Number(config.tradeFeeRate.toString())/100===r.protocolFeeBps&&!cp.disableCreatePool&&Number(cp.tradeFeeRate.toString())/100===r.postGradTradeBps&&Number(cp.creatorFeeRate.toString())/100===r.postGradCreatorBps,'Raydium changed this pair’s launch terms. No token was created. Start a new review.');
    const curve=rayCurveForLaunch(config,r.quoteDecimals,r.price.usd,i);
    ok(curve.curvePolicy===r.curvePolicy&&curve.graduationTargetUsd===r.graduationTargetUsd,'The bonding-curve policy differs from the reviewed launch. Prepare a new review.');
    ok(['raise','supply','sell','virtualBase','virtualQuote'].every(k=>curve[k]===r[k]),'The bonding-curve configuration changed after review. No token was created.');
  }
  async platformBrandUpdateInstructions(launch,decision){
    const target=decision?.target;
    ok(validPlatformBrandTarget(target),'Invalid platform branding.');
    const {admin,w,m,q,pool,platform,program}=this.addresses(launch),snapshot=await this.c.getMultipleAccountsInfoAndContext([pool,platform],{commitment:'finalized'});
    ok(Number.isSafeInteger(snapshot?.context?.slot)&&snapshot.context.slot>0&&Array.isArray(snapshot.value)&&snapshot.value.length===2&&!snapshot.value.some(account=>!account||account.executable),'The platform branding snapshot could not be verified.');
    const curve=decodeRay(snapshot.value[0],program,ray.LaunchpadPool,'PoolState'),state=decodeRay(snapshot.value[1],program,ray.PlatformConfig,'PlatformConfig');
    ok(curve.creator.equals(w)&&curve.mintA.equals(m)&&curve.mintB.equals(q)&&curve.platformId.equals(platform)&&curve.configId.toBase58()===launch.review.configId,'The platform belongs to a different launch.');
    decision.platformHash=platformBrandHash(state);decision.platformSlot=snapshot.context.slot;
    return [ray.updatePlatformConfig(program,admin,platform,{type:'updateName',value:target.name}),ray.updatePlatformConfig(program,admin,platform,{type:'updateWeb',value:target.web}),ray.updatePlatformConfig(program,admin,platform,{type:'updateImg',value:target.img})];
  }
  async verifyPlatformBrandUpdate(launch,decision,receiptSlot){
    ok(Number.isSafeInteger(receiptSlot)&&receiptSlot>0&&/^[a-f0-9]{64}$/.test(decision?.platformHash||''),'The platform branding receipt evidence is invalid.');
    const {platform,program}=this.addresses(launch),minimum=Math.max(receiptSlot,decision.platformSlot||0),snapshot=await this.c.getAccountInfoAndContext(platform,{commitment:'finalized',minContextSlot:minimum});
    ok(Number.isSafeInteger(snapshot?.context?.slot)&&snapshot.context.slot>=minimum&&snapshot.value&&!snapshot.value.executable,'The RPC has not confirmed the platform branding update.');
    const state=decodeRay(snapshot.value,program,ray.PlatformConfig,'PlatformConfig');
    ok(platformText(state.name)===decision.target.name&&platformText(state.web)===decision.target.web&&platformText(state.img)===decision.target.img&&platformBrandHash(state)===decision.platformHash,'The confirmed platform branding or financial settings differ from the signed update.');
    return true;
  }
  async externalNativeFundingAddress(launch) {
    const payer=launch.keys.payer||launch.keys.wallet;
    ok(payer.external===true&&launch.input.quoteMint===SOL_MINT,'No connected-wallet SOL setup is needed.');
    // The launch mint is unique and persisted with the draft. Rebuilding an
    // expired unsigned setup reuses this address rather than creating another.
    return PublicKey.createWithSeed(pk(payer.address),launch.keys.mint.address.slice(0,32),TOKEN_PROGRAM_ID);
  }
  /**
   * One Jupiter build of the SOL → pair-asset purchase for `lamports`, checked like the reviewed purchase (exact
   * input, Jupiter's swap instruction, no tip, 1% slippage, 2% impact, the taker as the only signer). Reports whether
   * the route reads the Instructions sysvar (in an instruction or in one of its lookup tables) and which DEXes it uses.
   */
  async buildPairFunding({quoteMint,lamports,taker,excludeDexes=[],maxAccounts=32}){
    return this.buildJupiterSwap({inputMint:SOL_MINT,outputMint:quoteMint,amount:lamports,taker,excludeDexes,maxAccounts,texts:{unavailable:'The pairing asset could not be purchased. Check your Jupiter connection or try again.',differs:'The funding route differs from the reviewed purchase.',moved:'The pairing-asset price moved too far. Nothing was swapped; review a new launch or retry when the price returns.'}});
  }
  /** One guarded Jupiter swap (v2 build, ExactIn, 1% slippage, at most 2% impact, no foreign signers, no tip) for `taker` to sign; the launch funding purchase and the payout gas sale (v71.37) both go through it. */
  async buildJupiterSwap({inputMint,outputMint,amount,taker,excludeDexes=[],maxAccounts=32,texts={}}){
    const unavailable=texts.unavailable||'The swap could not be built. Check your Jupiter connection or try again.',differs=texts.differs||'The swap route differs from the request.',moved=texts.moved||'The price moved too far. Nothing was swapped.';
    const signal=AbortSignal.timeout(15000),config={jupiterKey:this.jupiterKey};
    await this.jupiterGate.acquire(config,signal,Date.now()+15000);
    const query=new URLSearchParams({inputMint,outputMint,amount:String(amount),taker,slippageBps:'100',mode:'fast',maxAccounts:String(maxAccounts),wrapAndUnwrapSol:'true',...(excludeDexes.length?{excludeDexes:excludeDexes.join(',')}:{})});
    const response=await this.fetcher('https://api.jup.ag/swap/v2/build?'+query,{headers:this.jupiterKey?{'x-api-key':this.jupiterKey}:{},signal});
    if(response.status===429)this.jupiterGate.cooldown(config,Math.max(1000,(Number(response.headers.get('retry-after'))||1)*1000));
    ok(response.ok,unavailable);const b=await response.json();
    ok(b.inputMint===inputMint&&b.outputMint===outputMint&&String(b.inAmount)===String(amount)&&(!b.swapMode||b.swapMode==='ExactIn')&&b.swapInstruction?.programId===JUPITER&&!b.tipInstruction,differs);
    ok(Number.isInteger(b.slippageBps)&&b.slippageBps>=0&&b.slippageBps<=100&&/^[1-9]\d*$/.test(String(b.otherAmountThreshold||''))&&Number.isFinite(Number(b.priceImpactPct))&&Math.abs(Number(b.priceImpactPct))<=.02,moved);
    const ixs=[...(b.setupInstructions||[]),b.swapInstruction,...(b.cleanupInstruction?[b.cleanupInstruction]:[]),...(b.otherInstructions||[])].map(ix=>new TransactionInstruction({programId:pk(ix.programId),keys:ix.accounts.map(a=>({pubkey:pk(a.pubkey),isSigner:a.isSigner,isWritable:a.isWritable})),data:Buffer.from(ix.data,'base64')}));
    ok(ixs.every(ix=>ix.keys.every(a=>!a.isSigner||a.pubkey.toBase58()===taker)),'Unexpected signer in the funding route.');
    const tables=b.addressesByLookupTableAddress&&typeof b.addressesByLookupTableAddress==='object'?b.addressesByLookupTableAddress:{};
    const introspection=ixs.some(ix=>ix.programId.toBase58()===INSTRUCTIONS_SYSVAR||ix.keys.some(a=>a.pubkey.toBase58()===INSTRUCTIONS_SYSVAR))||Object.values(tables).some(list=>Array.isArray(list)&&list.includes(INSTRUCTIONS_SYSVAR));
    const dexes=[...new Set((Array.isArray(b.routePlan)?b.routePlan:[]).map(step=>step?.swapInfo?.label).filter(label=>typeof label==='string'&&label.length>0&&label.length<=64))];
    return{b,ixs,introspection,dexes,tableKeys:Object.keys(tables)};
  }
  /**
   * Payout gas (v71.37): how many raw units of the pair asset the rewards wallet must sell for `lamports` of SOL, from a live
   * Jupiter quote (an exact-out quote when the route offers one, otherwise a one-token exact-in sample). Pure pricing: nothing
   * is built or signed here.
   */
  async payoutGasSaleAmount(launch,lamports){
    const quoteMint=launch.input.quoteMint;ok(quoteMint!==SOL_MINT&&BigInt(lamports)>0n,'A payout gas sale needs a pair asset other than SOL.');
    const signal=AbortSignal.timeout(15000),config={jupiterKey:this.jupiterKey},headers=this.jupiterKey?{'x-api-key':this.jupiterKey}:{};
    const quote=async params=>{await this.jupiterGate.acquire(config,signal,Date.now()+15000);const url=new URL('https://api.jup.ag/swap/v1/quote');url.search=new URLSearchParams({inputMint:quoteMint,outputMint:SOL_MINT,slippageBps:'100',...params});const response=await this.fetcher(url.href,{headers,signal});if(response.status===429)this.jupiterGate.cooldown(config,Math.max(1000,(Number(response.headers.get('retry-after'))||1)*1000));if(!response.ok)return null;const q=await response.json();return q&&q.inputMint===quoteMint&&q.outputMint===SOL_MINT&&/^[1-9]\d*$/.test(String(q.inAmount||''))&&/^[1-9]\d*$/.test(String(q.outAmount||''))&&Number.isFinite(Number(q.priceImpactPct))&&Math.abs(Number(q.priceImpactPct))<=.02?q:null;};
    const exact=await quote({amount:String(lamports),swapMode:'ExactOut'});
    if(exact&&BigInt(exact.outAmount)>=BigInt(lamports))return BigInt(exact.inAmount);
    const sample=10n**BigInt(launch.review.quoteDecimals),probe=await quote({amount:sample.toString(),swapMode:'ExactIn'});
    if(!probe)throw Object.assign(Error('The pair asset has no SOL route right now; the holder payout will be retried.'),{code:'REWARD_MARKET_WAIT',retryable:true});
    const units=(BigInt(lamports)*sample+BigInt(probe.outAmount)-1n)/BigInt(probe.outAmount);ok(units>0n,'Invalid payout gas sale size.');return units;
  }
  /**
   * Payout gas (v71.37): the SOL this cycle's unpaid recipients will cost the rewards wallet — rent for every recipient that has no
   * token account for the pair asset yet (read on chain, 100 accounts a call) plus a fee allowance per payout batch. A read only.
   */
  async payoutRecipientRentLamports(launch,rows,{batchSize=3,feePerBatch=50000n}={}){
    const quoteMint=launch.input.quoteMint;ok(quoteMint!==SOL_MINT&&Array.isArray(rows),'Recipient rent applies to a pair asset other than SOL.');
    const q=pk(quoteMint),program=pk(launch.review.quoteProgram),owners=[...new Set(rows.map(row=>row.owner))].map(owner=>pk(owner)).filter(owner=>PublicKey.isOnCurve(owner.toBytes()));
    const accounts=owners.map(owner=>getAssociatedTokenAddressSync(q,owner,false,program));let missing=0;
    for(let i=0;i<accounts.length;i+=100){const infos=await this.c.getMultipleAccountsInfo(accounts.slice(i,i+100),{commitment:'confirmed'});ok(Array.isArray(infos)&&infos.length===Math.min(100,accounts.length-i),'The recipient account snapshot is incomplete.');for(const info of infos)if(!info)missing++;}
    const rent=missing?BigInt(await this.c.getMinimumBalanceForRentExemption(associatedTokenAccountSize(await this.mintInfo(quoteMint)))):0n;
    const batches=BigInt(Math.ceil(rows.length/batchSize));
    return {recipients:owners.length,missing,rentLamports:(rent*BigInt(missing)).toString(),lamports:(rent*BigInt(missing)+batches*feePerBatch).toString()};
  }
  /**
   * Payout gas (v71.37): the swap that sells `amount` raw units of the pair asset from the dedicated rewards wallet for SOL, signed
   * by that wallet, under the same guards as the launch funding purchase. `operation.payoutGas.shortfallLamports` is the SOL the
   * payout simulation said was missing; a route whose worst-case output does not cover it is refused before anything is signed.
   */
  async payoutGasSaleInstructions(launch,amount,{operation}={}){
    const quoteMint=launch.input.quoteMint;ok(quoteMint!==SOL_MINT&&launch.input.feeMode==='holders'&&BigInt(amount)>0n,'A payout gas sale needs a holder-rewards launch on a pair asset other than SOL.');
    const selection=rewardsWalletSelection(launch,{operation:operation??{},kind:'gas-sell'});ok(selection.source==='rewards'&&selection.signerSource==='rewards','A payout gas sale sells from the dedicated rewards wallet only.');
    const taker=rewardsWalletKey(launch,selection,{signer:true}).address;
    const route=await this.buildJupiterSwap({inputMint:quoteMint,outputMint:SOL_MINT,amount,taker,texts:{unavailable:'The rewards could not be sold for network fees. Check your Jupiter connection or try again.',differs:'The payout gas sale route differs from the request.',moved:'The pair asset price moved too far for the payout gas sale. Nothing was swapped.'}});
    const shortfall=BigInt(operation?.payoutGas?.shortfallLamports||'0');
    if(shortfall>0n&&BigInt(route.b.otherAmountThreshold)<shortfall)throw Object.assign(Error('The payout gas sale would not cover the missing SOL at the current price; it will be sized again on the next pass.'),{code:'REWARD_MARKET_WAIT',retryable:true});
    const result=route.ixs.filter(ix=>!ix.programId.equals(ComputeBudgetProgram.programId));
    ok(route.tableKeys.length<=20,'The payout gas sale route returned too many address lookup tables.');
    if(route.tableKeys.length)result.lookupTables=await this.lookupTables(route.tableKeys);
    result.payoutGas={expectedLamports:String(route.b.outAmount),minimumLamports:String(route.b.otherAmountThreshold),dexes:route.dexes};
    return result;
  }
  /** The purchase route a connected wallet may sign: when the first route reads the instruction list, one retry without that route's DEXes. */
  async pairFundingRoute({quoteMint,lamports,taker,maxAccounts}){
    const first=await this.buildPairFunding({quoteMint,lamports,taker,maxAccounts});
    if(!first.introspection||!first.dexes.length)return first;
    try{const again=await this.buildPairFunding({quoteMint,lamports,taker,maxAccounts,excludeDexes:first.dexes});return{...again,excludedDexes:first.dexes};}
    catch{return first;}
  }
  async quoteFundingInstructions(launch,{maxAccounts=32}={}) {
    const {p,q}=this.addresses(launch),d=launch.review.devBuy;
    ok(BigInt(d?.solBudget||0)>0n,'No pairing-asset purchase is needed.');
    if(launch.input.quoteMint===SOL_MINT){
      const address=await this.externalNativeFundingAddress(launch),rent=BigInt(await this.c.getMinimumBalanceForRentExemption(ACCOUNT_SIZE)),amount=BigInt(d.maxQuote);
      ok(amount>0n&&amount<=BigInt(d.solBudget)&&rent+amount<=BigInt(Number.MAX_SAFE_INTEGER),'Invalid developer-buy funding amount.');
      return [SystemProgram.createAccountWithSeed({fromPubkey:p,basePubkey:p,seed:launch.keys.mint.address.slice(0,32),newAccountPubkey:address,lamports:Number(rent+amount),space:ACCOUNT_SIZE,programId:TOKEN_PROGRAM_ID}),createInitializeAccount3Instruction(address,q,p)];
    }
    const external=(launch.keys.payer||launch.keys.wallet).external===true,taker=p.toBase58();
    const route=external?await this.pairFundingRoute({quoteMint:launch.input.quoteMint,lamports:d.solBudget,taker,maxAccounts}):await this.buildPairFunding({quoteMint:launch.input.quoteMint,lamports:d.solBudget,taker,maxAccounts});
    // Nothing is prepared for a wallet signature on a route the wallet guard could never accept; Launchpad-managed payers sign unchanged.
    if(external&&route.introspection)throw Object.assign(Error(pairFundingIntrospectionText(quoteLabel(launch.input.quoteMint),'purchase')),{code:'LAUNCH_FUNDING_INTROSPECTION',retryable:true});
    if(BigInt(route.b.otherAmountThreshold)<BigInt(d.maxQuote))throw Object.assign(Error('The pairing-asset quote is outside your reviewed budget. No swap was submitted.'),{code:'LAUNCH_FUNDING_PRICE_MOVED',retryable:true});
    const result=route.ixs.filter(ix=>!ix.programId.equals(ComputeBudgetProgram.programId));
    ok(route.tableKeys.length<=20,'The funding route returned too many address lookup tables.');
    if(route.tableKeys.length)result.lookupTables=await this.lookupTables(route.tableKeys);
    return result;
  }
  async launchInstructions(launch,stage){
    const {input:i,review:r}=launch,{w,p,admin,m,q,program,platform,pool,auth}=this.addresses(launch);
    ok(i.route==='raydium'&&i.network==='mainnet-beta','This launch is archived.');
    if(stage==='setup'||stage==='launch-all'){
      ok(compactPlan(launch)&&(launch.keys.payer||launch.keys.wallet).external===true,'Invalid compact launch step.');
      const buy=BigInt(r.devBuy?.gross||0)>0n,paid=BigInt(launch.storage?.budget||0)>0n;
      if(stage==='launch-all'){
        ok(!buy&&!paid,'This launch needs its reviewed setup transaction first.');
        return [...await this.launchInstructions(launch,'platform'),...await this.launchInstructions(launch,'create')];
      }
      const setup=launch.executionPlan==='compact-v3'
        ?[SystemProgram.transfer({fromPubkey:p,toPubkey:admin,lamports:this.platformFundingAmount(launch)})]
        :[...(paid?await this.launchInstructions(launch,'storage-credit'):[]),...await this.launchInstructions(launch,'platform')];
      let sizeError;
      for(const maxAccounts of buy&&i.quoteMint!==SOL_MINT?[32,24,16]:[32]){
        const funding=buy?await this.quoteFundingInstructions(launch,{maxAccounts}):[],instructions=[...setup,...funding];
        if(funding.lookupTables)instructions.lookupTables=funding.lookupTables;
        if(!buy||i.quoteMint===SOL_MINT)return instructions;
        try{await this.walletMessage(p,SystemProgram.programId.toBase58(),instructions,1400000,'launch setup');return instructions;}
        catch(error){if(error.code!=='LAUNCH_TRANSACTION_TOO_LARGE')throw error;sizeError=error;}
      }
      throw sizeError;
    }
    if(stage==='quote-fund')return this.quoteFundingInstructions(launch);
    if(stage==='storage-credit'||stage==='storage-fund'){
      ok(launch.storage?.provider==='irys'&&BigInt(launch.storage.budget)>0n&&BigInt(launch.storage.budget)<=5000000n,'Invalid image-storage payment.');
      const external=(launch.keys.payer||launch.keys.wallet).external===true;
      if(stage==='storage-credit'){
        ok(external&&launch.keys.platform?.secret&&!admin.equals(p),'Invalid image-storage funding wallet.');
        ok(typeof r.storageWalletRent==='string'&&/^[1-9]\d*$/.test(r.storageWalletRent),'The image-storage wallet reserve is missing. Refresh the launch review.');
        return [SystemProgram.transfer({fromPubkey:p,toPubkey:admin,lamports:BigInt(launch.storage.budget)+25000n+BigInt(r.storageWalletRent)})];
      }
      // Irys credits the address sending its funding payment. External launches
      // first fund their dedicated Launchpad storage signer, which owns the items.
      return [SystemProgram.transfer({fromPubkey:external?admin:p,toPubkey:pk(launch.storage.recipient),lamports:BigInt(launch.storage.budget)})];
    }
    if(stage==='platform'||stage==='platform-setup'){
      if(stage==='platform-setup')ok(launch.executionPlan==='compact-v3'&&(launch.keys.payer||launch.keys.wallet).external===true&&launch.keys.platform?.secret&&!admin.equals(p),'Invalid automatic platform setup.');
      const liquidity=protocolLiquidityTerms(r.protocolFees);
      // A review without a brand snapshot carries the platform's name with its own uploaded logo. Reviews carry the
      // brand snapshot (src/launchpad-branding.mjs) and its permanent image URL.
      const brand=r.platformBrand||{name:platformBrand().name,web:compactPlan(launch)?'':launch.publicOrigin||'',img:launch.storage?.platformImage||(compactPlan(launch)?'':i.image||'')};
      return[
        ...(stage==='platform'&&!admin.equals(p)?[SystemProgram.transfer({fromPubkey:p,toPubkey:admin,lamports:BigInt(r.platformRent)+BigInt(r.serviceReserve||0)})]:[]),
        ray.createPlatformConfig(program,admin,w,w,w,platform,pk(r.cpConfigId),w,{platformScale:bn(liquidity.platformScale),creatorScale:bn(liquidity.creatorScale),burnScale:bn(liquidity.burnScale)},bn((r.platformFeeBps||0)*100),bn(r.creatorFeeRatePpm??i.creatorFeeBps*100),brand.name,brand.web,brand.img,zero())];
    }
    ok(stage==='create','Invalid launch step.');
    const vaultA=ray.getPdaLaunchpadVaultId(program,pool,m).publicKey,vaultB=ray.getPdaLaunchpadVaultId(program,pool,q).publicKey;
    const base=[program,p,w,pk(r.configId),platform,auth,pool,m,q,vaultA,vaultB];
    const params=[6,i.name,i.symbol,launch.uri,{type:'ConstantCurve',totalSellA:bn(r.sell),migrateType:'cpmm',supply:bn(r.supply),totalFundRaisingB:bn(r.raise)},zero(),zero(),zero(),ray.CpmmCreatorFeeOn.OnlyTokenB];
    const ixs=[i.taxBps?ray.initializeWithToken2022(...base,pk(r.quoteProgram),...params,{transferFeeBasePoints:i.taxBps,maxinumFee:bn('18446744073709551615')}):ray.initializeV2(...base,ray.getPdaMetadataKey(m).publicKey,pk(r.quoteProgram),...params)];
    const d=r.devBuy;
    if(BigInt(d?.gross||0)>0n){
      ok(BigInt(d.gross)<=100000000000000n&&(i.devBuyMode==='sol'?d.solBudget===i.devBuyLamports:d.gross===i.devBuyRaw)&&BigInt(d.net)===BigInt(d.gross)-(BigInt(d.gross)*BigInt(i.taxBps)+9999n)/10000n,'Developer buy exceeds the reviewed supply limit.');
      if(i.devBuyMode==='sol')ok(BigInt(d.maxQuote)>0n&&BigInt(d.maxQuote)<=BigInt(i.quoteMint===SOL_MINT?i.devBuyLamports:d.quoteBudget||'0'),'Developer buy exceeds the reviewed SOL budget.');
      const ap=i.taxBps?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID,qp=pk(r.quoteProgram),aa=getAssociatedTokenAddressSync(m,p,false,ap);
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(p,aa,p,m,ap));
      let bb=getAssociatedTokenAddressSync(q,p,false,qp);
      if(i.quoteMint===SOL_MINT&&(launch.keys.payer||launch.keys.wallet).external===true){
        bb=await this.externalNativeFundingAddress(launch);
      }else if(i.quoteMint===SOL_MINT){
        const seed=randomUUID().replaceAll('-','');bb=await PublicKey.createWithSeed(p,seed,TOKEN_PROGRAM_ID);
        const rent=BigInt(await this.c.getMinimumBalanceForRentExemption(ACCOUNT_SIZE));
        ok(rent+BigInt(d.maxQuote)<=BigInt(Number.MAX_SAFE_INTEGER),'Developer buy is too large.');
        ixs.push(SystemProgram.createAccountWithSeed({fromPubkey:p,basePubkey:p,seed,newAccountPubkey:bb,lamports:Number(rent+BigInt(d.maxQuote)),space:ACCOUNT_SIZE,programId:TOKEN_PROGRAM_ID}),createInitializeAccount3Instruction(bb,q,p));
      }
      ixs.push(ray.buyExactOutInstruction(program,p,auth,pk(r.configId),platform,pool,aa,bb,vaultA,vaultB,m,q,ap,qp,ray.getPdaPlatformVault(program,platform,q).publicKey,ray.getPdaCreatorVault(program,w,q).publicKey,bn(d.net),bn(d.maxQuote),zero()));
      if(i.quoteMint===SOL_MINT)ixs.push(createCloseAccountInstruction(bb,p,p));
    }
    if(units(r.protocolFees?.creationFeeSol||'0')>0n)ixs.push(SystemProgram.transfer({fromPubkey:p,toPubkey:pk(r.protocolFees.recipient),lamports:units(r.protocolFees.creationFeeSol)}));
    return ixs;
  }
  setupCost(launch){
    const r=launch.review,budget=BigInt(launch.storage?.budget||0),buy=BigInt(r.devBuy?.gross||0)>0n;
    const funding=launch.executionPlan==='compact-v3'?this.platformFundingAmount(launch):BigInt(r.platformRent)+BigInt(r.serviceReserve||0)+(budget?budget+25000n+BigInt(r.storageWalletRent):0n);
    return (funding+(buy?BigInt(r.devBuy.solBudget)+6000000n:0n)+100000n).toString();
  }
  platformFundingAmount(launch){
    const r=launch.review,budget=BigInt(launch.storage?.budget||0),{p,admin}=this.addresses(launch);
    ok(launch.executionPlan==='compact-v3'&&(launch.keys.payer||launch.keys.wallet).external===true&&launch.keys.platform?.secret&&!admin.equals(p),'Invalid automatic platform funding.');
    ok(typeof r.storageWalletRent==='string'&&/^[1-9]\d*$/.test(r.storageWalletRent),'The launch wallet reserve is missing. Refresh the launch review.');
    ok(budget>=0n&&budget<=5000000n&&(!budget||launch.storage?.provider==='irys'),'Invalid image-storage payment.');
    return BigInt(r.platformRent)+BigInt(r.serviceReserve||0)+BigInt(r.storageWalletRent)+25000n+(budget?budget+25000n:0n);
  }
  async lookupTables(addresses){
    return Promise.all([...new Set(addresses)].map(async address=>{
      const key=pk(address),snapshot=await this.c.getAccountInfoAndContext(key,{commitment:'finalized'}),account=snapshot.value;
      ok(account?.owner.equals(AddressLookupTableProgram.programId),'A transaction address lookup table is unavailable. Nothing was submitted.');
      const table=new AddressLookupTableAccount({key,state:AddressLookupTableAccount.deserialize(account.data)});
      ok(table.isActive()&&table.state.addresses.length<=256,'A transaction address lookup table is inactive. Nothing was submitted.');
      ok(Number.isSafeInteger(snapshot.context.slot)&&snapshot.context.slot>table.state.lastExtendedSlot,'A transaction address lookup table is still warming up. Try again shortly.');
      return table;
    }));
  }
  async walletMessage(payer,blockhash,instructions,computeUnits,step='launch'){
    const base=new TransactionMessage({payerKey:payer,recentBlockhash:blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:computeUnits}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000}),...instructions]});
    let message=compactWalletMessage(base,instructions.lookupTables||[]);
    if(transactionSize(message)>1232){
      // This shared table address is declared by the pinned Raydium SDK. Read
      // its actual program-owned data; never invent or trust offchain indexes.
      try{
        const tables=await this.lookupTables(['AcL1Vo8oy1ULiavEcjSUcwfBSForXMudcZvDZy5nzJkU']);
        const compact=compactWalletMessage(base,[...(instructions.lookupTables||[]),...tables]);
        if(transactionSize(compact)<transactionSize(message))message=compact;
      }catch{}
    }
    if(transactionSize(message)>1232)throw Object.assign(Error(`The ${step} transaction needs ${transactionSize(message)} bytes, above this wallet’s 1,232-byte limit. Launchpad could not compress this route. No transaction was submitted.`),{code:'LAUNCH_TRANSACTION_TOO_LARGE',transactionBytes:transactionSize(message),step});
    return message;
  }
  async preflightWalletSize(launch){
    if((launch.keys.payer||launch.keys.wallet).external!==true)return;
    const compact=compactPlan(launch),one=compact&&!launch.splitPlatformSetup&&BigInt(launch.storage?.budget||0)===0n&&BigInt(launch.review.devBuy?.gross||0)===0n;
    for(const stage of one?['launch-all']:launch.executionPlan==='compact-v3'?['setup','platform-setup','create']:compact?['setup','create']:['platform','create']){
      const instructions=await this.launchInstructions(launch,stage);
      try{await this.walletMessage(pk(stage==='platform-setup'?launch.keys.platform.address:(launch.keys.payer||launch.keys.wallet).address),SystemProgram.programId.toBase58(),instructions,1400000,stage==='setup'?'launch setup':stage==='create'?'token creation':stage==='launch-all'?'launch':'platform setup');}
      catch(error){
        // A logo must never make an otherwise supported launch too large. A
        // maximum-length coin can cross the packet limit by a few bytes when
        // free storage and no dev buy would otherwise combine every step.
        // Select and price the separate platform setup before authorization.
        if(one&&launch.executionPlan==='compact-v3'&&launch.storage?.platformImage&&error.code==='LAUNCH_TRANSACTION_TOO_LARGE'){
          launch.splitPlatformSetup=true;return this.preflightWalletSize(launch);
        }
        throw error;
      }
    }
    return compact?{transactions:one?1:2,setupLamports:one?units(launch.review.minimumSol).toString():this.setupCost(launch)}:undefined;
  }
  async simulatePrepared(transaction,config,lastValidBlockHeight){
    // A load-balanced RPC can send the snapshot and simulation to nodes at
    // different finalized slots. Retry the same transaction against the same
    // lower bound; dropping minContextSlot would invalidate our spend checks.
    for(let attempt=0;attempt<3;attempt++){
      try{
        const result=await this.c.simulateTransaction(transaction,config);
        if(config.minContextSlot!==undefined&&result.context?.slot!==undefined&&result.context.slot<config.minContextSlot)throw Object.assign(Error('Minimum context slot has not been reached'),{code:-32016});
        return result;
      }catch(error){
        if(!contextLag(error))throw error;
        if(attempt===2)throw Object.assign(Error('The Solana RPC is still catching up to the launch balance check. Launchpad will retry without changing your transaction or sending funds.',{cause:error}),{code:-32016,launchCode:'LAUNCH_RPC_CONTEXT_LAG',retryable:true});
        await this.sleep(attempt===0?250:750);
        const height=await this.c.getBlockHeight('finalized');
        if(!Number.isSafeInteger(height)||height>lastValidBlockHeight)throw Object.assign(Error('The launch blockhash expired while waiting for the RPC. Launchpad will prepare a fresh transaction before requesting a signature.'),{code:'LAUNCH_BLOCKHASH_EXPIRED',retryable:true});
      }
    }
  }
  async prepare(launch,instructions,extraSigners=[],initial=false,options={}){
    // These retries happen before an operation is journaled or submitted. Once
    // prepare returns, only reconciliation may decide the saved bytes' fate.
    for(let attempt=0;attempt<3;attempt++){
      try{return await this.prepareOnce(launch,instructions,extraSigners,initial,options);}
      catch(error){
        if(!['LAUNCH_SIMULATION_BLOCKHASH','LAUNCH_BLOCKHASH_EXPIRED'].includes(error?.code)||attempt===2)throw error;
        await this.sleep(attempt===0?250:750);
      }
    }
  }
  async prepareOnce(launch,instructions,extraSigners=[],initial=false,{minContextSlot,operation,kind}={}){
    ok(instructions.length,'No transaction instructions.');
    if(operation?.kind==='tax-burn'||kind==='tax-burn'){
      ok(!initial&&extraSigners.length===0&&!instructions.lookupTables?.length,'A LAUNCHPAD tax burn cannot include other signers or lookup accounts.');
      validateTaxBurnInstructions(launch,operation,instructions);
      if(operation.taxSource==='approved-initial-inventory')ok(Number.isSafeInteger(instructions.taxBurnBalanceSlot)&&instructions.taxBurnBalanceSlot>0,'Initial LAUNCHPAD tax burn is missing a finalized inventory snapshot.');
    }
    const trade=initial==='trade';
    if(trade)ok(Number.isSafeInteger(minContextSlot)&&minContextSlot>=0,'The reviewed trading snapshot is unavailable. Review a fresh quote.');
    const payer=launch.keys.payer||launch.keys.wallet;
    const selected=['storage-fund','platform-setup'].includes(initial)&&payer.external===true?launch.keys.platform:initial?payer:rewardsWalletKey(launch,rewardsWalletSelection(launch,{operation:operation??{},kind}),{signer:true});
    ok(selected?.address,'Launch signer is unavailable.');
    const external=selected.external===true,publicKey=pk(selected.address);
    ok(PublicKey.isOnCurve(publicKey.toBytes()),'The launch signer must be a Solana wallet.');
    ok(!external||!selected.secret,'Connected wallet secrets must never be stored by Launchpad.');
    const wallet=external?{publicKey}:signer(selected.secret);
    ok(wallet.publicKey.equals(publicKey),'Launch signer does not match its saved address.');
    const payoutRentCheck=instructions.holderPayoutRentCheck;
    if(payoutRentCheck)ok(!initial&&!external&&launch.input.feeMode==='holders'&&launch.input.quoteMint===SOL_MINT&&(!operation?.kind||operation.kind==='payout')&&(!kind||kind==='payout')&&Number.isSafeInteger(payoutRentCheck.slot)&&payoutRentCheck.slot>0,'Invalid holder recipient balance check.');
    const block=await this.c.getLatestBlockhash('finalized');
    const signers=[...(external?[]:[wallet]),...extraSigners].filter((s,i,a)=>a.findIndex(x=>x.publicKey.equals(s.publicKey))===i);
    const required=new Set([wallet.publicKey.toBase58(),...instructions.flatMap(ix=>ix.keys.filter(k=>k.isSigner).map(k=>k.pubkey.toBase58()))]);
    ok(signers.length+(external?1:0)===required.size&&signers.every(s=>required.has(s.publicKey.toBase58())&&(!external||!s.publicKey.equals(publicKey))),'Launch signer mismatch.');
    const build=async units=>{
      const message=external?await this.walletMessage(wallet.publicKey,block.blockhash,instructions,units,initial==='setup'?'launch setup':initial==='create'?'token creation':initial==='launch-all'?'launch':trade?'trade':'wallet'):new TransactionMessage({payerKey:wallet.publicKey,recentBlockhash:block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000}),...instructions]}).compileToV0Message(instructions.lookupTables||[]);
      const size=transactionSize(message);
      const tx=size<=1232?new VersionedTransaction(message):makeV1Transaction(wallet.publicKey,block.blockhash,instructions,{computeUnits:units,fees:{priority:14000n}});
      ok(transactionSize(tx.message)<=(tx.version===1?4096:1232),'This atomic launch exceeds the transaction size limit. No token was created; creation and developer buy will not be split.');
      if(signers.length)tx.sign(signers);const bytes=Buffer.from(tx.serialize());
      if(!external)verifySignedTransaction(bytes,wallet.publicKey.toBase58(),signers.filter(s=>!s.publicKey.equals(wallet.publicKey)).map(s=>s.publicKey.toBase58()));return{tx,bytes};
    };
    let built=await build(1400000);
    let fundingCheck,harvestCheck;
    if(instructions.protocolHarvestMinimum===true){
      ok(!initial&&!external,'Automatic LP harvesting requires the dedicated protocol signer.');
      const quote=pk(launch.input.quoteMint),program=pk(launch.review.quoteProgram),base=pk(launch.keys.mint.address),baseProgram=launch.input.taxBps?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID;
      const assets=[{mint:quote,program},{mint:base,program:baseProgram}].map(asset=>({...asset,ata:getAssociatedTokenAddressSync(asset.mint,wallet.publicKey,false,asset.program)}));
      const before=await this.c.getMultipleAccountsInfoAndContext(assets.map(asset=>asset.ata),{commitment:'finalized'});
      ok(Number.isSafeInteger(before.context?.slot)&&before.context.slot>0,'The RPC omitted the protocol balance snapshot slot.');
      for(let index=0;index<assets.length;index++){const asset=assets[index];asset.token=before.value[index]?unpackAccount(asset.ata,before.value[index],asset.program):null;if(asset.token)ok(asset.token.owner.equals(wallet.publicKey)&&asset.token.mint.equals(asset.mint),'A protocol fee account is invalid.');}
      harvestCheck={before,assets};
    }
    if(initial==='quote-fund'||initial==='setup'&&BigInt(launch.review.devBuy?.gross||0)>0n){
      const quote=pk(launch.input.quoteMint),program=pk(launch.review.quoteProgram),ata=external&&launch.input.quoteMint===SOL_MINT?await this.externalNativeFundingAddress(launch):getAssociatedTokenAddressSync(quote,wallet.publicKey,false,program);
      const before=await this.c.getMultipleAccountsInfoAndContext([wallet.publicKey,ata],{commitment:'finalized'});
      ok(before.value[0]?.owner.equals(SystemProgram.programId),'Developer wallet account is unavailable.');
      ok(Number.isSafeInteger(before.context?.slot)&&before.context.slot>=0,'The RPC omitted the funding balance snapshot slot. Nothing was submitted.');
      fundingCheck={before,ata,quote,program,token:before.value[1]?unpackAccount(ata,before.value[1],program):null};
    }
    // Trading quotes and balance snapshots use confirmed state. Simulating
    // that trade against an older finalized bank can miss a recent deposit or
    // token-account creation. Fee collection retains its finalized policy.
    const sim=await this.simulatePrepared(built.tx,{sigVerify:!external,commitment:trade?'confirmed':'finalized',...(trade?{minContextSlot}:fundingCheck?{minContextSlot:fundingCheck.before.context.slot,accounts:{encoding:'base64',addresses:[wallet.publicKey.toBase58(),fundingCheck.ata.toBase58()]}}:harvestCheck?{minContextSlot:harvestCheck.before.context.slot,accounts:{encoding:'base64',addresses:harvestCheck.assets.map(asset=>asset.ata.toBase58())}}:instructions.taxBurnBalanceSlot?{minContextSlot:instructions.taxBurnBalanceSlot}:instructions.rewardHandoffBalanceSlot?{minContextSlot:instructions.rewardHandoffBalanceSlot}:payoutRentCheck?{minContextSlot:payoutRentCheck.slot}:{})},block.lastValidBlockHeight);
    if(sim.value.err==='BlockhashNotFound')throw Object.assign(Error('The Solana RPC could not validate the recent blockhash. Nothing was submitted. Retry when the RPC has caught up.'),{code:'LAUNCH_SIMULATION_BLOCKHASH',retryable:true});
    if(trade)ok(Number.isSafeInteger(sim.context?.slot)&&sim.context.slot>=minContextSlot,'The RPC omitted the trading simulation context. Nothing was submitted.');
    if(instructions.taxBurnBalanceSlot&&(!Number.isSafeInteger(sim.context?.slot)||sim.context.slot<instructions.taxBurnBalanceSlot))throw Object.assign(Error('The LAUNCHPAD burn simulation is behind its verified inventory snapshot. Waiting for a fresh finalized context.'),{code:'REWARD_ACCOUNT_SCAN_RETRY'});
    if(instructions.rewardHandoffBalanceSlot&&(!Number.isSafeInteger(sim.context?.slot)||sim.context.slot<instructions.rewardHandoffBalanceSlot))throw Object.assign(Error('The rewards handoff simulation is behind its verified inventory snapshot. Waiting for a fresh finalized context.'),{code:'REWARD_ACCOUNT_SCAN_RETRY'});
    if(payoutRentCheck)ok(Number.isSafeInteger(sim.context?.slot)&&sim.context.slot>=payoutRentCheck.slot,'The RPC omitted the holder payout simulation context. Nothing was submitted.');
    if(sim.value.err)throw recipientRentSimulationError(built.tx,sim.value,payoutRentCheck)||launchSimulationError(built.tx,sim.value,initial);
    if(harvestCheck){
      let nonzero=false;
      for(let index=0;index<harvestCheck.assets.length;index++){
        const asset=harvestCheck.assets[index],account=sim.value.accounts?.[index];ok(account?.data&&account.owner===asset.program.toBase58(),'The RPC omitted LP fee simulation balances.');
        const after=unpackAccount(asset.ata,{...account,owner:pk(account.owner),data:Buffer.from(account.data[0],'base64')},asset.program);
        ok(after.owner.equals(wallet.publicKey)&&after.mint.equals(asset.mint),'The LP fee simulation changed a fee account identity.');
        const earned=after.amount-(asset.token?.amount||0n);ok(earned>=0n,'The LP fee simulation unexpectedly spent tokens.');if(earned>0n)nonzero=true;
      }
      if(!nonzero)throw Object.assign(Error('No locked LP fees are ready to collect.'),{code:'PROTOCOL_HARVEST_DEFERRED'});
    }
    if(fundingCheck){
      const [payerAccount,tokenAccount]=sim.value.accounts||[];
      ok(payerAccount?.owner===SystemProgram.programId.toBase58()&&Number.isSafeInteger(payerAccount.lamports)&&tokenAccount,'The RPC omitted funding simulation balances. Nothing was submitted.');
      const q=unpackAccount(fundingCheck.ata,{...tokenAccount,owner:pk(tokenAccount.owner),data:Buffer.from(tokenAccount.data[0],'base64')},fundingCheck.program),prior=fundingCheck.token;
      ok(q.owner.equals(wallet.publicKey)&&q.mint.equals(fundingCheck.quote)&&q.amount-(prior?.amount||0n)>=BigInt(launch.review.devBuy.maxQuote),'The funding route does not deliver enough pairing tokens to your developer wallet.');
      ok(String(q.delegate||'')===String(prior?.delegate||'')&&String(q.closeAuthority||'')===String(prior?.closeAuthority||''),'The funding route changes wallet permissions. Nothing was submitted.');
      ok(BigInt(fundingCheck.before.value[0].lamports)-BigInt(payerAccount.lamports)<=(initial==='setup'?BigInt(this.setupCost(launch)):BigInt(launch.review.devBuy.solBudget)+6000000n),'The funding route exceeds the reviewed SOL budget and setup allowance.');
    }
    if(Number.isFinite(sim.value.unitsConsumed))built=await build(Math.min(1400000,Math.max(200000,Math.ceil(sim.value.unitsConsumed*1.2)+10000)));
    const validity={blockhash:block.blockhash,lastValidBlockHeight:block.lastValidBlockHeight,createdAt:Date.now(),...(Number.isSafeInteger(sim.context?.slot)&&sim.context.slot>=0?{preparedSlot:sim.context.slot}:{})};
    if(external)return{...validity,needsSignature:true,state:'awaiting_signature',externalSigner:wallet.publicKey.toBase58(),unsignedRaw:built.bytes.toString('base64'),messageHash:createHash('sha256').update(built.tx.message.serialize()).digest('hex')};
    return{...validity,signature:bs58.encode(built.tx.signatures[0]),raw:built.bytes.toString('base64'),state:'pending'};
  }
  async acceptSigned(op,encoded,{resolveAdditionalSigners}={}){
    ok(op?.needsSignature===true&&op.state==='awaiting_signature'&&!op.signature&&!op.raw,'This transaction is not waiting for a wallet signature.');
    const decode=value=>{
      ok(typeof value==='string'&&value.length>0&&value.length<=1644&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),'Invalid signed transaction encoding.');
      const bytes=Buffer.from(value,'base64');
      ok(bytes.length<=1232&&bytes.toString('base64')===value,'Invalid signed transaction size or encoding.');
      let tx;try{tx=VersionedTransaction.deserialize(bytes);}catch{throw Error('Invalid signed transaction.');}
      ok(tx.version===0&&Buffer.from(tx.serialize()).equals(bytes),'Only canonical v0 wallet transactions are accepted.');
      return{tx,bytes};
    };
    const expected=decode(op.unsignedRaw),message=Buffer.from(expected.tx.message.serialize());
    ok(createHash('sha256').update(message).digest('hex')===op.messageHash,'The saved wallet-signing request changed. Refresh this coin before signing again.');
    ok(expected.tx.message.staticAccountKeys[0].toBase58()===op.externalSigner&&expected.tx.message.recentBlockhash===op.blockhash&&expected.tx.signatures[0].every(x=>x===0),'The saved wallet-signing request is invalid.');
    const additional=expected.tx.message.staticAccountKeys.slice(1,expected.tx.message.header.numRequiredSignatures).map(k=>k.toBase58());
    let submitted,signature,guardCount=0,changed=false,needsLookupResolution=false;
    const walletRejection=error=>Object.assign(Error(`The wallet changed the reviewed transaction (${changedWalletMessageParts(expected.tx.message,submitted.tx.message)}). ${error.walletValidationReason?`Wallet transaction validation failed (${error.walletValidationReason}). This step was not submitted.`:error.message} Resume this coin to request a new signature.`),{code:'WALLET_TRANSACTION_REJECTED'});
    try{
      submitted=decode(encoded);
      if(!message.equals(Buffer.from(submitted.tx.message.serialize()))){
        // Phantom/Solflare may append Lighthouse assertions and set their own
        // bounded priority fee/compute limit. Everything else stays reviewed.
        try{({guardCount,changed}=validateWalletMessage(expected.tx.message,submitted.tx.message,{allowComputeBudget:true}));ok(changed===true,'No supported wallet change was found.');}
        catch(error){
          if(error.code!=='WALLET_LOOKUP_RESOLUTION_REQUIRED')throw walletRejection(error);
          // Structural/signing/guard checks passed, but concrete addresses are
          // needed before deciding whether this wallet layout is equivalent.
          needsLookupResolution=true;changed=true;
        }
        // Validate the external approval before retrieving any service key.
        ok(validWalletSignature(submitted.tx.message.serialize(),submitted.tx.signatures[0],op.externalSigner),'Local transaction signature verification failed. Nothing was submitted.');
        ok(expected.tx.signatures.slice(1).every((saved,index)=>validWalletSignature(message,saved,additional[index])&&(submitted.tx.signatures[index+1].every(byte=>byte===0)||Buffer.from(saved).equals(Buffer.from(submitted.tx.signatures[index+1])))),'The wallet changed a Launchpad signature. This step was not submitted. Resume this coin to request a new signature.');
      }else{
        ({signature}=verifySignedTransaction(submitted.bytes,op.externalSigner,additional));
        ok(expected.tx.signatures.slice(1).every((signature,index)=>Buffer.from(signature).equals(Buffer.from(submitted.tx.signatures[index+1]))),'The wallet changed a Launchpad signature. This step was not submitted. Resume this coin to request a new signature.');
      }
    }catch(error){
      // This synchronous validation has no network or journal writes. Only
      // these definitive rejections let the browser discard cached signed
      // bytes. RPC failures below must retain the original bytes for retries.
      throw Object.assign(error,{code:'WALLET_TRANSACTION_REJECTED'});
    }
    const height=await this.c.getBlockHeight('finalized');
    ok(Number.isSafeInteger(height)&&height>=0&&Number.isSafeInteger(op.lastValidBlockHeight)&&op.lastValidBlockHeight>=0&&height<=op.lastValidBlockHeight,'This wallet-signing request expired. Refresh it and sign the new transaction.');
    if(changed){
      const tableKeys=[...new Set([expected.tx.message,...(needsLookupResolution?[submitted.tx.message]:[])].flatMap(message=>message.addressTableLookups.map(table=>table.accountKey.toBase58())))];
      // Only chain-owned, active, warmed-up tables are used. Their existing
      // entries cannot change. RPC failures retain the signed bytes for retry.
      const tables=tableKeys.length?await this.lookupTables(tableKeys):[];
      if(needsLookupResolution){
        try{({guardCount}=validateWalletMessage(expected.tx.message,submitted.tx.message,{resolvedTables:tables,allowComputeBudget:true}));}
        catch(error){throw walletRejection(error);}
      }else validateWalletLookupAccounts(expected.tx.message,tables);
      if(guardCount)await this.verifyWalletGuardProgram();
      // The only permitted message changes add verified read-only assertions
      // or the wallet's own bounded compute budget. Either invalidates prior
      // mint/platform signatures, so obtain exactly those saved-operation
      // signers after validating the user's new approval.
      if(additional.length){
        ok(typeof resolveAdditionalSigners==='function','The saved wallet request cannot be co-signed. Resume this coin with a fresh request.');
        const signers=await resolveAdditionalSigners([...additional]);
        try{
          ok(Array.isArray(signers)&&signers.length===additional.length&&new Set(signers.map(s=>s.publicKey.toBase58())).size===additional.length&&signers.every(s=>additional.includes(s.publicKey.toBase58())&&s.publicKey.toBase58()!==op.externalSigner),'The saved wallet request has an invalid Launchpad signer set.');
          submitted.tx.sign(signers);
        }finally{
          // The scoped service resolver returns owned byte arrays, not
          // Keypair.secretKey getters (which return copies).
          if(Array.isArray(signers))for(const signer of signers)if(signer?.secretKey instanceof Uint8Array)signer.secretKey.fill(0);
        }
      }
      submitted.bytes=Buffer.from(submitted.tx.serialize());
      ({signature}=verifySignedTransaction(submitted.bytes,op.externalSigner,additional));
      // A request prepared against confirmed state (op.simulationCommitment) is checked at that commitment; finalized state trails it by about 13 seconds.
      const sim=await this.simulatePrepared(submitted.tx,{sigVerify:true,commitment:op.simulationCommitment==='confirmed'?'confirmed':'finalized',...(Number.isSafeInteger(op.preparedSlot)?{minContextSlot:op.preparedSlot}:{})},op.lastValidBlockHeight);
      if(sim.value?.err==='BlockhashNotFound')throw Error('This wallet-signing request expired. Refresh it and sign the new transaction.');
      if(sim.value?.err)throw Object.assign(Error('The wallet safety checks could not be confirmed. Launchpad has kept this exact signed request for a safe retry.'),{code:'WALLET_GUARD_SIMULATION_FAILED'});
      ok(sim.value&&sim.value.err===null,'The RPC omitted wallet transaction simulation results. Nothing was submitted.');
    }
    const now=Date.now(),result={...op,needsSignature:false,state:'pending',signature,raw:submitted.bytes.toString('base64'),preparedAt:op.createdAt,createdAt:now,signedAt:now};
    delete result.unsignedRaw;delete result.messageHash;
    return result;
  }
  async verifyWalletGuardProgram(){
    if(verifiedImmutableWalletGuard)return;
    const snapshot=await this.c.getMultipleAccountsInfoAndContext([pk(WALLET_GUARD_PROGRAM),pk(WALLET_GUARD_DATA)],{commitment:'finalized'});
    const [program,data]=snapshot.value||[],failure='The wallet safety program could not be verified. Nothing was submitted. Try again shortly.';
    ok(Number.isSafeInteger(snapshot.context?.slot)&&snapshot.context.slot>=294179293&&program?.owner.equals(pk(WALLET_GUARD_LOADER))&&program.executable===true&&program.data.length===36&&program.data.readUInt32LE(0)===2&&new PublicKey(program.data.subarray(4)).toBase58()===WALLET_GUARD_DATA,failure);
    ok(data?.owner.equals(pk(WALLET_GUARD_LOADER))&&data.executable===false&&data.data.length===424293&&data.data.readUInt32LE(0)===3&&data.data[12]===0&&createHash('sha256').update(data.data).digest('hex')===WALLET_GUARD_HASH,failure);
    verifiedImmutableWalletGuard=true;
  }
  async broadcast(op){ok(!op.needsSignature&&op.signature&&op.raw,'The transaction still needs a wallet signature. Nothing was submitted.');const signature=await this.c.sendRawTransaction(Buffer.from(op.raw,'base64'),{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,...(Number.isSafeInteger(op.preparedSlot)?{minContextSlot:op.preparedSlot}:{})});ok(signature===op.signature,'RPC returned a different transaction signature.');}
  async receipt(op){
    const result=await this.c.getSignatureStatuses([op.signature],{searchTransactionHistory:true});
    const status=result.value[0];
    if(status&&(op.observedSignatureStatus?.confirmationStatus!==(status.confirmationStatus||'unknown')||op.observedSignatureStatus?.slot!==(status.slot??null)))op.observedSignatureStatus={confirmationStatus:status.confirmationStatus||'unknown',slot:status.slot??null};
    if(status&&status.confirmationStatus!=='finalized')return null;
    // Providers can lose the status-cache entry while archival receipt lookup
    // still succeeds. A null status is not evidence that the trade never landed.
    const tx=await this.c.getTransaction(op.signature,{commitment:'finalized',maxSupportedTransactionVersion:1});
    if(!tx)return null;
    ok(tx.transaction.signatures[0]===op.signature,'Receipt signature mismatch.');
    return tx;
  }
  async pendingTransactionState(op){
    // Fail closed on old/malformed journals and RPCs without retained history.
    // Expiry alone does not prove that a previously submitted trade failed.
    const unknown=reason=>({state:'unknown',reason});
    if(op.observedSignatureStatus)return{state:'pending',reason:'This signature was previously observed onchain. Its exact receipt must be recovered before retrying.'};
    if(!op.signature||!op.raw||!Number.isSafeInteger(op.lastValidBlockHeight)||op.lastValidBlockHeight<151)return unknown('The saved transaction is missing its expiry proof.');
    const bytes=Buffer.from(op.raw,'base64'),tx=deserializeTransaction(bytes),hash=tx.message.recentBlockhash;
    if(!hash||op.blockhash&&op.blockhash!==hash||bs58.encode(tx.signatures[0])!==op.signature)return unknown('The saved transaction identity could not be verified.');
    const epoch=await this.c.getEpochInfo('finalized'),height=epoch?.blockHeight,slot=epoch?.absoluteSlot;
    if(!Number.isSafeInteger(height)||!Number.isSafeInteger(slot)||height<0||slot<height)return unknown('The RPC omitted a finalized checkpoint.');
    if(height<=op.lastValidBlockHeight)return{state:'pending',reason:'The saved transaction has not expired.'};
    // New operations retain the simulation slot. For older journals, block
    // height is a conservative lower bound on slot; this needs deeper history.
    const lowerSlot=Number.isSafeInteger(op.preparedSlot)&&op.preparedSlot>=0?op.preparedSlot:op.lastValidBlockHeight-151;
    const first=await this.c.getFirstAvailableBlock();
    if(!Number.isSafeInteger(first)||first<0||first>lowerSlot)return unknown('The RPC does not retain enough transaction history to establish this outcome.');
    const result=await this.c.getSignatureStatuses([op.signature],{searchTransactionHistory:true});
    if(!Number.isSafeInteger(result.context?.slot)||result.context.slot<slot||!Array.isArray(result.value)||result.value.length!==1)return unknown('The signature check is behind the finalized checkpoint.');
    if(result.value[0]!==null){op.observedSignatureStatus={confirmationStatus:result.value[0].confirmationStatus||'unknown',slot:result.value[0].slot??null};return{state:'pending',reason:'The saved signature is still present; its receipt must be reconciled.'};}
    const receipt=await this.c.getTransaction(op.signature,{commitment:'finalized',maxSupportedTransactionVersion:1});
    if(receipt){ok(receipt.transaction?.signatures?.[0]===op.signature,'Receipt signature mismatch.');op.observedSignatureStatus={confirmationStatus:'finalized',slot:receipt.slot??null};return{state:'pending',reason:'A receipt exists and must be reconciled before continuing.'};}
    const valid=await this.c.isBlockhashValid(hash,{commitment:'finalized',minContextSlot:slot});
    if(valid?.value!==false||!Number.isSafeInteger(valid.context?.slot)||valid.context.slot<slot)return unknown('Blockhash expiry could not be verified at the finalized checkpoint.');
    return{state:'expired',signature:op.signature,checkpoint:{height,slot},historyFromSlot:first};
  }
  transferTax(launch,info){
    const fee=getTransferFeeConfig(info.mint);if(!launch.input.taxBps){ok(!fee,'The token has an unexpected transfer tax.');return null;}
    const {w,auth}=this.addresses(launch);
    ok(info.program.equals(TOKEN_2022_PROGRAM_ID)&&fee,'The holder transfer tax is missing.');
    ok([fee.olderTransferFee,fee.newerTransferFee].every(x=>x.transferFeeBasisPoints===launch.input.taxBps&&x.maximumFee===18446744073709551615n),'The token transfer tax differs from the reviewed launch.');
    // Token-2022 encodes a permanently revoked config authority as zero.
    // Revocation fixes the checked schedules without revoking the distinct
    // withdrawal authority that the holder-reward service still requires.
    ok([w,auth].some(x=>x.equals(fee.withdrawWithheldAuthority))&&(fee.transferFeeConfigAuthority.equals(PublicKey.default)||[w,auth].some(x=>x.equals(fee.transferFeeConfigAuthority))),'The token tax authority differs from the reviewed launch.');
    return fee;
  }
  async verifyLaunch(launch){
    const {m,w,q,pool,program,platform}=this.addresses(launch);
    const minimumSlot=Math.max(0,...(launch.operations||[]).filter(op=>['create','launch-all'].includes(op.kind)&&op.state==='confirmed'&&Number.isSafeInteger(op.slot)).map(op=>op.slot));
    // Verify all linked accounts from the same finalized bank, at least as new
    // as the creation receipt. Separate RPC reads can hit lagging replicas and
    // incorrectly turn a successful launch into a permanent verification error.
    const snapshot=await this.c.getMultipleAccountsInfoAndContext([m,pool,platform,q],{commitment:'finalized',minContextSlot:minimumSlot});
    const waiting=message=>Object.assign(Error(message),{code:'LAUNCH_VERIFICATION_PENDING',retryable:true});
    if(!Number.isSafeInteger(snapshot?.context?.slot)||snapshot.context.slot<minimumSlot)throw waiting('Your token was created. The RPC is catching up with its confirmed launch accounts.');
    if(!Array.isArray(snapshot.value)||snapshot.value.length!==4||snapshot.value.some(account=>!account))throw waiting('Your token was created. Waiting for the RPC to return all of its launch accounts.');
    const [baseAccount,curveAccount,platformAccount,quoteAccount]=snapshot.value;
    const verify=(condition,message)=>{if(!condition)throw Object.assign(Error(message),{code:'LAUNCH_VERIFICATION_MISMATCH'});};
    const baseProgram=launch.input.taxBps?TOKEN_2022_PROGRAM_ID:TOKEN_PROGRAM_ID;
    verify(baseAccount.owner.equals(baseProgram),'The created token uses a different token program than the reviewed launch.');
    verify(quoteAccount.owner.equals(pk(launch.review.quoteProgram)),'The pairing token program differs from the reviewed launch.');
    const mint=unpackMint(m,baseAccount,baseAccount.owner),quote=unpackMint(q,quoteAccount,quoteAccount.owner);
    verify(mint.isInitialized&&!mint.mintAuthority&&!mint.freezeAuthority&&mint.decimals===6,'Token mint/freeze authority or decimals differ from the reviewed launch.');
    verify(quote.isInitialized&&quote.decimals===launch.review.quoteDecimals,'The pairing token decimals differ from the reviewed launch.');
    this.transferTax(launch,{key:m,program:baseAccount.owner,mint,extensions:getExtensionTypes(mint.tlvData)});
    const c=decodeRay(curveAccount,program,ray.LaunchpadPool,'PoolState');
    verify(c.creator.equals(w),'The onchain creator wallet differs from the reviewed launch.');
    verify(c.mintA.equals(m)&&c.mintB.equals(q),'The launch curve uses different token mints than the reviewed launch.');
    verify(c.configId.toBase58()===launch.review.configId&&c.platformId.equals(platform),'The launch curve configuration differs from the reviewed launch.');
    const expectedPrograms=(baseProgram.equals(TOKEN_2022_PROGRAM_ID)?1:0)|(quoteAccount.owner.equals(TOKEN_2022_PROGRAM_ID)?2:0);
    verify(c.mintProgramFlag===expectedPrograms&&c.mintDecimalsA===6&&c.mintDecimalsB===quote.decimals,'The launch curve token programs or decimals differ from its mints.');
    verify(c.supply.toString()===launch.review.supply&&c.totalSellA.toString()===launch.review.sell&&c.totalFundRaisingB.toString()===launch.review.raise,'The launch supply, sale allocation or fundraising target differs from the reviewed launch.');
    verify(c.virtualA.toString()===launch.review.virtualBase&&c.virtualB.toString()===launch.review.virtualQuote,'The launch virtual reserves differ from the reviewed bonding curve.');
    verify(c.migrateType===1&&c.cpmmCreatorFeeOn===ray.CpmmCreatorFeeOn.OnlyTokenB,'The launch migration or creator-fee setting differs from the reviewed launch.');
    const p=decodeRay(platformAccount,program,ray.PlatformConfig,'PlatformConfig');
    const liquidity=protocolLiquidityTerms(launch.review.protocolFees);
    verify(p.burnScale.eq(bn(liquidity.burnScale))&&p.creatorScale.eq(bn(liquidity.creatorScale))&&p.platformScale.eq(bn(liquidity.platformScale)),'The launch liquidity allocation differs from the reviewed burn policy.');
    if(liquidity.lpPolicy==='platform_locked')verify(p.platformLockNftWallet.equals(pk(protocolWalletKey(launch).address)),'The locked liquidity fee-key wallet differs from the reviewed launch.');
    verify(p.feeRate.eqn((launch.review.platformFeeBps||0)*100)&&p.creatorFeeRate.eqn(effectiveCreatorFeeRate(launch)),'The platform or creator trading fee differs from the reviewed launch.');
    verify(p.cpConfigId.toBase58()===launch.review.cpConfigId&&p.transferFeeExtensionAuth.equals(w),'The migration configuration or transfer-fee receiving authority differs from the reviewed launch.');
    return{mint:m.toBase58(),curve:pool.toBase58(),slot:snapshot.context.slot};
  }
  async holderSnapshot(launch){const {m,w}=this.addresses(launch),mi=await this.mintInfo(m),excluded=new Set([w.toBase58(),launch.keys.rewards?.address].filter(Boolean));const response=await readMintTokenAccounts(this,mi.program,m);const rows=[];for(const row of response.value){const a=unpackAccount(row.pubkey,row.account,mi.program);if(a.amount&&!a.isFrozen&&!excluded.has(a.owner.toBase58())&&PublicKey.isOnCurve(a.owner.toBytes()))rows.push({owner:a.owner.toBase58(),amount:a.amount.toString()});}return{slot:response.context.slot,rows};}
  async payoutInstructions(launch,payouts,{operation,kind='payout'}={}){const {q}=this.addresses(launch),w=pk(rewardsWalletKey(launch,rewardsWalletSelection(launch,{operation:operation??{},kind})).address),program=pk(launch.review.quoteProgram),native=launch.input.quoteMint===SOL_MINT,from=getAssociatedTokenAddressSync(q,w,false,program),instructions=[];
    if(native&&launch.input.feeMode==='holders'&&(operation?.kind||kind)==='payout'){
      const check=await inspectNativeRewardRecipients(this.c,payouts,w.toBase58());
      if(check)Object.defineProperty(instructions,'holderPayoutRentCheck',{value:check});
    }
    if(native){
      // Unwrap exactly this reward batch. Other WSOL (including donations and
      // future fee credit) stays in the launch ATA and cannot be paid out here.
      const amount=payouts.reduce((n,x)=>n+BigInt(x.amount),0n),seed=randomUUID().replaceAll('-',''),temporary=await PublicKey.createWithSeed(w,seed,TOKEN_PROGRAM_ID);
      const rent=await this.c.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
      instructions.push(SystemProgram.createAccountWithSeed({fromPubkey:w,basePubkey:w,seed,newAccountPubkey:temporary,lamports:rent,space:ACCOUNT_SIZE,programId:TOKEN_PROGRAM_ID}),createInitializeAccount3Instruction(temporary,q,w),createTransferCheckedInstruction(from,q,temporary,w,amount,9),createCloseAccountInstruction(temporary,w,w));
    }
    for(const row of payouts){const to=pk(row.owner);ok(PublicKey.isOnCurve(to.toBytes()),'Invalid fee recipient.');if(native&&!to.equals(w))instructions.push(SystemProgram.transfer({fromPubkey:w,toPubkey:to,lamports:BigInt(row.amount)}));else if(!native){ok(!to.equals(w),'Fees are already in this wallet.');const ata=getAssociatedTokenAddressSync(q,to,false,program);instructions.push(createAssociatedTokenAccountIdempotentInstruction(w,ata,to,q,program),createTransferCheckedInstruction(from,q,ata,w,BigInt(row.amount),launch.review.quoteDecimals,[],program));}}return instructions;}
  async rewardInventoryAccount(launch,address,{program,owner,mint,amount,missing,error}){
    // A finalized RPC may still trail the receipt already journaled by another
    // endpoint. Never compare its older inventory with newer earned credits.
    const minimum=(launch.operations||[]).reduce((slot,op)=>op.state==='confirmed'&&Number.isSafeInteger(op.slot)&&op.slot>slot?op.slot:slot,1);
    const snapshot=await this.c.getAccountInfoAndContext(address,{commitment:'finalized',minContextSlot:minimum});
    if(!Number.isSafeInteger(snapshot.context?.slot)||snapshot.context.slot<minimum)throw Object.assign(Error('The reward inventory snapshot is behind its confirmed transaction receipt. Waiting for a fresh finalized context.'),{code:'REWARD_ACCOUNT_SCAN_RETRY'});
    ok(snapshot.value&&!snapshot.value.executable,missing);
    const balance=unpackAccount(address,snapshot.value,program);
    ok(balance.isInitialized&&balance.owner.equals(owner)&&balance.mint.equals(mint)&&!balance.isFrozen&&balance.amount>=amount,error);
    return {slot:snapshot.context.slot};
  }
  async revalidateRewardInventory(launch,{error}={}){
    ok(launch.input?.feeMode==='holders','Inventory recovery is limited to managed holder rewards.');
    ok(!launch.operations?.some(op=>['pending','awaiting_signature'].includes(op.state)),'A saved reward transaction must reconcile before inventory recovery.');
    const payout=savedAtaPayoutFailure({...launch,error});
    if(payout){
      requireManagedRewardSource(launch);
      const selection=rewardsWalletSelection(launch,{kind:'payout'}),payer=pk(rewardsWalletKey(launch,selection,{signer:true}).address),quote=await this.mintInfo(launch.input.quoteMint);
      ok(quote.key.equals(pk(launch.input.quoteMint))&&quote.program.equals(pk(launch.review.quoteProgram))&&quote.mint.decimals===launch.review.quoteDecimals,'The reward payout mint metadata differs from its saved quote.');
      const instructions=await this.payoutInstructions(launch,payout.payouts,{operation:{kind:'payout',rewardsWallet:selection}});
      ok(instructions.length===payout.payouts.length*2,'The saved SPL reward payout instruction layout changed.');
      const minimum=(launch.operations||[]).reduce((slot,op)=>op.state==='confirmed'&&Number.isSafeInteger(op.slot)&&op.slot>slot?op.slot:slot,1),block=await this.c.getLatestBlockhash('finalized');
      const transaction=new VersionedTransaction(new TransactionMessage({payerKey:payer,recentBlockhash:block.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000}),...instructions]}).compileToV0Message());
      // This diagnostic transaction deliberately remains unsigned and is never
      // journaled or broadcast. Only the unchanged saved payout can later run.
      const sim=await this.simulatePrepared(transaction,{sigVerify:false,commitment:'finalized',minContextSlot:minimum},block.lastValidBlockHeight);
      if(!Number.isSafeInteger(sim.context?.slot)||sim.context.slot<minimum)throw Object.assign(Error('The reward payout simulation is behind its confirmed receipt. Waiting for a fresh finalized context.'),{code:'REWARD_ACCOUNT_SCAN_RETRY'});
      if(sim.value?.err!==null)throw launchSimulationError(transaction,sim.value||{err:'Missing simulation result'},false);
      return {slot:sim.context.slot};
    }
    if(error==='LAUNCHPAD tax burn exceeds its verified rewards-wallet inventory.'){
      // v71.24: with automatic burns off and no burn requested, no burn is planned, so this stop no longer applies.
      if(!officialTaxBurnEnabled(launch)){const slot=await this.c.getSlot('finalized');ok(Number.isSafeInteger(slot)&&slot>0,'The finalized slot is unavailable.');return {slot};}
      const plan=taxBurnPlan(launch);ok(BigInt(plan.amount)>0n,'There is no current LAUNCHPAD tax burn to revalidate.');
      const operation={kind:'tax-burn',...plan.operationData,amount:plan.amount,rewardsWallet:rewardsWalletSelection(launch,{kind:'tax-burn'})};
      const instructions=await this.burnInstructions(launch,plan.amount,{kind:'tax-burn',operation});
      return {slot:instructions.taxBurnBalanceSlot};
    }
    ok(error==='The creator rewards token account cannot cover its saved credits.','This reward error is not eligible for inventory revalidation.');
    const plan=rewardHandoffPlan(launch),instructions=await this.rewardHandoffInstructions(launch,plan);
    ok(Number.isSafeInteger(instructions.rewardHandoffBalanceSlot)&&instructions.rewardHandoffBalanceSlot>0,'There are no creator-held reward token credits to revalidate.');
    return {slot:instructions.rewardHandoffBalanceSlot};
  }
  async burnInstructions(launch,amount,{operation,kind='burn'}={}){
    const taxBurn=(operation?.kind||kind)==='tax-burn';
    if(taxBurn)ok(operation?.kind==='tax-burn'&&operation.amount===String(amount),'LAUNCHPAD tax burn differs from its saved operation amount.');
    const {m}=this.addresses(launch),w=pk(rewardsWalletKey(launch,rewardsWalletSelection(launch,{operation:operation??{},kind})).address),info=await this.mintInfo(m);
    if(taxBurn)ok(info.program.equals(TOKEN_2022_PROGRAM_ID)&&info.mint.decimals===6,'LAUNCHPAD tax burn requires the official six-decimal Token2022 mint.');
    const instructions=[createBurnCheckedInstruction(getAssociatedTokenAddressSync(m,w,false,info.program),m,w,BigInt(amount),6,[],info.program)];
    if(taxBurn){
      validateTaxBurnInstructions(launch,operation,instructions);
      const ata=instructions[0].keys[0].pubkey,snapshot=await this.rewardInventoryAccount(launch,ata,{program:TOKEN_2022_PROGRAM_ID,owner:w,mint:m,amount:BigInt(amount),missing:'LAUNCHPAD tax burn is missing a finalized token-account balance.',error:'LAUNCHPAD tax burn exceeds its verified rewards-wallet inventory.'});
      instructions.taxBurnBalanceSlot=snapshot.slot;
    }
    return instructions;
  }
  async migratedRayPool(launch){const {m,q,w}=this.addresses(launch),[a,b]=[m,q].sort((a,b)=>Buffer.compare(a.toBuffer(),b.toBuffer()));const key=ray.getCpmmPdaPoolId(this.ids.CREATE_CPMM_POOL_PROGRAM,pk(launch.review.cpConfigId),a,b).publicKey,account=await this.c.getAccountInfo(key);if(!account)return null;const pool=decodeRay(account,this.ids.CREATE_CPMM_POOL_PROGRAM,ray.CpmmPoolInfoLayout,'PoolState');ok(pool.mintA.equals(a)&&pool.mintB.equals(b)&&pool.poolCreator.equals(w)&&pool.enableCreatorFee,'Migrated pool does not match this launch’s creator-fee policy.');return{key,pool};}
  async protocolActivationInstructions(launch){
    const {admin,w,m,q,pool,program,platform}=this.addresses(launch),snapshot=await this.c.getMultipleAccountsInfoAndContext([pool,platform],{commitment:'finalized'});
    ok(Number.isSafeInteger(snapshot.context?.slot)&&snapshot.context.slot>0&&snapshot.value?.length===2&&snapshot.value.every(a=>a&&!a.executable),'The RPC omitted a valid platform activation snapshot.');
    const curve=decodeRay(snapshot.value[0],program,ray.LaunchpadPool,'PoolState'),state=decodeRay(snapshot.value[1],program,ray.PlatformConfig,'PlatformConfig');
    ok(curve.status===0&&curve.mintA.equals(m)&&curve.mintB.equals(q)&&curve.creator.equals(w)&&curve.platformId.equals(platform)&&curve.configId.toBase58()===launch.review.configId,'Only this token’s active bonding curve can enable a platform fee. Graduated coins cannot be changed.');
    const target=launch.protocolActivation;
    if(target?.upgradeVersion!==undefined){
      ok(validProtocolPolicyTarget(target,launch),'The reviewed protocol policy upgrade is invalid.');
      const selected=protocolActivationWallet(launch,target),previousWallet=pk(protocolWalletKey(launch).address),nextWallet=pk(selected.address);
      ok(launch.curve===pool.toBase58()&&curve.migrateType===1,'This upgrade requires the original CPMM-bound launch.');
      const previous=protocolLiquidityTerms(launch.review.protocolFees),reviewedFee=launch.review.platformFeeBps||0;
      ok([0,100].includes(reviewedFee)&&state.feeRate.eqn(reviewedFee*100)&&state.creatorFeeRate.eqn(effectiveCreatorFeeRate(launch)),'The onchain fees differ from the launch record. Refresh before upgrading.');
      ok(state.platformScale.eq(bn(previous.platformScale))&&state.creatorScale.eq(bn(previous.creatorScale))&&state.burnScale.eq(bn(previous.burnScale)),'The onchain LP allocation differs from the launch record.');
      ok(state.platformClaimFeeWallet.equals(previousWallet)&&state.platformLockNftWallet.equals(previousWallet)&&state.cpConfigId.toBase58()===launch.review.cpConfigId&&(state.platformCpCreator.equals(PublicKey.default)||state.platformCpCreator.equals(w)),'The platform wallets or migration configuration differ from this launch.');
      if(!nextWallet.equals(previousWallet)){
        // Recipient changes affect the whole PlatformConfig. Confirm its scope
        // on chain as well as in the local account inventory before signing.
        ok(typeof this.c.getProgramAccounts==='function','The RPC cannot verify which launches use this platform. Retry with an RPC that supports program-account queries.');
        const scope=await this.c.getProgramAccounts(program,{commitment:'finalized',minContextSlot:snapshot.context.slot,withContext:true,filters:[{dataSize:ray.LaunchpadPool.span},{memcmp:{offset:ray.LaunchpadPool.offsetOf('platformId'),bytes:platform.toBase58()}}]});
        ok(Number.isSafeInteger(scope.context?.slot)&&scope.context.slot>=snapshot.context.slot&&Array.isArray(scope.value)&&scope.value.length>0,'The RPC did not return a complete platform launch inventory. Retry before upgrading.');
        ok(scope.value.length===1&&scope.value[0].pubkey.equals(pool),'This platform configuration is shared by another onchain launch. Upgrade its launches together through a separate migration.');
        const scoped=decodeRay(scope.value[0].account,program,ray.LaunchpadPool,'PoolState');
        ok(!scope.value[0].account.executable&&scoped.platformId.equals(platform)&&scoped.mintA.equals(m)&&scoped.mintB.equals(q)&&scoped.creator.equals(w),'The platform launch inventory does not match this token.');
      }
      const updated={...state,platformClaimFeeWallet:nextWallet,platformLockNftWallet:nextWallet,feeRate:bn(10000),creatorFeeRate:bn(target.creatorFeeRatePpm),platformScale:bn(750000),creatorScale:zero(),burnScale:bn(250000)};
      target.platformSlot=snapshot.context.slot;target.platformHash=platformPolicyHash(updated);
      return [platformPolicyUpdateInstruction(program,admin,platform,updated,target.creatorFeeRatePpm)];
    }
    // Requests journaled by older releases retain their fee-only scope.
    ok(target?.curveFeeBps===100&&state.feeRate.isZero()&&state.platformClaimFeeWallet.equals(w),'This platform is not eligible for a new 1% fee. Refresh its onchain configuration.');
    ok(state.creatorFeeRate.eqn(effectiveCreatorFeeRate(launch)),'The creator fee differs from the launch record.');
    return [ray.updatePlatformConfig(program,admin,platform,{type:'updateFeeRate',value:bn(10000)})];
  }
  async verifyProtocolActivation(launch,receiptSlot,target=launch.protocolActivation){
    ok(Number.isSafeInteger(receiptSlot)&&receiptSlot>0,'The protocol activation receipt slot is missing.');
    if(target?.upgradeVersion!==undefined){
      ok(validProtocolPolicyTarget(target,launch)&&/^[a-f0-9]{64}$/.test(target.platformHash||'')&&Number.isSafeInteger(target.platformSlot)&&target.platformSlot>0,'The signed policy upgrade evidence is missing.');
      const selected=protocolActivationWallet(launch,target);
      const {w,m,q,pool,program,platform}=this.addresses(launch),minimum=Math.max(receiptSlot,target.platformSlot);
      const snapshot=await this.c.getMultipleAccountsInfoAndContext([pool,platform],{commitment:'finalized',minContextSlot:minimum});
      ok(Number.isSafeInteger(snapshot.context?.slot)&&snapshot.context.slot>=minimum&&snapshot.value?.length===2&&snapshot.value.every(a=>a&&!a.executable),'The RPC has not finalized the policy upgrade.');
      const curve=decodeRay(snapshot.value[0],program,ray.LaunchpadPool,'PoolState'),state=decodeRay(snapshot.value[1],program,ray.PlatformConfig,'PlatformConfig');
      ok(curve.mintA.equals(m)&&curve.mintB.equals(q)&&curve.creator.equals(w)&&curve.platformId.equals(platform)&&curve.configId.toBase58()===launch.review.configId&&launch.curve===pool.toBase58(),'The policy upgrade receipt belongs to a different launch.');
      // If graduation raced this transaction, a changed PlatformConfig alone
      // cannot prove how the already-created LP was disposed of. Do not report
      // a successful allocation upgrade without verifying that outcome.
      ok([0,1].includes(curve.status),'Graduation overlapped the policy upgrade. Its migration allocation needs verification before this upgrade can be marked complete.');
      ok(state.platformClaimFeeWallet.equals(pk(selected.address))&&state.platformLockNftWallet.equals(pk(selected.address)),'The confirmed protocol wallets differ from the signed policy upgrade.');
      ok(platformPolicyHash(state)===target.platformHash&&state.feeRate.eqn(10000)&&state.creatorFeeRate.eqn(target.creatorFeeRatePpm)&&state.platformScale.eqn(750000)&&state.creatorScale.isZero()&&state.burnScale.eqn(250000),'The confirmed fees, LP allocation or preserved platform settings differ from the signed policy upgrade.');
      return true;
    }
    const {w,program,platform}=this.addresses(launch),snapshot=await this.c.getMultipleAccountsInfoAndContext([platform],{commitment:'finalized',minContextSlot:receiptSlot});
    ok(Number.isSafeInteger(snapshot.context?.slot)&&snapshot.context.slot>=receiptSlot,'The RPC is behind the protocol activation receipt.');
    const state=decodeRay(snapshot.value[0],program,ray.PlatformConfig,'PlatformConfig');
    ok(state.platformClaimFeeWallet.equals(w)&&state.feeRate.eqn(10000)&&state.creatorFeeRate.eqn(effectiveCreatorFeeRate(launch)),'The RPC has not confirmed the reviewed protocol fee configuration.');
    return true;
  }
  async protocolLiquidityInstructions(launch,{automatic=false}={}){
    const instructions=await buildProtocolLiquidityClaim(this,launch);
    if(automatic&&instructions.length)instructions.protocolHarvestMinimum=true;
    return instructions;
  }
  async protocolPayoutInstructions(launch,{quote='0',base='0',recipient=launch.review.protocolFees.recipient}={}){
    const view=protocolWalletView(launch),{w,m}=this.addresses(view),instructions=BigInt(quote)>0n?await this.payoutInstructions(view,[{owner:recipient,amount:quote}],{operation:{kind:'protocol-payout'}}):[];
    if(BigInt(base)>0n){
      const mint=await this.mintInfo(m),owner=pk(recipient),from=getAssociatedTokenAddressSync(m,w,false,mint.program),to=getAssociatedTokenAddressSync(m,owner,false,mint.program);
      ok(mint.mint.decimals===6,'The launched token decimals changed.');
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(w,to,owner,m,mint.program),createTransferCheckedInstruction(from,m,to,w,BigInt(base),6,[],mint.program));
    }
    return instructions;
  }
  async rewardsGasFundingPlan(launch){
    ok(dedicatedRewardsWallet(launch),'A separate managed rewards wallet is required.');
    const creator=pk(launch.keys.wallet.address),rewards=pk(launch.keys.rewards.address);
    const [creatorBalance,rewardsBalance]=await Promise.all([this.c.getBalance(creator,'finalized'),this.c.getBalance(rewards,'finalized')]);
    ok([creatorBalance,rewardsBalance].every(n=>Number.isSafeInteger(n)&&n>=0),'The rewards gas balance snapshot is invalid.');
    const target=10000000n,initializeGas=!launch.rewardsWallet?.gasInitializedAt,rewardsRequired=initializeGas?target:0n,needed=rewardsRequired>BigInt(rewardsBalance)?rewardsRequired-BigInt(rewardsBalance):0n,credits=launch.rewardsWallet?.creatorCredits;
    // Raydium quote credits are held in the WSOL ATA, not native wallet SOL.
    // Only a legacy native-quote route reserves its quote principal here.
    const nativeReserve=launch.input.quoteMint===SOL_MINT&&launch.input.route==='pump'
      ?BigInt(credits?.quote??launch.credits?.quote??'0')+BigInt(credits?.protocolQuote??launch.taxProtocol?.creditQuote??'0')+BigInt(launch.protocolCredit||'0'):0n;
    ok(nativeReserve>=0n,'The rewards gas principal reserve is invalid.');
    const hasTokenHandoff=BigInt(credits?.base||'0')+BigInt(credits?.quote||'0')+BigInt(credits?.protocolQuote||'0')>0n;
    let handoffCost=needed>0n||hasTokenHandoff?50000n:0n; // No fee when activation needs no transaction.
    for(const [mintAddress,amount] of [[launch.keys.mint.address,credits?.base||'0'],[launch.input.quoteMint,(BigInt(credits?.quote||'0')+BigInt(credits?.protocolQuote||'0')).toString()]]){
      if(BigInt(amount)===0n)continue;
      const mint=await this.mintInfo(mintAddress),ata=getAssociatedTokenAddressSync(mint.key,rewards,false,mint.program),existing=await this.c.getAccountInfo(ata,'finalized');
      if(existing){const account=unpackAccount(ata,existing,mint.program);ok(account.owner.equals(rewards)&&account.mint.equals(mint.key)&&!account.isFrozen,'The rewards destination token account is invalid.');}
      else {const rent=await this.c.getMinimumBalanceForRentExemption(associatedTokenAccountSize(mint));ok(Number.isSafeInteger(rent)&&rent>=0,'The rewards account rent estimate is invalid.');handoffCost+=BigInt(rent);}
    }
    const needsTransaction=hasTokenHandoff||needed>0n;
    // Self-funded initialization retains the creator reserve and covers the
    // entire seed before signing. The central funder can instead fill the
    // rewards wallet directly, avoiding an unnecessary seed transaction and
    // making its creator requirement depend only on an actual token handoff.
    const creatorRequired=needsTransaction?target+nativeReserve+handoffCost+needed:0n;
    const creatorDirectRequired=hasTokenHandoff?target+nativeReserve+handoffCost:0n;
    const creatorDeficit=creatorRequired>BigInt(creatorBalance)?creatorRequired-BigInt(creatorBalance):0n,ready=creatorDeficit===0n,gas=ready?needed:0n;
    const gasFundingNeed={version:1,creatorAddress:creator.toBase58(),rewardsAddress:rewards.toBase58(),creatorMinimumLamports:creatorDirectRequired.toString(),rewardsMinimumLamports:rewardsRequired.toString(),creatorPrincipalReserveLamports:nativeReserve.toString()};
    return {gasLamports:gas.toString(),ready,initializeGas,needsTransaction,creatorBalanceLamports:String(creatorBalance),rewardsBalanceLamports:String(rewardsBalance),targetLamports:target.toString(),handoffCostLamports:handoffCost.toString(),creatorRequiredLamports:creatorRequired.toString(),creatorDirectRequiredLamports:creatorDirectRequired.toString(),creatorDeficitLamports:creatorDeficit.toString(),rewardsRequiredLamports:rewardsRequired.toString(),rewardsDeficitLamports:needed.toString(),creatorPrincipalReserveLamports:nativeReserve.toString(),gasFundingNeed,...(!ready?{reason:'The original creator wallet needs additional SOL for rewards account rent and gas while preserving its 0.01 SOL reserve.'}:{})};
  }
  async rewardHandoffInstructions(launch,plan){
    requireManagedRewardSource(launch);
    ok(dedicatedRewardsWallet(launch),'A separate managed rewards wallet is required.');
    ok(plan?.version===1&&plan.sourceAddress===launch.keys.wallet.address&&plan.destinationAddress===launch.keys.rewards.address,'The saved rewards handoff wallets differ from this launch.');
    const read=key=>{ok(typeof plan[key]==='string'&&/^\d+$/.test(plan[key]),'Invalid rewards handoff amount.');const n=BigInt(plan[key]);ok(n<=18446744073709551615n,'Rewards handoff exceeds token amount limits.');return n;};
    const base=read('baseUnits'),quote=read('quoteUnits'),holder=read('holderQuoteUnits'),protocol=read('protocolQuoteUnits'),tax=read('taxBaseUnits'),gas=read('gasLamports'),saved=launch.rewardsWallet?.creatorCredits;
    ok(saved&&base<=BigInt(saved.base)&&holder<=BigInt(saved.quote)&&protocol<=BigInt(saved.protocolQuote)&&tax<=BigInt(saved.taxBase)&&tax<=base&&quote===holder+protocol,'Rewards handoff exceeds saved creator-held credits.');
    ok(gas<=10000000n,'Rewards gas funding exceeds its per-handoff limit.');
    ok(base+quote+gas>0n,'No rewards credits or gas are ready to transfer.');
    if(gas>0n)ok(gas<=BigInt((await this.rewardsGasFundingPlan(launch)).gasLamports),'The creator gas reserve changed before rewards funding.');
    const w=pk(plan.sourceAddress),destination=pk(plan.destinationAddress),instructions=[];
    for(const [mintAddress,amount,decimals] of [[launch.keys.mint.address,base,6],[launch.input.quoteMint,quote,launch.review.quoteDecimals]]){
      if(amount===0n)continue;
      const mint=await this.mintInfo(mintAddress),from=getAssociatedTokenAddressSync(mint.key,w,false,mint.program),to=getAssociatedTokenAddressSync(mint.key,destination,false,mint.program);
      ok(mint.mint.decimals===decimals,'The rewards handoff mint decimals changed.');
      if(mintAddress===launch.input.quoteMint)ok(mint.program.equals(pk(launch.review.quoteProgram)),'The rewards handoff quote program changed.');
      const snapshot=await this.rewardInventoryAccount(launch,from,{program:mint.program,owner:w,mint:mint.key,amount,missing:'The creator rewards token account is unavailable.',error:'The creator rewards token account cannot cover its saved credits.'});
      instructions.rewardHandoffBalanceSlot=Math.max(instructions.rewardHandoffBalanceSlot||0,snapshot.slot);
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(w,to,destination,mint.key,mint.program),createTransferCheckedInstruction(from,mint.key,to,w,amount,decimals,[],mint.program));
    }
    if(gas>0n)instructions.push(SystemProgram.transfer({fromPubkey:w,toPubkey:destination,lamports:gas}));
    return instructions;
  }
  async holderRewardReference(launch){
    const mint=await this.mintInfo(launch.input.quoteMint);
    ok(mint.mint.decimals===launch.review.quoteDecimals,'The reward quote decimals changed.');
    return {...await this.referencePrice(launch.input,mint),mint:launch.input.quoteMint};
  }
  async claimInstructions(launch,source='creator',{operation}={}){
    const {w:creator,m,q,program}=this.addresses(launch),w=source==='protocol'||source==='protocol-auto'?pk(protocolWalletKey(launch).address):creator,qp=pk(launch.review.quoteProgram),ata=getAssociatedTokenAddressSync(q,w,false,qp);
    if(source==='protocol'||source==='protocol-auto'){
      ok(launch.review.platformFeeBps===100&&launch.review.protocolFees?.recipient,'This launch has no Launchpad protocol-fee policy.');
      const {platform}=this.addresses(launch),state=decodeRay(await this.c.getAccountInfo(platform),program,ray.PlatformConfig,'PlatformConfig');
      ok(state.platformClaimFeeWallet.equals(w)&&state.feeRate.eqn(10000),'The onchain platform fee or claim authority differs from this launch.');
      const vault=ray.getPdaPlatformVault(program,platform,q).publicKey,info=await this.c.getAccountInfo(vault);
      if(!info)return [];
      const account=unpackAccount(vault,info,qp);
      ok(account.mint.equals(q)&&account.owner.equals(ray.getPdaPlatformFeeVaultAuth(program).publicKey),'The platform fee vault is invalid.');
      if(account.amount===0n)return [];
      if(source==='protocol-auto'){
        const mint=await this.mintInfo(q),price=await this.referencePrice(launch.input,mint),usd=units(price.usd,8);
        ok(Number.isFinite(price.at)&&Date.now()-price.at<60000,'A fresh quote price is required for automatic protocol fee collection.');
        if(account.amount*usd<5n*100000000n*10n**BigInt(launch.review.quoteDecimals))return [];
      }
      return [createAssociatedTokenAccountIdempotentInstruction(w,ata,w,q,qp),ray.claimPlatformFeeFromVault(program,platform,w,ray.getPdaPlatformFeeVaultAuth(program).publicKey,vault,ata,q,qp)];
    }
    if(source==='tax'){
      ok(launch.input.route==='raydium'&&launch.input.feeMode==='holders'&&launch.input.taxBps>0,'This launch has no holder transfer tax.');
      const fee=this.transferTax(launch,await this.mintInfo(m));
      // Raydium can assign withdrawal authority at creation or migration.
      // Follow the actual authority; creator-fee rewards can still proceed.
      if(!fee.withdrawWithheldAuthority.equals(w))return[];
      // Already-harvested mint fees do not depend on the account index. A
      // temporary scan failure must not strand that independently verified
      // balance. Never consume partial rows or mask invalid account data.
      let rows=[],scanDeferred=false;
      try{({value:rows}=await readMintTokenAccounts(this,TOKEN_2022_PROGRAM_ID,m));}
      catch(error){if(error?.code!=='REWARD_ACCOUNT_SCAN_RETRY'||fee.withheldAmount<=0n)throw error;scanDeferred=true;}
      const sources=rows.filter(x=>getTransferFeeAmount(unpackAccount(x.pubkey,x.account,TOKEN_2022_PROGRAM_ID))?.withheldAmount>0n).slice(0,12).map(x=>x.pubkey);if(!sources.length&&!fee.withheldAmount)return[];
      const destination=pk(rewardsWalletKey(launch,rewardsWalletSelection(launch,{operation:operation??{},kind:'tax'})).address),dst=getAssociatedTokenAddressSync(m,destination,false,TOKEN_2022_PROGRAM_ID),ixs=[createAssociatedTokenAccountIdempotentInstruction(w,dst,destination,m,TOKEN_2022_PROGRAM_ID)];
      if(scanDeferred)ixs.taxAccountScanDeferred=true;
      if(fee.withheldAmount)ixs.push(createWithdrawWithheldTokensFromMintInstruction(m,dst,w,[],TOKEN_2022_PROGRAM_ID));
      if(sources.length)ixs.push(createWithdrawWithheldTokensFromAccountsInstruction(m,dst,w,[],sources,TOKEN_2022_PROGRAM_ID));return ixs;
    }
    const instructions=[],vault=ray.getPdaCreatorVault(program,w,q).publicKey,vaultInfo=await this.c.getAccountInfo(vault);
    let claimQuote=0n;
    if(vaultInfo){const account=unpackAccount(vault,vaultInfo,qp);ok(account.mint.equals(q)&&account.owner.equals(ray.getPdaCreatorFeeVaultAuth(program).publicKey),'The creator fee vault is invalid.');claimQuote=account.amount;}
    if(claimQuote>0n)instructions.push(createAssociatedTokenAccountIdempotentInstruction(w,ata,w,q,qp),ray.claimCreatorFee(program,w,ray.getPdaCreatorFeeVaultAuth(program).publicKey,vault,ata,q,qp));
    const migrated=await this.migratedRayPool(launch);
    if(migrated){const {key,pool:p}=migrated;if(p.creatorFeesMintA.gtn(0)||p.creatorFeesMintB.gtn(0)){
      claimQuote+=BigInt((p.mintA.equals(q)?p.creatorFeesMintA:p.creatorFeesMintB).toString());
      const aa=getAssociatedTokenAddressSync(p.mintA,w,false,p.mintProgramA),bb=getAssociatedTokenAddressSync(p.mintB,w,false,p.mintProgramB);
      instructions.push(createAssociatedTokenAccountIdempotentInstruction(w,aa,w,p.mintA,p.mintProgramA),createAssociatedTokenAccountIdempotentInstruction(w,bb,w,p.mintB,p.mintProgramB),ray.makeCollectCreatorFeeInstruction(this.ids.CREATE_CPMM_POOL_PROGRAM,w,this.ids.CREATE_CPMM_POOL_AUTH,key,p.configId,p.vaultA,p.vaultB,p.mintA,p.mintB,aa,bb,p.mintProgramA,p.mintProgramB));
    }}
    if(source==='holder-auto'){
      ok(launch.input.feeMode==='holders','The holder claim policy requires a holder rewards coin.');
      const minimum=currentHolderRewardMinimum(launch,launch.holderRewards?.priceReference);
      // A Paycheck launch (v71.44) keeps accrued credit in its wallet between payouts; its $1 claim floor is about the vault alone.
      if((paycheckLaunch(launch)?claimQuote:BigInt(launch.credits?.quote||'0')+claimQuote)<minimum)return [];
    }
    return instructions;
  }
  async taxConversionPlan(launch,credit,{policy='paced-v1'}={}){
    ok(['paced-v1',TAX_CONVERSION_BURST_POLICY].includes(policy),'Unknown tax conversion policy.');
    const maximumImpact=policy===TAX_CONVERSION_BURST_POLICY?TAX_CONVERSION_BURST_MAX_IMPACT_BPS:TAX_CONVERSION_MAX_IMPACT_BPS;
    ok(launch.input.feeMode==='holders','Tax conversions are available only for holder rewards.');
    const earned=BigInt(launch.credits?.base||'0'),requested=BigInt(credit);
    ok(requested>=0n&&requested<=earned,'Tax conversion exceeds earned token credit.');
    const {m,q,w,program,pool:key,platform}=this.addresses(launch),migrated=await this.migratedRayPool(launch);
    if(migrated){
      const p=migrated.pool,snapshot=await this.c.getMultipleAccountsInfoAndContext([migrated.key,p.vaultA,p.vaultB],{commitment:'finalized'});
      const current=decodeRay(snapshot.value[0],this.ids.CREATE_CPMM_POOL_PROGRAM,ray.CpmmPoolInfoLayout,'PoolState');
      ok(current.mintA.equals(p.mintA)&&current.mintB.equals(p.mintB)&&current.poolCreator.equals(w)&&current.configId.equals(p.configId)&&current.vaultA.equals(p.vaultA)&&current.vaultB.equals(p.vaultB),'The reward conversion pool changed.');
      const a=unpackAccount(p.vaultA,snapshot.value[1],current.mintProgramA),b=unpackAccount(p.vaultB,snapshot.value[2],current.mintProgramB);
      ok(a.mint.equals(current.mintA)&&b.mint.equals(current.mintB)&&a.owner.equals(this.ids.CREATE_CPMM_POOL_AUTH)&&b.owner.equals(this.ids.CREATE_CPMM_POOL_AUTH),'The reward conversion vaults differ from the pool.');
      const ra=a.amount-BigInt(current.protocolFeesMintA.toString())-BigInt(current.fundFeesMintA.toString())-BigInt(current.creatorFeesMintA.toString()),rb=b.amount-BigInt(current.protocolFeesMintB.toString())-BigInt(current.fundFeesMintB.toString())-BigInt(current.creatorFeesMintB.toString());
      if(current.status&4)return {amount:'0',waiting:true,reason:'Pool swaps are temporarily disabled.',priceImpactBps:0,maxPriceImpactBps:maximumImpact,slot:snapshot.context.slot};
      const baseIsA=current.mintA.equals(m);
      return {...taxConversionAmount(requested,baseIsA?ra:rb,{quoteReserve:baseIsA?rb:ra,policy}),slot:snapshot.context.slot};
    }
    const snapshot=await this.c.getAccountInfoAndContext(key,{commitment:'finalized'}),p=decodeRay(snapshot.value,program,ray.LaunchpadPool,'PoolState');
    ok(p.mintA.equals(m)&&p.mintB.equals(q)&&p.creator.equals(w)&&p.configId.equals(pk(launch.review.configId))&&p.platformId.equals(platform),'The tax conversion curve differs from this launch.');
    if(p.status!==0)return {amount:'0',waiting:true,reason:'The curve is awaiting graduation. Its reward conversion will retry when the pool is available.',priceImpactBps:0,maxPriceImpactBps:maximumImpact,slot:snapshot.context.slot};
    return {...taxConversionAmount(requested,BigInt(p.virtualA.sub(p.realA).toString()),{availableBase:BigInt(p.realA.toString()),quoteReserve:BigInt(p.virtualB.add(p.realB).toString()),availableQuote:BigInt(p.realB.toString()),policy}),slot:snapshot.context.slot};
  }
  async swapFeeInstructions(launch,side,amount,{operation}={}){
    ok(BigInt(amount)>0n,'No earned fees to swap.');ok(side==='buy'||side==='sell'&&launch.input.feeMode==='holders','The buyback bot cannot sell tokens.');
    const conversionPolicy=operation?.taxConversionPolicy||'paced-v1';
    if(side==='sell'){ok(['paced-v1',TAX_CONVERSION_BURST_POLICY].includes(conversionPolicy),'Unknown tax conversion policy.');if(conversionPolicy===TAX_CONVERSION_BURST_POLICY)ok(BigInt(amount)===TAX_CONVERSION_BACKLOG_UNITS,'A reward backlog burst must sell exactly 10,000,000 launch tokens.');}
    if(side==='sell')taxConversionReady(BigInt(amount)<=BigInt((await this.taxConversionPlan(launch,amount,{policy:conversionPolicy})).amount),'Pool liquidity changed. Tax conversion will be checked again after the cooldown.');
    const {m,q,w:creator,program,pool:key,auth,platform}=this.addresses(launch),w=pk(rewardsWalletKey(launch,rewardsWalletSelection(launch,{operation:operation??{},kind:side})).address),base=await this.mintInfo(m),quote=await this.mintInfo(q),aa=getAssociatedTokenAddressSync(m,w,false,base.program),bb=getAssociatedTokenAddressSync(q,w,false,quote.program),input=bn(amount);
    const migrated=await this.migratedRayPool(launch),ixs=[createAssociatedTokenAccountIdempotentInstruction(w,aa,w,m,base.program),createAssociatedTokenAccountIdempotentInstruction(w,bb,w,q,quote.program)],slot=await this.c.getSlot('finalized');
    let baseFee=getTransferFeeConfig(base.mint)||undefined,quoteFee=getTransferFeeConfig(quote.mint)||undefined;
    if(side==='sell'&&(baseFee||quoteFee)){
      const {epoch}=await this.c.getEpochInfo('finalized');
      ok(Number.isSafeInteger(epoch)&&epoch>=0,'The current transfer-fee epoch is unavailable.');
      const active=fee=>{if(!fee)return undefined;const schedule=getEpochFee(fee,BigInt(epoch));return {...fee,olderTransferFee:schedule,newerTransferFee:schedule};};
      baseFee=active(baseFee);quoteFee=active(quoteFee);
    }
    if(migrated){
      const {pool:p,key:cp}=migrated,cfg=decodeRay(await this.c.getAccountInfo(p.configId),this.ids.CREATE_CPMM_POOL_PROGRAM,ray.CpmmConfigInfoLayout,'AmmConfig');
      const inputMint=side==='buy'?q:m,isA=p.mintA.equals(inputMint),[va,vb]=await Promise.all([this.c.getTokenAccountBalance(p.vaultA),this.c.getTokenAccountBalance(p.vaultB)]);
      const reserveA=bn(va.value.amount).sub(p.protocolFeesMintA).sub(p.fundFeesMintA).sub(p.creatorFeesMintA),reserveB=bn(vb.value.amount).sub(p.protocolFeesMintB).sub(p.fundFeesMintB).sub(p.creatorFeesMintB);
      if(side==='sell')taxConversionReady(BigInt(amount)<=BigInt(taxConversionAmount(amount,BigInt((isA?reserveA:reserveB).toString()),{quoteReserve:BigInt((isA?reserveB:reserveA).toString()),policy:conversionPolicy}).amount),'Pool liquidity changed. Tax conversion will be checked again after the cooldown.');
      const inFee=side==='buy'?quoteFee:baseFee,outFee=side==='buy'?baseFee:quoteFee;
      const netIn=ray.getTransferAmountFeeFromPre(input,inFee,slot);const calc=ray.CurveCalculator.swapBaseInput(netIn.amount.sub(netIn.fee||zero()),isA?reserveA:reserveB,isA?reserveB:reserveA,cfg.tradeFeeRate,p.enableCreatorFee?cfg.creatorFeeRate:zero(),cfg.protocolFeeRate,cfg.fundFeeRate,p.feeOn===0||p.feeOn===(isA?1:2));
      const out=ray.getTransferAmountFeeFromPre(calc.outputAmount,outFee,slot),min=out.amount.sub(out.fee||zero()).muln(side==='sell'?9975:9900).divn(10000);if(side==='sell')taxConversionReady(min.gtn(0),'Tax conversion is too small after fees and will be checked again later.');else ok(min.gtn(0),'Fee swap is below the minimum size.');
      ixs.push(ray.makeSwapCpmmBaseInInstruction(this.ids.CREATE_CPMM_POOL_PROGRAM,w,this.ids.CREATE_CPMM_POOL_AUTH,p.configId,cp,side==='buy'?bb:aa,side==='buy'?aa:bb,isA?p.vaultA:p.vaultB,isA?p.vaultB:p.vaultA,side==='buy'?quote.program:base.program,side==='buy'?base.program:quote.program,inputMint,side==='buy'?m:q,p.observationId,input,min));return ixs;
    }
    const info=decodeRay(await this.c.getAccountInfo(key),program,ray.LaunchpadPool,'PoolState');
    if(side==='sell')taxConversionReady(info.status===0,'Tax conversion is waiting for the graduated pool.');else ok(info.status===0,'The curve is awaiting graduation. Fee processing is paused until its AMM pool is available.');
    if(side==='sell')taxConversionReady(BigInt(amount)<=BigInt(taxConversionAmount(amount,BigInt(info.virtualA.sub(info.realA).toString()),{availableBase:BigInt(info.realA.toString()),quoteReserve:BigInt(info.virtualB.add(info.realB).toString()),availableQuote:BigInt(info.realB.toString()),policy:conversionPolicy}).amount),'Launchpad liquidity changed. Tax conversion will be checked again after the cooldown.');
    const cfg=decodeRay(await this.c.getAccountInfo(info.configId),program,ray.LaunchpadConfig,'GlobalConfig'),plat=decodeRay(await this.c.getAccountInfo(platform),program,ray.PlatformConfig,'PlatformConfig');
    const args={poolInfo:info,protocolFeeRate:cfg.tradeFeeRate,platformFeeRate:plat.feeRate,curveType:0,shareFeeRate:zero(),creatorFeeRate:plat.creatorFeeRate,transferFeeConfigA:baseFee,transferFeeConfigB:quoteFee,slot};
    const calc=side==='buy'?ray.Launchpad.buyExactIn({...args,amountB:input}):ray.Launchpad.sellExactIn({...args,amountA:input});
    // sellExactIn already deducts the quote transfer fee from amountB.
    const min=(side==='buy'?calc.amountA.amount.sub(calc.amountA.fee||zero()):calc.amountB).muln(side==='sell'?9975:9900).divn(10000);if(side==='sell')taxConversionReady(min.gtn(0),'Tax conversion is too small after fees and will be checked again later.');else ok(min.gtn(0),'Fee swap is below the minimum size.');
    const f=side==='buy'?ray.buyExactInInstruction:ray.sellExactInInstruction;
    ixs.push(f(program,w,auth,info.configId,platform,key,aa,bb,info.vaultA,info.vaultB,m,q,base.program,quote.program,ray.getPdaPlatformVault(program,platform,q).publicKey,ray.getPdaCreatorVault(program,creator,q).publicKey,input,min,zero()));return ixs;
  }
}


export { newLaunchKeys, signer, receiptDeltas } from './launchpad-receipts.mjs';
