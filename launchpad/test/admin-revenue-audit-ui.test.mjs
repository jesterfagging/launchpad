import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createAdminRevenueAudit,safeRevenueAuditReport} from '../public/admin-revenue-audit-ui.mjs';

const admin={id:'operator',role:'admin',mfaEnabled:true},wallet='11111111111111111111111111111111',mint='So11111111111111111111111111111111111111112';
const result={version:1,generatedAt:1800840000000,evidence:'saved-records',liveChainVerified:false,policy:{recipient:wallet,creationFeeSol:'0.015',curveFeeBps:100,taxRevenueShareBps:500,autoHarvest:true,lpPolicy:'locked-75-burned-25',platformLpPercent:75},treasury:{configured:true,enabled:true,address:wallet,recipientMatches:true,previousRecipients:[],pending:null},summary:{launches:3,legacyLaunches:1,pendingOperations:1,untrackedCreationReceipts:1,attentionCount:2},totals:[{mint,symbol:'SOL',decimals:9,recipient:wallet,kind:'tax-protocol-payout',amount:'9007199254740993123456',receipts:3,currentRecipient:true}],coins:[{id:'coin',accountId:'owner',name:'Example',symbol:'COIN',mint,quoteMint:mint,quoteSymbol:'SOL',quoteDecimals:9,baseDecimals:6,platformFeeBps:100,protocolWallet:wallet,recipient:wallet,autoHarvest:true,lpPolicy:'locked-75-burned-25',protocolCredit:'10000000',protocolBaseCredit:'0',taxProtocolCredit:'2500000',pending:[{kind:'tax-protocol-payout',signature:'1'.repeat(64),state:'pending',createdAt:1800840000000}],issues:['legacy_launch']}],issues:[{code:'untracked_creation_receipts',scope:'creation',count:1}]};
function page({account=admin,respond=async()=>result,isActive=()=>true}={}){
  const {document}=parseHTML('<html><body></body></html>');Object.defineProperty(document,'hidden',{value:false,writable:true});
  const calls=[],timers=new Map(),downloads=[];let nextTimer=0;
  const ui=createAdminRevenueAudit({document,getAccount:()=>account,isActive,api:async path=>{calls.push(path);return respond();},downloadFile:async file=>downloads.push(file),setTimer:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id)});document.body.append(ui.element);
  return {ui,document,calls,timers,downloads,setAccount:value=>{account=value;},visibility:hidden=>{document.hidden=hidden;document.dispatchEvent(new document.defaultView.Event('visibilitychange'));}};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('checks disclose recorded-only scope, percentage basis, exact pending amounts and destination',async()=>{
  const p=page();await p.ui.load();assert.deepEqual(p.calls,['/api/admin/revenue-audit']);assert.equal(p.ui.element.tagName,'DETAILS');assert.equal(p.ui.element.querySelector('summary').textContent,'Revenue checks');
  assert.match(p.ui.element.textContent,/does not independently verify on-chain balances/);assert.match(p.ui.element.textContent,/On-chain verification: not performed/);assert.match(p.ui.element.textContent,/5% of collected tax proceeds/);assert.match(p.ui.element.textContent,/0\.25%/);assert.match(p.ui.element.textContent,/9,007,199,254,740\.993123456 SOL/);assert.match(p.ui.element.textContent,/Protocol payout pending: 0\.01 SOL/);assert.match(p.ui.element.textContent,/Tax revenue payout pending: 0\.0025 SOL/);assert.match(p.ui.element.textContent,/legacy fee policy/);assert.match(p.ui.element.textContent,/Some creation fees have no retained receipt/);assert.match(p.ui.element.textContent,/Current recipient/);
  assert.equal([...p.timers.values()][0].ms,60000);assert.equal(p.ui.element.querySelectorAll('form,input,select').length,0);p.ui.destroy();
});

test('report download explicitly whitelists public fields and cannot include source keys or provider errors',async()=>{
  const privateData={...structuredClone(result),secret:'TOP_SECRET',raw:'SIGNED_RAW',rpcUrl:'https://secret-rpc',accounts:[{password:'PASSWORD'}],wallet:{secret:'KEY'},error:'PRIVATE_ERROR'};
  privateData.treasury.secret='TREASURY_SECRET';privateData.treasury.wallet={secret:'NESTED_SECRET'};privateData.coins[0].keys={wallet:{secret:'LAUNCH_SECRET'}};privateData.coins[0].input={password:'PVT'};privateData.coins[0].pending[0].raw='PENDING_SIGNED_RAW';privateData.coins[0].pending[0].error='PENDING_PRIVATE_ERROR';privateData.totals[0].secret='TOTAL_SECRET';
  const p=page({respond:async()=>privateData});await p.ui.load();await p.ui.element.querySelector('#admin-revenue-audit-download').onclick();assert.equal(p.downloads.length,1);const file=p.downloads[0],data=JSON.parse(file.contents);assert.equal(file.type,'application/json');assert.match(file.name,/^Launchpad-Revenue-Checks-\d{4}-\d{2}-\d{2}\.json$/);assert.equal(data.policy.recipient,wallet);assert.equal(data.coins[0].pending[0].signature,'1'.repeat(64));assert.equal(data.liveChainVerified,false);
  for(const secret of ['TOP_SECRET','SIGNED_RAW','secret-rpc','PASSWORD','TREASURY_SECRET','NESTED_SECRET','LAUNCH_SECRET','PENDING_PRIVATE_ERROR','TOTAL_SECRET'])assert(!file.contents.includes(secret));assert(!p.ui.element.textContent.includes('PRIVATE_ERROR'));p.ui.destroy();
});

test('malicious names and issue metadata stay inert and cannot change diagnostic trust labels',async()=>{
  const data={...structuredClone(result),liveChainVerified:true,evidence:'fully-audited',issues:[{code:'<img src=x onerror=alert(1)>',scope:'<script>bad()</script>'}]};data.coins[0].name='<img src=x onerror=alert(1)>';data.totals[0].symbol='<script>bad()</script>';
  const p=page({respond:async()=>data});await p.ui.load();assert.equal(p.ui.element.querySelector('img,script'),null);assert.match(p.ui.element.textContent,/<img src=x/);assert.match(p.ui.element.textContent,/needs review/);assert.match(p.ui.element.textContent,/On-chain verification: not performed/);assert.equal(safeRevenueAuditReport(data).liveChainVerified,false);p.ui.destroy();
});

test('unknown data does not become zero earnings or a verified all-clear',async()=>{
  const p=page({respond:async()=>({policy:{},treasury:{},summary:{},totals:[],coins:[],issues:[]})});await p.ui.load();assert.match(p.ui.element.textContent,/does not establish zero lifetime revenue/);assert.match(p.ui.element.textContent,/Raydium launch policies checked: Unavailable/);assert.match(p.ui.element.textContent,/has not been independently verified/);assert.match(p.ui.element.textContent,/Not configured/);assert(!p.ui.element.textContent.includes('All fees verified'));p.ui.destroy();
});

test('requires an active administrator with MFA and clears report after permission loss',async()=>{
  for(const account of [null,{role:'user',mfaEnabled:true},{role:'admin',mfaEnabled:false},{...admin,banned:true}]){const p=page({account});await p.ui.load();assert.equal(p.calls.length,0);assert.equal(p.ui.element.hidden,true);assert.equal(p.timers.size,0);p.ui.destroy();}
  const p=page();await p.ui.load();p.setAccount(null);await p.ui.element.querySelector('#admin-revenue-audit-download').onclick();assert.equal(p.downloads.length,0);assert.equal(p.ui.element.hidden,true);assert.equal(p.ui.element.querySelector('table'),null);assert.equal(p.timers.size,0);p.ui.destroy();
});

test('late response and download cannot cross an administrator account switch',async()=>{
  let resolve;const p=page({respond:()=>new Promise(done=>{resolve=done;})});const pending=p.ui.load();p.setAccount({...admin,id:'other'});resolve(result);await pending;assert.equal(p.ui.element.hidden,true);assert.equal(p.ui.element.querySelector('table'),null);assert.equal(p.timers.size,0);
  const next=p.ui.load();resolve(result);await next;p.setAccount(admin);await p.ui.element.querySelector('#admin-revenue-audit-download').onclick();assert.equal(p.downloads.length,0);assert.equal(p.ui.element.hidden,true);p.ui.destroy();
});

test('clear and destroy discard pending private responses without blocking the next request',async()=>{
  const resolvers=[];const p=page({respond:()=>new Promise(resolve=>resolvers.push(resolve))});const old=p.ui.load();p.ui.clear();const current=p.ui.load();assert.equal(resolvers.length,2);resolvers[0](result);await old;assert.equal(p.ui.element.querySelector('table'),null);resolvers[1](result);await current;assert(p.ui.element.querySelector('table'));p.ui.destroy();assert.equal(p.ui.element.querySelector('table'),null);assert.equal(p.timers.size,0);
});

test('visible-only refresh avoids overlap and preserves a labeled previous snapshot on failure',async()=>{
  let fail=false;const p=page({respond:async()=>{if(fail)throw Error('PRIVATE_BACKEND_ERROR');return result;}});await p.ui.load();p.visibility(true);assert.equal(p.timers.size,0);await p.ui.load();assert.equal(p.calls.length,1);p.visibility(false);await tick();assert.equal(p.calls.length,2);fail=true;await p.ui.load();assert.match(p.ui.element.textContent,/previous saved-record snapshot/);assert(!p.ui.element.textContent.includes('PRIVATE_BACKEND_ERROR'));assert(p.ui.element.querySelector('table'));p.ui.destroy();
  let resolve;const slow=page({respond:()=>new Promise(done=>{resolve=done;})});const loading=slow.ui.load();await slow.ui.load();assert.equal(slow.calls.length,1);resolve(result);await loading;slow.ui.destroy();
});

test('large reports display a bounded launch list while retaining every sanitized row in the download',async()=>{
  const data={...result,coins:Array.from({length:25},(_,index)=>({...result.coins[0],id:String(index)}))};const p=page({respond:async()=>data});await p.ui.load();assert.equal(p.ui.element.querySelectorAll('.admin-revenue-product').length,20);assert.match(p.ui.element.textContent,/Showing 20 of 25/);await p.ui.element.querySelector('#admin-revenue-audit-download').onclick();assert.equal(JSON.parse(p.downloads[0].contents).coins.length,25);p.ui.destroy();
});

test('download retains receipt signatures, destinations and tax basis while excluding nested private source fields',async()=>{
  const data=structuredClone(result);data.policy.creationFeeSol='0.023';data.transfers=[{signature:'2'.repeat(88),mint,amount:'23',recipient:wallet,sourceWallet:mint,decimals:9,symbol:'SOL',kind:'creation',currentRecipient:true,secret:'TRANSFER_SECRET',raw:'TRANSFER_RAW',data:'TRANSFER_DATA'}];data.coins[0].taxBps=500;data.coins[0].taxSourceBaseCredit='12345';data.coins[0].issues=['tax_conversion_pending'];
  const p=page({respond:async()=>data});await p.ui.load();assert.match(p.ui.element.textContent,/Creation fee: 0\.023 SOL/);assert.match(p.ui.element.textContent,/Collected tax awaiting conversion: 0\.012345 COIN/);assert.match(p.ui.element.textContent,/awaiting conversion before its protocol share is calculated/);
  await p.ui.element.querySelector('#admin-revenue-audit-download').onclick();const report=JSON.parse(p.downloads[0].contents);assert.deepEqual(report.transfers,[{signature:'2'.repeat(88),mint,amount:'23',recipient:wallet,sourceWallet:mint,decimals:9,symbol:'SOL',kind:'creation',currentRecipient:true}]);assert.equal(report.coins[0].taxBps,500);assert.equal(report.coins[0].taxSourceBaseCredit,'12345');assert.doesNotMatch(p.downloads[0].contents,/TRANSFER_(SECRET|RAW|DATA)/);p.ui.destroy();
});

test('unrepresentable dates and invalid creation fees cannot break render or report download',async()=>{
  const data=structuredClone(result);data.generatedAt=Number.MAX_SAFE_INTEGER;data.policy.creationFeeSol='PRIVATE_CONFIGURATION';data.coins[0].pending[0].createdAt=Number.MAX_SAFE_INTEGER;
  const p=page({respond:async()=>data});await p.ui.load();assert.match(p.ui.element.textContent,/Creation fee: Unavailable/);assert.doesNotMatch(p.ui.element.textContent,/PRIVATE_CONFIGURATION|Invalid Date/);await p.ui.element.querySelector('#admin-revenue-audit-download').onclick();assert.equal(p.downloads[0].name,'Launchpad-Revenue-Checks-snapshot.json');const report=JSON.parse(p.downloads[0].contents);assert.equal(report.generatedAt,null);assert.equal(report.coins[0].pending[0].createdAt,null);assert.equal(report.policy.creationFeeSol,null);p.ui.destroy();
});

test('revenue tab pause retains its snapshot and prevents polling while another section is active',async()=>{
  let active=false;const p=page({isActive:()=>active});await p.ui.load();assert.equal(p.calls.length,0);active=true;await p.ui.load();assert.equal(p.calls.length,1);assert.equal(p.timers.size,1);
  active=false;p.ui.pause();assert.equal(p.timers.size,0);assert(p.ui.element.querySelector('table'));p.visibility(true);p.visibility(false);await tick();await p.ui.load();assert.equal(p.calls.length,1);active=true;await p.ui.load();assert.equal(p.calls.length,2);assert.equal(p.timers.size,1);p.ui.destroy();
});
