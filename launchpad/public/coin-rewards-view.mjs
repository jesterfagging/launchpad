import {quoteLabel} from './quote-display-identity.mjs';
import {burnedUsdDisplay} from './burn-valuation.mjs';
import {gotchiTheme} from './gotchi-catalog.mjs';
import {basketRewardSentence} from './basket-ui.mjs';

const number=value=>value!=null&&value!==''&&['string','number'].includes(typeof value)&&Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null;
const amount=value=>{const n=number(value);return n===null?'—':new Intl.NumberFormat(undefined,{maximumSignificantDigits:6}).format(n);};
const date=(value,seconds=false)=>{const at=number(value);return at>0&&at<=8640000000000000?new Date(at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',...(seconds?{second:'2-digit'}:{})}):'';};
const modes=new Set(['holders','buyback','gotchi','paycheck']);

// Reward baskets (v71.33): the public basket of a Meteora holder-rewards coin, read defensively (symbols as text, counts as numbers).
const symbolText=value=>typeof value==='string'?value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').trim().slice(0,24):'';
const basketOf=data=>{const assets=Array.isArray(data?.basket?.assets)?data.basket.assets.filter(a=>a&&typeof a==='object'&&symbolText(a.symbol)).map(a=>({mint:String(a.mint||''),symbol:symbolText(a.symbol),decimals:number(a.decimals)})):[];return assets.length>=2?{assets}:null;};
const basketRows=data=>Array.isArray(data?.holder?.basket)?data.holder.basket.filter(r=>r&&typeof r==='object'&&symbolText(r.symbol)):[];
export function validCoinRewards(data,coin){return !!data&&modes.has(coin?.feeMode)&&data.mint===coin.mint&&data.mode===coin.feeMode&&data.quote?.mint===coin.quote?.mint;}

// Shared read-only card. Signing and operator actions stay in account controls.
export function createCoinRewardsView({document,root,onRefresh=()=>{}}={}){
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
  root.classList.add('coin-rewards');const prefix=root.id||'coin-rewards';
  const header=el('div',null,'coin-card-heading'),title=el('h2','Holder rewards'),actions=el('div',null,'coin-rewards-actions'),activity=el('a','View activity ↗','coin-rewards-activity'),refresh=el('button','Refresh','text-button');title.id=prefix+'-title';refresh.id=prefix+'-refresh';refresh.type='button';refresh.setAttribute('aria-label','Refresh reward information');refresh.onclick=()=>refresh.getAttribute('aria-disabled')==='true'?undefined:onRefresh();activity.target='_blank';activity.rel='noopener noreferrer';activity.hidden=true;actions.append(activity,refresh);header.append(title,actions);
  const statusRow=el('div',null,'coin-rewards-status-row'),mode=el('span',null,'coin-rewards-mode'),state=el('span',null,'coin-rewards-state');state.id=prefix+'-state';statusRow.append(mode,state);
  const description=el('p',null,'coin-rewards-description'),wallets=el('p',null,'coin-rewards-note'),primary=el('div',null,'coin-rewards-primary'),secondary=el('div',null,'coin-rewards-secondary'),schedule=el('p',null,'coin-rewards-schedule'),latest=el('p',null,'coin-rewards-latest'),note=el('p',null,'coin-rewards-note');
  description.id=prefix+'-description';wallets.id=prefix+'-wallets';wallets.hidden=true;primary.id=prefix+'-primary';secondary.id=prefix+'-secondary';schedule.id=prefix+'-schedule';latest.id=prefix+'-latest';note.id=prefix+'-note';note.setAttribute('role','status');root.setAttribute('aria-labelledby',title.id);root.replaceChildren(header,statusRow,description,wallets,primary,secondary,schedule,latest,note);
  // A busy Refresh stays focusable (aria-disabled) so keyboard focus is not lost.
  function busyRefresh(busy){if(busy)refresh.setAttribute('aria-disabled','true');else refresh.removeAttribute('aria-disabled');refresh.textContent=busy?'Refreshing…':'Refresh';}
  // Gotchi coins fund a shared prize pot instead of paying holders directly.
  // Decorative only: the coin's Gotchi peeks into its prize-pot card once (the shared motion layer draws it).
  let peeked='';
  function peekGotchi(id){
    const motion=document.defaultView?.curveMotion;if(!id||peeked===id||typeof motion?.peek!=='function'||!gotchiTheme(id))return;peeked=id;
    try{Promise.resolve(motion.peek(root,{theme:id,stage:1,side:'right',height:88})).catch(()=>{});}catch{}
  }
  function renderGotchi({coin,data,busy,error}){
    const gotchi=data?.gotchi||coin.gotchi||{},theme=gotchiTheme(gotchi.id)?.name||gotchi.theme||gotchi.id||'Gotchi',href='/gotchi?id='+encodeURIComponent(gotchi.id||'');
    peekGotchi(gotchi.id);
    busyRefresh(busy);title.textContent='Gotchi prize pot';mode.textContent='Fees → '+theme+' pot';activity.hidden=true;activity.removeAttribute('href');
    // Only graduated coins race for the pot; a coin still on its curve funds it without competing yet.
    const racing=coin.stage==='graduated';
    state.textContent=data?(racing?'Racing':'Not racing yet'):error?'Unavailable':'Loading';state.dataset.state=data?(racing?'enabled':'paused'):'unknown';
    const tax=number(data?.taxBps??coin.taxBps);
    description.textContent=coin.platform==='meteora'?`The creator allocation of this coin’s 2.52% Meteora trading fee is routed to ${theme}’s prize pot. There is no transfer tax and no creator payout.`:`A ${tax===null?'1':amount(tax/100)}% transfer tax on every buy, sell and transfer is converted to SOL by Launchpad: 95% fills ${theme}’s prize pot and 5% goes to the Launchpad protocol. There is no creator fee.`;
    wallets.hidden=true;primary.replaceChildren();secondary.replaceChildren();schedule.textContent='';
    if(data?.gotchi?.contributedRaw!==undefined){const decimals=number(data.gotchi.quoteDecimals)??9,scale=10**decimals;metric(primary,'contributed','Contributed to the pot',Number(data.gotchi.contributedRaw)/scale,data.gotchi.quoteSymbol||'');metric(secondary,'pending','Awaiting payout',Number(data.gotchi.pendingRaw||0)/scale,data.gotchi.quoteSymbol||'');}
    latest.replaceChildren();const link=el('a','Open the '+theme+' race ↗','coin-rewards-activity');link.href=href;latest.append(link);
    note.textContent=error||'Only graduated coins compete. The top 10 time-averaged holders across the Gotchi’s graduated coins share the pot when it reaches $10,000.';
  }
  // Paycheck (v71.44): the creator fee paid out every 15 minutes. The card shows the split, what holders are accruing,
  // what has been paid and what sellers forfeited; the per-wallet ledger itself is never published.
  function renderPaycheck({coin,data,busy,error}){
    const value=validCoinRewards(data,coin)?data:null,quote=quoteLabel(coin.quote?.mint,value?.quote?.symbol,coin.quote?.symbol),pay=value?.paycheck&&value.paycheck.accountingUnavailable!==true?value.paycheck:null,holder=value?.holder;
    busyRefresh(busy);title.textContent='Paycheck';mode.textContent='Creator fee → holders · $LAUNCHPAD burn · Launchpad · creator';
    const activityUrl=typeof value?.activityUrl==='string'&&/^https:\/\/solscan\.io\/account\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.activityUrl)?value.activityUrl:null;activity.hidden=!activityUrl;if(activityUrl)activity.href=activityUrl;else activity.removeAttribute('href');
    const retryAt=value?.enabled&&value.status==='retrying'?date(value.retryAt,true):'';
    state.textContent=value?retryAt?'Retry scheduled':value.status==='processing'?'Paying out':value.status==='unavailable'?'Unavailable':value.enabled?'Enabled':'Paused':error?'Unavailable':'Loading';state.dataset.state=!value||value.status==='unavailable'?'unknown':value.enabled?'enabled':'paused';
    const split=pay?.split||{holders:5000,burn:3500,curve:1000,creator:500},pct=key=>(split[key]/100).toLocaleString(undefined,{maximumFractionDigits:2})+'%';
    description.textContent=`Every ${amount(pay?.intervalMinutes??15)} minutes the 0.50% creator fee is paid out in ${quote}: ${pct('holders')} to holders by their balance, ${pct('burn')} buys and burns $LAUNCHPAD, ${pct('curve')} to Launchpad and ${pct('creator')} to the creator. A wallet is paid once its share reaches $${(pay?.thresholdUsd??0.5).toFixed(2)}; smaller amounts roll over, and selling before the payout forfeits the pending amount to the other holders.`;
    wallets.replaceChildren();wallets.hidden=true;
    const roles=value?.wallets,validAddress=address=>typeof address==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    if(roles?.status==='active'&&validAddress(roles.rewardsAddress)&&validAddress(roles.creatorAddress)&&roles.rewardsAddress!==roles.creatorAddress){
      wallets.hidden=false;wallets.append(el('span','Launchpad manages a separate wallet for the payouts. '));
      for(const [label,address]of [['Payout wallet ↗',roles.rewardsAddress],['Fee collection wallet ↗',roles.creatorAddress]]){if(wallets.children.length>1)wallets.append(el('span',' · '));const link=el('a',label);link.href='https://solscan.io/account/'+address;link.title=address;link.target='_blank';link.rel='noopener noreferrer';wallets.append(link);}
    }
    primary.replaceChildren();secondary.replaceChildren();schedule.textContent='';latest.textContent='';
    metric(primary,'paid-holders','Paid to holders',pay?.paidToHolders,quote,number(holder?.payments)!==null?`${amount(holder.payments)} confirmed payments`:'Confirmed payouts since launch');
    metric(primary,'accruing','Accruing to holders',pay?.accruing,quote,number(pay?.accruingWallets)!==null?`${amount(pay.accruingWallets)} wallets below the $${(pay?.thresholdUsd??0.5).toFixed(2)} payout line`:'Pending shares below the payout line');
    metric(secondary,'claimed','Fees paid out so far',pay?.claimed,quote);
    metric(secondary,'burn','Sent to the $LAUNCHPAD burn',pay?.allocatedToBurn,quote);
    metric(secondary,'curve','Sent to Launchpad',pay?.allocatedToCurve,quote);
    metric(secondary,'creator','Creator share',pay?.allocatedToCreator,quote);
    metric(secondary,'forfeited','Forfeited by sellers',pay?.forfeited,quote);
    metric(secondary,'unclaimed',holder?.unclaimedScope==='curve_and_pool'?'Unclaimed creator fees':'Unclaimed curve fees',holder?.unclaimedCreatorQuote,quote);
    if(value)schedule.textContent=value.enabled?`Checked every ${amount(pay?.intervalMinutes??15)} minutes · the fee vault is claimed from $${(pay?.claimMinimumUsd??1).toFixed(2)} · each wallet is paid at $${(pay?.thresholdUsd??0.5).toFixed(2)}`:'Automatic payouts are paused.';
    if(retryAt)schedule.textContent='Next automatic check: '+retryAt+'. '+schedule.textContent;
    if(holder?.lastDistributionAt)latest.textContent=`Last payout ${amount(holder.lastDistributionQuote)} ${quote} · ${date(holder.lastDistributionAt)}`+(number(pay?.cycles)!==null?` · ${amount(pay.cycles)} cycles`:'');
    else if(value&&number(holder?.distributedQuote)===0)latest.textContent='No confirmed payouts yet.';
    const observed=number(value?.asOf),history=holder?.historyComplete===false?holder.historyNote||'Some earlier transaction amounts are unavailable.':'';
    note.textContent=[error||value?.error,value?.paycheck?.accountingUnavailable===true?'Paycheck accounting needs review; amounts are unavailable.':'',value?.stale?'Balances delayed; showing the last reading.':'',observed?'Updated '+date(observed):'',history].filter(Boolean).join(' ');
    if(!value&&!busy&&!error)note.textContent='Reward information is not available yet.';
  }
  function valueNode(value,unit){const strong=el('strong',amount(value));if(unit&&number(value)!==null)strong.append(el('span',unit,'coin-reward-unit'));if(value!=null)strong.title=String(value)+(unit?' '+unit:'');return strong;}
  function metric(target,key,label,value,unit,caption){const row=el('div');row.dataset.rewardMetric=key;if(target===primary){const line=el('div',null,'coin-reward-value-row');line.append(el('span',label),valueNode(value,unit));row.append(line);if(caption)row.append(el('small',caption));}else{row.append(valueNode(value,unit),el('small',label));}target.append(row);}
  function burnValue(target,key,tokens,price,mint,now){const row=el('div'),value=burnedUsdDisplay(tokens,price,{mint,now});row.dataset.rewardMetric=key;const caption=value==='—'?'Current USD price unavailable. This is not historical buyback spending.':'Confirmed burns valued at the current token price; not historical buyback spending.';if(target===primary){const line=el('div',null,'coin-reward-value-row');line.append(el('span','Burned value · current price'),el('strong',value));row.append(line,el('small',caption));}else{row.append(el('strong',value),el('small','Burned value · current price'));row.title=caption;}target.append(row);}
  function render({coin,data=null,busy=false,error='',price=null,now=Date.now()}={}){
    const visible=modes.has(coin?.feeMode);root.hidden=!visible;if(!visible)return;
    if(coin.feeMode==='gotchi'){renderGotchi({coin,data:validCoinRewards(data,coin)?data:null,busy,error});return;}
    if(coin.feeMode==='paycheck'){renderPaycheck({coin,data,busy,error});return;}
    const valid=validCoinRewards(data,coin),value=valid?data:null,isHolder=coin.feeMode==='holders',quote=quoteLabel(coin.quote?.mint,value?.quote?.symbol,coin.quote?.symbol),symbol=coin.symbol||value?.tokenSymbol||'tokens',holder=value?.holder,buyback=value?.buyback,taxBurn=isHolder&&value?.taxBurn?.selected===true?value.taxBurn:null;
    busyRefresh(busy);title.textContent=isHolder?taxBurn?'Tax burns & holder rewards':'Holder rewards':'Tokenized agent';mode.textContent=isHolder?taxBurn?'Tax → burn · Creator fees → holders':'Shared with holders':'Automated buyback & burn';
    const activityUrl=typeof value?.activityUrl==='string'&&/^https:\/\/solscan\.io\/account\/[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.activityUrl)?value.activityUrl:null;activity.hidden=!activityUrl;if(activityUrl)activity.href=activityUrl;else activity.removeAttribute('href');
    const retryAt=value?.enabled&&value.status==='retrying'?date(value.retryAt,true):'';
    const needsAttention=value?.automation?.enabled===true&&['paused','error'].includes(value.automation.state);
    state.textContent=value?retryAt?'Retry scheduled':value.status==='processing'?'Processing':value.status==='unavailable'?'Unavailable':needsAttention?'Needs attention':value.enabled?'Enabled':'Paused':error?'Unavailable':'Loading';state.dataset.state=!value||value.status==='unavailable'||needsAttention?'unknown':value.enabled?'enabled':'paused';
    description.textContent=isHolder?taxBurn?`The ${amount(Number(value?.taxBps??coin.taxBps)/100)}% transfer tax is collected in ${symbol} and ${taxBurn.manual===true?'kept in the rewards wallet until the team burns it':'burned directly'}, without selling it for ${quote}. Separately accrued creator fees in ${quote} still fund holder rewards. Protocol fees from Launchpad’s locked LP go to the treasury. Previously owed ${quote} rewards remain payable.`:`${coin.platform==='meteora'?'The creator share of Meteora trading fees funds holder rewards. ':''}${basketOf(value)?basketRewardSentence(basketOf(value)):`Rewards are paid in ${quote}, weighted by eligible token balances.`}${Number(value?.taxBps??coin.taxBps)>0?" Launchpad receives 5% of newly converted tax proceeds; 95% funds holder rewards.":""}`:`Creator fees in ${quote} fund purchases of ${symbol}. Purchased tokens are burned after confirmation.`;
    wallets.replaceChildren();wallets.hidden=true;
    const roles=value?.wallets,validAddress=address=>typeof address==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
    if(isHolder&&roles?.status==='active'&&validAddress(roles.rewardsAddress)&&validAddress(roles.creatorAddress)&&roles.rewardsAddress!==roles.creatorAddress){
      wallets.hidden=false;wallets.append(el('span',taxBurn?'Launchpad manages a separate wallet for collected-tax burns and holder payouts. ':'Launchpad manages a separate wallet for reward conversions and holder payouts. '));
      for(const [label,address]of [['Reward wallet ↗',roles.rewardsAddress],['Creator collection wallet ↗',roles.creatorAddress]]){if(wallets.children.length>1)wallets.append(el('span',' · '));const link=el('a',label);link.href='https://solscan.io/account/'+address;link.title=address;link.target='_blank';link.rel='noopener noreferrer';wallets.append(link);}
    }else if(isHolder&&roles?.status==='migrating'){wallets.hidden=false;wallets.textContent='A separate reward conversion wallet is being prepared. Existing reward transactions finish before funds move.';}
    else if(isHolder&&roles?.status==='unavailable'){wallets.hidden=false;wallets.textContent='The saved reward conversion wallet could not be verified. Current wallet balances are unavailable.';}
    primary.replaceChildren();secondary.replaceChildren();schedule.textContent='';latest.textContent='';
    if(isHolder){
      metric(primary,'distributed','Distributed',holder?.distributedQuote,quote,number(holder?.payments)!==null?`${amount(holder.payments)} confirmed holder payments`:'Confirmed holder payments');
      metric(primary,'collecting','Collecting',holder?.pendingQuote,quote,retryAt?'Earned quote rewards remain recorded while automatic processing waits to retry.':value?.status==='processing'?'Includes earned funds committed to processing payments.':'Earned quote rewards awaiting distribution.');
      metric(secondary,'unclaimed',holder?.unclaimedScope==='curve_and_pool'?'Unclaimed creator fees':'Unclaimed curve fees',holder?.unclaimedCreatorQuote,quote);
      const basket=basketOf(value);
      if(basket){for(const row of basketRows(value).slice(1)){metric(secondary,'basket-'+row.symbol.toLowerCase(),'Distributed in '+row.symbol,row.distributed,row.symbol);metric(secondary,'basket-pending-'+row.symbol.toLowerCase(),'Collecting in '+row.symbol,row.pending,row.symbol);}
        const stage=typeof value?.holder?.stage==='string'?value.holder.stage:null;if(stage){const row=el('div');row.dataset.rewardMetric='basket-stage';row.append(el('strong',stage==='convert'?'Converting':stage==='allocate'?'Allocating':stage==='payout'?'Paying out':symbolText(stage)),el('small','Current round'));secondary.append(row);}}
      if(taxBurn){
        metric(primary,'tax-burned','Tokens burned directly',taxBurn.tokensBurned,symbol,number(taxBurn.completedBurns)!==null?`${amount(taxBurn.completedBurns)} confirmed burns · no buyback spending${taxBurn.initialInventory?.status==='burned'?' · includes approved initial inventory':''}`:'Confirmed direct burns · no buyback spending');
        burnValue(primary,'tax-burned-usd',taxBurn.tokensBurned,price,coin.mint,now);
        metric(secondary,'tax-burn-pending','Collected tax awaiting burn',taxBurn.pendingTaxTokens,symbol);
        if(taxBurn.initialInventory?.status==='authorized')metric(secondary,'initial-burn','Initial burn approved (includes collected tax)',taxBurn.initialInventory.approvedTokens,symbol);
        else if(number(taxBurn.unattributedTokens)>0)metric(secondary,'tax-reserved','Other token credit reserved',taxBurn.unattributedTokens,symbol);
      }else if(coin.platform!=='meteora')metric(secondary,'conversion','Tokens awaiting conversion',holder?.unconvertedTaxTokens,symbol);
      if(number(holder?.withheldTokens)!==null)metric(secondary,'withheld',holder.withheldStale?'Uncollected transfer tax · delayed':'Uncollected transfer tax · estimate',holder.withheldTokens,symbol);
      const tax=number(value?.taxBps??coin.taxBps);if(tax!==null)metric(secondary,'tax','Transfer tax',tax/100,'%');
      if(value){const minimum='$100 in '+quote;const interval=number(holder?.intervalMinutes);schedule.textContent=value.enabled?[interval===60?'Checked hourly':interval?`Checked every ${amount(interval)} minutes`:'Automatic distribution',minimum?'once at least '+minimum+' is ready':''].filter(Boolean).join(' · '):needsAttention?'Automatic distributions need operator attention.':'Automatic distributions are paused.';}
      const rounds=Array.isArray(holder?.rounds)?holder.rounds.filter(r=>r&&Array.isArray(r.assets)):[],lastRound=rounds.at(-1);
      if(basket&&lastRound)latest.textContent='Last round · '+lastRound.assets.map(a=>`${amount(a.amount)} ${symbolText(a.symbol)}`).join(' · ')+(number(lastRound.assets[0]?.recipients)!==null?` to ${amount(lastRound.assets[0].recipients)} holders`:'')+(date(lastRound.at)?' · '+date(lastRound.at):'')+(Array.isArray(lastRound.skipped)&&lastRound.skipped.length?' · '+lastRound.skipped.map(x=>symbolText(basket.assets.find(a=>a.mint===x.mint)?.symbol)||'an asset').join(', ')+' paid in '+quote+' (no conversion route)':'');
      else if(holder?.lastDistributionAt)latest.textContent=`Last distributed ${amount(holder.lastDistributionQuote)} ${quote} · ${date(holder.lastDistributionAt)}`;
      else if(value&&number(holder?.distributedQuote)===0)latest.textContent='No confirmed distributions yet.';
      if(taxBurn){
        const taxRetry=date(value.taxMaintenance?.retry?.at,true),taxSchedule=needsAttention?'Automatic tax collection and burning need operator attention. Collected tax stays reserved.':!value.enabled?'Automatic tax collection is paused with the reward service. Tax burns are paused; collected tax stays reserved.':taxBurn.enabled&&!taxBurn.paused?taxBurn.manual===true?(taxRetry?`Tax collection is waiting to retry. ${value.taxMaintenance.retry.at>now?'Next tax check: '+taxRetry+'.':'The next tax check is due.'}`:'Tax is collected automatically and kept in the rewards wallet until the team burns it. It is never sold.'):taxRetry?`Tax collection and burning are waiting to retry. ${value.taxMaintenance.retry.at>now?'Next tax check: '+taxRetry+'.':'The next tax check is due.'} Saved transactions are checked first.`:'Automatic tax collection and burning are enabled, checked separately from holder payouts. Collected tax is burned after collection confirms.':'Tax burns are paused by server settings or burn approval; collected tax stays reserved.';
        schedule.textContent+=(schedule.textContent?' ':'')+taxSchedule;
        if(typeof taxBurn.lastBurnSignature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(taxBurn.lastBurnSignature)){const link=el('a','Latest tax burn ↗');link.href='https://solscan.io/tx/'+taxBurn.lastBurnSignature;link.target='_blank';link.rel='noopener noreferrer';latest.append(el('span',latest.textContent?' · ':''),link);}
        if(taxBurn.accountingUnavailable)schedule.textContent+=' Tax-burn accounting needs review; amounts are unavailable.';
      }
    }else{
      const hasSpent=number(buyback?.totalQuoteSpent)!==null;
      metric(primary,'completed','Buybacks completed',hasSpent?buyback.totalQuoteSpent:buyback?.completedBuys,hasSpent?quote:'buys',hasSpent&&number(buyback?.completedBuys)!==null?`${amount(buyback.completedBuys)} confirmed buys`: 'Confirmed onchain · historical quote total unavailable');
      metric(primary,'pending','Buybacks pending',buyback?.pendingQuote,quote,retryAt?'Earned quote funds remain recorded while automatic processing waits to retry.':number(buyback?.pendingOperations)>0?`${amount(buyback.pendingOperations)} operation${Number(buyback.pendingOperations)===1?'':'s'} processing; funds stay included until confirmed.`:'Earned quote funds awaiting buyback.');
      metric(secondary,'rate','Buyback rate',buyback?.buybackPercent,'%');
      metric(secondary,'claimed','Revenue claimed',buyback?.totalClaimedQuote,quote);
      metric(secondary,'unclaimed',buyback?.unclaimedScope==='curve_and_pool'?'Unclaimed creator fees':'Unclaimed curve fees',buyback?.unclaimedCreatorQuote,quote);
      metric(secondary,'burned','Tokens burned',buyback?.tokensBurned,symbol);
      burnValue(secondary,'burned-usd',buyback?.tokensBurned,price,coin.mint,now);
      metric(secondary,'bought','Tokens bought',buyback?.tokensBought,symbol);
      metric(secondary,'pending-burn','Tokens awaiting burn',buyback?.pendingBurnTokens,symbol);
      if(value){schedule.textContent=value.enabled?'Launchpad automatically buys back and burns tokens with available creator fees.':'Automatic buybacks are paused.';if(number(buyback?.buybackPercent)!==null)schedule.textContent=`${amount(buyback.buybackPercent)}% of available creator fees are allocated to buybacks. `+schedule.textContent;}
      if(buyback?.lastBuybackAt)latest.textContent='Last confirmed buyback · '+date(buyback.lastBuybackAt);
      else if(value&&number(buyback?.completedBuys)===0)latest.textContent='No confirmed buybacks yet.';
    }
    if(retryAt)schedule.textContent=(taxBurn?'Next automatic holder reward check: ':'Next automatic check: ')+retryAt+'. '+schedule.textContent;
    const section=isHolder?holder:buyback,observed=number(value?.asOf),history=section?.historyComplete===false?section.historyNote||'Some earlier transaction amounts are unavailable.':'';
    if(number(section?.unclaimedBaseTokens)>0)metric(secondary,'unclaimed-tokens','Unclaimed token fees',section.unclaimedBaseTokens,symbol);
    const coverage=section?.unclaimedNote||(section?.unclaimedShared?'This creator-fee vault is shared; a per-coin balance is unavailable.':valid?section?.unclaimedScope==='curve_and_pool'?'Unclaimed fees: verified curve and pool.':'Unclaimed fees: launch curve only.':'');
    note.textContent=[error||value?.error,value?.stale?'Balances delayed; showing the last reading.':'',observed?'Updated '+date(observed):'',history,coverage,valid&&isHolder&&number(holder?.withheldTokens)!==null?holder.withheldStale?'Transfer-fee balance is delayed.':'Unclaimed transfer fees are estimates.':''].filter(Boolean).join(' ');
    if(!value&&!busy&&!error)note.textContent='Reward information is not available yet.';
  }
  return {render};
}
