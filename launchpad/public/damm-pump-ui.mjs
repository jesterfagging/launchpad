import {createMeteoraOperation,meteoraDecimalRaw,meteoraUnits,validMeteoraOperation} from './meteora-ui.mjs';
export const isDammPumpCoin=coin=>['damm-pump','meteora-pumpswap'].includes(coin?.platform)||['damm-pump','meteora-pumpswap'].includes(coin?.venue);
export const dammPumpDecimalRaw=meteoraDecimalRaw;
export const dammPumpUnits=meteoraUnits;
const DAMM_ACTIONS=['configure','prepare-buy','fund-quote','initialize','buy','sell'];
const CONTINUATION_ACTIONS=['prepare-buy','fund-quote'];
const SOL='So11111111111111111111111111111111111111112';
const RAW=/^(0|[1-9]\d{0,19})$/;
export function validDammPumpOperation(value,options={}){
  if(!DAMM_ACTIONS.includes(value?.action)||!validMeteoraOperation(value,{...options,...(options.action==='initialize'&&CONTINUATION_ACTIONS.includes(value?.action)?{action:value.action}:{}),additionalActions:CONTINUATION_ACTIONS}))return false;
  const r=value.review;
  if(r.atomicGraduation!==undefined&&r.atomicGraduation!==false){
    if(r.atomicGraduation!==true||value.action!=='buy'||r.budgetIncludesAccountRent!==true||!['inputRaw','chargedRaw','maxQuoteDebitRaw','expectedQuoteDebitRaw','unusedQuoteBudgetRaw','expectedWalletDebitLamports','networkFeeLamports','accountSetupLamports','expectedOutputRaw','minOutputRaw'].every(key=>RAW.test(String(r[key]??''))))return false;
    if(BigInt(r.chargedRaw)<=0n||BigInt(r.chargedRaw)>BigInt(r.inputRaw)||r.maxQuoteDebitRaw!==r.inputRaw||r.expectedQuoteDebitRaw!==r.chargedRaw||BigInt(r.unusedQuoteBudgetRaw)!==BigInt(r.inputRaw)-BigInt(r.chargedRaw)||BigInt(r.maxWalletDebitLamports)<BigInt(r.expectedWalletDebitLamports)||BigInt(r.minOutputRaw)<=0n||BigInt(r.minOutputRaw)>BigInt(r.expectedOutputRaw))return false;
  }
  if(value.action==='prepare-buy'&&(r.quoteMint!==SOL||r.quoteDecimals!==9||!RAW.test(String(r.firstBuyRaw??''))||BigInt(r.firstBuyRaw)===0n))return false;
  if(!r.fundingMode)return value.action!=='fund-quote';
  if(r.fundingMode!=='sol'||!RAW.test(String(r.firstBuySolLamports??'')))return false;
  if(r.quoteMint===SOL)return value.action!=='fund-quote';
  if(!['quoteFundingInLamports','quoteFundingExpectedRaw','quoteFundingMinRaw'].every(key=>RAW.test(String(r[key]??''))))return false;
  return BigInt(r.quoteFundingInLamports)===(BigInt(r.firstBuySolLamports)||100000n)&&BigInt(r.quoteFundingMinRaw)>0n&&BigInt(r.quoteFundingExpectedRaw)>=BigInt(r.quoteFundingMinRaw);
}
export function dammPumpPairCompatible(asset){return asset?.launchReady===true&&Number.isInteger(asset.decimals)&&asset.decimals>=0&&asset.decimals<=18;}
export function dammPumpBlocker(status){return status?.blockers?.map(value=>typeof value==='string'?value:value?.message).filter(Boolean).join(' ')||status?.reason||'Launch setup is not ready yet. Check again shortly.';}
export function dammPumpFeeText(status){return status?.fees?.description||'1.25% pool trading fee before graduation, including approximately 1% for Launchpad. No transfer tax or creator or holder rewards. PumpSwap pool fees apply after graduation.';}
export function createDammPumpOperation(options){
  const request=options.request;
  const controller=createMeteoraOperation({...options,validateOperation:validDammPumpOperation,continuationActionMatches:(requested,received)=>requested===received||requested==='initialize'&&CONTINUATION_ACTIONS.includes(received),isTemporaryError:error=>error?.status===429||error?.statusCode===429||['DAMM_VENUE_RPC','DAMM_RPC_BUSY','DAMM_WALLET_GUARD_RPC','SOL_ROUTE_RATE_LIMITED','SOL_ROUTE_PROVIDER_UNAVAILABLE','SOL_ROUTE_NETWORK','SOL_ROUTE_TIMEOUT','SOL_ROUTE_NOT_FOUND','LAUNCH_REQUEST_TIMEOUT'].includes(error?.code)||!error?.code&&/^(?:The connection was interrupted\.|Failed to fetch|fetch failed|Network request failed)/i.test(error?.message||''),additionalActions:CONTINUATION_ACTIONS,continuationActions:CONTINUATION_ACTIONS,nextLaunchAction:operation=>{if(operation?.state!=='finalized')return null;if(operation.action==='configure'){if(CONTINUATION_ACTIONS.includes(operation.nextAction)||operation.nextAction==='initialize')return operation.nextAction;return operation.review?.fundingMode!=='sol'||operation.review?.quoteMint==='So11111111111111111111111111111111111111112'?'initialize':null;}return CONTINUATION_ACTIONS.includes(operation.action)&&operation.nextAction==='initialize'?'initialize':null;},setupKind:'lookup',transactionKindPrefix:'curve-damm-pump-',launchedMessage:'Your coin is live. It will graduate to PumpSwap with all received LP burned.',request:async(path,body)=>{
    const result=await request(path,body);
    if(result?.operation&&!DAMM_ACTIONS.includes(result.operation.action))throw Error('This transaction does not belong to the PumpSwap launch mode.');
    if(path==='/prepare'&&result?.operation?.state==='awaiting_signature'&&!validDammPumpOperation(result.operation,{now:options.clock?.()??Date.now()}))throw Error('The transaction review is incomplete or invalid. Nothing was signed.');
    return result;
  }});
  const restore=controller.restore;controller.restore=operation=>DAMM_ACTIONS.includes(operation?.action)&&restore(operation);
  return controller;
}

