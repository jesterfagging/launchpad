import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, parseAbi, parseAbiParameters, parseEther } from 'viem';
import { cleanEvmTool, createRobinhoodAccount } from '../src/robinhood-settings.mjs';
import { RobinhoodEngine } from '../src/robinhood-engine.mjs';
import { RobinhoodExecutor } from '../src/robinhood-executor.mjs';
import { CONTRACTS, EVM_NATIVE } from '../src/robinhood-contracts.mjs';
import { wrappedEthPlan, verifyWrappedEth } from '../src/robinhood-wrapped-eth.mjs';
import { RobinhoodTelegram } from '../src/robinhood-telegram.mjs';

const token='0x1111111111111111111111111111111111111111', quote='0x2222222222222222222222222222222222222222';
const pool={protocol:'v3',currency0:token,currency1:quote,fee:3000};
function setup(t, kind='market') {
  const ledger={data:{lots:[],pending:[],seen:[],events:[],feeReceipts:[]},async save(){},addEvent(e){this.data.events.push(e);}};
  const config=createRobinhoodAccount().settings, wallet=config.wallets.find(w=>w.tool===kind);config.wallets=[wallet];
  const engine=new RobinhoodEngine(ledger,{},kind);t.after(()=>clearInterval(engine.reconcileTimer));
  Object.assign(engine,{config,tool:{token,quote,budgetEth:'0.02',preset:'balanced'},strategyPool:pool,pools:{find:async()=>pool},rpc:{balance:async(_,asset)=>asset===EVM_NATIVE?parseEther('1'):0n},abort:new AbortController(),state:'running'});
  engine.executor=new RobinhoodExecutor({client:{}},ledger);
  return {engine,ledger,wallet};
}
const settle=async engine=>{await Promise.allSettled([...engine.tasks]);await Promise.resolve();};

test('old quote-token budgets require a deliberate ETH amount; fresh strategies default to automatic pools',()=>{
  for(const kind of ['market','liquidity']){
    assert.equal(cleanEvmTool({},kind).budgetEth,'0.1');assert.equal(cleanEvmTool({},kind).quote,'');
    const old=cleanEvmTool({budget:'200',quote},kind);assert.equal(old.budgetEth,'');assert.equal(old.budget,'200');
    const migrated=cleanEvmTool({...old,budgetEth:'0.025'},kind);assert.equal(migrated.budgetEth,'0.025');
    assert.equal(cleanEvmTool(migrated,kind).budgetEth,'0.025');
    assert.throws(()=>cleanEvmTool({budgetEth:'-1'},kind));
    assert.throws(()=>cleanEvmTool({budgetEth:'0.0000000000000000001'},kind));
  }
});
test('idle legacy MM budgets migrate without spending old quote assets; ETH budgets are not refilled on restart',async t=>{
  const {engine,ledger,wallet}=setup(t);ledger.data.inventory={[wallet.publicKey]:{token,quote,budget:'200000000000000000',quoteAvailable:'200000000000000000'}};
  let calls=0;engine.swap=async(_,p,input,amount)=>{calls++;assert.equal(input,EVM_NATIVE);assert.equal(amount,parseEther('0.01'));};
  await engine.marketTick();await settle(engine);assert.equal(calls,1);assert.equal(ledger.data.inventory[wallet.publicKey].budgetCurrency,EVM_NATIVE);
  assert.equal(ledger.data.inventory[wallet.publicKey].ethAvailable,String(parseEther('0.02')));
  ledger.data.inventory[wallet.publicKey].ethAvailable='0';engine.tool.budgetEth='10';
  await engine.marketTick();await settle(engine);assert.equal(calls,1);assert.equal(ledger.data.inventory[wallet.publicKey].budgetEth,String(parseEther('0.02')));
});
test('pending receipts and live legacy holdings block budget migration and new funding',async t=>{
  const {engine,ledger,wallet}=setup(t);ledger.data.inventory={[wallet.publicKey]:{token,quote,quoteAvailable:'200'}};
  ledger.data.lots.push({wallet:wallet.publicKey,token,remaining:'1'});
  assert.throws(()=>engine.checkMarketAllocation(wallet.publicKey),/positions from a quote-token budget/);
  ledger.data.lots=[];ledger.data.pending.push({wallet:wallet.publicKey,signature:'pending'});
  assert.throws(()=>engine.checkMarketAllocation(wallet.publicKey),/positions from a quote-token budget/);
  engine.swap=async()=>assert.fail('An unresolved wallet cannot trade');await engine.marketTick();await settle(engine);
  assert.equal(ledger.data.inventory[wallet.publicKey].quoteAvailable,'200');assert.equal(ledger.data.inventory[wallet.publicKey].budgetCurrency,undefined);
});
test('LP funding cannot buy again while its receipt is unresolved or after it was credited',async t=>{
  const {engine,ledger,wallet}=setup(t,'liquidity');ledger.data.lpFunds={[wallet.publicKey]:{token,quote,budgetCurrency:EVM_NATIVE,ethAvailable:'100',quoteAvailable:'0',tokenAvailable:'0',fundingComplete:false}};
  ledger.data.pending.push({wallet:wallet.publicKey,signature:'conversion'});
  await assert.rejects(engine.convertLpQuote(wallet,true,100n),/unresolved/);
  ledger.data.pending=[];ledger.data.lpFunds[wallet.publicKey].ethAvailable='0';
  await assert.rejects(engine.convertLpQuote(wallet,true,100n),/No tracked LP funds/);
});
test('native LP allocation rolls back when its journal write fails',async t=>{
  const {engine,ledger,wallet}=setup(t,'liquidity');ledger.data.lpFunds={[wallet.publicKey]:{token,quote:EVM_NATIVE,ethAvailable:'100',quoteAvailable:'0',tokenAvailable:'0'}};
  const before=structuredClone(ledger.data);ledger.save=async()=>{throw Error('disk unavailable');};
  await assert.rejects(engine.convertLpQuote(wallet,true,100n),/disk unavailable/);assert.deepEqual(ledger.data,before);
});
test('WETH9 deposit and withdrawal events verify exact conversions without requiring Transfer logs',()=>{
  const wallet='0x3333333333333333333333333333333333333333', abi=parseAbi(['event Deposit(address indexed dst,uint wad)','event Withdrawal(address indexed src,uint wad)']);
  for(const buy of [true,false]){
    const name=buy?'Deposit':'Withdrawal', plan=wrappedEthPlan(buy,100n);
    const pending={...plan,value:String(plan.value),wallet,context:{side:buy?'buy':'sell',amount:'100'}};
    const receipt={logs:[{address:CONTRACTS.weth,topics:encodeEventTopics({abi,eventName:name,args:{[buy?'dst':'src']:wallet}}),data:encodeAbiParameters(parseAbiParameters('uint'),[100n])}]};
    assert.equal(verifyWrappedEth(pending,receipt),100n);
    assert.throws(()=>verifyWrappedEth({...pending,wallet:token},receipt),/no matching/);
    assert.throws(()=>verifyWrappedEth({...pending,value:'1'},receipt),/signed conversion/);
    assert.throws(()=>verifyWrappedEth(pending,{logs:[...receipt.logs,...receipt.logs]}),/no matching/);
  }
});
test('Telegram strategies expose ETH budgets with automatic quote selection; MM sales skip quote prompts',async()=>{
  const messages=[],buttons=[];
  const bot={now:()=>1000,deleteInput:async()=>{},button:(_,title,op,args)=>{buttons.push({title,op,args});return{title,op,args};},say:(_,message)=>messages.push(message)};
  const telegram=new RobinhoodTelegram(bot,{policy:{get:async()=>({description:'Fees',version:'test'})}});
  for(const kind of ['market','liquidity']){
    const ctx={tool:kind,chain:'robinhood',account:{id:'test'},revision:1,settings:createRobinhoodAccount().settings};
    buttons.length=0;telegram.group(ctx,'buy');assert(buttons.some(b=>b.args?.key==='budgetEth'));assert(!buttons.some(b=>b.args?.key==='quote'||b.args?.key==='budget'));
    await telegram.action(ctx,'rhField',{key:'budgetEth'});assert.match(messages.at(-1),/ETH budget per wallet/);
  }
  const settings=createRobinhoodAccount().settings,ctx={tool:'market',chain:'robinhood',account:{id:'test'},revision:1,settings,manualDraft:{id:'manual-market',kind:'market',side:'sell',wallets:[settings.defaultWallets.market]}};
  telegram.prompt(ctx,'manual-token','Token');await telegram.message(ctx,{text:token});assert.equal(ctx.prompt,null);assert.equal(ctx.manualDraft.quote,'');
  await telegram.action(ctx,'rhManualSize',{id:'manual-market'});assert.equal(ctx.prompt.input,'manual-size');
});
