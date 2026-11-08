import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Keypair,PublicKey,SystemProgram,SystemInstruction,VersionedTransaction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,AccountLayout,getAssociatedTokenAddressSync,decodeTransferCheckedInstruction} from '@solana/spl-token';
import {Launchpad} from '../src/launchpad.mjs';
import {LaunchChain,ray,rayCurveForLaunch,decodeRay,newLaunchKeys} from '../src/launchpad-chain.mjs';
import {SOL_MINT,USDC_MINT} from '../public/launchpad-model.mjs';
import {verifySignedTransaction} from '../src/providers.mjs';

const fixture=JSON.parse(await readFile(new URL('./launchpad-accounts.json',import.meta.url),'utf8'));
const config=decodeRay({...fixture.rayConfig.account,owner:new PublicKey(fixture.rayConfig.account.owner),data:Buffer.from(fixture.rayConfig.account.data[0],'base64')},ray.LAUNCHPAD_PROGRAM,ray.LaunchpadConfig,'GlobalConfig');
// This captured config is denominated in 9-decimal SOL at the fixture's $100
// reference. The synthetic 6-decimal USD config keeps those same dollar limits.
const usdConfig={...config,migrateFee:config.migrateFee.divn(10),minFundRaisingB:config.minFundRaisingB.divn(10)};
const pk=value=>new PublicKey(value);
const image='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=';

async function harness(t){
  const dir=await mkdtemp(join(tmpdir(),'launchpad-fee-custody-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const payer=newLaunchKeys().wallet,external=Keypair.generate(),books=new Map(),stores=new Map(),sent=[],vaults=new Map();
  const accounts={dir,hostStore:{read:async(key,fallback)=>key==='launch-protocol-fees'?{recipient:'9xQeWvG816bUx9EPbHmaT23yvVMEBBcK4RJaymHMNHpJ'}:fallback},get:async()=>({mainWallet:payer.address}),storeFor:id=>{
    if(!stores.has(id))stores.set(id,{dir:join(dir,id),read:async(key,fallback)=>structuredClone(key==='main-wallet'?{publicKey:payer.address,privateKey:payer.secret}:books.get(id+':'+key)??fallback),write:async(key,value)=>books.set(id+':'+key,structuredClone(value))});
    return stores.get(id);
  }};
  const chain=new LaunchChain({network:'mainnet-beta',connection:{
    getMinimumBalanceForRentExemption:async size=>size===0?890880:2039280,
    getLatestBlockhash:async()=>({blockhash:Keypair.generate().publicKey.toBase58(),lastValidBlockHeight:200}),
    getBalance:async()=>1000000000,getAccountInfo:async address=>vaults.get(address.toBase58())||null,
    simulateTransaction:async(tx,options)=>{assert.equal(options.sigVerify,true);assert.equal(tx.message.header.numRequiredSignatures,1);return{value:{err:null,unitsConsumed:30000}};},
    sendRawTransaction:async bytes=>{const tx=VersionedTransaction.deserialize(bytes),owner=tx.message.staticAccountKeys[0].toBase58(),{signature}=verifySignedTransaction(bytes,owner,[]);assert((books.get('a:launchpad')?.launches||[]).some(l=>l.keys.wallet.address===owner),'only a persisted coin fee authority signs rewards');sent.push(tx);return signature;},
  }});
  chain.preview=async input=>({...rayCurveForLaunch(input.quoteMint===SOL_MINT?config:usdConfig,input.quoteMint===SOL_MINT?9:6,input.quoteMint===SOL_MINT?'100':'1',input),...await chain.fundingEstimate(input,{program:TOKEN_PROGRAM_ID,mint:{tlvData:Buffer.alloc(0)}}),configId:fixture.rayConfig.pubkey,cpConfigId:'D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2',quoteProgram:TOKEN_PROGRAM_ID.toBase58(),quoteDecimals:input.quoteMint===SOL_MINT?9:6,price:{usd:input.quoteMint===SOL_MINT?'100':'1'},platformFeeBps:input.protocolFees.curveFeeBps,protocolFees:structuredClone(input.protocolFees),creatorFeeRatePpm:input.creatorFeeBps*100,creatorFeePolicy:input.creatorFeePolicy,creatorFeeBps:input.creatorFeeBps,protocolFeeBps:25,devBuy:{gross:'0',net:'0',maxQuote:'0',solBudget:'0'}});
  const manager=new Launchpad(accounts,null,{chainFactory:()=>chain,metadataStorage:{prepare:async()=>({uri:'https://gateway.irys.xyz/'+'a'.repeat(43),imageUrl:'https://gateway.irys.xyz/'+'b'.repeat(43),metadata:{},storage:{provider:'irys',budget:'0',items:[]}}),upload:async()=>true}});
  manager.kick=()=>{};t.after(()=>manager.close());
  const {imageId}=await manager.uploadImage('a',image);
  const raw=(walletMode='default',quoteMint=SOL_MINT,feeMode='creator')=>({name:'Custody test',symbol:'TEST',quoteMint,feeMode,walletMode,...(walletMode==='external'?{externalWallet:external.publicKey.toBase58()}:{}),devBuySol:'0',imageId});
  const stored=id=>books.get('a:launchpad').launches.find(l=>l.id===id);
  function fundVault(l,amount){
    const key=ray.getPdaCreatorVault(ray.LAUNCHPAD_PROGRAM,pk(l.keys.wallet.address),pk(l.input.quoteMint)).publicKey;
    const data=Buffer.alloc(AccountLayout.span);AccountLayout.encode({mint:pk(l.input.quoteMint),owner:ray.getPdaCreatorFeeVaultAuth(ray.LAUNCHPAD_PROGRAM).publicKey,amount,delegateOption:0,delegate:PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);
    vaults.set(key.toBase58(),{owner:TOKEN_PROGRAM_ID,lamports:2039280,data,executable:false,rentEpoch:0});return key;
  }
  return{manager,chain,payer,external,books,sent,raw,stored,fundVault};
}

test('every new coin has its own nonexportable fee authority while the chosen developer wallet stays the payer and recipient',async t=>{
  const h=await harness(t),wallets=new Set(),vaults=new Set();
  for(const mode of ['default','external'])for(const feeMode of ['creator','holders'])for(let index=0;index<2;index++){
    const publicCoin=await h.manager.create('a',h.raw(mode,SOL_MINT,feeMode)),l=h.stored(publicCoin.id),payer=mode==='default'?h.payer.address:h.external.publicKey.toBase58();
    assert.equal(l.feeCustody,'relay');assert.equal(l.keys.payer.address,payer);assert.notEqual(l.keys.wallet.address,payer);assert.equal(l.keys.platform.address,l.keys.wallet.address);assert(l.keys.wallet.secret);
    if(mode==='external')assert.equal(l.keys.payer.secret,undefined);else assert.equal(l.keys.payer.secret,h.payer.secret);
    assert.equal(l.input.recipient,feeMode==='creator'?payer:'');assert.equal(l.review.serviceReserve,feeMode==='holders'?'25078560':'10000000');
    assert(!wallets.has(l.keys.wallet.address));wallets.add(l.keys.wallet.address);
    const vault=ray.getPdaCreatorVault(ray.LAUNCHPAD_PROGRAM,pk(l.keys.wallet.address),pk(SOL_MINT)).publicKey.toBase58();assert(!vaults.has(vault));vaults.add(vault);
    await assert.rejects(h.manager.exportWallet('a',l.id),/cannot be exported/);
    for(const exposed of [publicCoin,await h.manager.read('a')])for(const secret of [l.keys.wallet.secret,l.keys.mint.secret,h.payer.secret])assert(!JSON.stringify(exposed).includes(secret),'API responses do not reveal signing keys');
  }
  assert.equal(wallets.size,8);assert.equal(vaults.size,8);
});

test('real Raydium claims use separate creator vaults even when two coins share the same connected developer and quote',async t=>{
  const h=await harness(t),coins=[];
  for(let index=0;index<2;index++)coins.push(h.stored((await h.manager.create('a',h.raw('external'))).id));
  const vaults=coins.map(l=>h.fundVault(l,123456n));
  for(const [index,l]of coins.entries()){
    const instructions=await h.chain.claimInstructions(l),claim=instructions.find(ix=>ix.programId.equals(ray.LAUNCHPAD_PROGRAM));assert(claim);
    assert(claim.keys.some(k=>k.pubkey.equals(vaults[index])));assert(!claim.keys.some(k=>k.pubkey.equals(vaults[1-index])));
    assert.equal(claim.keys.find(k=>k.isSigner).pubkey.toBase58(),l.keys.wallet.address);
    const operation=await h.chain.prepare(l,instructions);assert(!operation.needsSignature);assert.equal(operation.unsignedRaw,undefined);
    verifySignedTransaction(Buffer.from(operation.raw,'base64'),l.keys.wallet.address,[]);
    const tx=VersionedTransaction.deserialize(Buffer.from(operation.raw,'base64'));assert(!tx.message.staticAccountKeys.some(k=>k.toBase58()===l.keys.payer.address));
  }
});

test('automatic holder claims require $100 in fresh quote value while admin claims can collect one atomic unit',async t=>{
  const h=await harness(t),l=h.stored((await h.manager.create('a',h.raw('default',USDC_MINT,'holders'))).id);
  l.credits={quote:'0',base:'0'};l.holderRewards={priceReference:{mint:USDC_MINT,usd:'1',at:Date.now()}};
  h.fundVault(l,99999999n);assert.deepEqual(await h.chain.claimInstructions(l,'holder-auto'),[]);
  h.fundVault(l,100000000n);assert.equal((await h.chain.claimInstructions(l,'holder-auto')).length,2);
  l.credits.quote='15000000';h.fundVault(l,85000000n);assert.equal((await h.chain.claimInstructions(l,'holder-auto')).length,2);
  l.holderRewards.priceReference.usd='0.5';assert.deepEqual(await h.chain.claimInstructions(l,'holder-auto'),[]);
  l.holderRewards.priceReference.at=Date.now()-61000;await assert.rejects(h.chain.claimInstructions(l,'holder-auto'),/fresh/i);
  l.credits.quote='0';h.fundVault(l,1n);assert.equal((await h.chain.claimInstructions(l,'creator')).length,2);
});

test('creator fee processing signs with each coin authority and pays the selected developer in SOL or SPL tokens',async t=>{
  const h=await harness(t);
  for(const mode of ['default','external'])for(const quote of [SOL_MINT,USDC_MINT]){
    const publicCoin=await h.manager.create('a',h.raw(mode,quote));
    const b=await h.manager.book('a'),l=b.launches.find(l=>l.id===publicCoin.id),amount=12345n;
    l.state='live';l.curve='confirmed-curve';l.authorizedAt=1;l.feesRequested=true;l.credits.quote=String(amount);l.cycle={stage:'distribute',index:0,manual:true};await h.manager.save('a',b);
    const actualPayout=h.chain.payoutInstructions.bind(h.chain);let inspected=false;
    h.chain.payoutInstructions=async(coin,rows)=>{
      assert.deepEqual(rows,[{owner:l.keys.payer.address,amount:String(amount)}]);
      const instructions=await actualPayout(coin,rows);
      if(quote===SOL_MINT){
        const transfer=SystemInstruction.decodeTransfer(instructions.at(-1));assert.equal(transfer.fromPubkey.toBase58(),l.keys.wallet.address);assert.equal(transfer.toPubkey.toBase58(),l.keys.payer.address);assert.equal(transfer.lamports,amount);
      }else{
        const transfer=decodeTransferCheckedInstruction(instructions.at(-1));assert.equal(transfer.keys.owner.pubkey.toBase58(),l.keys.wallet.address);assert(transfer.keys.destination.pubkey.equals(getAssociatedTokenAddressSync(pk(quote),pk(l.keys.payer.address))));assert.equal(transfer.data.amount,amount);
      }
      inspected=true;return instructions;
    };
    await h.manager.advanceFees('a',b,l,h.chain);h.chain.payoutInstructions=actualPayout;
    assert(inspected);const saved=h.stored(l.id),op=saved.operations.at(-1);assert.equal(op.kind,'payout');assert.equal(op.state,'pending');assert.equal(op.externalSigner,undefined);assert.deepEqual(op.payouts,[{owner:l.keys.payer.address,amount:String(amount)}]);
    verifySignedTransaction(Buffer.from(op.raw,'base64'),l.keys.wallet.address,[]);
    assert.equal(h.sent.at(-1).message.staticAccountKeys[0].toBase58(),l.keys.wallet.address);
  }
  assert.equal(h.sent.length,4);
});
