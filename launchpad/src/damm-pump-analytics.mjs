// Background reporting only. This worker receives public launch identities and
// a read-only history reader, never the custody journal or signing operations.
export function createDammPumpAnalytics({service,history,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,intervalMs=10000}={}) {
  let closed=false,started=false,timer=null,pending=null,lastError=null;
  const originalAnalytics=service.analyticsTrades.bind(service),originalTrades=service.trades.bind(service);
  const record=launch=>({mint:launch.mint,curve:launch.dammPoolId,dammPoolId:launch.dammPoolId,
    poolId:launch.status==='migrated'?launch.poolId:null,createdAt:launch.createdAt,baseDecimals:6,
    quote:{mint:launch.quoteMint,decimals:launch.quoteDecimals,symbol:launch.quoteSymbol}});
  const tick=()=>{
    if(closed)return Promise.resolve();
    if(pending)return pending;
    pending=(async()=>{
      const launches=await service.analyticsList();
      if(!Array.isArray(launches))throw Error('PumpSwap volume inventory is unavailable.');
      const records=launches.filter(row=>row?.platform==='damm-pump'&&row.confirmationStatus==='finalized'&&['trading','bonded','migrated'].includes(row.status)).map(record);
      if(closed)return;
      await history.sync(records);
      if(closed)return;
      await history.advance();
      lastError=null;
    })().catch(()=>{lastError='PumpSwap volume history is syncing.';}).finally(()=>{pending=null;});
    return pending;
  };
  const onchain=async mint=>{
    const result=await history.read(mint);
    if(result?.source!=='damm-pump-onchain'||!Array.isArray(result.trades))return null;
    // Retain already recorded host trades until the new reader has evidence.
    return result.trades.length||result.complete===true?result:null;
  };
  service.analyticsTrades=async mint=>{
    try{const result=await onchain(mint);if(result)return result;}catch{}
    return originalAnalytics(mint);
  };
  service.trades=async mint=>{
    try{const result=await onchain(mint);if(result)return result.trades.slice().sort((a,b)=>(b.time||0)-(a.time||0)||String(a.eventId).localeCompare(String(b.eventId))).slice(0,200);}catch{}
    return originalTrades(mint);
  };
  return {
    tick,
    start(){
      if(started||closed)return;started=true;
      const run=async()=>{timer=null;await tick();if(!closed){timer=setTimer(run,intervalMs);timer?.unref?.();}};
      void run();
    },
    async close(){closed=true;if(timer!==null)clearTimer(timer);timer=null;const ending=history.close?.();await pending;await ending;},
    status(){return {running:started&&!closed,refreshing:!!pending,lastError,at:now()};},
  };
}
