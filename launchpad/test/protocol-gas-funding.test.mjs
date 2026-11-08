import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { ProtocolGasFunding, GAS_FUNDING_POLICY } from '../src/protocol-gas-funding.mjs';
import { SOL_MINT } from '../public/launchpad-model.mjs';

const key=()=>{const value=Keypair.generate();return{address:value.publicKey.toBase58(),secret:bs58.encode(value.secretKey)};},sig=()=>bs58.encode(randomBytes(64)),copy=structuredClone;
async function fixture(t,{targetCount=1}={}){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-gas-funding-'));let now=Date.UTC(2026,8,27,1),sequence=0;
  const admin={id:'a'.repeat(32),role:'admin',mfaEnabled:true,mainWallet:key().address,username:'owner'},recipient=key().address,source=key(),treasury=key(),book={launches:[]},host=new Map([['protocol-treasury',{version:1,wallet:treasury,enabled:false,totals:{buybackAvailable:'999000000',retainedSol:'999000000'}}],['launch-protocol-fees',{recipient,history:[]}],['fee-policy',{recipient:key().address}]]),balances=new Map([[source.address,'1000000000']]),receipts=new Map(),calls=[];
  for(let i=0;i<targetCount;i++){const wallet=key();book.launches.push({id:String(i).padStart(32,'0'),input:{route:'raydium',network:'mainnet-beta',feeMode:'holders',quoteMint:SOL_MINT,recipient},feeCustody:'relay',keys:{wallet,platform:{...wallet},payer:{address:admin.mainWallet,external:true},mint:key()},authorizedAt:now-10000,state:'live',curve:key().address,operations:[],review:{platformFeeBps:100,protocolFees:{recipient}}});balances.set(wallet.address,'0');}
  const accounts={dir,get:async id=>id===admin.id?copy(admin):null,list:async()=>[copy(admin)],hostStore:{read:async(name,fallback)=>copy(host.get(name)??fallback),write:async(name,value)=>host.set(name,copy(value))},storeFor:()=>({read:async(name,fallback)=>name==='settings'?{}:name==='launchpad'?copy(book):fallback})},launchpad={book:async()=>copy(book)};
  const chain={gasBalances:async addresses=>{calls.push(['balances',...addresses]);return{slot:100,balances:addresses.map(address=>({address,lamports:balances.get(address)??'0'}))};},prepare:async input=>{calls.push(['prepare',input]);assert.equal(input.minSolReserve,'10000000');const raw=Buffer.from(JSON.stringify({n:++sequence,kind:input.kind,recipient:input.recipient,amount:input.amount})).toString('base64');return{kind:input.kind,wallet:input.wallet.address,mint:input.mint,recipient:input.recipient,inputAmount:input.amount,signature:sig(),raw,rawHash:createHash('sha256').update(Buffer.from(raw,'base64')).digest('hex'),preparedSlot:100,lastValidBlockHeight:200};},broadcast:async op=>{assert.equal(host.get('protocol-gas-funding').pending.raw,op.raw);calls.push(['broadcast',op.signature]);},receipt:async op=>copy(receipts.get(op.signature)||null),state:async()=>({state:'unknown'}),close:async()=>{}};
  const service=new ProtocolGasFunding({accounts,launchpad,chainFactory:async()=>{calls.push(['chain']);return chain;},now:()=>now});service.kick=()=>{};
  t.after(async()=>{await service.close();await rm(dir,{recursive:true,force:true});});
  const state=()=>host.get('protocol-gas-funding'),install=(extra={})=>service.installSigner(admin.id,{secretKey:source.secret,expectedAddress:source.address,reason:'Set up dedicated gas wallet',...extra}),configure=enabled=>service.configure(admin.id,{enabled,expectedAddress:source.address,reason:enabled?'Enable automatic gas refills':'Pause automatic gas refills'}),enable=async()=>{if(!state()?.wallet)await install();return configure(true);};
  return {service,admin,source,treasury,recipient,accounts,host,book,balances,receipts,calls,chain,state,install,configure,enable,advance:(n=60001)=>{now+=n;},get now(){return now;}};
}
const confirmation=op=>({state:'confirmed',signature:op.signature,slot:110,mint:SOL_MINT,recipient:op.recipient,inputAmount:op.inputAmount,outputAmount:'0',actualSolCostLamports:'5000',feeLamports:'5000'});
test('a SOL-blocked active wallet is scanned immediately without waiting the full inventory rotation',async t=>{
  const h=await fixture(t,{targetCount:40}),ordered=[...h.book.launches].sort((a,b)=>a.keys.wallet.address.localeCompare(b.keys.wallet.address)),l=ordered.at(-1);
  for(const item of ordered)h.balances.set(item.keys.wallet.address,'20000000');h.balances.set(l.keys.wallet.address,'1505000');
  Object.assign(l,{autoFees:true,feeAutomation:{enabled:true},feesRequested:true,error:'Automatic rewards are waiting for SOL and will retry automatically.',rewardRetry:{at:h.now+300000,attempt:1,kind:'funding'}});
  await h.install();await h.service.process();assert.equal(h.calls.length,0);
  await h.configure(true);await h.service.process();assert.equal(h.state().pending.recipient,l.keys.wallet.address);assert.equal(h.state().pending.inputAmount,'18495000');
  const scan=h.calls.find(row=>row[0]==='balances');assert.equal(scan.length,18);assert.equal(scan[2],l.keys.wallet.address);assert.equal(h.state().cursor,15);assert.equal(h.calls.filter(row=>row[0]==='prepare').length,1);
  assert.equal(GAS_FUNDING_POLICY.dailyLimitLamports,'100000000');assert.equal(GAS_FUNDING_POLICY.cooldownMs,3600000);
});
test('prioritized waits preserve bounded batches and ordinary inventory progress',async t=>{
  const h=await fixture(t,{targetCount:40}),ordered=[...h.book.launches].sort((a,b)=>a.keys.wallet.address.localeCompare(b.keys.wallet.address));
  for(const [index,l]of ordered.entries()){h.balances.set(l.keys.wallet.address,'20000000');if(index>=20)Object.assign(l,{autoFees:true,feeAutomation:{enabled:true},feesRequested:true,error:'Automatic rewards are waiting for SOL and will retry automatically.',rewardRetry:{at:h.now+300000,attempt:1,kind:'funding'}});}
  await h.enable();for(let i=0;i<4;i++){await h.service.process();h.advance();}
  const scans=h.calls.filter(row=>row[0]==='balances');assert(scans.every(row=>row.length===18));const seen=new Set(scans.flatMap(row=>row.slice(2)));assert.equal(seen.size,40);assert.equal(h.calls.filter(row=>row[0]==='prepare').length,0);
});
function migration(h,{creator='7000000',rewards='20000000',minimum='14128560',rewardsMinimum='10000000'}={}){
  const l=h.book.launches[0];l.keys.rewards=key();l.credits={base:'20000',quote:'30000'};l.rewardsWallet={version:1,status:'migrating',address:l.keys.rewards.address,creatorCredits:{base:'20000',quote:'30000',protocolQuote:'0',taxBase:'0'},gasFundingNeed:{version:1,creatorAddress:l.keys.wallet.address,rewardsAddress:l.keys.rewards.address,creatorMinimumLamports:minimum,rewardsMinimumLamports:rewardsMinimum,creatorPrincipalReserveLamports:'0',observedAt:h.now}};h.balances.set(l.keys.wallet.address,creator);h.balances.set(l.keys.rewards.address,rewards);return l;
}
async function confirmFunding(h){const op=copy(h.state().pending);h.balances.set(op.recipient,(BigInt(h.balances.get(op.recipient)||'0')+BigInt(op.inputAmount)).toString());h.balances.set(h.source.address,(BigInt(h.balances.get(h.source.address))-BigInt(op.inputAmount)-5000n).toString());h.receipts.set(op.signature,confirmation(op));h.advance(11000);await h.service.process();return op;}

function addMeteora(h){
  const record=()=>{const k=key();return {address:k.address,secretBase64:Buffer.from(bs58.decode(k.secret)).toString('base64')};},authority=record(),creator=record();
  const data={schemaVersion:1,enabled:false,authority,config:{authority:authority.address,treasury:h.recipient},operations:[],launches:[{mint:key().address,dbcPoolId:key().address,configAddress:key().address,status:'trading',finalizedAt:h.now-1,partnerAuthority:authority.address,creatorAuthority:creator.address,creatorWallet:h.admin.mainWallet,creatorRecipient:h.admin.mainWallet,treasury:h.recipient,keys:{creator,mint:record(),config:record()}}]};h.host.set('meteora-launches',data);h.balances.set(authority.address,'90000000');return data;
}
test('Meteora shared gas reserve refills toward 0.12 SOL under unchanged caps and explicit enablement',async t=>{
  const h=await fixture(t,{targetCount:0}),data=addMeteora(h);await h.install();await h.service.process();assert.equal(h.calls.length,0);
  await h.configure(true);await h.service.process();assert.equal(h.state().pending.recipient,data.authority.address);assert.equal(h.state().pending.inputAmount,'20000000');assert.equal(h.state().targets[0].requiredBalanceLamports,'100000000');assert.equal(h.state().targets[0].reservedPrincipalLamports,'0');assert.deepEqual(h.state().targets[0].roles,['meteora']);
  await confirmFunding(h);assert.equal(h.state().totals.refilledLamports,'20000000');h.advance();await h.service.process();assert.equal(h.state().pending,null);assert.equal(h.state().targets[0].status,'funded');assert.equal(h.state().day.spentLamports,'20000000');assert.equal(GAS_FUNDING_POLICY.maxRefillLamports,'20000000');assert.equal(GAS_FUNDING_POLICY.dailyLimitLamports,'100000000');
});
test('Meteora authority and creator keys cannot be imported as the dedicated gas source',async t=>{
  for(const role of ['authority','creator'])await t.test(role,async t=>{const h=await fixture(t,{targetCount:0}),data=addMeteora(h),record=role==='authority'?data.authority:data.launches[0].keys.creator;await assert.rejects(h.service.installSigner(h.admin.id,{secretKey:bs58.encode(Buffer.from(record.secretBase64,'base64')),expectedAddress:record.address,reason:'Set up separate gas wallet'}),/must be separate/);assert.equal(h.state(),undefined);});
});
test('Meteora funding requirements cannot raise daily caps, mix roles, or disguise reward principal',async t=>{
  for(const patch of [{minimumLamports:'100000001'},{targetLamports:'999999999'},{principalReserveLamports:'1'},{policy:'caller-selected'}])await t.test(JSON.stringify(patch),async t=>{
    const h=await fixture(t,{targetCount:0}),data=addMeteora(h);await h.enable();const discovery=h.service.targetDiscovery;h.service.targetDiscovery=async args=>{const result=await discovery(args);Object.assign(result.targets[0].fundingNeed,patch);return result;};await h.service.process();assert.equal(h.state().pending,null);assert.equal(h.calls.filter(row=>row[0]==='prepare').length,0);
  });
});
test('Meteora authority exposure between balance scan and preparation cancels its refill',async t=>{
  const h=await fixture(t,{targetCount:0}),data=addMeteora(h);await h.enable();const balances=h.chain.gasBalances;h.chain.gasBalances=async addresses=>{const result=await balances(addresses);data.authority.exportedAt=h.now;return result;};await h.service.process();assert.equal(h.state().pending,null);assert.equal(h.calls.filter(row=>row[0]==='prepare').length,0);
});

test('reward migration refills the creator above the ordinary low-water mark without manual intervention',async t=>{
  const h=await fixture(t),l=migration(h);await h.enable();await h.service.process();assert.equal(h.state().pending.recipient,l.keys.wallet.address);assert.equal(h.state().pending.inputAmount,'13000000');assert.equal(h.state().targets.find(row=>row.address===l.keys.wallet.address).requiredBalanceLamports,'14128560');await confirmFunding(h);assert.equal(h.balances.get(l.keys.wallet.address),'20000000');assert.equal(h.state().totals.refilledLamports,'13000000');
});
test('two wallets above 0.005 SOL can both reach their separate migration needs under normal caps',async t=>{
  const h=await fixture(t),l=migration(h,{creator:'12000000',rewards:'7000000'});await h.enable();await h.service.process();const first=await confirmFunding(h);h.advance();await h.service.process();const second=await confirmFunding(h);assert.notEqual(first.recipient,second.recipient);assert.deepEqual(new Set([first.recipient,second.recipient]),new Set([l.keys.wallet.address,l.keys.rewards.address]));assert.equal(h.balances.get(l.keys.wallet.address),'20000000');assert.equal(h.balances.get(l.keys.rewards.address),'20000000');assert.equal(h.state().totals.refilledLamports,'21000000');assert.equal(h.state().day.spentLamports,'21000000');
});
test('a funded reward wallet with no token handoff does not demand a creator migration refill',async t=>{
  const h=await fixture(t);migration(h,{minimum:'0'});await h.enable();await h.service.process();assert.equal(h.state().pending,null);assert.equal(h.calls.filter(row=>row[0]==='prepare').length,0);assert(h.state().targets.every(row=>row.status==='funded'));
});
test('migration requirements respect manual enablement, per-refill caps and existing cooldown',async t=>{
  const h=await fixture(t),l=migration(h,{minimum:'50000000'});await h.install();await h.service.process();assert.equal(h.calls.length,0);await h.configure(true);await h.service.process();assert.equal(h.state().pending.inputAmount,'20000000');await confirmFunding(h);h.advance();await h.service.process();assert.equal(h.state().pending,null);assert.equal(h.state().targets.find(row=>row.address===l.keys.wallet.address).status,'cooldown');
});
test('a migration hint that disappears before preparation cannot authorize an unnecessary refill',async t=>{
  const h=await fixture(t),l=migration(h);await h.enable();const balances=h.chain.gasBalances;h.chain.gasBalances=async addresses=>{const result=await balances(addresses);delete l.rewardsWallet.gasFundingNeed;return result;};await h.service.process();assert.equal(h.state().pending,null);assert.equal(h.calls.filter(row=>row[0]==='prepare').length,0);assert.match(h.state().error,/funding requirement changed/);
});
test('a wallet topped up between scan and preparation is not refilled again',async t=>{
  const h=await fixture(t),l=migration(h);await h.enable();const balances=h.chain.gasBalances;h.chain.gasBalances=async addresses=>{const result=await balances(addresses);h.balances.set(l.keys.wallet.address,'20000000');return result;};await h.service.process();assert.equal(h.state().pending,null);assert.equal(h.calls.filter(row=>row[0]==='prepare').length,0);
});
test('a protected native reward-principal shortfall cannot be subsidized by the gas wallet',async t=>{
  const h=await fixture(t),target=h.book.launches[0].keys.wallet.address;h.balances.set(target,'1000000');h.service.targetDiscovery=async()=>({targets:[{address:target,roles:['rewards'],fundingNeed:{version:1,minimumLamports:'12000000',principalReserveLamports:'2000000',observedAt:h.now}}]});await h.enable();await h.service.process();assert.equal(h.state().pending,null);assert.equal(h.state().targets[0].status,'principal_shortfall');assert.equal(h.calls.filter(row=>row[0]==='prepare').length,0);
});

test('gas wallet setup stays off and leaves treasury and fee recipient bytes unchanged',async t=>{
  const h=await fixture(t),before=copy([...h.host]);await h.service.process();assert.deepEqual([...h.host],before);assert.equal(h.calls.length,0);
  const view=await h.install();assert.equal(view.configured,true);assert.equal(view.enabled,false);assert.equal(view.address,h.source.address);assert.equal(view.balanceLamports,null);assert.equal(view.lowBalance,null);assert.equal(h.calls.length,0);
  assert.deepEqual(h.host.get('protocol-treasury'),before[0][1]);assert.deepEqual(h.host.get('launch-protocol-fees'),before[1][1]);await h.service.process();assert.equal(h.calls.length,0);
  assert(!JSON.stringify(view).includes(h.source.secret));assert(!JSON.stringify(view).includes('raw'));
});
test('setup cannot import treasury, revenue, user or managed launch keys as the source',async t=>{
  for(const kind of ['treasury','current-fees','historic-fees','user','launch','settings'])await t.test(kind,async t=>{
    const h=await fixture(t);if(kind==='treasury')h.host.get('protocol-treasury').wallet={...h.source};if(kind==='current-fees')h.host.get('launch-protocol-fees').recipient=h.source.address;if(kind==='historic-fees')h.host.get('launch-protocol-fees').history=[{from:h.source.address,to:h.recipient}];if(kind==='user')h.admin.signInWallet=h.source.address;if(kind==='launch')h.book.launches[0].keys.wallet={...h.source};if(kind==='settings')h.accounts.storeFor=()=>({read:async(name)=>name==='settings'?{wallets:[{publicKey:h.source.address}]}:{launches:[]}});
    await assert.rejects(h.install(),/must be separate/);assert.equal(h.state(),undefined);
  });
});
test('setup and configuration require MFA, matching public address and fixed reviewed input',async t=>{
  const h=await fixture(t);await assert.rejects(h.install({secretKey:'invalid private key'}),/valid 64-byte/);await assert.rejects(h.install({expectedAddress:key().address}),/does not match/);h.admin.mfaEnabled=false;await assert.rejects(h.install(),{statusCode:403});h.admin.mfaEnabled=true;await h.install();
  await assert.rejects(h.service.configure(h.admin.id,{enabled:true,expectedAddress:key().address,reason:'Enable refills'}),/wallet changed/);
  const view=await h.service.configure(h.admin.id,{enabled:true,expectedAddress:h.source.address,reason:'Enable refills',dailyLimitLamports:'999999999999',recipient:h.admin.mainWallet});assert.equal(view.policy.dailyLimitLamports,'100000000');assert.equal(view.policy.maxRefillLamports,'20000000');
});
test('same-key setup is idempotent, cannot rotate or reset gas accounting',async t=>{
  const h=await fixture(t);await h.install();h.state().totals.refilledLamports='123';const before=copy(h.state());await h.install();assert.deepEqual(h.state(),before);const other=key();await assert.rejects(h.install({secretKey:other.secret,expectedAddress:other.address}),/already configured/);assert.deepEqual(h.state(),before);
});
test('real target discovery admits a managed launch wallet and excludes all personal recipients',async t=>{
  const h=await fixture(t);h.admin.signInWallet='';await h.enable();const before=copy(h.host.get('protocol-treasury'));await h.service.process();const pending=h.state().pending;assert.equal(pending.kind,'gas-refill');assert.equal(pending.recipient,h.book.launches[0].keys.wallet.address);assert.equal(pending.inputAmount,'20000000');assert.equal(h.calls.filter(row=>row[0]==='broadcast').length,1);assert.equal(h.state().day.reservedLamports,'20000000');assert.deepEqual(h.host.get('protocol-treasury'),before);
});
test('source reserve and network allowance cannot be spent even when a target is empty',async t=>{
  const h=await fixture(t);await h.enable();h.balances.set(h.source.address,'34999999');await h.service.process();assert.equal(h.state().pending,null);assert.equal(h.state().lowBalance,true);assert.equal(h.state().targets[0].status,'low_source');assert.equal(h.calls.filter(row=>row[0]==='prepare').length,0);
});
test('wallets at threshold are not refilled; below threshold fills only the gap',async t=>{
  const h=await fixture(t);await h.enable();h.balances.set(h.book.launches[0].keys.wallet.address,'5000000');await h.service.process();assert.equal(h.state().pending,null);h.advance();h.balances.set(h.book.launches[0].keys.wallet.address,'4000000');await h.service.process();assert.equal(h.state().pending.inputAmount,'16000000');
});
test('daily cap blocks additional transfers and resets after midnight UTC',async t=>{
  const h=await fixture(t);await h.enable();h.state().day={date:new Date(h.now).toISOString().slice(0,10),spentLamports:'90000000',reservedLamports:'0',networkSpentLamports:'0',reservedNetworkLamports:'0'};await h.service.process();assert.equal(h.state().pending,null);assert.equal(h.state().targets[0].status,'daily_limit');h.advance(86400000);await h.service.process();assert.equal(h.state().pending.inputAmount,'20000000');assert.equal(h.state().day.spentLamports,'0');
});
test('only one bounded wallet batch is checked per minute and cursor makes progress',async t=>{
  const h=await fixture(t,{targetCount:20});await h.enable();for(const l of h.book.launches)h.balances.set(l.keys.wallet.address,'10000000');await h.service.process();assert.equal(h.calls.filter(row=>row[0]==='balances').length,1);assert.equal(h.calls.find(row=>row[0]==='balances').length,18);const before=h.calls.length;await h.service.process();assert.equal(h.calls.length,before);h.advance();await h.service.process();assert.equal(h.state().targets.length,20);
});
test('durable journal precedes broadcast and provider timeout cannot create duplicate funding',async t=>{
  const h=await fixture(t);await h.enable();h.chain.broadcast=async op=>{assert.equal(h.state().pending.signature,op.signature);h.calls.push(['broadcast',op.signature]);throw Error('PRIVATE_RPC');};await h.service.process();const op=copy(h.state().pending);h.advance(11000);await h.service.process();assert.equal(h.state().pending.signature,op.signature);assert.equal(h.calls.filter(row=>row[0]==='prepare').length,1);assert(!JSON.stringify(await h.service.read(h.admin.id)).includes('PRIVATE_RPC'));
});
test('journal storage failure prevents broadcasts and preserves original source accounting',async t=>{
  const h=await fixture(t);await h.enable();const write=h.accounts.hostStore.write;h.accounts.hostStore.write=async(name,value)=>{if(name==='protocol-gas-funding'&&value.pending)throw Error('Disk full');return write(name,value);};await assert.rejects(h.service.process(),/Disk full/);assert.equal(h.calls.filter(row=>row[0]==='broadcast').length,0);assert.equal(h.state().pending,null);assert.equal(h.state().totals.refilledLamports,'0');
});
test('confirmation credits exact sent amount once, releases reservations and applies one-hour cooldown',async t=>{
  const h=await fixture(t);await h.enable();await h.service.process();const pending=copy(h.state().pending);h.receipts.set(pending.signature,confirmation(pending));h.advance(11000);await h.service.process();assert.equal(h.state().pending,null);assert.equal(h.state().totals.refilledLamports,'20000000');assert.equal(h.state().totals.networkSpentLamports,'5000');assert.equal(h.state().day.reservedLamports,'0');assert.equal(h.state().day.reservedNetworkLamports,'0');assert.equal(h.state().balanceLamports,null);
  h.advance();await h.service.process();assert.equal(h.state().pending,null);assert.equal(h.state().targets[0].status,'cooldown');assert.equal(h.state().totals.refilledLamports,'20000000');h.advance(GAS_FUNDING_POLICY.cooldownMs);await h.service.process();assert.equal(h.state().pending?.kind,'gas-refill');
});
test('disabled service still reconciles pending refills and never resubmits them',async t=>{
  const h=await fixture(t);await h.enable();await h.service.process();const op=copy(h.state().pending);await h.configure(false);h.chain.state=async()=>({state:'pending'});h.advance(21000);await h.service.process();assert.equal(h.calls.filter(row=>row[0]==='broadcast').length,1);h.receipts.set(op.signature,confirmation(op));h.advance(11000);await h.service.process();assert.equal(h.state().pending,null);assert.equal(h.state().totals.refilledLamports,'20000000');const count=h.calls.length;h.advance();await h.service.process();assert.equal(h.calls.length,count);
});
test('target export between signing and initial broadcast keeps the saved operation without sending',async t=>{
  const h=await fixture(t);await h.enable();const prepare=h.chain.prepare;h.chain.prepare=async input=>{const op=await prepare(input);h.book.launches[0].walletExportedAt=h.now;return op;};await h.service.process();assert.equal(h.state().pending.kind,'gas-refill');assert.equal(h.calls.filter(row=>row[0]==='broadcast').length,0);assert.match(h.state().pending.error,/no longer eligible/);
});
test('eligibility is checked again after the balance scan and before signing',async t=>{
  const h=await fixture(t);await h.enable();const balances=h.chain.gasBalances;h.chain.gasBalances=async addresses=>{const result=await balances(addresses);h.book.launches[0].walletExportedAt=h.now;return result;};await h.service.process();assert.equal(h.state().pending,null);assert.equal(h.calls.filter(row=>row[0]==='prepare').length,0);assert.match(h.state().error,/no longer eligible/);
});
test('source newly used for revenue fails closed before any additional signing',async t=>{
  const h=await fixture(t);await h.enable();h.host.get('launch-protocol-fees').recipient=h.source.address;await h.service.process();assert.equal(h.state().pending,null);assert.equal(h.calls.filter(row=>row[0]==='prepare').length,0);assert.equal(h.state().totals.refilledLamports,'0');
});
test('new loss of eligibility or admin access blocks rebroadcast but allows receipt reconciliation',async t=>{
  for(const kind of ['export','admin'])await t.test(kind,async t=>{const h=await fixture(t);await h.enable();await h.service.process();const op=copy(h.state().pending);if(kind==='export')h.book.launches[0].walletExportedAt=h.now;else h.admin.role='user';h.chain.state=async()=>({state:'pending'});h.advance(21000);await h.service.process();assert.equal(h.calls.filter(row=>row[0]==='broadcast').length,1);h.receipts.set(op.signature,confirmation(op));h.advance(11000);await h.service.process();assert.equal(h.state().pending,null);assert.equal(h.state().totals.refilledLamports,'20000000');});
});
test('expiry needs two advancing finalized checkpoints and complete retained history',async t=>{
  const h=await fixture(t);await h.enable();await h.service.process();const op=copy(h.state().pending);let slot=210,height=210;h.chain.state=async()=>({state:'expired',signature:op.signature,checkpoint:{slot,height},historyFromSlot:1});h.advance(11000);await h.service.process();assert(h.state().pending.expiryCheck);h.advance(11000);await h.service.process();assert(h.state().pending);slot++;height++;h.advance(11000);await h.service.process();assert.equal(h.state().pending,null);assert.equal(h.state().history.at(-1).state,'expired');assert.equal(h.state().day.reservedLamports,'0');assert.equal(h.state().totals.refilledLamports,'0');
});
test('unknown or pruned history preserves pending signature and prevents replacement',async t=>{
  const h=await fixture(t);await h.enable();await h.service.process();const op=copy(h.state().pending);h.chain.state=async()=>({state:'expired',signature:op.signature,checkpoint:{slot:210,height:210},historyFromSlot:101});for(let n=0;n<3;n++){h.advance(11000);await h.service.process();}assert.equal(h.state().pending.signature,op.signature);assert.equal(h.state().pending.expiryCheck,undefined);assert.equal(h.calls.filter(row=>row[0]==='prepare').length,1);
});
test('wrong confirmed recipient, amount, mint or network cost never partially settles funding',async t=>{
  for(const patch of [{recipient:key().address},{inputAmount:'20000001'},{mint:key().address},{actualSolCostLamports:'5000001'}])await t.test(JSON.stringify(patch),async t=>{const h=await fixture(t);await h.enable();await h.service.process();const op=copy(h.state().pending);h.receipts.set(op.signature,{...confirmation(op),...patch});h.advance(11000);await h.service.process();assert.equal(h.state().pending.signature,op.signature);assert.equal(h.state().totals.refilledLamports,'0');assert.equal(h.state().day.reservedLamports,'20000000');});
});
test('malformed balance snapshots never report zero funds or authorize any refill',async t=>{
  for(const response of [{slot:1,balances:[]},{slot:1,balances:[{address:key().address,lamports:'1000000000'}]},null])await t.test(JSON.stringify(response),async t=>{const h=await fixture(t);await h.enable();h.chain.gasBalances=async()=>response;await h.service.process();assert.equal(h.state().balanceLamports,null);assert.equal(h.state().lowBalance,null);assert.equal(h.state().pending,null);assert.equal(h.calls.filter(row=>row[0]==='prepare').length,0);});
});
test('failed transaction spends only actual network fees and later retry never counts a transfer',async t=>{
  const h=await fixture(t);await h.enable();await h.service.process();const op=copy(h.state().pending);h.receipts.set(op.signature,{state:'failed',signature:op.signature,actualSolCostLamports:'5000'});h.advance(11000);await h.service.process();assert.equal(h.state().pending,null);assert.equal(h.state().totals.refilledLamports,'0');assert.equal(h.state().totals.networkSpentLamports,'5000');assert.equal(h.state().day.reservedLamports,'0');assert.equal(Object.keys(h.state().cooldowns).length,0);
});
test('receipt storage failure keeps original pending budget for safe replay',async t=>{
  const h=await fixture(t);await h.enable();await h.service.process();const op=copy(h.state().pending);h.receipts.set(op.signature,confirmation(op));const write=h.accounts.hostStore.write;h.accounts.hostStore.write=async(name,value)=>{if(name==='protocol-gas-funding'&&!value.pending&&value.history.length)throw Error('Receipt commit failed');return write(name,value);};h.advance(11000);await assert.rejects(h.service.process(),/Receipt commit failed/);assert.equal(h.state().pending.signature,op.signature);assert.equal(h.state().totals.refilledLamports,'0');h.accounts.hostStore.write=write;h.advance(11000);await h.service.process();assert.equal(h.state().totals.refilledLamports,'20000000');assert.equal(h.state().pending,null);
});
test('damaged stored policy accounting fails closed without provider calls',async t=>{
  const h=await fixture(t);await h.enable();h.state().totals.refilledLamports='-1';await assert.rejects(h.service.process(),/invalid amount/);assert.equal(h.calls.length,0);
});
