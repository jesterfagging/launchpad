import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createMeteoraTrade} from '../public/meteora-trade-ui.mjs';
import {createMeteoraAccountLaunches} from '../public/meteora-account-ui.mjs';
import {gotchiFundingSummary} from '../public/gotchi-catalog.mjs';
const A='7NwWHXzj8oWDV88gurSYjVT77J81qpLPN6xYkUSwfTgS',B='HN22QWXBPb7dfmPhTjCf14jDco4dYzwDKeehWDXcnHEF',M='GNu1FSuype33KF4RXfow38Dw3ziw9e71FTBLVY5mdrTa',Q='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const session={authenticated:true,token:'csrf',account:{id:'creator',mainWallet:A},walletVerified:true,walletAddress:A};
const coin={platform:'meteora',mint:M,symbol:'COIN',stage:'new',curveStatus:'curve',quote:{mint:Q,symbol:'STOCK',decimals:6},baseDecimals:6};
function fixture(t,{quoteDecimals=6,response}={}){
 const {document}=parseHTML('<html><head></head><body><main></main></body></html>'),root=document.querySelector('main'),calls=[];let address=A,listener;
 const wallet={state:()=>({address,wallets:[]}),onChange:fn=>{listener=fn;return()=>{};},sign:async input=>{calls.push(['sign',input]);return 'signed';}};
 let prepared;const fetcher=async(path,options)=>{const body=options?.body?JSON.parse(options.body):undefined;calls.push([path,body]);let value=response?.(path,body);
  if(value===undefined){if(path.endsWith('/wallet'))value={wallet:A,nativeBalanceLamports:'10000000',quoteBalanceRaw:'2345678',baseBalanceRaw:'9876543'};else if(path.endsWith('/operations'))value={operations:[]};else if(path.endsWith('/prepare'))value={operation:prepared={id:'operation-123',action:body.action,wallet:A,mint:M,state:'awaiting_signature',expiresAt:200000,transaction:'AQID',review:{maxWalletDebitLamports:'5000',quoteMint:Q,quoteDecimals,amountRaw:body.amountRaw,expectedOutputRaw:'2000000',minOutputRaw:'1800000'}}};else if(path.endsWith('/submit'))value={operation:{...prepared,state:'finalized',signature:'2'.repeat(88)}};else throw Error(path);}
  return {ok:true,status:200,json:async()=>value};};
 const controller=createMeteoraTrade({document,window:{setTimeout,clearTimeout},root,fetcher,walletFactory:()=>wallet,clock:()=>100000,setTimer:()=>0,clearTimer:()=>{}});t.after(()=>controller.destroy());controller.setCoin(coin);controller.setSession(session);
 return {root,calls,controller,get:name=>root.querySelector('[data-mt-'+name+']'),changeWallet(){address=B;listener();}};
}
test('Meteora buy signs once with exact six-decimal quote units and keeps fee amounts in quote units',async t=>{
 const f=fixture(t);await flush();assert.match(f.get('balance').textContent,/2\.345678/);assert.equal(f.get('unit').textContent,'STOCK');f.get('amount').value='1.234567';await f.get('review').onclick();const prepare=f.calls.find(([path])=>path.endsWith('/prepare'));assert.equal(prepare[1].amountRaw,'1234567');assert.equal(f.calls.filter(([path])=>path==='sign').length,1);assert.equal(f.calls.filter(([path])=>path.endsWith('/submit')).length,1);assert.match(f.root.textContent,/1\.00768%/);
});
test('Meteora buy refuses extra quote decimals and a wrong-decimal review before wallet signing',async t=>{
 const f=fixture(t,{quoteDecimals:9});await flush();f.get('amount').value='1.0000001';await f.get('review').onclick();assert.equal(f.calls.some(([path])=>path.endsWith('/prepare')),false);f.get('amount').value='1.2';await f.get('review').onclick();assert.equal(f.calls.some(([path])=>path==='sign'),false);assert.equal(f.calls.some(([path])=>path.endsWith('/submit')),false);
});
test('graduated Meteora coins keep the dedicated decimal-aware DAMM trade route',async t=>{
 const f=fixture(t);f.controller.setCoin({...coin,stage:'graduated',curveStatus:'migrated'});await flush();assert.match(f.get('progress').textContent,/DAMM v2/);f.get('sell').onclick();f.get('amount').value='2.5';await f.get('review').onclick();assert.equal(f.calls.find(([path])=>path.endsWith('/prepare'))[1].action,'sell');assert.equal(f.calls.find(([path])=>path.endsWith('/prepare'))[1].amountRaw,'2500000');
});
test('private Meteora fee assignments preserve creator attribution and never initialize wallets on load',async()=>{
 const {document}=parseHTML('<html><body><main></main></body></html>'),root=document.querySelector('main'),calls=[];
 const row={platform:'meteora',mint:M,name:'Assigned launch',symbol:'COIN',creatorId:'someone-else',creatorRecipient:A,status:'trading',quoteMint:Q,quoteSymbol:'STOCK',quoteDecimals:6,feeMode:'creator',creatorRewards:{totalClaimedRaw:'1500000',totalPaidRaw:'1000000',pendingRaw:'500000'},feeRedirect:{used:true,canRedirect:false,recipient:A}};
 const controller=createMeteoraAccountLaunches({document,window:{},root,api:async(path)=>{calls.push(path);return{launches:[row]};},walletFactory:()=>{throw Error('Do not initialize a wallet before claiming');},setTimer:()=>0,clearTimer:()=>{}});
 controller.setSession(session);await controller.load();assert.match(root.textContent,/original creator’s public profile/);assert.match(root.textContent,/1\.5 STOCK/);assert.equal(root.querySelector('form'),null);assert.equal(calls.length,1);controller.setSession({authenticated:false});assert.equal(root.hidden,true);assert.equal(root.querySelectorAll('article').length,0);controller.destroy();
});
function accountFixture(rows,{handler}={}){
 const {document}=parseHTML('<html><body><main></main></body></html>'),root=document.querySelector('main'),calls=[];
 const controller=createMeteoraAccountLaunches({document,window:{},root,api:async(path,body)=>{calls.push([path,body]);const custom=await handler?.(path,body);if(custom!==undefined)return custom;if(path.endsWith('/launches'))return{launches:rows};throw Error('Unexpected '+path);},walletFactory:()=>({state:()=>({address:A,wallets:[]}),onChange:()=>()=>{}}),setTimer:()=>0,clearTimer:()=>{}});
 controller.setSession(session);
 return {document,root,calls,controller,dialog:()=>document.getElementById('meteora-fee-redirect-dialog'),button:text=>[...root.querySelectorAll('button')].find(button=>button.textContent===text)};
}
test('one-time Meteora fee redirect needs the full-address preview and an explicit confirmation before posting',async()=>{
 const row={platform:'meteora',mint:M,name:'Harbor',symbol:'HARBR',creatorId:'creator',creatorRecipient:A,status:'trading',quoteSymbol:'SOL',quoteDecimals:9,feeMode:'creator',creatorRewards:{totalClaimedRaw:'0',totalPaidRaw:'0',pendingRaw:'0'},feeRedirect:{used:false,canRedirect:true,recipient:A}};
 let resolve;const f=accountFixture([row],{handler:path=>path==='/api/launchpad/meteora/reroute'?new Promise(r=>resolve=r):undefined});await f.controller.load();
 assert.equal(f.root.querySelector('form'),null,'no inline form posts on Enter');f.root.querySelector('[data-meteora-redirect]').onclick();
 const dialog=f.dialog(),form=dialog.querySelector('form'),input=f.document.getElementById('meteora-fee-redirect-address'),confirm=dialog.querySelector('input[type=checkbox]'),submit=dialog.querySelector('button[type=submit]');
 assert.equal(dialog.hasAttribute('open')||dialog.open===true,true);assert.equal(input.hasAttribute('maxlength'),false);assert.match(dialog.textContent,/Current recipient/);assert.match(dialog.textContent,new RegExp(A));
 input.value=B;input.oninput();assert.equal(dialog.querySelector('output').textContent,B);assert.equal(submit.disabled,true);await form.onsubmit({preventDefault(){}});
 assert.equal(f.calls.some(([path])=>path.endsWith('/reroute')),false,'Enter without the confirmation sends nothing');
 confirm.checked=true;confirm.onchange();for(const value of ['z'.repeat(44),A]){input.value=value;input.oninput();assert.equal(submit.disabled,true,value);await form.onsubmit({preventDefault(){}});}
 assert.equal(f.calls.some(([path])=>path.endsWith('/reroute')),false);
 input.value='  '+B+' ';input.oninput();assert.equal(submit.disabled,false);const saving=form.onsubmit({preventDefault(){}});await flush();
 assert.deepEqual(f.calls.filter(([path])=>path.endsWith('/reroute')).map(([,body])=>body),[{mint:M,recipient:B}]);assert.equal(f.controller.canLeave(),false);assert.equal(input.disabled,true);
 resolve({launch:{...row,creatorRecipient:B,feeRedirect:{used:true,canRedirect:false,recipient:B}}});await saving;assert.equal(f.controller.canLeave(),true);assert.equal(dialog.hasAttribute('open')&&dialog.open!==false,false);assert.match(f.root.textContent,/now belong to/);
 f.controller.destroy();assert.equal(f.document.getElementById('meteora-fee-redirect-dialog'),null);
});
test('Meteora AI Agent and unfinished launches offer no creator claim, redirect or link to a coin that is not live',async()=>{
 const base={platform:'meteora',creatorId:'creator',quoteSymbol:'SOL',quoteDecimals:9,creatorRewards:{totalClaimedRaw:'0',totalPaidRaw:'0',pendingRaw:'0'}};
 const agent={...base,mint:M,name:'Tide Writer',symbol:'TIDE',status:'trading',feeMode:'agent',agent:{id:'a1',wallet:B,href:'/coin?mint='+M+'#agent'},creatorRecipient:B,feeRedirect:{used:false,canRedirect:false,recipient:B}};
 const pending={...base,mint:Q,name:'Pending Pier',symbol:'PIER',status:'configured',feeMode:'creator',creatorRecipient:A,feeRedirect:{used:false,canRedirect:true,recipient:A}};
 const f=accountFixture([agent,pending]);await f.controller.load();
 assert.match(f.root.textContent,/AI Agent/);assert.equal(f.button('Claim creator fees'),undefined);assert.doesNotMatch(f.root.textContent,/Recorded creator earnings/);
 assert.deepEqual([...f.root.querySelectorAll('.token-card a')].map(a=>a.getAttribute('href')),['/coin?mint='+M+'#agent']);
 f.controller.setFilter('drafts');assert.match(f.root.textContent,/Pending Pier/);assert.equal(f.button('Claim creator fees'),undefined);assert.equal(f.root.querySelector('[data-meteora-redirect]'),null);
 assert.deepEqual([...f.root.querySelectorAll('.token-card a')].map(a=>a.getAttribute('href')),['/launchpad?venue=meteora']);f.controller.destroy();
});

test('the Meteora fee note follows the coin: Gotchi launches show their 2.52% policy and agent coins pay their agent',async t=>{
 const f=fixture(t);await flush();
 f.controller.setCoin({...coin,feeMode:'gotchi',gotchi:{id:'fomogotchi'}});assert.equal(f.get('fee').textContent,gotchiFundingSummary('meteora').text);assert.match(f.get('fee').textContent,/2\.52%/);assert.doesNotMatch(f.get('fee').textContent,/1\.88%|0\.49632%/);
 f.controller.setCoin({...coin,feeMode:'agent'});assert.match(f.get('fee').textContent,/1\.88% trading fee: 0\.376% to Meteora, 1\.00768% to Launchpad, and 0\.49632% to the coin’s AI agent\./);
 f.controller.setCoin({...coin,feeMode:'holders'});assert.match(f.get('fee').textContent,/0\.49632% to holder rewards\./);
 f.controller.setCoin({...coin,feeMode:'creator'});assert.match(f.get('fee').textContent,/0\.49632% to the creator\./);
});
test('Meteora slippage errors name the slippage field, and switching Buy/Sell clears earlier messages',async t=>{
 const f=fixture(t);await flush();f.get('amount').value='1';
 for(const value of ['','abc','0.001','101']){f.get('slippage').value=value;await f.get('review').onclick();assert.equal(f.get('status').textContent,'Enter slippage from 0% to 100%, with up to two decimal places.',JSON.stringify(value));}
 assert.equal(f.calls.some(([path])=>path.endsWith('/prepare')),false);
 f.get('sell').onclick();assert.equal(f.get('status').textContent,'');assert.equal(f.get('amount').value,'');
 f.get('buy').onclick();f.get('amount').value='1';f.get('slippage').value='1';await f.get('review').onclick();await flush();assert.equal(f.calls.filter(([path])=>path.endsWith('/submit')).length,1);assert.equal(f.get('operation').hidden,false);
 f.get('sell').onclick();assert.equal(f.get('operation').hidden,true,'the finished buy is cleared for a new sell');assert.equal(f.get('sell').getAttribute('aria-pressed'),'true');
});
