import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Keypair,PublicKey } from '@solana/web3.js';
import { Launchpad } from '../src/launchpad.mjs';
import { LaunchProtocolFees,launchProtocolPolicy,protocolFeeEligibility } from '../src/launchpad-protocol-fees.mjs';
import { newLaunchKeys } from '../src/launchpad-receipts.mjs';
import { recoverFailedLaunch } from '../src/launchpad-recovery-service.mjs';
import { AccountFeePolicy } from '../src/account-policy.mjs';
import { TelegramStore } from '../src/telegram-store.mjs';
import { randomBytes } from 'node:crypto';

const admin='a'.repeat(32),user='b'.repeat(32),other='c'.repeat(32);
const address=()=>Keypair.generate().publicKey.toBase58();
function fixture(index=1,legacy=false){const recipient=address();return {id:index.toString(16).padStart(32,'0'),createdAt:index,authorizedAt:10,feeCustody:'relay',curve:address(),keys:{...newLaunchKeys(),payer:newLaunchKeys().wallet,platform:newLaunchKeys().wallet},input:{route:'raydium',network:'mainnet-beta',creatorFeeBps:25,name:`Coin ${index}`,symbol:`C${index}`,quoteMint:address(),feeMode:'holders',taxBps:300,recipient:''},review:{quoteDecimals:6,quoteSymbol:'CUSTOM',platformFeeBps:legacy?0:100,...(legacy?{}:{protocolFees:{recipient,curveFeeBps:100}})},state:'live',operations:[{kind:'create',state:'confirmed',signature:'launch-signature'}],credits:{quote:'999',base:'888'},gas:{reserved:'10000'},autoFees:true,feesRequested:false,protocolCredit:'0',protocolClaimed:'0',protocolPaid:'0'};}
async function harness(t,launches=[fixture()],policy={recipient:address()}){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-protocol-admin-')),books=new Map([[admin,{launches:[]}],[user,{launches}],[other,{launches:[]}]]),users=new Map([[admin,{id:admin,username:'owner',role:'admin',mfaEnabled:true,mainWallet:address()}],[user,{id:user,username:'creator',role:'user',mfaEnabled:true,mainWallet:address()}],[other,{id:other,username:'second',role:'user',mfaEnabled:false,mainWallet:address()}]]);
  let hostValue=structuredClone(policy),hostReads=0,hostWrites=0,bookReads=0,bookWrites=0,kicks=0;const hostRecords=new Map();
  const accounts={dir,get:async id=>structuredClone(users.get(id)),list:async()=>structuredClone([...users.values()]),hostStore:{read:async(key,fallback)=>{hostReads++;return structuredClone(key==='launch-protocol-fees'?(hostValue??fallback):(hostRecords.get(key)??fallback));},write:async(key,value)=>{hostWrites++;if(key==='launch-protocol-fees')hostValue=structuredClone(value);else hostRecords.set(key,structuredClone(value));}},storeFor:id=>({dir:join(dir,id),read:async()=>{bookReads++;return structuredClone(books.get(id)||{launches:[]});},write:async(key,value)=>{bookWrites++;books.set(id,structuredClone(value));}})};
  const launchpad=new Launchpad(accounts,null);launchpad.kick=()=>{kicks++;};const service=new LaunchProtocolFees({accounts,launchpad,now:()=>12345});
  t.after(async()=>{await launchpad.close();await rm(dir,{recursive:true,force:true});});
  return{service,accounts,launchpad,books,users,get host(){return hostValue;},get hostReads(){return hostReads;},get hostWrites(){return hostWrites;},get bookReads(){return bookReads;},get bookWrites(){return bookWrites;},get kicks(){return kicks;}};
}
const body=(launch,extra={})=>({accountId:user,id:launch.id,requestId:'1'.repeat(32),reason:'Collect verified platform revenue.',policyVersion:3,...extra});

test('launchpad and toolkit recipients stay in separate settings and cannot reuse the same wallet',async t=>{
  const launch=fixture(),h=await harness(t,[launch]),toolkitWallet=address(),launchWallet=address();
  const settings=new Map([['fee-policy',{recipient:toolkitWallet,fundingVerified:true}],['launch-protocol-fees',{recipient:h.host.recipient}]]);
  h.accounts.hostStore={read:async(key,fallback)=>structuredClone(settings.get(key)??fallback),write:async(key,value)=>{settings.set(key,structuredClone(value));}};
  const toolkit=new AccountFeePolicy(h.accounts,{verifyRecipient:async()=>{}}),before=structuredClone(settings.get('fee-policy'));
  await assert.rejects(h.service.configure(admin,{recipient:toolkitWallet,expectedRecipient:h.host.recipient,reason:'Separate launchpad revenue.'}),/different wallet/);
  await h.service.configure(admin,{recipient:launchWallet,expectedRecipient:h.host.recipient,reason:'Separate launchpad revenue.'});
  assert.deepEqual(settings.get('fee-policy'),before);assert.equal(settings.get('launch-protocol-fees').recipientScope,'launchpad');
  await assert.rejects(toolkit.setRecipient(launchWallet),/separate wallet/);
  assert.equal((await toolkit.get(user)).recipient,toolkitWallet);
  const listing=await h.service.coins(admin);assert.equal(listing.coins[0].recipient,launchWallet);assert.equal(h.books.get(user).launches[0].review.protocolFees.recipient,launch.review.protocolFees.recipient);
  const replacement=address();await toolkit.setRecipient(replacement);assert.equal(settings.get('launch-protocol-fees').recipient,launchWallet);assert.equal((await launchProtocolPolicy(h.accounts)).recipient,launchWallet);
});

test('protocol revenue cannot use the dedicated gas wallet while refills are disabled',async t=>{
  const h=await harness(t,[]),destination=address(),prior=h.host.recipient;
  await h.accounts.hostStore.write('protocol-gas-funding',{enabled:false,wallet:{address:destination}});
  const before=structuredClone(h.host),writes=h.hostWrites;
  await assert.rejects(h.service.configure(admin,{recipient:destination,expectedRecipient:prior,reason:'Change protocol receiving wallet.'}),error=>error.statusCode===409&&/separate wallet.*service gas/.test(error.message));
  assert.deepEqual(h.host,before);assert.equal(h.hostWrites,writes);
  const replacement=address();await h.service.configure(admin,{recipient:replacement,expectedRecipient:prior,reason:'Use a separate revenue wallet.'});assert.equal(h.host.recipient,replacement);
});

test('simultaneous wallet changes cannot configure the same launchpad and toolkit destination',async t=>{
  const h=await harness(t,[]),destination=address(),original=h.host.recipient,settings=new Map([['launch-protocol-fees',{recipient:original}],['fee-policy',{recipient:address(),fundingVerified:true}]]);
  h.accounts.hostStore={read:async(key,fallback)=>structuredClone(settings.get(key)??fallback),write:async(key,value)=>{settings.set(key,structuredClone(value));}};
  const toolkit=new AccountFeePolicy(h.accounts,{verifyRecipient:async()=>{}});
  const results=await Promise.allSettled([toolkit.setRecipient(destination),h.service.configure(admin,{recipient:destination,expectedRecipient:original,reason:'Set dedicated launchpad wallet.'})]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.match(results.find(row=>row.status==='rejected').reason.message,/different wallet|separate wallet/);
  assert.notEqual(settings.get('fee-policy').recipient,settings.get('launch-protocol-fees').recipient);
});

test('legacy shared fee settings remain readable but new launches require a separate recipient',async t=>{
  const h=await harness(t,[]),recipient=h.host.recipient;
  h.accounts.hostStore.read=async()=>({recipient});
  assert.equal((await h.service.read(admin)).recipient,recipient);
  await assert.rejects(launchProtocolPolicy(h.accounts),e=>e.statusCode===503&&/separate launchpad fee wallet/.test(e.message));
});

test('protocol service requires administrator MFA before policy or launch reads',async t=>{
  const h=await harness(t);
  for(const actor of [user,other])for(const name of ['read','coins','configure','claim','claimAll','activate'])await assert.rejects(h.service[name](actor,{}),e=>e.statusCode===403);
  h.users.get(admin).mfaEnabled=false;await assert.rejects(h.service.read(admin),e=>e.statusCode===403);
  assert.equal(h.hostReads,0);assert.equal(h.bookReads,0);assert.equal(h.hostWrites,0);assert.equal(h.kicks,0);
});

test('new launches require an explicit valid host protocol policy while an unconfigured admin can inspect settings',async t=>{
  const h=await harness(t,[],null);
  await assert.rejects(launchProtocolPolicy(h.accounts),e=>e.statusCode===503);await assert.rejects(launchProtocolPolicy({}),e=>e.statusCode===503);
  const view=await h.service.read(admin);assert.equal(view.configured,false);assert.equal(view.curveFeeBps,100);assert.equal(view.recipient,'');
  h.accounts.hostStore.read=async(key,fallback)=>key==='launch-protocol-fees'?{recipient:'invalid'}:fallback;await assert.rejects(launchProtocolPolicy(h.accounts),/valid Solana wallet/);
});

test('configuring protocol revenue changes future policy only and writes a durable operator audit',async t=>{
  const launch=fixture(),h=await harness(t,[launch]),recipient=address(),previous=h.host.recipient,before=structuredClone(h.books.get(user));
  const result=await h.service.configure(admin,{recipient,expectedRecipient:previous,reason:'Move future revenue to treasury.'});
  assert.equal(result.policy.recipient,recipient);assert.equal(result.policy.curveFeePercent,1);assert.equal(result.policy.lpPolicy,'platform_locked');assert.equal(result.policy.platformLpPercent,75);assert.equal(result.policy.existingLaunches,'explicit activation required');assert.equal(h.host.history.length,1);assert.equal(h.host.history[0].actorId,admin);assert.equal(h.host.history[0].from,previous);assert.equal(h.host.history[0].to,recipient);assert.deepEqual(h.books.get(user),before);assert.equal(h.bookWrites,0);assert.equal(h.kicks,0);
  const json=JSON.stringify(await h.service.read(admin));assert(!json.includes(launch.keys.wallet.secret));assert(!json.includes('history'));
});

test('protocol policy comparison prevents concurrent overwrite and rejects malformed destination or reason',async t=>{
  const h=await harness(t),previous=h.host.recipient;
  const results=await Promise.allSettled([address(),address()].map(recipient=>h.service.configure(admin,{recipient,expectedRecipient:previous,reason:'Change future protocol collection.'})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.statusCode,409);assert.equal(h.host.history.length,1);
  const [pda]=PublicKey.findProgramAddressSync([Buffer.from('protocol')],Keypair.generate().publicKey);
  for(const extra of [{recipient:'invalid'},{recipient:pda.toBase58()},{expectedRecipient:undefined},{reason:'no'},{reason:'x'.repeat(501)}])await assert.rejects(h.service.configure(admin,{recipient:address(),expectedRecipient:h.host.recipient,reason:'Change future protocol collection.',...extra}));
});

test('creation fees are bounded and auto-harvest accepts only explicit boolean settings',async t=>{
  const h=await harness(t),recipient=h.host.recipient;
  for(const extra of [{creationFeeSol:'-0.01'},{creationFeeSol:'0.100000001'},{creationFeeSol:'NaN'},{creationFeeSol:'1e-2'},{autoHarvest:'false'}])await assert.rejects(h.service.configure(admin,{recipient,expectedRecipient:recipient,reason:'Set protocol fee collection.',...extra}));
  const result=await h.service.configure(admin,{recipient,expectedRecipient:recipient,reason:'Set maximum allowed creation fee.',creationFeeSol:'0.1',autoHarvest:false});
  assert.equal(result.policy.creationFeeSol,'0.1');assert.equal(result.policy.autoHarvest,false);assert.equal(h.host.creationFeeSol,'0.1');assert.equal(h.host.autoHarvest,false);assert.equal(h.bookWrites,0);
});

test('changing only the protocol recipient preserves independent fee and harvest settings',async t=>{
  const h=await harness(t,[],{recipient:address(),creationFeeSol:'0.025',autoHarvest:false,hostExtension:{retained:true}}),prior=h.host.recipient;
  await h.service.configure(admin,{recipient:address(),expectedRecipient:prior,reason:'Rotate treasury without changing fee policy.'});
  assert.equal(h.host.creationFeeSol,'0.025');assert.equal(h.host.autoHarvest,false);assert.deepEqual(h.host.hostExtension,{retained:true});
  assert.equal(h.host.history[0].fromCreationFeeSol,'0.025');assert.equal(h.host.history[0].toCreationFeeSol,'0.025');assert.equal(h.host.history[0].fromAutoHarvest,false);assert.equal(h.host.history[0].toAutoHarvest,false);
});

test('new locked liquidity settings require a bounded whole percentage and leave existing launches untouched',async t=>{
  const launch=fixture(),h=await harness(t,[launch]),before=structuredClone(h.books.get(user)),recipient=h.host.recipient;
  for(const platformLpPercent of [0,50,74,76,100,101,1.5,'75'])await assert.rejects(h.service.configure(admin,{recipient,expectedRecipient:recipient,reason:'Set platform liquidity allocation.',lpPolicy:'platform_locked',platformLpPercent}));
  await h.service.configure(admin,{recipient,expectedRecipient:recipient,reason:'Lock platform liquidity on future launches.',lpPolicy:'platform_locked'});
  assert.equal(h.host.lpPolicy,'platform_locked');assert.equal(h.host.platformLpPercent,75);assert.deepEqual(h.books.get(user),before);assert.deepEqual(h.host.history[0].fromLiquidity,{lpPolicy:'platform_locked',platformLpPercent:75});assert.deepEqual(h.host.history[0].toLiquidity,{lpPolicy:'platform_locked',platformLpPercent:75});
  await h.service.configure(admin,{recipient:address(),expectedRecipient:recipient,reason:'Rotate treasury with existing liquidity policy.'});assert.equal(h.host.lpPolicy,'platform_locked');assert.equal(h.host.platformLpPercent,75);
});

test('protocol policy reads and mutations reject role revocation after asynchronous host reads',async t=>{
  const h=await harness(t),read=h.accounts.hostStore.read;
  h.accounts.hostStore.read=async(...args)=>{const value=await read(...args);h.users.get(admin).role='user';return value;};
  await assert.rejects(h.service.read(admin),/Administrator/);h.users.get(admin).role='admin';let calls=0;
  h.accounts.hostStore.read=async(...args)=>{const value=await read(...args);if(++calls===2)h.users.get(admin).role='user';return value;};
  await assert.rejects(h.service.configure(admin,{recipient:address(),expectedRecipient:h.host.recipient,reason:'Attempt while access is revoked.'}),/Administrator/);assert.equal(h.hostWrites,0);
});

test('cross-account protocol claims use separate earned credit and retain user reward policy and keys',async t=>{
  const launch=fixture();launch.protocolCredit='7000000';launch.protocolClaimed='11000000';launch.protocolPaid='4000000';const h=await harness(t,[launch]),before=structuredClone(launch);
  const result=await h.service.claim(admin,body(launch)),saved=h.books.get(user).launches[0];
  assert.equal(saved.protocolFeesRequested,true);assert.equal(saved.protocolClaimStage,'claim');assert.equal(result.alreadyRequested,false);assert.equal(result.coin.collecting,'7');assert.equal(result.coin.claimed,'11');assert.equal(result.coin.paid,'4');
  for(const key of ['credits','gas','keys','operations','input','review','autoFees'])assert.deepEqual(saved[key],before[key]);
  assert.equal(saved.protocolClaimRequests[0].actorId,admin);assert.equal(saved.protocolClaimRequests[0].reason,body(launch).reason);assert.equal(h.kicks,1);
  assert(!JSON.stringify(result).includes(saved.keys.wallet.secret));assert(!JSON.stringify(result).includes(saved.keys.platform.secret));
});

const recordedTax=()=>({policy:'collected-tax-proceeds-v1',shareBps:500,harvestedBase:'2000000',sourceBaseCredit:'1000000',convertedBase:'1000000',convertedQuote:'100000000',holderQuote:'95000000',accruedQuote:'5000000',creditQuote:'2000000',paidQuote:'3000000',roundingRemainder:'0'});

test('admin tax revenue shows separate verified amounts and payout destinations without double-counting platform or LP revenue',async t=>{
  const launch=fixture(),recipient=address();launch.credits.base='1000888';launch.taxProtocol=recordedTax();
  Object.assign(launch,{protocolCredit:'7000000',protocolClaimed:'11000000',protocolPaid:'4000000'});
  launch.operations.push({kind:'protocol-payout',state:'confirmed',signature:'platform-paid',createdAt:1,confirmedAt:2,amount:'4000000',raw:'private-platform-bytes'},
    {kind:'tax-protocol-payout',state:'confirmed',signature:'tax-paid',createdAt:3,confirmedAt:4,amount:'3000000',taxProtocolRecipient:recipient,raw:'private-tax-bytes',secret:'private-secret',error:'private-error'},
    {kind:'tax-protocol-payout',state:'pending',signature:'tax-pending',createdAt:5,amount:'2000000',taxProtocolRecipient:recipient,raw:'private-pending-bytes'});
  const h=await harness(t,[launch]),before=structuredClone(h.books.get(user)),row=(await h.service.coins(admin)).coins[0];
  assert.equal(row.collecting,'7');assert.equal(row.claimed,'11');assert.equal(row.paid,'4');
  assert.deepEqual(row.taxRevenue,{eligible:true,policy:'collected-tax-proceeds-v1',shareBps:500,recorded:true,status:'pending_receipt',error:'',harvestedBase:'2',unconvertedBase:'1',convertedQuote:'100',holderQuote:'95',accruedQuote:'5',pendingQuote:'2',paidQuote:'3',lastPayoutAt:4,operations:[
    {kind:'tax-protocol-payout',state:'confirmed',signature:'tax-paid',createdAt:3,confirmedAt:4,recipient,amount:'3'},
    {kind:'tax-protocol-payout',state:'pending',signature:'tax-pending',createdAt:5,confirmedAt:undefined,recipient,amount:'2'},
  ]});
  assert.equal(row.operations.length,1);assert.equal(row.operations[0].kind,'protocol-payout');
  const json=JSON.stringify(row.taxRevenue);for(const value of ['private-',launch.keys.wallet.secret,launch.keys.platform.secret])assert(!json.includes(value));
  assert.deepEqual(h.books.get(user),before);assert.equal(h.bookWrites,0);assert.equal(h.kicks,0);
});

test('admin tax statuses distinguish pending forwarding, unconverted taxes and settled recorded proceeds',async t=>{
  const launch=fixture();launch.credits.base='1000000';launch.taxProtocol=recordedTax();
  const h=await harness(t,[launch]),read=async()=>(await h.service.coins(admin)).coins[0].taxRevenue;
  assert.equal((await read()).status,'awaiting_payout');
  launch.taxProtocol.creditQuote='0';launch.taxProtocol.paidQuote='5000000';assert.equal((await read()).status,'awaiting_conversion');
  launch.taxProtocol.sourceBaseCredit='0';launch.taxProtocol.convertedBase='2000000';assert.equal((await read()).status,'current');
  assert.equal((await read()).paidQuote,'5');assert.equal((await read()).unconvertedBase,'0');
});

test('missing historical tax attribution is explicit and does not relabel old reward balances as protocol income',async t=>{
  const taxed=fixture(1),untaxed=fixture(2);untaxed.input.feeMode='creator';untaxed.input.taxBps=0;
  const h=await harness(t,[taxed,untaxed]),rows=(await h.service.coins(admin)).coins;
  assert.equal(rows[0].taxRevenue.status,'no_recorded_proceeds');assert.equal(rows[0].taxRevenue.recorded,false);assert.equal(rows[0].taxRevenue.paidQuote,'0');assert.equal(rows[0].taxRevenue.harvestedBase,'0');assert.deepEqual(rows[0].taxRevenue.operations,[]);
  assert.equal(rows[1].taxRevenue.status,'not_applicable');assert.equal(rows[1].taxRevenue.eligible,false);assert.equal(rows[1].taxRevenue.paidQuote,null);
});

test('invalid saved tax accounting remains visible without false zero totals, private details or hiding other coins',async t=>{
  const broken=fixture(1),normal=fixture(2);broken.credits.base='1000000';broken.taxProtocol={...recordedTax(),paidQuote:'9999999',privateDiagnostic:'hidden-secret'};
  const h=await harness(t,[broken,normal]),rows=(await h.service.coins(admin)).coins,tax=rows[0].taxRevenue;
  assert.equal(rows.length,2);assert.equal(tax.status,'invalid_ledger');assert.equal(tax.recorded,true);assert.match(tax.error,/accounting needs review/);
  for(const field of ['harvestedBase','unconvertedBase','convertedQuote','holderQuote','accruedQuote','pendingQuote','paidQuote'])assert.equal(tax[field],null,field);
  assert(!JSON.stringify(tax).includes('hidden-secret'));assert.equal(rows[1].taxRevenue.status,'no_recorded_proceeds');assert.equal(h.bookWrites,0);
});

test('tax payout history is bounded and keeps each signed destination rather than the current recipient',async t=>{
  const launch=fixture(),prior=address(),current=address();launch.credits.base='1000000';launch.taxProtocol=recordedTax();
  launch.operations.push(...Array.from({length:25},(_,index)=>({kind:'tax-protocol-payout',state:'confirmed',signature:`tax-${index}`,amount:'1',taxProtocolRecipient:prior,createdAt:index+1,confirmedAt:index+2,raw:'hidden signed bytes'})));
  const h=await harness(t,[launch],{recipient:current,recipientScope:'launchpad'}),row=(await h.service.coins(admin)).coins[0];
  assert.equal(row.recipient,current);assert.equal(row.taxRevenue.operations.length,20);assert.equal(row.taxRevenue.operations[0].signature,'tax-5');assert.equal(row.taxRevenue.lastPayoutAt,26);assert(row.taxRevenue.operations.every(op=>op.recipient===prior&&op.amount==='0.000001'));assert(!JSON.stringify(row.taxRevenue).includes('hidden signed bytes'));
});

test('protocol claim replay is bound to the same administrator and operation with one durable request',async t=>{
  const launch=fixture(),h=await harness(t,[launch]),request=body(launch);
  const replies=await Promise.all([h.service.claim(admin,request),h.service.claim(admin,request)]);assert.deepEqual(replies.map(r=>r.alreadyRequested),[false,true]);assert.equal(h.bookWrites,1);
  const saved=h.books.get(user).launches[0];saved.protocolFeesRequested=false;saved.protocolClaimStage='done';
  await h.service.claim(admin,request);assert.equal(saved.protocolFeesRequested,false);assert.equal(h.bookWrites,1);
  await assert.rejects(h.service.activate(admin,request),e=>e.statusCode===409);h.users.get(other).role='admin';h.users.get(other).mfaEnabled=true;await assert.rejects(h.service.claim(other,request),e=>e.statusCode===409);
});

test('collect all queues eligible protocol claims across accounts and reports protected or unsettled coins',async t=>{
  const live=fixture(1),credit=fixture(2),legacy=fixture(3,true),busy=fixture(4),shared=fixture(5),pending=fixture(6),personal=fixture(7),draft=fixture(8),archived=fixture(9),own=fixture(10),remote=fixture(11),sharedOther=fixture(12);
  credit.protocolBaseCredit='900';legacy.autoFees=false;busy.cycle={stage:'distribute',payouts:[{owner:address(),amount:'5'}]};pending.operations.push({kind:'protocol-claim',state:'pending',raw:'private signed bytes'});delete draft.curve;archived.input.route='archived';sharedOther.keys.platform=shared.keys.platform;
  const h=await harness(t,[live,credit,legacy,busy,shared,pending,personal,draft,archived]);h.books.get(admin).launches=[own];h.books.get(other).launches=[remote,sharedOther];h.users.get(other).mainWallet=personal.keys.wallet.address;
  const before=structuredClone([...h.books]),requestId='a1'.repeat(16),result=await h.service.claimAll(admin,{requestId});
  assert.equal(result.requestId,requestId);assert.equal(result.queued.length,5);assert.equal(result.alreadyRequested.length,0);assert.equal(result.skipped.length,5);assert.equal(result.failed.length,0);
  assert.deepEqual(new Set(result.queued.map(c=>c.id)),new Set([live,credit,busy,own,remote].map(l=>l.id)));
  assert.equal(result.skipped.find(c=>c.id===legacy.id).reason.includes('predates'),true);assert.match(result.skipped.find(c=>c.id===shared.id).reason,/Shared/);assert.match(result.skipped.find(c=>c.id===pending.id).reason,/awaiting confirmation/);
  assert.equal(result.queued.find(c=>c.id===remote.id).accountId,other);
  for(const [accountId,book] of before)for(const launch of book.launches){
    const saved=h.books.get(accountId).launches.find(l=>l.id===launch.id);
    if(!result.queued.some(c=>c.accountId===accountId&&c.id===launch.id)){assert.deepEqual(saved,launch);continue;}
    for(const key of ['credits','gas','keys','operations','input','review','autoFees','feesRequested','cycle'])assert.deepEqual(saved[key],launch[key]);
    assert.equal(saved.protocolFeesRequested,true);assert.equal(saved.protocolClaimStage,'claim');assert.equal(saved.protocolCredit,launch.protocolCredit);assert.equal(saved.protocolBaseCredit,launch.protocolBaseCredit);assert.equal(saved.protocolActivation,undefined);
    assert.equal(saved.protocolClaimRequests.length,1);assert.equal(saved.protocolClaimRequests[0].reason,'Collect all protocol fees');assert.equal(saved.protocolClaimRequests[0].activate,false);assert.equal(saved.protocolClaimRequests[0].batchRequestId,requestId);assert.match(saved.protocolClaimRequests[0].requestId,/^[a-f0-9]{64}$/);
  }
  assert.equal(h.kicks,5);assert(!JSON.stringify(result).includes('private signed bytes'));assert(!JSON.stringify(result).includes(live.keys.wallet.secret));
});

test('collect all concurrent retries queue each coin once and a new overlapping batch skips pending work',async t=>{
  const a=fixture(1),b=fixture(2),h=await harness(t,[a,b]),request={requestId:'a2'.repeat(16)};
  const results=await Promise.all([h.service.claimAll(admin,request),h.service.claimAll(admin,request)]);
  assert.equal(results.reduce((n,r)=>n+r.queued.length,0),2);assert.equal(results.reduce((n,r)=>n+r.alreadyRequested.length,0),2);assert.equal(h.bookWrites,2);assert.equal(h.hostWrites,1);
  const next=await h.service.claimAll(admin,{requestId:'a3'.repeat(16)});assert.equal(next.queued.length,0);assert.equal(next.alreadyRequested.length,0);assert.equal(next.skipped.length,2);assert(next.skipped.every(c=>/already queued/.test(c.reason)));assert.equal(h.bookWrites,2);
  h.users.get(other).role='admin';h.users.get(other).mfaEnabled=true;
  await assert.rejects(h.service.claimAll(other,request),e=>e.statusCode===409);assert.equal(h.bookWrites,2);
});

test('different simultaneous collect-all batches cannot queue the same coin twice',async t=>{
  const launch=fixture(),h=await harness(t,[launch]);
  const results=await Promise.all(['a4','a5'].map(value=>h.service.claimAll(admin,{requestId:value.repeat(16)})));
  assert.equal(results.reduce((n,r)=>n+r.queued.length,0),1);assert.equal(results.reduce((n,r)=>n+r.skipped.length,0),1);assert.equal(h.bookWrites,1);assert.equal(h.kicks,1);
});

test('collect all uses one stable record per onchain pool even when duplicate records span accounts',async t=>{
  const launch=fixture(),duplicate=structuredClone(launch);duplicate.id=fixture(2).id;
  const h=await harness(t,[launch]);h.books.get(other).launches=[duplicate];
  const first=await h.service.claimAll(admin,{requestId:'b2'.repeat(16)});
  assert.equal(first.queued.length,1);assert.equal(first.queued[0].accountId,user);assert.equal(first.skipped.length,1);assert.equal(first.skipped[0].accountId,other);assert.match(first.skipped[0].reason,/already represented/);assert.equal(h.bookWrites,1);assert.equal(h.kicks,1);assert.deepEqual(h.books.get(other).launches[0],duplicate);
  const next=await h.service.claimAll(admin,{requestId:'b3'.repeat(16)});
  assert.equal(next.queued.length,0);assert.equal(next.skipped.length,2);assert.equal(h.bookWrites,1);assert.equal(h.kicks,1);
});

test('collect all rechecks runtime flags under the coin lock rather than trusting its initial inventory',async t=>{
  const launch=fixture(),h=await harness(t,[launch]),write=h.accounts.hostStore.write;
  h.accounts.hostStore.write=async(...args)=>{await write(...args);h.books.get(user).launches[0].brandingRequested=true;};
  const result=await h.service.claimAll(admin,{requestId:'a6'.repeat(16)});
  assert.equal(result.queued.length,0);assert.equal(result.skipped.length,1);assert.match(result.skipped[0].reason,/branding/);assert.equal(h.bookWrites,0);assert.equal(h.kicks,0);
});

test('collect all stops on permission loss after partial progress and retries only unfinished requests',async t=>{
  const a=fixture(1),b=fixture(2),h=await harness(t,[a,b]),save=h.launchpad.save.bind(h.launchpad),request={requestId:'a7'.repeat(16)};let revoke=true;
  h.launchpad.save=async(...args)=>{await save(...args);if(revoke){revoke=false;h.users.get(admin).role='user';}};
  await assert.rejects(h.service.claimAll(admin,request),e=>e.statusCode===403);
  assert.equal(h.books.get(user).launches[0].protocolClaimRequests.length,1);assert.equal(h.books.get(user).launches[1].protocolClaimRequests,undefined);assert.equal(h.bookWrites,1);
  h.users.get(admin).role='admin';const result=await h.service.claimAll(admin,request);
  assert.equal(result.queued.length,1);assert.equal(result.alreadyRequested.length,1);assert.equal(h.bookWrites,2);assert.equal(h.hostWrites,1);
});

test('collect all stops on an administrator ban after partial progress and safely resumes after access is restored',async t=>{
  const a=fixture(1),b=fixture(2),h=await harness(t,[a,b]),save=h.launchpad.save.bind(h.launchpad),request={requestId:'b4'.repeat(16)};let ban=true;
  h.launchpad.save=async(...args)=>{await save(...args);if(ban){ban=false;h.users.get(admin).banned=true;}};
  await assert.rejects(h.service.claimAll(admin,request),e=>e.statusCode===403);
  assert.equal(h.books.get(user).launches[0].protocolClaimRequests.length,1);assert.equal(h.books.get(user).launches[1].protocolClaimRequests,undefined);assert.equal(h.bookWrites,1);
  await assert.rejects(h.service.claimAll(admin,request),e=>e.statusCode===403);assert.equal(h.bookWrites,1);
  h.users.get(admin).banned=false;const result=await h.service.claimAll(admin,request);
  assert.equal(result.queued.length,1);assert.equal(result.alreadyRequested.length,1);assert.equal(h.bookWrites,2);assert.equal(h.hostWrites,1);
});

test('collect all does not turn an authorization failure during safety inventory into a per-coin error',async t=>{
  const launch=fixture(),h=await harness(t,[launch]),list=h.accounts.list;let reads=0;
  h.accounts.list=async()=>{const rows=await list();if(++reads===2)h.users.get(admin).mfaEnabled=false;return rows;};
  await assert.rejects(h.service.claimAll(admin,{requestId:'a8'.repeat(16)}),e=>e.statusCode===403);
  assert.equal(h.bookWrites,0);assert.equal(h.kicks,0);
});

test('collect all validates its request before reads and persists an empty batch without starting workers',async t=>{
  const h=await harness(t,[]);
  for(const requestId of [undefined,'short','x'.repeat(32),'a'.repeat(65)])await assert.rejects(h.service.claimAll(admin,{requestId}),/request ID/);
  assert.equal(h.hostReads,0);assert.equal(h.bookReads,0);assert.equal(h.hostWrites,0);
  const result=await h.service.claimAll(admin,{requestId:'a9'.repeat(16)});
  assert.deepEqual(result,{requestId:'a9'.repeat(16),queued:[],alreadyRequested:[],skipped:[],failed:[]});assert.equal(h.bookWrites,0);assert.equal(h.kicks,0);
});

test('collect-all manifests and per-coin audits recover uncertain writes after recreating encrypted stores and services',async t=>{
  const a=fixture(1),b=fixture(2),h=await harness(t,[a,b]),key=randomBytes(32),request={requestId:'b1'.repeat(16)};
  h.accounts.hostStore=new TelegramStore(h.accounts.dir,key,'protocol-test-host');
  h.accounts.storeFor=id=>new TelegramStore(join(h.accounts.dir,id),key,`protocol-test-${id}`);
  await h.accounts.hostStore.write('launch-protocol-fees',{recipient:address()});
  for(const [id,book] of h.books)await h.accounts.storeFor(id).write('launchpad',book);
  const save=h.launchpad.save.bind(h.launchpad);let failOnce=true;
  h.launchpad.save=async(...args)=>{await save(...args);if(failOnce){failOnce=false;throw Error('secret signing data and provider URL must never be exposed');}};
  const initial=await h.service.claimAll(admin,request);
  assert.equal(initial.failed.length,1);assert.equal(initial.failed[0].uncertain,true);assert.match(initial.failed[0].reason,/Retry this request/);assert.equal(initial.queued.length,1);assert(!JSON.stringify(initial).includes('secret signing data'));
  const book=await h.launchpad.book(user);for(const l of book.launches){l.protocolFeesRequested=false;l.protocolClaimStage='done';}book.launches.push(fixture(3));await save(user,book);
  await h.launchpad.close();
  h.accounts.hostStore=new TelegramStore(h.accounts.dir,key,'protocol-test-host');
  const restarted=new Launchpad(h.accounts,null);let kicks=0;restarted.kick=()=>{kicks++;};t.after(()=>restarted.close());
  const result=await new LaunchProtocolFees({accounts:h.accounts,launchpad:restarted}).claimAll(admin,request),after=await restarted.book(user);
  assert.equal(result.alreadyRequested.length,2);assert.equal(result.queued.length,0);assert.equal(result.failed.length,0);assert.equal(result.skipped.length,0);assert.equal(kicks,2);
  for(const l of after.launches.slice(0,2)){assert.equal(l.protocolClaimRequests.length,1);assert.equal(l.protocolFeesRequested,false);assert.equal(l.protocolClaimStage,'done');}
  assert.equal(after.launches[2].protocolFeesRequested,undefined);assert.equal(after.launches[2].protocolClaimRequests,undefined);
});

test('older dedicated launches require explicit activation and do not change the reviewed fee until onchain confirmation',async t=>{
  const launch=fixture(1,true),h=await harness(t,[launch]),before=structuredClone(launch);
  await assert.rejects(h.service.claim(admin,body(launch)),/predates/);
  const result=await h.service.activate(admin,body(launch)),saved=h.books.get(user).launches[0];
  assert.equal(result.alreadyRequested,false);assert.equal(saved.protocolClaimStage,'activate');assert.equal(saved.protocolActivation.recipient,h.host.recipient);assert.equal(saved.protocolActivation.curveFeeBps,100);assert.deepEqual(saved.review,before.review);assert.deepEqual(saved.input,before.input);assert.deepEqual(saved.operations,before.operations);assert.equal(saved.protocolClaimRequests[0].activate,true);
});

test('legacy activation accepts dormant reward bookkeeping without resetting any saved work',async t=>{
  for(const feeMode of ['buyback','holders','creator'])for(const state of ['live','paused','error']){
    const launch=fixture(1,true);launch.input.feeMode=feeMode;launch.state=state;launch.autoFees=false;launch.feesRequested=true;
    launch.cycle={stage:'payout',index:1,payouts:[{owner:address(),amount:'17'},{owner:address(),amount:'29'}],claimedQuote:'46',slot:400};
    launch.error='Previous reward preparation failed.';
    const h=await harness(t,[launch]),before=structuredClone(launch);
    assert.equal((await h.service.coins(admin)).coins[0].activation.allowed,true);
    await h.service.activate(admin,body(launch));const saved=h.books.get(user).launches[0];
    for(const key of ['cycle','credits','operations','autoFees','feesRequested','input','review','state','error'])assert.deepEqual(saved[key],before[key]);
    assert.equal(saved.protocolFeesRequested,true);assert.equal(saved.protocolClaimStage,'activate');
  }
});

test('explicit collection queues at unsigned reward boundaries while preserving live or paused rewards',async t=>{
  for(const state of ['live','paused','error'])for(const pendingRewards of ['cycle','request','both']){
    const launch=fixture();launch.state=state;launch.autoFees=state==='live';
    launch.feesRequested=pendingRewards!=='cycle';
    if(pendingRewards!=='request')launch.cycle={stage:'payout',index:1,payouts:[{owner:address(),amount:'17'},{owner:address(),amount:'29'}],slot:400,claimedQuote:'46'};
    launch.rewardRetry={at:999999,attempt:2,reason:'Token-account scan temporarily unavailable.'};
    launch.error='Saved holder reward work must survive collection.';
    const h=await harness(t,[launch]),before=structuredClone(launch);
    assert.deepEqual(protocolFeeEligibility(launch),{allowed:true,reason:''});assert.deepEqual(launch,before);
    assert.equal((await h.service.coins(admin)).coins[0].eligibility.allowed,true);
    await h.service.claim(admin,body(launch));const saved=h.books.get(user).launches[0];
    for(const key of ['cycle','credits','operations','autoFees','feesRequested','input','review','state','error','rewardRetry','gas','keys'])assert.deepEqual(saved[key],before[key],key);
    assert.equal(saved.protocolFeesRequested,true);assert.equal(saved.protocolClaimStage,'claim');assert.equal(h.kicks,1);
  }
});

test('explicit collection still blocks protocol, setup and branding transactions without changing rewards',async t=>{
  for(const blocker of [
    {operation:{kind:'protocol-lp-claim',state:'pending',signature:'saved-payout',raw:'private-signed-bytes'}},
    {operation:{kind:'platform-brand-update',state:'pending',signature:'saved-branding',raw:'private-signed-bytes'}},
    {operation:{kind:'protocol-payout',state:'awaiting_signature',unsignedRaw:'private-unsigned-bytes'}},
    {protocolFeesRequested:true},
    {brandingRequested:true},
  ]){
    const launch=fixture();launch.state='paused';launch.feesRequested=true;launch.cycle={stage:'payout',index:2};
    if(blocker.operation)launch.operations.push(blocker.operation);else Object.assign(launch,blocker);
    const h=await harness(t,[launch]),before=structuredClone(h.books.get(user));
    assert.equal(protocolFeeEligibility(launch).allowed,false);
    await assert.rejects(h.service.claim(admin,body(launch)),error=>error.statusCode===409);
    assert.deepEqual(h.books.get(user),before);assert.equal(h.bookWrites,0);assert.equal(h.kicks,0);
  }
});

test('one-coin collection checks fresh fees despite saved credit and never queues other coins',async t=>{
  const curve=fixture(1),another=fixture(2),remote=fixture(3);curve.input.symbol='LAUNCHPAD';
  curve.protocolCredit='9704822000';curve.protocolBaseCredit='123';curve.protocolClaimStage='payout';
  curve.cycle={stage:'payout',index:1};curve.feesRequested=true;
  const h=await harness(t,[curve,another]);h.books.get(other).launches.push(remote);
  const before=structuredClone([...h.books]),request=body(curve);
  const first=await h.service.claim(admin,request),saved=h.books.get(user).launches[0];
  assert.equal(first.alreadyRequested,false);assert.equal(saved.protocolFeesRequested,true);assert.equal(saved.protocolClaimStage,'claim');
  for(const key of ['protocolCredit','protocolBaseCredit','credits','cycle','feesRequested','operations','input','review','keys'])assert.deepEqual(saved[key],curve[key],key);
  assert.deepEqual(h.books.get(user).launches[1],another);assert.deepEqual(h.books.get(other),new Map(before).get(other));assert.deepEqual(h.books.get(admin),new Map(before).get(admin));
  assert.equal(h.bookWrites,1);assert.equal(saved.protocolClaimRequests.length,1);assert.equal(saved.protocolClaimRequests[0].batchRequestId,undefined);
  assert.equal((await h.service.claim(admin,request)).alreadyRequested,true);assert.equal(h.bookWrites,1);assert.equal(h.books.get(user).launches[0].protocolClaimRequests.length,1);
});

test('queued legacy activation rejects a second request but the original request remains idempotent',async t=>{
  const launch=fixture(1,true),h=await harness(t,[launch]),request=body(launch);
  const results=await Promise.allSettled([h.service.activate(admin,request),h.service.activate(admin,{...request,requestId:'2'.repeat(32)})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/already queued/);
  assert.equal(h.books.get(user).launches[0].protocolClaimRequests.length,1);assert.equal(h.kicks,1);
  assert.equal((await h.service.activate(admin,request)).alreadyRequested,true);
  assert.equal(h.books.get(user).launches[0].protocolClaimRequests.length,1);
});

test('legacy activation reports the exact unresolved operation without exposing its signed bytes',async t=>{
  for(const state of ['pending','awaiting_signature']){
    const launch=fixture(1,true),operation={kind:'buy',state,signature:'saved-signature',createdAt:123,raw:'private-signed-bytes',unsignedRaw:'unsigned-bytes'};
    launch.cycle={stage:'distribute'};launch.operations.push(operation);const h=await harness(t,[launch]),before=structuredClone(h.books.get(user));
    const coin=(await h.service.coins(admin)).coins[0];assert.equal(coin.activation.allowed,false);
    assert.deepEqual(coin.activation.blockingOperation,{kind:'buy',state,signature:'saved-signature',createdAt:123});
    assert(!JSON.stringify(coin).includes('private-signed-bytes'));assert(!JSON.stringify(coin).includes('unsigned-bytes'));
    await assert.rejects(h.service.activate(admin,body(launch)),e=>e.statusCode===409&&/saved buy transaction/.test(e.message));
    assert.deepEqual(h.books.get(user),before);assert.equal(h.kicks,0);
  }
  const launch=fixture(1,true);launch.brandingRequested=true;const h=await harness(t,[launch]);
  await assert.rejects(h.service.activate(admin,body(launch)),/branding update/);assert.equal(h.kicks,0);
});

test('upgrading a legacy fee targets 75% locked LP and 0.5% creator fees without a retroactive creation charge',async t=>{
  const launch=fixture(1,true),h=await harness(t,[launch],{recipient:address(),lpPolicy:'platform_locked',platformLpPercent:75,creationFeeSol:'0.03',autoHarvest:true});
  await h.service.activate(admin,body(launch));const saved=h.books.get(user).launches[0];
  assert.equal(saved.protocolActivation.lpPolicy,'platform_locked');assert.equal(saved.protocolActivation.platformLpPercent,75);assert.equal(saved.protocolActivation.creatorFeeRatePpm,0);assert.equal(saved.protocolActivation.upgradeVersion,3);assert.equal(saved.protocolActivation.creationFeeSol,'0');assert.equal(saved.review.platformFeeBps,0);
});

test('unsafe or unsettled launches cannot queue protocol collection or activation',async t=>{
  const changes=[l=>{delete l.authorizedAt;},l=>{delete l.curve;},l=>{l.input.network='devnet';},l=>{l.feeCustody='legacy';},l=>{l.keys.wallet.external=true;},l=>{delete l.keys.wallet.secret;},l=>{l.keys.payer=l.keys.wallet;},l=>{l.walletExportedAt=1;},l=>{l.feeWalletExportedAt=1;},l=>{l.keys.wallet.exportedAt=1;},l=>{l.operations.push({kind:'create',state:'pending'});},l=>{l.operations.push({kind:'setup-refund',state:'awaiting_signature'});}];
  for(const change of changes){const launch=fixture();change(launch);const h=await harness(t,[launch]),before=structuredClone(h.books.get(user));await assert.rejects(h.service.claim(admin,body(launch)),e=>e.statusCode===409);assert.deepEqual(h.books.get(user),before);assert.equal(h.kicks,0);}
  const legacy=fixture(2,true);delete legacy.keys.platform.secret;assert.equal(protocolFeeEligibility(legacy,{activate:true}).allowed,false);
});

test('protocol inventory rejects cross-account fee/platform sharing and personal authorities without leaking secrets',async t=>{
  const launch=fixture(),h=await harness(t,[launch]),otherLaunch=fixture(2);otherLaunch.keys.platform=launch.keys.platform;h.books.get(other).launches.push(otherLaunch);
  const listing=await h.service.coins(admin);assert.equal(listing.coins.length,2);assert.equal(listing.coins[0].eligibility.allowed,false);assert(!JSON.stringify(listing).includes(launch.keys.platform.secret));
  await assert.rejects(h.service.claim(admin,body(launch)),/Shared/);otherLaunch.keys.platform=newLaunchKeys().wallet;otherLaunch.keys.wallet=launch.keys.wallet;await assert.rejects(h.service.claim(admin,body(launch)),/Shared/);
  h.books.get(other).launches=[];h.users.get(other).mainWallet=launch.keys.platform.address;await assert.rejects(h.service.claim(admin,body(launch)),/Shared/);assert.equal(h.kicks,0);
});

test('protocol actions reject forged request data and authorization revoked during inventory',async t=>{
  const launch=fixture(),h=await harness(t,[launch]);
  for(const extra of [{accountId:'bad'},{id:'bad'},{requestId:'bad'},{reason:'no'},{reason:'x'.repeat(501)}])await assert.rejects(h.service.claim(admin,body(launch,extra)));
  const list=h.accounts.list;h.accounts.list=async()=>{const result=await list();h.users.get(admin).mfaEnabled=false;return result;};
  await assert.rejects(h.service.claim(admin,body(launch)),/Administrator/);assert.equal(h.bookWrites,0);assert.equal(h.kicks,0);
});


test('new-launch LP policy is 75% locked even on explicit legacy burn hosts without rewriting historical launches',async t=>{
  const launch=fixture(),h=await harness(t,[launch],{recipient:address(),lpPolicy:'burn',platformLpPercent:0,liquidityPolicyVersion:1,autoHarvest:false}),before=structuredClone(h.books.get(user));
  const view=await launchProtocolPolicy(h.accounts);
  assert.equal(view.lpPolicy,'platform_locked');assert.equal(view.platformLpPercent,75);assert.equal(view.taxRevenueShareBps,500);assert.equal(view.autoHarvest,false);
  assert.equal(h.hostWrites,0);assert.deepEqual(h.books.get(user),before);
  assert.deepEqual((await h.service.coins(admin)).coins[0].lpPolicy,{lpPolicy:'burn',platformLpPercent:0});
  await assert.rejects(h.service.configure(admin,{recipient:h.host.recipient,expectedRecipient:h.host.recipient,lpPolicy:'burn',reason:'Stale client attempts the old burn policy.'}),/75% permanently locked/);
  assert.equal(h.host.lpPolicy,'burn');assert.equal(h.hostWrites,0);assert.equal((await launchProtocolPolicy(h.accounts)).lpPolicy,'platform_locked');
  assert.deepEqual(h.books.get(user),before);
});


test('protocol inventory identifies a dedicated service wallet independently of activation and pending work',async t=>{
  const launch=fixture(),h=await harness(t,[launch]);
  let coin=(await h.service.coins(admin)).coins[0];assert.equal(coin.serviceWalletManaged,true);assert.equal(coin.activation.allowed,true);
  h.books.get(user).launches[0].operations.push({kind:'protocol-claim',state:'pending'});
  coin=(await h.service.coins(admin)).coins[0];assert.equal(coin.serviceWalletManaged,true);assert.equal(coin.eligibility.allowed,false);
  const changes=[l=>{l.feeCustody='legacy';},l=>{l.keys.wallet.external=true;},l=>{delete l.keys.wallet.secret;},l=>{l.keys.payer=l.keys.wallet;},l=>{l.walletExportedAt=1;},l=>{l.feeWalletExportedAt=1;},l=>{l.keys.wallet.exportedAt=1;}];
  for(const change of changes){const candidate=structuredClone(launch);change(candidate);h.books.get(user).launches=[candidate];assert.equal((await h.service.coins(admin)).coins[0].serviceWalletManaged,false);}
  h.books.get(user).launches=[structuredClone(launch)];h.users.get(other).mainWallet=launch.keys.wallet.address;
  assert.equal((await h.service.coins(admin)).coins[0].serviceWalletManaged,false);
  h.users.get(other).mainWallet=address();const second=fixture(2);second.keys.platform=launch.keys.platform;h.books.get(other).launches=[second];
  const listing=await h.service.coins(admin);assert(listing.coins.every(c=>c.serviceWalletManaged===false));assert(!JSON.stringify(listing).includes(launch.keys.wallet.secret));
});


test('a previously enabled 1% fee can upgrade its creator and LP policy, while stale clients cannot broaden an old activation',async t=>{
  const launch=fixture(),h=await harness(t,[launch]);
  assert.equal((await h.service.coins(admin)).coins[0].policyCurrent,false);
  await assert.rejects(h.service.activate(admin,body(launch,{policyVersion:undefined})),/Refresh the Admin panel/);assert.equal(h.bookWrites,0);
  await h.service.activate(admin,body(launch));const saved=h.books.get(user).launches[0];
  assert.equal(saved.protocolActivation.creatorFeeRatePpm,0);assert.equal(saved.protocolActivation.platformLpPercent,75);assert.equal(saved.review.platformFeeBps,100);assert.equal(saved.creatorFees,undefined);
});
test('fully upgraded and exported platform authorities cannot queue another policy change',async t=>{
  for(const mutate of [l=>{l.keys.platform.exportedAt=1;},l=>{l.keys.platform.external=true;},l=>{l.creatorFees={status:'graduated',ratePpm:2500};},l=>{l.review.protocolFees={recipient:address(),lpPolicy:'platform_locked',platformLpPercent:75};l.creatorFees={policy:'taxed-holders-0-v3',ratePpm:0};}]){
    const launch=fixture();mutate(launch);const h=await harness(t,[launch]);await assert.rejects(h.service.activate(admin,body(launch)));assert.equal(h.bookWrites,0);
  }
});

test('real legacy custody uses its separate platform key even when the creator is the personal, shared or exported payer',async t=>{
  for(const custody of [undefined,'creator','legacy']){
    const launch=fixture(1,true);if(custody===undefined)delete launch.feeCustody;else launch.feeCustody=custody;
    launch.keys.payer=launch.keys.wallet;launch.walletExportedAt=1;launch.keys.wallet.exportedAt=1;
    const h=await harness(t,[launch]),second=fixture(2,true);second.keys.wallet=launch.keys.wallet;h.books.get(other).launches=[second];h.users.get(user).mainWallet=launch.keys.wallet.address;
    const before=structuredClone(launch),coin=(await h.service.coins(admin)).coins[0];
    assert.equal(coin.activation.allowed,true);assert.equal(coin.eligibility.allowed,false);assert.equal(coin.feeWallet,launch.keys.platform.address);assert.equal(coin.creatorFeeWallet,launch.keys.wallet.address);assert.equal(coin.serviceWalletForUpgrade,true);assert.equal(coin.serviceWalletManaged,true);assert.equal(coin.gas.initialReserveSol,'0');
    const request=body(launch);await h.service.activate(admin,request);const saved=h.books.get(user).launches[0];
    assert.deepEqual(saved.protocolActivation.protocolFeeWallet,{source:'platform',address:launch.keys.platform.address});assert.equal(saved.protocolFeeWallet,undefined);
    for(const field of ['keys','feeCustody','input','review','credits','autoFees'])assert.deepEqual(saved[field],before[field]);
    assert.equal((await h.service.activate(admin,request)).alreadyRequested,true);assert.equal(h.bookWrites,1);
    assert(!JSON.stringify(coin).includes(launch.keys.platform.secret));
  }
});

test('legacy platform upgrades require a recoverable exclusive platform key, independently of creator custody',async t=>{
  const mutations=[l=>{delete l.keys.platform;},l=>{delete l.keys.platform.secret;},l=>{l.keys.platform.external=true;},l=>{l.keys.platform.exportedAt=1;},l=>{l.platformWalletExportedAt=1;},l=>{l.keys.platform=l.keys.wallet;},l=>{l.keys.platform=l.keys.payer;},l=>{l.protocolCredit='1';},l=>{l.protocolBaseCredit='1';},l=>{l.review.platformFeeBps=100;}];
  for(const mutate of mutations){
    const launch=fixture(1,true);delete launch.feeCustody;mutate(launch);const h=await harness(t,[launch]),before=structuredClone(h.books.get(user));
    assert.equal((await h.service.coins(admin)).coins[0].activation.allowed,false);await assert.rejects(h.service.activate(admin,body(launch)),e=>e.statusCode===409);assert.deepEqual(h.books.get(user),before);
  }
  for(const role of ['wallet','payer','platform','mainWallet']){
    const launch=fixture(1,true);delete launch.feeCustody;const h=await harness(t,[launch]),second=fixture(2);
    if(role==='mainWallet')h.users.get(other).mainWallet=launch.keys.platform.address;else{second.keys[role]=launch.keys.platform;h.books.get(other).launches=[second];}
    const row=(await h.service.coins(admin)).coins[0];assert.equal(row.activation.allowed,false);assert.equal(row.serviceWalletForUpgrade,false);await assert.rejects(h.service.activate(admin,body(launch)),/launch owner|shared by multiple live launches/);
  }
});

test('a confirmed legacy protocol wallet supports collection while retaining creator ownership and export rights',async t=>{
  const launch=fixture();delete launch.feeCustody;launch.keys.payer=launch.keys.wallet;launch.walletExportedAt=1;launch.protocolFeeWallet={source:'platform',address:launch.keys.platform.address};
  const h=await harness(t,[launch]);h.users.get(user).mainWallet=launch.keys.wallet.address;const row=(await h.service.coins(admin)).coins[0];
  assert.equal(row.eligibility.allowed,true);assert.equal(row.serviceWalletManaged,true);assert.equal(row.serviceWalletForUpgrade,false);assert.equal(row.feeWallet,launch.keys.platform.address);
  await h.service.claim(admin,body(launch));const saved=h.books.get(user).launches[0];assert.equal(saved.protocolClaimStage,'claim');assert.equal(saved.feeCustody,undefined);
  const exported=await h.launchpad.exportWallet(user,launch.id);assert.equal(exported.publicKey,launch.keys.wallet.address);assert.notEqual(exported.privateKey,launch.keys.platform.secret);
});


test('owner-authorized same-key legacy upgrade creates a distinct durable protocol signer without changing creator custody',async t=>{
  const launch=fixture(1,true);delete launch.feeCustody;launch.keys.platform=launch.keys.wallet;launch.keys.payer=launch.keys.wallet;
  launch.walletExportedAt=1;launch.keys.wallet.exportedAt=1;
  const h=await harness(t,[launch]);h.users.get(user).role='admin';h.users.get(user).mainWallet=launch.keys.wallet.address;
  const before=structuredClone(launch),row=(await h.service.coins(user)).coins[0];
  assert.equal(row.activation.allowed,true);assert.equal(row.serviceWalletForUpgrade,true);assert.equal(row.separateProtocolWalletForUpgrade,true);assert.equal(row.feeWallet,launch.keys.platform.address);
  const request=body(launch),result=await h.service.activate(user,request),saved=h.books.get(user).launches[0],key=saved.keys.protocol;
  assert(key.secret);assert.notEqual(key.address,launch.keys.wallet.address);assert.deepEqual(saved.protocolActivation.protocolFeeWallet,{source:'protocol',address:key.address});assert.equal(saved.protocolFeeWallet,undefined);
  for(const field of ['input','review','credits','operations','feeCustody','autoFees'])assert.deepEqual(saved[field],before[field]);
  for(const role of ['wallet','payer','platform','mint'])assert.deepEqual(saved.keys[role],before.keys[role]);
  assert.equal(result.coin.protocolFeeWalletAddress,key.address);assert.equal(result.coin.feeWallet,launch.keys.platform.address);
  assert(!JSON.stringify(result).includes(key.secret));assert(!JSON.stringify(result).includes(launch.keys.wallet.secret));
  await h.service.activate(user,request);assert.equal(h.bookWrites,1);assert.equal(h.books.get(user).launches[0].keys.protocol.address,key.address);
  saved.protocolFeesRequested=false;saved.protocolError='A temporary preparation failure.';
  await h.service.activate(user,{...request,requestId:'2'.repeat(32)});assert.equal(h.books.get(user).launches[0].keys.protocol.address,key.address);assert.equal(h.bookWrites,2);
});

test('a different administrator cannot authorize a personal legacy platform or generate its protocol key',async t=>{
  const launch=fixture(1,true);delete launch.feeCustody;launch.keys.platform=launch.keys.wallet;const h=await harness(t,[launch]);
  const row=(await h.service.coins(admin)).coins[0];assert.equal(row.activation.allowed,false);assert.match(row.activation.reason,/launch owner/);
  await assert.rejects(h.service.activate(admin,body(launch)),/launch owner/);assert.equal(h.bookWrites,0);assert.equal(h.books.get(user).launches[0].keys.protocol,undefined);
});

test('owner legacy fallback rejects missing, external and compromised administrators with specific reasons',async t=>{
  for(const [mutate,reason]of [
    [l=>{delete l.keys.platform.secret;},/administrator key is missing/],
    [l=>{l.keys.platform.external=true;},/external wallet/],
    [l=>{l.keys.platform.compromised=true;},/compromised/],
    [l=>{l.keys.platform.compromisedAt=1;},/compromised/],
    [l=>{l.platformWalletCompromisedAt=1;},/compromised/],
  ]){
    const launch=fixture(1,true);delete launch.feeCustody;mutate(launch);const h=await harness(t,[launch]);h.users.get(user).role='admin';
    const row=(await h.service.coins(user)).coins[0];assert.equal(row.activation.allowed,false);assert.match(row.activation.reason,reason);
    await assert.rejects(h.service.activate(user,body(launch)),reason);assert.equal(h.bookWrites,0);
  }
});

test('duplicate records of one actual curve do not block its dedicated platform upgrade',async t=>{
  const launch=fixture(1,true);delete launch.feeCustody;const duplicate=structuredClone(launch);duplicate.id='2'.repeat(32);
  const h=await harness(t,[launch,duplicate]),rows=(await h.service.coins(admin)).coins;
  assert(rows.every(row=>row.activation.allowed&&row.serviceWalletForUpgrade));await h.service.activate(admin,body(launch));
  assert.equal(h.books.get(user).launches[0].protocolActivation.protocolFeeWallet.source,'platform');
});

test('a genuinely shared platform config cannot be upgraded per-coin even by its owner',async t=>{
  const launch=fixture(1,true);delete launch.feeCustody;const second=fixture(2,true);second.keys.platform=launch.keys.platform;
  const h=await harness(t,[launch,second]);h.users.get(user).role='admin';const row=(await h.service.coins(user)).coins[0];
  assert.equal(row.activation.allowed,false);assert.match(row.activation.reason,/shared by multiple live launches/);
  await assert.rejects(h.service.activate(user,body(launch)),/shared by multiple live launches/);assert.equal(h.bookWrites,0);
});

test('confirmed fresh protocol collection ignores retained personal administrator custody while checking its own signer',async t=>{
  const launch=fixture();delete launch.feeCustody;launch.keys.platform=launch.keys.wallet;launch.keys.payer=launch.keys.wallet;launch.keys.wallet.exportedAt=1;
  launch.keys.protocol={...newLaunchKeys().wallet,createdAt:1,purpose:'protocol-fees'};launch.protocolFeeWallet={source:'protocol',address:launch.keys.protocol.address};
  const h=await harness(t,[launch]);h.users.get(user).mainWallet=launch.keys.wallet.address;
  const row=(await h.service.coins(admin)).coins[0];assert.equal(row.eligibility.allowed,true);assert.equal(row.serviceWalletManaged,true);assert.equal(row.feeWallet,launch.keys.protocol.address);assert.equal(row.serviceWalletForUpgrade,false);
  assert(!JSON.stringify(row).includes(launch.keys.protocol.secret));await h.service.claim(admin,body(launch));assert.equal(h.books.get(user).launches[0].protocolClaimStage,'claim');
  h.books.get(user).launches[0].protocolFeesRequested=false;h.users.get(other).mainWallet=launch.keys.protocol.address;
  await assert.rejects(h.service.claim(admin,{...body(launch),requestId:'2'.repeat(32)}),/Shared or personal fee keys/);
});


test('a saved future protocol wallet cannot be reused when it is shared, personal or exported',async t=>{
  for(const conflict of ['shared','personal','exported']){
    const launch=fixture(1,true);delete launch.feeCustody;launch.keys.platform=launch.keys.wallet;launch.keys.protocol=newLaunchKeys().wallet;
    const h=await harness(t,[launch]);h.users.get(user).role='admin';
    if(conflict==='shared'){const second=fixture(2);second.keys.wallet=launch.keys.protocol;h.books.get(other).launches=[second];}
    if(conflict==='personal')h.users.get(other).mainWallet=launch.keys.protocol.address;
    if(conflict==='exported')launch.protocolWalletExportedAt=1;
    await assert.rejects(h.service.activate(user,body(launch)),/shared or personal|signer is unavailable/);assert.equal(h.bookWrites,0);
  }
});


test('retry retains the prepared protocol wallet when the original administrator later appears exclusive',async t=>{
  const launch=fixture(1,true);delete launch.feeCustody;const h=await harness(t,[launch]);h.users.get(user).role='admin';h.users.get(user).mainWallet=launch.keys.platform.address;
  await h.service.activate(user,body(launch));const saved=h.books.get(user).launches[0],prepared=structuredClone(saved.keys.protocol);
  assert.equal(saved.protocolActivation.protocolFeeWallet.source,'protocol');saved.protocolFeesRequested=false;h.users.get(user).mainWallet=address();
  const row=(await h.service.coins(user)).coins[0];assert.equal(row.activation.allowed,true);assert.equal(row.separateProtocolWalletForUpgrade,true);assert.equal(row.protocolFeeWalletAddress,prepared.address);
  await h.service.activate(user,{...body(launch),requestId:'2'.repeat(32)});const retried=h.books.get(user).launches[0];
  assert.deepEqual(retried.keys.protocol,prepared);assert.deepEqual(retried.protocolActivation.protocolFeeWallet,{source:'protocol',address:prepared.address});
  assert.equal((await h.service.coins(admin)).coins[0].activation.allowed,false);
});

test('invalid prepared protocol signer flags disable the owner upgrade before submission',async t=>{
  for(const mutate of [l=>{delete l.keys.protocol.secret;},l=>{l.keys.protocol.external=true;},l=>{l.keys.protocol.exportedAt=1;},l=>{l.keys.protocol.compromisedAt=1;},l=>{l.protocolWalletExportedAt=1;},l=>{l.keys.protocol=l.keys.wallet;}]){
    const launch=fixture(1,true);delete launch.feeCustody;launch.keys.protocol=newLaunchKeys().wallet;mutate(launch);
    const h=await harness(t,[launch]);h.users.get(user).role='admin';const row=(await h.service.coins(user)).coins[0];
    assert.equal(row.activation.allowed,false);assert.match(row.activation.reason,/signer is unavailable/);assert.equal(h.bookWrites,0);
  }
});

test('a verified launch restored by setup recovery can queue its owner-authorized legacy upgrade without resetting rewards',async t=>{
  const launch=fixture(1,true),curve=launch.curve,persisted=[];delete launch.feeCustody;delete launch.curve;
  launch.keys.platform=launch.keys.wallet;launch.keys.payer=launch.keys.wallet;launch.keys.wallet.exportedAt=1;launch.walletExportedAt=1;
  launch.state='error';launch.phase='verify';launch.error='The creation verification request timed out.';
  let verifications=0,broadcasts=0;
  const chain={
    addresses:()=>({pool:new PublicKey(curve),m:new PublicKey(launch.keys.mint.address)}),
    receipt:async op=>({slot:999,transaction:{signatures:[op.signature]},meta:{err:null}}),
    verifyLaunch:async candidate=>{assert.equal(candidate.keys.mint.address,launch.keys.mint.address);verifications++;return{curve};},
    broadcast:async()=>{broadcasts++;},
    c:{getEpochInfo:async()=>({blockHeight:500,absoluteSlot:1000}),getMultipleAccountsInfoAndContext:async(keys,options)=>{
      assert.deepEqual(keys.map(String),[curve,launch.keys.mint.address]);assert.equal(options.commitment,'finalized');assert.equal(options.minContextSlot,1000);
      return{context:{slot:1000},value:[{},{}]};
    }}
  };
  assert.equal(await recoverFailedLaunch({launch,chain,persist:async()=>persisted.push(structuredClone(launch)),now:2000000}),true);
  assert.equal(verifications,1);assert.equal(broadcasts,0);assert.equal(launch.curve,curve);assert.equal(launch.state,'live');assert.equal(launch.recovery.status,'not-needed');
  assert.equal(launch.recovery.refundedLamports,'0');assert.equal(persisted.at(-1).recovery.status,'not-needed');assert(!launch.operations.some(op=>op.kind==='setup-refund'));
  // This successful launch later has ordinary enabled holder work and a saved retry.
  launch.autoFees=true;launch.feesRequested=true;launch.feeAutomation={enabled:true,source:'user',updatedAt:2000100};
  launch.cycle={stage:'payout',index:1,payouts:[{owner:address(),amount:'17'},{owner:address(),amount:'29'}],claimedQuote:'46',slot:1100};
  launch.rewardRetry={attempt:1,at:2060000,kind:'network',reason:'RPC request timed out.'};
  launch.taxProtocol={baseCredit:'101',quoteCredit:'202'};
  const h=await harness(t,[launch]);h.users.get(user).role='admin';h.users.get(user).mainWallet=launch.keys.wallet.address;
  const before=structuredClone(launch),row=(await h.service.coins(user)).coins[0];
  assert.equal(row.activation.allowed,true);assert.equal(row.serviceWalletForUpgrade,true);assert.equal(row.separateProtocolWalletForUpgrade,true);
  await h.service.activate(user,body(launch));const saved=h.books.get(user).launches[0];
  assert(saved.keys.protocol.secret);assert.notEqual(saved.keys.protocol.address,before.keys.wallet.address);
  assert.deepEqual(saved.protocolActivation.protocolFeeWallet,{source:'protocol',address:saved.keys.protocol.address});assert.equal(saved.protocolClaimStage,'activate');
  for(const field of ['recovery','credits','cycle','taxProtocol','autoFees','feesRequested','feeAutomation','rewardRetry','operations','input','review','gas','state','phase'])assert.deepEqual(saved[field],before[field],field);
  for(const role of ['wallet','payer','platform','mint'])assert.deepEqual(saved.keys[role],before.keys[role],role);
  assert.equal(h.bookWrites,1);assert.equal(h.kicks,1);assert.equal(broadcasts,0);
});

test('unfinished or unknown setup recovery still blocks owner-authorized legacy policy upgrades',async t=>{
  for(const status of ['checking','refunding','blocked','complete','unknown','',undefined]){
    const launch=fixture(1,true);delete launch.feeCustody;launch.keys.platform=launch.keys.wallet;launch.keys.payer=launch.keys.wallet;
    launch.recovery={status,reason:'Saved setup recovery.',refundedLamports:'0'};
    const h=await harness(t,[launch]);h.users.get(user).role='admin';h.users.get(user).mainWallet=launch.keys.wallet.address;const before=structuredClone(h.books.get(user));
    assert.equal((await h.service.coins(user)).coins[0].activation.allowed,false,`recovery status ${String(status)}`);
    await assert.rejects(h.service.activate(user,body(launch)),e=>e.statusCode===409);assert.deepEqual(h.books.get(user),before);assert.equal(h.bookWrites,0);assert.equal(h.kicks,0);
  }
});

test('successful recovery history does not bypass incomplete launch or pending transaction checks',async t=>{
  for(const [label,mutate]of [
    ['missing curve',l=>{delete l.curve;}],
    ['missing authorization',l=>{delete l.authorizedAt;}],
    ['pending transaction',l=>{l.operations.push({kind:'sell',state:'pending',signature:'saved-sale',createdAt:123});}],
    ['pending setup refund',l=>{l.operations.push({kind:'setup-refund',state:'pending',signature:'saved-refund',createdAt:123});}],
    ['wallet signature pending',l=>{l.operations.push({kind:'payout',state:'awaiting_signature',unsignedRaw:'unsigned-bytes',createdAt:123});}],
  ]){
    const launch=fixture(1,true);delete launch.feeCustody;launch.keys.platform=launch.keys.wallet;launch.keys.payer=launch.keys.wallet;
    launch.recovery={status:'not-needed',reason:'The original launch succeeded onchain.',refundedLamports:'0'};mutate(launch);
    const h=await harness(t,[launch]);h.users.get(user).role='admin';h.users.get(user).mainWallet=launch.keys.wallet.address;const before=structuredClone(h.books.get(user));
    const row=(await h.service.coins(user)).coins[0];
    if(label==='missing curve')assert.equal(row,undefined,'unverified launches stay out of the live inventory');else assert.equal(row.activation.allowed,false,label);
    assert.equal(protocolFeeEligibility(launch,{activate:true,ownerMatch:true}).allowed,false,label);
    if(label==='pending transaction'||label==='pending setup refund'||label==='wallet signature pending')assert.equal(row.activation.blockingOperation.kind,launch.operations.at(-1).kind);
    await assert.rejects(h.service.activate(user,body(launch)),e=>e.statusCode===409);assert.deepEqual(h.books.get(user),before);assert.equal(h.bookWrites,0);assert.equal(h.kicks,0);
  }
});

test('successful recovery history preserves nonlegacy administrator export restrictions',async t=>{
  for(const exported of ['key','launch']){
    const launch=fixture();launch.recovery={status:'not-needed',reason:'The original launch succeeded onchain.',refundedLamports:'0'};
    if(exported==='key')launch.keys.platform.exportedAt=1;else launch.platformWalletExportedAt=1;
    const h=await harness(t,[launch]),before=structuredClone(h.books.get(user));
    assert.equal((await h.service.coins(admin)).coins[0].activation.allowed,false);
    await assert.rejects(h.service.activate(admin,body(launch)),e=>e.statusCode===409);assert.deepEqual(h.books.get(user),before);assert.equal(h.bookWrites,0);assert.equal(h.kicks,0);
  }
});

test('ordinary fee settings cannot redirect an active or unresolved managed treasury',async t=>{
  for(const state of [{enabled:true},{activation:{at:1}},{pending:{signature:'saved'}}]){
    const h=await harness(t,[]),managed=h.host.recipient;
    await h.accounts.hostStore.write('protocol-treasury',{wallet:{address:managed},...state});
    await assert.rejects(h.service.configure(admin,{recipient:address(),expectedRecipient:managed,reason:'Attempt recipient change while treasury active'}),e=>e.statusCode===409&&/Pause treasury/.test(e.message));
    assert.equal(h.host.recipient,managed);
    await h.service.configure(admin,{recipient:managed,expectedRecipient:managed,reason:'Update independent creation fee',creationFeeSol:'0.02'});
    assert.equal(h.host.creationFeeSol,'0.02');assert.equal(h.host.recipient,managed);
  }
  const h=await harness(t,[]),managed=h.host.recipient,newRecipient=address();
  await h.accounts.hostStore.write('protocol-treasury',{wallet:{address:managed},enabled:false});
  await h.service.configure(admin,{recipient:newRecipient,expectedRecipient:managed,reason:'Rotate after pausing and reconciling'});
  assert.equal(h.host.recipient,newRecipient);
});

test('already 75/25 taxed holder launch can explicitly remove its old 0.5% creator fee without changing tax',async t=>{
  const launch=fixture();launch.review.protocolFees={...launch.review.protocolFees,lpPolicy:'platform_locked',platformLpPercent:75};launch.creatorFees={policy:'flat-0.5-v2',ratePpm:5000};launch.input.taxBps=500;const h=await harness(t,[launch]);
  const before=(await h.service.coins(admin)).coins[0];assert.equal(before.policyCurrent,false);assert.equal(before.activation.allowed,true);assert.equal(before.policyTarget.upgradeVersion,3);assert.equal(before.policyTarget.creatorFeeRatePpm,0);assert.equal(before.policyTarget.creatorFeePolicy,'taxed-holders-0-v3');
  await h.service.activate(admin,body(launch));const saved=h.books.get(user).launches[0];assert.equal(saved.protocolActivation.creatorFeeRatePpm,0);assert.equal(saved.creatorFees.ratePpm,5000);assert.equal(saved.input.taxBps,500);assert.equal(saved.review.protocolFees.platformLpPercent,75);
});


test('manual protocol claims queue behind saved reward transactions without altering or signing them',async t=>{
  for(const kind of ['claim','tax','tax-burn','sell','buy','burn','payout','tax-protocol-payout','reward-handoff'])for(const state of ['pending','awaiting_signature']){
    const launch=fixture();launch.state='paused';launch.feesRequested=true;launch.cycle={stage:'distribute',index:2,payouts:[{owner:address(),amount:'99'}]};
    const operation={kind,state,signature:'saved-reward-signature',createdAt:100,raw:'private-signed-bytes',unsignedRaw:'private-unsigned-bytes'};launch.operations.push(operation);
    const h=await harness(t,[launch]),before=structuredClone(launch),eligibility=protocolFeeEligibility(launch);
    assert.equal(eligibility.allowed,true);assert.deepEqual(eligibility.waitingForOperation,{kind,state,signature:operation.signature,createdAt:100});assert.equal(protocolFeeEligibility(launch,{activate:true}).allowed,false);
    const reply=await h.service.claim(admin,body(launch)),saved=h.books.get(user).launches[0];
    for(const field of ['operations','keys','credits','gas','cycle','feesRequested','state','autoFees'])assert.deepEqual(saved[field],before[field],field);
    assert.equal(saved.protocolFeesRequested,true);assert.equal(saved.protocolClaimStage,'claim');assert.equal(reply.coin.requested,true);assert.deepEqual(reply.coin.waitingForOperation,eligibility.waitingForOperation);assert.equal(reply.coin.pending,false);assert.equal(reply.coin.eligibility.allowed,false);
    assert.doesNotMatch(JSON.stringify(reply),/private-signed-bytes|private-unsigned-bytes/);
    const replay=await h.service.claim(admin,body(launch));assert.equal(replay.alreadyRequested,true);assert.equal(h.bookWrites,1);
  }
});

test('a reward operation cannot conceal a second unsettled protocol operation',async t=>{
  const launch=fixture();launch.operations.push({kind:'payout',state:'pending'},{kind:'protocol-lp-payout',state:'pending'});
  const h=await harness(t,[launch]);assert.equal(protocolFeeEligibility(launch).allowed,false);await assert.rejects(h.service.claim(admin,body(launch)),/awaiting confirmation/);assert.equal(h.bookWrites,0);
});

test('collect all queues reward receipt and signature waits while retaining protocol blockers',async t=>{
  const receipt=fixture(1),signature=fixture(2),protocol=fixture(3);
  receipt.operations.push({kind:'payout',state:'pending',raw:'private-receipt'});signature.operations.push({kind:'claim',state:'awaiting_signature',unsignedRaw:'private-unsigned'});protocol.operations.push({kind:'protocol-claim',state:'pending'});
  const h=await harness(t,[receipt,signature,protocol]),before=structuredClone(h.books.get(user)),result=await h.service.claimAll(admin,{requestId:'d1'.repeat(16)});
  assert.deepEqual(result.queued.map(row=>row.id),[receipt.id,signature.id]);assert.equal(result.skipped.length,1);assert.equal(result.skipped[0].id,protocol.id);assert.equal(result.failed.length,0);
  for(let i=0;i<3;i++)assert.deepEqual(h.books.get(user).launches[i].operations,before.launches[i].operations);
  assert.equal(h.books.get(user).launches[0].protocolFeesRequested,true);assert.equal(h.books.get(user).launches[1].protocolFeesRequested,true);assert.deepEqual(h.books.get(user).launches[2],protocol);
});

test('protocol retry inventory exposes only validated public timing and sanitized reason',async t=>{
  const launch=fixture();launch.protocolFeesRequested=true;launch.protocolRetry={at:100000,attempt:2,kind:'funding',reason:'Retry https://rpc.example/private-token\nshortage',secret:'private-key',raw:'private-raw'};
  const h=await harness(t,[launch]),row=(await h.service.coins(admin)).coins[0];
  assert.deepEqual(row.protocolRetry,{at:100000,attempt:2,kind:'funding',reason:'Retry [provider] shortage'});assert.doesNotMatch(JSON.stringify(row),/private-token|private-key|private-raw/);
  for(const patch of [{at:Infinity},{attempt:0},{kind:'<img>'}]){Object.assign(h.books.get(user).launches[0].protocolRetry,launch.protocolRetry,patch);assert.equal((await h.service.coins(admin)).coins[0].protocolRetry,null);}
});

const meteoraCoin=(patch={})=>({route:'meteora',accountId:user,id:'12345678-1234-4123-8123-123456789abc',mint:address(),name:'Meteora coin',symbol:'MET',quoteSymbol:'SOL',platformFeeBps:0,policyCurrent:true,recipient:address(),eligibility:{allowed:true,reason:''},requested:false,pending:false,collecting:'0',claimed:'0',paid:'0',...patch});
function attachMeteora(h,rows){
  const calls=[],requests=new Map();h.service.meteora={protocolInventoryRows:async actor=>{assert.equal(actor,admin);return structuredClone(rows);},collectProtocolFees:async(actor,input)=>{assert.equal(actor,admin);calls.push(structuredClone(input));const row=rows.find(row=>['accountId','id','mint'].every(key=>row[key]===input[key]));assert(row,'Meteora claim must identify the saved launch');if(requests.has(input.requestId))return{alreadyRequested:true};requests.set(input.requestId,input);return{queued:true};}};return {calls,requests};
}

test('protocol inventory and single collection include Meteora without touching Raydium launches',async t=>{
  const ray=fixture(),met=meteoraCoin(),h=await harness(t,[ray]),m=attachMeteora(h,[met]),before=structuredClone(h.books.get(user));
  const inventory=await h.service.coins(admin);assert.equal(inventory.coins.length,2);assert.deepEqual(inventory.coins[1],met);
  const request={route:'meteora',accountId:met.accountId,id:met.id,mint:met.mint,requestId:'e1'.repeat(16),reason:'Collect all Meteora protocol revenue.'};
  assert.equal((await h.service.claim(admin,request)).queued,true);assert.deepEqual(m.calls[0],{accountId:met.accountId,id:met.id,mint:met.mint,requestId:request.requestId});assert.deepEqual(h.books.get(user),before);assert.equal(h.bookWrites,0);assert.equal(h.kicks,0);
  assert.equal((await h.service.claim(admin,request)).alreadyRequested,true);assert.equal(m.requests.size,1);
  for(const patch of [{id:'invalid'},{mint:'invalid'},{accountId:'invalid'},{requestId:'invalid'},{reason:'x'}])await assert.rejects(h.service.claim(admin,{...request,...patch}));
  assert.equal(m.calls.length,2);h.users.get(admin).mfaEnabled=false;await assert.rejects(h.service.claim(admin,request),error=>error.statusCode===403);assert.equal(m.calls.length,2);
});

test('collect all freezes Raydium and Meteora scope, deduplicates mint aliases, and safely replays both routes',async t=>{
  const ray=fixture(),met=meteoraCoin(),alias=meteoraCoin({id:'12345678-1234-4123-8123-123456789abd',mint:met.mint}),crossRouteAlias=meteoraCoin({id:'12345678-1234-4123-8123-123456789abe',mint:ray.keys.mint.address}),rows=[met,alias,crossRouteAlias],h=await harness(t,[ray]),m=attachMeteora(h,rows),request={requestId:'e2'.repeat(16)};
  const first=await h.service.claimAll(admin,request);assert.equal(first.queued.length,2);assert.equal(first.skipped.length,2);assert.equal(first.failed.length,0);assert.deepEqual(new Set(first.queued.map(row=>row.route||'raydium')),new Set(['raydium','meteora']));assert.equal(m.requests.size,1);assert.equal(h.bookWrites,1);
  rows.push(meteoraCoin({id:'12345678-1234-4123-8123-123456789abf'}));
  const replay=await h.service.claimAll(admin,request);assert.equal(replay.alreadyRequested.length,2);assert.equal(replay.queued.length,0);assert.equal(replay.skipped.length,2);assert.equal(m.requests.size,1);assert.equal(h.bookWrites,1);assert.deepEqual(m.calls[0],m.calls[1]);assert.match(m.calls[0].requestId,/^[a-f0-9]{64}$/);
});

test('Meteora inability to queue is explicit and does not claim success or suppress Raydium collections',async t=>{
  const ray=fixture(),met=meteoraCoin(),h=await harness(t,[ray]);h.service.meteora={protocolInventoryRows:async()=>[met],collectProtocolFees:async()=>({skipped:true,reason:'Restore the original encrypted Meteora protocol signer.'})};
  await assert.rejects(h.service.claim(admin,{...met,requestId:'e3'.repeat(16),reason:'Collect Meteora fees.'}),error=>error.statusCode===409);
  const result=await h.service.claimAll(admin,{requestId:'e4'.repeat(16)});assert.equal(result.queued.length,1);assert.equal(result.queued[0].id,ray.id);assert.equal(result.skipped.length,1);assert.equal(result.skipped[0].route,'meteora');assert.match(result.skipped[0].reason,/original encrypted/);
});
