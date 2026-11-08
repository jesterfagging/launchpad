import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PublicKey, Keypair, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, AccountLayout } from '@solana/spl-token';
import { Launchpad } from '../src/launchpad.mjs';
import { LaunchChain, ray, rayCurveAtTarget, rayCurveForLaunch, decodeRay, signer } from '../src/launchpad-chain.mjs';
import { SOL_MINT, units, displayUnits, LAUNCH_CURVE_POLICY } from '../public/launchpad-model.mjs';
import { verifySignedTransaction } from '../src/providers.mjs';

// This exercises the real controller, instruction builders, partial signing,
// signature acceptance, journal/broadcast boundary, and receipt transitions.
// Only RPC responses, market preview, and uploaded media are local fixtures.
async function externalFlow(t,{legacy=false,paid=true,buy=true,version='compact-v3',rejectCreate=false}={}){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-connected-flow-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const values=new Map(),external=Keypair.generate(),stores=new Map(),owner=external.publicKey.toBase58();
  const accounts={dir,hostStore:{read:async(key,fallback)=>key==='launch-protocol-fees'?{recipient:'9xQeWvG816bUx9EPbHmaT23yvVMEBBcK4RJaymHMNHpJ'}:fallback},get:async()=>({mainWallet:Keypair.generate().publicKey.toBase58()}),storeFor:id=>{
    if(!stores.has(id))stores.set(id,{dir:join(dir,id),read:async(key,fallback)=>structuredClone(values.get(id+':'+key)??fallback),write:async(key,value)=>values.set(id+':'+key,structuredClone(value))});return stores.get(id);
  }};
  const fixture=JSON.parse(await readFile(new URL('./launchpad-accounts.json',import.meta.url),'utf8'));
  const config=decodeRay({...fixture.rayConfig.account,owner:new PublicKey(fixture.rayConfig.account.owner),data:Buffer.from(fixture.rayConfig.account.data[0],'base64')},ray.LAUNCHPAD_PROGRAM,ray.LaunchpadConfig,'GlobalConfig');
  const saved=()=>values.get('a:launchpad').launches[0],balances=new Map(),receipts=new Map(),broadcasts=[],walletKinds=[];
  const row=(mint,amount)=>({owner,mint,uiTokenAmount:{amount:String(amount),decimals:mint===SOL_MINT?9:6}});
  let preflightCount=0,uploads=0,tempFunded=false,buyFundingCount=0;
  const tables=[];
  const tokenAccount=(amount)=>{const data=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint:new PublicKey(SOL_MINT),owner:external.publicKey,amount:BigInt(amount),delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:1,isNative:2039280n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);return{owner:TOKEN_PROGRAM_ID.toBase58(),lamports:2039280+Number(amount),data:[data.toString('base64'),'base64']};};
  const connection={
    getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:200}),
    getBlockHeight:async()=>100,
    getMinimumBalanceForRentExemption:async size=>size===0?890880:2039280,
    getBalance:async key=>balances.get(key.toBase58())||0,
    getMultipleAccountsInfoAndContext:async keys=>{
      assert.equal(keys[0].toBase58(),owner);assert.equal(keys[1].toBase58(),(await chain.externalNativeFundingAddress(saved())).toBase58());assert.equal(tempFunded,false);
      return{context:{slot:90},value:[{owner:SystemProgram.programId,lamports:balances.get(owner)},null]};
    },
    simulateTransaction:async(tx,options)=>{
      const op=saved();
      if(['storage-fund','platform-setup'].includes(op.phase))assert.equal(options.sigVerify,true);else assert.equal(options.sigVerify,false);
      if(op.phase==='quote-fund'||op.phase==='setup'&&buy){
        const setup=op.phase==='setup'?Number(op.review.platformRent)+Number(op.review.serviceReserve||0)+(op.executionPlan==='compact-v3'?Number(op.review.storageWalletRent)+25000+(paid?Number(op.storage.budget)+25000:0):paid?Number(op.storage.budget)+25000+Number(op.review.storageWalletRent):0):0;
        return{value:{err:null,unitsConsumed:30000,accounts:[{owner:SystemProgram.programId.toBase58(),lamports:balances.get(owner)-setup-Number(op.review.devBuy.maxQuote)-2039280-17000},tokenAccount(op.review.devBuy.maxQuote)]}};
      }
      if(op.phase==='create')assert.equal(tempFunded,buy);
      return{value:{err:null,unitsConsumed:30000}};
    },
    sendRawTransaction:async bytes=>{
      const tx=VersionedTransaction.deserialize(bytes),signerAddresses=tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures).map(String);
      const {signature}=verifySignedTransaction(bytes,signerAddresses[0],signerAddresses.slice(1));
      const l=saved(),op=l.operations.find(x=>x.signature===signature);
      assert(op,'signed bytes must be durable before broadcast');assert.equal(op.raw,Buffer.from(bytes).toString('base64'));assert.equal(op.state,'pending');assert.equal(op.unsignedRaw,undefined);
      if(receipts.has(signature))return signature;
      broadcasts.push(op.kind);const payer=signerAddresses[0],fee=signerAddresses.length*5000+2000;
      assert((balances.get(payer)||0)>=fee);balances.set(payer,balances.get(payer)-fee);
      const transfer=(from,to,amount)=>{assert((balances.get(from)||0)>=amount);balances.set(from,balances.get(from)-amount);balances.set(to,(balances.get(to)||0)+amount);};
      let preTokenBalances=[],postTokenBalances=[];
      if(op.kind==='setup'&&l.executionPlan==='compact-v3')transfer(owner,l.keys.platform.address,Number(l.review.platformRent)+Number(l.review.serviceReserve||0)+Number(l.review.storageWalletRent)+25000+(paid?Number(l.storage.budget)+25000:0));
      else if(op.kind==='storage-credit'||op.kind==='setup'&&paid)transfer(owner,l.keys.platform.address,Number(l.storage.budget)+25000+Number(l.review.storageWalletRent));
      if(op.kind==='storage-fund'){
        assert.equal(payer,l.keys.platform.address);assert(l.operations.some(x=>['storage-credit','setup'].includes(x.kind)&&x.state==='confirmed'));
        if(l.executionPlan==='compact-v3')assert(l.operations.some(x=>x.kind==='platform-setup'&&x.state==='confirmed'));
        transfer(payer,l.storage.recipient,Number(l.storage.budget));assert(balances.get(payer)>=Number(l.review.storageWalletRent),'the storage signer stays rent exempt after paying Irys and its fee');
      }
      if(op.kind==='platform-setup'){
        assert.equal(payer,l.keys.platform.address);assert.equal(uploads,paid?0:1);assert(l.operations.some(x=>x.kind==='setup'&&x.state==='confirmed'));
        assert(balances.get(payer)>=Number(l.review.platformRent));balances.set(payer,balances.get(payer)-Number(l.review.platformRent));
        assert(balances.get(payer)>=Number(l.review.storageWalletRent),'automatic platform setup preserves its remaining payment/rent reserve');
      }else if(['platform','launch-all'].includes(op.kind)||op.kind==='setup'&&l.executionPlan!=='compact-v3'){
        assert.equal(uploads,op.kind==='setup'&&paid?0:1);transfer(owner,l.keys.platform.address,Number(l.review.platformRent));balances.set(l.keys.platform.address,balances.get(l.keys.platform.address)-Number(l.review.platformRent));
      }
      if(op.kind==='quote-fund'||op.kind==='setup'&&buy){
        assert.equal(tempFunded,false);buyFundingCount++;transfer(owner,(await chain.externalNativeFundingAddress(l)).toBase58(),Number(l.review.devBuy.maxQuote)+2039280);tempFunded=true;postTokenBalances=[row(SOL_MINT,l.review.devBuy.maxQuote)];
      }
      if(op.kind==='create'||op.kind==='launch-all'){
        assert.equal(tempFunded,buy);if(legacy)assert(balances.get(owner)<Number(l.review.devBuy.solBudget),'only one developer-buy budget was funded');
        const allKeys=tx.message.getAccountKeys({addressLookupTableAccounts:tables}),rayInstructions=tx.message.compiledInstructions.filter(ix=>allKeys.get(ix.programIdIndex).equals(ray.LAUNCHPAD_PROGRAM));assert.equal(rayInstructions.length,op.kind==='launch-all'?2:buy?2:1,'creation and developer buy must be atomic');
        assert.equal(preflightCount,1);assert(balances.get(owner)>5000000);balances.set(owner,balances.get(owner)-5000000+(buy?2039280:0));tempFunded=false;
        if(buy){preTokenBalances=[row(SOL_MINT,l.review.devBuy.maxQuote)];postTokenBalances=[row(l.keys.mint.address,l.review.devBuy.net)];}
      }
      receipts.set(signature,{slot:100,transaction:{signatures:[signature],message:tx.message},meta:{err:null,fee,preTokenBalances,postTokenBalances}});return signature;
    },
    getSignatureStatuses:async signatures=>({value:signatures.map(signature=>receipts.has(signature)?{confirmationStatus:'finalized'}:null)}),
    getTransaction:async signature=>receipts.get(signature)||null,
  };
  const chain=new LaunchChain({network:'mainnet-beta',connection});
  chain.preview=async input=>{
    const review={platformFeeBps:input.protocolFees.curveFeeBps,protocolFees:structuredClone(input.protocolFees),creatorFeeRatePpm:input.creatorFeeBps*100,creatorFeePolicy:input.creatorFeePolicy,...rayCurveForLaunch(config,9,'100',input),configId:fixture.rayConfig.pubkey,cpConfigId:'D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2',quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals:9,price:{usd:'100'},minimumSol:'0.06',platformRent:'15000000',serviceReserve:'0',creatorFeeBps:25,protocolFeeBps:25};
    const funding=await chain.fundingEstimate(input);review.storageWalletRent=funding.storageWalletRent;review.serviceReserve=funding.serviceReserve;
    review.devBuy=await chain.devBuyEstimate(input,review,{mint:{tlvData:Buffer.alloc(0)}});review.minimumSol=displayUnits(units(review.minimumSol)+BigInt(review.devBuy.solBudget));return review;
  };
  chain.preflightLaunch=async()=>{preflightCount++;};chain.verifyLaunch=async launch=>({mint:launch.keys.mint.address,curve:chain.addresses(launch).pool.toBase58()});
  const manager=new Launchpad(accounts,null,{chainFactory:()=>chain,metadataStorage:{
    prepare:async(input,keys)=>{assert.equal(input.walletMode,'external');assert.equal(keys.payer.secret,undefined);assert(keys.platform.secret);return{uri:'https://gateway.irys.xyz/'+'a'.repeat(43),imageUrl:'https://gateway.irys.xyz/'+'b'.repeat(43),metadata:{},storage:{provider:'irys',budget:paid?'10000':'0',recipient:Keypair.generate().publicKey.toBase58(),items:[]}};},
    upload:async launch=>{if(paid)assert(launch.operations.some(op=>op.kind==='storage-fund'&&op.state==='confirmed'));uploads++;return true;},
  }});manager.kick=()=>{};t.after(()=>manager.close());
  const image=await manager.uploadImage('a','iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=');
  const launch=await manager.create('a',{name:'Example launch',symbol:'TEST',quoteMint:SOL_MINT,feeMode:'creator',walletMode:'external',externalWallet:owner,...(legacy?{devBuyPercent:'10'}:{devBuySol:buy?'0.01':'0'}),imageId:image.imageId});
  await manager.action('a',launch.id,'launch',{confirm:true,reviewHash:launch.reviewHash});
  const legacyCustody=legacy||version==='compact-v2';
  if(legacyCustody){saved().keys.wallet=saved().keys.payer;delete saved().feeCustody;}
  else{assert.equal(saved().feeCustody,'relay');assert.notEqual(saved().keys.wallet.address,owner);assert.equal(saved().review.serviceReserve,'10000000');}
  if(legacy){delete saved().executionPlan;saved().phase='storage-credit';}
  else{assert.equal(saved().executionPlan,'compact-v3');if(version==='compact-v2')saved().executionPlan=version;assert.equal(launch.review.approvals,paid||buy?2:1);}
  assert.equal(launch.review.storageSol,undefined);assert.equal(units(launch.review.launchFeesSol),units(launch.review.minimumSol)-BigInt(launch.review.devBuy.solBudget));
  if(legacyCustody){
    // Seed the original economics together with the old controller's saved
    // wallet request below. Future drafts still pass through current approval.
    const l=saved(),oldBudget=BigInt(l.review.devBuy.solBudget);
    delete l.input.curvePolicy;delete l.input.graduationTargetUsd;
    delete l.review.curvePolicy;delete l.review.graduationTargetUsd;
    Object.assign(l.review,rayCurveAtTarget(config,9,'100',l.input.targetUsd));
    l.review.devBuy=await chain.devBuyEstimate(l.input,l.review,{mint:{tlvData:Buffer.alloc(0)}});
    l.review.minimumSol=displayUnits(units(l.review.minimumSol)-oldBudget+BigInt(l.review.devBuy.solBudget));
  }
  const initial=Math.max(Number(units(saved().review.minimumSol)),Number(saved().review.devBuy.solBudget)+Number(saved().review.platformRent)+Number(saved().storage.budget)+Number(saved().review.storageWalletRent)+100000+2039280+20000000);balances.set(owner,initial);
  // Reproduce an already prepared wallet request from the older controller;
  // the updated controller must retain those reviewed legacy bytes.
  if(legacyCustody){const book=await manager.book('a'),l=book.launches[0],extra=l.phase==='setup'?[signer(l.keys.platform.secret)]:[];await manager.send('a',book,l,chain,l.phase,await chain.launchInstructions(l,l.phase),{extra});}
  for(let step=0;step<20&&saved().state!=='live';step++){
    await manager.process('a');assert.notEqual(saved().state,'error',saved().error);
    const op=saved().operations.find(x=>x.state==='awaiting_signature');
    if(op){
      assert.equal(op.externalSigner,owner);assert.equal(op.signature,undefined);assert.equal(op.raw,undefined);walletKinds.push(op.kind);
      const request=await manager.signature('a',launch.id,op.operationId);assert.equal(request.pendingSignature.transaction,op.unsignedRaw);
      assert(Buffer.from(request.pendingSignature.transaction,'base64').length<=1232,'every connected-wallet request fits the wallet packet limit');
      const tx=VersionedTransaction.deserialize(Buffer.from(request.pendingSignature.transaction,'base64'));tx.sign([external]);const encoded=Buffer.from(tx.serialize()).toString('base64');
      if(rejectCreate&&op.kind==='create'){
        const before=structuredClone(saved()),changed=VersionedTransaction.deserialize(Buffer.from(encoded,'base64'));
        changed.message.compiledInstructions[0].data[1]^=1;
        await assert.rejects(manager.sign('a',launch.id,op.operationId,Buffer.from(changed.serialize()).toString('base64')),error=>error.code==='WALLET_TRANSACTION_REJECTED');
        assert.deepEqual(saved(),before,'rejected wallet bytes must not rewrite paid setup or the saved creation request');
        assert.equal(broadcasts.filter(kind=>kind==='setup').length,1,'the paid setup is still confirmed exactly once');
        const resumed=await manager.signature('a',launch.id,op.operationId);
        assert.equal(resumed.pendingSignature.transaction,request.pendingSignature.transaction,'resume requests a signature for the existing operation');
      }
      await manager.sign('a',launch.id,op.operationId,encoded);
      const count=broadcasts.length;await manager.sign('a',launch.id,op.operationId,encoded);assert.equal(broadcasts.length,count,'browser retry must not rebroadcast');
    }
  }
  assert.equal(saved().state,'live',saved().error);assert.equal(saved().input.curvePolicy,legacyCustody?undefined:LAUNCH_CURVE_POLICY);assert.equal(saved().review.curvePolicy,saved().input.curvePolicy);assert.equal(saved().autoFees,false);assert.equal(saved().operations.every(x=>x.state==='confirmed'),true);
  assert.deepEqual(broadcasts,legacy?['storage-credit','storage-fund','platform','quote-fund','create']:paid?version==='compact-v3'?['setup','platform-setup','storage-fund','create']:['setup','storage-fund','create']:buy?version==='compact-v3'?['setup','platform-setup','create']:['setup','create']:['launch-all']);assert.deepEqual(walletKinds,legacy?['storage-credit','platform','quote-fund','create']:paid||buy?['setup','create']:['launch-all']);
  assert.equal(buyFundingCount,buy?1:0);assert.equal(uploads,1);assert.equal(tempFunded,false);assert.equal(saved().keys.payer.secret,undefined);
  assert.equal(saved().input.recipient,owner,'creator payouts remain directed to the developer');
  if(legacyCustody)assert.equal(saved().keys.wallet.secret,undefined);else{assert(saved().keys.wallet.secret);assert.equal(saved().keys.wallet.address,saved().keys.platform.address);}
}
test('compact external paid 0.01 SOL developer buy needs only setup and atomic-create wallet approvals',async t=>externalFlow(t));
test('compact external free-storage launch without a developer buy needs one atomic launch approval',async t=>externalFlow(t,{paid:false,buy:false}));
test('compact external free-storage developer buy uploads once before its two wallet approvals',async t=>externalFlow(t,{paid:false,buy:true}));
test('compact external paid-storage launch without a developer buy still needs only two wallet approvals',async t=>externalFlow(t,{paid:true,buy:false}));
test('wallet rejection after paid setup resumes creation without paying setup again',async t=>externalFlow(t,{paid:true,buy:false,rejectCreate:true}));
test('saved compact-v2 launches retain their combined platform setup without funding it twice',async t=>externalFlow(t,{version:'compact-v2'}));
test('saved legacy external launches resume their original storage, platform and developer-buy phases',async t=>externalFlow(t,{legacy:true}));
