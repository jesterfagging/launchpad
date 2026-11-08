import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PublicKey,TransactionMessage} from '@solana/web3.js';
import {createBurnCheckedInstruction,getAssociatedTokenAddressSync,TOKEN_2022_PROGRAM_ID,TOKEN_PROGRAM_ID} from '@solana/spl-token';
import bs58 from 'bs58';
import {Launchpad} from '../src/launchpad.mjs';
import {newLaunchKeys} from '../src/launchpad-receipts.mjs';
import {SOL_MINT} from '../public/launchpad-model.mjs';
import {TAX_PROTOCOL_POLICY,taxProtocolLedger,recordTaxHarvest,recordTaxConversion} from '../src/launchpad-tax-protocol.mjs';
import {TAX_BURN_MINT,TAX_BURN_WALLET,TAX_BURN_POLICY,TAX_BURN_INITIAL_AMOUNT,officialTaxBurnSelected,officialTaxBurnEnabled,selectOfficialTaxBurn,taxBurnPlan,requireTaxBurnPlan,recordTaxBurn,publicTaxBurn,manualTaxBurnRequest,officialTaxAutoBurnConfigured} from '../src/launchpad-tax-burn.mjs';
import {TAX_BURN_INITIAL_POLICY,TAX_BURN_INITIAL_PREVIOUS_AMOUNT,TAX_BURN_INITIAL_PREVIOUS_POLICY,TAX_BURN_INITIAL_LEGACY_AMOUNT,TAX_BURN_INITIAL_LEGACY_POLICY} from '../src/launchpad-rewards-wallet.mjs';
const NOW=1790670000000,INITIAL=BigInt(TAX_BURN_INITIAL_AMOUNT),signature=bs58.encode(Buffer.alloc(64,1)),address=()=>newLaunchKeys().wallet.address;
// These scenarios use automatic burns (v71.24: LAUNCHPAD_OFFICIAL_TAX_AUTO_BURN=true); the manual default is tested separately.
function flags(t,main=true,initial=false,auto=true){const names=['LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED','LAUNCHPAD_OFFICIAL_INITIAL_BURN_ENABLED','LAUNCHPAD_OFFICIAL_TAX_AUTO_BURN'],old=names.map(name=>process.env[name]);process.env[names[0]]=String(main);process.env[names[1]]=String(initial);process.env[names[2]]=String(auto);t.after(()=>names.forEach((name,i)=>old[i]===undefined?delete process.env[name]:process.env[name]=old[i]));}
function launch(){return {id:'a'.repeat(32),input:{network:'mainnet-beta',route:'raydium',feeMode:'holders',taxBps:200,quoteMint:SOL_MINT,dailyGasLamports:'100000000'},keys:{wallet:newLaunchKeys().wallet,mint:{address:TAX_BURN_MINT},rewards:{address:TAX_BURN_WALLET}},rewardsWallet:{version:1,status:'active',address:TAX_BURN_WALLET,creatorCredits:{base:'0',quote:'0',protocolQuote:'0',taxBase:'0'}},review:{quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals:9,price:{usd:'100'}},feeCustody:'relay',authorizedAt:NOW,createdAt:NOW,state:'live',curve:address(),credits:{quote:'1000000000',base:'0'},operations:[],gas:{day:new Date(NOW).toISOString().slice(0,10),reserved:'0'},autoFees:false,feesRequested:true,cycle:{stage:'route',index:0},lastHolderRewardCheck:NOW};}
function harvest(l,value){l.taxProtocol=recordTaxHarvest(l,value);l.credits.base=(BigInt(l.credits.base)+value).toString();}
function planned(l){const plan=taxBurnPlan(l);return {...plan.operationData,amount:plan.amount,kind:'tax-burn',signature,operationId:'burn1',state:'pending',createdAt:NOW,reserve:'0',raw:'journaled',rewardsWallet:{version:1,source:'rewards',signerSource:'rewards',address:TAX_BURN_WALLET}};}
function apply(l,op){const result=recordTaxBurn(l,op,{base:-BigInt(op.amount),quote:0n},NOW);l.taxProtocol=result.ledger;l.taxBurn=result.policy;l.credits.base=(BigInt(l.credits.base)-BigInt(op.amount)).toString();return result;}
function legacyInitial(l){l.taxBurn={policy:TAX_BURN_POLICY,selectedAt:NOW-1000,burnCount:0,lastBurnAt:null,lastBurnSignature:null,initialInventory:{version:1,policy:TAX_BURN_INITIAL_LEGACY_POLICY,approvedBase:TAX_BURN_INITIAL_LEGACY_AMOUNT,status:'authorized',trackedBurnedBase:'0',legacyBurnedBase:'0',completedAt:null,signature:null}};}
function previousInitial(l){legacyInitial(l);Object.assign(l.taxBurn.initialInventory,{policy:TAX_BURN_INITIAL_PREVIOUS_POLICY,approvedBase:TAX_BURN_INITIAL_PREVIOUS_AMOUNT});}
function receipt(l,op,{amount=BigInt(op.amount)}={}){const mint=new PublicKey(TAX_BURN_MINT),owner=new PublicKey(TAX_BURN_WALLET),ata=getAssociatedTokenAddressSync(mint,owner,false,TOKEN_2022_PROGRAM_ID),ix=createBurnCheckedInstruction(ata,mint,owner,amount,6,[],TOKEN_2022_PROGRAM_ID),message=new TransactionMessage({payerKey:owner,recentBlockhash:address(),instructions:[ix]}).compileToV0Message(),index=message.staticAccountKeys.findIndex(key=>key.equals(ata)),balance=BigInt(l.credits.base),row=value=>({accountIndex:index,owner:TAX_BURN_WALLET,mint:TAX_BURN_MINT,programId:TOKEN_2022_PROGRAM_ID.toBase58(),uiTokenAmount:{amount:value.toString(),decimals:6}});return{slot:451600000,transaction:{message,signatures:[op.signature]},meta:{err:null,fee:5000,preBalances:message.staticAccountKeys.map(()=>10000000),postBalances:message.staticAccountKeys.map((_,i)=>i===0?9995000:10000000),preTokenBalances:[row(balance)],postTokenBalances:[row(balance-amount)],innerInstructions:[]}};}
async function manager(t,l){const dir=await mkdtemp(join(tmpdir(),'launchpad-tax-burn-')),book={launches:[l]},saves=[];const m=new Launchpad({storeFor:()=>({dir,read:async()=>structuredClone(book),write:async(_,b)=>saves.push(structuredClone(b))})},null,{now:()=>NOW});m.kick=()=>{};t.after(async()=>{await m.close();await rm(dir,{recursive:true,force:true});});return{m,book,saves};}

test('default-off and exact mint/wallet/network isolation preserve other launches',t=>{flags(t,false);const l=launch();assert.equal(selectOfficialTaxBurn(l,NOW),false);assert.equal(officialTaxBurnSelected(l),false);for(const mutate of [x=>x.keys.mint.address=address(),x=>x.keys.rewards.address=address(),x=>x.input.network='devnet',x=>x.input.route='meteora',x=>x.input.feeMode='creator']){process.env.LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED='true';const other=launch();mutate(other);assert.equal(selectOfficialTaxBurn(other,NOW),false);assert.equal(officialTaxBurnSelected(other),false);}});
test('v71.24 default: collected tax is kept (never sold) until the owner asks for one burn of all of it',t=>{
  flags(t,true,false,false);assert.equal(officialTaxAutoBurnConfigured(),false);
  const l=launch();harvest(l,100n);assert.equal(selectOfficialTaxBurn(l,NOW),true,'the burn policy still applies: tax is reserved, never sold');
  assert.equal(officialTaxBurnSelected(l),true);assert.equal(officialTaxBurnEnabled(l),false,'nothing burns by itself');assert.throws(()=>taxBurnPlan(l),/not enabled/);
  let view=publicTaxBurn(l);assert.deepEqual([view.enabled,view.automatic,view.manual,view.manualRequested,view.paused,view.pendingTaxBase],[true,false,true,false,false,'100']);
  for(const bad of [{version:2,requestId:'f'.repeat(32),at:NOW},{version:1,requestId:'x',at:NOW},{version:1,requestId:'f'.repeat(32),at:-1}]){l.taxBurnRequest=bad;assert.equal(manualTaxBurnRequest(l),null);assert.equal(officialTaxBurnEnabled(l),false);}
  l.taxBurnRequest={version:1,requestId:'f'.repeat(32),actorId:'a'.repeat(32),at:NOW};
  assert.equal(officialTaxBurnEnabled(l),true);assert.equal(taxBurnPlan(l).amount,'100','one request burns everything collected');view=publicTaxBurn(l);assert.equal(view.manualRequested,true);
  const op=planned(l);requireTaxBurnPlan(l,op);apply(l,op);delete l.taxBurnRequest;
  assert.equal(l.taxBurn.burnCount,1);assert.equal(l.credits.base,'0');assert.equal(officialTaxBurnEnabled(l),false,'the next harvest waits for the next request');
  harvest(l,40n);view=publicTaxBurn(l);assert.deepEqual([view.pendingTaxBase,view.manual,view.manualRequested],['40',true,false]);
  process.env.LAUNCHPAD_OFFICIAL_TAX_AUTO_BURN='true';assert.equal(officialTaxBurnEnabled(l),true,'opting in restores automatic burns');assert.equal(publicTaxBurn(l).automatic,true);
});
test('policy persists: disabling new burns never re-enables tax selling',t=>{flags(t);const l=launch();harvest(l,100n);assert.equal(selectOfficialTaxBurn(l,NOW),true);process.env.LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED='false';assert.equal(officialTaxBurnEnabled(l),false);assert.equal(officialTaxBurnSelected(l),true);assert.throws(()=>taxBurnPlan(l),/not enabled/);assert.equal(publicTaxBurn(l).paused,true);});
test('future burn spends tracked tax only, preserves prior 5% proceeds, SOL debt and mixed inventory',t=>{flags(t);const l=launch();l.credits.base='17';harvest(l,200n);const sale={amount:'50',taxProtocolPolicy:TAX_PROTOCOL_POLICY,taxSource:'withheld-tax'},converted=recordTaxConversion(l,sale,50n,100n);l.taxProtocol=converted.ledger;l.credits.base='167';l.credits.quote=(BigInt(l.credits.quote)+converted.holderQuote).toString();l.nativeRewardDebts={version:1,payouts:[{owner:address(),amount:'12345'}]};selectOfficialTaxBurn(l,NOW);const op=planned(l),before=structuredClone(l);assert.equal(op.amount,'150');apply(l,op);assert.equal(l.credits.base,'17');assert.equal(l.credits.quote,before.credits.quote);assert.deepEqual(l.nativeRewardDebts,before.nativeRewardDebts);assert.equal(taxProtocolLedger(l).burnedBase,'150');assert.equal(l.taxProtocol.convertedBase,'50');assert.equal(l.taxProtocol.creditQuote,'5');assert.equal(l.taxProtocol.harvestedBase,'200');assert.equal(publicTaxBurn(l).burnedBase,'150');});
test('old tax ledgers normalize burnedBase without altering historical conversion',t=>{flags(t);const l=launch();harvest(l,40n);delete l.taxProtocol.burnedBase;assert.equal(taxProtocolLedger(l).burnedBase,'0');l.taxProtocol.burnedBase='1';assert.throws(()=>taxProtocolLedger(l),/invariant/);});
test('one-time initial burn is exact, separately attributes legacy balance and cannot repeat',t=>{flags(t,true,true);const l=launch();l.credits.base=(INITIAL-200n).toString();harvest(l,200n);selectOfficialTaxBurn(l,NOW);const op=planned(l);assert.equal(op.amount,TAX_BURN_INITIAL_AMOUNT);assert.equal(op.initialTaxBase,'200');assert.equal(op.initialLegacyBase,(INITIAL-200n).toString());requireTaxBurnPlan(l,op);apply(l,op);assert.equal(l.credits.base,'0');assert.equal(taxProtocolLedger(l).burnedBase,'200');assert.equal(publicTaxBurn(l).burnedBase,TAX_BURN_INITIAL_AMOUNT);assert.equal(l.taxBurn.initialInventory.status,'burned');assert.throws(()=>recordTaxBurn(l,op,{base:-INITIAL,quote:0n},NOW),/one-time/);assert.equal(selectOfficialTaxBurn(l,NOW),false);harvest(l,33n);assert.equal(taxBurnPlan(l).amount,'33');assert.equal(taxBurnPlan(l).operationData.taxSource,'withheld-tax');});
test('untouched v69 approval adopts the larger exact authorization once and leaves excess inventory untouched',t=>{
  flags(t,true,true);const l=launch();legacyInitial(l);l.credits.base=(INITIAL+50n).toString();
  assert.equal(selectOfficialTaxBurn(l,NOW),true);assert.equal(l.taxBurn.initialInventory.policy,TAX_BURN_INITIAL_POLICY);
  assert.deepEqual(l.taxBurn.initialInventory.replaces,{policy:TAX_BURN_INITIAL_LEGACY_POLICY,approvedBase:TAX_BURN_INITIAL_LEGACY_AMOUNT,revisedAt:NOW});
  assert.equal(selectOfficialTaxBurn(l,NOW+1),false);const op=planned(l);assert.equal(op.amount,'50000000000000');apply(l,op);
  assert.equal(l.credits.base,'50');assert.equal(taxBurnPlan(l).amount,'0');assert.equal(selectOfficialTaxBurn(l,NOW+2),false);
});
test('any saved v69 tax-burn operation pins the existing amount and preserves signed bytes',t=>{
  flags(t,true,true);
  for(const state of ['pending','awaiting_signature','failed','confirmed']){
    const l=launch();legacyInitial(l);l.credits.base=TAX_BURN_INITIAL_AMOUNT;const op=planned(l);op.state=state;l.operations.push(op);const before=structuredClone(l);
    assert.equal(selectOfficialTaxBurn(l,NOW),false);assert.deepEqual(l,before);assert.equal(taxBurnPlan(l).amount,TAX_BURN_INITIAL_LEGACY_AMOUNT);
    assert.throws(()=>requireTaxBurnPlan(l,{...op,amount:TAX_BURN_INITIAL_AMOUNT,initialBurnPolicy:TAX_BURN_INITIAL_POLICY}),/verified source authorization/);
  }
});
test('a completed v69 initial burn never reauthorizes v3 and only later tracked tax may burn',t=>{
  flags(t,true,true);const l=launch();legacyInitial(l);l.credits.base=(INITIAL*2n).toString();const op=planned(l);apply(l,op);op.state='confirmed';l.operations.push(op);
  const remaining=(INITIAL*2n-BigInt(TAX_BURN_INITIAL_LEGACY_AMOUNT)).toString();assert.equal(l.credits.base,remaining);assert.ok(BigInt(remaining)>INITIAL);
  assert.equal(selectOfficialTaxBurn(l,NOW),false);assert.equal(l.taxBurn.initialInventory.policy,TAX_BURN_INITIAL_LEGACY_POLICY);assert.equal(taxBurnPlan(l).amount,'0');
  harvest(l,25n);const next=planned(l);assert.equal(next.taxSource,'withheld-tax');assert.equal(next.amount,'25');apply(l,next);assert.equal(l.credits.base,remaining);
  assert.throws(()=>recordTaxBurn(l,op,{base:-BigInt(op.amount),quote:0n},NOW),/one-time/);
});
test('pending signed v69 burn reconciles exactly after upgrade with gates disabled and cannot double settle',async t=>{
  flags(t,true,true);const l=launch();legacyInitial(l);l.credits.base=TAX_BURN_INITIAL_AMOUNT;const op=planned(l);l.operations.push(op);const tx=receipt(l,op),raw=op.raw;
  assert.equal(selectOfficialTaxBurn(l,NOW),false);assert.equal(op.raw,raw);process.env.LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED='false';process.env.LAUNCHPAD_OFFICIAL_INITIAL_BURN_ENABLED='false';
  const {m,book}=await manager(t,l);await m.reconcile('a',book,l,{receipt:async()=>tx},op);
  assert.equal(op.state,'confirmed');assert.equal(op.raw,undefined);assert.equal(op.signature,signature);assert.equal(op.amount,TAX_BURN_INITIAL_LEGACY_AMOUNT);assert.equal(op.taxBurnReceipt.baseUnits,TAX_BURN_INITIAL_LEGACY_AMOUNT);assert.equal(l.taxBurn.initialInventory.policy,TAX_BURN_INITIAL_LEGACY_POLICY);
  assert.equal(l.credits.base,(INITIAL-BigInt(TAX_BURN_INITIAL_LEGACY_AMOUNT)).toString());const settled=structuredClone(l);
  await m.reconcile('a',book,l,{receipt:async()=>tx},op);assert.deepEqual(l,settled);
});
test('disabled initial gate cannot revise a previous unsigned authorization',t=>{
  flags(t,true,false);const l=launch();legacyInitial(l);l.credits.base=TAX_BURN_INITIAL_AMOUNT;const before=structuredClone(l);
  assert.equal(selectOfficialTaxBurn(l,NOW),false);assert.deepEqual(l,before);assert.equal(taxBurnPlan(l).amount,'0');
});
test('initial burn below authorized balance fails rather than shrinking or burning new donations',t=>{flags(t,true,true);const l=launch();l.credits.base=(INITIAL-1n).toString();selectOfficialTaxBurn(l,NOW);assert.throws(()=>taxBurnPlan(l),/no longer fully accounted/);assert.equal(l.taxBurn.initialInventory.status,'authorized');});
test('late initial flag cannot reinterpret future inventory after tracked burn',t=>{flags(t);const l=launch();harvest(l,8n);selectOfficialTaxBurn(l,NOW);apply(l,planned(l));process.env.LAUNCHPAD_OFFICIAL_INITIAL_BURN_ENABLED='true';assert.throws(()=>selectOfficialTaxBurn(l,NOW),/cannot be enabled after/);assert.equal(l.taxBurn.initialInventory,undefined);});
test('pausing initial authorization blocks all newer burns while reserving existing credit',t=>{flags(t,true,true);const l=launch();harvest(l,INITIAL);selectOfficialTaxBurn(l,NOW);process.env.LAUNCHPAD_OFFICIAL_INITIAL_BURN_ENABLED='false';assert.equal(taxBurnPlan(l).amount,'0');assert.equal(publicTaxBurn(l).paused,true);assert.equal(l.credits.base,TAX_BURN_INITIAL_AMOUNT);});
test('receipt settlement survives restart/disabled gates, and duplicate reconciliation cannot double-debit',async t=>{flags(t,true,true);const l=launch();l.credits.base=(INITIAL-100n).toString();harvest(l,100n);selectOfficialTaxBurn(l,NOW);const op=planned(l);l.operations.push(op);const tx=receipt(l,op),debt={version:1,payouts:[{owner:address(),amount:'40000'}]};l.nativeRewardDebts=debt;process.env.LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED='false';process.env.LAUNCHPAD_OFFICIAL_INITIAL_BURN_ENABLED='false';const {m,book}=await manager(t,l);await m.reconcile('a',book,l,{receipt:async()=>tx},op);assert.equal(op.state,'confirmed');assert.equal(l.credits.base,'0');assert.equal(l.credits.quote,'1000000000');assert.deepEqual(l.nativeRewardDebts,debt);assert.equal(l.taxBurn.burnCount,1);assert.equal(op.taxBurnReceipt.approvedLegacyBaseUnits,(INITIAL-100n).toString());const before=structuredClone(l);await m.reconcile('a',book,l,{receipt:async()=>tx},op);assert.deepEqual(l,before);});
test('altered burn receipt rolls back all accounting and retains pending signed journal',async t=>{flags(t);const l=launch();harvest(l,100n);selectOfficialTaxBurn(l,NOW);const op=planned(l);l.operations.push(op);const before=structuredClone(l),{m,book}=await manager(t,l);await assert.rejects(()=>m.reconcile('a',book,l,{receipt:async()=>receipt(l,op,{amount:99n})},op),/burn/);assert.deepEqual(l,before);assert.equal(op.state,'pending');});
test('failed onchain burn and unresolved receipt preserve every earned credit',async t=>{flags(t);const l=launch();harvest(l,100n);selectOfficialTaxBurn(l,NOW);const op=planned(l);l.operations.push(op);const {m,book}=await manager(t,l),before=structuredClone(l.credits);await m.reconcile('a',book,l,{receipt:async()=>null},op);assert.equal(op.state,'pending');assert.deepEqual(l.credits,before);const tx=receipt(l,op);tx.meta.err={InstructionError:[0,'InsufficientFunds']};await m.reconcile('a',book,l,{receipt:async()=>tx},op);assert.equal(op.state,'failed');assert.deepEqual(l.credits,before);assert.equal(l.taxProtocol.burnedBase,'0');assert.equal(l.taxBurn.burnCount,0);});
test('new sales are rejected before preparation once the LAUNCHPAD policy is selected',async t=>{flags(t);const l=launch();harvest(l,100n);selectOfficialTaxBurn(l,NOW);l.cycle.taxConversionAttempted=true;const {m,book}=await manager(t,l);let prepared=false;await assert.rejects(()=>m.send('a',book,l,{prepare:async()=>{prepared=true;}},'sell',['placeholder'],{amount:'100'}),/new sales are disabled/);assert.equal(prepared,false);});
test('initial inventory bypasses unsigned RPC collection but cannot bypass managed signing custody',async t=>{flags(t,true,true);const l=launch();harvest(l,INITIAL);l.cycle.stage='claim';const {m,book}=await manager(t,l);m.advanceRewardsWallet=async()=>false;let claimed=false;await assert.rejects(()=>m.advanceFees('a',book,l,{claimInstructions:async()=>{claimed=true;throw Error('RPC overload');}}),/wallet is unavailable/);assert.equal(claimed,false);assert.equal(l.cycle.stage,'route');assert.equal(l.credits.base,TAX_BURN_INITIAL_AMOUNT);assert.equal(l.taxBurn.initialInventory.status,'authorized');});
test('unsigned paused initial inventory still permits owed SOL payouts to be prepared',async t=>{flags(t,true,true);const l=launch();harvest(l,INITIAL);selectOfficialTaxBurn(l,NOW);process.env.LAUNCHPAD_OFFICIAL_INITIAL_BURN_ENABLED='false';l.nativeRewardDebts={version:1,payouts:[{owner:address(),amount:'12345'}]};const {m,book}=await manager(t,l);m.advanceRewardsWallet=async()=>false;let paid=null;m.send=async(_id,_book,_launch,_chain,kind,_ix,options)=>{paid={kind,...options};return true;};await assert.rejects(()=>m.advanceFees('a',book,l,{payoutInstructions:async()=>[]}),/wallet is unavailable/);assert.equal(l.cycle.stage,'payout');assert.equal(l.cycle.payouts[0].amount,'12345');assert.equal(l.credits.quote,'1000000000');assert.equal(l.credits.base,TAX_BURN_INITIAL_AMOUNT);assert.equal(paid,null);});

test('finalized burn reconciles after rewards key record removal without authorizing new signing',async t=>{flags(t);const l=launch();harvest(l,100n);selectOfficialTaxBurn(l,NOW);const op=planned(l);l.operations.push(op);const tx=receipt(l,op);delete l.keys.rewards;process.env.LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED='false';const {m,book}=await manager(t,l);await m.reconcile('a',book,l,{receipt:async()=>tx},op);assert.equal(op.state,'confirmed');assert.equal(l.credits.base,'0');assert.equal(l.taxBurn.burnCount,1);assert.equal(l.taxProtocol.burnedBase,'100');});

test('failed receipt persistence retains the exact initial authorization and signed journal until one successful settlement',async t=>{
  flags(t,true,true);const l=launch();l.credits.base=(INITIAL-100n).toString();harvest(l,100n);selectOfficialTaxBurn(l,NOW);
  const op=planned(l);l.operations.push(op);const tx=receipt(l,op),{m,book}=await manager(t,l),before=structuredClone(l);
  const save=m.save.bind(m);let fail=true;
  m.save=async(...args)=>{if(fail){fail=false;throw Error('Simulated journal persistence failure');}return save(...args);};
  await assert.rejects(()=>m.reconcile('a',book,l,{receipt:async()=>tx},op),/journal persistence/);
  assert.deepEqual(l,before);assert.equal(op.raw,'journaled');assert.equal(l.taxBurn.initialInventory.status,'authorized');
  await m.reconcile('a',book,l,{receipt:async()=>tx},op);
  assert.equal(op.state,'confirmed');assert.equal(l.taxBurn.initialInventory.status,'burned');assert.equal(l.taxBurn.burnCount,1);assert.equal(l.credits.base,'0');assert.equal(l.credits.quote,before.credits.quote);
  const settled=structuredClone(l);await m.reconcile('a',book,l,{receipt:async()=>tx},op);assert.deepEqual(l,settled);
});

test('an untouched 48,765,432.109876 approval adopts exactly 50,000,000 once, without sweeping extra tokens',t=>{
  flags(t,true,false);const l=launch();previousInitial(l);l.credits.base=(INITIAL+1234567n).toString();const before=structuredClone(l);
  assert.equal(selectOfficialTaxBurn(l,NOW),false);assert.deepEqual(l,before);
  process.env.LAUNCHPAD_OFFICIAL_INITIAL_BURN_ENABLED='true';
  assert.equal(selectOfficialTaxBurn(l,NOW),true);
  assert.deepEqual(l.taxBurn.initialInventory.replaces,{policy:TAX_BURN_INITIAL_PREVIOUS_POLICY,approvedBase:TAX_BURN_INITIAL_PREVIOUS_AMOUNT,revisedAt:NOW});
  const op=planned(l);assert.equal(op.amount,'50000000000000');apply(l,op);
  assert.equal(l.credits.base,'1234567');assert.equal(taxBurnPlan(l).amount,'0');assert.equal(selectOfficialTaxBurn(l,NOW+1),false);
});

test('every saved previous v70 burn operation pins its original amount and signed bytes',t=>{
  flags(t,true,true);
  for(const state of ['pending','awaiting_signature','failed','confirmed']){
    const l=launch();previousInitial(l);l.credits.base=TAX_BURN_INITIAL_AMOUNT;const op=planned(l);op.state=state;l.operations.push(op);const before=structuredClone(l);
    assert.equal(selectOfficialTaxBurn(l,NOW),false);assert.deepEqual(l,before);assert.equal(taxBurnPlan(l).amount,'48765432109876');
    assert.throws(()=>requireTaxBurnPlan(l,{...op,amount:TAX_BURN_INITIAL_AMOUNT,initialBurnPolicy:TAX_BURN_INITIAL_POLICY}),/verified source authorization/);
  }
});

test('completed previous v70 initial burn never reauthorizes even with enough remaining inventory',t=>{
  flags(t,true,true);const l=launch();previousInitial(l);l.credits.base=(INITIAL*2n).toString();const op=planned(l);apply(l,op);op.state='confirmed';l.operations.push(op);
  const remaining=l.credits.base;assert.ok(BigInt(remaining)>INITIAL);
  assert.equal(selectOfficialTaxBurn(l,NOW),false);assert.equal(l.taxBurn.initialInventory.policy,TAX_BURN_INITIAL_PREVIOUS_POLICY);assert.equal(taxBurnPlan(l).amount,'0');
  harvest(l,25n);const next=planned(l);assert.equal(next.amount,'25');apply(l,next);assert.equal(l.credits.base,remaining);
});

test('pending previous v70 burn reconciles once with both gates disabled after the amount revision',async t=>{
  flags(t,true,true);const l=launch();previousInitial(l);l.credits.base=TAX_BURN_INITIAL_AMOUNT;const op=planned(l);l.operations.push(op);const tx=receipt(l,op);
  assert.equal(selectOfficialTaxBurn(l,NOW),false);
  process.env.LAUNCHPAD_OFFICIAL_TAX_BURN_ENABLED='false';process.env.LAUNCHPAD_OFFICIAL_INITIAL_BURN_ENABLED='false';
  const {m,book}=await manager(t,l);await m.reconcile('a',book,l,{receipt:async()=>tx},op);
  assert.equal(op.state,'confirmed');assert.equal(op.taxBurnReceipt.baseUnits,'48765432109876');assert.equal(l.credits.base,'1234567890124');
  const settled=structuredClone(l);await m.reconcile('a',book,l,{receipt:async()=>tx},op);assert.deepEqual(l,settled);
});
