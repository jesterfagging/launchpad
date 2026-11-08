import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Keypair,PublicKey,SystemProgram,SystemInstruction,VersionedTransaction} from '@solana/web3.js';
import {AccountLayout,TOKEN_PROGRAM_ID,getAssociatedTokenAddressSync,decodeTransferCheckedInstruction} from '@solana/spl-token';
import BN from 'bn.js';
import {Launchpad} from '../src/launchpad.mjs';
import {LaunchChain,ray,newLaunchKeys} from '../src/launchpad-chain.mjs';
import {SOL_MINT,units} from '../public/launchpad-model.mjs';
import {protocolPolicyTarget} from '../src/launchpad-policy-upgrade.mjs';
import {effectiveCreatorFeeRate} from '../public/creator-fee-schedule.mjs';
import {platformBrand} from '../src/launchpad-branding.mjs';
process.env.LAUNCHPAD_PUBLIC_URL='https://launchpad.example';
const LAUNCHPAD_PLATFORM_BRAND=platformBrand();

const key=()=>Keypair.generate().publicKey.toBase58(),pk=v=>new PublicKey(v),bn=v=>new BN(String(v));
const policy=()=>({recipient:key(),curveFeeBps:100,creationFeeSol:'0',autoHarvest:false});
const launch=()=>({id:'c'.repeat(32),keys:{...newLaunchKeys(),payer:newLaunchKeys().wallet},input:{route:'raydium',network:'mainnet-beta',quoteMint:SOL_MINT,creatorFeeBps:25,feeMode:'holders',dailyGasLamports:'50000000',taxBps:0},review:{minimumSol:'0',platformRent:'0',quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals:9,cpConfigId:key(),platformFeeBps:100,protocolFees:policy(),supply:'1000000000000000',sell:'800000000000000',raise:'64000000000',configId:key(),devBuy:{gross:'0'}},feeCustody:'relay',authorizedAt:1,state:'live',curve:key(),credits:{quote:'700',base:'900'},operations:[],gas:{day:'1970-01-01',reserved:'0'},autoFees:false,protocolFeesRequested:true,protocolClaimStage:'claim'});
function receipt(l,{quote=0n,base=0n,err=null}={}){const row=(mint,n,i)=>({owner:l.keys.wallet.address,mint,accountIndex:i,uiTokenAmount:{amount:String(n)}});return {slot:42,transaction:{message:{accountKeys:[pk(l.keys.wallet.address),pk(key()),pk(key())]}},meta:{err,fee:5000,preBalances:[1000000000,2039280,2039280],postBalances:[999995000,2039280,2039280],preTokenBalances:[row(l.input.quoteMint,100000n,1),row(l.keys.mint.address,100000n,2)],postTokenBalances:[row(l.input.quoteMint,100000n+quote,1),row(l.keys.mint.address,100000n+base,2)]}};}
async function harness(t,hostPolicy=null){const dir=await mkdtemp(join(tmpdir(),'launchpad-protocol-'));t.after(()=>rm(dir,{recursive:true,force:true}));let book={launches:[launch()]},tx=null,clock=10000,count=0;const calls=[];
  const store={dir,read:async()=>structuredClone(book),write:async(_,v)=>{book=structuredClone(v);}};
  const c={c:{getBlockHeight:async()=>9},prepare:async()=>({signature:'sig'+ ++count,state:'pending',raw:'signed',createdAt:clock,lastValidBlockHeight:100}),broadcast:async op=>{assert(book.launches[0].operations.some(x=>x.raw===op.raw&&x.signature===op.signature));calls.push(op.kind);},receipt:async()=>tx,claimInstructions:async(_,source)=>{calls.push(source);return ['claim'];},payoutInstructions:async(_,rows)=>{calls.push(rows);return ['payout'];},protocolActivationInstructions:async()=>['activate'],verifyProtocolActivation:async()=>true,close(){}};
  const manager=new Launchpad({storeFor:()=>store,hostStore:{read:async(name,fallback)=>name==='launch-protocol-fees'?structuredClone(hostPolicy):fallback}},null,{chainFactory:()=>c,now:()=>clock});manager.kick=()=>{};t.after(()=>manager.close());
  return {manager,c,calls,get l(){return book.launches[0];},get book(){return book;},set tx(v){tx=v;},advance(n){clock+=n;}};
}
test('existing coins forward new protocol payouts to the dedicated launchpad wallet while signed transfers keep their destination',async t=>{
  const current={recipient:key(),recipientScope:'launchpad'},h=await harness(t,current),snapshot=structuredClone(h.l.review),first=current.recipient;
  h.l.protocolCredit='1234';h.l.protocolClaimStage='payout';
  await h.manager.process('a');const pending=structuredClone(h.l.operations[0]);assert.deepEqual(pending.payouts,[{owner:first,amount:'1234'}]);
  current.recipient=key();await h.manager.process('a');assert.equal(h.l.operations.length,1);assert.deepEqual(h.l.operations[0],pending);
  h.tx=receipt(h.l,{quote:-1234n});await h.manager.process('a');assert.equal(h.l.protocolPaid,'1234');assert.deepEqual(h.l.credits,{quote:'700',base:'900'});
  h.tx=null;h.l.protocolCredit='17';h.l.protocolFeesRequested=true;h.l.protocolClaimStage='payout';await h.manager.process('a');
  assert.deepEqual(h.l.operations.at(-1).payouts,[{owner:current.recipient,amount:'17'}]);assert.deepEqual(h.l.review,snapshot);assert.deepEqual(h.l.credits,{quote:'700',base:'900'});
});

test('real locked liquidity payout instructions send SOL and base tokens to the newly configured launchpad recipient',async()=>{
  const l=launch(),recipient=key(),c=new LaunchChain({network:'mainnet-beta',connection:{getMinimumBalanceForRentExemption:async()=>2039280}});c.mintInfo=async()=>({program:TOKEN_PROGRAM_ID,mint:{decimals:6}});
  const instructions=await c.protocolPayoutInstructions(l,{quote:'123',base:'456',recipient});
  const sol=instructions.filter(ix=>ix.programId.equals(SystemProgram.programId)&&SystemInstruction.decodeInstructionType(ix)==='Transfer').map(ix=>SystemInstruction.decodeTransfer(ix));
  assert.equal(sol.length,1);assert.equal(sol[0].toPubkey.toBase58(),recipient);assert.equal(sol[0].lamports,123n);
  const base=decodeTransferCheckedInstruction(instructions.at(-1));assert.equal(base.data.amount,456n);assert(base.keys.destination.pubkey.equals(getAssociatedTokenAddressSync(pk(l.keys.mint.address),pk(recipient))));assert.notEqual(recipient,l.review.protocolFees.recipient);
});
test('SOL-only protocol payouts prepare and journal real transactions without holder recipient checks',async t=>{
  for(const source of ['wallet','protocol']){
    const treasury={recipient:key(),recipientScope:'launchpad'},h=await harness(t,treasury),l=h.l;
    if(source==='protocol'){
      l.keys.protocol=newLaunchKeys().wallet;
      l.protocolFeeWallet={source,address:l.keys.protocol.address};
    }
    l.keys.rewards=newLaunchKeys().wallet;
    l.rewardsWallet={version:1,status:'active',address:l.keys.rewards.address};
    l.protocolCredit='1234567';l.protocolBaseCredit='0';l.protocolClaimStage='payout';
    const rewardCredits=structuredClone(l.credits),simulations=[],broadcasts=[];let recipientReads=0;
    const chain=new LaunchChain({network:'mainnet-beta',connection:{
      getMultipleAccountsInfoAndContext:async keys=>{recipientReads++;return{context:{slot:50},value:keys.map(()=>({lamports:1000000,data:Buffer.alloc(0),owner:SystemProgram.programId,executable:false}))};},
      getMinimumBalanceForRentExemption:async size=>size===0?890880:2039280,
      getLatestBlockhash:async()=>({blockhash:key(),lastValidBlockHeight:100}),
      simulateTransaction:async(tx,options)=>{simulations.push({tx,options});return{context:{slot:51},value:{err:null,unitsConsumed:60000}};},
    }});
    chain.broadcast=async op=>{
      assert(h.book.launches[0].operations.some(saved=>saved.signature===op.signature&&saved.raw===op.raw),'signed transaction is saved before submission');
      broadcasts.push(op);
    };
    await h.manager.advanceProtocolFees('a',h.book,l,chain);
    const op=h.l.operations.at(-1),tx=VersionedTransaction.deserialize(Buffer.from(op.raw,'base64'));
    assert.equal(op.kind,'protocol-payout');assert.equal(op.state,'pending');
    assert.deepEqual(op.payouts,[{owner:treasury.recipient,amount:'1234567'}]);
    assert.equal(tx.message.staticAccountKeys[0].toBase58(),l.keys[source].address);
    assert.equal(tx.message.header.numRequiredSignatures,1);
    assert(!tx.message.staticAccountKeys.some(address=>address.toBase58()===l.keys.rewards.address));
    const transfer=tx.message.compiledInstructions.filter(ix=>tx.message.staticAccountKeys[ix.programIdIndex].equals(SystemProgram.programId)&&Buffer.from(ix.data).readUInt32LE(0)===2);
    assert.equal(transfer.length,1);
    assert.equal(tx.message.staticAccountKeys[transfer[0].accountKeyIndexes[1]].toBase58(),treasury.recipient);
    assert.equal(Buffer.from(transfer[0].data).readBigUInt64LE(4),1234567n);
    assert.equal(recipientReads,0);assert.equal(simulations.length,1);assert.equal(simulations[0].options.sigVerify,true);
    assert.equal(simulations[0].options.minContextSlot,undefined);assert.equal(broadcasts.length,1);
    assert.deepEqual(h.l.credits,rewardCredits);assert.equal(h.l.protocolCredit,'1234567');assert.equal(h.l.protocolPaid,undefined);
  }
});
test('protocol claims and payouts use only confirmed platform credits, isolated from holder rewards',async t=>{const h=await harness(t);await h.manager.process('a');assert.deepEqual(h.calls,['protocol','protocol-claim']);assert.equal(h.l.operations[0].state,'pending');h.tx=receipt(h.l,{quote:1234n});await h.manager.process('a');assert.equal(h.l.protocolCredit,'1234');assert.deepEqual(h.l.credits,{quote:'700',base:'900'});assert.equal(h.l.protocolClaimed,'1234');h.tx=null;await h.manager.process('a');assert.deepEqual(h.calls.at(-2),[{owner:h.l.review.protocolFees.recipient,amount:'1234'}]);h.tx=receipt(h.l,{quote:-1234n});await h.manager.process('a');assert.equal(h.l.protocolCredit,'0');assert.equal(h.l.protocolPaid,'1234');assert.equal(h.l.protocolFeesRequested,false);assert.deepEqual(h.l.credits,{quote:'700',base:'900'});});
test('a full manual collection combines saved protocol credits with new curve and locked LP earnings',async t=>{
  const h=await harness(t),rewardCredits=structuredClone(h.l.credits);
  h.l.protocolCredit='100';h.l.protocolBaseCredit='50';h.l.review.protocolFees.lpPolicy='platform_locked';
  h.l.protocolAutomaticCycle=false;
  h.c.protocolLiquidityInstructions=async(_launch,options)=>{assert.equal(options.automatic,false);return ['lp-claim'];};
  h.c.protocolPayoutInstructions=async(_launch,amounts)=>{assert.equal(amounts.quote,'130');assert.equal(amounts.base,'80');return ['lp-payout'];};
  await h.manager.process('a');assert.equal(h.l.operations.at(-1).kind,'protocol-claim');
  h.tx=receipt(h.l,{quote:20n});await h.manager.process('a');
  h.tx=null;await h.manager.process('a');assert.equal(h.l.operations.at(-1).kind,'protocol-lp-claim');
  h.tx=receipt(h.l,{quote:10n,base:30n});await h.manager.process('a');
  assert.equal(h.l.protocolCredit,'130');assert.equal(h.l.protocolBaseCredit,'80');
  h.tx=null;await h.manager.process('a');assert.equal(h.l.operations.at(-1).kind,'protocol-lp-payout');
  h.tx=receipt(h.l,{quote:-130n,base:-80n});await h.manager.process('a');
  assert.equal(h.l.protocolCredit,'0');assert.equal(h.l.protocolBaseCredit,'0');
  assert.equal(h.l.protocolPaid,'130');assert.equal(h.l.protocolBasePaid,'80');
  assert.equal(h.l.protocolFeesRequested,false);assert.deepEqual(h.l.credits,rewardCredits);
});
test('protocol failed or mismatched receipts never become spendable credit or disable holder automation',async t=>{const h=await harness(t);h.l.autoFees=true;await h.manager.process('a');h.tx=receipt(h.l,{err:{failure:true}});await h.manager.process('a');assert.equal(h.l.operations[0].state,'failed');assert.equal(h.l.autoFees,true);assert.equal(h.l.protocolCredit,undefined);const b=await h.manager.book('a');b.launches[0].protocolFeesRequested=true;b.launches[0].protocolClaimStage='claim';await h.manager.save('a',b);h.tx=null;await h.manager.process('a');h.tx=receipt(h.l,{quote:100n,base:-1n});await h.manager.process('a');assert.equal(h.l.operations.at(-1).state,'pending');assert.equal(h.l.protocolCredit,undefined);assert.match(h.l.protocolError,/unexpected token/);});
test('a protocol receipt timeout keeps exact signed bytes and leaves reward flags intact',async t=>{const h=await harness(t);await h.manager.process('a');await h.manager.action('a',h.l.id,'resume',{autoFees:true});h.advance(181000);await h.manager.process('a');assert.equal(h.l.autoFees,true);assert.equal(h.l.feeAutomation.enabled,true);assert.equal(h.l.feesRequested,true);assert.equal(h.l.operations[0].raw,'signed');assert.equal(h.l.operations.length,1);assert.match(h.l.protocolError,/unresolved/);});
test('a transient protocol receipt error preserves the pending request so manual collection continues to payout',async t=>{const h=await harness(t);await h.manager.process('a');const read=h.c.receipt;h.c.receipt=async()=>{throw Error('RPC unavailable');};await h.manager.process('a');assert.equal(h.l.protocolFeesRequested,true);assert.equal(h.l.operations.length,1);h.c.receipt=read;h.tx=receipt(h.l,{quote:12n});await h.manager.process('a');h.tx=null;await h.manager.process('a');assert.equal(h.l.operations.at(-1).kind,'protocol-payout');assert.equal(h.l.operations.at(-1).amount,'12');});
test('expired protocol transactions resume only their saved step after two advancing finalized checks',async t=>{
  const stages={'protocol-claim':'claim','protocol-lp-claim':'lp','protocol-payout':'payout','protocol-lp-payout':'payout','protocol-enable':'activate'};
  for(const [kind,stage]of Object.entries(stages)){
    const h=await harness(t);h.l.state='paused';h.l.autoFees=false;h.l.feesRequested=false;h.l.protocolCredit='123';h.l.protocolBaseCredit='45';h.l.protocolClaimStage=stage;
    const target={...policy(),...protocolPolicyTarget()};if(kind==='protocol-enable')h.l.protocolActivation=structuredClone(target);
    const op={kind,state:'pending',signature:'saved-protocol',raw:'exact-signed-bytes',createdAt:10000,lastValidBlockHeight:100,reserve:'5000000',...(kind==='protocol-enable'?{protocolPolicy:target}:{})};
    h.l.operations.push(op);h.l.gas.reserved='5000000';h.advance(181000);
    let checks=0;h.c.pendingTransactionState=async saved=>{checks++;return{state:'expired',signature:saved.signature,checkpoint:{slot:300+checks,height:200+checks},historyFromSlot:0};};
    const before=structuredClone({state:h.l.state,autoFees:h.l.autoFees,feesRequested:h.l.feesRequested,credits:h.l.credits,protocolCredit:h.l.protocolCredit,protocolBaseCredit:h.l.protocolBaseCredit});
    await h.manager.process('a');assert.equal(h.l.operations[0].state,'pending');assert.equal(h.l.operations[0].raw,'exact-signed-bytes');assert.equal(h.calls.length,0);
    h.advance(9999);await h.manager.process('a');assert.equal(checks,1);h.advance(1);await h.manager.process('a');
    assert.equal(h.l.operations[0].state,'expired');assert.equal(h.l.operations[0].raw,undefined);assert.equal(h.l.operations[0].expiryProof.second.slot,302);assert.equal(h.l.gas.reserved,'0');
    assert.equal(h.l.protocolClaimStage,stage);assert.equal(h.l.protocolFeesRequested,true);assert.equal(h.calls.length,0);
    assert.deepEqual({state:h.l.state,autoFees:h.l.autoFees,feesRequested:h.l.feesRequested,credits:h.l.credits,protocolCredit:h.l.protocolCredit,protocolBaseCredit:h.l.protocolBaseCredit},before);
    if(kind==='protocol-enable')assert.deepEqual(h.l.protocolActivation,target);
    if(kind==='protocol-payout'){
      h.l.protocolBaseCredit='0';await h.manager.process('a');assert.equal(h.l.operations.length,2);assert.equal(h.l.operations[1].kind,'protocol-payout');assert.equal(h.l.operations[1].amount,'123');
      h.tx=receipt(h.l,{quote:-123n});await h.manager.process('a');assert.equal(h.l.protocolCredit,'0');assert.equal(h.l.protocolPaid,'123');assert.equal(h.l.operations[0].state,'expired');
    }
  }
});
test('protocol expiry never replaces unknown history, stale checkpoints or a transaction with an available receipt',async t=>{
  const h=await harness(t);await h.manager.process('a');h.advance(181000);
  let result={state:'unknown',reason:'Retained history is incomplete.'},checks=0;h.c.pendingTransactionState=async()=>{checks++;return result;};
  await h.manager.process('a');assert.equal(h.l.operations[0].state,'pending');assert.equal(h.l.operations[0].expiryCheck,undefined);
  result={state:'expired',signature:'sig1',checkpoint:{slot:300,height:200},historyFromSlot:0};h.advance(10000);await h.manager.process('a');
  h.advance(10000);await h.manager.process('a');assert.equal(h.l.operations[0].state,'pending');assert.equal(h.l.operations.length,1);assert.equal(h.l.operations[0].raw,'signed');
  h.tx=receipt(h.l,{quote:50n});h.advance(10000);const previous=checks;await h.manager.process('a');assert.equal(checks,previous);assert.equal(h.l.operations[0].state,'confirmed');assert.equal(h.l.protocolCredit,'50');
});
test('existing-platform activation changes local terms only after successful confirmation and onchain verification',async t=>{const h=await harness(t);h.l.review.platformFeeBps=0;h.l.protocolActivation=policy();h.l.protocolClaimStage='activate';await h.manager.process('a');assert.equal(h.l.review.platformFeeBps,0);h.tx=receipt(h.l);h.c.verifyProtocolActivation=async()=>{throw Error('RPC stale');};await h.manager.process('a');assert.equal(h.l.review.platformFeeBps,0);assert.equal(h.l.operations[0].state,'pending');h.c.verifyProtocolActivation=async()=>true;await h.manager.process('a');assert.equal(h.l.review.platformFeeBps,100);assert.equal(h.l.operations[0].state,'confirmed');assert.equal(h.l.input.creatorFeeBps,25);assert.deepEqual(h.l.credits,{quote:'700',base:'900'});});

test('legacy fee activation runs at a transaction boundary and preserves paused reward cycles',async t=>{
  for(const feeMode of ['buyback','holders','creator'])for(const stage of ['claim','distribute','burn','done','payout']){
    const h=await harness(t);h.l.input.feeMode=feeMode;h.l.review.platformFeeBps=0;h.l.protocolActivation=policy();h.l.protocolClaimStage='activate';
    h.l.state='paused';h.l.feesRequested=true;h.l.error='Previous reward preparation failed.';
    h.l.cycle={stage,index:1,payouts:[{owner:key(),amount:'100'},{owner:key(),amount:'200'}],slot:99,claimedQuote:'300'};
    const before=structuredClone(h.l);
    await h.manager.process('a');assert.equal(h.l.operations.length,1);assert.equal(h.l.operations[0].kind,'protocol-enable');assert.equal(h.l.review.platformFeeBps,0);
    h.tx=receipt(h.l);await h.manager.process('a');assert.equal(h.l.review.platformFeeBps,100);assert.equal(h.l.operations[0].state,'confirmed');
    for(const field of ['state','cycle','credits','autoFees','feesRequested','error','input'])assert.deepEqual(h.l[field],before[field]);
    assert.equal(h.l.protocolFeesRequested,false);assert.equal(h.l.protocolError,'');
    await h.manager.process('a');assert.equal(h.l.operations.length,1);assert.deepEqual(h.l.cycle,before.cycle);
  }
});

test('explicit activation takes priority over unsigned queued rewards while keeping their automation preference',async t=>{
  const h=await harness(t);h.l.review.platformFeeBps=0;h.l.protocolActivation=policy();h.l.protocolClaimStage='activate';h.l.feesRequested=true;h.l.autoFees=true;h.l.cycle={stage:'claim',index:0};
  const cycle=structuredClone(h.l.cycle);await h.manager.process('a');assert.deepEqual(h.calls,['protocol-enable']);assert.deepEqual(h.l.cycle,cycle);assert.equal(h.l.feesRequested,true);assert.equal(h.l.autoFees,true);
});

test('queued activation never bypasses an unresolved or unsigned reward transaction',async t=>{
  for(const state of ['pending','awaiting_signature']){
    const h=await harness(t);h.l.review.platformFeeBps=0;h.l.protocolActivation=policy();h.l.protocolClaimStage='activate';h.l.state='paused';h.l.cycle={stage:'distribute',index:0};
    const op={kind:'buy',state,signature:'previous-buy',raw:'saved-buy-bytes',createdAt:10000,lastValidBlockHeight:100};h.l.operations.push(op);
    await h.manager.process('a');assert.equal(h.calls.length,0);assert.deepEqual(h.l.operations,[op]);assert.equal(h.l.review.platformFeeBps,0);assert.equal(h.l.protocolFeesRequested,true);
  }
});

test('activation failures and broadcast uncertainty retain the original paused reward state',async t=>{
  const h=await harness(t);h.l.review.platformFeeBps=0;h.l.protocolActivation=policy();h.l.protocolClaimStage='activate';h.l.state='paused';h.l.cycle={stage:'burn',index:0};h.l.error='Paused buyback needs attention.';
  h.c.broadcast=async()=>{throw Error('RPC disconnected');};await h.manager.process('a');
  assert.match(h.l.protocolError,/saved signature/);assert.equal(h.l.error,'Paused buyback needs attention.');
  h.advance(181000);await h.manager.process('a');assert.equal(h.l.operations.length,1);assert.equal(h.l.operations[0].raw,'signed');assert.match(h.l.protocolError,/unresolved/);
  h.tx=receipt(h.l,{err:{rejected:true}});await h.manager.process('a');assert.equal(h.l.operations[0].state,'failed');assert.equal(h.l.review.platformFeeBps,0);assert.equal(h.l.protocolFeesRequested,false);assert.equal(h.l.error,'Paused buyback needs attention.');assert.deepEqual(h.l.cycle,{stage:'burn',index:0});assert.equal(h.l.state,'paused');assert.equal(h.l.autoFees,false);
});
test('automatic protocol collection is hourly and does not switch on creator reward automation',async t=>{const h=await harness(t);h.l.review.protocolFees.autoHarvest=true;h.l.protocolFeesRequested=false;h.advance(3600000);h.c.claimInstructions=async(_,source)=>{assert.equal(source,'protocol-auto');return [];};await h.manager.process('a');assert.equal(h.l.autoFees,false);assert.equal(h.l.operations.length,0);assert(h.l.protocolNextHarvestAt>3600000);await h.manager.process('a');assert.equal(h.l.operations.length,0);});
function rayAccount(fields){const data=Buffer.alloc(ray.PlatformConfig.span);ray.PlatformConfig.encode({...ray.PlatformConfig.decode(data),...fields},data);createHash('sha256').update('account:PlatformConfig').digest().copy(data,0,0,8);return {owner:ray.LAUNCHPAD_PROGRAM,data,lamports:1000000};}
test('the real LaunchLab config encodes 1% platform fee and optional creation fee is atomic with token creation',async()=>{const l=launch();l.keys.platform=l.keys.wallet;l.input.name='Coin';l.input.symbol='COIN';l.uri='https://example.com/coin.json';l.review.protocolFees.creationFeeSol='0.03';const c=new LaunchChain({network:'mainnet-beta',connection:{}}),instructions=await c.launchInstructions(l,'platform'),ix=instructions.find(x=>x.programId.equals(ray.LAUNCHPAD_PROGRAM));assert.equal(ix.data.readBigUInt64LE(32),10000n);assert.equal(ix.data.readBigUInt64LE(24),1000000n);const creation=await c.launchInstructions(l,'create'),payment=SystemInstruction.decodeTransfer(creation.at(-1));assert.equal(payment.lamports,30000000n);assert.equal(payment.fromPubkey.toBase58(),l.keys.payer.address);assert.equal(payment.toPubkey.toBase58(),l.review.protocolFees.recipient);assert(creation[0].programId.equals(ray.LAUNCHPAD_PROGRAM));});
test('protocol vault claims target only the platform authority ATA and reject wrong mint or authority',async()=>{const l=launch(),map=new Map(),c=new LaunchChain({network:'mainnet-beta',connection:{getAccountInfo:async key=>map.get(key.toBase58())||null}}),a=c.addresses(l),vault=ray.getPdaPlatformVault(a.program,a.platform,a.q).publicKey;map.set(a.platform.toBase58(),rayAccount({feeRate:bn(10000),platformClaimFeeWallet:a.w}));const data=Buffer.alloc(AccountLayout.span);const state={mint:a.q,owner:ray.getPdaPlatformFeeVaultAuth(a.program).publicKey,amount:100000000n,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default};AccountLayout.encode(state,data);map.set(vault.toBase58(),{owner:TOKEN_PROGRAM_ID,data,lamports:2039280});const ixs=await c.claimInstructions(l,'protocol');assert.equal(ixs.length,2);assert.equal(ixs[1].keys[0].pubkey.toBase58(),l.keys.wallet.address);assert(ixs[1].keys.some(k=>k.pubkey.equals(getAssociatedTokenAddressSync(a.q,a.w))));state.mint=pk(key());AccountLayout.encode(state,data);await assert.rejects(c.claimInstructions(l,'protocol'),/vault is invalid/);});
test('automatic protocol collection requires a fresh price and skips less than $5',async()=>{const l=launch(),map=new Map(),c=new LaunchChain({network:'mainnet-beta',connection:{getAccountInfo:async key=>map.get(key.toBase58())||null}}),a=c.addresses(l),vault=ray.getPdaPlatformVault(a.program,a.platform,a.q).publicKey;map.set(a.platform.toBase58(),rayAccount({feeRate:bn(10000),platformClaimFeeWallet:a.w}));const data=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint:a.q,owner:ray.getPdaPlatformFeeVaultAuth(a.program).publicKey,amount:1000000n,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);map.set(vault.toBase58(),{owner:TOKEN_PROGRAM_ID,data,lamports:2039280});c.mintInfo=async()=>({});c.referencePrice=async()=>({usd:'100',at:Date.now()});assert.deepEqual(await c.claimInstructions(l,'protocol-auto'),[]);c.referencePrice=async()=>({usd:'100',at:1});await assert.rejects(c.claimInstructions(l,'protocol-auto'),/fresh quote price/);});

test('locked LP fees check every minute independently and forward both actual fee assets only to the platform',async t=>{
  const treasury={recipient:key(),recipientScope:'launchpad'},h=await harness(t,treasury);h.l.review.protocolFees.autoHarvest=true;h.l.review.protocolFees.lpPolicy='platform_locked';h.l.review.protocolFees.platformLpPercent=75;h.l.protocolFeesRequested=false;h.l.state='paused';h.advance(60000);
  h.c.protocolLiquidityInstructions=async(_,options)=>{assert.equal(options.automatic,true);return ['locked-fees'];};
  h.c.protocolPayoutInstructions=async(l,amounts)=>{assert.equal(l.review.protocolFees.recipient,h.l.review.protocolFees.recipient);assert.deepEqual(amounts,{quote:'10',base:'20',recipient:treasury.recipient});return ['treasury-transfer'];};
  await h.manager.process('a');assert.equal(h.l.operations[0].kind,'protocol-lp-claim');assert(h.l.protocolNextLpHarvestAt>=130000);assert.equal(h.l.protocolNextHarvestAt,undefined);assert.equal(h.calls.includes('protocol-auto'),false);
  h.tx=receipt(h.l,{quote:10n,base:20n});await h.manager.process('a');assert.equal(h.l.protocolCredit,'10');assert.equal(h.l.protocolBaseCredit,'20');assert.deepEqual(h.l.credits,{quote:'700',base:'900'});
  h.tx=null;await h.manager.process('a');assert.equal(h.l.operations.at(-1).kind,'protocol-lp-payout');h.tx=receipt(h.l,{quote:-10n,base:-20n});await h.manager.process('a');assert.equal(h.l.protocolCredit,'0');assert.equal(h.l.protocolBaseCredit,'0');assert.equal(h.l.protocolPaid,'10');assert.equal(h.l.protocolBasePaid,'20');assert.deepEqual(h.l.credits,{quote:'700',base:'900'});assert.equal(h.l.state,'paused');
});
test('an empty LP simulation spends no gas and schedules the next check without touching reward credits',async t=>{
  const h=await harness(t);h.l.review.protocolFees.autoHarvest=true;h.l.review.protocolFees.lpPolicy='platform_locked';h.l.protocolFeesRequested=false;h.advance(60000);
  h.c.protocolLiquidityInstructions=async()=>['claim'];h.c.prepare=async()=>{throw Object.assign(Error('No fees'),{code:'PROTOCOL_HARVEST_DEFERRED'});};
  await h.manager.process('a');assert.equal(h.l.operations.length,0);assert.equal(h.l.gas.reserved,'0');assert.equal(h.l.protocolFeesRequested,false);assert.deepEqual(h.l.credits,{quote:'700',base:'900'});assert(h.l.protocolNextLpHarvestAt>70000);
});
test('protocol collection completes at unsigned reward boundaries without changing saved rewards',async t=>{
  for(const stage of ['tax','payout',null]){
    const h=await harness(t);h.l.state='paused';h.l.feesRequested=true;h.l.feeAutomation={enabled:false,source:'admin',updatedAt:10000};
    h.l.review.protocolFees.lpPolicy='platform_locked';h.l.review.protocolFees.platformLpPercent=75;
    if(stage)h.l.cycle={stage,index:1,slot:91,payouts:[{owner:key(),amount:'100'},{owner:key(),amount:'200'}],claimedQuote:'300'};
    h.l.nativeRewardDebts={version:1,payouts:[{owner:key(),amount:'123'}]};h.l.error='Saved reward preparation needs attention.';
    const fields=['state','cycle','credits','nativeRewardDebts','autoFees','feeAutomation','feesRequested','error'],before=Object.fromEntries(fields.map(k=>[k,structuredClone(h.l[k])]));
    const preserved=()=>{for(const field of fields)assert.deepEqual(h.l[field],before[field],field);};
    h.c.protocolLiquidityInstructions=async()=>['lp-claim'];h.c.protocolPayoutInstructions=async(_,amounts)=>{assert.deepEqual(amounts,{quote:'30',base:'5',recipient:h.l.review.protocolFees.recipient});return ['treasury-payout'];};
    await h.manager.process('a');assert.equal(h.l.operations.at(-1)?.kind,'protocol-claim');preserved();
    h.tx=receipt(h.l,{quote:20n});await h.manager.process('a');preserved();
    h.tx=null;await h.manager.process('a');assert.equal(h.l.operations.at(-1).kind,'protocol-lp-claim');preserved();
    h.tx=receipt(h.l,{quote:10n,base:5n});await h.manager.process('a');preserved();
    h.tx=null;await h.manager.process('a');assert.equal(h.l.operations.at(-1).kind,'protocol-lp-payout');preserved();
    h.tx=receipt(h.l,{quote:-30n,base:-5n});await h.manager.process('a');preserved();
    assert.equal(h.l.protocolCredit,'0');assert.equal(h.l.protocolBaseCredit,'0');assert.equal(h.l.protocolPaid,'30');assert.equal(h.l.protocolBasePaid,'5');assert.equal(h.l.protocolFeesRequested,false);
    const count=h.l.operations.length;await h.manager.process('a');assert.equal(h.l.operations.length,count);preserved();
  }
});
test('automatic LP collection wakes during reward backoff and preserves its retry schedule',async t=>{
  const h=await harness(t);h.l.review.protocolFees.autoHarvest=true;h.l.review.protocolFees.lpPolicy='platform_locked';h.l.protocolFeesRequested=false;
  h.l.autoFees=true;h.l.feeAutomation={enabled:true,source:'admin',updatedAt:10000};h.l.feesRequested=true;h.l.cycle={stage:'tax',index:0};
  h.l.rewardRetry={attempt:6,at:970000,kind:'network',reason:'Token-account scan is temporarily unavailable.'};
  const saved=structuredClone({cycle:h.l.cycle,credits:h.l.credits,retry:h.l.rewardRetry});let checks=0;h.c.protocolLiquidityInstructions=async()=>{checks++;return [];};
  await h.manager.process('a');assert.equal(checks,0);assert.equal(h.manager.wakeAt.get('a'),60001);
  h.advance(60000);await h.manager.process('a');assert.equal(checks,1);assert.equal(h.l.protocolNextLpHarvestAt,130000);assert.equal(h.manager.wakeAt.get('a'),130000);
  await h.manager.process('a');assert.equal(checks,1);assert.equal(h.l.operations.length,0);
  assert.deepEqual({cycle:h.l.cycle,credits:h.l.credits,retry:h.l.rewardRetry},saved);assert.equal(h.l.feesRequested,true);assert.equal(h.l.autoFees,true);
});
test('protocol collection never bypasses a pending or awaiting-signature reward transaction',async t=>{
  for(const state of ['pending','awaiting_signature'])for(const automatic of [false,true]){
    const h=await harness(t);h.l.review.protocolFees.autoHarvest=automatic;h.l.review.protocolFees.lpPolicy='platform_locked';h.l.protocolFeesRequested=!automatic;
    h.l.state='paused';h.l.feeAutomation={enabled:false,source:'admin',updatedAt:10000};h.l.feesRequested=true;h.l.cycle={stage:'payout',index:1};h.advance(60000);
    const op={kind:'payout',state,signature:'saved-holder-receipt',raw:'exact-holder-bytes',createdAt:70000,lastValidBlockHeight:100};h.l.operations.push(op);
    const before=structuredClone(h.l);let claims=0;h.c.protocolLiquidityInstructions=async()=>{claims++;return ['lp'];};
    await h.manager.process('a');assert.equal(claims,0);assert.equal(h.calls.length,0);assert.deepEqual(h.l.operations,[op]);assert.deepEqual(h.l.cycle,before.cycle);assert.deepEqual(h.l.credits,before.credits);
  }
});
test('queued protocol work finishes before enabled rewards resume their exact unsigned step',async t=>{
  const h=await harness(t);h.l.autoFees=true;h.l.feeAutomation={enabled:true,source:'admin',updatedAt:10000};h.l.feesRequested=true;h.l.cycle={stage:'payout',index:1,payouts:[{owner:key(),amount:'10'},{owner:key(),amount:'20'}],slot:99};
  const cycle=structuredClone(h.l.cycle);let rewardCalls=0;h.manager.advanceFees=async(_id,_book,l)=>{rewardCalls++;assert.deepEqual(l.cycle,cycle);assert.equal(l.feesRequested,true);};
  await h.manager.process('a');assert.equal(h.l.operations.at(-1)?.kind,'protocol-claim');assert.equal(rewardCalls,0);
  h.tx=receipt(h.l,{quote:12n});await h.manager.process('a');h.tx=null;await h.manager.process('a');assert.equal(h.l.operations.at(-1).kind,'protocol-payout');assert.equal(rewardCalls,0);
  h.tx=receipt(h.l,{quote:-12n});await h.manager.process('a');h.tx=null;assert.equal(h.l.protocolFeesRequested,false);
  await h.manager.process('a');assert.equal(rewardCalls,1);assert.deepEqual(h.l.cycle,cycle);assert.deepEqual(h.l.credits,{quote:'700',base:'900'});
});
test('queued protocol collection interleaves held-SOL batches without changing their authorization or snapshot',async t=>{
  const h=await harness(t);h.l.state='paused';h.l.feesRequested=false;
  h.l.heldSolDistribution={version:1,state:'processing',requestId:'saved-request',actorId:'saved-admin',operationIndex:0,amountLamports:'700',nextAttemptAt:970000,previous:{state:'paused',error:'Explicit pause',feesRequested:false}};
  h.l.cycle={stage:'payout',index:1,heldSolDistributionRequest:'saved-request',slot:99,payouts:[{owner:key(),amount:'100'},{owner:key(),amount:'200'}]};
  h.l.nativeRewardDebts={version:1,payouts:[{owner:key(),amount:'100'}]};
  const fields=['state','cycle','credits','nativeRewardDebts','heldSolDistribution','feeAutomation','feesRequested','autoFees'];const before=Object.fromEntries(fields.map(k=>[k,structuredClone(h.l[k])]));
  const preserved=()=>{for(const field of fields)assert.deepEqual(h.l[field],before[field],field);};let heldSteps=0;h.manager.advanceHeldSolDistribution=async()=>{heldSteps++;};
  await h.manager.process('a');assert.equal(h.l.operations.at(-1)?.kind,'protocol-claim');assert.equal(h.manager.wakeAt.get('a'),11000);preserved();
  h.tx=receipt(h.l,{quote:12n});await h.manager.process('a');assert.equal(h.l.operations[0].state,'confirmed');preserved();
  h.tx=null;await h.manager.process('a');assert.equal(h.l.operations.at(-1).kind,'protocol-payout');preserved();
  h.tx=receipt(h.l,{quote:-12n});await h.manager.process('a');assert.equal(h.l.protocolPaid,'12');assert.equal(h.l.protocolFeesRequested,false);assert.equal(heldSteps,0);preserved();
  await h.manager.process('a');assert.equal(heldSteps,0);assert.equal(h.manager.wakeAt.get('a'),970000);
  h.advance(960000);await h.manager.process('a');assert.equal(heldSteps,1);preserved();
});
test('automatic LP wake crosses held-SOL backoff but cannot bypass its saved payout receipt',async t=>{
  const h=await harness(t);h.l.state='paused';h.l.review.protocolFees.autoHarvest=true;h.l.review.protocolFees.lpPolicy='platform_locked';h.l.protocolFeesRequested=false;
  h.l.heldSolDistribution={version:1,state:'processing',requestId:'saved-request',actorId:'saved-admin',nextAttemptAt:970000};h.l.cycle={stage:'payout',index:1,heldSolDistributionRequest:'saved-request'};
  const before=structuredClone({request:h.l.heldSolDistribution,cycle:h.l.cycle,credits:h.l.credits});let lp=0;h.c.protocolLiquidityInstructions=async()=>{lp++;return [];};
  await h.manager.process('a');assert.equal(h.manager.wakeAt.get('a'),60001);assert.equal(lp,0);
  h.advance(60000);await h.manager.process('a');assert.equal(lp,1);assert.equal(h.manager.wakeAt.get('a'),130000);assert.deepEqual({request:h.l.heldSolDistribution,cycle:h.l.cycle,credits:h.l.credits},before);
  const op={kind:'payout',state:'pending',signature:'saved-held-receipt',raw:'exact-held-bytes',createdAt:70000,lastValidBlockHeight:100,heldSolDistributionRequest:'saved-request'};h.l.operations.push(op);h.l.protocolFeesRequested=true;
  delete h.l.heldSolDistribution.nextAttemptAt;await h.manager.process('a');assert.equal(lp,1);assert.deepEqual(h.l.operations,[op]);assert.deepEqual(h.l.credits,before.credits);
  h.l.operations[0].state='awaiting_signature';let heldSteps=0;h.manager.advanceHeldSolDistribution=async()=>{heldSteps++;};
  await h.manager.process('a');assert.equal(lp,1);assert.equal(heldSteps,0);assert.equal(h.l.operations.length,1);assert.equal(h.manager.wakeAt.get('a'),Infinity);
});
test('automatic LP simulation accepts base-only income and rejects empty or negative asset changes',async()=>{
  const l=launch(),w=pk(l.keys.wallet.address);let quoteDelta=0n,baseDelta=1n;
  const token=(mint,amount)=>{const data=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint,owner:w,amount,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);return {owner:TOKEN_PROGRAM_ID,data,lamports:2039280};};
  const before=[token(pk(l.input.quoteMint),100n),token(pk(l.keys.mint.address),200n)];
  const c=new LaunchChain({network:'mainnet-beta',connection:{getLatestBlockhash:async()=>({blockhash:key(),lastValidBlockHeight:100}),getMultipleAccountsInfoAndContext:async()=>({context:{slot:50},value:before}),simulateTransaction:async(_,options)=>{assert.equal(options.accounts.addresses.length,2);const after=[token(pk(l.input.quoteMint),100n+quoteDelta),token(pk(l.keys.mint.address),200n+baseDelta)];return {context:{slot:50},value:{err:null,accounts:after.map(a=>({...a,owner:a.owner.toBase58(),data:[a.data.toString('base64'),'base64']}))}};}}});
  const instructions=[SystemProgram.transfer({fromPubkey:w,toPubkey:pk(key()),lamports:0})];instructions.protocolHarvestMinimum=true;
  assert.equal((await c.prepare(l,instructions)).state,'pending');baseDelta=0n;await assert.rejects(c.prepare(l,instructions),e=>e.code==='PROTOCOL_HARVEST_DEFERRED');baseDelta=-1n;await assert.rejects(c.prepare(l,instructions),/unexpectedly spent/);quoteDelta=1n;baseDelta=0n;assert.equal((await c.prepare(l,instructions)).state,'pending');
});

test('historical creator fee transactions already journaled still require exact finalized receipt verification',async t=>{
  const h=await harness(t);h.l.protocolFeesRequested=false;h.l.input.creatorFeePolicy='sol-market-cap-v1';h.l.review.creatorFeePolicy='sol-market-cap-v1';h.l.review.creatorFeeRatePpm=3000;
  const decision={policy:'sol-market-cap-v1',status:'ready',previousRatePpm:3000,ratePpm:5000,checkedAt:10000,nextAt:70000,marketSlot:40};
  decision.platformHash='verified-preserved-fields';h.l.operations.push({kind:'creator-fee-update',state:'pending',raw:'already-signed',signature:'legacy-tier-signature',createdAt:10000,lastValidBlockHeight:100,creatorFeeDecision:decision});
  h.c.verifyCreatorFeeUpdate=async()=>{throw Error('RPC still behind');};
  assert.equal((await h.manager.refreshCreatorFee('a',h.l.id)).status,'deferred');assert.equal(h.l.operations.length,1);
  h.tx=receipt(h.l);await h.manager.process('a');assert.equal(h.l.creatorFees,undefined);assert.equal(h.l.operations[0].state,'pending');assert.equal(h.l.autoFees,false);
  h.c.verifyCreatorFeeUpdate=async()=>true;await h.manager.process('a');assert.equal(h.l.creatorFees.ratePpm,5000);assert.equal(h.l.creatorFees.status,'active');assert.equal(h.l.review.creatorFeeRatePpm,3000);assert.deepEqual(h.l.credits,{quote:'700',base:'900'});
});

test('platform branding journals signed bytes and confirms independently without changing launch snapshots or fee credits',async t=>{
  const h=await harness(t);h.l.protocolFeesRequested=false;h.l.brandingRequested=true;h.l.brandingUpdate={target:{...LAUNCHPAD_PLATFORM_BRAND}};
  h.l.uri='https://gateway.irys.xyz/immutable-token';h.l.storage={items:[{id:'immutable-logo',raw:'original-signed-upload'}]};h.l.reviewHash='original-review';
  const original=structuredClone({input:h.l.input,review:h.l.review,uri:h.l.uri,storage:h.l.storage,reviewHash:h.l.reviewHash,credits:h.l.credits});
  h.c.platformBrandUpdateInstructions=async(_,decision)=>{decision.platformHash='verified-state-hash';return ['brand-only'];};h.c.verifyPlatformBrandUpdate=async()=>{throw Error('RPC readback unavailable');};
  await h.manager.process('a');assert.equal(h.l.operations[0].kind,'platform-brand-update');assert.equal(h.l.operations[0].brandDecision.platformHash,'verified-state-hash');assert.equal(h.l.platformBrand,undefined);
  h.tx=receipt(h.l);await h.manager.process('a');assert.equal(h.l.brandingRequested,true);assert.equal(h.l.operations[0].state,'pending');assert.equal(h.l.operations[0].raw,'signed');assert.equal(h.l.platformBrand,undefined);
  h.c.verifyPlatformBrandUpdate=async()=>true;await h.manager.process('a');assert.equal(h.l.platformBrand.name,'Launchpad');assert.equal(h.l.platformBrand.signature,'sig1');assert.equal(h.l.operations[0].state,'confirmed');assert.equal(h.l.brandingRequested,false);assert.equal(h.l.brandingUpdate,undefined);
  assert.deepEqual({input:h.l.input,review:h.l.review,uri:h.l.uri,storage:h.l.storage,reviewHash:h.l.reviewHash,credits:h.l.credits},original);
});
test('branding failures and unresolved receipts preserve owner rewards and never replace pending bytes',async t=>{
  const h=await harness(t);h.l.protocolFeesRequested=false;h.l.brandingRequested=true;h.l.brandingUpdate={target:{...LAUNCHPAD_PLATFORM_BRAND}};h.c.platformBrandUpdateInstructions=async()=>['brand-only'];
  await h.manager.process('a');await h.manager.action('a',h.l.id,'resume',{autoFees:true});h.advance(181000);await h.manager.process('a');assert.match(h.l.brandingError,/unresolved/);assert.equal(h.l.operations.length,1);assert.equal(h.l.operations[0].raw,'signed');assert.equal(h.l.autoFees,true);assert.equal(h.l.feeAutomation.enabled,true);assert.equal(h.l.feesRequested,true);
  h.tx=receipt(h.l,{err:{rejected:true}});await h.manager.process('a');assert.equal(h.l.operations[0].state,'failed');assert.equal(h.l.brandingRequested,false);assert.equal(h.l.autoFees,true);assert.equal(h.l.feeAutomation.enabled,true);assert.equal(h.l.feesRequested,true);assert.equal(h.l.platformBrand,undefined);assert.deepEqual(h.l.credits,{quote:'700',base:'900'});
});

test('explicit branding updates preserve saved paused rewards and prioritize over unsigned work',async t=>{
  for(const state of ['paused','live']){
    const h=await harness(t);h.l.protocolFeesRequested=false;h.l.state=state;h.l.autoFees=state==='live';h.l.feesRequested=true;h.l.error='Saved reward pause reason.';
    h.l.cycle={stage:'payout',index:1,payouts:[{owner:key(),amount:'100'},{owner:key(),amount:'200'}],slot:99};
    h.l.brandingRequested=true;h.l.brandingUpdate={target:{...LAUNCHPAD_PLATFORM_BRAND}};
    h.c.platformBrandUpdateInstructions=async()=>['branding'];h.c.verifyPlatformBrandUpdate=async()=>true;
    const before=structuredClone(h.l);await h.manager.process('a');assert.deepEqual(h.calls,['platform-brand-update']);
    h.tx=receipt(h.l);await h.manager.process('a');assert.equal(h.l.platformBrand.version,LAUNCHPAD_PLATFORM_BRAND.version);assert.equal(h.l.brandingRequested,false);
    for(const field of ['cycle','credits','state','autoFees','feesRequested','error','review','input'])assert.deepEqual(h.l[field],before[field]);
  }
});

test('queued branding cannot replace an unresolved reward signature',async t=>{
  const h=await harness(t);h.l.protocolFeesRequested=false;h.l.brandingRequested=true;h.l.brandingUpdate={target:{...LAUNCHPAD_PLATFORM_BRAND}};h.l.state='paused';h.l.cycle={stage:'burn',index:0};
  h.l.operations.push({kind:'burn',state:'pending',signature:'saved-burn',raw:'signed-burn',createdAt:10000,lastValidBlockHeight:100});
  await h.manager.process('a');assert.equal(h.calls.length,0);assert.equal(h.l.operations.length,1);assert.equal(h.l.operations[0].raw,'signed-burn');assert.equal(h.l.brandingRequested,true);assert.equal(h.l.platformBrand,undefined);
});


test('policy upgrade journals its exact target and commits fee and LP records together only after verification',async t=>{
  const h=await harness(t);h.l.review.platformFeeBps=0;h.l.protocolActivation={...policy(),...protocolPolicyTarget()};h.l.protocolClaimStage='activate';
  h.l.cycle={stage:'burn',index:1};h.l.state='paused';const input=structuredClone(h.l.input),cycle=structuredClone(h.l.cycle),review=structuredClone(h.l.review);
  h.c.protocolActivationInstructions=async l=>{l.protocolActivation.platformHash='a'.repeat(64);l.protocolActivation.platformSlot=40;return ['upgrade'];};
  await h.manager.process('a');const op=h.l.operations[0];assert.equal(op.protocolPolicy.creatorFeeRatePpm,5000);assert.equal(op.protocolPolicy.platformLpPercent,75);assert.deepEqual(h.l.review,review);assert.equal(effectiveCreatorFeeRate(h.l),2500);
  h.l.protocolActivation.platformLpPercent=100;h.tx=receipt(h.l);h.c.verifyProtocolActivation=async(_l,_slot,target)=>{assert.equal(target.platformLpPercent,75);throw Error('Readback stale');};
  await h.manager.process('a');assert.equal(h.l.operations[0].state,'pending');assert.deepEqual(h.l.review,review);assert.equal(h.l.creatorFees,undefined);
  h.c.verifyProtocolActivation=async(_l,_slot,target)=>{assert.equal(target.platformLpPercent,75);return true;};await h.manager.process('a');
  assert.equal(h.l.operations[0].state,'confirmed');assert.equal(h.l.review.protocolFees.platformLpPercent,75);assert.equal(h.l.review.platformFeeBps,100);assert.equal(effectiveCreatorFeeRate(h.l),5000);assert.equal(h.l.creatorFees.policy,'flat-0.5-v2');assert.match(h.l.review.lp,/75%.*locked.*25%.*burned/);
  assert.deepEqual(h.l.input,input);assert.deepEqual(h.l.cycle,cycle);assert.deepEqual(h.l.credits,{quote:'700',base:'900'});assert.equal(h.l.state,'paused');assert.equal(h.l.protocolPolicyUpgrades.length,1);assert.equal(h.l.protocolPolicyUpgrades[0].previous.creatorFeeRatePpm,2500);
  await h.manager.process('a');assert.equal(h.l.protocolPolicyUpgrades.length,1);assert.equal(h.l.operations.length,1);
});
test('failed policy transactions leave fee and LP records unchanged and cannot create fee credit',async t=>{
  const h=await harness(t);h.l.review.platformFeeBps=0;h.l.protocolActivation={...policy(),...protocolPolicyTarget()};h.l.protocolClaimStage='activate';const before=structuredClone(h.l.review);
  await h.manager.process('a');h.tx=receipt(h.l,{err:{InstructionError:[0,'Rejected']}});await h.manager.process('a');
  assert.deepEqual(h.l.review,before);assert.equal(h.l.creatorFees,undefined);assert.equal(h.l.protocolPolicyUpgrades,undefined);assert.equal(h.l.operations[0].state,'failed');assert.deepEqual(h.l.credits,{quote:'700',base:'900'});
});

function legacyPlatformProtocol(l){
  delete l.feeCustody;l.keys.platform=newLaunchKeys().wallet;l.keys.payer=l.keys.wallet;l.walletExportedAt=1;
  l.review.platformFeeBps=0;l.protocolClaimStage='activate';l.protocolActivation={...policy(),...protocolPolicyTarget(),protocolFeeWallet:{source:'platform',address:l.keys.platform.address}};
  return {source:'platform',address:l.keys.platform.address};
}
function platformReceipt(l,options={}){return receipt({...l,keys:{...l.keys,wallet:l.keys.platform}},options);}

test('legacy upgrade and restart retain separate protocol signing and receipts without adopting creator custody',async t=>{
  const h=await harness(t),selection=legacyPlatformProtocol(h.l),original=structuredClone(h.l),prepare=h.c.prepare;
  h.l.state='paused';h.c.c.getBalance=async wallet=>{assert.equal(String(wallet),selection.address);return 10000000;};
  h.c.prepare=async(view,ixs,extra)=>{assert.equal(view.keys.wallet.address,selection.address);assert.equal(view.keys.wallet.secret,original.keys.platform.secret);assert.equal(extra.length,0);return prepare();};
  await h.manager.process('a');assert.equal(h.l.protocolFeeWallet,undefined);assert.deepEqual(h.l.operations[0].protocolFeeWallet,selection);assert.deepEqual(h.l.operations[0].protocolPolicy.protocolFeeWallet,selection);
  h.l.protocolActivation.protocolFeeWallet.address=key();h.tx=platformReceipt(h.l);h.c.verifyProtocolActivation=async(_l,_slot,target)=>{assert.deepEqual(target.protocolFeeWallet,selection);throw Error('Waiting for finalized rotation');};
  await h.manager.process('a');assert.equal(h.l.protocolFeeWallet,undefined);assert.equal(h.l.operations[0].state,'pending');assert.equal(h.l.review.platformFeeBps,0);
  h.c.verifyProtocolActivation=async()=>true;await h.manager.close();
  const restarted=new Launchpad(h.manager.accounts,null,{chainFactory:()=>h.c,now:()=>10000});t.after(()=>restarted.close());restarted.kick=()=>{};
  await restarted.process('a');assert.deepEqual(h.l.protocolFeeWallet,selection);assert.equal(h.l.operations[0].state,'confirmed');assert.equal(h.l.review.platformFeeBps,100);assert.equal(h.l.review.protocolFees.platformLpPercent,75);assert.equal(h.l.creatorFees.ratePpm,5000);
  for(const field of ['keys','feeCustody','input','credits','walletExportedAt'])assert.deepEqual(h.l[field],original[field]);
  h.tx=null;h.l.protocolFeesRequested=true;h.l.protocolClaimStage='claim';await restarted.process('a');assert.equal(h.l.operations.at(-1).kind,'protocol-claim');
  h.tx=platformReceipt(h.l,{quote:123n});await restarted.process('a');assert.equal(h.l.protocolCredit,'123');assert.equal(h.l.protocolClaimed,'123');assert.deepEqual(h.l.credits,original.credits);
  h.tx=null;h.l.protocolClaimStage='payout';h.c.payoutInstructions=async(view,rows)=>{assert.equal(view.keys.wallet.address,selection.address);assert.equal(rows[0].amount,'123');return ['payout'];};
  await restarted.process('a');assert.equal(h.l.operations.at(-1).kind,'protocol-payout');h.tx=platformReceipt(h.l,{quote:-123n});await restarted.process('a');assert.equal(h.l.protocolPaid,'123');assert.equal(h.l.protocolCredit,'0');assert.deepEqual(h.l.credits,original.credits);
});

test('unfunded legacy platform wallet stops before signing and can retry after funding',async t=>{
  const h=await harness(t),selection=legacyPlatformProtocol(h.l);h.c.c.getBalance=async()=>0;
  await h.manager.process('a');assert.equal(h.l.operations.length,0);assert.equal(h.l.protocolFeesRequested,false);assert.equal(h.l.protocolFeeWallet,undefined);assert.equal(h.l.review.platformFeeBps,0);assert.match(h.l.protocolError,new RegExp(selection.address));assert.match(h.l.protocolError,/Add SOL to the upgrade gas wallet/);
  h.c.c.getBalance=async()=>10000000;h.l.protocolFeesRequested=true;await h.manager.process('a');assert.equal(h.l.operations.length,1);assert.equal(h.l.operations[0].kind,'protocol-enable');
});

test('legacy protocol receipt accounting ignores tokens in the creator wallet and preserves queued wallet identity',async t=>{
  const h=await harness(t),selection=legacyPlatformProtocol(h.l);h.l.protocolFeeWallet=selection;h.l.review.platformFeeBps=100;h.l.protocolClaimStage='claim';delete h.l.protocolActivation;
  await h.manager.process('a');const tx=platformReceipt(h.l,{quote:7n});
  tx.meta.postTokenBalances.push({owner:h.l.keys.wallet.address,mint:h.l.input.quoteMint,accountIndex:3,uiTokenAmount:{amount:'999999999'}});h.tx=tx;
  await h.manager.process('a');assert.equal(h.l.protocolCredit,'7');assert.equal(h.l.operations[0].receipt.quoteDelta,'7');assert.deepEqual(h.l.credits,{quote:'700',base:'900'});
});

test('real legacy platform claims and payouts use platform ATAs while graduated creator identity stays original',async()=>{
  const l=launch(),selection=legacyPlatformProtocol(l);l.protocolFeeWallet=selection;l.review.platformFeeBps=100;
  const map=new Map(),c=new LaunchChain({network:'mainnet-beta',connection:{getAccountInfo:async key=>map.get(String(key))||null,getMinimumBalanceForRentExemption:async()=>2039280}}),a=c.addresses(l),owner=pk(selection.address),vault=ray.getPdaPlatformVault(a.program,a.platform,a.q).publicKey;
  map.set(String(a.platform),rayAccount({feeRate:bn(10000),platformClaimFeeWallet:owner}));const data=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint:a.q,owner:ray.getPdaPlatformFeeVaultAuth(a.program).publicKey,amount:100000n,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);map.set(String(vault),{owner:TOKEN_PROGRAM_ID,data,lamports:2039280});
  const claim=await c.claimInstructions(l,'protocol');assert(claim[1].keys[0].pubkey.equals(owner));assert(claim[1].keys.some(k=>k.pubkey.equals(getAssociatedTokenAddressSync(a.q,owner))));
  c.mintInfo=async()=>({program:TOKEN_PROGRAM_ID,mint:{decimals:6}});const payout=await c.protocolPayoutInstructions(l,{quote:'3',base:'5'}),base=decodeTransferCheckedInstruction(payout.at(-1));assert(base.keys.owner.pubkey.equals(owner));assert(base.keys.source.pubkey.equals(getAssociatedTokenAddressSync(a.m,owner)));assert.equal(base.data.amount,5n);
  assert.equal(c.addresses(l).w.toBase58(),l.keys.wallet.address);assert.notEqual(c.addresses(l).w.toBase58(),selection.address);
});

function freshProtocolRecipient(l){
  const administrator=legacyPlatformProtocol(l);
  l.keys.protocol=newLaunchKeys().wallet;
  const recipient={source:'protocol',address:l.keys.protocol.address};
  l.protocolActivation.protocolFeeWallet={...recipient};
  return {administrator,recipient};
}
function protocolReceipt(l,options={}){return receipt({...l,keys:{...l.keys,wallet:l.keys.protocol}},options);}

test('fresh protocol recipient upgrade signs and pays with the original administrator and commits only finalized settings',async t=>{
  const h=await harness(t),{administrator,recipient}=freshProtocolRecipient(h.l),original=structuredClone(h.l);
  h.l.state='paused';h.l.cycle={stage:'burn',index:1};
  h.c.c.getBalance=async wallet=>{assert.equal(String(wallet),administrator.address);return 10000000;};
  const chain=new LaunchChain({network:'mainnet-beta',connection:{getLatestBlockhash:async()=>({blockhash:key(),lastValidBlockHeight:100})}});
  chain.simulatePrepared=async()=>({context:{slot:40},value:{err:null,unitsConsumed:10000}});
  h.c.protocolActivationInstructions=async()=>[SystemProgram.transfer({fromPubkey:pk(administrator.address),toPubkey:pk(recipient.address),lamports:0})];
  h.c.prepare=async(view,instructions,extra,initial)=>{assert.equal(view.keys.wallet.address,administrator.address);assert.equal(initial,false);assert.deepEqual(extra,[]);return chain.prepare(view,instructions,extra,initial);};
  await h.manager.process('a');assert.equal(h.l.operations.length,1,h.l.protocolError);
  const pending=structuredClone(h.l.operations[0]),signed=VersionedTransaction.deserialize(Buffer.from(pending.raw,'base64'));
  assert.equal(signed.message.staticAccountKeys[0].toBase58(),administrator.address);assert.equal(signed.message.header.numRequiredSignatures,1);
  assert(signed.signatures[0].some(byte=>byte!==0));assert.deepEqual(pending.protocolFeeWallet,administrator);assert.deepEqual(pending.protocolPolicy.protocolFeeWallet,recipient);
  assert.equal(h.l.protocolFeeWallet,undefined);assert.equal(h.l.review.platformFeeBps,0);
  // The new recipient is not the transaction payer. Such a receipt must not be
  // mistaken for proof that the administrator's saved transaction completed.
  h.tx=protocolReceipt(h.l);await h.manager.process('a');assert.equal(h.l.operations[0].state,'pending');assert.equal(h.l.protocolFeeWallet,undefined);assert.match(h.l.protocolError,/receipt is missing/);
  h.tx=platformReceipt(h.l);h.l.protocolActivation.protocolFeeWallet.address=key();
  h.c.verifyProtocolActivation=async(_l,slot,target)=>{assert.equal(slot,42);assert.deepEqual(target.protocolFeeWallet,recipient);throw Error('Waiting for finalized recipient');};
  await h.manager.process('a');assert.equal(h.l.operations[0].state,'pending');assert.equal(h.l.operations[0].raw,pending.raw);assert.equal(h.l.protocolFeeWallet,undefined);assert.deepEqual(h.l.review,original.review);
  await h.manager.close();h.c.verifyProtocolActivation=async(_l,_slot,target)=>{assert.deepEqual(target.protocolFeeWallet,recipient);return true;};
  const restarted=new Launchpad(h.manager.accounts,null,{chainFactory:()=>h.c,now:()=>10000});t.after(()=>restarted.close());restarted.kick=()=>{};
  await restarted.process('a');assert.equal(h.l.operations[0].state,'confirmed');assert.deepEqual(h.l.protocolFeeWallet,recipient);assert.equal(h.l.review.protocolFees.platformLpPercent,75);assert.equal(h.l.creatorFees.ratePpm,5000);
  for(const field of ['keys','input','credits','walletExportedAt','feeCustody'])assert.deepEqual(h.l[field],original[field]);
  assert.equal(h.l.state,'paused');assert.deepEqual(h.l.cycle,{stage:'burn',index:1});assert.equal(h.l.protocolPolicyUpgrades.length,1);
});

test('fresh recipient keys survive preparation failure and exact signed retries without spending creator credits',async t=>{
  const h=await harness(t),{administrator,recipient}=freshProtocolRecipient(h.l),keys=structuredClone(h.l.keys),target=structuredClone(h.l.protocolActivation),prepare=h.c.prepare;
  h.c.c.getBalance=async()=>10000000;let attempts=0;
  h.c.prepare=async(view)=>{assert.equal(view.keys.wallet.address,administrator.address);attempts++;if(attempts===1)throw Error('RPC simulation unavailable');return prepare();};
  await h.manager.process('a');assert.equal(h.l.operations.length,0);assert.equal(h.l.protocolFeesRequested,false);assert.deepEqual(h.l.keys,keys);assert.deepEqual(h.l.protocolActivation,target);
  h.l.protocolFeesRequested=true;await h.manager.process('a');assert.equal(h.l.operations.length,1,h.l.protocolError);const pending=structuredClone(h.l.operations[0]);
  h.advance(16000);await h.manager.process('a');assert.equal(attempts,2);assert.equal(h.l.operations.length,1);assert.equal(h.l.operations[0].raw,pending.raw);assert.equal(h.l.operations[0].signature,pending.signature);
  assert.deepEqual(h.l.operations[0].protocolPolicy.protocolFeeWallet,recipient);assert.deepEqual(h.l.operations[0].protocolFeeWallet,administrator);assert.deepEqual(h.l.keys,keys);assert.deepEqual(h.l.credits,{quote:'700',base:'900'});
});

test('after fresh recipient confirmation protocol claims use its signer and receipts while creator identity stays unchanged',async t=>{
  const h=await harness(t),{administrator,recipient}=freshProtocolRecipient(h.l),original=structuredClone(h.l),prepare=h.c.prepare;
  h.c.c.getBalance=async()=>10000000;let signingAddress=administrator.address;
  h.c.prepare=async(view)=>{assert.equal(view.keys.wallet.address,signingAddress);return prepare();};
  await h.manager.process('a');assert.equal(h.l.operations.length,1,h.l.protocolError);h.tx=platformReceipt(h.l);await h.manager.process('a');assert.deepEqual(h.l.protocolFeeWallet,recipient);
  signingAddress=recipient.address;h.tx=null;h.l.protocolFeesRequested=true;h.l.protocolClaimStage='claim';await h.manager.process('a');assert.equal(h.l.operations.at(-1).kind,'protocol-claim');assert.deepEqual(h.l.operations.at(-1).protocolFeeWallet,recipient);
  const tx=protocolReceipt(h.l,{quote:17n});tx.meta.postTokenBalances.push({owner:original.keys.wallet.address,mint:h.l.input.quoteMint,accountIndex:3,uiTokenAmount:{amount:'9000000'}});h.tx=tx;
  await h.manager.process('a');assert.equal(h.l.protocolCredit,'17');assert.equal(h.l.protocolClaimed,'17');assert.deepEqual(h.l.credits,original.credits);assert.deepEqual(h.l.keys,original.keys);assert.equal(h.l.walletExportedAt,1);assert.equal(h.l.feeCustody,undefined);
});

test('fresh recipient activation cannot sign with a missing, external or compromised original administrator',async t=>{
  for(const mutate of [l=>{delete l.keys.platform.secret;},l=>{l.keys.platform.external=true;},l=>{l.keys.platform.compromisedAt=1;}]){
    const h=await harness(t),{administrator}=freshProtocolRecipient(h.l);mutate(h.l);const before=structuredClone(h.l);
    h.c.c.getBalance=async()=>10000000;
    const chain=new LaunchChain({network:'mainnet-beta',connection:{getLatestBlockhash:async()=>({blockhash:key(),lastValidBlockHeight:100})}});
    chain.simulatePrepared=async()=>({context:{slot:40},value:{err:null,unitsConsumed:10000}});
    h.c.prepare=chain.prepare.bind(chain);h.c.protocolActivationInstructions=async()=>[SystemProgram.transfer({fromPubkey:pk(administrator.address),toPubkey:pk(key()),lamports:0})];
    await h.manager.process('a');assert.equal(h.l.operations.length,0);assert.equal(h.l.protocolFeesRequested,false);assert.equal(h.l.protocolFeeWallet,undefined);assert(h.l.protocolError);
    for(const field of ['keys','input','credits','review'])assert.deepEqual(h.l[field],before[field]);
  }
});

test('fresh recipient activation rejects missing, external, exported, compromised or overlapping recipient keys',async t=>{
  for(const mutate of [l=>{delete l.keys.protocol;},l=>{l.keys.protocol.external=true;},l=>{l.keys.protocol.exportedAt=1;},l=>{l.keys.protocol.compromised=true;},...['wallet','platform','payer'].map(role=>l=>{l.keys.protocol=l.keys[role];l.protocolActivation.protocolFeeWallet.address=l.keys[role].address;})]){
    const h=await harness(t);freshProtocolRecipient(h.l);mutate(h.l);const before=structuredClone(h.l);
    h.c.c.getBalance=async()=>10000000;h.c.prepare=async()=>{assert.fail('Invalid recipient must be rejected before signing');};
    await h.manager.process('a');assert.equal(h.l.operations.length,0);assert.equal(h.l.protocolFeesRequested,false);assert.equal(h.l.protocolFeeWallet,undefined);assert(h.l.protocolError);
    for(const field of ['keys','input','credits','review'])assert.deepEqual(h.l[field],before[field]);
  }
});

test('explicit taxed-holder upgrade commits zero only after receipt verification and leaves transfer tax and migration tier intact',async t=>{
  const h=await harness(t);h.l.input.taxBps=500;h.l.input.creatorFeeBps=50;h.l.review.creatorFeeRatePpm=5000;h.l.review.creatorFeePolicy='flat-0.5-v2';h.l.review.protocolFees={...policy(),lpPolicy:'platform_locked',platformLpPercent:75};h.l.review.postGradCreatorBps=5;h.l.protocolActivation={...h.l.review.protocolFees,...protocolPolicyTarget(h.l)};h.l.protocolClaimStage='activate';
  h.c.protocolActivationInstructions=async l=>{l.protocolActivation.platformHash='b'.repeat(64);l.protocolActivation.platformSlot=40;return ['upgrade'];};const input=structuredClone(h.l.input),cp=h.l.review.cpConfigId;
  await h.manager.process('a');assert.equal(h.l.operations[0].protocolPolicy.creatorFeeRatePpm,0);assert.equal(effectiveCreatorFeeRate(h.l),5000);
  h.tx=receipt(h.l);h.c.verifyProtocolActivation=async(_l,_slot,target)=>{assert.equal(target.creatorFeeRatePpm,0);throw Error('stale');};await h.manager.process('a');assert.equal(effectiveCreatorFeeRate(h.l),5000);assert.equal(h.l.operations[0].state,'pending');
  h.c.verifyProtocolActivation=async()=>true;await h.manager.process('a');assert.equal(effectiveCreatorFeeRate(h.l),0);assert.equal(h.l.creatorFees.policy,'taxed-holders-0-v3');assert.deepEqual(h.l.input,input);assert.equal(h.l.review.cpConfigId,cp);assert.equal(h.l.review.postGradCreatorBps,5);assert.equal(h.l.review.platformFeeBps,100);assert.equal(h.l.review.protocolFees.platformLpPercent,75);
});

test('manual protocol collection survives funding and RPC failures for every launch mode without enabling rewards',async t=>{
  for(const mode of ['creator','holders','buyback'])for(const kind of ['funding','network']){
    const treasury={recipient:key(),recipientScope:'launchpad'},h=await harness(t,treasury);
    h.l.input.feeMode=mode;h.l.state='paused';h.l.feeAutomation={enabled:false,source:'admin',updatedAt:1};
    h.l.cycle={stage:'payout',index:2,payouts:[{owner:key(),amount:'7'}]};
    const cycle=structuredClone(h.l.cycle),credits=structuredClone(h.l.credits);let attempts=0;
    h.c.claimInstructions=async()=>{attempts++;if(attempts===1)throw Object.assign(Error(kind==='funding'?'Insufficient SOL for fee':'RPC request timed out'),{code:kind==='funding'?'REWARD_NATIVE_FUNDS':'ETIMEDOUT'});return ['claim'];};
    await h.manager.process('a');assert.equal(h.l.protocolFeesRequested,true);assert.equal(h.l.protocolRetry.kind,kind);assert.equal(h.l.operations.length,0);
    assert.equal(h.l.state,'paused');assert.equal(h.l.feeAutomation.enabled,false);assert.deepEqual(h.l.cycle,cycle);assert.deepEqual(h.l.credits,credits);
    assert.equal(h.manager.wakeAt.get('a'),h.l.protocolRetry.at);
    await h.manager.process('a');assert.equal(attempts,1);
    h.advance(h.l.protocolRetry.at-10000);await h.manager.process('a');assert.equal(attempts,2);assert.equal(h.l.operations[0].kind,'protocol-claim');
    h.tx=receipt(h.l,{quote:123n});await h.manager.process('a');assert.equal(h.l.protocolRetry,undefined);
    h.tx=null;await h.manager.process('a');assert.deepEqual(h.l.operations.at(-1).payouts,[{owner:treasury.recipient,amount:'123'}]);
    h.tx=receipt(h.l,{quote:-123n});await h.manager.process('a');assert.equal(h.l.protocolPaid,'123');assert.equal(h.l.protocolFeesRequested,false);
    assert.equal(h.l.state,'paused');assert.equal(h.l.feeAutomation.enabled,false);assert.deepEqual(h.l.cycle,cycle);assert.deepEqual(h.l.credits,credits);
  }
});
test('protocol gas budget waits for reset and unknown integrity errors remain blocked',async t=>{
  const h=await harness(t);h.l.feeAutomation={enabled:false};h.l.state='paused';
  h.c.claimInstructions=async()=>{throw Object.assign(Error('Daily gas budget used'),{code:'REWARD_GAS_BUDGET'});};
  await h.manager.process('a');assert.equal(h.l.protocolRetry.kind,'gas-budget');assert.equal(h.l.protocolRetry.at,86401000);assert.equal(h.manager.wakeAt.get('a'),86401000);
  h.advance(86401000-10000);h.c.claimInstructions=async()=>{throw Object.assign(Error('The saved protocol wallet no longer matches its signing key.'),{statusCode:503});};
  await h.manager.process('a');assert.equal(h.l.protocolFeesRequested,false);assert.equal(h.l.protocolRetry,undefined);assert.equal(h.l.operations.length,0);assert.match(h.l.protocolError,/no longer matches/);
});
test('a temporary saved protocol receipt failure retries the same signature without another claim',async t=>{
  const h=await harness(t);h.l.feeAutomation={enabled:false};h.l.state='paused';await h.manager.process('a');
  const signature=h.l.operations[0].signature;let reads=0;
  h.c.receipt=async()=>{reads++;if(reads===1)throw Object.assign(Error('RPC request timed out'),{code:'ETIMEDOUT'});return receipt(h.l,{quote:5n});};
  await h.manager.process('a');assert.equal(h.l.protocolRetry.kind,'network');assert.equal(h.l.operations[0].receiptCheckAfter,h.l.protocolRetry.at);
  await h.manager.process('a');assert.equal(reads,1);assert.equal(h.l.operations.length,1);
  h.advance(h.l.protocolRetry.at-10000);await h.manager.process('a');assert.equal(h.l.operations.length,1);assert.equal(h.l.operations[0].signature,signature);assert.equal(h.l.operations[0].state,'confirmed');assert.equal(h.l.protocolCredit,'5');assert.equal(h.l.protocolRetry,undefined);
});
