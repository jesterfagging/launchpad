import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey, SystemProgram, SystemInstruction, TransactionMessage, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, AccountLayout, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createApproveInstruction, createTransferInstruction } from '@solana/spl-token';
import { quoteConversion, buildConversion, treasuryRouteGuardError } from '../src/launchpad-trading-route.mjs';
import { JUPITER } from '../src/core.mjs';
const wallet=Keypair.generate().publicKey,mint=Keypair.generate().publicKey,alien=Keypair.generate().publicKey,jup=new PublicKey(JUPITER);
const event=PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],jup)[0];
const wire=ix=>({programId:ix.programId.toBase58(),accounts:ix.keys.map(a=>({...a,pubkey:a.pubkey.toBase58()})),data:ix.data.toString('base64')});
const meta=(key,isWritable=false,isSigner=false)=>({pubkey:key.toBase58(),isWritable,isSigner});
function fixture({sell=false,shared=false}={}){
 const input=sell?mint:NATIVE_MINT,output=sell?NATIVE_MINT:mint,source=getAssociatedTokenAddressSync(input,wallet),destination=getAssociatedTokenAddressSync(output,wallet);
 const bytes=Buffer.alloc((shared?9:8)+31);createHash('sha256').update('global:'+(shared?'shared_accounts_route_v2':'route_v2')).digest().copy(bytes,0,0,8);
 const o=shared?9:8;bytes.writeBigUInt64LE(1000000n,o);bytes.writeBigUInt64LE(800000n,o+8);bytes.writeUInt16LE(50,o+16);bytes.writeUInt32LE(1,o+22);bytes[o+26]=3;bytes.writeUInt16LE(10000,o+27);bytes[o+30]=1;
 const accounts=shared?[meta(event),meta(wallet,false,true),meta(source,true),meta(alien,true),meta(Keypair.generate().publicKey,true),meta(destination,true),meta(input),meta(output),meta(TOKEN_PROGRAM_ID),meta(TOKEN_PROGRAM_ID),meta(event),meta(jup)]:[meta(wallet,false,true),meta(source,true),meta(destination,true),meta(input),meta(output),meta(TOKEN_PROGRAM_ID),meta(TOKEN_PROGRAM_ID),meta(jup),meta(event),meta(jup)];
 const body={inputMint:input.toBase58(),outputMint:output.toBase58(),inAmount:'1000000',outAmount:'800000',otherAmountThreshold:'796000',swapMode:'ExactIn',slippageBps:50,priceImpactPct:'0.001',routePlan:[{}],setupInstructions:[wire(createAssociatedTokenAccountIdempotentInstruction(wallet,source,wallet,input)),wire(createAssociatedTokenAccountIdempotentInstruction(wallet,destination,wallet,output))],swapInstruction:{programId:JUPITER,accounts,data:bytes.toString('base64')},cleanupInstruction:null,otherInstructions:[],tipInstruction:null,addressesByLookupTableAddress:{}};
 return {body,args:{inputMint:input.toBase58(),outputMint:output.toBase58(),wallet:wallet.toBase58(),amountRaw:'1000000',slippageBps:50}};
}
function chain(body,{existing=new Map(),key=''}={}){
 const seen=[];return {seen,jupiterKey:key,jupiterGate:{async acquire(){},cooldown(){}},async fetcher(url,options){seen.push({url,options});return{ok:true,status:200,json:async()=>body};},c:{async getMultipleAccountsInfoAndContext(keys){return{context:{slot:20},value:keys.map(k=>existing.get(k.toBase58())||null)};},async getMinimumBalanceForRentExemption(){return 2039280;}},async lookupTables(keys){seen.push({tables:keys});return [];}};
}
function tokenInfo({owner=wallet,tokenMint=mint,amount=0n,delegate=null}={}){
 const data=Buffer.alloc(165);AccountLayout.encode({mint:tokenMint,owner,amount,delegateOption:delegate?1:0,delegate:delegate||PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:delegate?amount:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);return{owner:TOKEN_PROGRAM_ID,data,lamports:2039280,executable:false};
}
for(const sell of [false,true])for(const shared of [false,true])test(`atomic conversion ${sell?'sell':'buy'} ${shared?'shared':'direct'} validates and preserves WSOL`,async()=>{
 const {body,args}=fixture({sell,shared}),c=chain(body),quote=await quoteConversion(c,args),out=await buildConversion(c,quote);
 assert.equal(quote.minimumRaw,'796000');assert.equal(out.rentLamports,'2039280');
 assert.equal(c.seen[0].options.headers['x-api-key'],undefined);assert.match(c.seen[0].url,/wrapAndUnwrapSol=false/);
 const nativeATA=getAssociatedTokenAddressSync(NATIVE_MINT,wallet);assert(out.instructions.every(ix=>ix.keys.every(k=>!k.pubkey.equals(nativeATA))));
 const temp=new PublicKey(out.nativeAccount),swap=out.instructions.find(ix=>ix.programId.equals(jup));assert(swap.keys.some(k=>k.pubkey.equals(temp)));
 assert.equal(out.instructions[0].programId.toBase58(),SystemProgram.programId.toBase58());
 const create=SystemInstruction.decodeCreateWithSeed(out.instructions[0]),initialize=out.instructions[1];
 assert.match(create.seed,/^[a-f0-9]{32}$/);assert.equal(initialize.data.toString('hex'),'01');assert(initialize.programId.equals(TOKEN_PROGRAM_ID));
 assert.deepEqual(initialize.keys.map(key=>key.pubkey.toBase58()),[temp,NATIVE_MINT,wallet,SYSVAR_RENT_PUBKEY].map(key=>key.toBase58()));
 const close=out.instructions.at(-1);assert.equal(close.data[0],9);assert(close.keys[0].pubkey.equals(temp)&&close.keys[1].pubkey.equals(wallet));
 await assert.rejects(buildConversion(c,quote),/expired/);
});
test('operator key is server-only and the amount/mint/slippage are exact',async()=>{
 const {body,args}=fixture(),c=chain(body,{key:'server-key'});await quoteConversion(c,args);assert.equal(c.seen[0].options.headers['x-api-key'],'server-key');assert(!c.seen[0].url.includes('server-key'));
});
test('compact route requests use only the bounded account budgets without changing spend or slippage',async()=>{
 for(const maxAccounts of [32,24,20,16]){
   const {body,args}=fixture(),c=chain(body);await quoteConversion(c,{...args,maxAccounts});
   const query=new URL(c.seen[0].url).searchParams;
   assert.equal(query.get('maxAccounts'),String(maxAccounts));assert.equal(query.get('amount'),args.amountRaw);assert.equal(query.get('slippageBps'),String(args.slippageBps));assert.equal(query.get('wrapAndUnwrapSol'),'false');
 }
 for(const maxAccounts of [0,15,17,19,64,'16',NaN]){
   const {body,args}=fixture(),c=chain(body);await assert.rejects(quoteConversion(c,{...args,maxAccounts}),/account budget/);assert.equal(c.seen.length,0);
 }
});
for(const sell of [false,true])for(const shared of [false,true])test(`preserves a DEX writable duplicate of the verified wallet for ${sell?'sell':'buy'} ${shared?'shared':'direct'}`,async()=>{
 const {body,args}=fixture({sell,shared});body.swapInstruction.accounts.push(meta(wallet,true));
 const c=chain(body),quote=await quoteConversion(c,args),out=await buildConversion(c,quote),swap=out.instructions.find(ix=>ix.programId.equals(jup));
 const authority=swap.keys[shared?1:0],duplicate=swap.keys.at(-1);
 assert(authority.pubkey.equals(wallet)&&authority.isSigner&&!authority.isWritable);
 assert(duplicate.pubkey.equals(wallet)&&!duplicate.isSigner&&duplicate.isWritable);
 const message=new TransactionMessage({payerKey:wallet,recentBlockhash:PublicKey.default.toBase58(),instructions:out.instructions}).compileToV0Message();
 assert.equal(message.header.numRequiredSignatures,1);assert(message.staticAccountKeys[0].equals(wallet));assert(message.isAccountWritable(0));
 assert.equal(SystemInstruction.decodeCreateWithSeed(out.instructions[0]).lamports,2039280+(sell?0:1000000));
 assert(!JSON.stringify(quote).includes('instructions'),'a quote must not expose a transaction that bypasses final simulation');
});
test('captured live SOL to AMD Manifest route accepts its writable payer while preserving exact recipients and instruction bytes',async()=>{
 const {request,response:body}=JSON.parse(readFileSync(new URL('./fixtures/sol-amd-jupiter-route.json',import.meta.url),'utf8'));
 const args={inputMint:request.inputMint,outputMint:request.outputMint,wallet:request.taker,amountRaw:request.amount,slippageBps:Number(request.slippageBps),inputProgram:TOKEN_PROGRAM_ID.toBase58(),outputProgram:TOKEN_2022_PROGRAM_ID.toBase58()};
 assert(body.routePlan.some(step=>step.swapInfo.label==='Manifest'));
 assert.deepEqual(body.swapInstruction.accounts[26],{pubkey:request.taker,isSigner:false,isWritable:true});
 const c=chain(body),quote=await quoteConversion(c,args),out=await buildConversion(c,quote),swap=out.instructions.find(ix=>ix.programId.equals(jup));
 assert.equal(quote.amountRaw,'50000000');assert.equal(quote.minimumRaw,'9084');
 assert.equal(swap.data.toString('base64'),body.swapInstruction.data);
 assert(swap.keys[26].pubkey.equals(new PublicKey(request.taker))&&swap.keys[26].isWritable&&!swap.keys[26].isSigner);
 assert(swap.keys[2].pubkey.equals(getAssociatedTokenAddressSync(new PublicKey(request.outputMint),new PublicKey(request.taker),false,TOKEN_2022_PROGRAM_ID)));
 assert.equal(SystemInstruction.decodeCreateWithSeed(out.instructions[0]).lamports,52039280);
 for(const mutate of [
   b=>b.swapInstruction.accounts[26].pubkey=alien.toBase58(),
   b=>b.swapInstruction.accounts[2].pubkey=alien.toBase58(),
   b=>b.otherInstructions=[wire(SystemProgram.transfer({fromPubkey:new PublicKey(request.taker),toPubkey:alien,lamports:1}))],
 ]){
   const changed=structuredClone(body);mutate(changed);
   if(changed.swapInstruction.accounts[26].pubkey===alien.toBase58())changed.swapInstruction.accounts[26].isSigner=true;
   await assert.rejects(quoteConversion(chain(changed),args));
 }
});
for(const [label,mutate] of [
 ['wrong input',b=>b.inputMint=mint.toBase58()],['wrong amount',b=>b.inAmount='1000001'],['wrong output',b=>b.outputMint=alien.toBase58()],['looser slippage',b=>b.slippageBps=51],['wrong threshold',b=>b.otherAmountThreshold='1'],['non-exact input',b=>b.swapMode='ExactOut'],['excess impact',b=>b.priceImpactPct='0.06'],
 ['tip',b=>b.tipInstruction={}],['cleanup',b=>b.cleanupInstruction={}],['extra transfer',b=>b.otherInstructions=[{}]],['extra signer',b=>b.swapInstruction.accounts.push(meta(alien,true,true))],['altered fixed authority flags',b=>b.swapInstruction.accounts[0].isWritable=true],['recipient',b=>b.swapInstruction.accounts[2].pubkey=alien.toBase58()],['fee recipient',b=>b.swapInstruction.accounts[7].pubkey=alien.toBase58()],
 ['binary input',b=>{const d=Buffer.from(b.swapInstruction.data,'base64');d.writeBigUInt64LE(1000001n,8);b.swapInstruction.data=d.toString('base64');}],['binary min output',b=>{const d=Buffer.from(b.swapInstruction.data,'base64');d.writeBigUInt64LE(700000n,16);b.swapInstruction.data=d.toString('base64');}],['positive slippage fee',b=>{const d=Buffer.from(b.swapInstruction.data,'base64');d.writeUInt16LE(100,28);b.swapInstruction.data=d.toString('base64');}],['platform fee',b=>{const d=Buffer.from(b.swapInstruction.data,'base64');d.writeUInt16LE(100,26);b.swapInstruction.data=d.toString('base64');}],
 ['unverified instruction',b=>{const d=Buffer.from(b.swapInstruction.data,'base64');d[0]=0;b.swapInstruction.data=d.toString('base64');}],
 ['system setup',b=>b.setupInstructions=[wire(SystemProgram.transfer({fromPubkey:wallet,toPubkey:alien,lamports:1000}))]],['token approval',b=>b.setupInstructions=[wire(createApproveInstruction(getAssociatedTokenAddressSync(mint,wallet),alien,wallet,1000))]],['token transfer',b=>b.setupInstructions=[wire(createTransferInstruction(getAssociatedTokenAddressSync(mint,wallet),alien,wallet,1000))]],['ATA recipient',b=>b.setupInstructions[1].accounts[2].pubkey=alien.toBase58()]
])test(`rejects ${label}`,async()=>{const {body,args}=fixture();mutate(body);await assert.rejects(quoteConversion(chain(body),args));});
test('requires final simulation to preserve an unrelated wallet balance and its rent',async()=>{
 const {body,args}=fixture(),other=getAssociatedTokenAddressSync(alien,wallet);body.swapInstruction.accounts.push(meta(other,true));
 const existing=new Map([[other.toBase58(),tokenInfo({tokenMint:alien,amount:5n})]]),c=chain(body,{existing}),q=await quoteConversion(c,args),out=await buildConversion(c,q);
 assert.deepEqual(out.monitoredAccounts,[{address:other.toBase58(),mint:alien.toBase58(),program:TOKEN_PROGRAM_ID.toBase58(),minimumAmountRaw:'5',minimumLamports:2039280}]);
});
test('accepts existing paired tokens without spending them and accounts for intermediate rent',async()=>{
 const {body,args}=fixture(),pair=getAssociatedTokenAddressSync(mint,wallet),middle=getAssociatedTokenAddressSync(alien,wallet);
 body.setupInstructions.push(wire(createAssociatedTokenAccountIdempotentInstruction(wallet,middle,wallet,alien)));body.swapInstruction.accounts.push(meta(middle,true));
 const existing=new Map([[pair.toBase58(),tokenInfo({amount:50n})]]),c=chain(body,{existing}),quote=await quoteConversion(c,args);assert.equal(quote.rentLamports,'4078560');
 const out=await buildConversion(c,quote);assert(out.instructions.some(ix=>ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)&&ix.keys[1].pubkey.equals(middle)));
 assert(!out.instructions.some(ix=>ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)&&ix.keys[1].pubkey.equals(pair)));
});
for(const sell of [false,true])test(`omits verified existing setup ATAs while preserving ${sell?'sell':'buy'} balances and rebuilding closed accounts on the next quote`,async()=>{
 const {body,args}=fixture({sell}),pair=getAssociatedTokenAddressSync(mint,wallet),middle=getAssociatedTokenAddressSync(alien,wallet);
 body.setupInstructions.push(wire(createAssociatedTokenAccountIdempotentInstruction(wallet,middle,wallet,alien)));
 body.swapInstruction.accounts.push(meta(middle,true));
 const existing=new Map([[pair.toBase58(),tokenInfo({amount:50n})],[middle.toBase58(),tokenInfo({tokenMint:alien,amount:70n})]]),c=chain(body,{existing});
 const quote=await quoteConversion(c,args),out=await buildConversion(c,quote);
 assert(!out.instructions.some(ix=>ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)));
 assert.equal(quote.rentLamports,'2039280');assert.equal(quote.amountRaw,args.amountRaw);assert.equal(quote.minimumRaw,'796000');
 assert.deepEqual(out.monitoredAccounts,[{address:middle.toBase58(),mint:alien.toBase58(),program:TOKEN_PROGRAM_ID.toBase58(),minimumAmountRaw:'70',minimumLamports:2039280}]);
 existing.clear();
 const fresh=await quoteConversion(c,args),rebuilt=await buildConversion(c,fresh);
 const creations=rebuilt.instructions.filter(ix=>ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
 assert.deepEqual(creations.map(ix=>ix.keys[1].pubkey.toBase58()),[pair,middle].map(key=>key.toBase58()));
 assert(creations.every(ix=>ix.data[0]===1));assert.equal(fresh.rentLamports,'4078560');
});
test('never treats a wrong owner, mint, program or frozen ATA as a removable setup instruction',async()=>{
 for(const change of [v=>{v.data[108]=2;},v=>{alien.toBuffer().copy(v.data,32);},v=>{alien.toBuffer().copy(v.data,0);},v=>{v.owner=SystemProgram.programId;}]){
  const {body,args}=fixture(),pair=getAssociatedTokenAddressSync(mint,wallet),info=tokenInfo();change(info);
  await assert.rejects(quoteConversion(chain(body,{existing:new Map([[pair.toBase58(),info]])}),args));
 }
});
test('lookup table contents are loaded from chain rather than trusted from router mapping',async()=>{
 const {body,args}=fixture(),table=Keypair.generate().publicKey.toBase58();body.addressesByLookupTableAddress={[table]:['not-an-address']};const c=chain(body),q=await quoteConversion(c,args);await buildConversion(c,q);assert.deepEqual(c.seen.at(-1),{tables:[table]});
});
test('cloned quote cannot manufacture or change a prepared route',async()=>{const {body,args}=fixture(),c=chain(body),q=await quoteConversion(c,args);await assert.rejects(buildConversion(c,{...q,minimumRaw:'1'}),/expired/);});
test('rejects an unrelated non-associated wallet account even if empty',async()=>{
 const {body,args}=fixture();body.swapInstruction.accounts.push(meta(alien,true));const c=chain(body,{existing:new Map([[alien.toBase58(),tokenInfo()]])});await assert.rejects(quoteConversion(c,args),/non-associated wallet/);
});
test('rejects preexisting delegated intermediate accounts',async()=>{
 const {body,args}=fixture(),middle=getAssociatedTokenAddressSync(alien,wallet);body.swapInstruction.accounts.push(meta(middle,true));const c=chain(body,{existing:new Map([[middle.toBase58(),tokenInfo({tokenMint:alien,amount:5n,delegate:alien})]])});await assert.rejects(quoteConversion(c,args),/unexpected permissions/);
});

test('SOL routing uses the enclosing quote deadline and rejects an expired action before provider work',async()=>{
 const {body,args}=fixture(),c=chain(body),deadline=Date.now()+5000;let received;
 c.rpcContext={getStore:()=>({deadline})};c.jupiterGate.acquire=async(_config,_signal,value)=>{received=value;};
 await quoteConversion(c,args);assert.equal(received,deadline);
 const expired=chain(body);expired.rpcContext={getStore:()=>({deadline:Date.now()-1})};
 await assert.rejects(quoteConversion(expired,args),/deadline/);assert.equal(expired.seen.length,0);
});

function providerSequence(c,steps){
 const calls=[],reservations=[],cooldowns=[];
 c.jupiterGate={async acquire(config,signal,deadline){reservations.push({config,signal,deadline});},cooldown(config,ms){cooldowns.push({config,ms});}};
 c.fetcher=async(url,options)=>{calls.push({url,options});const step=steps[calls.length-1];assert(step,'Unexpected provider retry');if(step instanceof Error)throw step;return step;};
 return {calls,reservations,cooldowns};
}
const providerResponse=(status,body,headers={})=>({ok:status>=200&&status<300,status,headers:{get:key=>headers[key]??null},json:async()=>body});
for(const [status,body,code] of [
 [400,{error:'No routes found; confidential-provider-details'},'SOL_ROUTE_NOT_FOUND'],
 [404,{errorCode:'COULD_NOT_FIND_ANY_ROUTE'},'SOL_ROUTE_NOT_FOUND'],
 [400,{error:'confidential-provider-details'},'SOL_ROUTE_REJECTED'],
 [401,{error:'bad confidential-provider-details'},'SOL_ROUTE_AUTH'],
 [403,{message:'confidential-provider-details'},'SOL_ROUTE_AUTH'],
 [429,{error:'confidential-provider-details'},'SOL_ROUTE_RATE_LIMITED'],
])test(`HTTP ${status} ${code} is categorized safely without retrying deterministic failures`,async()=>{
 const {args}=fixture(),c=chain(null,{key:'private-server-key'}),trace=providerSequence(c,[providerResponse(status,body,{'retry-after':'7'})]);
 await assert.rejects(quoteConversion(c,args),error=>{
   assert.equal(error.code,code);assert.equal(error.httpStatus,status);
   assert(!String(error).includes('confidential-provider-details'));assert(!JSON.stringify(error).includes('private-server-key'));
   assert.equal(error.cause,undefined);return true;
 });
 assert.equal(trace.calls.length,1);assert.equal(trace.reservations.length,1);
 assert.equal(trace.cooldowns.length,status===429?1:0);if(status===429)assert.equal(trace.cooldowns[0].ms,7000);
});
for(const first of [providerResponse(503,{message:'private-upstream-trace'}),Object.assign(Error('private-network-url-and-key'),{code:'ECONNRESET'})])test(`transient ${first.status||first.code} retries once through the shared gate under the same deadline`,async()=>{
 const {body,args}=fixture(),c=chain(body),deadline=Date.now()+8000;c.rpcContext={getStore:()=>({deadline})};
 const trace=providerSequence(c,[first,providerResponse(200,body)]),quote=await quoteConversion(c,args);
 assert.equal(quote.minimumRaw,'796000');assert.equal(trace.calls.length,2);assert.equal(trace.reservations.length,2);
 assert.equal(trace.calls[0].url,trace.calls[1].url);assert.equal(trace.calls[0].options.signal,trace.calls[1].options.signal);
 assert(trace.reservations.every(item=>item.deadline===deadline&&item.signal===trace.calls[0].options.signal));
});
test('repeated transient errors stop after one retry and never expose provider response content',async()=>{
 for(const network of [false,true]){
   const {args}=fixture(),c=chain(null),failure=network?Error('private-network-key'):providerResponse(502,{error:'private-provider-key'}),trace=providerSequence(c,[failure,failure]);
   await assert.rejects(quoteConversion(c,args),error=>{assert.equal(error.code,network?'SOL_ROUTE_NETWORK':'SOL_ROUTE_PROVIDER_UNAVAILABLE');assert(!String(error).includes('private-'));return true;});
   assert.equal(trace.calls.length,2);assert.equal(trace.reservations.length,2);
 }
});
test('TLS failures and successful but invalid route responses never trigger provider retries',async()=>{
 const {body,args}=fixture();
 for(const first of [Object.assign(Error('private-certificate-detail'),{code:'CERT_HAS_EXPIRED'}),providerResponse(200,{...body,inAmount:'999999'})]){
   const c=chain(body),trace=providerSequence(c,[first]);
   await assert.rejects(quoteConversion(c,args));assert.equal(trace.calls.length,1);assert.equal(trace.reservations.length,1);
 }
});
test('a denied retry reservation prevents a second provider request',async()=>{
 const {args}=fixture(),c=chain(null),trace=providerSequence(c,[providerResponse(503,{})]),capacityError=Error('Shared routing capacity is busy.');
 c.jupiterGate.acquire=async()=>{if(trace.calls.length)throw capacityError;};
 await assert.rejects(quoteConversion(c,args),error=>error===capacityError);assert.equal(trace.calls.length,1);
});
test('expired response bodies cannot extend the action deadline or start another provider attempt',async t=>{
 const {body,args}=fixture(),now=Date.now();let clock=now;t.mock.method(Date,'now',()=>clock);
 for(const status of [200,503]){
   clock=now;const c=chain(body);c.rpcContext={getStore:()=>({deadline:now+1000})};
   const response=providerResponse(status,body);response.json=async()=>{clock=now+1001;return body;};
   const trace=providerSequence(c,[response]);
   await assert.rejects(quoteConversion(c,args),error=>error.code==='SOL_ROUTE_TIMEOUT');assert.equal(trace.calls.length,1);assert.equal(trace.reservations.length,1);
 }
});


for(const sell of [false,true])for(const shared of [false,true])test(`Jupiter ${sell?'sell':'buy'} ${shared?'shared':'direct'} keeps exact input with0 and100 percent slippage`,async()=>{
  for(const slippageBps of [0,1,2537,10000]){
    const {body,args}=fixture({sell,shared}),offset=shared?9:8,data=Buffer.from(body.swapInstruction.data,'base64');
    data.writeUInt16LE(slippageBps,offset+16);body.swapInstruction.data=data.toString('base64');body.slippageBps=slippageBps;body.otherAmountThreshold=(800000n*BigInt(10000-slippageBps)/10000n).toString();
    const c=chain(body),q=await quoteConversion(c,{...args,slippageBps}),result=await buildConversion(c,q),swap=result.instructions.find(ix=>ix.programId.equals(jup));
    assert.equal(q.minimumRaw,body.otherAmountThreshold);assert.equal(new URL(c.seen[0].url).searchParams.get('slippageBps'),String(slippageBps));assert.equal(swap.data.readUInt16LE(offset+16),slippageBps);assert.equal(swap.data.readBigUInt64LE(offset),1000000n);
  }
});
test('Jupiter rejects out-of-range or fractional slippage before making provider requests',async()=>{
  for(const slippageBps of [-1,10001,0.5,NaN,Infinity,'100',null]){const {body,args}=fixture(),c=chain(body);await assert.rejects(quoteConversion(c,{...args,slippageBps}),/slippage/);assert.equal(c.seen.length,0);}
});
test('zero route output remains invalid even when the user explicitly accepts100 percent slippage',async()=>{
  const {body,args}=fixture();body.slippageBps=10000;body.outAmount='0';body.otherAmountThreshold='0';await assert.rejects(quoteConversion(chain(body),{...args,slippageBps:10000}),/differs/);
});


test('treasury guard failures preserve only locally branded fixed diagnostics without network retry',async()=>{
  for(const code of ['TREASURY_PRICE_IMPACT','TREASURY_SLIPPAGE_LIMIT','TREASURY_INVALID_IMPACT']){
    const {body,args}=fixture(),c=chain(body);let calls=0;
    c.fetcher=async()=>{calls++;throw treasuryRouteGuardError(code);};
    await assert.rejects(quoteConversion(c,args),error=>error.code===code&&error.treasuryPublic===true&&/No transaction was submitted/.test(error.message));
    assert.equal(calls,1);
  }
  const {body,args}=fixture(),c=chain(body);let calls=0;
  c.fetcher=async()=>{calls++;throw Object.assign(Error('PRIVATE_API_KEY https://private.invalid'),{code:'TREASURY_PRICE_IMPACT',treasuryPublic:true});};
  await assert.rejects(quoteConversion(c,args),error=>error.code==='SOL_ROUTE_NETWORK'&&!error.message.includes('PRIVATE_API_KEY')&&!error.message.includes('private.invalid'));
  assert.equal(calls,2);
});
