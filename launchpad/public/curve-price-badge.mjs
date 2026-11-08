// Uses the same cached, USD-normalized discovery record as the token page.
// No wallet connection, third-party price API or browser RPC is required.
import { PLATFORM_TOKEN_MINT } from './platform-token.mjs';
// The platform token (public/platform-token.mjs); without one the header shows no badge.
export const LAUNCHPAD_MINT=PLATFORM_TOKEN_MINT;
export const LAUNCHPAD_TOKEN_HREF='/coin?mint='+LAUNCHPAD_MINT;
const controllers=new WeakMap(),FRESH_MS=120000,POLL_MS=30000,RENEW_LEAD_MS=15000,MIN_GAP_MS=10000;
// Server-relative clock offset from the response Date header (one-second
// resolution). Without it a visitor clock a few seconds behind the server
// rejects every current price as "from the future" and shows a dash.
export function curvePriceClockOffset(response,receivedAt,previous=0){
  let header=null;try{header=response?.headers?.get?.('date');}catch{}
  const parsed=typeof header==='string'?Date.parse(header):NaN;
  if(!Number.isFinite(parsed)||!Number.isFinite(receivedAt))return previous;
  const offset=Math.round(parsed+500-receivedAt);
  return Math.abs(offset)>2000?offset:0;
}
const positiveUsd=value=>['number','string'].includes(typeof value)&&value!==''&&Number.isFinite(Number(value))&&Number(value)>0?Number(value):null;
// v71.26: the header badge shows the market cap (the fully diluted value when no circulating figure exists), with
// the price kept for the tooltip and as the fallback.
export function curvePriceSnapshot(data,now=Date.now()){
  const coin=data?.coin,price=positiveUsd(coin?.priceUsd),cap=positiveUsd(coin?.marketCapUsd),fdv=positiveUsd(coin?.fdvUsd),at=coin?.marketAt;
  if(coin?.mint!==LAUNCHPAD_MINT||coin.chain!=='solana'||coin.stale===true||data.stale===true)return null;
  if(price===null&&cap===null&&fdv===null)return null;
  if(!Number.isSafeInteger(at)||at<=0||at>now+5000||now-at>FRESH_MS)return null;
  return {price,cap:cap??fdv,capKind:cap!==null?'Market cap':fdv!==null?'Fully diluted value':null,at};
}
export function formatCurveCap(cap){
  if(!Number.isFinite(cap)||cap<=0)return '—';
  const digits=cap>=1e6?2:cap>=1e3?1:0;
  return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',notation:'compact',minimumFractionDigits:digits,maximumFractionDigits:digits}).format(cap);
}
export function formatCurvePrice(price){
  if(!Number.isFinite(price)||price<=0)return '—';
  // Significant digits retain tiny token prices; never round them to $0.00.
  return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumSignificantDigits:4,...(price<0.0000001||price>=1000000?{notation:'scientific'}:{})}).format(price);
}
export function mountCurvePriceBadge({document,window=document.defaultView,container,fetcher=window?.fetch?.bind(window),clock=Date.now,setTimer=(fn,ms)=>window.setTimeout(fn,ms),clearTimer=id=>window.clearTimeout(id)}={}){
  if(!container)return null;
  if(!LAUNCHPAD_MINT){container.querySelector('.curve-price-badge')?.remove();return null;}
  const previous=controllers.get(document);
  if(previous?.element.isConnected)return previous;
  previous?.destroy();
  if(!document.getElementById('curve-price-badge-styles')){
    const style=document.createElement('link');style.id='curve-price-badge-styles';style.rel='stylesheet';style.href='/curve-price-badge.css';document.head.append(style);
  }
  const link=container.querySelector('.curve-price-badge')||document.createElement('a');link.replaceChildren();link.className='curve-price-badge';link.href=LAUNCHPAD_TOKEN_HREF;
  const logo=document.createElement('img');logo.src='/brand-icon.svg?v=54';logo.alt='';logo.width=20;logo.height=20;
  const symbol=document.createElement('span');symbol.className='curve-price-symbol';symbol.textContent='$LAUNCHPAD';
  const price=document.createElement('span');price.className='curve-price-value';
  link.append(logo,symbol,price);
  const launch=container.querySelector('.top-launch');if(launch)launch.before(link);else container.prepend(link);
  let disposed=false,suspended=false,busy=false,timer=null,controller=null,snapshot=null,nextAt=0,failures=0,skew=0,startedAt=-Infinity;
  const serverNow=()=>clock()+skew;
  const current=()=>{const at=serverNow();return !!snapshot&&at-snapshot.at<=FRESH_MS&&snapshot.at<=at+5000;};
  function render(){
    const fresh=current(),showCap=fresh&&snapshot.cap!==null,label=showCap?snapshot.capKind:'Price';
    price.textContent=fresh?(showCap?formatCurveCap(snapshot.cap):formatCurvePrice(snapshot.price)):'—';
    link.dataset.priceState=fresh?'current':'unavailable';link.dataset.priceKind=showCap?(snapshot.capKind==='Market cap'?'cap':'fdv'):'price';
    const priceText=fresh&&snapshot.price!==null?' · price '+formatCurvePrice(snapshot.price):'';
    link.title=fresh?'$LAUNCHPAD · '+label.toLowerCase()+' '+price.textContent+priceText+' · updated '+new Date(snapshot.at).toLocaleTimeString():'$LAUNCHPAD · market data temporarily unavailable';
    link.setAttribute('aria-label',fresh?'Open official $LAUNCHPAD token page. '+label+' '+price.textContent+' USD.':'Open official $LAUNCHPAD token page. USD market data unavailable.');
  }
  // A cached discovery price can be most of its two-minute life old when it
  // arrives. Renew it shortly before it expires (at most every ten seconds)
  // instead of letting it lapse to a dash until the next 30-second poll.
  // After a failed request the error backoff applies instead, so a retained
  // price can never turn an outage into ten-second polling.
  function dueAt(){
    if(!snapshot||failures)return nextAt;
    return Math.min(nextAt,Math.max(snapshot.at+FRESH_MS-RENEW_LEAD_MS-skew,startedAt+MIN_GAP_MS));
  }
  function schedule(){
    clearTimer(timer);timer=null;
    if(disposed||suspended||document.hidden||typeof fetcher!=='function')return;
    const expiry=snapshot?snapshot.at+FRESH_MS+1-skew:Infinity;
    const delay=Math.max(100,Math.min(dueAt(),expiry>clock()?expiry:Infinity)-clock());
    timer=setTimer(()=>{timer=null;void refresh();},delay);timer?.unref?.();
  }
  async function refresh(){
    render();
    if(disposed||suspended||document.hidden||busy||typeof fetcher!=='function')return;
    if(clock()<dueAt()){schedule();return;}
    busy=true;startedAt=clock();nextAt=clock()+POLL_MS;controller=new AbortController();
    const request=controller,timeout=setTimer(()=>request.abort(),12000);timeout?.unref?.();
    // Settle on timeout/abort even if a fetch implementation ignores the signal.
    const expired=new Promise((_,reject)=>request.signal.addEventListener('abort',()=>reject(Error('Price request expired')),{once:true}));expired.catch(()=>{});
    try{
      const response=await Promise.race([fetcher('/api/explore/token?mint='+LAUNCHPAD_MINT,{method:'GET',credentials:'same-origin',cache:'no-store',signal:request.signal}),expired]);
      const receivedAt=clock();
      if(!response.ok)throw Error('Price temporarily unavailable');
      const data=await Promise.race([response.json(),expired]);if(disposed||suspended||request.signal.aborted)return;
      skew=curvePriceClockOffset(response,receivedAt,skew);
      snapshot=curvePriceSnapshot(data,serverNow());failures=0;
      nextAt=clock()+(data?.refreshing&&!snapshot?10000:POLL_MS);
    }catch{
      if(disposed||suspended)return;
      // A failed request does not erase a price that is still inside its
      // two-minute freshness window; render() drops it once that window ends.
      failures++;nextAt=clock()+Math.min(120000,POLL_MS*2**Math.min(failures,2));
    }finally{clearTimer(timeout);busy=false;if(controller===request)controller=null;if(!disposed){render();schedule();}}
  }
  function visibility(){if(document.hidden){clearTimer(timer);timer=null;}else void refresh();}
  function hide(){suspended=true;clearTimer(timer);timer=null;controller?.abort();}
  // A bfcache restore refreshes promptly; the aborted request does not hold
  // the badge until the next 30-second interval.
  function show(){if(suspended)nextAt=Math.min(nextAt,startedAt+MIN_GAP_MS);suspended=false;void refresh();}
  function destroy(){if(disposed)return;disposed=true;clearTimer(timer);controller?.abort();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',hide);window.removeEventListener('pageshow',show);link.remove();if(controllers.get(document)===api)controllers.delete(document);}
  const api={element:link,refresh,destroy};controllers.set(document,api);
  document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',hide);window.addEventListener('pageshow',show);
  render();void refresh();return api;
}
