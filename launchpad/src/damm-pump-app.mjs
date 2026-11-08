import { PublicKey } from '@solana/web3.js';
import { DammPumpService, DAMM_PUMP_TREASURY } from './damm-pump-service.mjs';
import { DammPumpFeeClientAdapter } from './damm-pump-fee-chain.mjs';
import { readCustomPairs } from './launchpad-custom-pairs.mjs';
import { launchProtocolPolicy } from './launchpad-protocol-fees.mjs';
import { units } from '../public/launchpad-model.mjs';
import { LaunchChain } from './launchpad-chain.mjs';
import { launchpadEnv } from './brand-env.mjs';
import { DammPumpVolumeHistory } from './damm-pump-volume-history.mjs';
import { createDammPumpAnalytics } from './damm-pump-analytics.mjs';

// The offered catalogue is shared, but compatibility is checked against both
// actual programs. A DBC badge is not evidence of PumpSwap compatibility.
export function createDammPumpIntegration({accounts,launches,discovery,requireOwner,publishMetadata,rpcUrl,rpcGate,adapter:providedAdapter,volumeHistory:providedHistory,now=Date.now}) {
  const adapter=providedAdapter||new DammPumpFeeClientAdapter({rpcUrl,rpcGate,now});
  let checks=new Map(),initialized=null,sweep=null,timer=null,closed=false;
  const assets=async()=>{
    const [catalogue,custom]=await Promise.all([launches.quoteCatalogue.read(),readCustomPairs(accounts)]);
    const rows=new Map(),offered=[...(catalogue.assets||[]),...(custom.assets||[])],excluded=new Set(offered.filter(row=>row.retired===true||row.isTradingHalted===true).map(row=>row.mint));
    for(const row of offered)try{
      const mint=new PublicKey(row.mint).toBase58();
      if(excluded.has(mint)||!row.name||!row.symbol||rows.has(mint))continue;
      rows.set(mint,{mint,name:String(row.name).slice(0,100),symbol:String(row.symbol).slice(0,24),category:row.category||'other',issuer:row.issuer||'',logoPath:row.logoPath||null});
    }catch{}
    return [...rows.values()].sort((a,b)=>Number(['So11111111111111111111111111111111111111112','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'].includes(b.mint))-Number(['So11111111111111111111111111111111111111112','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'].includes(a.mint)));
  };
  const initialize=()=>initialized||=accounts.hostStore.read('damm-pump-pairs',{pairs:[]}).then(saved=>{
    for(const row of saved?.pairs||[])if(row?.mint&&Number.isSafeInteger(row.checkedAt)&&now()-row.checkedAt<3600000)checks.set(row.mint,row);
  });
  const remember=(asset,result)=>{
    const launchReady=result?.launchReady===true||result?.ready===true;
    const compatibilityVerified=launchReady||result?.compatibilityVerified===true,comingSoon=!launchReady&&compatibilityVerified;
    const row={...asset,...result,mint:asset.mint,launchReady,supported:launchReady,compatibilityVerified,comingSoon,availability:launchReady?'ready':comingSoon?'coming-soon':'unavailable',tokenProgram:result?.tokenProgram||result?.quoteTokenProgram,supportReason:result?.supportReason||result?.reason||'',checkedAt:now()};
    checks.set(asset.mint,row);return row;
  };
  const check=async asset=>remember(asset,await adapter.quoteReadiness(asset));
  const warm=()=>{
    if(closed||sweep)return sweep;
    sweep=(async()=>{
      await initialize();
      const rows=(await assets()).filter(asset=>{const cached=checks.get(asset.mint);return !cached||now()-cached.checkedAt>=(cached.launchReady?900000:cached.compatibilityVerified?3600000:30000);});
      // One provider request reads up to 100 mint accounts. There is only one
      // sweep, including concurrent public viewers. Verified incompatibility
      // stays cached for an hour; unavailable RPC checks retry after 30 seconds.
      // Preparation always checks the selected mint afresh.
      for(let offset=0;offset<rows.length&&!closed;offset+=100){
        const batch=rows.slice(offset,offset+100);
        try{
          const results=await adapter.quoteReadinessBatch(batch);
          if(!Array.isArray(results)||results.length!==batch.length||results.some((result,i)=>result?.mint!==batch[i].mint))throw Error('Incomplete quote compatibility batch.');
          for(let i=0;i<batch.length;i++)remember(batch[i],results[i]);
          await accounts.hostStore.write('damm-pump-pairs',{schemaVersion:1,pairs:[...checks.values()]});
        }catch{for(const asset of batch)remember(asset,{launchReady:false,compatibilityVerified:false,supportReason:'Pair compatibility could not be checked. It will retry automatically.'});}
      }
    })().catch(()=>null).finally(()=>{sweep=null;});
    return sweep;
  };
  const quoteEligibility=async mint=>{
    const asset=(await assets()).find(row=>row.mint===mint);
    return asset?check(asset):{mint,launchReady:false,supportReason:'Choose one of the currently offered compatible quote assets.'};
  };
  const listPairs=async()=>{
    await initialize();void warm();
    return (await assets()).map(asset=>{
      const cached=checks.get(asset.mint),fresh=cached&&now()-cached.checkedAt>=0&&now()-cached.checkedAt<3600000;
      if(fresh)return {...cached,...asset,availability:cached.launchReady?'ready':cached.compatibilityVerified?'coming-soon':'unavailable',comingSoon:!cached.launchReady&&cached.compatibilityVerified===true};
      return {...asset,launchReady:false,supported:false,compatibilityVerified:false,comingSoon:false,availability:'unavailable',supportReason:'Checking compatibility for this pair.'};
    });
  };
  const getQuotePrice=async mint=>{
    const chain=await discovery.chain();
    return {...await chain.referencePrice({quoteMint:mint},await chain.mintInfo(mint)),mint};
  };
  const service=new DammPumpService({accounts,requireOwner,adapter,quoteEligibility,listPairs,getQuotePrice,publishMetadata,now,
    getCreationFee:async()=>{const policy=await launchProtocolPolicy(accounts,{required:false});return {lamports:units(policy.creationFeeSol||'0',9).toString(),recipient:DAMM_PUMP_TREASURY};},
  });
  // Give background history its own small local quota within the same operator
  // RPC budget. It does not hold the launch/graduation service's commit lock.
  const volumeTransport=!providedAdapter&&!providedHistory?new LaunchChain({network:'mainnet-beta',rpcUrl:rpcUrl||launchpadEnv('PUBLIC_RPC_URL')||'https://api.mainnet-beta.solana.com',rpcGate,rpcScope:'damm-pump-volume',rpcRequestsPerSecond:2}):null;
  const volumeHistory=providedHistory||(volumeTransport?new DammPumpVolumeHistory({store:accounts.hostStore,connection:volumeTransport.c,now,maxTransactions:20,concurrency:2}):null);
  const analytics=volumeHistory?createDammPumpAnalytics({service,history:volumeHistory,now}):null;
  return {service,adapter,warm,analytics,
    start(){closed=false;service.start();analytics?.start();void warm();timer||=setInterval(()=>void warm(),60000);timer.unref?.();},
    async stop(){closed=true;clearInterval(timer);timer=null;try{await Promise.all([analytics?.close(),service.stop(),sweep]);}finally{volumeTransport?.close?.();}},
  };
}
