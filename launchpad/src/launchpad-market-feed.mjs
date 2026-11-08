import { LaunchCurveHistory } from './launch-curve-history.mjs';
import { LaunchCurveActivity } from './launch-curve-activity.mjs';

const REFRESH_MS=5000,MAX_POINTS=720,MAX_AGE=86400000;
const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0;
const nonnegative=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
const safeError=(message,retryAfterMs=15000)=>Object.assign(Error(message),{statusCode:503,retryAfterMs});
const pointValid=(p,now)=>Number.isSafeInteger(p?.time)&&p.time>0&&p.time<=Math.floor(now/1000)+2&&p.time>=Math.floor((now-MAX_AGE)/1000)&&positive(p.priceQuote)&&Number.isSafeInteger(p.slot)&&p.slot>0;
const pointsFrom=(rows,now)=>[...new Map((Array.isArray(rows)?rows:[]).slice(-MAX_POINTS).filter(p=>pointValid(p,now)).map(p=>[p.time,{time:p.time,priceQuote:p.priceQuote,slot:p.slot}])).values()].sort((a,b)=>a.time-b.time);
const freshReference=(value,mint,now)=>value&&(!value.mint||value.mint===mint)&&value.stale!==true&&(typeof value.usd==='number'||typeof value.usd==='string'&&value.usd.trim()!=='')&&positive(Number(value.usd))&&Number(value.usd)<1e9&&Number.isSafeInteger(value.at)&&value.at>0&&value.at<=now&&now-value.at<=60000;

// This feed observes public accounts only. It has no path to signing, launching,
// or fee processing. Private account storage keeps each user's RPC/cache scope.
export class LaunchMarketFeed {
  constructor({storeFor,chainFor,history,activity,now=Date.now}={}) {
    Object.assign(this,{storeFor,chainFor,now});this.history=history||new LaunchCurveHistory({now});this.activity=activity||new LaunchCurveActivity({now});this.entries=new Map();this.quoteReferences=new Map();this.quotePending=new Map();this.closingChains=new Set();this.closed=false;
  }
  key(id,launchId){return id+':'+launchId;}
  peek(id,launchId){const e=this.entries.get(this.key(id,launchId));return e?.value?this.withActivity({...e.value,stale:e.value.stale||this.now()-e.value.at>15000},e.activity):null;}
  withActivity(value,activity){
    const result=structuredClone(value),window=activity?.windows?.h24;
    if(result.status!=='curve'||result.stale||activity?.poolId!==result.curve||!Number.isSafeInteger(activity.at)||activity.at>this.now()+5000||this.now()-activity.at>60000||!nonnegative(window?.quote)||!Number.isSafeInteger(window.buys)||window.buys<0||!Number.isSafeInteger(window.sells)||window.sells<0||typeof window.complete!=='boolean')return result;
    const quoteUsd=result.quote.stale===false&&positive(result.quote.usd)&&this.now()-result.quote.at<=60000?result.quote.usd:null,usd=quoteUsd&&Number.isFinite(quoteUsd*window.quote)?quoteUsd*window.quote:null;
    return {...result,volume24h:window.complete?usd:null,volume24hQuote:window.complete?window.quote:null,volumeObserved:window.complete?null:usd,volumeObservedQuote:window.complete?null:window.quote,volumeUsdEstimate:quoteUsd!==null,volumeComplete:window.complete,buys24h:window.complete?window.buys:null,sells24h:window.complete?window.sells:null};
  }
  applyReference(e,mint,reference){
    const value=e.value,now=this.now();
    if(this.closed||!freshReference(reference,mint,now)||!value||value.status!=='curve'||value.stale||value.quote.mint!==mint||now-value.at>15000||value.at>now||!positive(value.priceQuote)||!positive(value.fdvQuote))return;
    const usd=Number(reference.usd),priceUsd=value.priceQuote*usd,fdvUsd=value.fdvQuote*usd;
    if(!positive(priceUsd)||!positive(fdvUsd))return;
    e.value={...value,quote:{...value.quote,usd,at:reference.at,source:String(reference.source||'Live market reference').slice(0,100),stale:false},priceUsd,fdvUsd,warning:''};e.quoteRetry=0;
  }
  reference(id,input,mint,read,e){
    // Account scope and raw mint semantics are part of the cache key. Private
    // provider settings never leak between users or into public discovery.
    const address=input.quoteMint,key=JSON.stringify([id,address,mint?.mint?.decimals,mint?.program?.toBase58?.()||'',...(mint?.extensions||[]).slice().sort((a,b)=>a-b)]),cached=this.quoteReferences.get(key);
    let pending;
    if(freshReference(cached,address,this.now()))pending=Promise.resolve(cached);
    else{
      pending=this.quotePending.get(key);
      if(!pending){
        if(this.quotePending.size>=100)return Promise.reject(safeError('Market references are busy. They will retry automatically.'));
        pending=Promise.resolve().then(()=>read(input,mint)).then(value=>{
          if(!freshReference(value,address,this.now()))throw safeError('The current market reference is unavailable.');
          const reference={usd:Number(value.usd),at:value.at,source:String(value.source||'Live market reference').slice(0,100),mint:address,stale:false};
          if(!this.closed){this.quoteReferences.delete(key);this.quoteReferences.set(key,reference);while(this.quoteReferences.size>100)this.quoteReferences.delete(this.quoteReferences.keys().next().value);}
          return reference;
        }).finally(()=>this.quotePending.delete(key));this.quotePending.set(key,pending);
      }
    }
    return pending.then(reference=>{if(!this.closed)e.reference=reference;this.applyReference(e,address,reference);return reference;});
  }
  async read(id,l) {
    if(this.closed)throw safeError('The chart service is restarting.');
    const key=this.key(id,l.id);let e=this.entries.get(key);
    if(!e){
      if([...this.entries.values()].filter(row=>row.pending).length>=20)throw safeError('Onchain charts are busy. Please try again shortly.',5000);
      e={next:0,retry:0,failures:0,points:[],loaded:false,lastWrite:0,dirty:false};this.entries.set(key,e);
      while(this.entries.size>100){const victim=[...this.entries.keys()].find(k=>k!==key&&!this.entries.get(k).pending);if(!victim)break;this.entries.delete(victim);}
    }
    if(e.pending)return this.withActivity(await e.pending,e.activity);
    if(this.now()<Math.max(e.next,e.retry)){
      if(e.value)return this.withActivity(e.value,e.activity);
      throw safeError('The onchain chart is temporarily unavailable. It will retry automatically.',Math.max(1000,e.retry-this.now()));
    }
    if([...this.entries.values()].filter(row=>row.pending).length>=20)throw safeError('Onchain charts are busy. Please try again shortly.',5000);
    e.pending=this.update(id,l,e);
    try{return this.withActivity(await e.pending,e.activity);}finally{e.pending=null;}
  }
  async update(id,l,e) {
    const store=this.storeFor(id),name='launch-market-'+l.id,referenceWork=[];let chain;
    try{
      if(!e.loaded){
        const saved=await store.read(name,null);
        if(saved?.mint===l.keys.mint.address&&saved.curve===l.curve)e.points=pointsFrom(saved.points,this.now());
        e.loaded=true;
      }
      chain=await this.chainFor(id,l.input.network);
      if(chain.referencePrice){const read=chain.referencePrice.bind(chain);chain.referencePrice=(input,mint)=>{const job=this.reference(id,input,mint,read,e);referenceWork.push(job);return job;};}
      if(!e.activityPending)e.activityPending=this.activity.read(l.curve).then(value=>{e.activity=value;}).catch(()=>{e.activity=null;}).finally(()=>{e.activityPending=null;});
      const skipQuote=this.now()<(e.quoteRetry||0);
      const [snapshot,history]=await Promise.allSettled([
        chain.marketSnapshot(l,{quoteReference:skipQuote?null:e.value?.quote}),
        this.history.read(l.curve),
      ]);
      if(snapshot.status!=='fulfilled')throw snapshot.reason;
      const raw=snapshot.value;
      if(raw?.mint!==l.keys.mint.address||raw.curve!==l.curve||raw.quote?.mint!==l.input.quoteMint||!['curve','migrating','migrated'].includes(raw.status)||!Number.isSafeInteger(raw.slot)||raw.slot<=0||!nonnegative(raw.at)||raw.at>this.now()+5000||this.now()-raw.at>30000||!positive(raw.supply))throw safeError('The curve snapshot could not be verified.');
      if(raw.slot<Math.max(e.value?.slot||0,e.points.at(-1)?.slot||0))throw safeError('Your RPC is behind the last verified curve snapshot.',5000);
      if(!raw.quote.stale)e.quoteRetry=0;else if(!skipQuote)e.quoteRetry=this.now()+30000;
      const value={launchId:l.id,mint:raw.mint,curve:raw.curve,status:raw.status,at:raw.at,slot:raw.slot,source:'Raydium onchain',
        priceQuote:positive(raw.priceQuote)?raw.priceQuote:null,fdvQuote:positive(raw.fdvQuote)?raw.fdvQuote:null,supply:raw.supply,
        raisedQuote:nonnegative(raw.raisedQuote)?raw.raisedQuote:null,targetQuote:positive(raw.targetQuote)?raw.targetQuote:null,
        progressPercent:nonnegative(raw.progressPercent)?Math.min(100,raw.progressPercent):null,
        quote:{mint:raw.quote.mint,symbol:String(raw.quote.symbol||'Quote').slice(0,24),usd:positive(raw.quote.usd)?raw.quote.usd:null,at:nonnegative(raw.quote.at)?raw.quote.at:null,source:String(raw.quote.source||'').slice(0,100),stale:raw.quote.stale!==false},
        priceUsd:positive(raw.priceUsd)&&raw.quote.stale===false?raw.priceUsd:null,fdvUsd:positive(raw.fdvUsd)&&raw.quote.stale===false?raw.fdvUsd:null,
        warning:String(raw.warning||'').slice(0,300),stale:false,refreshMs:REFRESH_MS,historySource:'Launchpad observations'};
      if(value.status!=='curve'){value.priceQuote=null;value.fdvQuote=null;value.priceUsd=null;value.fdvUsd=null;}
      const last=e.points.at(-1),point={time:Math.floor(value.at/1000),priceQuote:value.priceQuote,slot:value.slot};
      if(value.status==='curve'&&pointValid(point,this.now())&&(!last||point.slot>last.slot&&point.time>=last.time)){
        if(last?.time===point.time)e.points.pop();e.points.push(point);e.points=pointsFrom(e.points,this.now());e.dirty=true;
      }
      value.points=e.points;
      // Provider candles remain separate from observations; sampled prices are
      // never presented as complete trade candles or fabricated volume.
      const h=history.status==='fulfilled'?history.value:null;
      value.candles=h?.candles||e.value?.candles||[];value.candleSource=value.candles.length?'Raydium history':null;value.candleAt=h?.at||e.value?.candleAt||null;
      e.value=value;e.next=this.now()+REFRESH_MS;e.retry=0;e.failures=0;
      // The provider can complete while history or storage work is pending,
      // before this new snapshot is installed. Consume that result again here.
      this.applyReference(e,l.input.quoteMint,e.reference);
      if(e.dirty&&this.now()-e.lastWrite>=30000){await store.write(name,{version:1,mint:value.mint,curve:value.curve,points:e.points});e.lastWrite=this.now();e.dirty=false;}
      return e.value;
    }catch(error){
      e.failures++;const delay=Math.min(60000,Math.max(Number(error?.retryAfterMs)||0,2000*2**Math.min(e.failures,5)));e.retry=this.now()+delay;
      if(e.value){e.value={...e.value,stale:true,retryAt:e.retry,warning:'Showing the last verified curve data. Your connection is temporarily unavailable.'};return e.value;}
      throw safeError('The onchain chart is temporarily unavailable. Check your Solana connection or retry shortly.',delay);
    }finally{
      // A fast native snapshot may return before its USD provider. Destroying
      // the HTTPS agent here used to cancel that lookup on every retry. Keep
      // this read-only connection until its bounded reference work completes.
      if(referenceWork.length){const closing=Promise.allSettled(referenceWork).then(()=>chain?.close?.()).finally(()=>this.closingChains.delete(closing));this.closingChains.add(closing);}
      else chain?.close?.();
    }
  }
  async close(){this.closed=true;this.activity.close?.();await Promise.allSettled([...this.entries.values()].flatMap(e=>[e.pending,e.activityPending]).filter(Boolean));await Promise.allSettled(this.closingChains);this.history.close?.();this.entries.clear();this.quoteReferences.clear();this.quotePending.clear();}
}
