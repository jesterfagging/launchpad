import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, http, parseEther, decodeFunctionData, encodeFunctionData, getAddress } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import solc from 'solc';
import { CONTRACTS, EVM_NATIVE, ROBINHOOD_CHAIN } from '../src/robinhood-contracts.mjs';
import { adapterAbi } from '../src/robinhood-legacy-contracts.mjs';
import { executorArtifact } from '../src/robinhood-deployment.mjs';
import { buildEthTradePlan, ethExecution, ethFundingPath } from '../src/robinhood-eth-trades.mjs';
import { RobinhoodEngine } from '../src/robinhood-engine.mjs';
import { RobinhoodExecutor } from '../src/robinhood-executor.mjs';
import { verifyEvmFee } from '../src/robinhood-cashback.mjs';

const pair = (a, b, protocol = 'v3') => { const [currency0, currency1] = [a,b].sort((a,b) => BigInt(a)<BigInt(b)?-1:1); return { protocol, currency0, currency1, fee: 3000, tickSpacing: 60, hooks: EVM_NATIVE }; };
test('ETH routing is address-based across 100 different stocks, arbitrary decimals and observed bridge tokens', async () => {
  for (let i=1; i<=100; i++) {
    const stock=getAddress(`0x${(i+100).toString(16).padStart(40,'0')}`), bridge=getAddress(`0x${(i+1000).toString(16).padStart(40,'0')}`);
    const a=pair(CONTRACTS.weth,bridge), b=pair(bridge,stock,'v2');
    const pools={ cache:new Map([[1,b],[2,a]]), validate:async p=>p, find:async()=>{throw Error('No direct pool');} };
    const route=await ethFundingPath(pools,stock);
    assert.deepEqual(route.map(h=>h.input),[CONTRACTS.weth,bridge]); assert.equal(route[1].output,stock);
  }
  const asset='0x1111111111111111111111111111111111111111';
  await assert.rejects(ethFundingPath({ cache:new Map(), find:async()=>{throw Error('No route');} },asset),/No liquid ETH trading route/);
});

test('ETH routes discover stock → USDG → ETH automatically from an empty cache', async () => {
  const stock='0x329fcACEb9AD6F9580DD5F643fed0646900D043c', a=pair(stock,CONTRACTS.usdg), b=pair(CONTRACTS.usdg,CONTRACTS.weth);
  const calls=[];
  const pools={cache:new Map(),validate:async p=>p,find:async(x,y)=>{calls.push([x,y]);if(x===stock&&y===CONTRACTS.usdg)return a;if(x===CONTRACTS.usdg&&y===EVM_NATIVE)return b;throw Error('No direct pool');}};
  const path=await ethFundingPath(pools,stock);
  assert.deepEqual(path.map(h=>[h.input,h.output]),[[CONTRACTS.weth,CONTRACTS.usdg],[CONTRACTS.usdg,stock]]);
  assert(calls.some(([x,y])=>x===stock&&y===CONTRACTS.usdg));
  await assert.rejects(ethFundingPath(pools,stock,{avoid:CONTRACTS.usdg}),/No liquid ETH/);
});

test('local EVM: ETH-only wallets execute stock-quoted Pons and Uniswap routes atomically', { timeout:120000 }, async t => {
  const listener=createServer(); await new Promise(r=>listener.listen(0,'127.0.0.1',r)); const port=listener.address().port; await new Promise(r=>listener.close(r));
  const node=spawn(new URL('../node_modules/.bin/anvil',import.meta.url).pathname,['--host','127.0.0.1','--port',String(port),'--chain-id','4663'],{stdio:['ignore','pipe','pipe']}); t.after(()=>node.kill('SIGTERM'));
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Local EVM did not start')),12000); const ready=data=>{if(String(data).includes('Listening on')){clearTimeout(timer);resolve();}};node.stdout.on('data',ready);node.stderr.on('data',ready);node.once('error',reject);});
  // Public Anvil fixture key. This test never connects to an external RPC.
  const key='0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', account=privateKeyToAccount(key);
  const transport=http(`http://127.0.0.1:${port}`), client=createPublicClient({chain:ROBINHOOD_CHAIN,transport}), wallet=createWalletClient({account,chain:ROBINHOOD_CHAIN,transport});
  const source=await readFile(new URL('../contracts/RobinhoodExecutor.sol',import.meta.url),'utf8'), harness=await readFile(new URL('fixtures/RobinhoodEthRouteHarness.sol',import.meta.url),'utf8');
  const built=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources:{'RobinhoodExecutor.sol':{content:source},'Harness.sol':{content:harness}},settings:{viaIR:true,optimizer:{enabled:true,runs:200},evmVersion:'cancun',outputSelection:{'*':{'*':['abi','evm.bytecode.object']}}}})));
  assert(!built.errors?.some(e=>e.severity==='error'),built.errors?.map(e=>e.formattedMessage).join('\n'));
  const write=async(c,name,args=[],value=0n)=>{const hash=await wallet.writeContract({...c,functionName:name,args,value}); const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');return receipt;};
  const read=(c,name,args=[])=>client.readContract({...c,functionName:name,args});
  const deploy=async(name,args=[])=>{const c=built.contracts['Harness.sol'][name];const hash=await wallet.deployContract({abi:c.abi,bytecode:`0x${c.evm.bytecode.object}`,args});const receipt=await client.waitForTransactionReceipt({hash}); assert.equal(receipt.status,'success');return{address:getAddress(receipt.contractAddress),abi:c.abi};};
  const etch=async(name,address)=>{const c=await deploy(name);await client.request({method:'anvil_setCode',params:[address,await client.getCode({address:c.address})]});return{...c,address};};
  const weth=await etch('EthWeth',CONTRACTS.weth), permit=await etch('EthPermit',CONTRACTS.permit2), router=await etch('EthRouter',CONTRACTS.router), factory=await deploy('EthFactory');
  for(const address of [weth.address,router.address])await client.request({method:'anvil_setBalance',params:[address,`0x${parseEther('1000').toString(16)}`]});
  const artifact=await executorArtifact(), deployHash=await wallet.deployContract({abi:artifact.abi,bytecode:artifact.bytecode,args:[factory.address,factory.address,factory.address]});
  const adapter=getAddress((await client.waitForTransactionReceipt({hash:deployHash})).contractAddress), collector='0x3333333333333333333333333333333333333333';
  const rates=new Map(), scales=new Map(), cache=new Map();
  const rate=async(a,b,n,d,spend=10000n,failing=false)=>{rates.set(`${a}:${b}`,[n,d]);await write(router,'configure',[a,b,n,d,spend,failing]);};
  const pools={cache,validate:async p=>p,find:async(a,b)=>{const p=[...cache.values()].find(p=>[p.currency0,p.currency1].includes(a)&&(!b||[p.currency0,p.currency1].includes(b===EVM_NATIVE?CONTRACTS.weth:b)));if(!p)throw Error('No pool');return p;},quote:async(p,input,n)=>{if(p.protocol==='pons-curve')return input===p.quote?n*scales.get(p.token):n/scales.get(p.token);const output=p.currency0===input?p.currency1:p.currency0;const [a,b]=rates.get(`${input}:${output}`)||[];if(!a)throw Error('No quote');return n*a/b;}};
  const makeMarket=async(decimals=18,protocol='v3',via=false)=>{
    const coin=await deploy('EthCoin',[18]), stock=await deploy('EthCoin',[decimals]), scale=10n**BigInt(18-decimals)*4n;
    const curve=await deploy('EthCurve',[factory.address,coin.address,stock.address,scale]);await write(factory,'set',[coin.address,curve.address,stock.address,0]);scales.set(coin.address,scale);
    const market={...pair(coin.address,stock.address),protocol:'pons-curve',token:coin.address,quote:stock.address,address:curve.address};cache.set(coin.address,market);
    let bridge;
    if(via){bridge=await deploy('EthCoin',[18]);cache.set(bridge.address,pair(CONTRACTS.weth,bridge.address,'v2'));await rate(CONTRACTS.weth,bridge.address,2n,1n);await rate(bridge.address,CONTRACTS.weth,1n,2n);}
    const base=bridge?.address||CONTRACTS.weth;cache.set(stock.address,pair(base,stock.address,protocol));
    const denom=10n**BigInt(18-decimals);await rate(base,stock.address,100n,denom);await rate(stock.address,base,denom,100n);
    return{coin,stock,curve,market,bridge};
  };
  const opts=(m,buy,amount,who=account.address,ppm=2500)=>({pools,pool:m.market,token:m.coin.address,buy,amount,wallet:who,recipient:collector,adapter,ppm,slippageBps:200});
  const execute=async plan=>{for(const requirement of plan.approvals)await write({address:requirement.token,abi:built.contracts['Harness.sol'].EthCoin.abi},'approve',[adapter,BigInt(requirement.amount)]); const hash=await wallet.sendTransaction({to:plan.to,data:plan.data,value:plan.value});const receipt=await client.waitForTransactionReceipt({hash});assert.equal(receipt.status,'success');const tx={to:adapter,from:account.address,input:plan.data,value:plan.value};return{receipt,event:ethExecution(tx,receipt)};};
  const markets=[];
  for(const [decimals,protocol,via] of [[18,'v3',false],[6,'v2',false],[18,'v4',true]]){
    await t.test(`${decimals}-decimal quote, ${protocol}${via?' with an ERC20 bridge':''}: buy token with ETH then sell back to ETH`,async()=>{
      const m=await makeMarket(decimals,protocol,via);markets.push(m);
      const amount=parseEther('0.01'),beforeFee=await client.getBalance({address:collector});
      assert.equal(await read(m.stock,'balanceOf',[account.address]),0n);
      const buy=await buildEthTradePlan(opts(m,true,amount)), bought=await execute(buy);
      assert.equal(buy.value,amount);assert.equal(buy.approvals.length,0);assert.equal(bought.event.inputSpent,amount);assert.equal(bought.event.output,await read(m.coin,'balanceOf',[account.address]));
      assert.equal(await read(m.stock,'balanceOf',[account.address]),0n);assert.equal(await read(m.stock,'balanceOf',[adapter]),0n);
      assert.equal(await read(weth,'balanceOf',[adapter]),0n);assert.equal(await client.getBalance({address:adapter}),0n);
      const sell=await buildEthTradePlan(opts(m,false,bought.event.output)), sold=await execute(sell);
      assert.equal(sell.value,0n);assert(sold.event.output>0n);assert.equal(await read(m.coin,'balanceOf',[account.address]),0n);
      assert.equal(await read(m.stock,'balanceOf',[account.address]),0n);assert.equal(await read(m.stock,'balanceOf',[adapter]),0n);
      assert.equal(await read(weth,'balanceOf',[adapter]),0n);assert.equal(await read(m.stock,'allowance',[adapter,CONTRACTS.permit2]),0n);
      assert.equal((await read(permit,'allowance',[adapter,m.stock.address,CONTRACTS.router]))[0],0n);
      assert.equal(await client.getBalance({address:collector}),beforeFee+bought.event.feeEth+sold.event.feeEth);
    });
  }
  await t.test('failed curve or conversion and a clamped fill roll back every hop and the fee',async()=>{
    const m=markets[0], plan=await buildEthTradePlan(opts(m,true,parseEther('0.01'))), feeBefore=await client.getBalance({address:collector}), stockBefore=await read(m.stock,'balanceOf',[router.address]);
    for(const [fail,partial]of[[true,false],[false,true]]){
      await write(m.curve,'configure',[fail,partial]);
      const decoded=decodeFunctionData({abi:adapterAbi,data:plan.data});
      if(partial)decoded.args[0].minimum=1n; // Exercise full-input protection even when the token minimum could pass.
      const data=encodeFunctionData({abi:adapterAbi,functionName:'tradeEth',args:decoded.args});
      await assert.rejects(client.call({account:account.address,to:adapter,data,value:plan.value}));
      const hash=await wallet.sendTransaction({to:adapter,data,value:plan.value,gas:5000000n});
      assert.equal((await client.waitForTransactionReceipt({hash})).status,'reverted');
      assert.equal(await read(m.stock,'balanceOf',[router.address]),stockBefore);assert.equal(await read(m.coin,'balanceOf',[account.address]),0n);assert.equal(await client.getBalance({address:collector}),feeBefore);
    }
    await write(m.curve,'configure',[false,false]);await rate(CONTRACTS.weth,m.stock.address,100n,1n,10000n,true);
    await assert.rejects(client.call({account:account.address,to:adapter,data:plan.data,value:plan.value}));
    await rate(CONTRACTS.weth,m.stock.address,100n,1n);
  });
  await t.test('graduated stock-quoted v4, v3 and v2 markets use the same ETH flow',async()=>{
    for(const protocol of ['v4','v3','v2']){
      const m=markets[0], market=pair(m.coin.address,m.stock.address,protocol), amount=parseEther('0.01');
      await rate(m.stock.address,m.coin.address,4n,1n);await rate(m.coin.address,m.stock.address,1n,4n);
      const buy=await buildEthTradePlan({...opts(m,true,amount),pool:market});const bought=await execute(buy);
      const sell=await buildEthTradePlan({...opts(m,false,bought.event.output),pool:market});const sold=await execute(sell);
      assert(sold.event.output>0n);assert.equal(await read(m.coin,'balanceOf',[account.address]),0n);assert.equal(await read(m.stock,'balanceOf',[account.address]),0n);
    }
  });
  await t.test('native ETH pools and curves do not require a wrapped or stock balance',async()=>{
    const coin=await deploy('EthCoin',[18]), curve=await deploy('EthCurve',[factory.address,coin.address,EVM_NATIVE,4n]);scales.set(coin.address,4n);await write(factory,'set',[coin.address,curve.address,EVM_NATIVE,0]);
    for(const protocol of ['pons-curve','v4']){
      const market={...pair(EVM_NATIVE,coin.address,'v4'),protocol,token:coin.address,quote:EVM_NATIVE,address:curve.address}, m={coin,market};
      await rate(EVM_NATIVE,coin.address,4n,1n);await rate(coin.address,EVM_NATIVE,1n,4n);
      const bought=await execute(await buildEthTradePlan(opts(m,true,parseEther('0.01'))));
      const sold=await execute(await buildEthTradePlan(opts(m,false,bought.event.output)));
      assert(sold.event.output>0n);assert.equal(await client.getBalance({address:adapter}),0n);
    }
  });
  await t.test('production engine executes three ETH-only followers and closes all positions with verified fees',async()=>{
    const m=markets[1], config={wallets:[],maxGasGwei:'10',priorityGwei:'0',reserveEth:'0.003',slippageBps:200,maxSignalAgeMs:120000};
    for(let i=0;i<3;i++){const privateKey=generatePrivateKey(), a=privateKeyToAccount(privateKey);config.wallets.push({privateKey,publicKey:a.address,label:`Follower ${i+1}`});await client.request({method:'anvil_setBalance',params:[a.address,`0x${parseEther('1').toString(16)}`]});}
    const ledger={data:{lots:[],pending:[],seen:[],events:[],feeReceipts:[]},async save(){},async remember(id){this.data.seen.push(id);},addEvent(e){this.data.events.push(e);}};
    const policy={adapter,recipient:collector,copyPpm:2500,sniperPpm:10000,cashbackBps:500,mainWallet:collector,accountId:'test',version:'eth-v2'};
    const rpc={client,config,request:args=>client.request(args),balance:(address,token)=>token===EVM_NATIVE?client.getBalance({address}):read({address:token,abi:m.coin.abi},'balanceOf',[address]),token:async address=>({address,decimals:address===m.stock.address?6:18,symbol:address===EVM_NATIVE?'ETH':'COIN'})};
    const engine=new RobinhoodEngine(ledger,policy,'copy');t.after(()=>clearInterval(engine.reconcileTimer));
    Object.assign(engine,{rpc,pools,config,tool:{amountMode:'fixed',buyAmount:'0.01',budget:'0.03',feePool:null},state:'running',abort:new AbortController()});
    engine.executor=new RobinhoodExecutor(rpc,ledger,{policy,signal:engine.abort.signal,confirmed:(p,r)=>engine.confirmed(p,r),event:(l,m,d)=>engine.event(l,m,d)});
    engine.buySignal({token:m.coin.address,quote:m.stock.address,pool:m.market,lead:account.address,signature:`0x${'12'.repeat(32)}`,at:Date.now()});await Promise.allSettled([...engine.tasks]);
    assert.equal(ledger.data.lots.length,3,JSON.stringify(ledger.data.events));assert.equal(ledger.data.pending.length,0);
    assert(ledger.data.lots.every(l=>l.costCurrency===EVM_NATIVE&&l.cost===String(parseEther('0.01'))&&l.quoteDecimals===18&&l.quote===m.stock.address));
    ledger.data.copySells=config.wallets.map((w,i)=>({id:`exit-${i}`,wallet:w.publicKey,lead:account.address,token:m.coin.address,quote:m.stock.address,pool:m.market,numerator:'1',denominator:'1',sequence:2,signal:'lead-sell',attempts:0}));engine.dispatchCopySells();await Promise.allSettled([...engine.tasks]);
    assert(ledger.data.lots.every(l=>l.remaining==='0'),JSON.stringify(ledger.data.events));assert.equal(ledger.data.copySells.length,0);assert.equal(ledger.data.feeReceipts.length,6);
    const timings=engine.metrics.executions; assert.equal(timings.length,6); assert.equal(timings.filter(t=>t.side==='buy').length,3); assert.equal(timings.filter(t=>t.side==='sell').length,3);
    assert(timings.every(t=>t.acceptedAt && t.confirmedAt >= t.acceptedAt && t.simulationMs >= 0 && t.routeMs >= 0)); assert(engine.metrics.detectionToSendMs>=0); assert(engine.metrics.confirmationMs>=0);
    for(const fee of ledger.data.feeReceipts){const tx=await client.getTransaction({hash:fee.signature}), mined=await client.getTransactionReceipt({hash:fee.signature});assert.equal(verifyEvmFee(fee,tx,mined,collector,adapter).amount,fee.amount);}
    for(const w of config.wallets){assert.equal(await read(m.stock,'balanceOf',[w.publicKey]),0n);assert.equal(await read(weth,'balanceOf',[w.publicKey]),0n);}
    const raw={...config,agreedFeeVersion:policy.version}, selected=[config.wallets[0].publicKey];
    await engine.manualTrade(raw,{id:'manual-buy',side:'buy',token:m.coin.address,amount:'0.01',wallets:selected});
    assert.equal(engine.manualResult.results[0].state,'confirmed',JSON.stringify(engine.manualResult));
    assert.equal(ledger.data.lots.at(-1).cost,String(parseEther('0.01')));
    await engine.manualTrade(raw,{id:'manual-sell',side:'sell',token:m.coin.address,percent:100,wallets:selected});
    assert.equal(engine.manualResult.results[0].state,'confirmed',JSON.stringify(engine.manualResult));
    assert(ledger.data.lots.every(l=>l.remaining==='0'));assert.equal(ledger.data.feeReceipts.length,8);
    engine.tool.budget='0.005';
    await assert.rejects(engine.swap(config.wallets[0],m.market,EVM_NATIVE,parseEther('0.01'),{side:'buy',token:m.coin.address,quote:m.stock.address}),/ETH run budget/);
  });
  await t.test('Market Making runs five ETH-only wallets, sells to ETH, and never exceeds its managed budget',async()=>{
    const m=markets[1], config={wallets:[],maxGasGwei:'10',priorityGwei:'0',reserveEth:'0.003',slippageBps:200,maxSignalAgeMs:120000};
    for(let i=0;i<5;i++){const privateKey=generatePrivateKey(), a=privateKeyToAccount(privateKey);config.wallets.push({privateKey,publicKey:a.address,label:`MM ${i+1}`});await client.request({method:'anvil_setBalance',params:[a.address,`0x${parseEther('1').toString(16)}`]});}
    const ledger={data:{lots:[],pending:[],seen:[],events:[],feeReceipts:[]},async save(){},addEvent(e){this.data.events.push(e);}};
    const policy={adapter,recipient:collector,marketPpm:1000,cashbackBps:0,mainWallet:collector,accountId:'test',version:'eth-v2'};
    const rpc={client,config,request:args=>client.request(args),balance:(address,token)=>token===EVM_NATIVE?client.getBalance({address}):read({address:token,abi:m.coin.abi},'balanceOf',[address]),token:async address=>({address,decimals:address===m.stock.address?6:18,symbol:address===EVM_NATIVE?'ETH':'COIN'})};
    const engine=new RobinhoodEngine(ledger,policy,'market');t.after(()=>clearInterval(engine.reconcileTimer));
    Object.assign(engine,{rpc,pools,config,tool:{token:m.coin.address,quote:m.stock.address,budgetEth:'0.01',budget:'0.000001',preset:'balanced',feePool:null},strategyPool:m.market,state:'running',abort:new AbortController()});
    const receipts=[];
    engine.executor=new RobinhoodExecutor(rpc,ledger,{policy,signal:engine.abort.signal,confirmed:(p,r)=>{receipts.push([p,r]);engine.confirmed(p,r);},event:(l,m,d)=>engine.event(l,m,d)});
    await engine.marketTick(); await Promise.allSettled([...engine.tasks]);
    assert.equal(ledger.data.lots.length,5,JSON.stringify(ledger.data.events));assert.equal(ledger.data.pending.length,0);
    for(const w of config.wallets){assert.equal(await read(m.stock,'balanceOf',[w.publicKey]),0n);assert.equal(ledger.data.inventory[w.publicKey].ethAvailable,String(parseEther('0.005')));}
    assert(ledger.data.lots.every(l=>l.costCurrency===EVM_NATIVE&&l.cost===String(parseEther('0.005'))&&l.quoteDecimals===18));
    const snapshot=JSON.stringify(ledger.data); for(const [p,r] of receipts)engine.confirmed(p,r);assert.equal(JSON.stringify(ledger.data),snapshot,'Replayed fills cannot double-charge ETH inventory');
    await assert.rejects(engine.swap(config.wallets[0],m.market,EVM_NATIVE,parseEther('0.006'),{side:'buy',token:m.coin.address,quote:m.stock.address,inventory:true}),/managed ETH budget/);
    engine.tool.preset='advanced';engine.tool.targetPercent=5;engine.tool.driftPercent=1;
    await engine.marketTick();await Promise.allSettled([...engine.tasks]);
    assert.equal(ledger.data.feeReceipts.length,10,JSON.stringify(ledger.data.events));
    for(const w of config.wallets){assert(BigInt(ledger.data.inventory[w.publicKey].ethAvailable)>parseEther('0.009'));assert.equal(await read(m.stock,'balanceOf',[w.publicKey]),0n);}
    for(const w of config.wallets){const amount=ledger.data.lots.filter(l=>l.wallet===w.publicKey).reduce((n,l)=>n+BigInt(l.remaining),0n);await engine.swap(w,m.market,m.coin.address,amount,{side:'sell',token:m.coin.address,quote:m.stock.address,inventory:true});}
    assert(ledger.data.lots.every(l=>l.remaining==='0'));assert.equal(ledger.data.pending.length,0);
    for(const w of config.wallets){const available=BigInt(ledger.data.inventory[w.publicKey].ethAvailable);assert(available>parseEther('0.0099')&&available<parseEther('0.01'));assert.equal(await read(m.stock,'balanceOf',[w.publicKey]),0n);}
  });
  await t.test('LP ETH funding and exits reconcile stock, WETH and native quotes without adopting existing assets',async()=>{
    const m=markets[1], privateKey=generatePrivateKey(), a=privateKeyToAccount(privateKey), w={privateKey,publicKey:a.address};
    await client.request({method:'anvil_setBalance',params:[a.address,`0x${parseEther('1').toString(16)}`]});
    const config={wallets:[w],maxGasGwei:'10',priorityGwei:'0',reserveEth:'0.003',slippageBps:200,maxSignalAgeMs:120000};
    const ledger={data:{lots:[],pending:[],seen:[],events:[],feeReceipts:[],lpFunds:{}},async save(){},addEvent(e){this.data.events.push(e);}};
    const policy={adapter,recipient:collector,cashbackBps:0};
    const rpc={client,config,request:args=>client.request(args),balance:(address,token)=>token===EVM_NATIVE?client.getBalance({address}):read({address:token,abi:m.coin.abi},'balanceOf',[address]),token:async address=>({address,decimals:address===m.stock.address?6:18,symbol:'ASSET'})};
    const engine=new RobinhoodEngine(ledger,policy,'liquidity');t.after(()=>clearInterval(engine.reconcileTimer));
    Object.assign(engine,{rpc,pools,config,tool:{feePool:null},state:'running',abort:new AbortController()});
    const receipts=[];engine.executor=new RobinhoodExecutor(rpc,ledger,{policy,signal:engine.abort.signal,confirmed:(p,r)=>{receipts.push([p,r]);engine.confirmed(p,r);},event:(l,m,d)=>engine.event(l,m,d)});
    await write(m.stock,'mint',[w.publicKey,123n]);
    const budget=parseEther('0.01');
    for(const quote of [m.stock.address,CONTRACTS.weth,EVM_NATIVE]){
      ledger.data.lpFunds[w.publicKey]={token:m.coin.address,quote,budgetCurrency:EVM_NATIVE,budgetEth:String(budget),ethAvailable:String(budget),quoteAvailable:'0',tokenAvailable:'0',fundingComplete:false};
      await engine.convertLpQuote(w,true,budget);
      let funds=ledger.data.lpFunds[w.publicKey];assert.equal(funds.ethAvailable,'0');assert.equal(funds.fundingComplete,true);assert(BigInt(funds.quoteAvailable)>0n);
      const before=JSON.stringify(funds);if(quote!==EVM_NATIVE){const [p,r]=receipts.at(-1);engine.confirmed(p,r);assert.equal(JSON.stringify(ledger.data.lpFunds[w.publicKey]),before);}
      funds=ledger.data.lpFunds[w.publicKey];await engine.convertLpQuote(w,false,BigInt(funds.quoteAvailable));
      funds=ledger.data.lpFunds[w.publicKey];assert.equal(funds.quoteAvailable,'0');assert.equal(funds.ethAvailable,String(budget));
      assert.equal(await read(m.stock,'balanceOf',[w.publicKey]),123n);assert.equal(await read(weth,'balanceOf',[w.publicKey]),0n);
    }
    assert.equal(ledger.data.feeReceipts.length,0,'LP preparation and return swaps must not charge an additional platform fee');assert.equal(ledger.data.pending.length,0);
  });
  await t.test('improved sell proceeds calculate the fee from actual ETH and reject forged execution evidence',async()=>{
    const m=markets[0], bought=await execute(await buildEthTradePlan(opts(m,true,parseEther('0.01'))));
    const plan=await buildEthTradePlan(opts(m,false,bought.event.output));
    await rate(m.stock.address,CONTRACTS.weth,2n,100n);
    const sold=await execute(plan);assert(sold.event.feeEth>BigInt(plan.feeEth));
    const tx={to:adapter,from:account.address,input:plan.data,value:0n};
    await assert.rejects(async()=>ethExecution({...tx,from:collector},sold.receipt),/signed trade/);
    await rate(m.stock.address,CONTRACTS.weth,1n,100n);
  });
});
