import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {createCoinTrade,normalizeTradeAmount,rawTradeAmount,tradePreset,tradeSlippageBps} from '../public/coin-trade.mjs';
const MINT='So11111111111111111111111111111111111111112',MAIN='11111111111111111111111111111111',EXTERNAL='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',CASHBACK='58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',SIGNATURE='5'.repeat(88),NOW=1700000000000;
const flush=()=>new Promise(resolve=>setTimeout(resolve,0));
async function setup(t,{external='',authType='manual',respond,sign,session=true,features={walletOnly:false}}={}){
  const {document,window}=parseHTML('<html><body><section id="trade"></section></body></html>');
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return [...this.options].find(o=>o.selected)?.value||this.options[0]?.value||'';},set(value){for(const option of this.options)option.selected=option.value===String(value);}});
  let now=NOW,address=external,listener,signin=0,confirmed=0;const calls=[],signed=[],timers=[];
  const wallet={state:()=>({address,wallets:[{id:'phantom',name:'Phantom'}]}),onChange:fn=>{listener=fn;return()=>{listener=null;};},connect:async()=>{address=EXTERNAL;listener?.(wallet.state());return wallet.state();},sign:async pending=>{signed.push(pending);return sign?sign(pending):'signed-transaction';}};
  const env={setTimeout,clearTimeout,crypto:{randomUUID:()=> 'request-123456789012345'},location:{href:'https://launchpad.test/coin?mint='+MINT}};
  let lastQuote,lastTrade;
  const fetcher=async(path,options)=>{const body=options.body?JSON.parse(options.body):null;calls.push({path,options,body});let data=await respond?.(path,body,options);
    if(data===undefined){if(path.endsWith('/wallet'))data={wallet:{mode:body.mode,address:body.wallet||MAIN,available:authType!=='wallet'||body.mode==='external',requiresConnection:authType==='wallet'&&body.mode==='default',nativeBalanceLamports:'25123456789',baseBalanceRaw:'1234567890123456',baseDecimals:6,quoteBalanceRaw:'999',quoteDecimals:6}};
      else if(path.endsWith('/quote'))data={quote:lastQuote={id:'quote-one',mint:MINT,mode:body.mode,wallet:body.wallet||MAIN,side:body.side,amount:body.amount,inputSymbol:body.side==='buy'?'SOL':'DELTA',outputSymbol:body.side==='buy'?'DELTA':'SOL',expectedOutput:'123.45',minimumOutput:'122.21',networkFeeLamports:5000,rentLamports:4078560,slippageBps:body.slippageBps,expiresAt:now+30000}};
      else if(path.endsWith('/prepare'))data={trade:lastTrade={id:'trade-one',state:lastQuote.mode==='external'?'awaiting_signature':'prepared',quote:lastQuote,...(lastQuote.mode==='external'?{unsignedTransaction:'dGVzdA=='}:{})}};
      else if(path.endsWith('/submit'))data={trade:lastTrade={...lastTrade,state:'pending',signature:SIGNATURE}};
      else if(path.includes('/status'))data={trade:lastTrade?.state==='pending'?lastTrade:null};
      else if(path.endsWith('/cancel'))data={trade:lastTrade={...lastTrade,state:'cancelled'}};
      else throw Error('Unexpected request '+path);}
    if(data instanceof Error)throw data;return{ok:!data.status||data.status<400,status:data.status||200,json:async()=>data.status?{error:data.error}:data};};
  const app=createCoinTrade({document,window:env,root:document.getElementById('trade'),fetcher,clock:()=>now,random:()=>0,walletFactory:()=>wallet,onConfirmed:()=>{confirmed++;},openSignIn:()=>{signin++;},setTimer:fn=>{timers.push(fn);return timers.length;},clearTimer:()=>{}});t.after(()=>app.destroy());
  app.setCoin({mint:MINT,symbol:'DELTA',quote:{symbol:'AMD',mint:CASHBACK}});if(session)app.setSession({authenticated:true,token:'fresh-csrf',features,account:{id:'account-one',authType,mainWallet:MAIN,cashbackWallet:CASHBACK}});await flush();await flush();
  const root=document.getElementById('trade'),get=name=>root.querySelector('[data-ct-'+name+']');
  return{app,root,get,calls,signed,document,window,wallet,signin:()=>signin,confirmed:()=>confirmed,changeWallet(next){address=next;listener?.(wallet.state());},async review(amount='0.1'){get('amount').value=amount;await get('action').onclick();},async confirm(){await get('action').onclick();},async tick(ms){now+=ms;for(const fn of timers)fn();await flush();await flush();}};
}
test('raw balances and sell percentages retain integer precision',()=>{assert.equal(rawTradeAmount('25123456789',9),'25.123456789');assert.equal(rawTradeAmount('0',9),'0');assert.equal(tradePreset('12345678901234567890',9,25),'3086419725.308641972');assert.equal(tradePreset('10',6,100),'0.00001');assert.equal(rawTradeAmount('-1',6),null);});
test('trade amount normalization preserves exact positive decimals without accepting numeric coercions',()=>{
  for(const [input,expected] of [['.05','0.05'],['  .05  ','0.05'],['000.0500','0.0500'],['00001','1'],['9007199254740993.123456789','9007199254740993.123456789'],['.000000000000000001','0.000000000000000001']])assert.equal(normalizeTradeAmount(input),expected,input);
  for(const input of ['', ' ', '.', '0', '.0', '000.000', '-.05', '+.05', '1e-3', 'Infinity', 'NaN', '1,000', '0x10', '.0.5', '0. 5', '1.', '100000000000000000000', '.0000000000000000001', '.05'+'0'.repeat(50), 0.05, null])assert.equal(normalizeTradeAmount(input),null,String(input));
  assert.equal(normalizeTradeAmount('.000000001',9),'0.000000001');assert.equal(normalizeTradeAmount('.0000000001',9),null);
  assert.equal(normalizeTradeAmount('.000001',6),'0.000001');assert.equal(normalizeTradeAmount('.0000001',6),null);assert.equal(normalizeTradeAmount('1',0),'1');assert.equal(normalizeTradeAmount('1.1',0),null);
});
test('one Buy click normalizes .05, gets a quote and opens wallet approval without a review step',async t=>{
  const ui=await setup(t,{external:EXTERNAL,authType:'wallet',features:{walletOnly:true}});assert.equal(ui.get('action').textContent,'Buy');await ui.review('  .05  ');
  assert.equal(ui.get('amount').value,'0.05');assert.equal(ui.calls.find(call=>call.path.endsWith('/quote')).body.amount,'0.05');assert.equal(ui.get('pay').textContent,'0.05 SOL');assert.equal(ui.get('review').hidden,true);
  assert.equal(ui.signed.length,1);assert.equal(ui.calls.filter(call=>call.path.endsWith('/submit')).length,1);
});
test('sell accepts leading-dot amounts and uses the token decimal limit',async t=>{
  const ui=await setup(t,{external:EXTERNAL});ui.get('sell').onclick();await ui.review('.0000001');
  assert.equal(ui.calls.some(call=>call.path.endsWith('/quote')),false);assert.match(ui.get('status').textContent,/DELTA amounts support up to 6 decimal places/);
  await ui.review('.000001');const request=ui.calls.find(call=>call.path.endsWith('/quote'));assert.equal(request.body.side,'sell');assert.equal(request.body.amount,'0.000001');assert.equal(ui.get('pay').textContent,'0.000001 DELTA');assert.equal(ui.signed.length,1);assert.equal(ui.calls.filter(call=>call.path.endsWith('/submit')).length,1);assert.equal(ui.get('review').hidden,true);
});
test('invalid and excessive precision SOL inputs never request a quote or round the amount',async t=>{
  const ui=await setup(t,{external:EXTERNAL});
  for(const input of ['.0','-.05','1e-3','Infinity','.0.5','.0000000001','0.0500000000']){await ui.review(input);assert.equal(ui.calls.some(call=>call.path.endsWith('/quote')),false,input);assert.equal(ui.get('amount').value,input);assert.equal(ui.get('review').hidden,true);}
  assert.match(ui.get('status').textContent,/SOL amounts support up to 9 decimal places/);
  await ui.review('.000000001');assert.equal(ui.calls.find(call=>call.path.endsWith('/quote')).body.amount,'0.000000001');
});
test('guest stays on the coin and opens the existing same-page sign in',async t=>{const ui=await setup(t,{session:false});assert.equal(ui.calls.length,0);assert.match(ui.root.textContent,/Connect your wallet to trade/);assert.doesNotMatch(ui.root.textContent,/username|password/);await ui.get('action').onclick();assert.equal(ui.signin(),1);assert.equal(ui.root.querySelector('a[href^="/trade"]'),null);});
test('connected wallet takes precedence over account Main and cashback wallets',async t=>{const ui=await setup(t,{external:EXTERNAL});assert.equal(ui.calls[0].body.mode,'external');assert.equal(ui.calls[0].body.wallet,EXTERNAL);assert.match(ui.get('input-label').textContent,/SOL/);assert.match(ui.get('balance').textContent,/25\.123/);await ui.review();assert.equal(ui.calls.find(c=>c.path.endsWith('/quote')).body.wallet,EXTERNAL);assert.equal(ui.calls.filter(c=>c.path.endsWith('/prepare')).length,1);assert.equal(ui.signed.length,1);assert.equal(ui.signed[0].wallet,EXTERNAL);assert.equal(ui.calls.find(c=>c.path.endsWith('/submit')).body.signedTransaction,'signed-transaction');});
test('manual account without connected wallet trades from Main after explicit confirmation',async t=>{const ui=await setup(t);assert.equal(ui.calls[0].body.mode,'default');assert.equal(ui.calls[0].body.wallet,undefined);await ui.review();assert.equal(ui.calls.some(c=>c.path.endsWith('/submit')),false);assert.equal(ui.get('minimum').textContent,'122.21 DELTA');assert.match(ui.get('approval').textContent,/Main wallet/);assert.equal(ui.get('cost').textContent,'0.00408356 SOL');await ui.confirm();assert.equal(ui.signed.length,0);const submit=ui.calls.find(c=>c.path.endsWith('/submit'));assert.equal(submit.body.confirm,true);assert.equal(submit.body.signedTransaction,undefined);assert.equal(submit.options.headers['x-control-token'],'fresh-csrf');assert.equal(ui.get('action').disabled,true);});
test('wallet accounts without an extension connection must connect, never use hosted fallback',async t=>{const ui=await setup(t,{authType:'wallet'});assert.equal(ui.get('action').textContent,'Connect wallet');assert.equal(ui.calls.some(c=>c.path.endsWith('/quote')),false);await ui.get('action').onclick();await flush();assert.equal(ui.calls.at(-1).body.mode,'external');});
test('sell receives SOL and percentage controls use token balance without rounding up',async t=>{const ui=await setup(t);ui.get('sell').onclick();assert.match(ui.get('direction').textContent,/Receive SOL/);ui.root.querySelector('[data-ct-percent="25"]').onclick();assert.equal(ui.get('amount').value,'308641972.530864');await ui.get('action').onclick();assert.equal(ui.calls.find(c=>c.path.endsWith('/quote')).body.side,'sell');assert.equal(ui.get('minimum').textContent,'122.21 SOL');});
test('external wallet rejection cancels its prepared trade and never falls back to Main',async t=>{const ui=await setup(t,{external:EXTERNAL,sign:async()=>{throw Error('User rejected');}});await ui.review();await ui.tick(4000);assert.equal(ui.calls.filter(c=>c.path.endsWith('/cancel')).length,1);assert.equal(ui.calls.filter(c=>c.path.endsWith('/submit')).length,0);assert.match(ui.get('status').textContent,/Nothing was submitted/);assert.equal(ui.get('action').textContent,'Buy');assert.equal(ui.signed.length,1);assert.equal(ui.calls.filter(c=>c.path.endsWith('/quote')).length,1);});
test('changing wallet discards reviewed quote and ignores a late quote result',async t=>{let release;const ui=await setup(t,{external:EXTERNAL,respond:async(path,body)=>path.endsWith('/quote')?new Promise(resolve=>{release=()=>resolve({quote:{id:'old',mode:'external',wallet:EXTERNAL,side:'buy',amount:'1',expectedOutput:'2',minimumOutput:'1',expiresAt:NOW+30000}});}):undefined});const pending=ui.review();await flush();ui.changeWallet(MAIN);release();await pending;await flush();assert.equal(ui.get('review').hidden,true);assert.equal(ui.calls.some(c=>c.path.endsWith('/prepare')),false);});
test('quote expiration requires new review before confirming',async t=>{const ui=await setup(t);await ui.review();await ui.tick(31000);assert.equal(ui.get('review').hidden,true);assert.match(ui.get('status').textContent,/expired/);assert.equal(ui.calls.some(c=>c.path.endsWith('/prepare')),false);});
test('uncertain submission polls saved trade and does not repeat send',async t=>{let statusCount=0;const ui=await setup(t,{external:EXTERNAL,respond:async(path,body)=>{if(path.endsWith('/submit'))return Error('network dropped');if(path.endsWith('/status')&&body?.tradeId){statusCount++;return{trade:{id:'trade-one',state:'pending',signature:SIGNATURE}};}}});await ui.review();await ui.confirm();assert.equal(ui.calls.filter(c=>c.path.endsWith('/submit')).length,1);await ui.get('action').onclick();await ui.tick(1000);assert.equal(statusCount,1);await ui.tick(3000);assert.equal(statusCount,2);assert.equal(ui.calls.filter(c=>c.path.endsWith('/submit')).length,1);assert.equal(ui.get('receipt').href,'https://solscan.io/tx/'+SIGNATURE);});
test('confirmed receipt updates balances and chart only once',async t=>{let confirmed=false;const ui=await setup(t,{external:EXTERNAL,respond:async(path,body)=>path.endsWith('/status')&&body?.tradeId&&confirmed?{trade:{id:'trade-one',state:'confirmed',signature:SIGNATURE}}:undefined});await ui.review();await ui.confirm();confirmed=true;await ui.tick(3000);assert.equal(ui.confirmed(),1);assert.match(ui.get('status').textContent,/confirmed/);assert.equal(ui.get('amount').value,'');await ui.tick(3000);assert.equal(ui.confirmed(),1);});
test('pending receipt backoff follows the server hint and displays its saved outcome',async t=>{let checks=0;const ui=await setup(t,{external:EXTERNAL,respond:async(path,body)=>{if(path.endsWith('/status')&&body?.tradeId){checks++;return{trade:{id:'trade-one',state:'pending',signature:SIGNATURE,pollAfterMs:30000,error:'The exact receipt is still being recovered.'}};}}});await ui.review();await ui.confirm();await ui.tick(3000);assert.equal(checks,1);assert.match(ui.get('status').textContent,/exact receipt/);await ui.tick(10000);assert.equal(checks,1);await ui.tick(20000);assert.equal(checks,2);assert.equal(ui.calls.filter(call=>call.path.endsWith('/submit')).length,1);});
test('account change invalidates quote and rotates the CSRF used on later requests',async t=>{const ui=await setup(t);await ui.review();ui.document.dispatchEvent(new ui.window.CustomEvent('curve-account-updated',{detail:{authenticated:true,token:'new-csrf',features:{walletOnly:false},account:{id:'another-account',authType:'manual',mainWallet:MAIN}}}));await flush();assert.equal(ui.get('review').hidden,true);await ui.review();const call=ui.calls.filter(c=>c.path.endsWith('/quote')).at(-1);assert.equal(call.options.headers['x-control-token'],'new-csrf');});
test('unavailable SOL routes show the reason without offering a paired-asset trade',async t=>{const ui=await setup(t,{respond:path=>path.endsWith('/quote')?{status:409,error:'No verified SOL route is available for this pair.'}:undefined});await ui.review();assert.match(ui.get('status').textContent,/No verified SOL route/);assert.equal(ui.get('review').hidden,true);assert.equal(ui.calls.some(c=>c.path.endsWith('/prepare')),false);assert.match(ui.get('input-label').textContent,/SOL/);});

test('same-account session rotation discards quotes and ignores late old-session results',async t=>{let release;const ui=await setup(t,{respond:async(path,body)=>path.endsWith('/quote')?new Promise(resolve=>{release=()=>resolve({quote:{id:'old',mint:MINT,mode:'default',wallet:MAIN,side:'buy',amount:'1',expectedOutput:'2',minimumOutput:'1',expiresAt:NOW+30000}});}):undefined});const pending=ui.review();await flush();ui.app.setSession({authenticated:true,token:'rotated-csrf',features:{walletOnly:false},account:{id:'account-one',authType:'manual',mainWallet:MAIN}});release();await pending;await flush();assert.equal(ui.get('review').hidden,true);assert.equal(ui.get('action').textContent,'Review buy');assert.equal(ui.calls.some(c=>c.path.endsWith('/prepare')),false);});

test('wallet-only is the default even for an existing manual account and never queries its hosted wallet',async t=>{
  const ui=await setup(t,{features:{},sign:async()=>{throw Error('User rejected');}});assert.equal(ui.get('action').textContent,'Connect wallet');assert.equal(ui.get('form').hidden,true);assert.equal(ui.calls.some(call=>call.path.endsWith('/wallet')),false);assert.doesNotMatch(ui.root.textContent,/Main wallet|username|password/);
  await ui.get('action').onclick();await flush();await ui.review();assert.equal(ui.get('form').hidden,false);assert.equal(ui.calls.find(call=>call.path.endsWith('/quote')).body.wallet,EXTERNAL);assert(ui.calls.filter(call=>call.path.endsWith('/wallet')||call.path.endsWith('/quote')).every(call=>call.body.mode==='external'));
  ui.changeWallet('');await flush();assert.equal(ui.get('review').hidden,true);assert.equal(ui.get('action').textContent,'Connect wallet');assert.equal(ui.calls.some(call=>call.path.endsWith('/submit')),false);assert.equal(ui.calls.some(call=>call.body?.mode==='default'),false);
});

test('enabling wallet-only mode invalidates an existing hosted-wallet quote before preparation',async t=>{
  const ui=await setup(t);await ui.review();assert.equal(ui.get('review').hidden,false);
  ui.app.setSession({authenticated:true,token:'fresh-csrf',features:{walletOnly:true},account:{id:'account-one',authType:'manual',mainWallet:MAIN}});await flush();assert.equal(ui.get('review').hidden,true);assert.equal(ui.get('action').textContent,'Connect wallet');await ui.confirm();await flush();assert.equal(ui.calls.some(call=>call.path.endsWith('/prepare')||call.path.endsWith('/submit')),false);
});


test('one-click quote, prepare and wallet approval stay locked against duplicate clicks',async t=>{
  let releaseQuote,releasePrepare,releaseSign;
  const ui=await setup(t,{external:EXTERNAL,features:{walletOnly:true},respond:async path=>{
    if(path.endsWith('/quote'))await new Promise(resolve=>{releaseQuote=resolve;});
    if(path.endsWith('/prepare'))await new Promise(resolve=>{releasePrepare=resolve;});
  },sign:()=>new Promise(resolve=>{releaseSign=resolve;})});
  const pending=ui.review('.05');await flush();assert.equal(ui.get('action').textContent,'Getting quote…');assert.equal(ui.get('action').disabled,true);assert.equal(ui.get('amount').disabled,true);
  await ui.confirm();assert.equal(ui.calls.filter(call=>call.path.endsWith('/quote')).length,1);releaseQuote();await flush();
  assert.equal(ui.get('action').textContent,'Preparing trade…');assert.equal(ui.get('review').hidden,true);await ui.confirm();assert.equal(ui.calls.filter(call=>call.path.endsWith('/prepare')).length,1);releasePrepare();await flush();
  assert.equal(ui.get('action').textContent,'Approve in wallet…');assert.equal(ui.get('review').hidden,true);assert.equal(ui.get('cancel').hidden,true);assert.equal(ui.signed.length,1);assert.equal(ui.calls.some(call=>call.path.endsWith('/submit')),false);
  await ui.confirm();assert.equal(ui.signed.length,1);releaseSign('signed-transaction');await pending;
  assert.equal(ui.calls.filter(call=>call.path.endsWith('/submit')).length,1);assert.equal(ui.get('action').textContent,'Checking confirmation…');await ui.confirm();assert.equal(ui.calls.filter(call=>call.path.endsWith('/submit')).length,1);
});

test('one-click trading rejects a quote that changes the entered amount or selected slippage',async t=>{
  for(const changed of [{amount:'1'},{slippageBps:500}]){
    const ui=await setup(t,{external:EXTERNAL,respond:(path,body)=>path.endsWith('/quote')?{quote:{id:'changed',mint:MINT,mode:body.mode,wallet:body.wallet,side:body.side,amount:body.amount,slippageBps:body.slippageBps,expectedOutput:'2',minimumOutput:'1',expiresAt:NOW+30000,...changed}}:undefined});
    await ui.review('.05');assert.match(ui.get('status').textContent,/did not match your amount or slippage/);assert.equal(ui.calls.some(call=>call.path.endsWith('/prepare')),false);assert.equal(ui.signed.length,0);
  }
});

test('restored unsigned trade waits for a user click before reopening wallet approval',async t=>{
  const saved={id:'saved-trade',state:'awaiting_signature',unsignedTransaction:'dGVzdA==',quote:{id:'saved-quote',mint:MINT,mode:'external',wallet:EXTERNAL,side:'buy',amount:'0.05',slippageBps:100,inputSymbol:'SOL',outputSymbol:'DELTA',expectedOutput:'2',minimumOutput:'1',expiresAt:NOW+30000}};
  const ui=await setup(t,{external:EXTERNAL,features:{walletOnly:true},respond:path=>path.endsWith('/status')?{trade:saved}:path.endsWith('/submit')?{trade:{...saved,state:'pending',signature:SIGNATURE}}:undefined});
  assert.equal(ui.signed.length,0);assert.equal(ui.get('action').textContent,'Continue buy');assert.equal(ui.get('review').hidden,false);
  await ui.confirm();assert.equal(ui.signed.length,1);assert.equal(ui.calls.some(call=>call.path.endsWith('/quote')||call.path.endsWith('/prepare')),false);assert.equal(ui.calls.filter(call=>call.path.endsWith('/submit')).length,1);
});


test('custom percent parsing is exact to basis-point precision and does not coerce or clamp invalid values',()=>{
  for(const [text,bps] of [['0',0],['.01',1],['0.29',29],['1',100],['5.01',501],['25.37',2537],['99.99',9999],['100.00',10000]])assert.equal(tradeSlippageBps(text),bps,text);
  for(const value of ['', ' ', '.', '-1', '+1', '1e2', 'NaN', 'Infinity', '100.01', '101', '0.001', '1%', '1,5', 100, null])assert.equal(tradeSlippageBps(value),null,String(value));
});
for(const side of ['buy','sell'])for(const [percent,bps] of [['0',0],['.01',1],['25.37',2537],['100',10000]])test(`${side} uses the exact custom ${percent}% slippage through wallet approval`,async t=>{
  const ui=await setup(t,{external:EXTERNAL});if(side==='sell')ui.get('sell').onclick();
  ui.get('slippage').value=percent;ui.get('slippage').oninput();
  if(bps===10000){assert.equal(ui.get('slippage-note').hidden,false);assert.match(ui.get('slippage-note').textContent,/minimum received to 0/);}
  await ui.review('0.1');const request=ui.calls.find(call=>call.path.endsWith('/quote'));
  assert.equal(request.body.side,side);assert.equal(request.body.slippageBps,bps);assert.equal(ui.signed.length,1);assert.equal(ui.calls.filter(call=>call.path.endsWith('/submit')).length,1);assert.equal(ui.get('slippage').value,percent);
});
test('invalid custom slippage never requests a quote, signs, or silently changes the field',async t=>{
  const ui=await setup(t,{external:EXTERNAL});
  for(const value of ['', '-1', '100.01', '101', '0.001', '1e2', 'Infinity']){
    ui.get('slippage').value=value;ui.get('slippage').oninput();await ui.review();
    assert.equal(ui.calls.some(call=>call.path.endsWith('/quote')),false);assert.equal(ui.signed.length,0);assert.equal(ui.get('slippage').value,value);assert.match(ui.get('status').textContent,/0% to 100%/);
  }
});
test('editing custom slippage invalidates a reviewed quote before confirmation',async t=>{
  const ui=await setup(t);await ui.review();assert.equal(ui.get('review').hidden,false);
  ui.get('slippage').value='25.37';ui.get('slippage').oninput();assert.equal(ui.get('review').hidden,true);
  await ui.review();assert.deepEqual(ui.calls.filter(call=>call.path.endsWith('/quote')).map(call=>call.body.slippageBps),[100,2537]);assert.equal(ui.calls.some(call=>call.path.endsWith('/submit')),false);
});

test('restored custom-slippage trade shows its saved tolerance before another approval',async t=>{
  const saved={id:'saved-trade',state:'awaiting_signature',unsignedTransaction:'dGVzdA==',quote:{id:'saved-quote',mint:MINT,mode:'external',wallet:EXTERNAL,side:'buy',amount:'0.05',slippageBps:10000,inputSymbol:'SOL',outputSymbol:'DELTA',expectedOutput:'2',minimumOutput:'0',expiresAt:NOW+30000}};
  const ui=await setup(t,{external:EXTERNAL,respond:(path)=>path.endsWith('/status')?{trade:saved}:undefined});
  assert.equal(ui.get('slippage').value,'100');assert.equal(ui.get('slippage').disabled,true);assert.match(ui.get('slippage-note').textContent,/minimum received to 0/);assert.equal(ui.get('minimum').textContent,'0 DELTA');assert.equal(ui.signed.length,0);
});

test('a signed-in visitor without a wallet sees which wallet to connect, and the first connection is not reported as a change',async t=>{
  const ui=await setup(t,{authType:'wallet',features:{walletOnly:true}});
  assert.equal(ui.get('wallet-label').textContent,'Trading wallet');assert.equal(ui.get('wallet-address').textContent,'Connect a wallet');assert.notEqual(ui.get('wallet-address').textContent,'…');
  await ui.get('connect').onclick();await flush();await flush();
  assert.equal(ui.get('wallet-label').textContent,'Connected wallet');assert.equal(ui.get('wallet-address').textContent,EXTERNAL.slice(0,5)+'…'+EXTERNAL.slice(-5));assert.doesNotMatch(ui.get('status').textContent,/Wallet changed/);
  ui.changeWallet(CASHBACK);await flush();assert.match(ui.get('status').textContent,/Wallet changed/,'switching to another wallet still warns');
});
