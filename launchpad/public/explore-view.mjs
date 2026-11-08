import {gotchiTheme} from './gotchi-catalog.mjs';
import {coinImage} from './coin-image.mjs';
import {createQuoteLabel} from './quote-logos.mjs';
import {createLaunchAmmBadge} from './amm-branding.mjs';
const address = value => typeof value === 'string' && (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) || /^0x[0-9a-fA-F]{40}$/.test(value));
export const isRobinhood = coin => coin?.chain === 'robinhood' || /^0x[0-9a-fA-F]{40}$/.test(String(coin?.mint || ''));
export const exploreNumber = value => value !== null && value !== undefined && value !== '' && ['number','string'].includes(typeof value) && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
export const exploreShort = value => typeof value === 'string' && value.length > 14 ? `${value.slice(0,5)}…${value.slice(-4)}` : value || '—';
const compactMoney=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',notation:'compact',maximumFractionDigits:2}),preciseMoney=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumSignificantDigits:4});
export function exploreMoney(value) {
  const n=exploreNumber(value);
  return n===null?'—':(n>=1000?compactMoney:preciseMoney).format(n);
}
// Only rendered fields invalidate a card. Provider timestamps and other metadata
// can change on every poll without replacing loaded logos or creating new nodes.
export function exploreCardVersion(coin,{stage}={}){
  if(!coin||!address(coin.mint))return '';
  const quote=coin.quote||{};
  return JSON.stringify([stage,coin.mint,coin.name,coin.symbol,coin.image,coin.stage,coin.curveStatus,coin.movingReason,coin.feeMode,coin.marketCapUsd,coin.fdvUsd,coin.stale,coin.volume24h,coin.volume24hQuote,coin.volumeObserved,coin.volumeObservedQuote,coin.volumeUsdEstimate,coin.volumeSource,coin.launchMode,coin.platform,coin.venue,coin.progressPercent,coin.stageStale,coin.createdAt,quote.mint,quote.symbol,quote.category,quote.name,quote.issuer,quote.logoPath,quote.imagePath,exploreHookNames(coin),exploreHookRoute(coin),exploreHookAppName(coin),coin.option?.phase]);
}
// Transfer hook rules (v71.28): a hooked Meteora coin's row carries `hook.rules` ([{ id, name, text }]) and `hook.route`
// ('any' | 'curve'); the grid shows a small "Hooked" chip whose title lists the rule names and, for a coin that trades on
// Launchpad only until graduation, a "Launchpad route" marker. Missing or malformed → no chip.
export const exploreHookNames=coin=>Array.isArray(coin?.hook?.rules)?coin.hook.rules.map(rule=>typeof rule==='string'?rule:typeof rule?.name==='string'&&rule.name?rule.name:typeof rule?.id==='string'?rule.id:'').filter(Boolean).slice(0,8):[];
export const exploreHookRoute=coin=>exploreHookNames(coin).length&&(coin.hook.route==='curve'||coin.hook.route==='app')?coin.hook.route:exploreHookNames(coin).length?'any':'';
const EXPLORE_CURVE_ROUTE_TEXT='Launchpad route only: trades on Launchpad while it is on the curve, because its rules need accounts or a payment only Launchpad adds to a trade. Trades anywhere after graduation.';
/** App only (v71.35): the coin trades only in the named app while on the curve; Launchpad's Buy and Sell are off for it until graduation. */
export const exploreHookAppName=coin=>exploreHookRoute(coin)==='app'?(typeof coin.hook.appName==='string'&&coin.hook.appName?coin.hook.appName:'App'):'';
const exploreAppRouteText=name=>name+' only: trades only in '+name+' while it is on the curve, so Launchpad’s Buy and Sell are off for it until it graduates. Trades anywhere after graduation.';
export function exploreAge(value,now=Date.now()) {
  const at=exploreNumber(value);if(at===null||at<=0||at>8640000000000000)return 'Age unavailable';
  const seconds=Math.max(0,Math.floor((now-at)/1000));
  if(seconds<60)return `${seconds}s ago`;
  if(seconds<3600)return `${Math.floor(seconds/60)}m ago`;
  if(seconds<86400)return `${Math.floor(seconds/3600)}h ago`;
  return `${Math.floor(seconds/86400)}d ago`;
}
export function exploreFilters(params=new URLSearchParams()) {
  const one=(key,choices,fallback)=>choices.includes(params.get(key))?params.get(key):fallback;
  return {search:(params.get('search')||'').trim().replace(/^\$+/,'').trim().slice(0,100),category:one('category',['all','crypto','stocks','preipo'],'all'),launchMode:one('launchMode',['all','pumpswap','raydium','meteora','damm-pump','pump-classic','robinhood'],'all'),chain:one('chain',['all','solana','robinhood'],'all'),quote:address(params.get('quote'))?params.get('quote'):'',feeMode:one('feeMode',['creator','holders','buyback','gotchi'],''),age:one('age',['all','24h','7d'],'all'),sort:one('sort',['recentBuys','newest','oldest','marketCap','volume','progress','launchType','quote'],'newest')};
}
/** A Robinhood pair's label: the badge the host serves (the stock's or ETF's own mark, a lettermark otherwise) and the ticker. */
export function robinhoodPairLabel(document,quote) {
  const root=document.createElement('span');root.className='quote-identity explore-coin-pair explore-coin-pair-robinhood';root.title='Paired with '+String(quote?.symbol||'ETH')+' on Robinhood Chain';
  const badge=document.createElement('span');badge.className='quote-logo explore-rh-badge';badge.setAttribute('aria-hidden','true');
  const mark=document.createElement('span');mark.className='explore-rh-mark';mark.textContent=quote?.kind==='native'||/^ETH$/i.test(String(quote?.symbol||''))?'Ξ':String(quote?.symbol||'ET').slice(0,2);badge.append(mark);
  if(typeof quote?.logo==='string'&&/^\/robinhood-pairs\/logo\/0x[0-9a-fA-F]{40}(?:\?v=\d+)?$/.test(quote.logo)){const img=document.createElement('img');img.src=quote.logo;img.alt='';img.width=18;img.height=18;img.loading='lazy';img.addEventListener('error',()=>{img.remove();mark.hidden=false;});mark.hidden=true;badge.append(img);}
  const label=document.createElement('span');label.className='quote-symbol';label.textContent=String(quote?.symbol||'ETH');
  root.append(badge,label);return root;
}
export function createExploreCard(document,coin,{stage,now=Date.now()}={}) {
  if(!coin||!address(coin.mint))return null;
  const el=(tag,text,cls)=>{const item=document.createElement(tag);if(text!==undefined&&text!==null)item.textContent=String(text);if(cls)item.className=cls;return item;};
  const card=el('a',null,'explore-coin');card.href=typeof coin.coinUrl==='string'&&coin.coinUrl.startsWith('/coin?')?coin.coinUrl:'/coin?mint='+encodeURIComponent(coin.mint)+(isRobinhood(coin)?'&chain=robinhood':'');card.dataset.mint=coin.mint;if(isRobinhood(coin))card.dataset.chain='robinhood';
  const name=String(coin.name||coin.symbol||'Unnamed coin').slice(0,120),symbol=String(coin.symbol||'COIN').slice(0,20);
  card.setAttribute('aria-label',`${name}, ${symbol}. View coin`);
  const picture=el('div',null,'explore-coin-image'),fallback=el('span',symbol.toUpperCase());fallback.setAttribute('aria-hidden','true');picture.append(fallback);
  const imageSource=coinImage(coin.mint,coin.image);
  if(imageSource){
    const img=el('img');img.src=imageSource;img.alt='';img.loading='lazy';img.decoding='async';picture.append(img);fallback.hidden=true;img.onerror=()=>{img.remove();fallback.hidden=false;};
  }
  const badges=el('div',null,'explore-coin-badges');
  // Badge classes only colour-code the existing labels (stage, then reward mode).
  if(coin.stage==='graduated')badges.append(el('span','Graduated','explore-coin-badge is-graduated'));
  else if(stage==='moving')badges.append(el('span',coin.movingReason==='volume'?'Volume rising':coin.movingReason==='both'?'Gaining momentum':'Moving on up','explore-coin-badge is-moving'));
  else if(coin.curveStatus==='migrating')badges.append(el('span','Graduating','explore-coin-badge is-graduating'));
  if(coin.feeMode==='gotchi')badges.append(el('span','Gotchi · '+(gotchiTheme(coin.gotchi?.id)?.name||'race'),'explore-coin-badge is-gotchi'));
  else if(coin.feeMode==='agent')badges.append(el('span','AI Agent','explore-coin-badge is-agent'));
  else if(coin.feeMode==='holders')badges.append(el('span','Holder rewards','explore-coin-badge is-holders'));
  else if(coin.feeMode==='paycheck')badges.append(el('span','Paycheck','explore-coin-badge is-paycheck'));
  else if(coin.feeMode==='buyback')badges.append(el('span','Agent buyback','explore-coin-badge is-buyback'));
  else if(coin.feeMode==='creator')badges.append(el('span','Creator fees','explore-coin-badge is-creator'));
  else if(coin.feeMode==='market_maker')badges.append(el('span','Market Maker','explore-coin-badge is-strategy'));
  else if(coin.feeMode==='lp_manager')badges.append(el('span','Liquidity Manager','explore-coin-badge is-strategy'));
  else if(coin.feeMode==='diamond_hands')badges.append(el('span','Diamond Hands','explore-coin-badge is-option'));
  else if(coin.feeMode==='earned')badges.append(el('span',coin.option?.phase==='failed'?'Earned · failed':coin.option?.phase==='earned'?'Earned':'Earned · probation','explore-coin-badge is-option'));
  else if(coin.feeMode==='insured')badges.append(el('span',coin.option?.phase==='holders'?'Insured · refunding':coin.option?.phase==='released'||coin.option?.phase==='bonus'?'Insured · graduated':'Insured','explore-coin-badge is-option'));
  const hookNames=exploreHookNames(coin);
  if(hookNames.length){const hooked=el('span','Hooked','explore-coin-badge is-hooked');hooked.setAttribute('title','Transfer hook rules: '+hookNames.join(' · '));hooked.setAttribute('aria-label','Transfer hook rules: '+hookNames.join(', '));badges.append(hooked);
    if(exploreHookRoute(coin)==='curve'){const route=el('span','Launchpad route','explore-coin-badge is-hooked is-curve-route');route.setAttribute('title',EXPLORE_CURVE_ROUTE_TEXT);route.setAttribute('aria-label',EXPLORE_CURVE_ROUTE_TEXT);badges.append(route);}
    else if(exploreHookRoute(coin)==='app'){const name=exploreHookAppName(coin),route=el('span',name+' only','explore-coin-badge is-hooked is-app-route');route.setAttribute('title',exploreAppRouteText(name));route.setAttribute('aria-label',exploreAppRouteText(name));badges.append(route);}}
  picture.append(badges);card.append(picture);
  const body=el('div',null,'explore-coin-body');body.append(el('h3',name,'explore-coin-name'),el('p','$'+symbol,'explore-coin-symbol'));
  const cap=exploreNumber(coin.marketCapUsd),fdv=exploreNumber(coin.fdvUsd),value=el('div',null,'explore-coin-value');
  if(cap!==null||fdv!==null){const amount=el('span',exploreMoney(cap??fdv));amount.dataset.motionNumber='';value.append(amount,el('small',cap!==null?'MC':'FDV'));}
  else{value.append(el('span','—'),el('small','FDV · USD'));value.title='USD pricing is temporarily unavailable. This value updates automatically.';}
  if(coin.stale){const stale=el('small','Delayed');stale.title='Showing the last available market reading';value.append(stale);}
  const secondary=el('div',null,'explore-coin-secondary');
  const full=coin.volume24h!=null||coin.volume24hQuote!=null,usd=full?coin.volume24h:coin.volumeObserved,quoteVolume=full?coin.volume24hQuote:coin.volumeObservedQuote;
  const volume=usd!=null?(coin.volumeUsdEstimate?'≈':'')+exploreMoney(usd):quoteVolume!=null?Number(quoteVolume).toLocaleString(undefined,{maximumSignificantDigits:4})+' '+String(coin.quote?.symbol||''):'—';
  // The window suffix is its own node so phones can show the amount alone (the card text stays "… vol / 24h").
  const volumeLabel=el('span');volumeLabel.append(document.createTextNode(volume),el('small',full||usd==null&&quoteVolume==null?' vol / 24h':' observed vol'));
  volumeLabel.title=[coin.volumeSource,coin.volumeUsdEstimate?'USD estimate using the current quote-token price.':'',!full&&(usd!=null||quoteVolume!=null)?'Recent indexed trades; the full 24-hour window is unavailable.':''].filter(Boolean).join(' · ');
  const pair=isRobinhood(coin)?robinhoodPairLabel(document,coin.quote):createQuoteLabel(document,coin.quote,{size:18,className:'explore-coin-pair'});pair.setAttribute('aria-label','Paired with '+pair.textContent);const pairing=el('span',null,'explore-pair-venue'),amm=createLaunchAmmBadge(document,coin);pairing.append(pair);if(amm){pairing.append(amm);card.setAttribute('aria-label',`${name}, ${symbol}. ${amm.title}. View coin`);}secondary.append(pairing,volumeLabel);
  body.append(value,secondary);
  const progress=exploreNumber(coin.progressPercent);
  if(coin.stage!=='graduated'&&progress!==null){
    const row=el('div',null,'explore-progress-row'),bar=el('progress');bar.max=100;bar.value=Math.min(100,progress);bar.setAttribute('aria-label','Progress toward graduation');bar.setAttribute('aria-valuetext',`${Math.min(100,progress).toFixed(1)}% toward graduation${coin.stageStale?' (last reading)':''}`);
    // The native bar stays the accessible value; the fill overlay only adds the animated sheen.
    const track=el('span',null,'explore-progress-track'),fill=el('i',null,'explore-progress-fill');fill.setAttribute('aria-hidden','true');track.style?.setProperty?.('--progress',String(Math.min(100,progress)));track.append(bar,fill);if(progress>=75)row.classList.add('is-hot');
    row.append(track,el('span',`${Math.min(100,progress).toFixed(1)}%`));row.title=coin.stageStale?'Last observed graduation progress':'Progress toward graduation';body.append(row);
  }else body.append(el('p',coin.stage==='graduated'?'Trading in a liquidity pool':coin.curveStatus==='migrating'?'Graduation underway':'Reading the launch curve','explore-coin-status'));
  const foot=el('div',null,'explore-coin-footer');const mint=el('span',exploreShort(coin.mint));mint.title=coin.mint;const age=el('time',exploreAge(coin.createdAt,now),'explore-coin-age');
  if(exploreNumber(coin.createdAt)>0&&Number(coin.createdAt)<=8640000000000000){age.dataset.createdAt=String(coin.createdAt);age.dateTime=new Date(Number(coin.createdAt)).toISOString();age.title=new Date(Number(coin.createdAt)).toLocaleString();if(now-Number(coin.createdAt)<3600000)age.classList.add('is-recent');if(now-Number(coin.createdAt)<600000&&now>=Number(coin.createdAt))card.classList.add('is-fresh');}
  foot.append(mint,age);body.append(foot);card.append(body);return card;
}
