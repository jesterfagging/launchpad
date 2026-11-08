const states={legacy:'Previous branding',queued:'Update queued',pending:'Awaiting confirmation',updated:'Launchpad branding confirmed'};
const publicUrl=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}};
// The website named in the attribution (LAUNCHPAD_PUBLIC_URL on the server), for the publish reminders.
const siteName=brand=>{const href=publicUrl(brand?.web);return href?new URL(href).host:'the website';};

export function createAdminBranding({document,api,security,message,getAccount}){
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!==null&&text!==undefined)node.textContent=String(text);if(cls)node.className=cls;return node;};
  const element=el('section',null,'admin-card admin-branding');element.id='admin-branding';
  const heading=el('div',null,'admin-card-heading'),copy=el('div'),refresh=el('button','Refresh','text-button');refresh.type='button';copy.append(el('p','LAUNCHPAD / IDENTITY','eyebrow'),el('h2','Onchain platform branding'),el('p','Update the platform attribution shown for existing launches. Coin names, tickers, images, fees and liquidity stay unchanged.'));heading.append(copy,refresh);
  const target=el('div',null,'admin-branding-target'),status=el('p','','admin-muted');status.setAttribute('role','status');
  const searchLabel=el('label','Find a coin','admin-search'),search=el('input');search.type='search';search.maxLength=100;search.placeholder='Search name, ticker or mint';searchLabel.append(search);
  const list=el('div',null,'admin-protocol-coins'),pages=el('div',null,'admin-pagination');element.append(heading,target,status,searchLabel,list,pages);
  let data=null,coins=[],page=0,revision=0,loading=false,busy=false;const requests=new Map();
  const permitted=()=>getAccount()?.role==='admin'&&getAccount()?.mfaEnabled;
  function clear(){revision++;data=null;coins=[];requests.clear();target.replaceChildren();list.replaceChildren();pages.replaceChildren();status.textContent='';element.hidden=true;}
  function link(label,url){const href=publicUrl(url);if(!href)return el('span',label);const node=el('a',label,'text-button');node.href=href;node.target='_blank';node.rel='noopener noreferrer';return node;}
  function renderTarget(){
    target.replaceChildren();const brand=data.brand||{},identity=el('div');identity.append(el('strong',brand.name||'Launchpad'),el('p',brand.web||'No public address is set (LAUNCHPAD_PUBLIC_URL).','help'));const links=el('div',null,'admin-inline-actions');links.append(link('Open website ↗',brand.web),link('Check public logo ↗',brand.img));target.append(identity,links);
    if(data.requiresPublishedLogo&&publicUrl(brand.web)&&brand.img===new URL('/brand-avatar.png',brand.web).href){const preview=el('a','Preview installed logo ↗','text-button');preview.href='/brand-avatar.png';preview.target='_blank';preview.rel='noopener noreferrer';links.append(preview);}
    target.append(el('p',data.requiresPublishedLogo?'Publish '+siteName(brand)+' and verify that the public logo URL opens before updating existing launches. The installed preview only checks this app; running it on localhost does not publish the logo. If the public link does not respond, check the domain and HTTPS hosting before confirming.':'The platform logo is available from permanent storage. Existing launches are updated only when you approve them.','help'));
  }
  function row(coin){
    const item=el('details',null,'admin-protocol-coin admin-branding-coin'),summary=el('summary');summary.append(el('strong',`${coin.name||'Unnamed coin'} · ${coin.symbol||'—'}`),el('span',states[coin.status]||'Status unavailable'));item.append(summary,el('p',coin.mint||'Mint unavailable','account-address'));
    item.append(el('p','Current attribution: '+(coin.currentBrand?.name||'Not recorded')+(coin.currentBrand?.web?' · '+coin.currentBrand.web:''),'help'));
    if(coin.error)item.append(el('p',coin.error,'negative help'));
    if(typeof coin.signature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(coin.signature))item.append(link('View branding transaction ↗','https://solscan.io/tx/'+coin.signature));
    const form=el('form'),label=el('label','Reason for update'),reason=el('input');reason.required=true;reason.minLength=5;reason.maxLength=500;reason.placeholder='Record why platform branding is changing';label.append(reason);form.append(label);
    let published;
    if(data.requiresPublishedLogo){const confirm=el('label',null,'check');published=el('input');published.type='checkbox';published.required=true;confirm.append(published,el('span','I have published '+siteName(data.brand)+' and verified that the platform logo URL opens.'));form.append(confirm);}
    const allowed=coin.eligibility?.allowed===true&&!['queued','pending','updated'].includes(coin.status),run=el('button','Update to Launchpad','small-button');run.type='submit';run.disabled=!allowed;form.append(el('p',allowed?'Updates platform attribution onchain. Confirmation can take time.':coin.eligibility?.reason||(['queued','pending'].includes(coin.status)?'An update is already awaiting confirmation.':coin.status==='updated'?'This launch already uses Launchpad branding.':'This launch cannot be updated here.'),'help'),run);
    form.onsubmit=async event=>{
      event.preventDefault();if(busy||loading||!allowed||!permitted())return;
      const explanation=reason.value.trim();if(explanation.length<5){message('Enter a reason of at least five characters.',true);return;}if(published&&!published.checked){message('Publish the website and verify its logo before confirming this update.',true);return;}
      busy=true;run.disabled=true;refresh.disabled=true;const generation=revision,key=String(coin.accountId)+':'+String(coin.id),requiresPublishedLogo=data.requiresPublishedLogo===true;
      try{
        const credentials=await security.authorize(`Update ${coin.symbol||'coin'} platform branding`,{requireCode:true});if(!permitted()||generation!==revision)return;
        let requestId=requests.get(key);if(!requestId){requestId=globalThis.crypto.randomUUID();requests.set(key,requestId);}
        const result=await api('/api/admin/branding/update',{accountId:coin.accountId,id:coin.id,requestId,reason:explanation,...(requiresPublishedLogo?{confirmPublishedLogo:true}:{}),...credentials});
        if(!permitted()||generation!==revision)return;
        if(result.coin?.id===coin.id&&result.coin?.accountId===coin.accountId){coins=coins.map(value=>value.id===coin.id&&value.accountId===coin.accountId?result.coin:value);requests.delete(key);renderCoins();}
        message(result.alreadyRequested?'This update was already accepted. Refresh to check its confirmation.':'Platform branding update queued. Wait for onchain confirmation.');
      }catch(error){if(generation===revision&&error.message!=='Cancelled.')message(error.message,true);}
      finally{busy=false;run.disabled=!allowed;refresh.disabled=false;}
    };item.append(form);return item;
  }
  function renderCoins(){
    const query=search.value.trim().toLowerCase(),matches=coins.filter(coin=>[coin.name,coin.symbol,coin.mint].some(value=>String(value||'').toLowerCase().includes(query)));page=Math.min(page,Math.max(0,Math.ceil(matches.length/10)-1));list.replaceChildren(...(matches.length?matches.slice(page*10,page*10+10).map(row):[el('p','No matching launch records.','admin-muted')]));pages.replaceChildren();
    if(matches.length>10){const prev=el('button','Previous','small-button'),next=el('button','Next','small-button');prev.type=next.type='button';prev.disabled=page===0;next.disabled=(page+1)*10>=matches.length;prev.onclick=()=>{page--;renderCoins();};next.onclick=()=>{page++;renderCoins();};pages.append(prev,el('span',`${page+1} / ${Math.ceil(matches.length/10)}`),next);}
  }
  async function load(){
    if(!permitted()){clear();return;}if(loading||busy)return;loading=true;refresh.disabled=true;const generation=++revision;element.hidden=false;status.textContent='Checking platform branding…';
    try{const result=await api('/api/admin/branding');if(!permitted()||generation!==revision)return;data=result;coins=Array.isArray(result.coins)?result.coins:[];renderTarget();renderCoins();status.textContent=`${coins.filter(coin=>coin.status==='updated').length} of ${coins.length} launches have confirmed Launchpad branding.`;}
    catch(error){if(generation===revision){status.textContent='Platform branding could not be refreshed. Use Refresh to try again.';message(error.message,true);}}
    finally{loading=false;refresh.disabled=false;}
  }
  refresh.onclick=load;search.oninput=()=>{page=0;renderCoins();};clear();return {element,load,clear};
}
