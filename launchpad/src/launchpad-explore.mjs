import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { PublicCoinHolders } from './public-coin-holders.mjs';
import { PublicKey } from '@solana/web3.js';
import { LaunchChain, ray } from './launchpad-chain.mjs';
import { MarketData } from './market-data.mjs';
import { LaunchCurveHistory } from './launch-curve-history.mjs';
import { LaunchCurveActivity } from './launch-curve-activity.mjs';
import { SharedRpcGate } from './shared-rpc-gate.mjs';
import { LAUNCH_ASSETS } from '../public/launch-assets.mjs';
import { quoteLabel } from '../public/quote-identity.mjs';
import { QuoteMetadataResolver } from './launchpad-quote-metadata.mjs';
import { CREATOR_FEE_POLICY, HOLDER_CREATOR_FEE_POLICY, effectiveCreatorFeeRate } from '../public/creator-fee-schedule.mjs';
import { isCurrentLaunch } from '../public/launchpad-model.mjs';
import { publicRewardRecord, PublicLaunchRewards } from './launchpad-public-rewards.mjs';
import { PublicRefreshQueue, boundedRefresh } from './public-refresh-queue.mjs';
import { operatorCapacity } from './operator-capacity.mjs';
import { launchpadEnv } from './brand-env.mjs';
import { publicCreatorEarnings, unavailableCreatorEarnings } from './public-creator-earnings.mjs';
import { gotchiLaunch } from './gotchi-launches.mjs';
import { agentLaunch } from './agent/launches.mjs';
import { paycheckLaunch } from './launchpad-paycheck.mjs';
import { validGotchiId } from '../public/gotchi-catalog.mjs';
import { HOOK_MAX_RULES } from '../public/hook-catalog.mjs';

const gotchiView=value=>value&&validGotchiId(value.id)?{id:value.id,theme:typeof value.theme==='string'?value.theme.slice(0,40):value.id,href:'/gotchi?id='+value.id}:null;
const agentView=(value,mint)=>value&&/^[a-f0-9]{24}$/.test(value.id||'')&&address(value.wallet)?{id:value.id,wallet:value.wallet,model:String(value.model||'').slice(0,120),capabilities:Number(value.capabilities)|0,href:'/coin?mint='+mint+'#agent'}:null;

const REGISTRY_TTL=10_000, MARKET_TTL=30_000, MAX_MARKETS=1000, MAX_PENDING=3, MAX_STARTS=60, MAX_POINTS=720, BOOK_RECHECK_MS=300_000;
const nonnegative=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const positive=value=>nonnegative(value)>0?value:null;
const timestamp=value=>Number.isSafeInteger(value)&&value>0?value:null;
const freshUsdReference=(ref,mint,now)=>ref&&(!ref.mint||ref.mint===mint)&&ref.stale!==true&&(typeof ref.usd==='number'||typeof ref.usd==='string'&&ref.usd.trim()!=='')&&positive(Number(ref.usd))&&Number(ref.usd)<1e9&&timestamp(ref.at)&&ref.at<=now&&now-ref.at<=60_000;
// Line breaks and tabs in older records read as one space; other control characters are dropped.
const label=(value,max=100)=>typeof value==='string'?value.replace(/[\t\n\r]+/g,' ').replace(/[\x00-\x1f\x7f]/g,'').slice(0,max):'';
const fail=(message,statusCode=400)=>{throw Object.assign(Error(message),{statusCode});};
// A contract address matches from its start (4+ characters) or in full, so one letter doesn't match nearly every coin.
const mintMatches=(mint,search)=>typeof mint==='string'&&search.length>=4&&mint.toLowerCase().startsWith(search);
const address=value=>{try{return typeof value==='string'&&new PublicKey(value).toBase58()===value?value:null;}catch{return null;}};
const link=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&u.href.length<=300?u.href:null;}catch{return null;}};
const nativeVenue=coin=>['pumpswap','meteora','damm-pump','pump-classic'].includes(coin?.platform);
const onchainSource=coin=>coin?.platform==='pump-classic'?'Pump.fun onchain':coin?.platform==='meteora'?'Meteora onchain':['pumpswap','damm-pump'].includes(coin?.platform)?'Launchpad onchain':'Raydium onchain';
const tradeSource=coin=>coin?.platform==='pump-classic'?'Pump.fun onchain trades':coin?.platform==='meteora'?'Meteora recorded trades':['pumpswap','damm-pump'].includes(coin?.platform)?'Launchpad trade history':'Raydium trade history';
const assets=new Map(LAUNCH_ASSETS.map(asset=>[asset.mint,asset]));
const publicUsername=value=>typeof value==='string'&&/^[a-z0-9_][a-z0-9_-]{2,31}$/.test(value);
function creatorProfile(account){
  if(!account||account.banned===true||!publicUsername(account.username))return null;
  return {username:account.username,bio:label(account.bio,280),avatar:typeof account.avatar==='string'&&/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(account.avatar)?account.avatar:null};
}

// A public discovery record is built field-by-field. Never forward publicLaunch:
// it is an account-owner response and includes operational and wallet details.
function discoveryRecord(launch,now) {
  if(launch?.moderation?.hidden===true||launch?.listArchive?.archived===true)return null;
  if(!isCurrentLaunch(launch?.input)||!timestamp(launch.authorizedAt)||launch.state==='draft')return null;
  const creation=(Array.isArray(launch.operations)?launch.operations:[]).find(op=>['create','launch-all'].includes(op.kind)&&op.state==='confirmed'&&Number.isSafeInteger(op.slot)&&op.slot>0&&typeof op.signature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(op.signature));
  // A verified curve is retained even if a later fee cycle failed. Unconfirmed
  // failed/cancelled creations and private drafts never enter the catalogue.
  if(!creation&&!address(launch.curve))return null;
  const mint=address(launch.keys?.mint?.address),quoteMint=address(launch.input.quoteMint),wallet=address(launch.keys?.wallet?.address);
  if(!mint||!quoteMint||!wallet)return null;
  const createdAt=timestamp(creation?.confirmedAt)||timestamp(creation?.createdAt)||timestamp(launch.createdAt);
  if(!createdAt||createdAt>now+5000)return null;
  let curve;
  try{curve=ray.getPdaLaunchpadPoolId(ray.LAUNCHPAD_PROGRAM,new PublicKey(mint),new PublicKey(quoteMint)).publicKey.toBase58();}catch{return null;}
  if(launch.curve&&launch.curve!==curve)return null;
  const asset=assets.get(quoteMint),imageId=launch.input.imageId;
  let creatorFeeBps=null;try{creatorFeeBps=effectiveCreatorFeeRate(launch)/100;}catch{}
  const savedCreatorPolicy=launch.creatorFees?.policy||launch.review?.creatorFeePolicy||launch.input.creatorFeePolicy;
  const creatorFeePolicy=[CREATOR_FEE_POLICY,HOLDER_CREATOR_FEE_POLICY].includes(savedCreatorPolicy)?savedCreatorPolicy:null;
  const coin={mint,name:label(launch.input.name,100),symbol:label(launch.input.symbol,24),description:label(launch.input.description,500),image:typeof imageId==='string'&&/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(imageId)?'/token-images/'+imageId:null,
    createdAt,chain:'solana',platform:'raydium',launchMode:'raydium',quote:{mint:quoteMint,symbol:quoteLabel(quoteMint,launch.review?.quoteSymbol),name:label(asset?.name||launch.review?.quoteSymbol||'Custom pair'),category:asset?.category||'other'},
    feeMode:gotchiLaunch(launch)?'gotchi':agentLaunch(launch)?'agent':paycheckLaunch(launch)?'paycheck':['creator','holders','buyback'].includes(launch.input.feeMode)?launch.input.feeMode:'creator',gotchi:gotchiLaunch(launch)?gotchiView(launch.input.gotchi):null,agent:agentLaunch(launch)?agentView(launch.input.agent,mint):null,creatorFeeBps,creatorFeePolicy,postGradCreatorFeeBps:nonnegative(launch.review?.postGradCreatorBps),taxBps:Number.isInteger(launch.input.taxBps)?launch.input.taxBps:0,
    links:Object.fromEntries(['website','twitter','telegram'].flatMap(key=>{const href=link(launch.input.links?.[key]);return href?[[key,href]]:[];})),curve,href:'/coin?mint='+mint,explorerUrl:'https://solscan.io/token/'+mint};
  const review={};
  for(const key of ['configId','cpConfigId','supply','sell','raise','virtualBase','virtualQuote','quoteDecimals','quoteProgram'])review[key]=launch.review?.[key];
  const publicKeys={mint:{address:mint},wallet:{address:wallet},payer:{address:address(launch.keys?.payer?.address)||wallet},platform:{address:address(launch.keys?.platform?.address)||wallet}};
  // Only public verification inputs go to the read-only provider. No signing
  // key, account ID, custom account RPC, receipt, or fee credit is retained.
  const chainRecord={curve,input:{route:'raydium',network:'mainnet-beta',quoteMint,name:coin.name,symbol:coin.symbol},review,keys:publicKeys};
  return {coin,chainRecord,rewardRecord:publicRewardRecord(launch,chainRecord,coin),creatorEarnings:publicCreatorEarnings(launch,coin,{now})};
}

// Pump launches are independently confirmed by the public custody service.
// This adapter never fabricates a Raydium curve or exposes its private journal.
export function pumpDiscoveryRecord(launch, now, {includeHidden=false}={}) {
  if (!launch || launch.platform !== 'pumpswap') return null;
  if (!includeHidden && (launch.hidden === true || launch.moderation?.hidden === true || launch.archived === true)) return null;
  if (!['trading','bonded','migrated'].includes(launch.status)) return null;
  const mint = address(launch.mint), curve = address(launch.stateAddress), custody = address(launch.custodyAuthority), program = address(launch.publicProgramId);
  const quoteMint = address(launch.quoteMint), createdAt = timestamp(launch.createdAt);
  if (!mint || !curve || !custody || !program || quoteMint !== 'So11111111111111111111111111111111111111112' || !createdAt || createdAt > now + 5000) return null;
  const poolId = launch.status === 'migrated' ? address(launch.poolId) : null;
  if (launch.status === 'migrated' && !poolId) return null;
  const image = typeof launch.image === 'string' && /^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(launch.image) ? launch.image : null;
  const coin = { mint, name: label(launch.name), symbol: label(launch.symbol, 24), description: label(launch.description, 500), image, createdAt, chain: 'solana', platform: 'pumpswap', launchMode: 'pumpswap',
    quote: { mint: quoteMint, symbol: 'SOL', name: 'Solana', category: 'crypto' }, feeMode: 'creator', creatorFeeBps: 50, creatorFeePolicy: null, postGradCreatorFeeBps: 0, taxBps: 0,
    links: Object.fromEntries(['website','twitter','telegram'].flatMap(key => { const href = link(launch[key] || launch.links?.[key]); return href ? [[key, href]] : []; })),
    curve, poolId, custodyAuthority: custody, graduationFeeBps: 2885, tradeFeeBps: 100, totalTradeFeeBps: 150, href: '/coin?mint=' + mint, explorerUrl: 'https://solscan.io/token/' + mint };
  const chainRecord = { curve, input: { route: 'pumpswap', network: 'mainnet-beta', quoteMint, name: coin.name, symbol: coin.symbol, feeMode: 'none', taxBps: 0 },
    review: { publicProgramId: program, stateAddress: curve, custodyAuthority: custody, poolId, quoteDecimals: 9, quoteProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
    keys: { mint: { address: mint }, wallet: { address: custody }, payer: { address: custody }, platform: { address: custody } } };
  return { coin, chainRecord, rewardRecord: null, creatorEarnings:publicCreatorEarnings(launch,coin,{now}) };
}

// Transfer hook rules (v71.28) on a Meteora coin, for coin rows: the rules in plain words, the gate token and whether the rules
// still run. Nothing else of the launch's hook record (program, PDAs, exemptions, allowlist) enters a public row.
export function hookRowView(hook, status) {
  if (!hook || !Array.isArray(hook.rules)) return null;
  const rules = hook.rules.slice(0, HOOK_MAX_RULES).map(rule => ({ id: label(rule?.id, 32), name: label(rule?.name, 40), text: label(rule?.text, 300) })).filter(rule => /^[a-z_]{3,32}$/.test(rule.id) && rule.name);
  if (!rules.length) return null;
  // `active` follows the service view when it says so (rules run only on a live curve); a row without it falls back to the status.
  const active = hook.active === true || hook.active === undefined && ['trading', 'bonded'].includes(status);
  // `route`: 'curve' when a rule needs per-wallet accounts (or the tithe payment) only Launchpad supplies, so the coin trades on
  // Launchpad until graduation; 'any' otherwise. `blocklistCount` and `titheRecipient` are shown on the coin page; the list itself
  // is read from chain through /api/launchpad/meteora/hook-blocklist.
  // 'app' (v71.35): the coin trades only through the named app while on the curve (its mark must be in the trade), so Launchpad's Buy and Sell are off for it
  // until graduation; the row carries the app id and name (the sentence for the trade box comes from the catalogue).
  const route = hook.route === 'curve' ? 'curve' : hook.route === 'app' ? 'app' : 'any', ended = status === 'migrated' || hook.ended === true;
  const app = route === 'app' ? { app: label(hook.app, 16) || null, appName: label(hook.appName, 24) || '' } : { app: null, appName: '' }; // the mark itself stays off public rows
  const blocklistCount = Number.isInteger(hook.blocklistCount) && hook.blocklistCount >= 0 ? hook.blocklistCount : null;
  return { rules, route, ...app, curveTrading: route !== 'app' || ended, gateMint: address(hook.gateMint), titheRecipient: address(hook.titheRecipient), blocklistCount, active, ended };
}

// Meteora pool identity and lifecycle are verified by the DBC service. Keep its
// discovery projection separate from both Raydium and Launchpad's Pump program.
export function meteoraDiscoveryRecord(launch, now, {includeHidden=false}={}) {
  if (launch?.platform !== 'meteora' || !['trading','bonded','migrated'].includes(launch.status)) return null;
  if (!includeHidden && (launch.hidden === true || launch.moderation?.hidden === true || launch.archived === true)) return null;
  const mint=address(launch.mint),curve=address(launch.dbcPoolId),config=address(launch.configAddress),quoteMint=address(launch.quoteMint),creator=address(launch.creatorWallet),createdAt=timestamp(launch.createdAt);
  const decimals=launch.quoteDecimals,baseDecimals=launch.baseDecimals??6;
  if(!mint||!curve||!config||!quoteMint||!creator||!createdAt||createdAt>now+5000||!Number.isInteger(decimals)||decimals<0||decimals>18||!Number.isInteger(baseDecimals)||baseDecimals<0||baseDecimals>18||!['creator','holders','gotchi','agent'].includes(launch.feeMode)||launch.feeMode==='gotchi'&&!gotchiView(launch.gotchi)||launch.feeMode==='agent'&&!agentView(launch.agent,mint))return null;
  const poolId=launch.status==='migrated'?address(launch.poolId):null;if(launch.status==='migrated'&&!poolId)return null;
  const asset=assets.get(quoteMint),image=typeof launch.image==='string'&&/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(launch.image)?launch.image:null;
  const coin={mint,curve,poolId,createdAt,chain:'solana',platform:'meteora',launchMode:'meteora',name:label(launch.name),symbol:label(launch.symbol,24),description:label(launch.description,500),image,
    quote:{mint:quoteMint,symbol:quoteLabel(quoteMint,launch.quoteSymbol),name:label(asset?.name||launch.quoteName||launch.quoteSymbol||'Custom pair'),category:asset?.category||launch.quoteCategory||'other',decimals},baseDecimals,
    feeMode:launch.feeMode,gotchi:launch.feeMode==='gotchi'?gotchiView(launch.gotchi):null,agent:launch.feeMode==='agent'?agentView(launch.agent,mint):null,creatorFeeBps:nonnegative(launch.creatorFeeBps),creatorFeePolicy:null,postGradCreatorFeeBps:null,taxBps:0,totalTradeFeeBps:nonnegative(launch.totalTradeFeeBps),graduationFeeBps:nonnegative(launch.graduationFeeBps),
    links:Object.fromEntries(['website','twitter','telegram'].flatMap(key=>{const href=link(launch[key]||launch.links?.[key]);return href?[[key,href]]:[];})),href:'/coin?mint='+mint,explorerUrl:'https://solscan.io/token/'+mint,hook:hookRowView(launch.hook,launch.status)};
  const wallet=address(launch.rewardsWallet?.address)||creator;
  const chainRecord={curve,input:{route:'meteora',network:'mainnet-beta',quoteMint,feeMode:coin.feeMode,taxBps:0},review:{configAddress:config,quoteDecimals:decimals,quoteProgram:address(launch.quoteProgram),baseDecimals,poolId,dbcPoolId:curve},keys:{mint:{address:mint},wallet:{address:wallet},payer:{address:creator},platform:{address:wallet}}};
  return {coin,chainRecord,rewardRecord:null,creatorEarnings:publicCreatorEarnings(launch,coin,{now})};
}

export function dammPumpDiscoveryRecord(launch,now,{includeHidden=false}={}) {
  if(launch?.platform!=='damm-pump'||!['trading','bonded','migrated'].includes(launch.status))return null;
  if(!includeHidden&&(launch.hidden===true||launch.archived===true))return null;
  const mint=address(launch.mint),state=address(launch.stateAddress),custody=address(launch.custodyAuthority),program=address(launch.publicProgramId),quoteMint=address(launch.quoteMint),dammPoolId=address(launch.dammPoolId),createdAt=timestamp(launch.createdAt),decimals=launch.quoteDecimals,quoteProgram=address(launch.quoteTokenProgram||launch.quoteProgram);
  if(!mint||!state||!custody||!program||!quoteMint||!dammPoolId||!quoteProgram||!createdAt||createdAt>now+5000||!Number.isInteger(decimals)||decimals<0||decimals>18)return null;
  const poolId=launch.status==='migrated'?address(launch.poolId):null;if(launch.status==='migrated'&&!poolId)return null;
  const asset=assets.get(quoteMint),image=typeof launch.image==='string'&&/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(launch.image)?launch.image:null;
  const coin={mint,name:label(launch.name),symbol:label(launch.symbol,24),description:label(launch.description,500),image,createdAt,chain:'solana',platform:'damm-pump',launchMode:'damm-pump',curve:dammPoolId,dammPoolId,poolId,
    quote:{mint:quoteMint,symbol:quoteLabel(quoteMint,launch.quoteSymbol),name:label(asset?.name||launch.quoteName||launch.quoteSymbol),category:asset?.category||launch.quoteCategory||'other',decimals},baseDecimals:6,
    feeMode:'none',creatorFeeBps:0,creatorFeePolicy:null,postGradCreatorFeeBps:0,taxBps:0,graduationFeeBps:0,tradeFeeBps:125,totalTradeFeeBps:125,
    links:Object.fromEntries(['website','twitter','telegram'].flatMap(key=>{const href=link(launch[key]);return href?[[key,href]]:[];})),href:'/coin?mint='+mint,explorerUrl:'https://solscan.io/token/'+mint};
  const chainRecord={curve:dammPoolId,input:{route:'damm-pump',network:'mainnet-beta',quoteMint,name:coin.name,symbol:coin.symbol,feeMode:'none',taxBps:0},review:{publicProgramId:program,stateAddress:state,custodyAuthority:custody,dammPoolId,poolId,quoteDecimals:decimals,quoteProgram,baseDecimals:6},keys:{mint:{address:mint},wallet:{address:custody},payer:{address:custody},platform:{address:custody}}};
  return {coin,chainRecord,rewardRecord:null,creatorEarnings:unavailableCreatorEarnings()};
}

// Native Pump.fun coins created by Launchpad (src/pump-classic). Identity comes from
// the service's verified launch record: the per-coin bonding curve is fixed and
// the canonical PumpSwap pool is reported only after a verified graduation.
const PUMP_CLASSIC_MODES=['creator','holders','gotchi','agent','market_maker','lp_manager','diamond_hands','earned','insured'],PUMP_CLASSIC_OPTION_MODES=['diamond_hands','earned','insured'],OPTION_PHASES=['pending','active','probation','earned','failed','holders','bonus','released'];
/** The option's kind and phase from a discovery row (v71.34), for the Explore badge; anything malformed → no option. */
const optionView=(launch,mode)=>PUMP_CLASSIC_OPTION_MODES.includes(mode)&&launch.option&&typeof launch.option==='object'&&OPTION_PHASES.includes(launch.option.phase)?{kind:mode,phase:launch.option.phase}:null;
const evmAddress=value=>typeof value==='string'&&/^0x[0-9a-fA-F]{40}$/.test(value)?value:null;
/**
 * A Robinhood Chain coin (v71.41) as Explore lists it: a pool-native launch the venue service reports with its live
 * numbers already computed (no Solana reads apply). The chain is `robinhood`, the AMM Uniswap v4, the quote the pair.
 */
export function robinhoodDiscoveryRecord(launch,now,{includeHidden=false}={}) {
  if(launch?.platform!=='robinhood'||!['trading','graduated'].includes(launch.status))return null;
  if(!includeHidden&&launch.hidden===true)return null;
  const mint=evmAddress(launch.token||launch.mint),createdAt=timestamp(launch.createdAt),quoteMint=evmAddress(launch.quoteMint)||'0x0000000000000000000000000000000000000000';
  if(!mint||!createdAt||createdAt>now+5000)return null;
  const kind=String(launch.quoteCategory||''),category=kind==='stock'||kind==='etf'?'stocks':'crypto';
  const coin={mint,curve:typeof launch.poolId==='string'?launch.poolId:null,poolId:launch.poolId||null,createdAt,chain:'robinhood',platform:'robinhood',launchMode:'robinhood',name:label(launch.name),symbol:label(launch.symbol,24),description:label(launch.description,500),image:typeof launch.image==='string'&&/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(launch.image)?launch.image:null,
    quote:{mint:quoteMint,symbol:label(launch.quoteSymbol,24)||'ETH',name:label(launch.quoteName,80)||label(launch.quoteSymbol,24),category,kind,decimals:Number(launch.quoteDecimals??18),logo:typeof launch.quoteLogo==='string'&&/^\/robinhood-pairs\/logo\/0x[0-9a-fA-F]{40}(?:\?v=\d+)?$/.test(launch.quoteLogo)?launch.quoteLogo:null},
    feeMode:label(launch.mode,32)||'creator',creatorFeeBps:Number(launch.creatorFeeBps||0),taxBps:Number(launch.taxBps||0),postGradCreatorFeeBps:Number(launch.postGradCreatorFeeBps||0),tier:label(launch.tier,16),rules:Number(launch.rules||0),coinUrl:typeof launch.coinUrl==='string'&&launch.coinUrl.startsWith('/coin?')?launch.coinUrl:'/coin?mint='+mint+'&chain=robinhood',tradeLinks:Array.isArray(launch.tradeLinks)?launch.tradeLinks.filter(t=>t&&/^https:\/\//.test(t.url||'')).map(t=>({id:label(t.id,24),label:label(t.label,24),url:String(t.url).slice(0,300)})):[],
    live:launch.live&&typeof launch.live==='object'?launch.live:null,status:launch.status};
  const chainRecord={curve:coin.curve,input:{route:'robinhood',network:'robinhood-chain',quoteMint,name:coin.name,symbol:coin.symbol,feeMode:coin.feeMode,taxBps:coin.taxBps},review:{poolId:coin.poolId},keys:{mint:{address:mint},wallet:{address:mint},payer:{address:mint},platform:{address:mint}}};
  return {coin,chainRecord,rewardRecord:null,creatorEarnings:unavailableCreatorEarnings()};
}

export function pumpClassicDiscoveryRecord(launch,now,{includeHidden=false}={}) {
  if(launch?.platform!=='pump-classic'||!['trading','migrated'].includes(launch.status))return null;
  if(!includeHidden&&launch.hidden===true)return null;
  const mint=address(launch.mint),curve=address(launch.bondingCurve),createdAt=timestamp(launch.createdAt),mode=launch.mode;
  if(!mint||!curve||!createdAt||createdAt>now+5000||!PUMP_CLASSIC_MODES.includes(mode)||mode==='gotchi'&&!gotchiView(launch.gotchi)||mode==='agent'&&!agentView(launch.agent,mint))return null;
  const poolId=launch.status==='migrated'?address(launch.poolId):null;if(launch.status==='migrated'&&!poolId)return null;
  // Pair (v71.19): SOL, or the quote asset Pump.fun admitted for this coin. Rows from before pairs carry no quote fields and are SOL coins.
  const SOL='So11111111111111111111111111111111111111112',quoteMint=launch.quoteMint===undefined?SOL:address(launch.quoteMint),native=quoteMint===SOL,decimals=native?9:launch.quoteDecimals;
  if(!quoteMint||!Number.isInteger(decimals)||decimals<0||decimals>18)return null;
  const asset=assets.get(quoteMint),custom=Number.isSafeInteger(launch.creatorFeeBps)&&launch.creatorFeeBps>0&&launch.creatorFeeBps<=10000?launch.creatorFeeBps:null;
  const image=typeof launch.image==='string'&&/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(launch.image)?launch.image:null;
  const coin={mint,name:label(launch.name),symbol:label(launch.symbol,24),description:label(launch.description,500),image,createdAt,chain:'solana',platform:'pump-classic',launchMode:'pump-classic',curve,poolId,
    quote:native?{mint:SOL,symbol:'SOL',name:'Solana',category:'crypto',decimals:9}:{mint:quoteMint,symbol:quoteLabel(quoteMint,launch.quoteSymbol),name:label(asset?.name||launch.quoteName||launch.quoteSymbol||'Custom pair'),category:asset?.category||launch.quoteCategory||'other',decimals},baseDecimals:6,feeMode:mode,gotchi:mode==='gotchi'?gotchiView(launch.gotchi):null,agent:mode==='agent'?agentView(launch.agent,mint):null,option:optionView(launch,mode),
    creatorFeeBps:custom,creatorFeePolicy:null,postGradCreatorFeeBps:null,taxBps:0,graduationFeeBps:null,totalTradeFeeBps:null,
    links:Object.fromEntries(['website','twitter','telegram'].flatMap(key=>{const href=link(launch[key]);return href?[[key,href]]:[];})),href:'/coin?mint='+mint,explorerUrl:'https://solscan.io/token/'+mint,pumpUrl:'https://pump.fun/coin/'+mint};
  const chainRecord={curve,input:{route:'pump-classic',network:'mainnet-beta',quoteMint,name:coin.name,symbol:coin.symbol,feeMode:mode,taxBps:0},review:{bondingCurve:curve,poolId,quoteDecimals:decimals,quoteProgram:native?'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA':address(launch.quoteProgram),baseDecimals:6},keys:{mint:{address:mint},wallet:{address:curve},payer:{address:curve},platform:{address:curve}}};
  return {coin,chainRecord,rewardRecord:null,creatorEarnings:unavailableCreatorEarnings()};
}

function options(raw={}) {
  const choice=(key,choices,fallback)=>{const value=raw[key]??fallback;if(typeof value!=='string'||!choices.includes(value))fail('Choose a valid '+key+' filter.');return value;};
  const search=raw.search??'',quote=raw.quote??'all';
  if(typeof search!=='string'||search.length>100)fail('Search must be 100 characters or fewer.');
  if(typeof quote!=='string'||quote.length>44)fail('Choose a valid quote asset.');
  const offset=Number(raw.offset??0),limit=Number(raw.limit??20);
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>40)fail('Choose a valid results page.');
  // Tickers are displayed as "$OTTER": a leading $ is part of how people type them, not of the symbol.
  return {search:search.trim().replace(/^\$/,'').trim().toLowerCase(),quote,offset,limit,launchMode:choice('launchMode',['all','pumpswap','raydium','meteora','damm-pump','pump-classic','robinhood'],'all'),stage:choice('stage',['all','new','graduated','moving'],'all'),category:choice('category',['all','crypto','stocks','preipo','other'],'all'),feeMode:choice('feeMode',['all','creator','holders','buyback','gotchi','agent','paycheck'],'all'),age:choice('age',['all','24h','7d'],'all'),sort:choice('sort',['newest','oldest','recentBuys','marketCap','volume','progress','launchType','quote'],'newest'),chain:choice('chain',['all','solana','robinhood'],'all')};
}

function safeSnapshot(raw,record,now,previous) {
  if(raw?.mint!==record.coin.mint||raw.curve!==record.coin.curve||raw.quote?.mint!==record.coin.quote.mint||!['curve','migrating','migrated'].includes(raw.status)||!Number.isSafeInteger(raw.slot)||raw.slot<=0||!timestamp(raw.at)||raw.at>now+5000||now-raw.at>60_000||!positive(raw.supply))throw Error('Invalid public curve snapshot.');
  if(raw.slot<(previous?.slot||0)||previous?.status==='migrated'&&raw.status!=='migrated')throw Error('Public curve snapshot is behind the last verified state.');
  const active=raw.status==='curve',freshQuote=raw.quote.stale===false&&positive(raw.quote.usd)&&timestamp(raw.quote.at)&&raw.quote.at<=now+5000&&now-raw.quote.at<=60_000;
  return {mint:raw.mint,curve:raw.curve,status:raw.status,at:raw.at,slot:raw.slot,source:onchainSource(record.coin),priceQuote:active?positive(raw.priceQuote):null,fdvQuote:active?positive(raw.fdvQuote):null,supply:raw.supply,raisedQuote:nonnegative(raw.raisedQuote),targetQuote:positive(raw.targetQuote),progressPercent:nonnegative(raw.progressPercent)===null?null:Math.min(100,raw.progressPercent),
    quote:{mint:record.coin.quote.mint,symbol:record.coin.quote.symbol,usd:freshQuote?raw.quote.usd:null,at:freshQuote?raw.quote.at:null,source:freshQuote?'Live market reference':'Unavailable',stale:!freshQuote},priceUsd:active&&freshQuote?positive(raw.priceUsd):null,fdvUsd:active&&freshQuote?positive(raw.fdvUsd):null,stale:false,refreshMs:MARKET_TTL,warning:raw.status==='migrating'?'Graduation is completing.':raw.status==='migrated'?'This token has graduated to its AMM market.':freshQuote?'':'USD pricing is unavailable. The chart uses the paired token.',historySource:'Launchpad observations'};
}

function safePool(raw,record) {
  if(raw?.token!==record.coin.mint||!address(raw.address))return null;
  const isBase=raw.base?.address===record.coin.mint&&raw.quote?.address===record.coin.quote.mint,isQuote=raw.quote?.address===record.coin.mint&&raw.base?.address===record.coin.quote.mint;if(!isBase&&!isQuote)return null;
  const priceChange=Object.fromEntries(['m5','h1','h6','h24'].map(key=>[key,isBase&&typeof raw.priceChange?.[key]==='number'&&Number.isFinite(raw.priceChange[key])?raw.priceChange[key]:null]));
  const count=value=>Number.isSafeInteger(value)?nonnegative(value):null;
  const txns=Object.fromEntries(['m5','h1','h6','h24'].map(key=>[key,{buys:count(raw.txns?.[key]?.[isBase?'buys':'sells']),sells:count(raw.txns?.[key]?.[isBase?'sells':'buys'])}]));
  const volume=Object.fromEntries(['m5','h1','h6','h24'].map(key=>[key,nonnegative(raw.volume?.[key])]));
  return {chain:'solana',address:raw.address,token:record.coin.mint,name:record.coin.name,symbol:record.coin.symbol,isBase,dex:label(raw.dex,50),pair:record.coin.symbol+' / '+record.coin.quote.symbol,priceUsd:positive(raw.priceUsd),marketCapUsd:isBase?nonnegative(raw.marketCapUsd):null,fdvUsd:isBase?nonnegative(raw.fdvUsd):null,liquidityUsd:nonnegative(raw.liquidityUsd),volume24h:nonnegative(raw.volume24h),priceChange,txns,volume,url:'https://dexscreener.com/solana/'+raw.address,chart:isBase?'https://dexscreener.com/solana/'+raw.address+'?embed=1&theme=dark&info=0&trades=0':null,base:{address:raw.base.address,symbol:isBase?record.coin.symbol:record.coin.quote.symbol},quote:{address:raw.quote.address,symbol:isBase?record.coin.quote.symbol:record.coin.symbol}};
}

/** Public, host-wide discovery. This service has no signer, account connection,
 * reward action, or transaction-submission interface. */
export class LaunchpadExplore {
  constructor({accounts,pumpPublic=null,meteora=null,dammPump=null,pumpClassic=null,chainFactory,marketData,history,activity,rpcUrl='',jupiterKey=launchpadEnv('PUBLIC_JUPITER_KEY')||'',rpcGate,now=Date.now,listWaitMs=1200,marketWaitMs=3000}={}) {
    if(!accounts?.list||!accounts?.storeFor)throw Error('An account registry is required for Launchpad discovery.');
    Object.assign(this,{accounts,pumpPublic,meteora,dammPump,pumpClassic,chainFactory,now,rpcUrl,jupiterKey});this.ownsRpcGate=!rpcGate;this.rpcGate=rpcGate||new SharedRpcGate();this.ownsMarket=!marketData;this.marketData=marketData||new MarketData({now});this.history=history||new LaunchCurveHistory({now});this.activity=activity||new LaunchCurveActivity({now});this.listWaitMs=Math.min(2000,Math.max(0,listWaitMs));this.marketWaitMs=Math.min(5000,Math.max(0,marketWaitMs));
    this.highs=new Map();this.highsLoaded=false;this.highsWrite=null;this.records=new Map();this.entries=new Map();this.stages=new Map();this.registryAt=0;this.registryLoaded=false;this.registryStale=false;this.pendingRegistry=null;this.starts=[];this.pending=new Map();this.dexPending=new Map();this.activityPending=new Map();this.closed=false;this.cursor=0;this.quoteResolver=new QuoteMetadataResolver({now});this.quoteReferences=new Map();this.quotePending=new Map();this.stagesLoaded=false;this.stageWrite=null;this.stageDirty=false;
    this.rpcRate=operatorCapacity({rpcUrl}).rpcRequestsPerSecond;
    this.refreshMultiplier=Math.max(1,this.rpcRate/8);
    this.nativeQueue=new PublicRefreshQueue({concurrency:MAX_PENDING,perMinute:Math.min(600,Math.floor(MAX_STARTS*this.refreshMultiplier)),now});
    this.owners=new Map();this.registryVersion=0;this.marketVersion=0;this.catalogueCache=null;this.listCache=new Map();this.listPending=new Map();this.inventorySnapshot=null;this.books=new Map();
  }
  async inventory() {
    if(this.closed)fail('Coin discovery is restarting.',503);
    if(this.registryLoaded&&this.now()-this.registryAt<REGISTRY_TTL)return this.records;
    if(this.pendingRegistry)return this.pendingRegistry;
    this.pendingRegistry=(async()=>{
      try{
        if(!this.highsLoaded){this.highsLoaded=true;try{const saved=await this.accounts.hostStore?.read('launch-market-highs',{coins:[]});for(const row of saved?.coins||[])if(address(row.mint)&&timestamp(row.since))this.highs.set(row.mint,{since:row.since,fdvUsd:positive(row.fdvUsd),marketCapUsd:positive(row.marketCapUsd)});}catch{}}
        const accounts=(await this.accounts.list()).filter(account=>creatorProfile(account)),next=new Map(),owners=new Map();let incomplete=false;
        for(let index=0;index<accounts.length;index+=8){
          const batch=accounts.slice(index,index+8),books=await Promise.allSettled(batch.map(account=>this.bookRecords(account)));
          for(const [bookIndex,book] of books.entries()){if(book.status==='rejected'){incomplete=true;continue;}for(const {record,launchId} of book.value){if(!next.has(record.coin.mint)){const creator=batch[bookIndex];record.coin.creator=creatorProfile(creator);next.set(record.coin.mint,record);owners.set(record.coin.mint,{accountId:creator.id,launchId});}}}
        }
        const listed=new Set(accounts.map(account=>account.id));for(const id of this.books.keys())if(!listed.has(id))this.books.delete(id);
        for(const [platform,service,project] of [['pumpswap',this.pumpPublic,pumpDiscoveryRecord],['meteora',this.meteora,meteoraDiscoveryRecord],['damm-pump',this.dammPump,dammPumpDiscoveryRecord],['pump-classic',this.pumpClassic,pumpClassicDiscoveryRecord],['robinhood',this.robinhoodLaunch,robinhoodDiscoveryRecord]]) {
          if(!service)continue;
          try {
            const feed=await service.publicList(),rows=Array.isArray(feed)?feed:feed?.launches;
            if(!Array.isArray(rows))throw Error('Invalid public launch inventory.');
            const creators=new Map(accounts.map(account=>[account.id,account]));
            for(const launch of rows){const creator=creators.get(launch.creatorId),record=creator&&project(launch,this.now());
              if(record&&!next.has(record.coin.mint)){record.coin.creator=creatorProfile(creator);next.set(record.coin.mint,record);owners.set(record.coin.mint,{accountId:creator.id,launchId:launch.id,platform});}}
          }catch{incomplete=true;}
        }
        // A failed storage read is not permission to keep serving potentially
        // removed records. Only successfully resolved confirmed coins survive.
        const walletQuotes=new Map();for(const record of next.values()){const key=record.chainRecord.keys.wallet.address+':'+record.coin.quote.mint;walletQuotes.set(key,(walletQuotes.get(key)||0)+1);}
        for(const record of next.values())if(walletQuotes.get(record.chainRecord.keys.wallet.address+':'+record.coin.quote.mint)>1){
          if(record.rewardRecord)record.rewardRecord.feeCustody='shared';
          if(record.creatorEarnings&&!nativeVenue(record.coin))record.creatorEarnings=unavailableCreatorEarnings(record.creatorEarnings,'This fee wallet is shared across launches, so per-coin earnings cannot be verified.');
        }
        this.records=next;this.owners=owners;this.registryVersion++;this.catalogueCache=null;this.listCache.clear();
        if(!this.stagesLoaded){
          this.stagesLoaded=true;
          try{const saved=await this.accounts.hostStore?.read('launch-explore-stages',null);
            if(saved?.version===1&&Array.isArray(saved.coins)&&saved.coins.length<=10_000){for(const row of saved.coins){const record=next.get(row?.mint);if(record&&row.curve===record.coin.curve&&row.status==='migrated'&&Number.isSafeInteger(row.slot)&&row.slot>0&&timestamp(row.at)&&row.at<=this.now()+5000)this.stages.set(row.mint,{status:'migrated',slot:row.slot,at:row.at,progressPercent:100});}}
          }catch{ /* A cache miss never hides confirmed launches. */ }
        }
        this.registryStale=incomplete;this.registryAt=this.now();this.registryLoaded=true;
        // Keep the detector independent of market updates and record order.
        // Only a complete public inventory can establish an addition/removal;
        // a failed owner read must not announce a temporary disappearance.
        if(!incomplete){
          const identities=[...next.values()].map(({coin})=>[coin.mint,coin.createdAt]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
          this.inventorySnapshot={version:createHash('sha256').update(JSON.stringify(identities)).digest('hex'),total:next.size};
        }
        for(const mint of this.entries.keys())if(!next.has(mint)&&!this.pending.has(mint))this.entries.delete(mint);
        for(const mint of this.stages.keys())if(!next.has(mint))this.stages.delete(mint);
        return this.records;
      }catch{this.registryStale=true;if(!this.registryLoaded)fail('Coin discovery is temporarily unavailable.',503);this.registryAt=this.now();return this.records;}
    })();
    try{return await this.pendingRegistry;}finally{this.pendingRegistry=null;}
  }
  // A launch book is decrypted and projected again only when its file changed (every write replaces the
  // file, so its identity changes) or at least every five minutes; an account without a book costs one
  // stat. Stores without a file path (and any failed read) are read in full every time, as before.
  async bookRecords(account) {
    const store=this.accounts.storeFor(account.id);let revision=null;
    if(typeof store?.path==='function'){
      try{const info=await stat(store.path('launchpad'),{bigint:true});revision=`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;}
      catch(error){if(error?.code!=='ENOENT')throw error;revision='missing';}
    }
    const now=this.now(),cached=revision&&this.books.get(account.id);
    if(cached&&cached.revision===revision&&now>=cached.at&&now-cached.at<BOOK_RECHECK_MS)return structuredClone(cached.rows);
    const book=revision==='missing'?{launches:[]}:await store.read('launchpad',{launches:[]});
    if(!Array.isArray(book?.launches))throw Error('Invalid launch book.');
    const rows=[];for(const launch of book.launches){const record=discoveryRecord(launch,now);if(record)rows.push({record,launchId:launch.id});}
    if(revision){this.books.delete(account.id);this.books.set(account.id,{revision,at:now,rows:structuredClone(rows)});}
    return rows;
  }
  async updates() {
    await this.inventory();
    if(!this.inventorySnapshot)fail('Coin discovery is temporarily unavailable.',503);
    // No coin(), catalogue(), warm(), RPC or market provider call belongs in
    // this inexpensive ten-second poll. The full feed refreshes separately.
    return {...this.inventorySnapshot,stale:this.registryStale,refreshMs:REGISTRY_TTL};
  }
  async chain() {
    if(!this.chainPromise)this.chainPromise=(async()=>{
      const config={network:'mainnet-beta',rpcUrl:this.rpcUrl,jupiterKey:this.jupiterKey,rpcGate:this.rpcGate,rpcScope:'public-explore',rpcRequestsPerSecond:this.rpcRate};
      const chain=this.chainFactory?await this.chainFactory(config):new LaunchChain(config);
      if(!this.chainFactory){try{await chain.init();}catch(error){chain.close?.();throw error;}}
      if(chain.referencePrice){const read=chain.referencePrice.bind(chain);chain.referencePrice=(input,mint)=>{
        const key=input.quoteMint,old=this.quoteReferences.get(key);if(old&&timestamp(old.at)&&old.at<=this.now()&&this.now()-old.at<60_000)return Promise.resolve(old);
        if(this.quotePending.has(key))return this.quotePending.get(key);
        const job=read(input,mint).then(value=>{if(!this.closed&&freshUsdReference(value,key,this.now())){this.quoteReferences.delete(key);this.quoteReferences.set(key,{...value,mint:key});while(this.quoteReferences.size>100)this.quoteReferences.delete(this.quoteReferences.keys().next().value);this.applyQuoteReference(key,value);}return value;}).finally(()=>this.quotePending.delete(key));this.quotePending.set(key,job);return job;
      };}return chain;
    })().catch(error=>{this.chainPromise=null;throw error;});
    return this.chainPromise;
  }
  applyQuoteReference(mint,ref) {
    if(this.closed||!freshUsdReference(ref,mint,this.now()))return;
    let changed=false;
    for(const [token,e] of this.entries){
      const n=e.native,record=this.records.get(token);
      if(record?.coin.quote.mint!==mint||n?.quote.mint!==mint||n.status!=='curve'||n.stale||!timestamp(n.at)||n.at>this.now()+5000||this.now()-n.at>60_000)continue;
      if(n.quote.stale===false&&n.quote.at>=ref.at)continue;
      const usd=Number(ref.usd),priceUsd=positive(n.priceQuote*usd),fdvUsd=positive(n.fdvQuote*usd);
      if(!priceUsd||!fdvUsd)continue;
      // A late USD lookup may enrich a still-fresh verified curve. It must
      // never advance the curve's own timestamp or revive expired reserves.
      e.native={...n,quote:{mint,symbol:record.coin.quote.symbol,usd,at:ref.at,source:'Live market reference',stale:false},priceUsd,fdvUsd,warning:''};changed=true;
    }
    if(changed){this.marketVersion++;this.catalogueCache=null;this.listCache.clear();}
  }
  saveHighs(){
    if(!this.accounts.hostStore?.write)return;this.highsDirty=true;if(this.highsWrite)return;
    this.highsWrite=(async()=>{while(this.highsDirty){this.highsDirty=false;try{await this.accounts.hostStore.write('launch-market-highs',{version:1,coins:[...this.highs].slice(-10000).map(([mint,value])=>({mint,...value}))});}catch{}}})().finally(()=>{this.highsWrite=null;});
  }
  async creator(username,offset=0){
    if(!publicUsername(username))fail('Creator not found.',404);
    const account=(await this.accounts.list()).find(a=>a.username===username),profile=creatorProfile(account);if(!profile)fail('Creator not found.',404);
    const rows=[...(await this.inventory()).values()].filter(r=>r.coin.creator?.username===username).sort((a,b)=>b.coin.createdAt-a.coin.createdAt);
    const start=Number(offset||0);if(!Number.isSafeInteger(start)||start<0||start>10000)fail('Invalid profile page.',400);
    const page=rows.slice(start,start+24);await this.warm(page);
    return {profile,coins:page.map(r=>this.coin(r)),total:rows.length,offset:start,limit:24};
  }
  async users(raw={}){
    const search=raw.search??'',offset=Number(raw.offset??0),limit=Number(raw.limit??12);
    if(typeof search!=='string'||search.length>100)fail('Search must be 100 characters or fewer.');
    if(!Number.isSafeInteger(offset)||offset<0||offset>10000||!Number.isSafeInteger(limit)||limit<1||limit>20)fail('Choose a valid user results page.');
    const query=search.trim().replace(/^@/,'').toLowerCase();
    if(!query)return {users:[],total:0,offset,limit,nextOffset:null};
    // Public usernames are intentionally searchable. Never match private
    // account IDs, wallets, email addresses, security settings or API keys.
    // Administrator usernames are not listed: they would hand out the sign-in names of privileged accounts.
    const profiles=(await this.accounts.list()).filter(account=>account?.role!=='admin').map(creatorProfile).filter(profile=>profile&&profile.username.includes(query));
    profiles.sort((a,b)=>Number(b.username===query)-Number(a.username===query)||Number(b.username.startsWith(query))-Number(a.username.startsWith(query))||a.username.localeCompare(b.username));
    const page=profiles.slice(offset,offset+limit),counts=new Map(page.map(profile=>[profile.username,0]));
    if(page.length){for(const {coin} of (await this.inventory()).values())if(counts.has(coin.creator?.username))counts.set(coin.creator.username,counts.get(coin.creator.username)+1);}
    return {users:page.map(profile=>({...profile,launchCount:counts.get(profile.username)})),total:profiles.length,offset,limit,nextOffset:offset+limit<profiles.length?offset+limit:null};
  }
  saveStages() {
    if(!this.accounts.hostStore?.write)return;this.stageDirty=true;if(this.stageWrite)return;
    this.stageWrite=(async()=>{while(this.stageDirty){this.stageDirty=false;const coins=[...this.stages].filter(([mint,state])=>state.status==='migrated'&&this.records.has(mint)).sort((a,b)=>b[1].at-a[1].at).slice(0,10_000).map(([mint,state])=>({mint,curve:this.records.get(mint).coin.curve,status:'migrated',slot:state.slot,at:state.at}));try{await this.accounts.hostStore.write('launch-explore-stages',{version:1,coins});}catch{ /* Derived discovery data is safe to rebuild onchain. */ }}})().finally(()=>{this.stageWrite=null;});
  }
  entry(mint){let entry=this.entries.get(mint);if(!entry){entry={at:0,retryAt:0,failures:0,native:null,pool:null,dexAt:0,points:[]};this.entries.set(mint,entry);while(this.entries.size>MAX_MARKETS){const victim=[...this.entries.keys()].find(key=>key!==mint&&!this.pending.has(key)&&!this.dexPending.has(key));if(!victim)break;this.entries.delete(victim);}}return entry;}
  observeDex(record,entry) {
    const mint=record.coin.mint;
    if(this.dexPending.has(mint))return this.dexPending.get(mint);
    if(this.closed||this.dexPending.size>=MAX_PENDING||entry.dexCheckedAt&&this.now()-entry.dexCheckedAt<MARKET_TTL)return;
    // DEX indexing is optional enrichment. A slow response must neither hold
    // back a verified curve nor consume the native reader's concurrency slots.
    const job=(async()=>{
      try{
        const dex=await this.marketData.pools('solana',mint);
        if(dex?.tokenAddress!==mint||!timestamp(dex.at)||dex.at>this.now()+5000||this.now()-dex.at>300_000)throw Error('Invalid market response.');
        entry.pool=(Array.isArray(dex.pools)?dex.pools:[]).map(pool=>safePool(pool,record)).filter(Boolean).sort((a,b)=>(b.liquidityUsd||0)-(a.liquidityUsd||0))[0]||null;
        entry.dexAt=dex.at;entry.dexStale=dex.stale===true;
      }catch{entry.dexStale=true;}
      finally{entry.dexCheckedAt=this.now();this.marketVersion++;}
    })().finally(()=>this.dexPending.delete(mint));
    this.dexPending.set(mint,job);return job;
  }
  nativeService(record) { return record.coin.platform==='pump-classic'?this.pumpClassic:record.coin.platform==='damm-pump'?this.dammPump:record.coin.platform==='meteora'?this.meteora:this.pumpPublic; }
  async pumpActivity(record) { return this.nativeActivity(record); }
  async nativeActivity(record) {
    const raw = await this.nativeService(record).trades(record.coin.mint), now = this.now();
    const rows = (Array.isArray(raw) ? raw : raw?.trades || []).slice(0, 200).flatMap(row => {
      const time = timestamp(row.time) || (timestamp(row.at) ? Math.floor(row.at / 1000) : null);
      if (!time || time > Math.floor(now / 1000) + 60 || time < Math.floor((now - 86400000) / 1000) || !['buy','sell'].includes(row.side) || !address(row.wallet) || !positive(row.amount) || !positive(row.quote) || typeof row.signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(row.signature)) return [];
      return [{ time, side: row.side, quote: row.quote, amount: row.amount, wallet: row.wallet, signature: row.signature }];
    });
    const windows = Object.fromEntries([['m5',300],['h1',3600],['h24',86400]].map(([key,seconds]) => { const selected=rows.filter(row=>row.time>Math.floor(now/1000)-seconds);return [key,{quote:selected.reduce((total,row)=>total+row.quote,0),buys:selected.filter(row=>row.side==='buy').length,sells:selected.filter(row=>row.side==='sell').length,complete:false}]; }));
    return { poolId: record.coin.curve, at: now, source: tradeSource(record.coin), windows, complete: false, stale: false, trades: rows };
  }
  observeActivity(record,entry) {
    const mint=record.coin.mint;
    if(this.activityPending.has(mint))return this.activityPending.get(mint);
    // LaunchCurveActivity owns the provider concurrency/rate budget. Keep this
    // outer map bounded while allowing distinct coins to take their FIFO turn.
    if(this.closed||this.activityPending.size>=200||entry.activityCheckedAt&&this.now()-entry.activityCheckedAt<MARKET_TTL)return;
    const job=(async()=>{try{
      let data=nativeVenue(record.coin)?await this.nativeActivity(record):await this.activity.read(record.coin.curve);
      // The activity reader returns promptly while its shared job continues.
      // Consume that job's completed result instead of caching the old/null
      // result for another full refresh interval.
      const pending=this.activity.pending?.get(record.coin.curve);
      if(pending)data=await pending;
      if(this.closed||!this.records.has(mint))return;
      if(data?.poolId!==record.coin.curve||!timestamp(data.at)||data.at>this.now()+5000||this.now()-data.at>15*60_000)throw Error('Invalid launch activity.');
      for(const key of ['m5','h1','h24']){const w=data.windows?.[key];if(nonnegative(w?.quote)===null||!Number.isSafeInteger(w.buys)||w.buys<0||!Number.isSafeInteger(w.sells)||w.sells<0||typeof w.complete!=='boolean')throw Error('Invalid launch volume.');}
      entry.activity={at:data.at,windows:data.windows,trades:data.trades||[],stale:data.stale===true||this.now()-data.at>60_000};
    }catch{if(entry.activity&&this.now()-entry.activity.at<=15*60_000)entry.activity={...entry.activity,stale:true};else entry.activity=null;}finally{entry.activityCheckedAt=this.now();this.marketVersion++;}})().finally(()=>this.activityPending.delete(mint));
    this.activityPending.set(mint,job);return job;
  }
  observe(record) {
    const mint=record.coin.mint,entry=this.entry(mint),now=this.now();
    this.nativeQueue.drain();
    if(this.pending.has(mint))return this.pending.get(mint);
    if(entry.retryAt>now||entry.at&&now-entry.at<MARKET_TTL)return Promise.resolve(entry);
    if(this.closed)return Promise.resolve(entry);
    const scheduled=this.nativeQueue.run(async()=>{
      if(this.closed||!this.records.has(mint))return entry;
      void this.observeDex(record,entry);void this.observeActivity(record,entry);
      try{
        const chain=nativeVenue(record.coin)?null:await this.chain();
        // Resolve unknown quote identities in the background, independently of
        // the verified pricing snapshot and without reading offchain URIs.
        if(chain)void this.quoteResolver.read(chain.c,record.coin.quote.mint,{fallbackSymbol:record.coin.quote.symbol}).then(identity=>{record.coin.quote.symbol=quoteLabel(identity.mint,identity.symbol);if(identity.name)record.coin.quote.name=identity.name;}).catch(()=>{});
        const native=safeSnapshot(nativeVenue(record.coin)?await this.nativeService(record).marketSnapshot(mint):await chain.marketSnapshot(record.chainRecord,{quoteReference:entry.native?.quote}),record,this.now(),entry.native||this.stages.get(mint));
        entry.native=native;entry.nativeError=null;
        this.applyQuoteReference(record.coin.quote.mint,this.quoteReferences.get(record.coin.quote.mint));
        if(entry.wantsHistory)void this.observeHistory(record,entry);
        const previousStage=this.stages.get(mint);this.stages.set(mint,{status:native.status,slot:native.slot,at:native.at,progressPercent:native.progressPercent});
        if(native.status==='migrated'&&previousStage?.status!=='migrated')this.saveStages();
        if(native.status==='curve'&&positive(native.priceQuote)){
          const point={time:Math.floor(native.at/1000),priceQuote:native.priceQuote,slot:native.slot},last=entry.points.at(-1);
          if(!last||point.slot>last.slot&&point.time>=last.time){if(last?.time===point.time)entry.points.pop();entry.points.push(point);entry.points=entry.points.filter(row=>row.time>Math.floor((this.now()-86_400_000)/1000)).slice(-MAX_POINTS);}
        }
        entry.failures=0;entry.retryAt=0;
      }catch(error){
        // Provider messages may contain credential URLs. Only fixed diagnostic
        // codes reach the public DTO; strict snapshot checks still fail closed.
        entry.nativeError=/launch (?:curve|market)|public curve snapshot/i.test(String(error?.message||''))?'curve_verification_failed':'rpc_unavailable';
        if(entry.native)entry.native={...entry.native,stale:true,warning:'Showing the last verified curve data. Refreshing automatically.'};
        entry.failures++;entry.retryAt=this.now()+Math.min(120_000,15_000*2**Math.min(3,entry.failures));
      }
      entry.at=this.now();this.marketVersion++;return entry;
    });
    if(!scheduled)return Promise.resolve(entry);
    const job=scheduled.catch(()=>entry).finally(()=>this.pending.delete(mint));
    Object.defineProperty(job,'started',{get:()=>scheduled.started});
    this.pending.set(mint,job);return job;
  }
  async observeFocused(record,waitMs=this.marketWaitMs) {
    const job=this.observe(record);if(job.started===false)return;
    await boundedRefresh(job,()=>this.entries.get(record.coin.mint),waitMs);
  }
  async warm(records,{wait=this.listWaitMs,max=12}={}) {
    const candidates=records.filter(record=>record.coin.chain!=='robinhood').filter(record=>{const entry=this.entries.get(record.coin.mint);return !entry||this.pending.has(record.coin.mint)||!entry.at||this.now()-entry.at>=MARKET_TTL&&this.now()>=entry.retryAt;}).slice(0,max);
    const work=Promise.allSettled(candidates.map(record=>this.observe(record)));if(wait>0)await boundedRefresh(work,()=>null,wait);
  }
  coin(record) {
    if(record.coin.chain==='robinhood')return this.robinhoodCoin(record);
    const e=this.entries.get(record.coin.mint),native=e?.native,pool=e?.pool,curveStale=!native||native.stale||this.now()-native.at>MARKET_TTL*2,dexStale=!pool||e.dexStale||this.now()-e.dexAt>120_000;
    const currentNative=native?.status==='curve'&&!curveStale,stage=native||this.stages.get(record.coin.mint);
    const eligible=!!stage&&!curveStale&&stage.status!=='migrated',progressMoving=eligible&&!curveStale&&native.progressPercent>=35;
    const nativeUsdFresh=currentNative&&freshUsdReference(native.quote,record.coin.quote.mint,this.now());
    const activity=e?.activity&&!e.activity.stale&&this.now()-e.activity.at<=60_000?e.activity:null,quoteUsd=nativeUsdFresh?positive(native.quote.usd):null;
    // Activity is matched to this curve by observeActivity. These are observed
    // launch-curve buys only; a missing buy is never replaced by creation time,
    // a sell, or an aggregate DEX transaction count.
    const lastBuyAt=(Array.isArray(activity?.trades)?activity.trades:[]).reduce((latest,trade)=>trade?.side==='buy'&&Number.isSafeInteger(trade.time)&&trade.time>=1_500_000_000&&trade.time*1000<=this.now()+60_000&&trade.time*1000>this.now()-86_400_000?Math.max(latest||0,trade.time*1000):latest,null);
    const curveWindows=activity?.windows,fullCurve=currentNative&&curveWindows?.h24.complete;
    const useCurve=fullCurve||currentNative&&dexStale&&!!activity;
    const volumeQuote=useCurve?curveWindows.h24.quote:null,volumeUsd=useCurve&&quoteUsd?nonnegative(volumeQuote*quoteUsd):null;
    const volumeComplete=useCurve?curveWindows.h24.complete:!dexStale&&nonnegative(pool?.volume24h)!==null;
    const liveCurveWindows=currentNative&&curveWindows?.m5.complete&&curveWindows.h1.complete&&quoteUsd;
    const m5=liveCurveWindows?curveWindows.m5.quote*quoteUsd:!dexStale?pool?.volume?.m5:null,h1=liveCurveWindows?curveWindows.h1.quote*quoteUsd:!dexStale?pool?.volume?.h1:null;
    const prior=nonnegative(h1)!==null&&nonnegative(m5)!==null?h1-m5:null,recentTrades=liveCurveWindows?curveWindows.m5.buys+curveWindows.m5.sells:!dexStale?(pool.txns.m5.buys??0)+(pool.txns.m5.sells??0):0;
    const acceleration=eligible&&prior>0&&m5>=100&&recentTrades>=3?m5*11/prior:null,volumeMoving=acceleration!==null&&acceleration>=2;
    const movingReason=progressMoving&&volumeMoving?'both':progressMoving?'progress':volumeMoving?'volume':null;
    const amount=useCurve?volumeUsd:!dexStale?pool.volume24h:null;
    const fdv=(nativeUsdFresh?positive(native.fdvUsd):null)??(!dexStale?pool.fdvUsd:null),cap=!dexStale?pool.marketCapUsd:null;
    const priceUsd=(nativeUsdFresh?positive(native.priceUsd):null)??(!dexStale?pool.priceUsd:null);
    const dexUsd=!dexStale&&!(nativeUsdFresh&&(positive(native.priceUsd)||positive(native.fdvUsd)))&&(priceUsd!==null||fdv!==null||cap!==null);
    let high=this.highs.get(record.coin.mint);if(positive(fdv)||positive(cap)){high||={since:this.now(),fdvUsd:null,marketCapUsd:null};let changed=false;for(const [key,value]of [['fdvUsd',fdv],['marketCapUsd',cap]])if(positive(value)&&value>(high[key]||0)){high[key]=value;changed=true;}if(changed){this.highs.set(record.coin.mint,high);this.saveHighs();}}
    return {...record.coin,trackedAthFdvUsd:high?.fdvUsd||null,trackedAthMarketCapUsd:high?.marketCapUsd||null,athTrackedSince:high?.since||null,athComplete:false,stage:stage?.status==='migrated'?'graduated':'new',curveStatus:stage?.status||null,movingReason,volumeAcceleration:acceleration,lastBuyAt,marketCapUsd:cap,fdvUsd:fdv,priceUsd,priceQuote:currentNative?native.priceQuote:null,fdvQuote:currentNative?native.fdvQuote:null,supply:native?.supply||null,
      volume24h:volumeComplete?amount:null,volume24hQuote:volumeComplete?volumeQuote:null,volumeObserved:volumeComplete?null:amount,volumeObservedQuote:volumeComplete?null:volumeQuote,volumeUsdEstimate:useCurve&&quoteUsd!==null,volumeSource:useCurve?tradeSource(record.coin):!dexStale?'DEX Screener':null,volumeAt:useCurve?activity.at:!dexStale?e.dexAt:null,volumeComplete,
      buys24h:useCurve&&volumeComplete?curveWindows.h24.buys:!dexStale?pool.txns.h24.buys:null,sells24h:useCurve&&volumeComplete?curveWindows.h24.sells:!dexStale?pool.txns.h24.sells:null,
      liquidityUsd:pool&&!dexStale?pool.liquidityUsd:null,priceChange24h:pool&&!dexStale?pool.priceChange.h24:null,progressPercent:stage?.progressPercent??null,marketAt:dexUsd?e.dexAt:currentNative?native.at:pool?e.dexAt:native?.at||null,marketSource:dexUsd?'DEX Screener':currentNative?onchainSource(record.coin):pool?'DEX Screener':null,stale:curveStale&&dexStale,stageStale:curveStale};
  }

  /** A Robinhood coin's row: the venue service's live numbers (its pool reading and trade journal), no Solana state. */
  robinhoodCoin(record) {
    const live=record.coin.live||{},graduated=record.coin.status==='graduated'||live.graduated===true;
    const cap=positive(live.marketCapUsd),priceUsd=positive(live.priceUsd),progress=nonnegative(live.progressPercent),volume=nonnegative(live.volume24hUsd),lastBuyAt=timestamp(live.lastBuyAt);
    let high=this.highs.get(record.coin.mint);if(positive(cap)){high||={since:this.now(),fdvUsd:null,marketCapUsd:null};if(cap>(high.marketCapUsd||0)){high.marketCapUsd=cap;high.fdvUsd=cap;this.highs.set(record.coin.mint,high);this.saveHighs();}}
    const {live:_live,...coin}=record.coin;
    return {...coin,trackedAthFdvUsd:high?.fdvUsd||null,trackedAthMarketCapUsd:high?.marketCapUsd||null,athTrackedSince:high?.since||null,athComplete:false,stage:graduated?'graduated':'new',curveStatus:graduated?'migrated':'curve',movingReason:!graduated&&progress!==null&&progress>=35?'progress':null,volumeAcceleration:null,lastBuyAt,marketCapUsd:cap,fdvUsd:cap,priceUsd,priceQuote:live.priceQuote??null,fdvQuote:null,
      volume24h:volume,volume24hQuote:nonnegative(live.volume24hQuote),volumeObserved:null,volumeObservedQuote:null,volumeUsdEstimate:false,volumeSource:'Launchpad trade journal',volumeAt:timestamp(live.marketAt),volumeComplete:true,buys24h:nonnegative(live.buys24h),sells24h:nonnegative(live.sells24h),
      liquidityUsd:null,priceChange24h:null,progressPercent:graduated?100:progress,holders:nonnegative(live.holders),marketAt:timestamp(live.marketAt),marketSource:'Uniswap v4 pool',stale:!live.marketAt,stageStale:false};
  }
  catalogue() {
    const old=this.catalogueCache;
    if(old&&old.registryVersion===this.registryVersion&&old.marketVersion===this.marketVersion&&this.now()-old.at<2000)return old;
    const records=[...this.records.values()],coins=records.map(record=>this.coin(record));
    const quotes=[...new Map(records.map(record=>[record.coin.quote.mint,record.coin.quote])).values()].sort((a,b)=>a.symbol.localeCompare(b.symbol));
    return this.catalogueCache={registryVersion:this.registryVersion,marketVersion:this.marketVersion,at:this.now(),records,coins,quotes};
  }
  async list(raw={}) {
    const filters=options(raw);await this.inventory();
    const key=JSON.stringify(filters),version=this.registryVersion,cached=this.listCache.get(key);
    if(cached&&cached.version===version&&cached.until>this.now())return structuredClone(cached.value);
    const existing=this.listPending.get(key);if(existing?.version===version)return structuredClone(await existing.promise);
    if(this.listPending.size>=100)fail('Coin discovery is busy. Try again shortly.',503);
    const state={version,promise:null};
    state.promise=this.buildList(filters).then(value=>{
      // Moderation invalidation takes precedence over an in-flight public read.
      if(version!==this.registryVersion)return this.list(filters);
      this.listCache.delete(key);this.listCache.set(key,{version,until:this.now()+2000,value});
      while(this.listCache.size>100)this.listCache.delete(this.listCache.keys().next().value);
      return value;
    }).finally(()=>{if(this.listPending.get(key)===state)this.listPending.delete(key);});
    this.listPending.set(key,state);return structuredClone(await state.promise);
  }
  async buildList(filters) {
    const catalogue=this.catalogue(),inLaunchMode=coin=>filters.launchMode==='all'||(coin.launchMode||coin.platform||'raydium')===filters.launchMode,records=catalogue.records.filter(record=>inLaunchMode(record.coin));
    const match=coin=>inLaunchMode(coin)&&(filters.chain==='all'||coin.chain===filters.chain)&&(!filters.search||[coin.name,coin.symbol].some(text=>text.toLowerCase().includes(filters.search))||mintMatches(coin.mint,filters.search))&&(filters.quote==='all'||coin.quote.mint===filters.quote||coin.quote.symbol.toLowerCase()===filters.quote.toLowerCase())&&(filters.category==='all'||coin.quote.category===filters.category)&&(filters.feeMode==='all'||coin.feeMode===filters.feeMode)&&(filters.age==='all'||coin.createdAt>=this.now()-(filters.age==='24h'?86_400_000:604_800_000));
    const sort=(a,b)=>{
      if(filters.sort==='oldest')return a.createdAt-b.createdAt||a.mint.localeCompare(b.mint);
      if(filters.sort==='recentBuys'){
        if(a.lastBuyAt===null&&b.lastBuyAt!==null)return 1;
        if(b.lastBuyAt===null&&a.lastBuyAt!==null)return -1;
        if(a.lastBuyAt!==null&&b.lastBuyAt!==null&&a.lastBuyAt!==b.lastBuyAt)return b.lastBuyAt-a.lastBuyAt;
      }
      if(filters.sort==='launchType')return a.feeMode.localeCompare(b.feeMode)||a.mint.localeCompare(b.mint);
      if(filters.sort==='quote')return a.quote.symbol.localeCompare(b.quote.symbol)||a.mint.localeCompare(b.mint);
      if(['marketCap','volume','progress'].includes(filters.sort)){const key={marketCap:'valuation',volume:'volume24h',progress:'progressPercent'}[filters.sort],av=key==='valuation'?a.marketCapUsd??a.fdvUsd:a[key],bv=key==='valuation'?b.marketCapUsd??b.fdvUsd:b[key];if(av===null&&bv!==null)return 1;if(bv===null&&av!==null)return -1;if(av!==null&&bv!==null&&av!==bv)return bv-av;}
      return b.createdAt-a.createdAt||a.mint.localeCompare(b.mint);
    };
    const desired=catalogue.coins.filter(match).sort(sort),inStage=coin=>filters.stage==='all'||(filters.stage==='moving'?coin.movingReason!==null:coin.stage===filters.stage);
    const visible=desired.filter(inStage).slice(filters.offset,filters.offset+filters.limit),priorities=[...new Map([...visible,...desired.filter(coin=>coin.curveStatus===null)].map(coin=>[coin.mint,this.records.get(coin.mint)])).values()];
    // Warm a bounded visible window and rotate the remaining catalogue. Reads
    // share host caches and cannot turn many public viewers into RPC fan-out.
    const work=this.warm(priorities);await work;
    if(records.length){const rotated=records.slice(this.cursor).concat(records.slice(0,this.cursor));this.cursor=(this.cursor+3)%records.length;void this.warm(rotated,{wait:0,max:3});}
    const latest=this.catalogue(),matched=latest===catalogue?desired:latest.coins.filter(match).sort(sort),counts={all:matched.length,new:0,graduated:0,moving:0};
    for(const coin of matched){counts[coin.stage]++;if(coin.movingReason!==null)counts.moving++;}
    const coins=matched.filter(inStage),total=coins.length,quotes=latest.quotes;
    const page=coins.slice(filters.offset,filters.offset+filters.limit),refreshing=page.some(coin=>this.pending.has(coin.mint)||this.quotePending.has(coin.quote.mint)||this.activityPending.has(coin.mint));
    return {coins:page,total,offset:filters.offset,limit:filters.limit,nextOffset:filters.offset+filters.limit<total?filters.offset+filters.limit:null,counts,quotes,at:this.now(),refreshing,refreshMs:refreshing?3000:MARKET_TTL,stale:this.registryStale,coverage:{observed:matched.filter(coin=>coin.curveStatus!==null).length,total:matched.length},scope:'Launchpad launches on this host'};
  }
  async directPumpRecord(mint,options={}) { return this.directNativeRecord(mint,{...options,platform:'pumpswap'}); }
  async directNativeRecord(mint,{trading=false,owner=null,platform=null}={}) {
    // Hiding a public launch never prevents holders opening or exiting it.
    for(const [mode,service,project]of [['pumpswap',this.pumpPublic,pumpDiscoveryRecord],['meteora',this.meteora,meteoraDiscoveryRecord],['damm-pump',this.dammPump,dammPumpDiscoveryRecord],['pump-classic',this.pumpClassic,pumpClassicDiscoveryRecord]]){
      if(platform&&platform!==mode||typeof service?.publicDetail!=='function')continue;
      const launch=await service.publicDetail(mint);if(!launch)continue;
      if(launch.mint!==mint||!launch.creatorId||owner&&launch.creatorId!==owner.accountId)fail('This Launchpad coin was not found.',404);
      const creator=this.accounts.get?await this.accounts.get(launch.creatorId):(await this.accounts.list()).find(row=>row.id===launch.creatorId),profile=creatorProfile(creator);
      if(!profile)fail(trading?'This Launchpad coin is not available for trading.':'This Launchpad coin was not found.',trading?403:404);
      const record=project(launch,this.now(),{includeHidden:true});if(!record)fail('This Launchpad coin was not found.',404);
      if(this.accounts.assertWalletAllowed&&creator.mainWallet)await this.accounts.assertWalletAllowed(creator.mainWallet);
      record.coin.creator=profile;return record;
    }
    fail('This Launchpad coin was not found.',404);
  }
  async find(mint) {if(!address(mint))fail('Enter a valid token mint.');return (await this.inventory()).get(mint)||this.directNativeRecord(mint);}
  async findForTrade(mint) {
    if(!address(mint))fail('Enter a valid token mint.');
    await this.inventory();let owner=this.owners.get(mint);
    // A newly published mint may not be in the ten-second discovery snapshot.
    if(!owner){if(this.pendingRegistry)await this.pendingRegistry;this.registryLoaded=false;await this.inventory();owner=this.owners.get(mint);}
    if(!owner)return this.directNativeRecord(mint,{trading:true});
    if(['pumpswap','meteora','damm-pump','pump-classic'].includes(owner.platform))return this.directNativeRecord(mint,{trading:true,owner,platform:owner.platform});
    let creator,book;
    try{[creator,book]=await Promise.all([this.accounts.get?this.accounts.get(owner.accountId):this.accounts.list().then(rows=>rows.find(row=>row.id===owner.accountId)),this.accounts.storeFor(owner.accountId).read('launchpad',null)]);}
    catch{fail('Coin availability is temporarily unavailable. Try again shortly.',503);}
    if(!creator||creator.banned)fail('This Launchpad coin is not available for trading.',403);
    if(!book||!Array.isArray(book.launches))fail('Coin availability is temporarily unavailable. Try again shortly.',503);
    // Only the owner location is cached. Current moderation and launch identity
    // are always read from that owner's fresh journal before building a trade.
    const launch=book.launches.find(row=>row.id===owner.launchId&&row.keys?.mint?.address===mint),record=discoveryRecord(launch,this.now());
    if(!record)fail('This Launchpad coin was not found.',404);
    if(this.accounts.assertWalletAllowed&&creator.mainWallet)await this.accounts.assertWalletAllowed(creator.mainWallet);
    record.coin.creator={username:label(creator.username,32),bio:label(creator.bio,280),avatar:typeof creator.avatar==='string'&&/^\/token-images\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(creator.avatar)?creator.avatar:null};
    return record;
  }
  async token(mint) {
    const record=await this.find(mint),previous=this.entries.get(mint);
    if(previous?.native||previous?.pool)void this.observe(record);else await this.observeFocused(record,this.listWaitMs);
    const coin=this.coin(record),refreshing=this.pending.has(mint);
    if(record.creatorEarnings)coin.creatorEarnings=structuredClone(record.creatorEarnings);
    return {coin,refreshing};
  }
  async rewards(mint) {const record=await this.find(mint);if(record.coin.platform==='meteora')return this.meteora.publicRewards(mint);if(['pumpswap','damm-pump','pump-classic'].includes(record.coin.platform))return {mint,mode:'none',holder:null,buyback:null,refreshMs:30000};if(record.coin.feeMode==='gotchi')return {mint:record.coin.mint,mode:'gotchi',gotchi:record.coin.gotchi,quote:{mint:record.coin.quote.mint,symbol:record.coin.quote.symbol},taxBps:record.coin.taxBps,enabled:true,status:'ready',holder:null,buyback:null,refreshMs:30_000};if(record.coin.feeMode==='agent')return {mint:record.coin.mint,mode:'agent',agent:record.coin.agent,quote:{mint:record.coin.quote.mint,symbol:record.coin.quote.symbol},taxBps:0,enabled:true,status:'ready',holder:null,buyback:null,refreshMs:30_000};if(!record.rewardRecord)return {mint:record.coin.mint,mode:'creator',holder:null,buyback:null,refreshMs:30_000};this.rewardView ||= new PublicLaunchRewards({chainFor:()=>this.chain(),now:this.now});return this.rewardView.read(record.rewardRecord,this.coin(record));}
  async trades(mint) {
    const record=await this.find(mint);if(nativeVenue(record.coin)){const data=await this.nativeActivity(record);return {mint,quote:record.coin.quote,at:data.at,trades:data.trades.slice(0,100),available:true,stale:false,refreshing:false,complete:false,source:tradeSource(record.coin),note:record.coin.platform==='pump-classic'?'Recent confirmed Pump.fun curve and PumpSwap trades, read onchain. Only the latest trades are shown.':'Recent confirmed trades submitted through Launchpad. External trades and post-graduation pool trades are not included.',refreshMs:30000};}const data=await this.activity.read(record.coin.curve);
    const refreshing=!!this.activity.pending?.has(record.coin.curve);
    return {mint,quote:record.coin.quote,at:data?.at||null,trades:data?.trades?.slice(0,100)||[],available:!!data,stale:data?.stale===true,refreshing,complete:!!data?.complete,source:'Raydium launch curve',note:(!data&&refreshing?'Trade history is loading. Updates will appear automatically. ':data?.stale?'Showing previously verified trades while history refreshes. ':'')+'Recent curve trades from the last 24 hours, up to 100 shown. Post-graduation pool trades are not included.',refreshMs:data?.stale||refreshing?10000:30000};
  }
  async holders(mint) {
    const record=await this.find(mint);
    this.publicHolders ||= new PublicCoinHolders({chain:()=>this.chain(),now:this.now,requestsPerMinute:Math.min(600,Math.floor(30*this.refreshMultiplier))});
    return this.publicHolders.read(mint,record.chainRecord);
  }
  observeHistory(record,e) {
    if(nativeVenue(record.coin))return Promise.resolve();
    if(e.historyPending)return e.historyPending;
    if(this.now()<(e.historyRetryAt||0))return Promise.resolve();
    const work=(async()=>{
      let received=false;
      try{
        const data=await this.history.read(record.coin.curve);
        if(data?.candles?.length){
          if(data.at!=null&&(!timestamp(data.at)||data.at>this.now()+5000))throw Error('Invalid history timestamp.');
          const candles=data.candles.filter(row=>timestamp(row.time)&&row.time<=Math.floor(this.now()/1000)+60&&['open','high','low','close'].every(key=>positive(row[key]))&&row.low<=Math.min(row.open,row.close)&&row.high>=Math.max(row.open,row.close)&&(row.volume==null||nonnegative(row.volume)!==null)).slice(-300).map(row=>({time:row.time,open:row.open,high:row.high,low:row.low,close:row.close,volume:row.volume}));
          if(candles.length){e.history={candles,at:timestamp(data.at),checkedAt:this.now(),stale:data.stale===true||!timestamp(data.at)};received=true;}
        }
      }catch{}
      if(!received&&e.history)e.history={...e.history,stale:true};
      e.historyRetryAt=this.now()+(e.history?.stale?10000:MARKET_TTL);
    })().finally(()=>{e.historyPending=null;});
    e.historyPending=work;return work;
  }
  async market(mint) {
    const record=await this.find(mint),previous=this.entries.get(mint),hadSnapshot=!!(previous?.native||previous?.pool);
    this.entry(mint).wantsHistory=true;
    if(hadSnapshot)void this.observe(record);else await this.observeFocused(record);
    const e=this.entries.get(mint);let candles=[],historyStale=false;
    if(e?.native){
      const history=this.observeHistory(record,e);if(!hadSnapshot)await history;
      if(e.history&&this.now()-(e.history.at??e.history.checkedAt)<15*60_000){candles=e.history.candles;historyStale=!!e.historyPending||e.history.stale||this.now()-e.history.at>60_000;}
    }
    const refreshing=this.pending.has(mint)||this.quotePending.has(record.coin.quote.mint),coin=this.coin(record),visibleCoin=coin;
    if(record.creatorEarnings)visibleCoin.creatorEarnings=structuredClone(record.creatorEarnings);
    const native=e?.native?{...e.native,stale:visibleCoin.stageStale,points:e.points.map(row=>({...row})),candles,historyAt:e.history?.at??null,historyStale,trades:e.activity?.trades||[],tradesStale:e.activity?.stale===true||!!e.activity&&this.now()-e.activity.at>60_000,candleSource:candles.length?'Raydium history':null}:null;
    return {coin:visibleCoin,native,nativeError:e?.nativeError||null,pool:e?.pool?{...e.pool,stale:!!e.dexStale||this.now()-e.dexAt>120_000,at:e.dexAt}:null,at:this.now(),refreshMs:refreshing||e?.historyPending||historyStale?10000:MARKET_TTL,refreshing,stale:visibleCoin.stale};
  }
  async close() {this.closed=true;this.nativeQueue.close();this.history.close?.();this.activity.close?.();await Promise.allSettled([...this.pending.values(),...this.dexPending.values(),...this.activityPending.values(),...[...this.entries.values()].map(entry=>entry.historyPending),this.pendingRegistry].filter(Boolean));await this.rewardView?.close();await this.publicHolders?.close();await this.quoteResolver.close();await this.stageWrite;await this.highsWrite;try{(await this.chainPromise)?.close?.();}catch{}if(this.ownsMarket)this.marketData.close?.();if(this.ownsRpcGate)this.rpcGate.close();this.entries.clear();this.records.clear();this.owners.clear();this.stages.clear();this.listCache.clear();this.books.clear();}
}
