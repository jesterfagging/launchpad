// Transfer hook rules (v71.28): the shared "Rules" card, the creator's allowlist manager and the read-only blocklist
// viewer, used by the coin page and My Tokens. Everything renders from a coin row's `hook` field
// ({ rules: [{ id, name, text }], route: 'any' | 'curve' | 'app', app?, appName?, gateMint, titheRecipient, blocklistCount?,
// active, ended, allowlist? }) and degrades to nothing when it is missing. An 'app' route (v71.35: FOMO-only, Pump App-only)
// means Launchpad's Buy and Sell are off for the coin until graduation; hookAppName / hookCurveTrading say so for the trade box. The creator's allowlist changes go through the Meteora
// prepare/submit flow (createMeteoraOperation) as `hook-allow`: the server returns an unsigned transaction that the
// creator signs in their wallet; nothing here signs or holds authority. A hooked coin's supply is fixed at creation like
// every Launchpad coin, so the card has no supply action.
import {hookRuleById,describeHookRule,HOOK_LIMITS,HOOK_ROUTES,hookAppTradeNote} from './hook-catalog.mjs';
import {createMeteoraOperation} from './meteora-ui.mjs';
import {getLaunchpadWallet} from './launchpad-wallet.mjs';

export const HOOK_ADDRESS=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const TERMINAL=new Set(['finalized','failed','expired','cancelled']);
export const HOOK_STYLES_HREF='/hook-ui.css?v=71.35';
const short=value=>typeof value==='string'&&value.length>16?value.slice(0,6)+'…'+value.slice(-6):String(value||'');
const timeText=at=>{const n=Number(at);if(!Number.isFinite(n)||n<=0)return '';try{return new Date(n).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});}catch{return '';}};
/** A wallet address must decode to exactly 32 bytes; length and alphabet alone also accept a pasted address cut short. */
export function validHookWallet(value){
  if(typeof value!=='string'||!HOOK_ADDRESS.test(value))return false;
  const bytes=[];for(const char of value){let carry=BASE58.indexOf(char);for(let i=0;i<bytes.length;i++){carry+=bytes[i]*58;bytes[i]=carry&255;carry>>=8;}while(carry>0){bytes.push(carry&255);carry>>=8;}}
  for(let i=0;i<value.length&&value[i]==='1';i++)bytes.push(0);
  return bytes.length===32;
}
/** The rules of a coin row as [{ id, name, text, route }], from the row's own words with the catalogue filling gaps. Unknown rows are dropped. */
export function hookRules(hook){
  const list=Array.isArray(hook?.rules)?hook.rules:[],out=[];
  for(const row of list){
    const id=typeof row==='string'?row:row?.id,item=hookRuleById(id);
    if(typeof id!=='string'||!item&&!row?.name)continue;
    let text=typeof row?.text==='string'?row.text:'';
    if(!text&&item)try{text=describeHookRule(id,row?.settings||{});}catch{text=item.summary;}
    const route=row?.route==='curve'||row?.route==='app'?row.route:item?.route==='curve'||item?.route==='app'?item.route:'any';
    out.push({id,name:typeof row?.name==='string'&&row.name?row.name:item?.name||id,text,route,...(route==='app'?{appName:typeof row?.appName==='string'&&row.appName?row.appName:item?.appName||''}:{})});
  }
  return out;
}
export const hookRuleNames=hook=>hookRules(hook).map(rule=>rule.name);
export const hasHook=coin=>hookRules(coin?.hook).length>0;
/** The coin's route: the row's word, else 'app' when a rule is an app-only rule, else 'curve' when any rule is a Launchpad-route rule in the catalogue. */
export function hookRoute(hook){
  if(hook?.route==='curve'||hook?.route==='any'||hook?.route==='app')return hook.route;
  const rules=hookRules(hook);return rules.some(rule=>rule.route==='app')?'app':rules.some(rule=>rule.route==='curve')?'curve':'any';
}
/** The app an app-only coin trades in ('FOMO', 'Pump App'), from the row or the catalogue; '' for every other coin. */
export function hookAppName(hook){
  if(hookRoute(hook)!=='app')return '';
  if(typeof hook?.appName==='string'&&hook.appName)return hook.appName;
  const rule=hookRules(hook).find(rule=>rule.route==='app');return rule?.appName||hookRuleById(rule?.id)?.appName||'the app';
}
/** Whether Launchpad's own Buy and Sell work for the coin now: false for an app-only coin still on the curve (the row's `curveTrading` wins when it says so). */
export function hookCurveTrading(coin){
  const hook=coin?.hook;if(!hook)return true;
  if(typeof hook.curveTrading==='boolean')return hook.curveTrading||hookEnded(coin);
  return hookRoute(hook)!=='app'||hookEnded(coin);
}
/** The sentence the trade box shows instead of Buy and Sell on an app-only coin still on the curve ('' otherwise). */
export function hookTradeLockText(coin){
  if(hookCurveTrading(coin))return '';
  return typeof coin?.hook?.tradeNote==='string'&&coin.hook.tradeNote?coin.hook.tradeNote:hookAppTradeNote(hookAppName(coin?.hook));
}
/** Rules run while the coin is on the curve; Meteora removes the hook at graduation. The row's own flags win over the stage. */
export function hookEnded(coin){const hook=coin?.hook;if(!hook)return false;if(hook.ended===true||hook.graduatedRulesEnded===true)return true;if(hook.active===true)return false;return coin?.stage==='graduated'||coin?.curveStatus==='migrated';}
export function hookStateText(coin){return hookEnded(coin)?'Ended at graduation':'Active on the curve';}
/** One sentence on where the coin trades, for its route and whether the rules still run. */
export function hookRouteText(route,ended=false,appName=''){
  if(route==='app'){const name=appName||'the app';return ended?'Traded only in '+name+' while it was on the curve; now it trades anywhere, Launchpad included.':'Trades only in '+name+' until graduation: its rule allows pool trades only when '+name+'’s program is in the transaction, so Launchpad’s Buy and Sell (and every other router) are off for it while it is on the curve.';}
  if(route!=='curve')return 'Trades anywhere: '+HOOK_ROUTES.any.text;
  return ended?'Traded on Launchpad only while it was on the curve; now it trades anywhere.':'Trades on Launchpad only until graduation: its rules need accounts or a payment that only Launchpad adds to a trade, so other routers cannot trade it while it is on the curve.';
}
export function hookRulesTitle(hook){return hookRuleNames(hook).join(' · ');}
/** How many wallets the blocklist holds, from the row ({ blocklistCount } or { blocklist: [...] | { count } }); null when it does not say. */
export function hookBlocklistCount(hook){
  if(!hook||typeof hook!=='object')return null;
  for(const value of [hook.blocklistCount,hook.blocklist?.count,Array.isArray(hook.blocklist)?hook.blocklist.length:undefined]){const n=Number(value);if(value!==undefined&&value!==null&&Number.isInteger(n)&&n>=0)return n;}
  return null;
}
/** The small "Hooked" chip for coin grids and cards: the rule names travel in its title and accessible name, a Launchpad-route coin carries the small route marker. */
export function createHookChip(document,hook,{className='hook-chip',text='Hooked'}={}){
  const names=hookRuleNames(hook);if(!names.length)return null;
  const route=hookRoute(hook),appName=hookAppName(hook),chip=document.createElement('span');chip.className=className;chip.textContent=text;chip.dataset.route=route;chip.dataset.hookRules=String(names.length);
  const routeNote=route==='curve'?HOOK_ROUTES.curve.name:route==='app'?appName+' only':'';
  chip.setAttribute('title','Transfer hook rules: '+names.join(' · ')+(routeNote?' · '+routeNote:''));chip.setAttribute('aria-label','Transfer hook rules: '+names.join(', ')+(routeNote?'. '+routeNote:''));
  if(route==='curve'||route==='app'){const marker=document.createElement('span');marker.className='hook-chip-route';marker.textContent=route==='curve'?'Launchpad route':appName+' only';marker.setAttribute('aria-hidden','true');chip.append(document.createTextNode(' '),marker);}
  return chip;
}
export function ensureHookStyles(document){
  if(!document?.head)return;
  // The creator actions' operation panels (facts, status, approval) are styled by meteora-account.css, which the Meteora
  // trade panel and My Tokens load too; the same spelling keeps it one file for the asset pipeline.
  for(const [id,href] of [['hook-ui-styles',HOOK_STYLES_HREF],['meteora-account-styles','/meteora-account.css?v=64']]){if(document.getElementById(id))continue;const link=document.createElement('link');link.id=id;link.rel='stylesheet';link.href=href;document.head.append(link);}
}
/** Lines of a textarea as wallets: deduplicated, with the lines that are not wallet addresses listed separately. */
export function parseHookWallets(text){
  const wallets=[],invalid=[],seen=new Set();
  for(const raw of String(text??'').split(/[\s,;]+/)){const line=raw.trim();if(!line)continue;if(!validHookWallet(line)){invalid.push(line);continue;}if(!seen.has(line)){seen.add(line);wallets.push(line);}}
  return {wallets,invalid};
}
/** The wallets of an allowlist or blocklist read (`{ wallets }` from the server; `{ allowlist }`, `{ blocklist }` and a bare array are accepted too). */
export function hookAllowlistWallets(data){
  const rows=Array.isArray(data?.wallets)?data.wallets:Array.isArray(data?.allowlist)?data.allowlist:Array.isArray(data?.blocklist)?data.blocklist:Array.isArray(data)?data:[];
  return [...new Set(rows.filter(address=>HOOK_ADDRESS.test(String(address||''))))];
}
export const hookBlocklistWallets=hookAllowlistWallets;
/** Where a list read came from: the chain, or Launchpad's record when the chain could not be read. */
export function hookAllowlistSourceText(data){
  const source=data?.source==='chain'?'Read from chain':data?.source==='curve'?'Recorded by Launchpad (chain read unavailable)':'';if(!source)return '';
  const at=typeof data.recorded==='number'?data.recorded:typeof data.updatedAt==='number'?data.updatedAt:typeof data.at==='number'?data.at:null,time=at===null?'':timeText(at);
  return source+(time?' · '+time:'');
}
/** A prepared creator operation of the given action: the saved unsigned transaction for this creator and mint. Quote fields are not part of these actions. */
export function validHookOperation(value,{action,wallet,mint,now=Date.now()}={}){
  return !!value&&/^[a-zA-Z0-9_-]{8,128}$/.test(value.id||'')&&(action?value.action===action:value.action==='hook-allow')&&HOOK_ADDRESS.test(value.wallet||'')&&(!wallet||value.wallet===wallet)&&HOOK_ADDRESS.test(value.mint||'')&&(!mint||value.mint===mint)&&value.state==='awaiting_signature'&&typeof value.transaction==='string'&&value.transaction.length>0&&value.transaction.length<=24000&&/^[A-Za-z0-9+/]+={0,2}$/.test(value.transaction)&&Number.isFinite(Number(value.expiresAt))&&Number(value.expiresAt)>now;
}
export const validHookAllowOperation=(value,options={})=>validHookOperation(value,{...options,action:'hook-allow'});
const sessionIdentity=session=>session?.authenticated?String(session.account?.id||session.account?.mainWallet||session.account?.username||''):'';
/** Whether the signed-in account is the coin's creator, as far as a public row can say (the server decides for real). */
export function hookOwner(coin,session){
  if(!sessionIdentity(session))return false;const account=session.account||{};
  if(coin?.creatorAccountId&&account.id&&coin.creatorAccountId===account.id)return true;
  if(coin?.creatorId&&account.id&&coin.creatorId===account.id)return true;
  if(coin?.creator?.id&&account.id&&coin.creator.id===account.id)return true;
  const name=String(coin?.creator?.username||'').toLowerCase();return !!name&&name===String(account.username||'').toLowerCase();
}

/**
 * One creator action through the Meteora operation flow: the browser wallet (created lazily, chosen from a list when
 * none is connected), a saved transaction recovered before a new one is prepared, and the operation panel (review,
 * status, approval). The allowlist manager is its only user today; the shape stays open for further creator actions.
 */
function createHookAction({document,window,root,request,walletFactory,clock,setTimer,clearTimer,action,transactionKindPrefix,onChange,onConfirmed,onFinalized,mintOf,contextOf=()=>({}),identity,message}){
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
  const choices=el('div',null,'hook-allowlist-wallets'),operationRoot=el('div',null,'hook-allowlist-operation');choices.hidden=true;root.append(choices,operationRoot);
  let wallet=null,unsubscribe=null,connecting=false,disposed=false,generation=0;
  const address=()=>wallet?.state().address||'';
  const binding=()=>[identity(),mintOf(),address()].join(':');
  const ensureWallet=()=>{if(!wallet){wallet=walletFactory({window});unsubscribe=wallet.onChange?.(()=>{if(disposed)return;generation++;operation.reset();choices.hidden=true;onChange();if(address())void recover();});}return wallet;};
  const walletProxy={state:()=>wallet?.state()||{address:null,wallets:[]},sign:input=>ensureWallet().sign(input)};
  const operation=createMeteoraOperation({document,root:operationRoot,request,wallet:walletProxy,clock,setTimer,clearTimer,additionalActions:[action],...(transactionKindPrefix?{transactionKindPrefix}:{}),validateOperation:(value,options={})=>validHookOperation(value,{action,wallet:options.wallet,mint:options.mint||mintOf(),now:options.now}),context:()=>({active:!disposed&&!!mintOf()&&!!identity(),key:binding(),mint:mintOf(),...contextOf()}),onChange,onConfirmed,onFinalized});
  /** A saved transaction of this action for this wallet and coin (for example after a reload) is picked up before a new one is prepared. */
  async function recover(){
    if(disposed||!mintOf()||!identity()||!address()||operation.operation)return;
    try{const saved=await request('/operations');if(disposed)return;const open=(saved?.operations||[]).find(row=>row.action===action&&row.mint===mintOf()&&row.wallet===address()&&!TERMINAL.has(row.state));if(open&&operation.restore(open))await operation.reconcile();}
    catch(error){if(!disposed&&!error?.cancelled)message(error.message,true);}
  }
  function chooseWallet(){
    choices.replaceChildren();choices.hidden=false;const state=ensureWallet().state();
    choices.append(el('p','Connect the wallet that created this coin.','help'));
    for(const option of state.wallets||[]){const button=el('button',option.name,'small-button');button.type='button';button.disabled=connecting;button.onclick=async()=>{if(disposed||connecting)return;connecting=true;onChange();try{await wallet.connect(option.id);if(disposed)return;choices.hidden=true;message('');}catch(error){if(!disposed)message(error.message||'Wallet connection was cancelled.',true);}finally{connecting=false;onChange();}};choices.append(button);}
    if(!(state.wallets||[]).length)choices.append(el('p','Open Launchpad in your Solana wallet browser or use a wallet extension.','help'));
  }
  /** Prepares the unsigned transaction; `input` holds the action's own fields. Returns the prepare result, or null. */
  async function prepare(input,{review=''}={}){
    ensureWallet();if(!address()){chooseWallet();return null;}
    const version=generation;
    await recover();if(disposed||version!==generation)return null;
    if(operation.operation&&!TERMINAL.has(operation.operation.state)){message(operation.operation.state==='awaiting_signature'?'A prepared transaction is waiting for your approval below.':'A saved transaction is still confirming. Check it before preparing another.',true);return null;}
    const result=await operation.prepare({action,mint:mintOf(),...input});if(disposed||version!==generation)return null;
    if(result?.operation&&review)message(review);return result;
  }
  return {operation,prepare,recover,ensureWallet,address,get connecting(){return connecting;},get locked(){return operation.busy||operation.pending||connecting;},reset(){generation++;operation.reset();choices.hidden=true;},canLeave:()=>!connecting&&operation.canLeave(),destroy(){if(disposed)return;disposed=true;generation++;unsubscribe?.();operation.destroy();}};
}

/**
 * The creator's allowlist manager: the wallets currently allowed (read from the server, with where the read came
 * from), a textarea for new ones and remove buttons, then one `hook-allow` transaction prepared through the Meteora
 * operation flow. "Prepare transaction" only prepares: the review (wallets added and removed, the SOL the creator
 * pays) and the approval button come from the operation panel, and the wallet opens when the creator approves there.
 * `request(path, body)` is relative to /api/launchpad/meteora and carries the session.
 */
export function createHookAllowlistManager({document,window=document.defaultView,root,request,walletFactory=getLaunchpadWallet,clock=Date.now,setTimer=setInterval,clearTimer=clearInterval,onChange=()=>{}}={}){
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
  root.classList.add('hook-allowlist');
  const head=el('div',null,'hook-allowlist-head'),title=el('h3','Allowlist','hook-allowlist-title'),count=el('span','','cv-pill hook-allowlist-count'),intro=el('p','Only wallets on this list can receive the coin. The pool and your creator wallet are always allowed. Changes are one transaction you sign in your wallet, up to '+HOOK_LIMITS.allowlistBatch+' wallets at a time.','help hook-allowlist-intro');
  head.append(title,count);count.hidden=true;
  const status=el('p','','help hook-allowlist-status'),list=el('ul',null,'hook-allowlist-current'),source=el('p','','hook-allowlist-source');status.setAttribute('role','status');status.setAttribute('aria-live','polite');list.setAttribute('aria-label','Wallets on the allowlist');source.hidden=true;
  const label=el('label',null,'hook-allowlist-add'),labelText=el('span','Add wallets','hook-allowlist-label'),textarea=el('textarea');textarea.rows=3;textarea.placeholder='One wallet address per line (up to '+HOOK_LIMITS.allowlistBatch+')';textarea.setAttribute('autocapitalize','off');textarea.spellcheck=false;textarea.setAttribute('aria-label','Wallets to add, one per line');label.append(labelText,textarea);
  const summary=el('p','','hook-allowlist-summary'),actions=el('div',null,'hook-allowlist-actions'),prepare=el('button','Prepare transaction','primary hook-allowlist-prepare'),refresh=el('button','Refresh list','text-button hook-allowlist-refresh');
  prepare.type='button';refresh.type='button';summary.setAttribute('aria-live','polite');actions.append(prepare,refresh);
  root.replaceChildren(head,intro,status,list,source,label,summary,actions);
  let session=null,mint='',wallets=[],loaded=false,loading=false,removed=new Set(),disposed=false,busy=false,generation=0,negative=false,listKey='',sourceText='';
  const identity=()=>sessionIdentity(session);
  function message(text='',error=false){negative=error;status.textContent=text;status.classList.toggle('negative',error);status.setAttribute('role',error?'alert':'status');}
  const action=createHookAction({document,window,root,request,walletFactory,clock,setTimer,clearTimer,action:'hook-allow',transactionKindPrefix:'curve-hook-',mintOf:()=>mint,identity,message,onChange:()=>{render();onChange();},onConfirmed:()=>changed(),onFinalized:()=>changed()});
  function changed(){textarea.value='';removed=new Set();void load(true);}
  function pending(){const {wallets:add,invalid}=parseHookWallets(textarea.value);const current=new Set(wallets);return {add:add.filter(address=>!current.has(address)),invalid,remove:[...removed].filter(address=>current.has(address))};}
  const locked=()=>busy||action.locked;
  function renderList(){
    // The list is rebuilt only when the wallets, the marked removals or the lock state change, so a hovered or focused
    // Remove button survives the market refresh that re-renders the card.
    const key=JSON.stringify([wallets,[...removed],loaded,loading,locked()]);if(key===listKey)return;listKey=key;
    list.replaceChildren();
    if(!wallets.length)list.append(el('li',loaded?'No wallets are on the allowlist yet. Only the pool and the creator can receive the coin until you add some.':loading?'Reading the allowlist…':'The allowlist has not been read yet.','hook-allowlist-empty'));
    for(const address of wallets){
      const item=el('li',null,'hook-allowlist-item'+(removed.has(address)?' is-removed':'')),code=el('code',short(address));code.setAttribute('title',address);item.dataset.wallet=address;
      const button=el('button',removed.has(address)?'Undo':'Remove','text-button hook-allowlist-remove');button.type='button';button.disabled=locked();button.setAttribute('aria-label',(removed.has(address)?'Keep ':'Remove ')+address);button.onclick=()=>{if(locked())return;if(removed.has(address))removed.delete(address);else removed.add(address);if(negative)message('');render();};
      item.append(code,button);list.append(item);
    }
  }
  function render(){
    if(disposed)return;const signedIn=!!identity(),address=action.address(),{add,invalid,remove}=pending();
    renderList();
    count.textContent=loaded?wallets.length.toLocaleString()+(wallets.length===1?' wallet':' wallets'):'';count.hidden=!loaded;
    source.textContent=loaded?sourceText:'';source.hidden=!(loaded&&sourceText);
    const parts=[];if(add.length)parts.push(add.length+' to add');if(remove.length)parts.push(remove.length+' to remove');if(invalid.length)parts.push(invalid.length+(invalid.length===1?' line is not a wallet address':' lines are not wallet addresses'));
    summary.textContent=parts.join(' · ');summary.hidden=!parts.length;summary.classList.toggle('negative',invalid.length>0);
    const changes=add.length+remove.length,held=locked();
    prepare.textContent=!signedIn?'Sign in to manage':!address?'Connect wallet':action.operation.pending?'Transaction prepared':busy?'Preparing…':'Prepare transaction';
    prepare.disabled=held||!signedIn||(!!address&&(changes===0||invalid.length>0||changes>HOOK_LIMITS.allowlistBatch));
    textarea.disabled=held;refresh.disabled=loading||held;root.setAttribute('aria-busy',String(loading||busy));
  }
  async function load(force=false){
    if(disposed||!mint||!identity()||loading&&!force)return;const version=generation,key=[identity(),mint].join(':');loading=true;render();
    try{const data=await request('/hook-allowlist?mint='+encodeURIComponent(mint));if(disposed||version!==generation||key!==[identity(),mint].join(':'))return;wallets=hookAllowlistWallets(data);sourceText=hookAllowlistSourceText(data);loaded=true;if(!negative)message('');}
    catch(error){if(!disposed&&version===generation&&!error?.cancelled)message(error.message||'The allowlist could not be read.',true);}
    finally{if(version===generation){loading=false;render();if(action.address())void action.recover();}}
  }
  /** Prepares one unsigned transaction with the pending additions and removals; the operation panel then shows the review and the approval. */
  async function prepareChange(){
    if(disposed||busy||action.locked||!mint)return;
    if(!identity()){message('Sign in with the creator account to change the allowlist.',true);return;}
    const {add,invalid,remove}=pending();
    if(action.address()){
      if(invalid.length){message('Check these lines, they are not wallet addresses: '+invalid.map(short).join(', '),true);render();return;}
      if(!add.length&&!remove.length){message('Add or remove at least one wallet first.',true);render();return;}
      if(add.length+remove.length>HOOK_LIMITS.allowlistBatch){message('Up to '+HOOK_LIMITS.allowlistBatch+' wallet changes fit in one transaction. Prepare the rest afterwards.',true);render();return;}
    }
    const version=generation;busy=true;message('');render();
    try{await action.prepare({add,remove},{review:'Review the change below, then approve it in your wallet.'});}
    catch(error){if(!disposed&&version===generation&&!error?.cancelled)message(error.message||'The allowlist change could not be prepared.',true);}
    finally{if(version===generation){busy=false;render();}}
  }
  prepare.onclick=()=>void prepareChange();refresh.onclick=()=>void load(true);textarea.oninput=()=>{if(negative)message('');render();};
  const timer=setTimer(()=>{if(!disposed&&!document.hidden)void action.operation.poll();},5000);
  render();
  return {
    setCoin(nextMint,{allowlist}={}){const next=HOOK_ADDRESS.test(String(nextMint||''))?nextMint:'';if(next!==mint){generation++;mint=next;wallets=[];loaded=false;loading=false;removed=new Set();textarea.value='';sourceText='';action.reset();message('');}if(Array.isArray(allowlist)&&!loaded){wallets=hookAllowlistWallets(allowlist);}render();},
    setSession(next){const previous=identity()+':'+(session?.token||'');session=next;if(previous!==identity()+':'+(session?.token||'')){generation++;action.reset();removed=new Set();loaded=false;wallets=[];sourceText='';message('');}if(identity())try{action.ensureWallet();}catch{}render();},
    load:()=>load(false),prepare:prepareChange,render,get busy(){return busy||action.locked;},get wallets(){return wallets.slice();},get operation(){return action.operation;},canLeave:()=>!busy&&action.canLeave(),
    destroy(){if(disposed)return;disposed=true;generation++;clearTimer(timer);action.destroy();root.replaceChildren();},
  };
}

/**
 * The read-only blocklist viewer: the wallets that can never receive the coin, read once per coin from
 * GET /hook-blocklist?mint= ({ wallets, count }), with the first few shown and the rest behind "Show all". The list is
 * written at launch and sealed by the first trade, so there is nothing to change here, for anyone.
 */
export function createHookBlocklistViewer({document,root,request,preview=8}={}){
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
  root.classList.add('hook-blocklist');
  const head=el('div',null,'hook-allowlist-head hook-blocklist-head'),title=el('h3','Blocklist','hook-allowlist-title'),count=el('span','','cv-pill hook-allowlist-count hook-blocklist-count'),intro=el('p','Wallets on this list can never receive the coin. The list was written on chain at launch and sealed by the first trade: nobody can add or remove a wallet.','help hook-allowlist-intro');
  head.append(title,count);count.hidden=true;
  const status=el('p','','help hook-allowlist-status hook-blocklist-status'),list=el('ul',null,'hook-allowlist-current hook-blocklist-current'),source=el('p','','hook-allowlist-source'),actions=el('div',null,'hook-allowlist-actions hook-blocklist-actions'),toggle=el('button','Show all','text-button hook-blocklist-toggle'),retry=el('button','Try again','text-button hook-blocklist-retry');
  status.setAttribute('role','status');status.setAttribute('aria-live','polite');list.setAttribute('aria-label','Wallets on the blocklist');source.hidden=true;toggle.type='button';retry.type='button';toggle.hidden=true;retry.hidden=true;actions.append(toggle,retry);
  root.replaceChildren(head,intro,status,list,source,actions);
  let mint='',wallets=[],known=null,loaded=false,loading=false,failed=false,expanded=false,disposed=false,generation=0,sourceText='';
  function render(){
    if(disposed)return;const total=loaded?wallets.length:known;
    count.textContent=total===null?'':total.toLocaleString()+(total===1?' wallet':' wallets');count.hidden=total===null;
    list.replaceChildren();
    if(!wallets.length)list.append(el('li',loaded?'No wallets are on the blocklist.':loading?'Reading the blocklist…':failed?'The blocklist could not be read.':'The blocklist has not been read yet.','hook-allowlist-empty'));
    const shown=expanded?wallets:wallets.slice(0,preview);
    for(const address of shown){const item=el('li',null,'hook-allowlist-item hook-blocklist-item'),code=el('code',short(address));code.setAttribute('title',address);item.dataset.wallet=address;item.append(code);list.append(item);}
    toggle.hidden=wallets.length<=preview;toggle.textContent=expanded?'Show fewer':'Show all '+wallets.length.toLocaleString();toggle.setAttribute('aria-expanded',String(expanded));
    retry.hidden=!failed;source.textContent=loaded?sourceText:'';source.hidden=!(loaded&&sourceText);root.setAttribute('aria-busy',String(loading));
  }
  async function load(force=false){
    if(disposed||!mint||!request||loading||loaded&&!force)return;const version=generation;loading=true;failed=false;status.textContent='';render();
    try{const data=await request('/hook-blocklist?mint='+encodeURIComponent(mint));if(disposed||version!==generation)return;wallets=hookBlocklistWallets(data);const n=Number(data?.count);if(Number.isInteger(n)&&n>=wallets.length)known=n;sourceText=hookAllowlistSourceText(data);loaded=true;}
    catch(error){if(disposed||version!==generation||error?.cancelled)return;failed=true;status.textContent=error?.message||'The blocklist could not be read.';}
    finally{if(version===generation){loading=false;render();}}
  }
  toggle.onclick=()=>{expanded=!expanded;render();};retry.onclick=()=>void load(true);
  render();
  return {
    setCoin(nextMint,{count:nextCount}={}){const next=HOOK_ADDRESS.test(String(nextMint||''))?nextMint:'';if(next!==mint){generation++;mint=next;wallets=[];loaded=false;loading=false;failed=false;expanded=false;sourceText='';status.textContent='';}const n=Number(nextCount);if(Number.isInteger(n)&&n>=0&&!loaded)known=n;render();},
    load:()=>load(false),render,get wallets(){return wallets.slice();},get loaded(){return loaded;},
    destroy(){if(disposed)return;disposed=true;generation++;root.replaceChildren();},
  };
}

/**
 * The "Rules" card: the state pill and the route pill, one row per rule (with a "Launchpad route" chip on the rules that
 * need it), the gate token and the tithe recipient with copy buttons, the plain-words note, the read-only blocklist
 * viewer (with the Blocklist rule) and, for the signed-in creator, the allowlist manager (with the Allowlist rule).
 * `render` is cheap to call on every market refresh: the card only rebuilds when what it shows has changed, so the
 * manager and the viewer keep their state.
 */
export function createHookRulesCard({document,window=document.defaultView,root,request,walletFactory=getLaunchpadWallet,clock=Date.now,setTimer=setInterval,clearTimer=clearInterval,heading='Rules',onChange=()=>{}}={}){
  ensureHookStyles(document);
  const el=(tag,text,cls)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(cls)node.className=cls;return node;};
  root.classList.add('hook-rules');root.hidden=true;
  let coin=null,session=null,version='',manager=null,blocklist=null,disposed=false,copyTimer=null,lastOwner=null;
  const managerHost=el('div',null,'hook-rules-manager'),blocklistHost=el('div',null,'hook-rules-blocklist');managerHost.hidden=true;blocklistHost.hidden=true;
  const ownerOf=(value,next)=>typeof value?.owner==='boolean'?value.owner:hookOwner(value?.coin,next);
  function copy(text,button,toast){
    const clipboard=window?.navigator?.clipboard;if(!clipboard?.writeText)return;
    Promise.resolve(clipboard.writeText(text)).then(()=>{if(disposed)return;button.textContent='Copied ✓';try{document.dispatchEvent(new (window?.CustomEvent||CustomEvent)('curve-toast',{detail:{text:toast}}));}catch{}},()=>{if(!disposed)button.textContent='Copy failed';}).finally(()=>{if(disposed)return;clearTimeout(copyTimer);copyTimer=setTimeout(()=>{if(!disposed)button.textContent='Copy';},2500);});
  }
  /** An address row (gate token, tithe recipient): the label, the shortened address, a Solscan link and a copy button. */
  function addressRow(label,address,{cls,href,linkLabel,copyLabel,toast}){
    const row=el('p',null,'hook-gate '+cls),code=el('code',short(address));code.setAttribute('title',address);const link=el('a','↗','hook-gate-link');link.href=href;link.target='_blank';link.rel='noopener noreferrer';link.setAttribute('aria-label',linkLabel);
    const button=el('button','Copy','text-button hook-gate-copy');button.type='button';button.setAttribute('aria-label',copyLabel);button.onclick=()=>copy(address,button,toast);row.append(el('span',label),code,link,button);return row;
  }
  function render(next={}){
    if(disposed)return;coin=next.coin??coin;if('session'in next)session=next.session;if('owner'in next)lastOwner=next.owner;
    const rules=hookRules(coin?.hook),owner=ownerOf({coin,owner:lastOwner},session),ended=hookEnded(coin),route=hookRoute(coin?.hook),appName=hookAppName(coin?.hook),allowlisted=rules.some(rule=>rule.id==='allowlist'),blocklisted=rules.some(rule=>rule.id==='blocklist'),manage=owner&&allowlisted&&!ended&&!!request,viewBlocklist=blocklisted&&!!request;
    root.hidden=!rules.length;if(!rules.length){version='';root.replaceChildren();if(manager){manager.destroy();manager=null;}if(blocklist){blocklist.destroy();blocklist=null;}return;}
    const gate=coin.hook?.gateMint,tithe=coin.hook?.titheRecipient,blockCount=hookBlocklistCount(coin.hook);
    const key=JSON.stringify([coin.mint,rules,route,appName,gate,tithe,blockCount,ended,manage,viewBlocklist,sessionIdentity(session),session?.token||'']);
    if(key===version){if(manager)manager.render();if(blocklist)blocklist.render();return;}version=key;
    root.replaceChildren();root.dataset.hookState=ended?'ended':'active';root.dataset.route=route;
    const head=el('div',null,'coin-card-heading hook-rules-heading'),pills=el('span',null,'hook-rules-pills'),pill=el('span',hookStateText(coin),'cv-pill hook-pill '+(ended?'is-ended':'is-active'));pills.append(pill);
    const routePill=el('span',route==='app'?appName+' only':HOOK_ROUTES[route].name,'cv-pill hook-route-pill '+(route==='curve'?'is-curve':route==='app'?'is-app':'is-any'));routePill.dataset.route=route;routePill.setAttribute('title',hookRouteText(route,ended,appName));pills.append(routePill);
    head.append(el('h2',heading),pills);root.append(head);
    const list=el('ul',null,'hook-rule-list');list.setAttribute('aria-label','Transfer hook rules');
    for(const rule of rules){const item=el('li',null,'hook-rule');item.dataset.rule=rule.id;item.dataset.route=rule.route;const name=el('strong',rule.name);if(rule.route==='curve'){const chip=el('span','Launchpad route','cv-pill hook-rule-chip');chip.setAttribute('title',HOOK_ROUTES.curve.text);name.append(chip);}else if(rule.route==='app'){const chip=el('span',(rule.appName||appName)+' only','cv-pill hook-rule-chip is-app');chip.setAttribute('title',HOOK_ROUTES.app.text);name.append(chip);}item.append(name,el('span',rule.text,'hook-rule-text'));list.append(item);}
    root.append(list);
    if(HOOK_ADDRESS.test(String(gate||'')))root.append(addressRow('Gate token',gate,{cls:'hook-gate-mint',href:'https://solscan.io/token/'+gate,linkLabel:'Open the gate token on Solscan',copyLabel:'Copy the gate token address',toast:'Gate token address copied'}));
    if(HOOK_ADDRESS.test(String(tithe||'')))root.append(addressRow('Tithe recipient',tithe,{cls:'hook-tithe',href:'https://solscan.io/account/'+tithe,linkLabel:'Open the tithe recipient on Solscan',copyLabel:'Copy the tithe recipient address',toast:'Tithe recipient address copied'}));
    root.append(el('p',(ended?'These rules ended when the coin graduated: the swap that completed the curve removed the hook, and transfers are plain Token-2022 transfers now.':'Launchpad’s hook program checks every transfer against these rules while the coin is on the Meteora curve. The swap that completes the curve removes the hook, so every rule ends at graduation.')+' '+hookRouteText(route,ended,appName)+' A rule can stop a transfer; it never takes a fee or moves tokens.','hook-fine'));
    if(route==='app'&&!ended)root.append(el('p',hookTradeLockText(coin),'hook-fine hook-trade-lock'));
    blocklistHost.hidden=!viewBlocklist;root.append(blocklistHost);
    if(viewBlocklist){if(!blocklist)blocklist=createHookBlocklistViewer({document,root:blocklistHost,request});blocklist.setCoin(coin.mint,{count:blockCount});void blocklist.load();}
    else if(blocklist){blocklist.destroy();blocklist=null;blocklistHost.replaceChildren();}
    managerHost.hidden=!manage;root.append(managerHost);
    if(manage){if(!manager)manager=createHookAllowlistManager({document,window,root:managerHost,request,walletFactory,clock,setTimer,clearTimer,onChange});manager.setSession(session);manager.setCoin(coin.mint,{allowlist:coin.hook?.allowlist});void manager.load();}
    else if(manager){manager.destroy();manager=null;managerHost.replaceChildren();}
  }
  return {render,get manager(){return manager;},get blocklist(){return blocklist;},canLeave:()=>!manager||manager.canLeave(),destroy(){if(disposed)return;disposed=true;clearTimeout(copyTimer);manager?.destroy();manager=null;blocklist?.destroy();blocklist=null;root.replaceChildren();}};
}
