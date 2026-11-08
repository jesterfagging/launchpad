import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Keypair, PublicKey, SystemProgram, TransactionMessage } from '@solana/web3.js';
import { treasuryChainHarness } from './support/protocol-treasury-chain-fixture.mjs';
import bs58 from 'bs58';
import { ProtocolTreasury, protocolTreasurySources, LAUNCHPAD_TREASURY_MINT, TREASURY_POLICY } from '../src/protocol-treasury.mjs';
import { treasuryRouteGuardError } from '../src/launchpad-trading-route.mjs';
import { SOL_MINT } from '../public/launchpad-model.mjs';
import { TelegramStore } from '../src/telegram-store.mjs';
import { MANUAL_PROTOCOL_HISTORY } from '../src/protocol-manual-history.mjs';

const address=()=>Keypair.generate().publicKey.toBase58(),signature=()=>bs58.encode(randomBytes(64)),copy=value=>structuredClone(value);
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-treasury-'));t.after(()=>rm(dir,{recursive:true,force:true}));let clock=100000,sequence=0,factoryCalls=0;
  const admin={id:'a'.repeat(32),role:'admin',mfaEnabled:true,username:'owner',mainWallet:address()},previous=address(),host=new Map([['launch-protocol-fees',{recipient:previous,creationFeeSol:'0.015',lpPolicy:'platform_locked',platformLpPercent:75}],['fee-policy',{recipient:address()}]]),books=new Map([[admin.id,{launches:[]}]]),incoming=new Map(),confirmed=new Map(),calls=[];
  const accounts={dir,get:async id=>id===admin.id?copy(admin):null,list:async()=>[copy(admin)],hostStore:{read:async(name,fallback)=>copy(host.get(name)??fallback),write:async(name,value)=>host.set(name,copy(value))},storeFor:id=>({read:async()=>copy(books.get(id)||{launches:[]})})};
  const chain={incomingReceipt:async(source,{wallet})=>{calls.push(['incoming',source.signature]);const receipt=incoming.get(`${source.signature}:${wallet}`);if(!receipt||receipt.mint!==source.mint||receipt.sourceWallet&&receipt.sourceWallet!==source.sourceWallet||BigInt(receipt.receivedAmount)>BigInt(source.amount)||BigInt(receipt.sourceDebitAmount||receipt.receivedAmount)>BigInt(source.amount))return null;return copy(receipt);},prepare:async input=>{calls.push(['prepare',input.kind,input.amount]);const raw=Buffer.from(JSON.stringify({n:++sequence,kind:input.kind,amount:input.amount})).toString('base64');return {kind:input.kind,wallet:input.wallet.address,mint:input.mint,inputAmount:input.amount,signature:signature(),raw,rawHash:createHash('sha256').update(Buffer.from(raw,'base64')).digest('hex'),lastValidBlockHeight:100,preparedSlot:50,blockhash:address(),...(input.recipient?{recipient:input.recipient}:{}),accounting:{maxCostLamports:input.maxNetworkCostLamports}};},broadcast:async op=>{assert.equal(host.get('protocol-treasury').pending.raw,op.raw);calls.push(['broadcast',op.signature]);},receipt:async op=>copy(confirmed.get(op.signature)||null),state:async()=>({state:'unknown'}),close:async()=>{}};
  const manager=new ProtocolTreasury({accounts,chainFactory:async()=>{factoryCalls++;return chain;},now:()=>clock});manager.kick=()=>{};t.after(()=>manager.close());
  const state=()=>host.get('protocol-treasury');
  const supplied=Keypair.generate();
  const install=(extra={})=>manager.installSigner(admin.id,{secretKey:bs58.encode(supplied.secretKey),expectedAddress:supplied.publicKey.toBase58(),expectedRecipient:host.get('launch-protocol-fees').recipient,reason:'Set up dedicated treasury wallet',...extra});
  const enable=async()=>{if(!state()?.wallet)await install();return manager.configure(admin.id,{enabled:true,expectedRecipient:host.get('launch-protocol-fees').recipient,expectedTreasuryAddress:state().wallet.address,reason:'Enable protocol treasury'});};
  const pause=()=>manager.configure(admin.id,{enabled:false,expectedRecipient:host.get('launch-protocol-fees').recipient,reason:'Pause treasury processing'});
  const addSource=({mint=SOL_MINT,amount='1000',net=amount,recipient=state()?.wallet.address||previous,kind=mint===SOL_MINT?'create':'protocol-payout',sig=signature(),source=address(),base=address(),decimals=6}={})=>{
    const l={input:{route:'raydium',network:'mainnet-beta',quoteMint:mint,symbol:'TEST',quoteSymbol:'QUOTE'},keys:{wallet:{address:source},payer:{address:source},mint:{address:base}},review:{quoteDecimals:mint===SOL_MINT?9:decimals},operations:[]};
    const op=['create','launch-all'].includes(kind)?{kind,signature:sig,state:'confirmed',creationFeeReceipt:{mint:SOL_MINT,decimals:9,recipient,amount}}:{kind,signature:sig,state:'confirmed',amount,payouts:[{owner:recipient,amount}],protocolRecipient:recipient,taxProtocolRecipient:recipient,receipt:{quoteDelta:`-${amount}`,baseDelta:'0'}};
    l.operations.push(op);books.get(admin.id).launches.push(l);const receipt={signature:sig,mint,wallet:recipient,sourceWallet:source,receivedAmount:net,sourceDebitAmount:amount,slot:60};incoming.set(`${sig}:${recipient}`,receipt);return {l,op,receipt};
  };
  return {dir,manager,accounts,admin,previous,host,books,chain,calls,incoming,confirmed,state,supplied,install,enable,pause,addSource,advance:(n=11000)=>{clock+=n;},factoryCalls:()=>factoryCalls};
}
const finalReceipt=(op,extra={})=>({state:'confirmed',signature:op.signature,slot:90,inputAmount:op.inputAmount,outputAmount:'0',actualSolCostLamports:'5000',feeLamports:'5000',...extra});

test('Meteora payout candidates require independent chain receipt before allocation and cannot be replayed across source kinds',async t=>{
  const h=await fixture(t);await h.enable();const {l,op,receipt}=h.addSource({amount:'7'}),source=protocolTreasurySources([l])[0];
  h.books.get(h.admin.id).launches=[];h.manager.meteoraSources=async()=>[{...source,kind:'meteora-partner-payout'},{...source,kind:'meteora-partner-payout'}];
  h.incoming.delete(`${op.signature}:${receipt.wallet}`);await h.manager.process();assert.equal(h.state().totals.receivedSol,'0');assert.equal(Object.keys(h.state().seen).length,0);
  h.incoming.set(`${op.signature}:${receipt.wallet}`,receipt);h.advance(16000);await h.manager.process();assert.equal(h.state().totals.receivedSol,'7');assert.equal(h.state().totals.buybackAvailable,'3');assert.equal(h.state().totals.retainedSol,'4');
  h.books.get(h.admin.id).launches.push(l);h.advance();await h.manager.process();assert.equal(h.state().totals.receivedSol,'7');assert.equal(Object.keys(h.state().seen).length,1);
});

test('paused treasury shows finalized wallet SOL with one shared bounded read and no revenue or allocation writes',async t=>{
  const h=await fixture(t);await h.install();const before=copy([...h.host]),wallet=h.state().wallet.address;let calls=0,closed=0,native='230000000';
  h.chain.gasBalances=async addresses=>{calls++;assert.deepEqual(addresses,[wallet]);await new Promise(resolve=>setTimeout(resolve,5));return{slot:123,balances:[{address:wallet,lamports:native}]};};
  h.chain.close=async()=>{closed++;};
  const views=await Promise.all([h.manager.read(h.admin.id),h.manager.read(h.admin.id),h.manager.read(h.admin.id)]);
  for(const view of views){assert.equal(view.enabled,false);assert.deepEqual(view.walletBalance,{status:'available',address:wallet,lamports:native,observedAt:100000,slot:123,commitment:'finalized'});assert.equal(view.totals.receivedSol,'0');assert.equal(view.totals.buybackAvailable,'0');}
  assert.equal(calls,1);assert.equal(closed,1);assert.deepEqual([...h.host],before);
  await h.manager.read(h.admin.id);assert.equal(calls,1);h.advance(61000);native='240000000';assert.equal((await h.manager.read(h.admin.id)).walletBalance.lamports,native);assert.equal(calls,2);assert.deepEqual([...h.host],before);
});

test('wallet balance provider errors and mismatched snapshots stay unknown and do not expose raw errors',async t=>{
  const invalid=[()=>{throw Error('RPC key PRIVATE_BALANCE_ERROR');},wallet=>({slot:1,balances:[{address:address(),lamports:'10'}]}),wallet=>({slot:1,balances:[{address:wallet,lamports:'-1'}]}),wallet=>({slot:1,balances:[{address:wallet,lamports:'18446744073709551616'}]}),wallet=>({slot:-1,balances:[{address:wallet,lamports:'10'}]}),wallet=>({slot:1,balances:[]})];
  for(const response of invalid){const h=await fixture(t);await h.install();const wallet=h.state().wallet.address,before=copy([...h.host]);let calls=0;h.chain.gasBalances=async()=>{calls++;return response(wallet);};
    const view=await h.manager.read(h.admin.id);assert.equal(view.walletBalance.status,'unavailable');assert.equal(view.walletBalance.lamports,null);assert.equal(view.walletBalance.observedAt,null);assert(!JSON.stringify(view).includes('PRIVATE_BALANCE_ERROR'));await h.manager.read(h.admin.id);assert.equal(calls,1);assert.deepEqual([...h.host],before);
  }
});

test('balance reads retain current admin authorization while the provider request is in flight',async t=>{
  const h=await fixture(t);await h.install();let finish;h.chain.gasBalances=addresses=>new Promise(resolve=>{finish=()=>resolve({slot:3,balances:[{address:addresses[0],lamports:'100'}]});});
  const pending=h.manager.read(h.admin.id);while(!finish)await new Promise(resolve=>setTimeout(resolve,0));h.admin.role='user';finish();await assert.rejects(pending,/Administrator/);
  const calls=h.factoryCalls();await assert.rejects(h.manager.read(h.admin.id),/Administrator/);assert.equal(h.factoryCalls(),calls);assert.equal(h.state().totals.receivedSol,'0');
});

test('timed-out wallet reads return unknown and never overlap another provider read',async t=>{
  const h=await fixture(t);await h.install();h.manager.balanceTimeoutMs=10;let finish,calls=0,closed=0;const wallet=h.state().wallet.address;
  h.chain.gasBalances=()=>{calls++;return new Promise(resolve=>{finish=()=>resolve({slot:3,balances:[{address:wallet,lamports:'100'}]});});};h.chain.close=async()=>{closed++;};
  assert.equal((await h.manager.read(h.admin.id)).walletBalance.status,'unavailable');h.advance(61000);assert.equal((await h.manager.read(h.admin.id)).walletBalance.status,'unavailable');assert.equal(calls,1);
  finish();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(closed,1);
  h.chain.gasBalances=async()=>{calls++;return{slot:4,balances:[{address:wallet,lamports:'200'}]};};assert.equal((await h.manager.read(h.admin.id)).walletBalance.lamports,'200');assert.equal(calls,2);
});

test('a balance response settling after shutdown is not cached or exposed as fresh',async t=>{
  const h=await fixture(t);await h.install();let finish;h.chain.gasBalances=addresses=>new Promise(resolve=>{finish=()=>resolve({slot:3,balances:[{address:addresses[0],lamports:'100'}]});});
  const pending=h.manager.read(h.admin.id);while(!finish)await new Promise(resolve=>setTimeout(resolve,0));await h.manager.close();finish();assert.equal((await pending).walletBalance.status,'unavailable');assert.equal(h.manager.balanceCache,null);assert.equal(h.state().totals.buybackAvailable,'0');
});

test('read and unconfigured startup create no key, policy write or provider calls',async t=>{const h=await fixture(t),before=copy([...h.host]);const view=await h.manager.read(h.admin.id);assert.equal(view.configured,false);await h.manager.process();assert.deepEqual([...h.host],before);assert.equal(h.factoryCalls(),0);});
test('enable saves stable separate encrypted wallet before policy and crash recovers authorized intent',async t=>{const h=await fixture(t),write=h.accounts.hostStore.write;let fail=true;h.accounts.hostStore.write=async(name,value)=>{if(name==='launch-protocol-fees'&&fail){fail=false;assert(h.state().wallet.secret);throw Error('disk failure');}return write(name,value);};await assert.rejects(h.enable,/disk failure/);const savedAddress=h.state().wallet.address;assert(h.state().activation);assert.equal(h.host.get('launch-protocol-fees').recipient,h.previous);await h.manager.process();assert.equal(h.state().wallet.address,savedAddress);assert.equal(h.state().enabled,true);assert.equal(h.state().activation,undefined);assert.equal(h.host.get('launch-protocol-fees').recipient,savedAddress);assert.equal(h.host.get('launch-protocol-fees').creationFeeSol,'0.015');});
test('settings require MFA and optimistic recipient and cannot enable from public read',async t=>{const h=await fixture(t);await assert.rejects(h.manager.configure(h.admin.id,{enabled:true,expectedRecipient:address(),reason:'Enable treasury'}),/recipient changed/);h.admin.mfaEnabled=false;await assert.rejects(h.enable,/two-factor/);assert.equal(h.state(),undefined);});
test('paused idle treasury makes no provider calls and response never exposes secret or signed bytes',async t=>{const h=await fixture(t);await h.enable();await h.pause();const n=h.factoryCalls();await h.manager.process();assert.equal(h.factoryCalls(),n);const view=await h.manager.read(h.admin.id),text=JSON.stringify(view);assert(!text.includes(h.state().wallet.secret));assert(!text.includes('rawHash'));assert.equal(view.enabled,false);assert.equal(view.recipient,h.state().wallet.address);});
test('source discovery excludes claims and personal rewards and deduplicates cloned kinds by signature mint destination',async t=>{const h=await fixture(t);await h.enable();const {l,op}=h.addSource({amount:'7'});l.operations.push({...copy(op),kind:'launch-all'},...['claim','protocol-claim','payout'].map(kind=>({...copy(op),kind})));const rows=protocolTreasurySources([l,copy(l)]);assert.equal(rows.length,1);await h.manager.process();assert.equal(h.state().totals.receivedSol,'7');await h.manager.process();assert.equal(h.state().totals.receivedSol,'7');assert.equal(Object.keys(h.state().seen).length,1);});
// v71.44: a Paycheck payout batch carries the Launchpad (10%) and $LAUNCHPAD burn (35%) shares in one row to the treasury; the burn
// share is allocated to buybacks whole and the Launchpad share follows the treasury's half-and-half policy.
test('a Paycheck protocol row is discovered from its payout batch and its burn share is all buyback money',async t=>{
  const h=await fixture(t);await h.enable();const treasury=h.state().wallet.address,rewards=address(),launchWallet=address(),holder=address(),sig=signature();
  const l={input:{route:'raydium',network:'mainnet-beta',quoteMint:SOL_MINT,symbol:'PAY',feeMode:'holders',taxBps:0,paycheck:{policy:'paycheck-v1'}},keys:{wallet:{address:launchWallet},payer:{address:launchWallet},mint:{address:address()},rewards:{address:rewards}},review:{quoteDecimals:9},operations:[
    {kind:'payout',signature:sig,state:'confirmed',amount:'13000',payouts:[{owner:holder,amount:'4000'},{owner:treasury,amount:'9000'}],rewardsWallet:{version:1,source:'rewards',signerSource:'rewards',address:rewards},paycheck:{policy:'paycheck-v1',protocolRecipient:treasury,creatorRecipient:address(),protocolUnits:'9000',curveUnits:'2000',burnUnits:'7000',creatorUnits:'0',holderUnits:'4000'},receipt:{quoteDelta:'-13000',baseDelta:'0'}},
    {kind:'payout',signature:signature(),state:'confirmed',amount:'4000',payouts:[{owner:holder,amount:'4000'}],paycheck:{policy:'paycheck-v1',protocolRecipient:treasury,creatorRecipient:address(),protocolUnits:'0',curveUnits:'0',burnUnits:'0',creatorUnits:'0',holderUnits:'4000'},receipt:{quoteDelta:'-4000',baseDelta:'0'}},
  ]};
  h.books.get(h.admin.id).launches.push(l);
  const sources=protocolTreasurySources([l]);assert.equal(sources.length,1,'only the batch with a treasury row is revenue');
  assert.equal(sources[0].kind,'paycheck-protocol');assert.equal(sources[0].amount,'9000');assert.equal(sources[0].wallet,treasury);assert.equal(sources[0].sourceWallet,rewards,'the dedicated rewards wallet signs Paycheck payouts');assert.equal(sources[0].buybackUnits,'7000');
  h.incoming.set(`${sig}:${treasury}`,{signature:sig,mint:SOL_MINT,wallet:treasury,sourceWallet:rewards,receivedAmount:'9000',sourceDebitAmount:'9000',slot:60});
  await h.manager.process();
  assert.equal(h.state().totals.receivedSol,'9000');assert.equal(h.state().totals.buybackAvailable,'8000','7000 burn share + half of the 2000 Launchpad share');assert.equal(h.state().totals.retainedSol,'1000');assert.equal(h.state().carry,0);
  assert.equal(protocolTreasurySources([{...l,input:{...l.input,paycheck:undefined,taxBps:200}}]).length,0,'an ordinary holder payout is never treasury revenue');
});
test('native revenue uses integer half carry across receipts and never spends donations',async t=>{const h=await fixture(t);await h.enable();h.addSource({amount:'3'});h.addSource({amount:'3'});h.incoming.set(`${signature()}:${h.state().wallet.address}`,{receivedAmount:'9000000000'});await h.manager.process();assert.equal(h.state().totals.receivedSol,'6');assert.equal(h.state().totals.buybackAvailable,'3');assert.equal(h.state().totals.retainedSol,'3');assert.equal(h.state().carry,0);});
test('token payout credit is the actual destination net rather than source gross',async t=>{const h=await fixture(t);await h.enable();const mint=address();h.addSource({mint,amount:'1000',net:'990'});h.chain.prepare=async()=>{throw Error('no route');};await h.manager.process();assert.equal(h.state().assets[mint].received,'990');assert.equal(h.state().assets[mint].credit,'990');assert.equal(h.state().totals.receivedSol,'0');});
test('unroutable and dust assets back off independently and do not block a second asset',async t=>{const h=await fixture(t);await h.enable();const first=address(),second=address();h.addSource({mint:first,amount:'100'});h.addSource({mint:second,amount:'200'});const prepare=h.chain.prepare;h.chain.prepare=async input=>{if(input.mint===first)throw Error('unroutable');return prepare(input);};h.state().assets={};await h.manager.process();assert.equal(h.state().pending.mint,second);assert.equal(h.state().assets[first]?.credit||'100','100');});
test('signed journal is durable before broadcast and a timeout cannot create a second transaction',async t=>{const h=await fixture(t);await h.enable();h.addSource({mint:address(),amount:'99'});h.chain.broadcast=async op=>{assert.equal(h.state().pending.signature,op.signature);h.calls.push(['broadcast',op.signature]);throw Error('RPC timeout');};await h.manager.process();const saved=copy(h.state().pending);h.advance();await h.manager.process();assert.equal(h.calls.filter(c=>c[0]==='prepare').length,1);assert.equal(h.state().pending.signature,saved.signature);assert.equal(h.state().pending.raw,saved.raw);});
test('failed durable journal write prevents broadcast and later unsigned retries',async t=>{const h=await fixture(t);await h.enable();h.addSource({mint:address(),amount:'99'});const write=h.accounts.hostStore.write;h.accounts.hostStore.write=async(name,value)=>{if(name==='protocol-treasury'&&value.pending)throw Error('disk full');return write(name,value);};await assert.rejects(h.manager.process(),/disk full/);assert.equal(h.calls.filter(c=>c[0]==='broadcast').length,0);assert.equal(h.state().pending,null);});
test('pause still reconciles a sent conversion and splits exact net SOL once across restart',async t=>{const h=await fixture(t);await h.enable();const mint=address();h.addSource({mint,amount:'100'});await h.manager.process();const op=copy(h.state().pending);await h.pause();h.confirmed.set(op.signature,finalReceipt(op,{outputAmount:'10000001',actualSolCostLamports:'7000'}));h.advance();await h.manager.process();assert.equal(h.state().pending,null);assert.equal(h.state().assets[mint].credit,'0');assert.equal(h.state().totals.buybackAvailable,'5000000');assert.equal(h.state().totals.retainedSol,'5000001');assert.equal(h.state().totals.networkSpent,'7000');await h.manager.process();assert.equal(h.state().totals.receivedSol,'10000001');});
test('expiry requires two spaced advancing finalized checkpoints with retained history',async t=>{const h=await fixture(t);await h.enable();h.addSource({mint:address(),amount:'100'});await h.manager.process();const op=copy(h.state().pending);let slot=101,height=101;h.chain.state=async()=>({state:'expired',signature:op.signature,checkpoint:{slot,height},historyFromSlot:1});h.advance();await h.manager.process();assert(h.state().pending.expiryCheck);h.advance();await h.manager.process();assert(h.state().pending);slot=102;height=102;h.advance();await h.manager.process();assert.equal(h.state().pending,null);assert.equal(h.state().history.at(-1).state,'expired');assert.equal(h.state().assets[op.mint].credit,'100');assert.equal(h.state().gas.reserved,'0');});
test('unknown or pruned history never authorizes expiry or a fresh signature',async t=>{const h=await fixture(t);await h.enable();h.addSource({mint:address()});await h.manager.process();const op=copy(h.state().pending);h.chain.state=async()=>({state:'expired',signature:op.signature,checkpoint:{slot:101,height:101},historyFromSlot:70});for(let i=0;i<3;i++){h.advance();await h.manager.process();}assert.equal(h.state().pending.signature,op.signature);assert.equal(h.state().pending.expiryCheck,undefined);assert.equal(h.calls.filter(c=>c[0]==='prepare').length,1);});
test('observed signature status survives RPC errors and restart',async t=>{const h=await fixture(t);await h.enable();h.addSource({mint:address()});await h.manager.process();h.chain.state=async op=>{op.observedSignatureStatus=true;throw Error('RPC failed');};h.advance();await h.manager.process();assert.equal(h.state().pending.observedSignatureStatus,true);});
test('funded gas can support minimum buy and burn reserves only actual purchased LAUNCHPAD',async t=>{const h=await fixture(t);await h.enable();h.addSource({amount:'2000000'});await h.manager.process();const buy=copy(h.state().pending);assert.equal(buy.kind,'buy');assert.equal(buy.mint,LAUNCHPAD_TREASURY_MINT);assert.equal(buy.inputAmount,'1000000');h.confirmed.set(buy.signature,finalReceipt(buy,{outputAmount:'923',outputDecimals:6}));h.advance();await h.manager.process();assert.equal(h.state().totals.burnAvailable,'923');h.advance();await h.manager.process();const burn=copy(h.state().pending);assert.equal(burn.kind,'burn');assert.equal(burn.inputAmount,'923');h.confirmed.set(burn.signature,finalReceipt(burn));h.advance();await h.manager.process();assert.equal(h.state().totals.curveBurned,'923');assert.equal(h.state().totals.burnAvailable,'0');assert.equal(h.state().totals.buybackSpent,'1000000');assert.equal(h.state().totals.retainedSol,'990000');});
test('invalid finalized output stays pending without partial credits or a second spend',async t=>{const h=await fixture(t);await h.enable();const mint=address();h.addSource({mint,amount:'100'});await h.manager.process();const op=copy(h.state().pending);h.confirmed.set(op.signature,finalReceipt(op,{inputAmount:'101',outputAmount:'50'}));h.advance();await h.manager.process();assert.equal(h.state().pending.signature,op.signature);assert.equal(h.state().assets[mint].credit,'100');assert.equal(h.state().totals.receivedSol,'0');assert.equal(h.state().gas.reserved,'5000000');});
test('failed conversion charges actual network costs against retained and keeps asset credit',async t=>{const h=await fixture(t);await h.enable();h.addSource({amount:'100000'});const mint=address();h.addSource({mint,amount:'100'});await h.manager.process();const op=copy(h.state().pending);h.confirmed.set(op.signature,{state:'failed',signature:op.signature,actualSolCostLamports:'7000',feeLamports:'7000'});h.advance();await h.manager.process();assert.equal(h.state().totals.retainedSol,'43000');assert.equal(h.state().totals.networkSpent,'7000');assert.equal(h.state().assets[mint].credit,'100');});
test('daily gas budget accounts for confirmed conversion costs and blocks new signing',async t=>{const h=await fixture(t);await h.enable();h.addSource({mint:address()});h.state().gas={day:'1970-01-01',used:'16000000',reserved:'0'};await h.manager.process();assert.equal(h.state().pending,null);assert.match(Object.values(h.state().assets)[0].error,/daily treasury/);assert.equal(h.calls.filter(c=>c[0]==='prepare').length,0);});
test('admin revocation prevents new signing while preserving pending reconciliation',async t=>{const h=await fixture(t);await h.enable();h.addSource({mint:address()});h.admin.mfaEnabled=false;await h.manager.process();assert.equal(h.calls.filter(c=>c[0]==='prepare').length,0);h.admin.mfaEnabled=true;await h.manager.process();const op=copy(h.state().pending);h.admin.role='user';h.confirmed.set(op.signature,finalReceipt(op,{outputAmount:'99'}));h.advance();await h.manager.process();assert.equal(h.state().pending,null);assert.equal(h.state().totals.receivedSol,'99');});
test('old-recipient imports consume gross source provenance but credit only received net, once',async t=>{const h=await fixture(t),mint=address();h.addSource({mint,amount:'1000',net:'990',recipient:h.previous});await h.enable();await h.manager.process();assert.equal(h.state().external[`${h.previous}:${mint}`],'990');const sig=signature();h.incoming.set(`${sig}:${h.state().wallet.address}`,{signature:sig,mint,wallet:h.state().wallet.address,sourceWallet:h.previous,receivedAmount:'980',sourceDebitAmount:'990',slot:70});await h.manager.recognizeRevenue(h.admin.id,{signature:sig,mint,reason:'Move existing protocol revenue'});assert.equal(h.state().assets[mint].credit,'980');assert.equal(h.state().external[`${h.previous}:${mint}`],'0');await h.manager.recognizeRevenue(h.admin.id,{signature:sig,mint,reason:'Retry existing protocol revenue'});assert.equal(h.state().assets[mint].credit,'980');});
test('import rejects unrelated wallets, unsupported assets and transfers beyond prior recorded revenue',async t=>{const h=await fixture(t),mint=address();h.addSource({mint,amount:'10',recipient:h.previous});await h.enable();await h.manager.process();const sig=signature();h.incoming.set(`${sig}:${h.state().wallet.address}`,{signature:sig,mint,wallet:h.state().wallet.address,sourceWallet:address(),receivedAmount:'9',sourceDebitAmount:'9',slot:70});await assert.rejects(h.manager.recognizeRevenue(h.admin.id,{signature:sig,mint,reason:'Recognize old revenue'}),/finalized transfer/);await assert.rejects(h.manager.recognizeRevenue(h.admin.id,{signature:sig,mint:address(),reason:'Recognize old revenue'}),/no recorded protocol/);h.incoming.get(`${sig}:${h.state().wallet.address}`).sourceWallet=h.previous;await assert.rejects(h.manager.recognizeRevenue(h.admin.id,{signature:sig,mint,amount:'11',reason:'Recognize old revenue'}),/finalized transfer/);assert.equal(h.state().assets[mint].credit,'0');});
test('legacy mint choices are available immediately after enable without writes or transactions',async t=>{const h=await fixture(t),mint=address();h.addSource({mint,recipient:h.previous});await h.enable();const before=copy([...h.host]),n=h.factoryCalls(),view=await h.manager.read(h.admin.id);assert(view.recognitionAssets.some(a=>a.mint===mint));assert.deepEqual([...h.host],before);assert.equal(h.factoryCalls(),n+1);assert.equal(view.walletBalance.status,'unavailable');assert.deepEqual(h.calls,[]);});
test('withdrawals reserve revenue obligations and gas floor; stable request is idempotent while paused',async t=>{const h=await fixture(t);await h.enable();h.state().totals.retainedSol='50000000';h.state().totals.buybackAvailable='50000000';await h.pause();const request={amountSol:'0.02',recipient:address(),reason:'Withdraw retained revenue',requestId:'request-id-123456789'};await h.manager.withdrawRetained(h.admin.id,request);await h.manager.withdrawRetained(h.admin.id,request);assert.equal(Object.keys(h.state().withdrawals).length,1);await h.manager.process();const op=copy(h.state().pending);assert.equal(op.kind,'withdraw');assert.equal(op.inputAmount,'20000000');h.confirmed.set(op.signature,finalReceipt(op));h.advance();await h.manager.process();assert.equal(h.state().totals.retainedSol,'29995000');assert.equal(h.state().totals.buybackAvailable,'50000000');assert.equal(h.state().totals.withdrawnSol,'20000000');assert.equal(h.state().withdrawal,null);await h.manager.withdrawRetained(h.admin.id,request);assert.equal(h.state().withdrawal,null);await assert.rejects(h.manager.withdrawRetained(h.admin.id,{...request,amountSol:'0.03'}),/already used/);});
test('retained withdrawals cannot consume gas reserve, buyback obligation or unrecognized balance',async t=>{const h=await fixture(t);await h.enable();h.state().totals.retainedSol='16000000';h.state().totals.buybackAvailable='1000000000';await assert.rejects(h.manager.withdrawRetained(h.admin.id,{amountSol:'0.002',recipient:address(),reason:'Withdraw retained revenue',requestId:'request-id-123456789'}),/exceeds retained revenue/);assert.equal(h.state().pending,null);});

test('post-journal storage failure cannot replace a pending signed operation or broadcast another asset',async t=>{const h=await fixture(t);await h.enable();h.addSource({mint:address(),amount:'100'});h.addSource({mint:address(),amount:'200'});const write=h.accounts.hostStore.write;let pendingWrites=0;h.accounts.hostStore.write=async(name,value)=>{if(name==='protocol-treasury'&&value.pending&&++pendingWrites===2)throw Error('disk failed after journal');return write(name,value);};await assert.rejects(h.manager.process(),/disk failed after journal/);const op=copy(h.state().pending);assert(op?.raw);assert.equal(h.calls.filter(c=>c[0]==='prepare').length,1);assert.equal(h.calls.filter(c=>c[0]==='broadcast').length,0);h.accounts.hostStore.write=write;h.advance();await h.manager.process();assert.equal(h.state().pending.signature,op.signature);assert.equal(h.calls.filter(c=>c[0]==='prepare').length,1);});
test('receipt commit failure retains pending journal and can apply the exact receipt once after recovery',async t=>{const h=await fixture(t);await h.enable();const mint=address();h.addSource({mint,amount:'100'});await h.manager.process();const op=copy(h.state().pending);h.confirmed.set(op.signature,finalReceipt(op,{outputAmount:'999'}));const write=h.accounts.hostStore.write;h.accounts.hostStore.write=async(name,value)=>{if(name==='protocol-treasury'&&!value.pending&&value.history.length)throw Error('receipt disk failed');return write(name,value);};h.advance();await assert.rejects(h.manager.process(),/receipt disk failed/);assert.equal(h.state().pending.signature,op.signature);assert.equal(h.state().assets[mint].credit,'100');assert.equal(h.state().totals.receivedSol,'0');h.accounts.hostStore.write=write;h.advance();await h.manager.process();assert.equal(h.state().pending,null);assert.equal(h.state().totals.receivedSol,'999');assert.equal(h.state().assets[mint].credit,'0');});
test('retained withdrawal cannot queue while a transaction still reserves network costs',async t=>{const h=await fixture(t);await h.enable();h.addSource({amount:'100000000'});await h.manager.process();assert(h.state().pending);await assert.rejects(h.manager.withdrawRetained(h.admin.id,{amountSol:'0.01',recipient:address(),reason:'Withdraw retained revenue',requestId:'request-id-123456789'}),/saved treasury transaction/);assert.equal(h.state().withdrawal,null);});
test('actual adapter integrates native revenue to buy, restart, exact burn and retained withdrawal',async t=>{
  const h=await fixture(t);await h.enable();const live=treasuryChainHarness('buy',{secret:h.state().wallet.secret}),transactions=new Map();
  const {op:sourceOp,l}=h.addSource({amount:'50000000'}),source=l.keys.payer.address,treasury=h.state().wallet.address;
  const message=new TransactionMessage({payerKey:new PublicKey(source),recentBlockhash:address(),instructions:[SystemProgram.transfer({fromPubkey:new PublicKey(source),toPubkey:new PublicKey(treasury),lamports:50000000})]}).compileToV0Message();
  const keys=message.staticAccountKeys.map(String),before=keys.map(key=>key===source?1000000000:key===treasury?Number(live.native):0),after=[...before];after[keys.indexOf(source)]-=50005000;after[keys.indexOf(treasury)]+=50000000;
  transactions.set(sourceOp.signature,{slot:1001,transaction:{message,signatures:[sourceOp.signature]},meta:{err:null,fee:5000,preBalances:before,postBalances:after,preTokenBalances:[],postTokenBalances:[],loadedAddresses:{writable:[],readonly:[]}}});
  live.native+=50000000n;live.amount=25000000n;live.chain.c.getTransaction=async sig=>transactions.get(sig)||null;live.chain.c.getSignatureStatuses=async sigs=>({context:{slot:1200},value:sigs.map(sig=>transactions.has(sig)?{confirmationStatus:'finalized',slot:1001}:null)});
  h.manager.chainFactory=async()=>live.chain;await h.manager.process();const buy=copy(h.state().pending);assert.equal(buy.kind,'buy');assert.equal(buy.mint,LAUNCHPAD_TREASURY_MINT);assert.equal(buy.inputAmount,'25000000');assert.equal(live.sent,1);
  transactions.set(buy.signature,live.receipt(buy));h.advance();await h.manager.process();assert.equal(h.state().totals.burnAvailable,'5000000');assert.equal(h.state().totals.retainedSol,'24981000');
  live.native=BigInt(live.lastSim[0].lamports);live.tokens+=live.output;live.kind='burn';live.amount=5000000n;
  await h.manager.close();const restarted=new ProtocolTreasury({accounts:h.accounts,chainFactory:async()=>live.chain,now:()=>300000});restarted.kick=()=>{};t.after(()=>restarted.close());await restarted.process();const burn=copy(h.state().pending);assert.equal(burn.kind,'burn');assert.equal(burn.inputAmount,'5000000');transactions.set(burn.signature,live.receipt(burn));await restarted.process();assert.equal(h.state().totals.curveBurned,'5000000');assert.equal(h.state().totals.retainedSol,'24962000');
  live.native=BigInt(live.lastSim[0].lamports);live.tokens-=live.amount;live.kind='withdraw';live.amount=5000000n;await restarted.configure(h.admin.id,{enabled:false,expectedRecipient:treasury,reason:'Pause new buyback orders'});await restarted.withdrawRetained(h.admin.id,{amountSol:'0.005',recipient:String(live.recipient),reason:'Withdraw the retained portion',requestId:'integration-request-123456'});await restarted.process();const withdraw=copy(h.state().pending);assert.equal(withdraw.kind,'withdraw');transactions.set(withdraw.signature,live.receipt(withdraw));await restarted.process();assert.equal(h.state().pending,null);assert.equal(h.state().totals.withdrawnSol,'5000000');assert.equal(h.state().totals.retainedSol,'19943000');assert.equal(live.sent,3);assert.equal(h.state().totals.networkSpent,'57000');
});

test('owner-provided setup stores the matching signer while disabled and leaves fee policy and balances unchanged',async t=>{
  const h=await fixture(t),policy=copy(h.host.get('launch-protocol-fees'));
  const view=await h.install();
  assert.equal(view.configured,true);assert.equal(view.enabled,false);assert.equal(view.ownerControlled,true);assert.equal(view.signerOrigin,'owner-provided');
  assert.equal(view.address,h.supplied.publicKey.toBase58());assert.equal(h.state().wallet.secret,bs58.encode(h.supplied.secretKey));assert.equal(h.state().operatorId,null);
  assert(Object.values(h.state().totals).every(n=>n==='0'));assert.deepEqual(h.host.get('launch-protocol-fees'),policy);assert.equal(h.factoryCalls(),0);
  const publicText=JSON.stringify(view);assert(!publicText.includes(bs58.encode(h.supplied.secretKey)));assert(!publicText.includes('importedBy'));
  await h.manager.process();assert.equal(h.factoryCalls(),0);assert.equal(h.state().enabled,false);
});

test('fresh enable requires an installed signer and explicit review of its public address',async t=>{
  const h=await fixture(t),before=copy([...h.host]);
  const configure=extra=>h.manager.configure(h.admin.id,{enabled:true,expectedRecipient:h.previous,reason:'Enable the treasury policy',...extra});
  await assert.rejects(configure({}),/dedicated treasury wallet on the VPS/);assert.deepEqual([...h.host],before);
  await h.install();const installed=copy([...h.host]);
  for(const expectedTreasuryAddress of [undefined,'',address()])await assert.rejects(configure({expectedTreasuryAddress}),/not reviewed/);
  assert.deepEqual([...h.host],installed);await configure({expectedTreasuryAddress:h.state().wallet.address});assert.equal(h.state().enabled,true);
});

test('setup requires current admin MFA access and refuses invalid, mismatched or stale input without writes',async t=>{
  const h=await fixture(t),before=copy([...h.host]);
  for(const extra of [{secretKey:'seed words are not a private key'},{secretKey:bs58.encode(randomBytes(32))},{secretKey:new Uint8Array(64)},{expectedAddress:address()},{expectedRecipient:address()},{expectedRecipient:undefined},{reason:'no'}])await assert.rejects(h.install(extra));
  for(const change of [{role:'user'},{mfaEnabled:false},{banned:true}]){
    const old={...h.admin};Object.assign(h.admin,change);await assert.rejects(h.install(),/Administrator/);for(const key of Object.keys(h.admin))delete h.admin[key];Object.assign(h.admin,old);
  }
  const get=h.accounts.get;let reads=0;h.accounts.get=async id=>{const actor=await get(id);if(++reads>=3)actor.role='user';return actor;};await assert.rejects(h.install(),/Administrator/);
  assert.deepEqual([...h.host],before);assert.equal(h.factoryCalls(),0);
});

test('setup accepts validated private-key bytes without modifying the callers buffer',async t=>{
  const h=await fixture(t),bytes=new Uint8Array(h.supplied.secretKey),before=new Uint8Array(bytes);await h.install({secretKey:bytes});assert.deepEqual(bytes,before);assert.equal(h.state().wallet.address,h.supplied.publicKey.toBase58());
});

test('setup cannot reuse user, creator, service, toolkit or previously used protocol wallets',async t=>{
  for(const kind of ['mainWallet','signInWallet','cashbackWallet','creator','service','toolkit','gasFunding','settings','currentRecipient','previousRecipient','recordedPayout'])await t.test(kind,async t=>{
    const h=await fixture(t),destination=h.supplied.publicKey.toBase58();
    if(['mainWallet','signInWallet','cashbackWallet'].includes(kind))h.admin[kind]=destination;
    if(kind==='creator')h.books.get(h.admin.id).launches.push({input:{recipient:destination}});
    if(kind==='service')h.books.get(h.admin.id).launches.push({keys:{wallet:{address:destination}}});
    if(kind==='toolkit')h.host.get('fee-policy').recipient=destination;
    if(kind==='gasFunding')h.host.set('protocol-gas-funding',{wallet:{address:destination},enabled:false});
    if(kind==='settings'){const storeFor=h.accounts.storeFor;h.accounts.storeFor=id=>({read:async(name,fallback)=>name==='settings'?{wallets:[{publicKey:destination}]}:storeFor(id).read(name,fallback)});}
    if(kind==='currentRecipient')h.host.get('launch-protocol-fees').recipient=destination;
    if(kind==='previousRecipient')h.host.get('launch-protocol-fees').history=[{from:destination,to:h.previous}];
    if(kind==='recordedPayout')h.addSource({recipient:destination});
    const before=copy([...h.host]);await assert.rejects(h.install(),/separate|new dedicated/);assert.deepEqual([...h.host],before);assert.equal(h.factoryCalls(),0);
  });
});

test('setup cannot reset existing activity, accounting or a different configured treasury',async t=>{
  for(const change of [state=>{state.enabled=true;},state=>{state.operatorId='prior-admin';},state=>{state.totals.buybackAvailable='1';},state=>{state.history=[{kind:'buy',state:'confirmed'}];},state=>{state.seen.old={};},state=>{state.gas.used='1';},state=>{state.withdrawal={amount:'1'};},state=>{state.pending={kind:'burn'};},state=>{state.previousRecipients=[address()];},state=>{state.configurationHistory=[{action:'install-signer'}];}]){
    const h=await fixture(t),state=await h.manager.load();change(state);h.host.set('protocol-treasury',state);const before=copy([...h.host]);await assert.rejects(h.install(),/existing activity or accounting/);assert.deepEqual([...h.host],before);
  }
  const h=await fixture(t);await h.install();const other=Keypair.generate(),before=copy([...h.host]);await assert.rejects(h.install({secretKey:other.secretKey,expectedAddress:other.publicKey.toBase58()}),/already configured/);assert.deepEqual([...h.host],before);
});

test('treasury activation rechecks gas-wallet separation after signer setup',async t=>{
  const h=await fixture(t);await h.install();
  h.host.set('protocol-gas-funding',{enabled:false,wallet:{address:h.state().wallet.address}});
  const before=copy([...h.host]);
  await assert.rejects(h.enable(),error=>error.statusCode===409&&/separate.*service gas/.test(error.message));
  assert.deepEqual([...h.host],before);assert.equal(h.state().enabled,false);assert.equal(h.factoryCalls(),0);
});

test('setup permits an unused explicitly paused ledger and same-key retry never resets accounting or metadata',async t=>{
  const h=await fixture(t);await h.pause();await h.install();await h.enable();h.state().totals.retainedSol='123';h.state().totals.buybackAvailable='123';
  const before=copy([...h.host]),view=await h.install();assert.equal(view.ownerControlled,true);assert.deepEqual([...h.host],before);
  await h.pause();await h.enable();assert.equal(h.state().totals.retainedSol,'123');assert.equal(h.state().totals.buybackAvailable,'123');assert.equal(h.state().wallet.activatedAt,before.find(([name])=>name==='protocol-treasury')[1].wallet.activatedAt);
});

test('first activation rechecks new-wallet provenance after local setup',async t=>{
  const h=await fixture(t);await h.install();h.host.get('launch-protocol-fees').history=[{from:h.state().wallet.address,to:h.previous}];
  const before=copy([...h.host]);await assert.rejects(h.enable(),/new dedicated/);assert.deepEqual([...h.host],before);
});

test('v50 server-generated wallets retain their identity and accounting through pause, retry and enable',async t=>{
  const h=await fixture(t);await h.enable();delete h.state().wallet.origin;delete h.state().wallet.importedAt;delete h.state().wallet.importedBy;delete h.state().wallet.activatedAt;
  h.state().totals.retainedSol='9';const saved=copy(h.state().wallet);await h.pause();
  const view=await h.manager.read(h.admin.id);assert.equal(view.ownerControlled,false);assert.equal(view.signerOrigin,'server-generated');
  const before=copy([...h.host]);await h.install();assert.deepEqual([...h.host],before);
  await h.enable();assert.deepEqual(h.state().wallet,saved);assert.equal(h.state().totals.retainedSol,'9');assert.equal(h.state().enabled,true);
});

test('two competing local installs cannot rotate or overwrite the first installed signer',async t=>{
  const h=await fixture(t),other=Keypair.generate(),results=await Promise.allSettled([h.install(),h.install({secretKey:other.secretKey,expectedAddress:other.publicKey.toBase58()})]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.filter(row=>row.status==='rejected').length,1);
  assert.equal(h.state().configurationHistory.filter(row=>row.action==='install-signer').length,1);assert.equal(h.state().enabled,false);assert.equal(h.host.get('launch-protocol-fees').recipient,h.previous);
});

test('actual encrypted host storage contains no plaintext signer and reload preserves supplied identity',async t=>{
  const h=await fixture(t),key=randomBytes(32),store=new TelegramStore(h.dir,key,'relay-accounts-host');
  for(const [name,value] of h.host)await store.write(name,value);h.accounts.hostStore=store;
  await h.install();const cipher=await readFile(join(h.dir,'protocol-treasury.enc'),'utf8'),secret=bs58.encode(h.supplied.secretKey);
  assert(!cipher.includes(secret));assert(!cipher.includes(h.supplied.publicKey.toBase58()));if(process.platform!=='win32')assert.equal((await stat(join(h.dir,'protocol-treasury.enc'))).mode&0o777,0o600);
  const state=await h.manager.load();assert.equal(state.wallet.secret,secret);assert.equal(state.wallet.address,h.supplied.publicKey.toBase58());assert.equal(state.enabled,false);
  const view=await h.manager.read(h.admin.id);assert.equal(view.signerOrigin,'owner-provided');assert(!JSON.stringify(view).includes(secret));assert.equal(h.factoryCalls(),1);assert.equal(view.walletBalance.status,'unavailable');assert.deepEqual(h.calls,[]);
});


test('verified historical manual buybacks appear before automation is configured without creating a ledger or chain',async t=>{
  const h=await fixture(t);h.advance(1800000000000);const before=copy([...h.host]),view=await h.manager.read(h.admin.id),totals=view.recordedBuybackTotals;
  assert.equal(totals.solSpent,'8916645858');assert.equal(totals.curveBought,'2314783626758');assert.equal(totals.curveBurned,'7414695326644');assert.equal(totals.manualContributionBurned,'5099911699886');assert.equal(totals.history.length,7);assert.equal(totals.manualIncluded,true);assert.equal(view.configured,false);assert.equal(view.totals.buybackAvailable,'0');assert.equal(h.factoryCalls(),0);assert.deepEqual([...h.host],before);
});
test('manual and automatic recorded totals deduplicate verified receipts and never alter financial allocations',async t=>{
  const h=await fixture(t);h.advance(1800000000000);await h.install();const [buy,burn]=MANUAL_PROTOCOL_HISTORY;
  Object.assign(h.state().totals,{buybackSpent:buy.inputAmount,curveBought:buy.outputAmount,curveBurned:burn.inputAmount,buybackAvailable:'500000000'});h.state().curveDecimals=6;
  h.state().history=[buy,burn].map(row=>({...row,state:'confirmed',raw:'PRIVATE_SIGNED_BYTES',accounting:{private:'PRIVATE_ACCOUNTING'}}));const before=copy([...h.host]),view=await h.manager.read(h.admin.id),totals=view.recordedBuybackTotals;
  assert.equal(totals.solSpent,'8916645858');assert.equal(totals.curveBought,'2314783626758');assert.equal(totals.curveBurned,'7414695326644');assert.equal(totals.manualContributionBurned,'5099911699886');assert.equal(totals.manualSolSpent,'8330951492');assert.equal(totals.history.length,7);assert.equal(view.totals.buybackAvailable,'500000000');assert(!JSON.stringify(totals).includes('PRIVATE'));assert(!JSON.stringify(totals).includes(h.state().wallet.secret));assert.deepEqual([...h.host],before);
  h.state().history[0].inputAmount='1';assert.equal((await h.manager.read(h.admin.id)).recordedBuybackTotals.status,'unavailable');assert.equal(h.state().totals.buybackAvailable,'500000000');
});
test('manual history excludes future buys and burns at the current read time',async t=>{
  const h=await fixture(t),first=MANUAL_PROTOCOL_HISTORY[0];let view=await h.manager.read(h.admin.id);assert.equal(view.recordedBuybackTotals.manualIncluded,undefined);
  h.advance(first.confirmedAt-100000);view=await h.manager.read(h.admin.id);assert.equal(view.recordedBuybackTotals.solSpent,'585694366');assert.equal(view.recordedBuybackTotals.curveBought,'719951750480');assert.equal(view.recordedBuybackTotals.curveBurned,'0');assert.equal(view.recordedBuybackTotals.history.length,1);assert.equal(h.factoryCalls(),0);
});

test('corrupt managed totals cannot suppress a pinned manual purchase or report more burned than bought',async t=>{
  const h=await fixture(t);h.advance(1800000000000);await h.install();const buy=MANUAL_PROTOCOL_HISTORY[0];h.state().curveDecimals=6;
  h.state().history=[{...buy,state:'confirmed'}];const before=copy([...h.host]),view=await h.manager.read(h.admin.id);
  assert.equal(view.recordedBuybackTotals.status,'unavailable');assert.equal(view.recordedBuybackTotals.solSpent,null);assert.equal(view.recordedBuybackTotals.curveBought,null);assert.equal(view.recordedBuybackTotals.curveBurned,null);assert.deepEqual([...h.host],before);
  h.state().history=[];h.state().totals.curveBurned='1';const invalid=await h.manager.read(h.admin.id);assert.equal(invalid.recordedBuybackTotals.status,'unavailable');assert.equal(invalid.recordedBuybackTotals.curveBurned,null);assert.equal(h.state().totals.curveBurned,'1');
});


test('admin retry diagnostics expose safe reason and time without changing buy budget or retry cadence',async t=>{
  const h=await fixture(t);await h.enable();h.addSource({amount:'17091613094'});
  let attempts=0;h.chain.prepare=async input=>{attempts++;assert.equal(input.amount,'8545806547');throw treasuryRouteGuardError('TREASURY_PRICE_IMPACT');};
  await h.manager.process();const state=h.state(),before=copy(state.totals),view=await h.manager.view(state);
  assert.equal(view.enabled,true);assert.equal(view.pending,null);assert.equal(view.totals.buybackAvailable,'8545806547');assert.equal(view.totals.buybackSpent,'0');
  assert.deepEqual(view.buyRetry,{attempts:1,nextAttemptAt:115000,reason:'The quoted treasury swap exceeds the 2% price-impact limit. No transaction was submitted.'});
  assert.equal(view.burnRetry,null);assert.match(view.error,/2% price-impact/);assert(!JSON.stringify(view).includes(state.wallet.secret));assert(!JSON.stringify(view).includes('rawHash'));
  h.advance(11000);await h.manager.process();assert.equal(attempts,1);assert.deepEqual(h.state().totals,before);
  h.advance(5000);await h.manager.process();assert.equal(attempts,2);assert.equal(h.state().buyRetry.nextAttemptAt,146000);assert.deepEqual(h.state().totals,before);
});
test('provider diagnostics use fixed messages and never reveal provider text or credentials',async t=>{
  for(const [code,pattern] of [['SOL_ROUTE_AUTH',/API key/],['SOL_ROUTE_RATE_LIMITED',/rate limiting/],['UNKNOWN',/verified route/]]){
    const h=await fixture(t);await h.enable();h.addSource({amount:'2000000'});h.chain.prepare=async()=>{throw Object.assign(Error('PRIVATE_PROVIDER_KEY https://private.invalid'),{code});};
    await h.manager.process();const view=await h.manager.view(h.state());assert.match(view.error,pattern);assert(!JSON.stringify(view).includes('PRIVATE_PROVIDER_KEY'));assert(!JSON.stringify(view).includes('private.invalid'));assert.equal(view.totals.buybackSpent,'0');
  }
});
