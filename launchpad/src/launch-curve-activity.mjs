import { PublicKey } from '@solana/web3.js';
import { createPublicFetcher } from './telegram-network.mjs';
import { readLaunchHistoryJson } from './launch-curve-history.mjs';
import { PublicRefreshQueue, boundedRefresh } from './public-refresh-queue.mjs';

// Raydium's LaunchLab trade endpoint reports amountB in human quote units.
// https://docs.raydium.io/api-reference/launch-history-v1-endpoints/trades/get-trade-history
const ORIGIN='https://launch-history-v1.raydium.io/trade',TTL=30_000,DAY=86_400_000;
const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0;
const validAddress=value=>{try{return typeof value==='string'&&new PublicKey(value).toBase58()===value;}catch{return false;}};
const fail=()=>{throw Error('Invalid launch activity response.');};

export class LaunchCurveActivity {
  constructor({fetcher,now=Date.now,timeoutMs=1500,waitMs=2000}={}){
    this.guarded=fetcher?null:createPublicFetcher();this.fetcher=fetcher||this.guarded.fetcher;this.now=now;this.timeoutMs=Math.min(1500,Math.max(1,timeoutMs));
    this.cache=new Map();this.pending=new Map();this.controllers=new Set();this.requests=[];this.retryUntil=0;this.closed=false;
    this.waitMs=Math.max(1,Math.min(2000,waitMs));this.queue=new PublicRefreshQueue({concurrency:3,perMinute:60,now});
  }
  stale(cached){return cached?.value&&this.now()-cached.value.at<15*60_000?{...cached.value,stale:true}:null;}
  async read(poolId){
    if(!validAddress(poolId))throw Object.assign(Error('Choose a valid launch curve.'),{statusCode:400});
    if(this.closed)return null;
    this.queue.drain();
    const cached=this.cache.get(poolId);if(cached&&this.now()-cached.checkedAt<TTL)return cached.value;
    if(this.pending.has(poolId)){const job=this.pending.get(poolId);return this.stale(cached)||(!job.started?null:boundedRefresh(job,()=>this.stale(cached),this.waitMs));}
    if(this.now()<this.retryUntil)this.queue.cooldown(this.retryUntil);
    const scheduled=this.queue.run(()=>this.collect(poolId));if(!scheduled)return this.stale(cached);
    const work=scheduled.catch(()=>null).then(value=>{value=value?{...value,stale:false}:this.stale(cached);if(!this.closed){this.cache.delete(poolId);this.cache.set(poolId,{value,checkedAt:this.now()});while(this.cache.size>1000)this.cache.delete(this.cache.keys().next().value);}return value;}).finally(()=>this.pending.delete(poolId));
    Object.defineProperty(work,'started',{get:()=>scheduled.started});this.pending.set(poolId,work);return this.stale(cached)||(!scheduled.started?null:boundedRefresh(work,()=>this.stale(cached),this.waitMs));
  }
  async request(poolId,cursor){
    this.requests=this.requests.filter(at=>at>this.now()-60_000);
    if(this.closed||this.requests.length>=60||this.now()<this.retryUntil){if(this.requests.length>=60)this.queue.cooldown(this.requests[0]+60001);fail();}
    this.requests.push(this.now());
    const url=new URL(ORIGIN);url.searchParams.set('poolId',poolId);url.searchParams.set('limit','100');if(cursor)url.searchParams.set('nextPageKey',cursor);
    const controller=new AbortController();this.controllers.add(controller);let timer;
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Launch activity timed out.'));},this.timeoutMs);});
    const request=(async()=>{
      const response=await this.fetcher(url.toString(),{method:'GET',redirect:'error',signal:controller.signal,headers:{accept:'application/json'}});
      if(controller.signal.aborted||this.closed)fail();
      if(response.status===429){const retry=response.headers.get('retry-after')||'',ms=/^\d+(?:\.\d+)?$/.test(retry)?Number(retry)*1000:Date.parse(retry)-this.now();this.retryUntil=this.now()+(Number.isFinite(ms)&&ms>0?ms:60_000);this.queue.cooldown(this.retryUntil);}
      if(!response.ok){await response.body?.cancel().catch(()=>{});fail();}
      const data=await readLaunchHistoryJson(response);if(controller.signal.aborted||this.closed)fail();return data;
    })();
    try{return await Promise.race([request,timeout]);}finally{clearTimeout(timer);this.controllers.delete(controller);}
  }
  async collect(poolId){
    const at=this.now(),cutoff=Math.floor((at-DAY)/1000),seen=new Map(),cursors=new Set();let cursor='',complete=false,oldest=Infinity,lastTime=Infinity;
    for(let page=0;page<5;page++){
      let data;try{data=await this.request(poolId,cursor);}catch(error){if(!page)throw error;break;}
      const rows=data?.data?.rows;if(data?.success!==true||!Array.isArray(rows)||rows.length>100)fail();
      let passedWindow=false;
      for(const row of rows){
        if(row?.poolId!==poolId||!Number.isSafeInteger(row.blockTime)||row.blockTime<1_500_000_000||row.blockTime>Math.floor(at/1000)+60||!['buy','sell'].includes(row.side)||!positive(row.amountA)||!positive(row.amountB)||!validAddress(row.owner)||typeof row.txid!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(row.txid))fail();
        const id=[row.txid,row.side,row.amountA,row.amountB,row.owner].join(':');
        if(seen.has(id))continue;
        if(row.blockTime>lastTime)fail();lastTime=row.blockTime;oldest=Math.min(oldest,row.blockTime);
        if(row.blockTime<=cutoff){passedWindow=true;continue;}
        seen.set(id,{time:row.blockTime,side:row.side,quote:row.amountB,amount:row.amountA,wallet:row.owner,signature:row.txid});
      }
      const next=data.data.nextPageKey;
      if(passedWindow||(!next&&rows.length<100)){complete=true;break;}
      if(!next)break; // A full page without a cursor cannot prove full coverage.
      if(typeof next!=='string'||next.length>2048||cursors.has(next))fail();cursors.add(next);cursor=next;
    }
    const windows={};
    for(const [key,seconds]of [['m5',300],['h1',3600],['h24',86400]]){
      const boundary=Math.floor(at/1000)-seconds,rows=[...seen.values()].filter(row=>row.time>boundary),quote=rows.reduce((sum,row)=>sum+row.quote,0);
      if(!Number.isFinite(quote))fail();
      windows[key]={quote,buys:rows.filter(row=>row.side==='buy').length,sells:rows.filter(row=>row.side==='sell').length,complete:complete||oldest<=boundary};
    }
    return {poolId,at,source:'Raydium trade history',windows,complete,trades:[...seen.values()]};
  }
  close(){this.closed=true;this.queue.close();for(const controller of this.controllers)controller.abort();this.guarded?.close();this.cache.clear();this.requests=[];}
}
