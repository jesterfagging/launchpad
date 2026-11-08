import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { createPublicClient, custom, decodeEventLog, encodeEventTopics, formatUnits, parseAbi } from 'viem';
import liquiditySdks from './liquidity-sdks.cjs';
import { CONTRACTS, erc20Abi, poolAbi, poolId, ponsAbi } from './robinhood-contracts.mjs';
import { pairAbi, v3PoolAbi, curveAbi } from './robinhood-legacy-contracts.mjs';
import { readLegacyPool, readCurve } from './robinhood-legacy-pools.mjs';

const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const positive = n => Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : null;
const validRaw = n => typeof n === 'string' && /^\d{1,78}$/.test(n);
const number = n => { const value=Number(n); return Number.isFinite(value) ? value : null; };
const unsupported = message => Object.assign(Error(message), { unsupported: true });
const address = value => new PublicKey(value).toBase58();
const key = value => String(value?.pubkey || value);
const lower = value => String(value || '').toLowerCase();
const opposite = (a,b) => a > 0n && b < 0n || a < 0n && b > 0n;
const abs = n => n < 0n ? -n : n;
const anchor = names => new Set(names.map(name=>createHash('sha256').update('global:'+name).digest('hex').slice(0,16)));
const signatures = {
  cpmm:anchor(['swap_base_input','swap_base_output']), clmm:anchor(['swap','swap_v2']),
  launchlab:anchor(['buy_exact_in','buy_exact_out','sell_exact_in','sell_exact_out']),
  pump:anchor(['buy','buy_exact_quote_in','sell']),
};
function decimals(value) { if (!Number.isInteger(Number(value)) || Number(value)<0 || Number(value)>36) throw Error('Invalid token decimals.'); return Number(value); }
function amounts(row, baseRaw, quoteRaw, baseDecimals, quoteDecimals, context) {
  row.tokenAmount=formatUnits(abs(baseRaw),baseDecimals); row.quoteAmount=formatUnits(abs(quoteRaw),quoteDecimals);
  const usd=positive(context.quoteUsd), base=positive(row.tokenAmount), quote=positive(row.quoteAmount);
  row.amountUsd=usd&&quote ? number(usd*quote) : null; row.priceUsd=row.amountUsd&&base ? number(row.amountUsd/base) : null;
  const supply=context.supply;
  row.fdvUsd=row.priceUsd&&supply&&validRaw(supply.amount) ? number(row.priceUsd*Number(formatUnits(BigInt(supply.amount),decimals(supply.decimals)))) : null;
  return {...row,quoteSymbol:context.quoteSymbol||'',marketCapUsd:null,usdEstimate:true,valuationReference:'Current quote-token USD reference; execution token/quote ratio',gasScope:'transaction'};
}

// A balance change is not evidence of a trade. Require exactly one recognized
// swap invocation touching this verified pool and both of its exact vaults.
export function decodeSolanaPoolSwap(tx, pool, context={}) {
  if (!tx?.meta || tx.meta.err || !Number.isSafeInteger(tx.meta.fee) || tx.meta.fee<0) return null;
  const message=tx.transaction?.message, keys=(message?.accountKeys||[]).map(key);
  const ixs=[...(message?.instructions||[]),...(tx.meta.innerInstructions||[]).flatMap(group=>group.instructions||[])];
  const poolInstructions=ixs.filter(ix=>key(ix.programId)===pool.program&&Array.isArray(ix.accounts)&&ix.accounts.map(key).includes(pool.address));
  const swaps=poolInstructions.filter(ix=>{
    if (key(ix.programId)!==pool.program || !Array.isArray(ix.accounts) || ![pool.address,...pool.vaults].every(a=>ix.accounts.map(key).includes(a))) return false;
    try { const data=Buffer.from(bs58.decode(ix.data)); return pool.protocol==='amm-v4' ? data.length===17&&[9,11].includes(data[0]) : signatures[pool.protocol]?.has(data.subarray(0,8).toString('hex')); } catch { return false; }
  });
  if (poolInstructions.length!==1 || swaps.length!==1 || !keys.includes(pool.address)) return null;
  const swap=swaps[0],outer=message.instructions||[],outerIndex=outer.indexOf(swap),groups=tx.meta.innerInstructions||[];
  const swapGroup=groups.find(group=>(group.instructions||[]).includes(swap)),swapOffset=swapGroup?.instructions.indexOf(swap);
  const vaultTransfer=ix=>{
    if(!['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(key(ix.programId)))return false;
    const info=ix.parsed?.info;return pool.vaults.some(v=>info?.source===v||info?.destination===v||(ix.accounts||[]).map(key).includes(v));
  };
  // A direct donation to a vault must not inflate the swap's execution amount.
  if(outer.some(vaultTransfer))return null;
  for(const group of groups)for(const [index,ix]of (group.instructions||[]).entries())if(vaultTransfer(ix)){
    if(outerIndex>=0){if(group.index!==outerIndex)return null;}
    else{
      if(group!==swapGroup||index<=swapOffset||!Number.isInteger(swap.stackHeight)||!Number.isInteger(ix.stackHeight)||ix.stackHeight<=swap.stackHeight)return null;
      if(group.instructions.slice(swapOffset+1,index).some(other=>Number.isInteger(other.stackHeight)&&other.stackHeight<=swap.stackHeight))return null;
    }
  }
  const deltas=pool.vaults.map((vault,i)=>{
    const index=keys.indexOf(vault), find=rows=>(rows||[]).find(row=>row.accountIndex===index&&row.mint===pool.mints[i]);
    const pre=find(tx.meta.preTokenBalances),post=find(tx.meta.postTokenBalances);
    if(index<0 || !pre || !post || !validRaw(pre.uiTokenAmount?.amount) || !validRaw(post.uiTokenAmount?.amount) || pre.uiTokenAmount.decimals!==post.uiTokenAmount.decimals) return null;
    try{return{amount:BigInt(post.uiTokenAmount.amount)-BigInt(pre.uiTokenAmount.amount),decimals:decimals(post.uiTokenAmount.decimals)};}catch{return null;}
  });
  if(deltas.some(x=>!x)||!opposite(deltas[0].amount,deltas[1].amount)) return null;
  const selected=pool.mints.indexOf(context.tokenAddress);if(selected<0)return null;
  const base=deltas[selected],quote=deltas[1-selected],signature=tx.transaction?.signatures?.[0];
  if(typeof signature!=='string'||!Number.isSafeInteger(tx.slot)||!positive(tx.blockTime))return null;
  const wallet=key(message.accountKeys[0]);try{address(wallet);}catch{return null;}
  return amounts({id:signature,signature,at:tx.blockTime*1000,side:base.amount<0n?'buy':'sell',wallet,walletRole:'transaction payer',gasNative:formatUnits(BigInt(tx.meta.fee),9),gasSymbol:'SOL',blockNumber:tx.slot,amountKind:'Pool vault changes'},base.amount,quote.amount,base.decimals,quote.decimals,context);
}

export function decodeEvmPoolSwap(log,pool,receipt,block,context={}) {
  if(log?.removed||lower(log.address)!==lower(pool.logAddress||pool.address)||!['0x1',1,1n,'success'].includes(receipt?.status)||lower(receipt.transactionHash)!==lower(log.transactionHash)||lower(receipt.blockHash)!==lower(log.blockHash)||lower(block?.hash)!==lower(log.blockHash))return null;
  try {
    const abi=pool.protocol==='v2'?pairAbi:pool.protocol==='v3'?v3PoolAbi:pool.protocol==='v4'?poolAbi:curveAbi;
    const event=decodeEventLog({abi,topics:log.topics,data:log.data,strict:true}),a=event.args;
    let deltas;
    if(pool.protocol==='pons-curve'){
      if(!['CurveBuy','CurveSell'].includes(event.eventName))return null;
      const buy=event.eventName==='CurveBuy';deltas=pool.mints.map(m=>m===lower(pool.token) ? (buy?-BigInt(a.tokensOut):BigInt(a.tokensIn)) : (buy?BigInt(a.quoteIn):-BigInt(a.quoteOut)));
    }else{
      if(event.eventName!=='Swap'||pool.protocol==='v4'&&lower(a.id)!==lower(pool.id))return null;
      deltas=pool.protocol==='v2'?[a.amount0In-a.amount0Out,a.amount1In-a.amount1Out]:[a.amount0,a.amount1];
      // V4 BalanceDelta uses the caller's sign; V2/V3 use pool balances.
      if(pool.protocol==='v4')deltas=deltas.map(n=>-n);
    }
    if(!opposite(...deltas))return null;
    const selected=pool.mints.indexOf(lower(context.tokenAddress));if(selected<0)return null;
    const gas=BigInt(receipt.gasUsed)*BigInt(receipt.effectiveGasPrice),at=Number(BigInt(block.timestamp))*1000,blockNumber=Number(BigInt(log.blockNumber)),index=rawNumber(log.logIndex);
    if(!Number.isSafeInteger(at)||at<=0||!Number.isSafeInteger(blockNumber)||blockNumber<0||index==null||gas<0n||!HASH32.test(log.transactionHash||'')||!HASH32.test(log.blockHash||'')||!/^0x[0-9a-f]{40}$/i.test(receipt.from||''))return null;
    return amounts({id:lower(log.transactionHash)+':0x'+index.toString(16),signature:lower(log.transactionHash),at,side:deltas[selected]<0n?'buy':'sell',wallet:lower(receipt.from),walletRole:'transaction sender',gasNative:formatUnits(gas,18),gasSymbol:'ETH',blockNumber,blockHash:lower(log.blockHash),amountKind:'Pool swap event'},deltas[selected],deltas[1-selected],pool.decimals[selected],pool.decimals[1-selected],context);
  }catch{return null;}
}

const HASH32=/^0x[0-9a-f]{64}$/i, EVM_ADDRESS=/^0x[0-9a-f]{40}$/i;
const creationAbi=parseAbi(['event PairCreated(address indexed token0,address indexed token1,address pair,uint256 ordinal)','event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)']);
const seenEvm=log=>lower(log.transactionHash)+':'+String(rawNumber(log.logIndex))+':'+lower(log.blockHash);
const rawNumber=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?BigInt(value):typeof value==='string'&&/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)?BigInt(value):null;
const explorerAddress=value=>lower(value?.hash||value);
const explorerLog=log=>({address:explorerAddress(log.address||log.address_hash),topics:(log.topics||[]).filter(x=>x!=null),data:log.data,transactionHash:log.transactionHash||log.transaction_hash,blockHash:log.blockHash||log.block_hash,blockNumber:log.blockNumber??log.block_number,logIndex:log.logIndex??log.index,removed:log.removed===true});
const safeRpcReason=error=>{
  const messages=[];for(let e=error,n=0;e&&n<5;e=e.cause,n++)messages.push(String(e.message||''));const text=messages.join(' '),http=text.match(/HTTP\s*(\d{3})/i);
  if(http)return `The RPC returned HTTP ${http[1]}.`;
  if(error?.connectionRequired||error?.statusCode===428)return 'No usable RPC connection is saved.';
  if(/rate.?limit|cooling down|too many requests/i.test(text))return 'The RPC is rate limited.';
  if(error?.unsupported)return 'The selected pool could not be resolved through RPC.';
  return 'The RPC could not load this market.';
};
function verifiedV4(pair,logs){
  for(const raw of logs||[]){const log=explorerLog(raw);if(log.removed||lower(log.address)!==lower(CONTRACTS.poolManager))continue;
    try{const event=decodeEventLog({abi:poolAbi,topics:log.topics,data:log.data,strict:true});if(event.eventName!=='Initialize'||lower(event.args.id)!==lower(pair.address))continue;
      const a=event.args,candidate={currency0:lower(a.currency0),currency1:lower(a.currency1),fee:Number(a.fee),tickSpacing:Number(a.tickSpacing),hooks:lower(a.hooks)};
      if(lower(poolId(candidate))!==lower(pair.address))continue;
      return{...candidate,address:lower(pair.address),protocol:'v4',id:lower(pair.address),logAddress:lower(CONTRACTS.poolManager)};
    }catch{}
  }
  throw unsupported('The selected V4 pool has no matching verified Initialize event.');
}

// Blockscout's current REST transaction response has block_number but may omit
// block_hash. Its consensus log records supply the hash; bind them to the exact
// confirmed transaction and height, never infer swaps from token transfers.
export function decodeExplorerPoolSwap(raw,pool,transaction,context={}){
  try{
    const log=explorerLog(raw),height=rawNumber(log.blockNumber),index=rawNumber(log.logIndex),txHeight=rawNumber(transaction?.block_number);
    if(!HASH32.test(log.transactionHash||'')||!HASH32.test(log.blockHash||'')||height==null||index==null||txHeight!==height||lower(transaction?.hash)!==lower(log.transactionHash)||transaction.status!=='ok'||!(Number(transaction.confirmations)>0)||transaction.is_pending_update===true)return null;
    if(transaction.block_hash&&lower(transaction.block_hash)!==lower(log.blockHash))return null;
    const at=Date.parse(transaction.timestamp),logAt=raw.block_timestamp?Date.parse(raw.block_timestamp):at;
    if(!Number.isSafeInteger(at)||at<=0||logAt!==at||transaction.fee?.type!=='actual'||!validRaw(String(transaction.fee.value)))return null;
    const gasUsed=rawNumber(transaction.gas_used),gasPrice=rawNumber(transaction.gas_price);if(gasUsed==null||gasPrice==null)return null;
    const receipt={status:'success',transactionHash:transaction.hash,blockHash:log.blockHash,from:explorerAddress(transaction.from),gasUsed,effectiveGasPrice:gasPrice};
    const row=decodeEvmPoolSwap({...log,blockNumber:'0x'+height.toString(16),logIndex:'0x'+index.toString(16)},pool,receipt,{hash:log.blockHash,timestamp:BigInt(Math.floor(at/1000))},context);
    return row?{...row,gasNative:formatUnits(BigInt(transaction.fee.value),18),source:'Blockscout indexed swap'}:null;
  }catch{return null;}
}

async function settledValues(jobs){const values=await Promise.allSettled(jobs),failure=values.find(row=>row.status==='rejected');if(failure)throw failure.reason;return values.map(row=>row.value);}
async function mapLimit(rows,limit,action){let at=0,failure;const result=[];await Promise.all(Array.from({length:Math.min(limit,rows.length)},async()=>{while(at<rows.length&&!failure){const i=at++;try{result[i]=await action(rows[i],i);}catch(error){failure=error;}}}));if(failure)throw failure;return result;}

// Read-only and account scoped. Requests flow through the caller's public-URL
// guard, shared RPC gate and provider cooldown; this module opens no sockets.
export class LiveMarketTrades {
  constructor({rpc,explorer,now=Date.now,pollMs=1000}={}) { this.rpc=rpc;this.explorer=explorer;this.now=now;this.pollMs=Math.max(1000,pollMs);this.feeds=new Map();this.explorerDescriptions=new Map(); }
  close(){this.feeds.clear();this.explorerDescriptions.clear();}
  async describe(chain,pair,tokenAddress){
    if(chain==='solana'){
      const info=(await this.rpc(chain,'getAccountInfo',[pair.address,{encoding:'base64',commitment:'confirmed'}]))?.value;
      if(!info?.data||info.executable)throw unsupported('The selected pool could not be verified onchain.');
      const ray=liquiditySdks.raydium(),program=address(info.owner),data=Buffer.from(info.data[0],'base64');let state,protocol,mints,vaults;
      if(program===String(ray.CREATE_CPMM_POOL_PROGRAM)){state=ray.CpmmPoolInfoLayout.decode(data);protocol='cpmm';}
      else if(program===String(ray.CLMM_PROGRAM_ID)){state=ray.PoolInfoLayout.decode(data);protocol='clmm';}
      else if(program===String(ray.LAUNCHPAD_PROGRAM)){state=ray.LaunchpadPool.decode(data);protocol='launchlab';}
      else if(program===String(ray.AMM_V4)){state=ray.liquidityStateV4Layout.decode(data);protocol='amm-v4';mints=[state.baseMint,state.quoteMint];vaults=[state.baseVault,state.quoteVault];}
      else if(program===PUMP_AMM){state=liquiditySdks.pump().PUMP_AMM_SDK.decodePool({data,owner:new PublicKey(program)});protocol='pump';mints=[state.baseMint,state.quoteMint];vaults=[state.poolBaseTokenAccount,state.poolQuoteTokenAccount];}
      else throw unsupported('Live swap decoding is not yet supported for this pool program. The DEX Screener chart remains available.');
      if(['cpmm','clmm','launchlab'].includes(protocol)&&!data.subarray(0,8).equals(createHash('sha256').update('account:PoolState').digest().subarray(0,8)))throw unsupported('The selected account is not a verified pool.');
      mints=(mints||[state.mintA,state.mintB]).map(address);vaults=(vaults||[state.vaultA,state.vaultB]).map(address);
      if(![pair.base.address,pair.quote.address].every(m=>mints.includes(m))||!mints.includes(tokenAddress))throw unsupported('The selected pool currencies could not be verified.');
      const supply=(await this.rpc(chain,'getTokenSupply',[tokenAddress,{commitment:'confirmed'}]))?.value;
      return{address:pair.address,program,protocol,mints,vaults,supply:supply&&validRaw(supply.amount)?{amount:supply.amount,decimals:decimals(supply.decimals)}:null};
    }
    const client=createPublicClient({transport:custom({request:({method,params})=>this.rpc(chain,method,params||[])},{retryCount:0})});let pool;
    if(/^0x[0-9a-f]{64}$/i.test(pair.address)){
      const topics=[encodeEventTopics({abi:poolAbi,eventName:'Initialize'})[0],pair.address];
      const logs=await this.rpc(chain,'eth_getLogs',[{address:CONTRACTS.poolManager,fromBlock:'0x0',toBlock:'latest',topics}]);
      if(!Array.isArray(logs))throw Error('Invalid pool initialization logs.');
      pool=verifiedV4(pair,logs);
    }else{
      const factory=lower(await client.readContract({address:pair.address,abi:pairAbi,functionName:'factory'}));
      if(factory===lower(CONTRACTS.v2Factory))pool=await readLegacyPool(client,pair.address,'v2',true);
      else if(factory===lower(CONTRACTS.v3Factory))pool=await readLegacyPool(client,pair.address,'v3',true);
      else if(factory===lower(CONTRACTS.ponsFactory)){const token=await client.readContract({address:pair.address,abi:curveAbi,functionName:'token'});pool=await readCurve(client,token,true);if(lower(pool.address)!==lower(pair.address))throw unsupported('Launchpad address did not match.');}
      else throw unsupported('Live swaps require a verified Uniswap or Pons pool.');
    }
    pool.address=pair.address;pool.mints=[lower(pool.currency0),lower(pool.currency1)];
    if(![pair.base.address,pair.quote.address].every(m=>pool.mints.includes(lower(m)))||!pool.mints.includes(lower(tokenAddress)))throw unsupported('The selected pool currencies could not be verified.');
    pool.decimals=await settledValues(pool.mints.map(m=>m==='0x0000000000000000000000000000000000000000'?Promise.resolve(18):client.readContract({address:m,abi:erc20Abi,functionName:'decimals'}).then(decimals)));
    const total=await client.readContract({address:tokenAddress,abi:erc20Abi,functionName:'totalSupply'});pool.supply={amount:String(total),decimals:pool.decimals[pool.mints.indexOf(lower(tokenAddress))]};return pool;
  }
  async explorerLogs(logAddress,topics){
    const query=new URLSearchParams({module:'logs',action:'getLogs',fromBlock:'0',toBlock:'latest',address:logAddress});
    topics.forEach((topic,index)=>{if(topic)query.set('topic'+index,topic);});
    for(let a=0;a<topics.length;a++)for(let b=a+1;b<topics.length;b++)if(topics[a]&&topics[b])query.set(`topic${a}_${b}_opr`,'and');
    const data=await this.explorer('/api?'+query);
    if(Array.isArray(data?.result))return data.result;
    if(String(data?.status)==='0'&&/no (?:logs|records)/i.test(String(data.message||data.result||'')))return[];
    throw Error('The explorer could not verify this market’s creation event.');
  }
  async describeExplorer(pair,tokenAddress){
    if(!this.explorer)throw Error('Explorer fallback is unavailable.');
    const cacheKey=lower(pair.address)+':'+lower(tokenAddress),old=this.explorerDescriptions.get(cacheKey);
    if(old&&old.until>this.now())return old.value;if(old?.pending)return old.pending;
    const entry={};entry.pending=(async()=>{
      let pool;
      if(HASH32.test(pair.address))pool=verifiedV4(pair,await this.explorerLogs(CONTRACTS.poolManager,[encodeEventTopics({abi:poolAbi,eventName:'Initialize'})[0],pair.address]));
      else{
        const mints=[lower(pair.base.address),lower(pair.quote.address)].sort(),topic=m=>'0x'+m.slice(2).padStart(64,'0');
        const definitions=[['v2',CONTRACTS.v2Factory,'PairCreated'],['v3',CONTRACTS.v3Factory,'PoolCreated']];
        for(const [protocol,factory,eventName]of definitions){
          const logs=await this.explorerLogs(factory,[encodeEventTopics({abi:creationAbi,eventName})[0],...mints.map(topic)]);
          for(const raw of logs)try{const log=explorerLog(raw);if(log.removed||lower(log.address)!==lower(factory))continue;const event=decodeEventLog({abi:creationAbi,topics:log.topics,data:log.data,strict:true}),a=event.args;
            if(event.eventName===eventName&&lower(a.pair||a.pool)===lower(pair.address)&&lower(a.token0)===mints[0]&&lower(a.token1)===mints[1])pool={address:lower(pair.address),protocol,currency0:mints[0],currency1:mints[1]};
          }catch{}if(pool)break;
        }
        if(!pool){const logs=await this.explorerLogs(CONTRACTS.ponsFactory,[encodeEventTopics({abi:ponsAbi,eventName:'TokenLaunched'})[0],null,topic(lower(pair.address))]);
          for(const raw of logs)try{const log=explorerLog(raw);if(log.removed||lower(log.address)!==lower(CONTRACTS.ponsFactory))continue;const event=decodeEventLog({abi:ponsAbi,topics:log.topics,data:log.data,strict:true}),a=event.args;
            if(event.eventName==='TokenLaunched'&&lower(a.curve)===lower(pair.address)&&[lower(a.token),lower(a.pairToken)].sort().join(':')===mints.join(':'))pool={address:lower(pair.address),protocol:'pons-curve',currency0:mints[0],currency1:mints[1],token:lower(a.token),quote:lower(a.pairToken)};
          }catch{}
        }
        if(!pool)throw unsupported('The explorer has no matching verified pool creation event.');
      }
      pool.mints=[lower(pool.currency0),lower(pool.currency1)];
      if(![pair.base.address,pair.quote.address].every(m=>pool.mints.includes(lower(m)))||!pool.mints.includes(lower(tokenAddress)))throw unsupported('The selected pool currencies could not be verified.');
      const tokens=await settledValues(pool.mints.map(async mint=>{
        if(mint==='0x0000000000000000000000000000000000000000')return{decimals:18};
        const data=await this.explorer('/api/v2/tokens/'+mint);
        if(explorerAddress(data?.address_hash||data?.address)!==mint)throw Error('Explorer token identity mismatch.');
        return{decimals:decimals(data.decimals),amount:validRaw(data.total_supply)?data.total_supply:null};
      }));pool.decimals=tokens.map(t=>t.decimals);const selected=tokens[pool.mints.indexOf(lower(tokenAddress))];pool.supply=selected.amount?{amount:selected.amount,decimals:selected.decimals}:null;pool.indexed=true;
      entry.value=pool;entry.until=this.now()+300000;return pool;
    })().finally(()=>{entry.pending=null;});this.explorerDescriptions.set(cacheKey,entry);while(this.explorerDescriptions.size>40)this.explorerDescriptions.delete(this.explorerDescriptions.keys().next().value);return entry.pending;
  }
  async indexed(feed,pair,context){
    feed.indexedPool=await this.describeExplorer(pair,context.tokenAddress);
    const pool=feed.indexedPool;context.supply=context.supply||pool.supply;
    const eventTopic=pool.protocol==='v4'?pool.id:pool.protocol==='v2'?encodeEventTopics({abi:pairAbi,eventName:'Swap'})[0]:pool.protocol==='v3'?encodeEventTopics({abi:v3PoolAbi,eventName:'Swap'})[0]:null;
    const path='/api/v2/addresses/'+(pool.logAddress||pool.address)+'/logs',query=new URLSearchParams(eventTopic?{topic:eventTopic}:{});
    const data=await this.explorer(path+(query.size?'?'+query:''));if(!Array.isArray(data?.items))throw Error('The explorer returned invalid swap logs.');
    const abi=pool.protocol==='v2'?pairAbi:pool.protocol==='v3'?v3PoolAbi:pool.protocol==='v4'?poolAbi:curveAbi;
    const logs=data.items.filter(raw=>{try{const log=explorerLog(raw),d=decodeEventLog({abi,topics:log.topics,data:log.data,strict:true});return !log.removed&&lower(log.address)===lower(pool.logAddress||pool.address)&&['Swap','CurveBuy','CurveSell'].includes(d.eventName)&&(pool.protocol!=='v4'||lower(d.args.id)===lower(pool.id));}catch{return false;}});
    const candidates=logs.filter(raw=>{const log=explorerLog(raw);return !feed.seen.has(seenEvm(log));}),selected=candidates.slice(0,6),details=new Map();let delayed=0;
    await mapLimit(selected,3,async raw=>{
      const log=explorerLog(raw);if(!HASH32.test(log.transactionHash||''))return;
      if(!details.has(log.transactionHash))details.set(log.transactionHash,this.explorer('/api/v2/transactions/'+log.transactionHash));const tx=await details.get(log.transactionHash);
      if(!tx||!(Number(tx.confirmations)>0)){delayed++;return;}
      const trade=decodeExplorerPoolSwap(raw,pool,tx,context);if(trade)feed.rows.set(trade.id,trade);
      feed.seen.set(seenEvm(log),this.now());
    });while(feed.seen.size>1000)feed.seen.delete(feed.seen.keys().next().value);
    return{source:'Blockscout indexed swaps',indexed:true,rpcUnavailable:!!feed.rpcError,refreshMs:5000,partial:true,backlog:Math.max(0,candidates.length-selected.length)+delayed,warning:delayed?'Waiting for indexed transaction details.':null,note:'Verified pool swap events indexed by Blockscout, refreshed every 5 seconds. Indexing can lag the chain. USD and FDV use the current quote-token reference; gas is the whole transaction fee.'};
  }
  async read({chain,pair,tokenAddress,quoteUsd=null,supply=null}){
    if(!['solana','robinhood'].includes(chain)||!pair?.address||!pair.base?.address||!pair.quote?.address)throw Error('Choose a verified market.');
    tokenAddress=chain==='solana'?address(tokenAddress):lower(tokenAddress);
    const cacheKey=chain+':'+pair.address+':'+tokenAddress;let feed=this.feeds.get(cacheKey);
    if(!feed){feed={rows:new Map(),seen:new Map(),until:0,head:null};this.feeds.set(cacheKey,feed);while(this.feeds.size>20)this.feeds.delete(this.feeds.keys().next().value);}
    if(feed.pending)return feed.pending;if(feed.value&&feed.until>this.now())return feed.value;
    const context={tokenAddress,quoteUsd,supply,quoteSymbol:tokenAddress===(chain==='solana'?pair.base.address:lower(pair.base.address))?pair.quote.symbol:pair.base.symbol};
    const work=async()=>{
      const base={chain,address:pair.address,tokenAddress,at:this.now(),source:'Confirmed onchain swaps',refreshMs:this.pollMs,quoteSymbol:context.quoteSymbol||'',partial:true,
        note:'Recent confirmed swaps from your RPC. USD and FDV use the current quote-token USD reference; gas is the whole transaction fee. Pool amounts can differ from wallet amounts after token taxes. Bounded history may omit swaps during heavy activity.'};
      try{
        let result;
        if(chain==='robinhood'&&this.explorer&&feed.rpcUntil>this.now())result=await this.indexed(feed,pair,context);
        else try{
          if(!feed.pool||feed.descriptionUntil<this.now()){feed.pool=null;feed.pool=await this.describe(chain,pair,tokenAddress);feed.descriptionUntil=this.now()+60000;}
          context.supply=supply||feed.pool.supply;
          result=chain==='solana'?await this.solana(feed,context):await this.evm(feed,context);
          feed.rpcError=null;
          // Bootstrap quiet pools from their indexed history. A one-second
          // ticker should not begin with only the last two seconds of blocks.
          if(chain==='robinhood'&&this.explorer&&!feed.bootstrapDone){
            feed.bootstrapDone=true;try{await this.indexed(feed,pair,context);}catch{}
          }
        }catch(error){
          if(chain!=='robinhood'||!this.explorer)throw error;
          const reason=safeRpcReason(error);
          // A provider can reject historical Initialize scans or eth_call while
          // still serving recent logs. Resolve the exact pool with the explorer
          // and retain fast RPC polling when those recent reads are healthy.
          if(!feed.pool&&!/HTTP (?:401|403|404|405)|rate limited|No usable RPC/.test(reason)){
            try{
              feed.pool=await this.describeExplorer(pair,tokenAddress);feed.descriptionUntil=this.now()+300000;context.supply=supply||feed.pool.supply;
              result=await this.evm(feed,context);feed.rpcError=null;feed.rpcUntil=0;
              if(!feed.bootstrapDone){feed.bootstrapDone=true;try{await this.indexed(feed,pair,context);}catch{}}
            }catch{}
          }
          if(!result){feed.rpcError=reason;feed.rpcUntil=this.now()+Math.max(60000,Number(error.retryAfterMs)||0);result=await this.indexed(feed,pair,context);}
        }
        while(feed.rows.size>200)feed.rows.delete(feed.rows.keys().next().value);
        feed.value={...base,...result,trades:[...feed.rows.values()].sort((a,b)=>b.at-a.at||b.blockNumber-a.blockNumber).slice(0,100),at:this.now()};feed.until=this.now()+(result.refreshMs||this.pollMs);return feed.value;
      }catch(error){
        const connectionRequired=error.connectionRequired===true||error.statusCode===428;
        const delay=error.unsupported||connectionRequired?60000:Math.max(5000,Number(error.retryAfterMs)||15000);feed.until=this.now()+delay;
        feed.value={...base,source:feed.value?.source||base.source,indexed:!!feed.value?.indexed,at:feed.value?.at||base.at,trades:[...feed.rows.values()].sort((a,b)=>b.at-a.at).slice(0,100),stale:feed.rows.size>0,unsupported:!!error.unsupported,connectionRequired,retryAt:feed.until,warning:chain==='robinhood'&&this.explorer?`${feed.rpcError||'The live RPC feed is unavailable.'} ${connectionRequired?'Check your Blockscout key in Account → Connections.':'Blockscout could not refresh swaps; the feed will retry automatically.'}`:connectionRequired?`Save your ${chain==='solana'?'Solana':'Robinhood'} RPC in Account → Connections to load live swaps.`:error.unsupported?error.message:'Live swaps are temporarily unavailable from your RPC. The feed will retry automatically.',rpcUnavailable:!!feed.rpcError,refreshMs:delay};return feed.value;
      }
    };
    feed.pending=work().finally(()=>{feed.pending=null;});return feed.pending;
  }
  async solana(feed,context){
    const rows=await this.rpc('solana','getSignaturesForAddress',[feed.pool.address,{limit:40,commitment:'confirmed'}]);if(!Array.isArray(rows))throw Error('Invalid RPC signature response.');
    const candidates=rows.filter(row=>row&&!row.err&&typeof row.signature==='string'&&!feed.seen.has(row.signature)),selected=candidates.slice(0,6);let delayed=0;
    await mapLimit(selected,3,async row=>{
      const tx=await this.rpc('solana','getTransaction',[row.signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:1}]);
      if(!tx){delayed++;return;}if(tx.transaction?.signatures?.[0]!==row.signature)throw Error('RPC transaction mismatch.');
      const trade=decodeSolanaPoolSwap(tx,feed.pool,context);if(trade)feed.rows.set(trade.id,trade);feed.seen.set(row.signature,this.now());
    });
    while(feed.seen.size>1000)feed.seen.delete(feed.seen.keys().next().value);
    return{partial:true,backlog:Math.max(0,candidates.length-selected.length)+delayed,warning:candidates.length>6||rows.length===40?'High activity: this bounded feed may omit some swaps.':delayed?'Waiting for confirmed transaction details.':null};
  }
  async evm(feed,context){
    const latest=BigInt(await this.rpc('robinhood','eth_blockNumber',[])),head=latest>1n?latest-1n:0n,first=feed.head==null;
    let from=feed.head==null?(head>2048n?head-2048n:0n):feed.head>1n?feed.head-1n:0n;
    const gap=head-from>2048n;if(gap)from=head-2048n;if(from>head)from=head;
    const p=feed.pool,abi=p.protocol==='v2'?pairAbi:p.protocol==='v3'?v3PoolAbi:p.protocol==='v4'?poolAbi:curveAbi;
    const eventNames=p.protocol==='pons-curve'?['CurveBuy','CurveSell']:['Swap'];
    const topics=[eventNames.map(eventName=>encodeEventTopics({abi,eventName})[0])];if(p.protocol==='v4')topics.push(p.id);
    const scan=async(a,b)=>{const rows=await this.rpc('robinhood','eth_getLogs',[{address:p.logAddress||p.address,fromBlock:'0x'+a.toString(16),toBlock:'0x'+b.toString(16),topics}]);if(!Array.isArray(rows))throw Error('Invalid RPC logs.');return rows;};
    const current=await scan(from,head);let logs=current;
    if(first&&from>0n&&!current.length)feed.backfillCursor=from-1n;
    else if(!first&&feed.rows.size===0&&feed.backfillCursor!=null){
      const end=feed.backfillCursor,start=end>2048n?end-2048n:0n;
      logs=[...await scan(start,end),...current];feed.backfillCursor=start>0n?start-1n:null;
    }
    if(feed.rows.size||logs.length)feed.backfillCursor=null;
    const candidates=logs.filter(log=>!log.removed&&!feed.seen.has(seenEvm(log))),selected=candidates.slice(-8),receipts=new Map(),blocks=new Map();
    const shared=(cache,id,fn)=>{if(!cache.has(id))cache.set(id,fn());return cache.get(id);};let delayed=0;
    // Rescan two blocks to replace rows if a shallow reorg changes their hash.
    const hashes=new Map(current.map(log=>[Number(BigInt(log.blockNumber)),lower(log.blockHash)]));
    for(const [id,row]of feed.rows)if(row.blockNumber>=Number(from)&&row.blockNumber<=Number(head)&&hashes.get(row.blockNumber)!==lower(row.blockHash))feed.rows.delete(id);
    await mapLimit(selected,3,async log=>{
      const [receipt,block]=await settledValues([shared(receipts,log.transactionHash,()=>this.rpc('robinhood','eth_getTransactionReceipt',[log.transactionHash])),shared(blocks,log.blockNumber,()=>this.rpc('robinhood','eth_getBlockByNumber',[log.blockNumber,false]))]);
      if(!receipt||!block){delayed++;return;}
      const trade=decodeEvmPoolSwap(log,p,receipt,block,context);if(trade)feed.rows.set(trade.id,trade);feed.seen.set(seenEvm(log),this.now());
    });feed.head=head;while(feed.seen.size>1000)feed.seen.delete(feed.seen.keys().next().value);
    return{partial:true,backlog:Math.max(0,candidates.length-selected.length)+delayed,warning:gap||candidates.length>8?'High activity: this bounded feed may omit some swaps.':delayed?'Waiting for confirmed transaction details.':feed.backfillCursor!=null?'Loading older confirmed swaps.':null};
  }
}
