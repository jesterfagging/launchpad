import {createQuoteIcon,createQuoteLabel,quoteLogoPath} from '../public/quote-logos.mjs';
import {createChainSelect,initialLaunchChain,launchChainById} from '../public/launch-chains.mjs';
import { CREATOR_FEE_TIERS, creatorFeeForLaunch } from '../public/creator-fee-schedule.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { launchInput, displayUnits, units, SOL_MINT, USDC_MINT, socialLink } from '../public/launchpad-model.mjs';
import { LAUNCH_ASSETS } from '../public/launch-assets.mjs';
import { NATIVE_LAUNCH_ASSETS } from '../public/quote-display-assets.mjs';

const WBTC_MINT='3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';
const WETH_MINT='7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';
const CUSTOM_WBTC_MINT='5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ';

async function picker(extra=[],{quotes,canViewComingSoon=true,timers=false}={}) {
  const {document,window}=parseHTML(await readFile(new URL('../public/launchpad.html',import.meta.url),'utf8'));
  for(const input of document.querySelectorAll('input[type=radio],input[type=checkbox]'))input.checked=input.hasAttribute('checked');
  const form=document.getElementById('launch-form');Object.defineProperty(form,'elements',{value:{namedItem(name){const rows=[...form.querySelectorAll('[name]')].filter(row=>row.name===name);return rows.length===1?rows[0]:{get value(){return rows.find(row=>row.checked)?.value||'';}};}}});
  window.HTMLElement.prototype.showModal=function(){this.open=true;};window.HTMLElement.prototype.close=function(){this.open=false;};
  const calls=[],assets=[...LAUNCH_ASSETS.map(a=>a.category==='custom'?a:{...a,supported:true}),...extra];
  const fetch=async(path,options={})=>{calls.push({path,options});return{ok:true,status:200,json:async()=>path==='/api/session'?{authenticated:true,token:'csrf',account:canViewComingSoon?{id:'admin',role:'admin',mfaEnabled:true}:{id:'user',role:'user'},monitorAllowed:canViewComingSoon}:path.endsWith('/quotes')?{canViewComingSoon,...(quotes?await quotes():{assets})}:{launches:[]}};};
  const source=(await readFile(new URL('../public/launchpad.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/^export /gm,'').replace(/bootPage\('launchpad',mountPage\);/,'')+'\nconst pageController=mountPage({document,window:document.defaultView});await pageController.ready;return pageController;';
  // `timers`: long timeouts (a second or more: the pair-list retry) are captured in `scheduled` and run by hand with runScheduled().
  const scheduled=[],scheduleLong=(fn,ms,...args)=>{if(timers&&ms>=1000){scheduled.push({fn:()=>fn(...args),ms});return -scheduled.length;}return setTimeout(fn,ms,...args);},runScheduled=async()=>{const due=scheduled.splice(0).filter(Boolean);for(const job of due)job.fn();await new Promise(resolve=>setTimeout(resolve,0));return due.map(job=>job.ms);};
  const deps={createChainSelect,initialLaunchChain,launchChainById,createQuoteIcon,createQuoteLabel,CREATOR_FEE_TIERS,creatorFeeForLaunch,document,fetch,crypto:{randomUUID},setInterval:()=>{},setTimeout:scheduleLong,clearTimeout:id=>{if(typeof id==='number'&&id<0)scheduled[-id-1]=null;else clearTimeout(id);},createWorkspaceShell:()=>{},launchInput,displayUnits,units,SOL_MINT,USDC_MINT,socialLink,LAUNCH_ASSETS:NATIVE_LAUNCH_ASSETS,createLaunchpadWallet:()=>({state:()=>({address:'',wallets:[]}),onChange(){}})};
  const controller=await new (Object.getPrototypeOf(async()=>{}).constructor)(...Object.keys(deps),source)(...Object.values(deps));await new Promise(resolve=>setTimeout(resolve,0));
  const $=id=>document.getElementById(id),open=()=>$('launch-asset-open').onclick(),rows=()=>[...document.querySelectorAll('#launch-asset-results button')],bySymbol=symbol=>rows().find(row=>row.querySelector('strong').textContent===symbol),byMint=mint=>rows().find(row=>row.querySelector('.quote-logo')?.dataset.mint===mint);
  open();return{document,window,$,calls,extra,open,rows,bySymbol,byMint,scheduled,runScheduled};
}

test('quote picker uses mint-specific local logos and preserves native-pair exclusions',async()=>{
  const p=await picker();
  for(const [symbol,mint] of [['WBTC',WBTC_MINT],['WETH',WETH_MINT],['MU','MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1'],['GPRO','GPRR2u6NS5yBQHWGauoJ9HXgjrTH8dDsrBfTV5zAYvDH']]) {const row=p.byMint(mint);assert(row,symbol);assert.equal(row.querySelector('.launch-ticker-badge').textContent,symbol);assert.equal(row.querySelector('.launch-ticker-badge').getAttribute('aria-hidden'),'true');}
  assert.equal(p.rows().some(row=>[SOL_MINT,USDC_MINT].includes(row.querySelector('.quote-logo')?.dataset.mint)),false);
  assert.equal(p.document.querySelectorAll('#launch-asset-results .launch-ticker-badge img').length,LAUNCH_ASSETS.filter(a=>![SOL_MINT,USDC_MINT].includes(a.mint)&&quoteLogoPath(a.mint)).length);for(const image of p.document.querySelectorAll('#launch-asset-results .launch-ticker-badge img'))assert.match(image.src,/^\/quote-logos\//,'only local bundled images');
  for(const symbol of ['SOL','USDC']){const image=p.document.querySelector('[data-pair='+symbol+'] img');assert.equal(image.src,quoteLogoPath(symbol==='SOL'?SOL_MINT:USDC_MINT));assert.equal(p.document.querySelectorAll('[data-pair='+symbol+'] img').length,1,'one native logo only');}
  const failed=p.byMint(WBTC_MINT).querySelector('img');failed.onerror();assert.equal(p.byMint(WBTC_MINT).querySelector('img'),null);assert.equal(p.byMint(WBTC_MINT).querySelector('.quote-logo').dataset.state,'fallback');
  assert(!p.calls.some(call=>!call.path.startsWith('/api/')));
});

test('selected custom-pair button reuses its full ticker badge and resets when switching to native SOL',async()=>{
  const p=await picker(),row=p.byMint(WBTC_MINT),tone=row.querySelector('.launch-ticker-badge').className;
  row.onclick();assert.equal(p.$('launch-custom-label').textContent,'WBTC');assert.equal(p.$('launch-card-pair').textContent,'WBTC');
  const selected=p.$('launch-asset-open').querySelector('.launch-ticker-badge');assert.equal(selected.textContent,'WBTC');assert(selected.className.startsWith(tone));assert.equal(selected.dataset.mint,WBTC_MINT);
  p.open();p.byMint(WETH_MINT).onclick();assert.equal(p.$('launch-asset-open').querySelectorAll('.launch-ticker-badge').length,1);assert.equal(p.$('launch-asset-open').querySelector('.launch-ticker-badge').textContent,'WETH');
  p.document.querySelector('[data-pair=SOL]').onclick();assert.equal(p.$('launch-asset-open').querySelector('.launch-ticker-badge'),null);assert.equal(p.$('launch-custom-label').textContent,'Custom');
});

test('provider slugs are human-readable without repeated issuers and long tickers remain complete',async()=>{
  const input=[{symbol:'EXAMPLEx',name:'Example - backpack_securities',issuer:'backpack_securities',mint:'test-mint-1',category:'stocks',supported:true},{symbol:'LONGSTOCKTICKER',name:'Another stock',issuer:'backpack_securities',mint:'test-mint-2',category:'stocks',supported:true}];
  const originals=structuredClone(input),p=await picker(input);
  const first=p.bySymbol('EXAMPLEx'),second=p.bySymbol('LONGSTOCKTICKER');
  assert.equal(first.querySelector('span:nth-child(2) small').textContent,'Example - Backpack Securities');
  assert.equal(second.querySelector('span:nth-child(2) small').textContent,'Another stock · Backpack Securities');
  assert.equal(first.querySelector('.launch-ticker-badge').textContent,'EXAMPLEx');assert.equal(second.querySelector('.launch-ticker-badge').textContent,'LONGSTOCKTICKER');
  assert.equal(second.querySelector('.launch-ticker-letters').dataset.size,'extended');assert.equal(p.byMint(WBTC_MINT).querySelector('.launch-ticker-letters').dataset.size,'short');
  p.$('launch-asset-search').value='Backpack Securities';p.$('launch-asset-search').oninput();assert(p.bySymbol('EXAMPLEx'));assert(!p.$('launch-asset-results').textContent.includes('backpack_securities'));assert.deepEqual(input,originals,'display cleanup never changes mint or provider identifiers');
});

test('Pre-IPO and Crypto filters show verified offerings, and unsupported rows explain why',async()=>{
  const p=await picker([{symbol:'NOTREADY',name:'Test stock',mint:'not-ready',category:'stocks',supported:false,supportReason:'Raydium has no bonding-curve launch configuration for this token yet.'}]);
  assert.equal(p.bySymbol('NOTREADY'),undefined);p.document.querySelector('[data-category=coming]').onclick();const blocked=p.bySymbol('NOTREADY');assert.equal(blocked.disabled,true);assert.match(blocked.textContent,/no bonding-curve launch configuration/);assert.match(blocked.textContent,/Not supported yet/);
  blocked.onclick();assert.equal(p.$('launch-card-pair').textContent,'SOL','unsupported mints cannot be selected');
  p.document.querySelector('[data-category=preipo]').onclick();assert.equal(p.rows().length,10);assert(p.bySymbol('OPENAI'));assert(p.bySymbol('ANDURIL'));assert(p.bySymbol('tOpenAI'));assert(p.bySymbol('tKalshi'));assert(p.bySymbol('tSpaceX'));assert.equal(p.bySymbol('XMR'),undefined);
  p.document.querySelector('[data-category=crypto]').onclick();assert(p.bySymbol('XMR'));assert.match(p.bySymbol('XMR').textContent,/wrapped on Solana/);assert.equal(p.bySymbol('OPENAI'),undefined);
});


test('Coming Soon contains only authoritative unavailable pairs, including unavailable native pairs',async()=>{
  const rows=LAUNCH_ASSETS.map(row=>({...row,supported:row.symbol==='SOL'||row.symbol==='BONK'?false:row.symbol==='USDC'?true:undefined,supportReason:row.symbol==='BONK'?'Awaiting quote configuration.':undefined})),p=await picker([],{quotes:async()=>({assets:rows})});
  assert.equal(p.bySymbol('BONK'),undefined);assert(p.bySymbol('WIF'));assert.match(p.bySymbol('WIF').textContent,/Check availability/);
  p.document.querySelector('[data-category=coming]').onclick();assert.deepEqual(p.rows().map(row=>row.querySelector('strong').textContent).sort(),['BONK','SOL']);assert.equal(p.$('launch-coming-note').hidden,false);assert.match(p.bySymbol('BONK').textContent,/Awaiting quote configuration/);
  p.$('launch-asset-search').value='bonk';p.$('launch-asset-search').oninput();assert.equal(p.rows().length,1);assert.equal(p.bySymbol('BONK').disabled,true);p.bySymbol('BONK').onclick();assert.equal(p.$('launch-card-pair').textContent,'SOL');
  p.document.querySelector('[data-category=crypto]').onclick();assert.equal(p.rows().length,0);assert.equal(p.$('launch-coming-note').hidden,true);p.$('launch-asset-search').value='wif';p.$('launch-asset-search').oninput();assert(p.bySymbol('WIF'));
});

test('an open picker refreshes after delayed availability checks and moves assets to Coming Soon',async()=>{
  let resolveQuotes;const pending=new Promise(resolve=>resolveQuotes=resolve),p=await picker([],{quotes:()=>pending});assert.equal(p.rows().length,0);assert.match(p.$('launch-asset-results').textContent,/Checking available pairs/);assert.equal(p.document.querySelector('[data-category=coming]').hidden,true);
  p.document.querySelector('[data-category=coming]').onclick();assert.equal(p.rows().length,0);
  resolveQuotes({assets:LAUNCH_ASSETS.map(row=>({...row,supported:row.symbol!=='BONK',supportReason:row.symbol==='BONK'?'Awaiting Raydium support.':''}))});await new Promise(resolve=>setTimeout(resolve,0));await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(p.document.querySelector('[data-category=coming]').hidden,false);p.document.querySelector('[data-category=coming]').onclick();assert.equal(p.rows().length,1);assert.equal(p.bySymbol('BONK').disabled,true);assert.match(p.bySymbol('BONK').textContent,/Awaiting Raydium support/);
  p.document.querySelector('[data-category=all]').onclick();assert.equal(p.bySymbol('BONK'),undefined);assert.match(p.bySymbol('WIF').textContent,/Available/);
});

test('Custom tab shows only curated custom assets and mint search distinguishes duplicate symbols',async()=>{
  const first='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',second='BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const p=await picker([{symbol:'SAME',name:'First custom token',mint:first,category:'custom',supported:true},{symbol:'SAME',name:'Second custom token',mint:second,category:'custom',supported:true},{symbol:'PENDING',name:'Unconfigured custom token',mint:'7rvRFpzP5W18yZcNpPNqtWgPTxLaFrnutz5QPxXpyupc',category:'custom',supported:false}]);
  p.document.querySelector('[data-category=custom]').onclick();assert.equal(p.rows().length,LAUNCH_ASSETS.filter(a=>a.category==='custom').length+2);assert.equal(Boolean(p.byMint(WBTC_MINT)),false,'the original Wormhole WBTC stays out of Custom');assert(p.byMint(CUSTOM_WBTC_MINT),'the distinct Custom WBTC remains listed by its own mint');assert.equal(p.bySymbol('PENDING'),undefined);
  p.$('launch-asset-search').value=second;p.$('launch-asset-search').oninput();assert.equal(p.rows().length,1);assert.match(p.rows()[0].textContent,/Second custom token/);assert.equal(p.rows()[0].querySelector('.launch-asset-mint').title,second);assert.equal(p.rows()[0].querySelector('img'),null,'unknown logos use neutral text fallback without remote requests');
  p.rows()[0].onclick();assert.equal(p.$('launch-asset-open').querySelector('.launch-ticker-badge').dataset.mint,second);
  assert(!p.calls.some(call=>!call.path.startsWith('/api/')));
});
test('Custom tab shows the selected catalogue and does not invent live availability',async()=>{
  const p=await picker();p.document.querySelector('[data-category=custom]').onclick();assert.equal(p.rows().length,LAUNCH_ASSETS.filter(a=>a.category==='custom').length);assert(p.rows().every(row=>row.disabled));assert(p.rows().every(row=>row.textContent.includes('Unable to verify')));
});
test('custom pair with unknown live verification stays disabled and cannot be selected',async()=>{
  const p=await picker([{symbol:'UNVERIFIED',name:'Custom unverified',mint:'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',category:'custom',supported:null,supportReason:'Unable to verify pairing availability right now.'}]);
  p.document.querySelector('[data-category=custom]').onclick();const row=p.bySymbol('UNVERIFIED');assert.equal(row.disabled,true);assert.match(row.textContent,/Unable to verify/);assert(!row.textContent.includes('Available'));
  row.onclick();assert.equal(p.$('launch-card-pair').textContent,'SOL');assert.equal(p.$('launch-asset-dialog').open,true);
});

test('pair total counts verified unique mints across categories and native shortcuts',async()=>{
  const sol={...LAUNCH_ASSETS.find(a=>a.mint===SOL_MINT),supported:true};
  const usdc={...LAUNCH_ASSETS.find(a=>a.mint===USDC_MINT),supported:true};
  const first={symbol:'SAME',name:'First custom',mint:'A'.repeat(32),category:'custom',supported:true};
  const second={symbol:'SAME',name:'Second custom',mint:'B'.repeat(32),category:'custom',wormhole:true,supported:true};
  const waiting={symbol:'WAIT',name:'Not yet available',mint:'C'.repeat(32),category:'custom',supported:false};
  const unknown={symbol:'UNKNOWN',name:'Unverified',mint:'D'.repeat(32),category:'stocks',supported:null};
  for(const canViewComingSoon of [false,true]){
    const p=await picker([],{canViewComingSoon,quotes:async()=>({assets:[sol,usdc,first,second,{...second,category:'wormhole'},waiting,unknown]})});
    const count=()=>p.$('launch-asset-count').textContent;
    assert.equal(count(),'4 pairs available · Includes SOL and USDC');
    for(const category of ['custom','wormhole','coming']){
      p.document.querySelector('[data-category='+category+']').onclick();
      assert.equal(count(),'4 pairs available · Includes SOL and USDC','filters never replace the full available count');
    }
    p.$('launch-asset-search').value='no results';p.$('launch-asset-search').oninput();
    assert.equal(count(),'4 pairs available · Includes SOL and USDC');
  }
});

test('pair total never borrows an unverified native shortcut or bundled catalogue entry',async()=>{
  const custom={symbol:'USDC',name:'A distinct custom token',mint:'A'.repeat(32),category:'custom',supported:true};
  const p=await picker([],{quotes:async()=>({assets:[custom,{...LAUNCH_ASSETS.find(a=>a.mint===USDC_MINT),supported:false}]})});
  assert.equal(p.$('launch-asset-count').textContent,'1 pair available');
  const empty=await picker([],{canViewComingSoon:false,quotes:async()=>({assets:[]})});
  assert.equal(empty.$('launch-asset-count').textContent,'0 pairs available');
});

test('pair total waits for verification and remains unavailable after a failed catalogue request',async()=>{
  let resolveQuotes;const pending=new Promise(resolve=>resolveQuotes=resolve);
  const p=await picker([],{quotes:()=>pending});
  assert.equal(p.$('launch-asset-count').textContent,'Checking available pairs…');
  resolveQuotes({assets:[{...LAUNCH_ASSETS.find(a=>a.mint===SOL_MINT),supported:true}]});
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(p.$('launch-asset-count').textContent,'1 pair available · Includes SOL');
  const failed=await picker([],{quotes:async()=>{throw Error('Provider unavailable');}});
  assert.equal(failed.$('launch-asset-count').textContent,'Pair count unavailable.');
  failed.open();assert.equal(failed.$('launch-asset-count').textContent,'Pair count unavailable.');
});

// v71.25: a category tab is offered only when it lists something (SOL and USDC have their own buttons).
test('Raydium hides category tabs that would list nothing, once its catalogue has arrived, and keeps Custom',async()=>{
  const sol={...LAUNCH_ASSETS.find(a=>a.mint===SOL_MINT),supported:true},usdc={...LAUNCH_ASSETS.find(a=>a.mint===USDC_MINT),supported:true},crypto={symbol:'ONLY',name:'Only crypto',mint:'E'.repeat(32),category:'crypto',supported:true},stock={symbol:'STK',name:'Waiting stock',mint:'F'.repeat(32),category:'stocks',supported:false};
  const p=await picker([],{canViewComingSoon:false,quotes:async()=>({assets:[sol,usdc,crypto,stock]})});
  const hidden=category=>p.document.querySelector('[data-category='+category+']').hidden;
  assert.deepEqual(['all','crypto','custom'].map(hidden),[false,false,false]);assert.deepEqual(['leveraged','wormhole','stocks','preipo','coming'].map(hidden),[true,true,true,true,true]);
  p.document.querySelector('[data-category=crypto]').onclick();assert.deepEqual(p.rows().map(row=>row.querySelector('strong').textContent),['ONLY']);
});

// v71.36: Raydium's SOL and USDC buttons are never dimmed by a pair list that is still loading, failed to load or came back
// without them: the built-in entries can be chosen, the pair note says what is happening, the launch waits for a list that
// carries the pair (prepare verifies it on chain again), and a failed or empty read is asked again after 5 s, then 10, 20, 40.
test('Raydium native pair buttons stay usable while the pair list loads, after a failed read and when the list lacks them; the note says so, the launch waits and the read is retried',async()=>{
  const sol={...LAUNCH_ASSETS.find(a=>a.mint===SOL_MINT),supported:true},usdc={...LAUNCH_ASSETS.find(a=>a.mint===USDC_MINT),supported:true};
  let resolveQuotes;const pending=new Promise(resolve=>resolveQuotes=resolve);
  const p=await picker([],{canViewComingSoon:false,quotes:()=>pending,timers:true}),button=symbol=>p.document.querySelector('[data-pair='+symbol+']');
  p.$('launch-asset-dialog').close();
  assert.equal(button('SOL').disabled,false);assert.equal(button('USDC').disabled,false);assert.equal(button('SOL').getAttribute('aria-pressed'),'true');
  assert.equal(p.$('launch-pair-note').textContent,'Your coin trades against SOL. Checking Raydium’s pair list…');assert.equal(p.$('launch-open').disabled,true,'the launch waits for the list');
  button('USDC').onclick();assert.equal(button('USDC').getAttribute('aria-pressed'),'true');assert.equal(button('SOL').getAttribute('aria-pressed'),'false');
  assert.equal(p.$('launch-pair-note').textContent,'Your coin trades against USDC. Checking Raydium’s pair list…');assert.equal(p.$('launch-card-pair').textContent,'USDC');assert.equal(p.$('launch-open').disabled,true);
  resolveQuotes({assets:[sol,usdc]});await new Promise(resolve=>setTimeout(resolve,0));
  assert.equal(p.$('launch-pair-note').textContent,'Your coin trades against USDC.');assert.equal(button('USDC').getAttribute('aria-pressed'),'true');assert.equal(button('SOL').disabled,false);assert.equal(button('USDC').disabled,false);
  assert.equal(p.$('launch-open').disabled,false,'the live row carries the pair');assert.deepEqual(p.scheduled.filter(Boolean),[],'nothing to retry after a good read');
  // A failed read: the buttons stay usable, the note says the list could not be checked, and the read is retried after 5 s, then 10 s.
  let reads=0,fail=true;const q=await picker([],{canViewComingSoon:false,quotes:async()=>{reads++;if(fail)throw Error('Provider unavailable');return{assets:[sol,usdc]};},timers:true}),qButton=symbol=>q.document.querySelector('[data-pair='+symbol+']');
  q.$('launch-asset-dialog').close();assert.equal(reads,1);
  assert.equal(qButton('SOL').disabled,false);assert.equal(qButton('USDC').disabled,false);assert.equal(q.$('launch-pair-note').textContent,'Your coin trades against SOL. Pair availability could not be checked just now; retrying automatically. It is verified before launch.');assert.equal(q.$('launch-open').disabled,true);
  assert.deepEqual(await q.runScheduled(),[5000]);assert.equal(reads,2,'retried after 5 s');assert.deepEqual(q.scheduled.filter(Boolean).map(job=>job.ms),[10000],'then after 10 s');
  qButton('USDC').onclick();assert.equal(q.$('launch-pair-note').textContent,'Your coin trades against USDC. Pair availability could not be checked just now; retrying automatically. It is verified before launch.');
  fail=false;await q.runScheduled();assert.equal(reads,3);
  assert.equal(q.$('launch-pair-note').textContent,'Your coin trades against USDC.');assert.equal(q.$('launch-open').disabled,false);assert.deepEqual(q.scheduled.filter(Boolean),[],'a good read ends the retries');
  // A list that came back without the native pairs (the server could not check availability): SOL stays chosen and usable, retried the same way.
  const r=await picker([],{canViewComingSoon:false,quotes:async()=>({assets:[]}),timers:true}),rButton=symbol=>r.document.querySelector('[data-pair='+symbol+']');
  r.$('launch-asset-dialog').close();
  assert.equal(rButton('SOL').disabled,false);assert.equal(rButton('USDC').disabled,false);assert.equal(rButton('SOL').getAttribute('aria-pressed'),'true');assert.equal(r.$('launch-open').disabled,true);
  assert.equal(r.$('launch-pair-note').textContent,'Your coin trades against SOL. Pair availability could not be checked just now; retrying automatically. It is verified before launch.');assert.deepEqual(r.scheduled.filter(Boolean).map(job=>job.ms),[5000]);
});
