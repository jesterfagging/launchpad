import {protocolTreasurySources} from './protocol-treasury.mjs';
import { RATES } from './account-policy.mjs';
import { launchProtocolPolicy } from './launchpad-protocol-fees.mjs';
import { receiptHash } from './cashback-verifier.mjs';
import { SOL } from './core.mjs';
import { EVM_NATIVE } from '../public/chains.mjs';
import { quoteLabel } from '../public/quote-identity.mjs';
import { isCurrentLaunch, units } from '../public/launchpad-model.mjs';
import { publicRevenueAnalytics, unavailableRevenueAnalytics } from './public-revenue-analytics.mjs';

const fail=(message,statusCode=503)=>{throw Object.assign(Error(message),{statusCode});};
// Public reuse of the last snapshot after a failed or slow refresh stays within
// the public page's two-minute freshness label (see public-analytics.mjs).
const PUBLIC_STALE_MS=120000;
const uint=value=>typeof value==='string'&&/^\d{1,78}$/.test(value)?BigInt(value):null;
const integer=value=>typeof value==='string'&&/^-?\d{1,78}$/.test(value)?BigInt(value):null;
const safeText=value=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,'').slice(0,80):'';
const percent=ppm=>`${ppm/10000}%`;
const names=[['live','copy'],['sniper-live','sniper'],['market-live','market'],['liquidity-live','liquidity'],['portfolio-live',null]];
const assetKey=a=>`${a.scope}:${a.chain}:${a.mint}`;
const asset=(scope,chain,mint,decimals,symbol)=>({scope,chain,mint,decimals,symbol:safeText(symbol)});
const native=chain=>chain==='solana'?asset('toolkit',chain,SOL,9,'SOL'):asset('toolkit',chain,EVM_NATIVE,18,'ETH');
const empty=a=>({...a,grossAmount:0n,cashbackAmount:0n,netAmount:0n,paidAmount:0n,pendingAmount:0n,cashbackPaidAmount:0n,cashbackPendingAmount:0n});
function add(map,a,{gross=0n,cashback=0n,paid=0n,pending=0n}={}){
  const key=assetKey(a),row=map.get(key)||empty(a);
  if(row.decimals!==a.decimals)fail('Recorded revenue has inconsistent token precision.');
  row.grossAmount+=gross;row.cashbackAmount+=cashback;row.netAmount+=gross-cashback;
  row.paidAmount=row.paidAmount===null||paid===null?null:row.paidAmount+paid;
  row.pendingAmount=row.pendingAmount===null||pending===null?null:row.pendingAmount+pending;
  row.cashbackPendingAmount+=cashback;map.set(key,row);return row;
}
const serialize=map=>[...map.values()].sort((a,b)=>assetKey(a).localeCompare(assetKey(b))).map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='bigint'?String(v):v])));
const product=(id,label,scope,feeLabel,feeBasis)=>({id,label,scope,feeLabel,feeBasis,rows:new Map(),issues:new Set(),records:0,revenueComplete:true});
function products(policy){
  const lp=policy?.lpPolicy==='platform_locked'?Number(policy.platformLpPercent)||75:0;
  return [product('copy','Copy trading','toolkit',percent(RATES.copyPpm),'Per buy or sell; manual trades use the selected tool rate.'),product('sniper','Launch sniping','toolkit',percent(RATES.sniperPpm),'Per buy or sell; manual trades use the selected tool rate.'),product('market','Market making','toolkit',percent(RATES.marketPpm),'Per executed swap.'),product('liquidity','Liquidity management','toolkit','0.005% / 0.015% / 0.025%','Per automatic adjustment, by pool fee tier; initial deposits and manual withdrawals are free.'),{...product('funding','Funding','toolkit','0%','Launchpad adds no markup. Third-party provider and network charges are separate and are not Launchpad revenue.'),noFees:true},product('legacy','Other retained toolkit receipts','toolkit','Historical rate','Older receipts without a product identity; counted once in toolkit totals.'),product('creation','Launch creation','launchpad',`${policy?.creationFeeSol||'0'} SOL`,'Fixed creation fee; network and storage costs are excluded.'),product('curve','Launchpad curve trading','launchpad','1%','Platform share of curve swap volume, separate from creator and Raydium fees.'),product('lp','Locked LP yield','launchpad',`${lp}%`,'Share of initial migration LP locked for Launchpad, not a fixed percentage of swap volume or all future pool fees. Later LP additions can dilute the pool share; existing launches retain their onchain terms.'),product('tax','Tax token revenue','launchpad','5%','Share of proceeds from separately tracked collected transfer taxes; not an extra 5% transfer tax.')];
}

// Read-only reporting: never initializes wallets, calls a customer RPC, requests
// a claim, or treats a wallet balance / requested swap budget as earned revenue.
export class AdminRevenue {
  // The account scan limit matches the registry ceiling (accounts.mjs MAX_REGISTRY_ACCOUNTS).
  constructor({accounts,launchpad,meteoraSources=null,meteoraRevenueSources=null,dammPumpRevenueSources=null,pumpClassicRevenueSources=null,robinhoodRevenueSources=null,agentShareRevenueSources=null,now=Date.now,cacheMs=15000,maxAccounts=10000,maxRecords=100000,toolkit=true}={}){Object.assign(this,{accounts,launchpad,meteoraSources,meteoraRevenueSources,dammPumpRevenueSources,pumpClassicRevenueSources,robinhoodRevenueSources,agentShareRevenueSources,now,cacheMs,maxAccounts,maxRecords,toolkit:toolkit===true});this.cache=null;this.pending=null;}
  async requireAdmin(id){const actor=await this.accounts.get(id);if(actor?.role!=='admin'||!actor.mfaEnabled||actor.banned)fail('Administrator access with two-factor authentication is required.',403);}
  async read(id){
    await this.requireAdmin(id);
    const result=await this.cachedSnapshot();
    await this.requireAdmin(id);return structuredClone(result);
  }
  async readPublic(options={}){
    let report;
    try{report=await this.cachedSnapshot();}
    // A slow or failed refresh must not turn a recent confirmed total into
    // "unavailable" on the public page; reuse the last snapshot for a bounded time.
    catch{report=this.cache&&this.now()-this.cache.at<=PUBLIC_STALE_MS?this.cache:null;}
    if(!report)return unavailableRevenueAnalytics();
    try{return publicRevenueAnalytics(report,{...options,now:this.now()});}
    catch{return unavailableRevenueAnalytics();}
  }
  async cachedSnapshot(){
    if(!this.cache||this.now()-this.cache.at>=this.cacheMs){
      if(!this.pending)this.pending=this.snapshot().then(value=>{this.cache=value;return value;}).finally(()=>{this.pending=null;});
      let timer;try{await Promise.race([this.pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('Revenue is still updating. Try again shortly.'),{statusCode:503})),8000);timer.unref?.();})]);}finally{clearTimeout(timer);}
    }
    return this.cache;
  }
  async snapshot(){
    const [users,solana,robinhood,policy]=await Promise.all([this.accounts.list(),this.toolkit?this.accounts.hostStore.read('fee-policy',{}):null,this.toolkit?this.accounts.hostStore.read('robinhood-fee-policy',{}):null,launchProtocolPolicy(this.accounts,{required:false})]);
    if(users.length>this.maxAccounts)fail('Revenue history exceeds the reporting scan limit.');
    const list=products(policy).filter(p=>this.toolkit||p.scope==='launchpad'),byId=new Map(list.map(p=>[p.id,p])),totals=new Map(),seenToolkit=new Set(),seenLaunch=new Set(),seenOps=new Set(),unknownGross=new Set(),unknownPaid=new Set(),poolRates=new Set();let checked=0;
    const check=()=>{if(++checked>this.maxRecords)fail('Revenue history exceeds the reporting scan limit.');};
    const issue=(ids,message,{revenue=true}={})=>{for(const id of ids){byId.get(id).issues.add(message);if(revenue)byId.get(id).revenueComplete=false;}};
    const launchIds=['creation','curve','lp','tax'];
    const reportAssets=map=>serialize(map).map(row=>this.toolkit?row:Object.fromEntries(Object.entries(row).filter(([key])=>!key.startsWith('cashback'))));
    for(const user of users){
      for(const chain of this.toolkit?['solana','robinhood']:[]){
        const store=this.accounts.storeFor(user.id);
        const prefix=chain==='robinhood'?'robinhood-':'';let values;
        try{values=await Promise.all([store.read(`${prefix}cashback-verification`,{receipts:{}}),...names.map(([name])=>store.read(prefix+name,{}))]);}catch{issue(['copy','sniper','market','liquidity','legacy'],`${chain} receipt history could not be read.`);continue;}
        const verification=values[0];
        for(let i=0;i<names.length;i++)for(const receipt of values[i+1]?.feeReceipts||[]){
          check();if(receipt?.mode!=='live')continue;
          const kind=['copy','sniper','market','liquidity'].includes(receipt.kind)?receipt.kind:names[i][1]||'legacy',p=byId.get(kind),v=verification?.receipts?.[receipt.signature];
          const a=native(chain),amount=uint(receipt.amount),cashback=uint(receipt.cashbackAmount),mint=receipt.mint||SOL;
          if(!receipt.signature||receipt.accountId!==user.id||mint!==a.mint||receipt.decimals!==undefined&&receipt.decimals!==a.decimals||amount===null||cashback===null||cashback>amount||v?.status!=='verified'||v.hash!==receiptHash(receipt)||v.amount!==receipt.amount||v.cashbackAmount!==receipt.cashbackAmount){p.issues.add('Unverified or incomplete receipts are excluded.');p.revenueComplete=false;continue;}
          const key=`${chain}:${receipt.signature}:${mint}`;if(seenToolkit.has(key))continue;seenToolkit.add(key);
          add(p.rows,a,{gross:amount,cashback,paid:amount});add(totals,a,{gross:amount,cashback,paid:amount});p.records++;
        }
      }
      let book;try{book=await this.launchpad.book(user.id);}catch{issue(launchIds,'Some launch history could not be read.');continue;}
      if(!Array.isArray(book?.launches)){issue(launchIds,'Some launch history could not be read.');continue;}
      for(const launch of book?.launches||[]){
        check();if(!isCurrentLaunch(launch?.input))continue;
        if(Number.isFinite(launch.review?.postGradTradeBps)&&launch.review.postGradTradeBps>=0&&launch.review.postGradTradeBps<=10000)poolRates.add(launch.review.postGradTradeBps);
        const mint=launch.keys?.mint?.address;if(!mint||seenLaunch.has(mint))continue;seenLaunch.add(mint);
        const decimals=launch.review?.quoteDecimals;if(!Number.isInteger(decimals)||decimals<0||decimals>18){issue(launchIds,'A launch is missing token precision.');continue;}
        const quote=asset('launchpad','solana',launch.input.quoteMint,decimals,quoteLabel(launch.input.quoteMint,launch.review.quoteSymbol,launch.input.quoteSymbol));
        const base=asset('launchpad','solana',mint,6,launch.input.symbol),sol=asset('launchpad','solana',SOL,9,'SOL');
        // Coverage markers and cumulative counters can prove that retained
        // receipts are incomplete, but never substitute for earned receipts.
        if(launch.historyTruncated===true||launch.operationsTruncated===true){
          issue(launchIds,'The retained launch operation history is truncated.');
          for(const a of [sol,quote,base])unknownGross.add(assetKey(a));
        }
        const payout=new Map(),claimed=new Map();let missing=false,hasLp=false;
        for(const op of launch.operations||[]){
          check();if(op?.state!=='confirmed'||!op.signature)continue;
          if(!['create','launch-all','protocol-claim','protocol-lp-claim','protocol-payout','protocol-lp-payout'].includes(op.kind))continue;
          const opKey=`solana:${op.signature}`;if(seenOps.has(opKey))continue;seenOps.add(opKey);
          if(['create','launch-all'].includes(op.kind)){
            const receipt=op.creationFeeReceipt,amount=uint(receipt?.amount);
            if(receipt?.selfPayment===true)continue;
            if(amount!==null&&receipt.mint===SOL&&receipt.decimals===9&&typeof receipt.recipient==='string'&&receipt.recipient){add(byId.get('creation').rows,sol,{gross:amount,paid:amount});add(totals,sol,{gross:amount,paid:amount});byId.get('creation').records++;}
            else if(launch.review?.protocolFees?.creationFeeSol&&units(launch.review.protocolFees.creationFeeSol)>0n)issue(['creation'],'Older creation fees lack a retained transfer receipt.');
            continue;
          }
          const q=integer(op.receipt?.quoteDelta),b=integer(op.receipt?.baseDelta),kind=op.kind==='protocol-claim'?'curve':'lp';
          if(q===null||b===null){missing=true;if(op.kind==='protocol-claim'||op.kind==='protocol-lp-claim'){unknownGross.add(assetKey(quote));if(op.kind==='protocol-lp-claim')unknownGross.add(assetKey(base));}else{unknownPaid.add(assetKey(quote));if(op.kind==='protocol-lp-payout')unknownPaid.add(assetKey(base));}issue(op.kind.includes('payout')?['curve','lp']:[kind],'Some older protocol operations lack actual receipt amounts.',{revenue:!op.kind.includes('payout')});continue;}
          if(op.kind==='protocol-claim'||op.kind==='protocol-lp-claim'){
            if(q<0n||b<0n||op.kind==='protocol-claim'&&b!==0n){missing=true;unknownGross.add(assetKey(quote));if(op.kind==='protocol-lp-claim')unknownGross.add(assetKey(base));issue([kind],'Invalid protocol receipts are excluded.');continue;}
            if(kind==='lp')hasLp=true;
            const p=byId.get(kind);for(const [a,n] of [[quote,q],[base,b]])if(n>0n){add(p.rows,a,{gross:n,paid:null,pending:null});add(totals,a,{gross:n,pending:n});claimed.set(assetKey(a),(claimed.get(assetKey(a))||0n)+n);}p.records++;
          }else{
            if(q>0n||b>0n||op.kind==='protocol-payout'&&b!==0n){missing=true;unknownPaid.add(assetKey(quote));if(op.kind==='protocol-lp-payout'||b!==0n)unknownPaid.add(assetKey(base));issue(['curve','lp'],'Invalid treasury receipts are excluded.',{revenue:false});continue;}
            for(const [a,n] of [[quote,-q],[base,-b]])if(n>0n){add(payout,a,{paid:n});add(totals,a,{paid:n,pending:-n});}
          }
        }
        for(const [field,a,ids]of [['protocolClaimed',quote,['curve','lp']],['protocolBaseClaimed',base,['lp']]]){
          if(launch[field]===undefined)continue;
          const cumulative=uint(launch[field]),retained=claimed.get(assetKey(a))||0n;
          if(cumulative===null||cumulative>retained){unknownGross.add(assetKey(a));issue(ids,'Retained claim receipts do not cover the recorded cumulative claims.');}
        }
        // Payouts share protocol credit. Their source cannot be split reliably
        // between curve and LP; show exact combined treasury receipts in totals.
        if(hasLp||missing)for(const id of ['curve','lp'])byId.get(id).issues.add('Treasury transfers combine curve and LP fees; per-product received and pending amounts are unavailable.');
        for(const row of payout.values()){const total=totals.get(assetKey(row)),uncovered=row.paidAmount>(claimed.get(assetKey(row))||0n);if(total?.pendingAmount<0n||missing||uncovered){total.pendingAmount=null;issue(['curve','lp'],'Retained claim history does not cover every treasury transfer.',{revenue:uncovered});}}
        const tax=launch.taxProtocol;
        if(tax){
          const accrued=uint(tax.accruedQuote),paid=uint(tax.paidQuote),credit=uint(tax.creditQuote),converted=uint(tax.convertedQuote),holder=uint(tax.holderQuote),remainder=uint(tax.roundingRemainder);
          if(tax.policy==='collected-tax-proceeds-v1'&&tax.shareBps===500&&accrued!==null&&paid!==null&&credit!==null&&converted!==null&&holder!==null&&remainder!==null&&remainder<10000n&&accrued===paid+credit&&accrued+holder===converted&&accrued*10000n+remainder===converted*500n){add(byId.get('tax').rows,quote,{gross:accrued,paid,pending:credit});add(totals,quote,{gross:accrued,paid,pending:credit});byId.get('tax').records++;}
          else issue(['tax'],'Incomplete tax-share accounting is excluded.');
        }else if(launch.input.taxBps>0&&launch.curve)issue(['tax'],'Tax shares begin with new tracked collections; prior taxes are not included.');
      }
    }
    if(typeof this.meteoraRevenueSources==='function'||typeof this.meteoraSources==='function'){
      const item=product('meteora','Meteora received revenue','launchpad','1.00768% on the curve','Finalized protocol payouts from Meteora DBC and DAMM v2. After graduation, revenue follows Launchpad’s locked liquidity share. Unclaimed fees and collected funds awaiting forwarding are excluded.');list.push(item);byId.set(item.id,item);
      try{const coverage=typeof this.meteoraRevenueSources==='function'?await this.meteoraRevenueSources():null;
        const rows=typeof this.meteoraRevenueSources==='function'?coverage?.sources:await this.meteoraSources();if(!Array.isArray(rows)||rows.length>this.maxRecords)throw Error('Meteora revenue scan limit.');
        if(typeof this.meteoraRevenueSources==='function'&&coverage.complete!==true)issue(['creation','meteora'],'Retained finalized Meteora receipts do not cover the recorded revenue history.');
        for(const source of protocolTreasurySources([],rows)){
          check();const key=`solana:${source.signature}`;if(seenOps.has(key))continue;seenOps.add(key);
          const target=source.kind==='creation'?byId.get('creation'):item,a=asset('launchpad','solana',source.mint,source.decimals,source.symbol),amount=uint(source.amount);
          if(amount===null)throw Error('Invalid Meteora revenue.');add(target.rows,a,{gross:amount,paid:amount});add(totals,a,{gross:amount,paid:amount});target.records++;
        }
      }catch{item.issues.add('Meteora payout history could not be read completely. Missing revenue is unavailable.');item.revenueComplete=false;}
    }
    if(typeof this.dammPumpRevenueSources==='function'){
      const item=product('damm-pump','PumpSwap launch revenue','launchpad','Recorded received fees','Finalized DAMM protocol collections and graduation fees paid to Launchpad. Creation fees are listed under launch creation. Burned PumpSwap LP does not generate ongoing protocol LP fees.');list.push(item);byId.set(item.id,item);
      try{
        const coverage=await this.dammPumpRevenueSources();
        if(!Array.isArray(coverage?.sources)||coverage.sources.length>this.maxRecords)throw Error('Invalid PumpSwap revenue history.');
        if(coverage.complete!==true)issue(['damm-pump'],'Retained finalized PumpSwap receipts do not cover the recorded revenue history.');
        if(coverage.creationComplete!==true)issue(['creation'],'Some PumpSwap creation fees lack a verified finalized transfer.');
        const seen=new Set();
        for(const source of coverage.sources){
          check();const key=`solana:${source.signature}`,identity=`${key}:${source.kind}`;
          if(seen.has(identity)||seenOps.has(key))continue;seen.add(identity);
          const amount=uint(source.amount);
          if(!['creation','protocol-fees','graduation'].includes(source.kind)||amount===null||amount<=0n||!Number.isInteger(source.decimals)||source.decimals<0||source.decimals>18||typeof source.mint!=='string')throw Error('Invalid PumpSwap fee receipt.');
          const target=source.kind==='creation'?byId.get('creation'):item,a=asset('launchpad','solana',source.mint,source.decimals,source.symbol);
          add(target.rows,a,{gross:amount,paid:amount});add(totals,a,{gross:amount,paid:amount});target.records++;
        }
      }catch{issue(['creation','damm-pump'],'PumpSwap finalized fee history could not be read completely. Missing revenue is unavailable.');}
    }
    if(typeof this.pumpClassicRevenueSources==='function'){
      const item=product('pump-classic','Pump.fun platform share','launchpad','Recorded received fees','Finalized Pump.fun creator-fee distributions to each coin’s Launchpad platform wallet, including distributions triggered by other callers, in the asset received (SOL, or the coin’s Pump.fun pair). Each distribution is recorded once; later conversions of pair assets to SOL are swaps, not new revenue. Shares by launch option are published in the docs.');list.push(item);byId.set(item.id,item);
      try{
        const coverage=await this.pumpClassicRevenueSources();
        if(!Array.isArray(coverage?.sources)||coverage.sources.length>this.maxRecords)throw Error('Invalid Pump.fun revenue history.');
        if(coverage.complete!==true)issue(['pump-classic'],'Some Pump.fun receipt history is still being scanned.');
        const seen=new Set();
        for(const source of coverage.sources){
          check();const identity=`solana:${source.signature}:${source.eventIndex}:${source.wallet}`;if(seen.has(identity))continue;seen.add(identity);
          const amount=uint(source.amount),sol=source.mint==='So11111111111111111111111111111111111111112';
          if(amount===null||amount<=0n||typeof source.mint!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(source.mint)||!(sol?source.decimals===9:Number.isInteger(source.decimals)&&source.decimals>=0&&source.decimals<=18))throw Error('Invalid Pump.fun fee receipt.');
          const a=asset('launchpad','solana',source.mint,sol?9:source.decimals,sol?'SOL':source.symbol);add(item.rows,a,{gross:amount,paid:amount});add(totals,a,{gross:amount,paid:amount});item.records++;
        }
      }catch{issue(['pump-classic'],'Pump.fun receipt history could not be read completely. Missing revenue is unavailable.');}
    }
    if(typeof this.robinhoodRevenueSources==='function'){
      // v71.39 Robinhood Chain: the platform wallet's claims from the fee escrow (the platform share of every curve trade fee, and of the locked pool's fees after graduation), in ETH or the coin's pair asset.
      const item=product('robinhood','Robinhood Chain platform share','launchpad','Recorded received fees','The platform share of Robinhood Chain curve trade fees claimed from the Launchpad fee escrow by the host platform wallet, in ETH or the coin’s pair asset (USDG, a tokenised stock).');
      try{
        const coverage=await this.robinhoodRevenueSources();
        const sources=Array.isArray(coverage)?coverage:coverage?.sources;
        if(!Array.isArray(sources)||sources.length>this.maxRecords)throw Error('Invalid Robinhood revenue history.');
        const seen=new Set();
        for(const source of sources){
          check();const identity=`robinhood:${source.tx}:${source.logIndex??''}:${source.asset}`;if(seen.has(identity))continue;seen.add(identity);
          const amount=uint(source.amount),native=typeof source.asset==='string'&&/^0x0{40}$/i.test(source.asset);
          if(amount===null||amount<=0n||typeof source.asset!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(source.asset)||!(native?true:Number.isInteger(source.decimals)&&source.decimals>=0&&source.decimals<=18))throw Error('Invalid Robinhood fee claim.');
          const a=asset('launchpad','robinhood',native?'0x0000000000000000000000000000000000000000':source.asset.toLowerCase(),native?18:source.decimals,native?'ETH':source.symbol);add(item.rows,a,{gross:amount,paid:amount});add(totals,a,{gross:amount,paid:amount});item.records++;
        }
      }catch{issue(['robinhood'],'Robinhood Chain claim history could not be read completely. Missing revenue is unavailable.');}
    }
    if(typeof this.agentShareRevenueSources==='function'){
      const item=product('agent-share','AI Agent platform share','launchpad','Recorded received fees','Platform share set aside from AI Agent fee receipts on Raydium and Meteora and remitted to the protocol recipient. Pump.fun agents pay it through native fee sharing, listed under Pump.fun. Shares are published in the docs.');list.push(item);byId.set(item.id,item);
      try{
        const coverage=await this.agentShareRevenueSources();
        if(!Array.isArray(coverage?.sources)||coverage.sources.length>this.maxRecords)throw Error('Invalid agent platform-share history.');
        const seen=new Set();
        for(const source of coverage.sources){
          check();const key=`solana:${source.signature}`;if(seen.has(key)||seenOps.has(key))continue;seen.add(key);
          const amount=uint(source.amount);if(amount===null||amount<=0n||source.kind!=='agent-protocol-share'||source.mint!=='So11111111111111111111111111111111111111112')throw Error('Invalid agent platform-share remittance.');
          const a=asset('launchpad','solana',source.mint,9,'SOL');add(item.rows,a,{gross:amount,paid:amount});add(totals,a,{gross:amount,paid:amount});item.records++;
        }
      }catch{issue(['agent-share'],'AI Agent platform-share history could not be read completely. Missing revenue is unavailable.');}
    }
    if(poolRates.size)byId.get('lp').feeBasis+=` Recorded post-graduation pool trading fee tiers: ${[...poolRates].sort((a,b)=>a-b).map(bps=>`${bps/100}%`).join(', ')}. The pool fee tier is separate from Launchpad’s LP allocation.`;
    const productRows=list.filter(p=>p.id!=='legacy'||p.records||p.issues.size).map(p=>({id:p.id,label:p.label,scope:p.scope,feeLabel:p.feeLabel,feeBasis:p.feeBasis,...(p.noFees?{noFees:true}:{}),totals:reportAssets(p.rows),revenueComplete:p.revenueComplete,status:p.issues.size?p.records?'partial':'unavailable':'available',note:p.noFees?'Funding has no Launchpad protocol fee. Provider and network charges are not included as earnings.':[...p.issues].join(' ')||'Confirmed retained receipts only. No unclaimed onchain fees are estimated.'}));
    return {at:this.now(),refreshMs:this.cacheMs,coverage:'recorded-confirmed-history',note:'Confirmed retained history, not an audited lifetime total. Revenue refreshes every 15 seconds. Assets and treasury scopes are kept separate. Launchpad treasury transfers are gross amounts before any token transfer fee. '+(this.toolkit?'Cashback is an accrued liability; no cashback payouts are inferred. ':'')+'Missing or unverified history is excluded.',wallets:{...(this.toolkit?{toolkitSolana:safeText(solana.recipient),toolkitRobinhood:safeText(robinhood.recipient)}:{}),launchpad:safeText(policy.recipient)},products:productRows,totals:reportAssets(totals).map(row=>({...row,...(unknownGross.has(assetKey(row))?{knownGrossAmount:row.grossAmount,grossAmount:null,netAmount:null,pendingAmount:null,status:'partial'}:{}),...(unknownPaid.has(assetKey(row))?{knownPaidAmount:row.paidAmount,paidAmount:null,pendingAmount:null,status:'partial'}:{})}))};
  }
}
