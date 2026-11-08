import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Keypair } from '@solana/web3.js';
import { FundingService, fundingInput, equalFundingPercentages } from '../src/funding.mjs';
import { TelegramFunding } from '../src/telegram-funding.mjs';
const address=()=>Keypair.generate().publicKey.toBase58();
async function harness(t){const dir=await mkdtemp(join(tmpdir(),'launchpad-funding-')),books=new Map(),stores=new Map();t.after(()=>rm(dir,{recursive:true,force:true}));
  const storeFor=id=>{if(!stores.has(id))stores.set(id,{dir:join(dir,id),read:async(k,d)=>structuredClone(books.get(id+':'+k)??d),write:async(k,v)=>books.set(id+':'+k,structuredClone(v))});return stores.get(id);};
  const wallet=address(),other=address(),accounts={storeFor,hostStore:storeFor('host'),get:async id=>({mainWallet:id==='a'?wallet:other})},runtime={readSettings:async()=>({settings:{wallets:[]}})},calls=[];
  let remote,ambiguous=false,mutate=x=>x,clock=Date.now();
  const fetcher=async(url,opts)=>{const path=new URL(url).pathname,body=opts.body?JSON.parse(opts.body):undefined;calls.push({path,body});assert.equal(opts.headers['x-api-key'],'private-test-husher-key');
    let data;if(path.endsWith('/rate'))data={recipients:body.recipients.map(r=>({...r,success:true,rate:{sendAmount:String(body.totalAmount*r.percent/100),receiveAmount:String(body.totalAmount*r.percent/200)}}))};
    else if(path==='/api/v1/multi-exchange'&&body){remote={...body,totalAmount:body.totalAmount,multiExchangeOrderId:'order-12345',orderId:'short123',sendAddress:address(),status:'Pending',recipients:body.recipients.map(r=>({...r,recipientAddress:r.address,status:'Pending'}))};if(ambiguous)throw Error('transport timeout');data={multiExchangeOrderId:remote.multiExchangeOrderId,orderId:remote.orderId};}
    else if(path.includes('/external-user/'))data={orders:[{...remote,type:'multi'}]};
    else if(path.endsWith('/currencies'))data=[{network:'ETH',networkName:'Ethereum',chainId:1}];
    else if(path.endsWith('/providers'))data={providers:['husher']};
    else data=mutate(structuredClone(remote));return new Response(JSON.stringify({success:true,data}),{status:200});};
  const service=new FundingService(accounts,runtime,null,{fetcher,key:'private-test-husher-key',now:()=>clock});
  const input={chain:'solana',send:'SOL',sendNetwork:'SOL',totalAmount:'0.2',recipients:[{address:wallet,percent:100,provider:'husher'}]};
  return{service,accounts,input,calls,wallet,other,books,set ambiguous(v){ambiguous=v;},set mutate(v){mutate=v;},advance(ms){clock+=ms;}};
}
test('funding allocations are exact for 20 and 99 wallets; Solana addresses are case-sensitive',()=>{
  for(const n of [1,20,99,100])assert.equal(equalFundingPercentages(n).reduce((s,x)=>s+Math.round(x*100),0),10000);
  const w={chain:'solana',address:address(),label:'one'},raw={chain:'solana',send:'SOL',sendNetwork:'SOL',totalAmount:'1',recipients:[{address:w.address,percent:100,provider:'husher'}]};
  assert.equal(fundingInput(raw,[w],'SOL').receive,'SOL');assert.throws(()=>fundingInput({...raw,recipients:[{...raw.recipients[0],address:w.address.toLowerCase()}]},[w],'SOL'),/not in/);
  assert.throws(()=>fundingInput({...raw,recipients:[...raw.recipients,...raw.recipients]},[w],'SOL'),/only once/);
  assert.throws(()=>fundingInput({...raw,recipients:[{...raw.recipients[0],percent:99}]},[w],'SOL'),/100%/);
});
test('quote → confirmed order exposes only verified deposit; duplicate clicks create once and another account cannot access it',async t=>{
  const h=await harness(t),quote=await h.service.quote('a',h.input);assert.equal(quote.state,'quoted');assert(!quote.externalUserId);assert(!quote.deposit);
  const [a,b]=await Promise.all([h.service.create('a',quote.id,quote.reviewHash),h.service.create('a',quote.id,quote.reviewHash)]);
  assert.equal(a.deposit.address,b.deposit.address);assert.equal(h.calls.filter(c=>c.path==='/api/v1/multi-exchange').length,1);assert.equal(a.deposit.amount,.2);
  await assert.rejects(h.service.refresh('b',quote.id),/not found/);assert(!JSON.stringify(await h.service.overview('a')).includes('private-test-husher-key'));
});
test('ambiguous provider response recovers the original order without a second create',async t=>{
  const h=await harness(t);h.ambiguous=true;const q=await h.service.quote('a',h.input),o=await h.service.create('a',q.id,q.reviewHash);assert.equal(o.state,'unresolved');assert(!o.deposit);
  await h.service.create('a',q.id,q.reviewHash);const recovered=await h.service.refresh('a',q.id);assert(recovered.deposit.address);assert.equal(h.calls.filter(c=>c.path==='/api/v1/multi-exchange').length,1);
});
test('expiry, removed ownership, deposit amount/network/address mismatches fail closed',async t=>{
  const h=await harness(t),q=await h.service.quote('a',h.input);h.advance(120001);await assert.rejects(h.service.create('a',q.id,q.reviewHash),/expired/);
  const fresh=await h.service.quote('a',h.input);h.accounts.get=async()=>({mainWallet:h.other});await assert.rejects(h.service.create('a',fresh.id,fresh.reviewHash),/not in/);h.accounts.get=async()=>({mainWallet:h.wallet});
  await h.service.create('a',fresh.id,fresh.reviewHash);
  for(const mutate of [x=>({...x,totalAmount:4}),x=>({...x,receiveNetwork:'ETH'}),x=>({...x,recipients:x.recipients.map(r=>({...r,recipientAddress:h.other}))})]){h.mutate=mutate;await assert.rejects(h.service.refresh('a',fresh.id));const v=await h.service.overview('a');assert(!v.orders.find(o=>o.id===fresh.id).deposit);}
});
test('Ethereum ETH is never silently treated as Robinhood ETH',async t=>{const h=await harness(t);await assert.rejects(h.service.destination('robinhood'),/does not advertise/);});
test('Telegram funding uses the same quote and confirmation service and rejects expired input',async t=>{
  const h=await harness(t),sent=[],bot={accounts:h.accounts,now:Date.now,button:(c,text,op,args)=>({text,op,args}),homeButton:()=>({text:'Home'}),say:(c,text,buttons)=>sent.push({text,buttons}),deleteInput:async()=>{}},menu=new TelegramFunding(bot,h.service),ctx={account:{id:'a'},chain:'solana',navigation:0,revision:1};
  await menu.action(ctx,'fundingNew',{});await menu.action(ctx,'fundingAll',{});await menu.action(ctx,'fundingInput',{});await menu.action(ctx,'fundingAsset',{stage:'send',token:'SOL'});await menu.action(ctx,'fundingAsset',{stage:'receive',token:'SOL'});await menu.message(ctx,{text:'0.2'});
  const button=sent.at(-1).buttons[0][0];assert.equal(button.op,'fundingConfirm');await menu.action(ctx,button.op,button.args);assert.match(sent.at(-1).text,/Deposit 0.2 SOL on SOL ONLY/);
  ctx.fundingDraft.expires=0;await assert.rejects(menu.message(ctx,{text:'SOL SOL 0.2 husher'}),/expired/);
});
test('large Telegram funding orders keep the deposit and memo visible and paginate all recipients',async()=>{
  const sent=[],bot={button:(c,text,op,args)=>({text,op,args}),say:(c,text,buttons)=>sent.push({text,buttons})},menu=new TelegramFunding(bot,{}),ctx={navigation:0};
  const o={id:'id',state:'Pending',input:{totalAmount:100,send:'USDC',sendNetwork:'ETH',receive:'SOL',receiveNetwork:'SOL'},deposit:{amount:100,token:'USDC',network:'ETH',address:'0x'+'1'.repeat(40),tag:'RequiredMemo',feeAmount:'1',networkFee:'.1'},quotes:Array.from({length:100},()=>({address:address(),percent:1,receiveAmount:'.00000001',provider:'husher'}))};
  await menu.review(ctx,o);assert(sent.at(-1).text.length<3900);assert.match(sent.at(-1).text,/Required memo \/ tag: RequiredMemo/);assert.match(sent.at(-1).text,/Wallets 1–20 of 100/);assert(sent.at(-1).buttons.flat().some(x=>x.args?.page===1));
  await menu.review(ctx,o,4);assert.match(sent.at(-1).text,/Wallets 81–100 of 100/);assert(!sent.at(-1).buttons.flat().some(x=>x.args?.page===5));
});
test('amount and random allocations keep reviewed totals and reject unsupported assets or cross-chain funding',async t=>{
  const h=await harness(t),base={...h.input,allocationMode:'amount',totalAmount:'999',recipients:[{address:h.wallet,provider:'husher',amount:'0.015'}]};
  const quoted=await h.service.quote('a',base);assert.equal(quoted.input.totalAmount,.015);assert.equal(quoted.input.recipients[0].amount,'0.015');
  const random=await h.service.quote('a',{...h.input,allocationMode:'random',randomMin:'0.01',randomMax:'0.02'}),snapshot=JSON.stringify(random.input.recipients);
  assert(random.input.totalAmount>=.01&&random.input.totalAmount<=.02);await h.service.create('a',random.id,random.reviewHash);const order=(await h.service.overview('a')).orders.find(x=>x.id===random.id);assert.equal(JSON.stringify(order.input.recipients),snapshot);
  const submitted=h.calls.findLast(c=>c.path==='/api/v1/multi-exchange').body;assert.equal(submitted.allocationMode,undefined);assert.equal(submitted.recipients[0].amount,undefined);
  for(const patch of [{send:'ETH'},{send:'USDC',sendNetwork:'ETH'},{receive:'USDG'}])await assert.rejects(h.service.quote('a',{...h.input,...patch}));
  const stable=await h.service.quote('a',{...h.input,send:'USDC',receive:'USDC'});assert.equal(stable.input.receive,'USDC');
});
test('random allocation supports 100 wallets without zero weights and exact token amounts survive conversion',async()=>{
  const {fundingAllocations}=await import('../src/funding-allocation.mjs');
  for(const n of [1,3,20,99,100]){const raw={allocationMode:'random',randomMin:'0.01',randomMax:'0.05',recipients:Array.from({length:n},()=>({}))},r=fundingAllocations(raw);
    assert.equal(r.recipients.reduce((sum,x)=>sum+BigInt(Math.round(x.percent*1e11)),0n),10000000000000n);
    assert(r.recipients.every(x=>Number(x.amount)>=.01&&Number(x.amount)<=.05&&x.percent>0));
    const exact=fundingAllocations({allocationMode:'amount',recipients:r.recipients});assert.equal(exact.totalAmount,r.totalAmount);assert.deepEqual(exact.recipients.map(x=>x.amount),r.recipients.map(x=>x.amount));
  }
  for(const [min,max]of [['0','.1'],['0.2','0.1'],['-1','2']])assert.throws(()=>fundingAllocations({allocationMode:'random',randomMin:min,randomMax:max,recipients:[{}]}));
});
test('Telegram funding buttons enforce chain assets and numeric-only amount entry',async t=>{
  const h=await harness(t),sent=[],bot={accounts:h.accounts,now:Date.now,button:(c,text,op,args)=>({text,op,args}),homeButton:()=>({text:'Home'}),say:(c,text,buttons)=>sent.push({text,buttons}),deleteInput:async()=>{}},menu=new TelegramFunding(bot,h.service),ctx={account:{id:'a'},chain:'solana',navigation:0,revision:1};
  await menu.action(ctx,'fundingNew');await menu.action(ctx,'fundingAll');await menu.action(ctx,'fundingInput',{mode:'random'});
  assert.deepEqual(sent.at(-1).buttons[0].map(b=>b.text),['SOL','USDC']);await assert.rejects(menu.action(ctx,'fundingAsset',{stage:'send',token:'ETH'}),/displayed assets/);
  await menu.action(ctx,'fundingAsset',{stage:'send',token:'USDC'});await menu.action(ctx,'fundingAsset',{stage:'receive',token:'SOL'});assert(!sent.at(-1).text.includes('TOKEN NETWORK'));assert.match(sent.at(-1).text,/minimum and maximum USDC/);
  await menu.message(ctx,{text:'1 2'});assert.equal(sent.at(-1).buttons[0][0].op,'fundingConfirm');
  ctx.chain='robinhood';assert.deepEqual(menu.tokens(ctx.chain),['ETH','USDG']);await assert.rejects(menu.message(ctx,{text:'1 2'}),/expired/);
});

test('Funding lists the selected cashback destination without relabeling the login wallet as its recipient',async t=>{
  const h=await harness(t),cashback=address();h.accounts.get=async()=>({mainWallet:h.wallet,cashbackWallet:cashback});
  const rows=await h.service.wallets('a');assert(rows.some(r=>r.tool==='cashback'&&r.address===cashback));assert(!rows.some(r=>r.tool==='cashback'&&r.address===h.wallet));assert.equal(h.calls.length,0);
});
