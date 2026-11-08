import { randomUUID, createHash } from 'node:crypto';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, ACCOUNT_SIZE, MINT_SIZE, MULTISIG_SIZE, AccountType, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createInitializeAccountInstruction, createCloseAccountInstruction, unpackAccount, unpackMint, unpackMultisig } from '@solana/spl-token';
import { JUPITER } from './core.mjs';
import { requireValue as ok } from '../public/launchpad-model.mjs';

const pk=x=>new PublicKey(x), SOL=NATIVE_MINT.toBase58(), JUP=pk(JUPITER), MAX_U64=18446744073709551615n;
const EVENT=PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],JUP)[0];
const plans=new WeakMap(), TTL=30000;
export const SOL_ROUTE_ACCOUNT_BUDGETS=Object.freeze([32,24,20,16]);
const discriminator=name=>createHash('sha256').update(`global:${name}`).digest().subarray(0,8);
const ROUTE=discriminator('route_v2'), SHARED=discriminator('shared_accounts_route_v2');
const transientStatuses=new Set([408,500,502,503,504]);
const routeFailure=(message,code,details={})=>Object.assign(new Error(message),{code,statusCode:503,...details});
const expiredRoute=()=>routeFailure('The SOL quote deadline passed. Please try again.','SOL_ROUTE_TIMEOUT');
const TREASURY_ROUTE_GUARD=Symbol('treasury-route-guard');
const treasuryRouteMessages=Object.freeze({
  TREASURY_PRICE_IMPACT:'The quoted treasury swap exceeds the 2% price-impact limit. No transaction was submitted.',
  TREASURY_SLIPPAGE_LIMIT:'The treasury route does not preserve the fixed 1% slippage limit. No transaction was submitted.',
  TREASURY_INVALID_IMPACT:'The treasury route did not provide a valid price-impact limit check. No transaction was submitted.',
});
// Only locally constructed, fixed-message guards cross the fetch error boundary.
// Provider JSON or arbitrary exception properties cannot supply a public error.
export function treasuryRouteGuardError(code){
  const message=Object.hasOwn(treasuryRouteMessages,code)?treasuryRouteMessages[code]:null;if(!message)throw Error('Unknown treasury route guard.');
  return Object.assign(Error(message),{code,treasuryPublic:true,[TREASURY_ROUTE_GUARD]:true});
}
function checkRouteDeadline(signal,deadline){if(signal.aborted||Date.now()>=deadline)throw expiredRoute();}
async function rejectedBuild(response){
  const status=Number.isInteger(response.status)&&response.status>=400&&response.status<=599?response.status:502;
  let body;try{body=await response.json();}catch{}
  const providerCode=body?.errorCode||body?.error?.code;
  const detail=typeof body?.error==='string'?body.error:body?.error?.message||body?.message;
  const noRoute=[400,404,422].includes(status)&&(['COULD_NOT_FIND_ANY_ROUTE','NO_ROUTES_FOUND','TOKEN_NOT_TRADABLE'].includes(providerCode)||typeof detail==='string'&&/no routes? found|could not find any route|token is not tradable/i.test(detail.slice(0,300)));
  // Provider response text and request credentials are never returned. Only
  // known categories and the numeric HTTP status cross the public boundary.
  if(noRoute)return routeFailure('No SOL route is available for this amount and route size right now. Please try again shortly.','SOL_ROUTE_NOT_FOUND',{httpStatus:status,routeUnavailable:true});
  if(status===429){const retryAfterMs=Math.min(60000,Math.max(2000,(Number(response.headers?.get('retry-after'))||2)*1000));return routeFailure(`SOL routing is busy (HTTP 429). Please try again in ${Math.ceil(retryAfterMs/1000)} seconds.`,'SOL_ROUTE_RATE_LIMITED',{httpStatus:status,rateLimited:true,retryAfterMs});}
  if(status===401||status===403)return routeFailure(`The site's SOL routing provider could not authorize this request (HTTP ${status}). The operator needs to check its routing configuration.`,'SOL_ROUTE_AUTH',{httpStatus:status});
  return routeFailure(transientStatuses.has(status)?`The SOL routing provider is temporarily unavailable (HTTP ${status}). Please try again shortly.`:`The SOL routing provider rejected this request (HTTP ${status}). Please try again shortly.`,transientStatuses.has(status)?'SOL_ROUTE_PROVIDER_UNAVAILABLE':'SOL_ROUTE_REJECTED',{httpStatus:status,retryable:transientStatuses.has(status)});
}
async function requestBuild(chain,url,config,signal,deadline){
  for(let attempt=0;attempt<2;attempt++){
    checkRouteDeadline(signal,deadline);
    // A retry must take another shared provider reservation under the original
    // deadline; it cannot bypass pacing or extend the trading action lifetime.
    await chain.jupiterGate.acquire(config,signal,deadline);checkRouteDeadline(signal,deadline);
    let response;
    try{response=await chain.fetcher(url,{headers:chain.jupiterKey?{'x-api-key':chain.jupiterKey}:{},signal});}
    catch(error){
      checkRouteDeadline(signal,deadline);
      if(error?.[TREASURY_ROUTE_GUARD]===true&&treasuryRouteMessages[error.code]===error.message)throw error;
      const networkCode=error?.code||error?.cause?.code||'',retryable=error?.retryable!==false&&!/CERT|TLS|SSL|ISSUER|SIGNATURE|EACCES|EPERM/.test(String(networkCode));
      if(retryable&&attempt===0)continue;
      throw routeFailure('The SOL routing provider could not be reached. Please try again shortly.','SOL_ROUTE_NETWORK',{retryable});
    }
    checkRouteDeadline(signal,deadline);
    if(response.ok){
      let body;try{body=await response.json();}catch{checkRouteDeadline(signal,deadline);throw routeFailure('The SOL routing provider returned an unreadable response. Please try again shortly.','SOL_ROUTE_INVALID_RESPONSE');}
      checkRouteDeadline(signal,deadline);return body;
    }
    const error=await rejectedBuild(response);
    checkRouteDeadline(signal,deadline);
    if(error.rateLimited)chain.jupiterGate.cooldown(config,error.retryAfterMs);
    if(error.retryable&&attempt===0)continue;
    throw error;
  }
}
const decimal=x=>typeof x==='string'&&/^[1-9]\d{0,19}$/.test(x)&&BigInt(x)<=MAX_U64;
function instruction(raw) {
  ok(raw&&typeof raw.data==='string'&&raw.data.length<=2048&&Array.isArray(raw.accounts)&&raw.accounts.length<=96,'The SOL route returned an invalid instruction.');
  const data=Buffer.from(raw.data,'base64');ok(data.toString('base64')===raw.data,'The SOL route returned invalid instruction bytes.');
  return new TransactionInstruction({programId:pk(raw.programId),data,keys:raw.accounts.map(a=>{
    ok(typeof a.isSigner==='boolean'&&typeof a.isWritable==='boolean','The SOL route returned invalid account flags.');
    return {pubkey:pk(a.pubkey),isSigner:a.isSigner,isWritable:a.isWritable};
  })});
}
function account(ix,index,key,{signer=false,writable=false}={}) {
  const a=ix.keys[index];ok(a&&a.pubkey.equals(key)&&a.isSigner===signer&&a.isWritable===writable,'The SOL route changed its authority, mint, or recipient.');
}
function decodeSwap(raw,request,expected,slippage) {
  const ix=instruction(raw),{wallet,inputMint,outputMint,inputProgram,outputProgram}=request;
  ok(ix.programId.equals(JUP)&&ix.keys.every(a=>!a.isSigner||a.pubkey.equals(wallet)),'Unexpected program or signer in the SOL route.');
  const shared=ix.data.subarray(0,8).equals(SHARED),direct=ix.data.subarray(0,8).equals(ROUTE);
  ok(shared||direct,'This SOL route instruction is not supported. Please try another amount.');
  const offset=shared?9:8;
  ok(ix.data.length>=offset+31&&ix.data.length<=1024,'The SOL route instruction is truncated.');
  ok(ix.data.readBigUInt64LE(offset)===BigInt(request.amountRaw)&&ix.data.readBigUInt64LE(offset+8)===expected&&ix.data.readUInt16LE(offset+16)===slippage&&ix.data.readUInt16LE(offset+18)===0&&ix.data.readUInt16LE(offset+20)===0,'The SOL route changed the spend, minimum, or fees.');
  const steps=ix.data.readUInt32LE(offset+22);ok(steps>0&&steps<=16&&ix.data.length>=offset+26+steps*5,'The SOL route plan is invalid.');
  const source=getAssociatedTokenAddressSync(inputMint,wallet,false,inputProgram),destination=getAssociatedTokenAddressSync(outputMint,wallet,false,outputProgram);
  if(direct){
    account(ix,0,wallet,{signer:true});account(ix,1,source,{writable:true});account(ix,2,destination,{writable:true});
    account(ix,3,inputMint);account(ix,4,outputMint);account(ix,5,inputProgram);account(ix,6,outputProgram);account(ix,7,JUP);account(ix,8,EVENT);account(ix,9,JUP);
  }else{
    ok(ix.keys.length>=12&&!ix.keys[0].isSigner&&!ix.keys[0].isWritable&&!PublicKey.isOnCurve(ix.keys[0].pubkey.toBytes()),'The SOL route shared authority is invalid.');
    account(ix,1,wallet,{signer:true});account(ix,2,source,{writable:true});account(ix,5,destination,{writable:true});
    account(ix,6,inputMint);account(ix,7,outputMint);account(ix,8,inputProgram);account(ix,9,outputProgram);account(ix,10,EVENT);account(ix,11,JUP);
  }
  // DEX remaining accounts can repeat the verified wallet as a writable payer
  // (for example Manifest). Preserve those flags: the composed transaction
  // already makes this same wallet writable as its fee/setup payer. The fixed
  // authority and recipients above remain exact, and prepareTrade must verify
  // the complete simulation's SOL spend, output and token-account permissions
  // before returning anything for signature. Per-instruction readonly metadata
  // cannot enforce a spend limit because Solana merges duplicate privileges.
  return ix;
}
function setupAccounts(raw,request) {
  ok(Array.isArray(raw)&&raw.length<=6,'The SOL route requires too many setup accounts.');
  const result=new Map();
  for(const item of raw){
    const ix=instruction(item);ok(ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)&&ix.data.length===1&&ix.data[0]===1&&ix.keys.length===6,'The SOL route contains an unexpected setup instruction.');
    const mint=ix.keys[3].pubkey,program=ix.keys[5].pubkey;
    ok(program.equals(TOKEN_PROGRAM_ID)||program.equals(TOKEN_2022_PROGRAM_ID),'The SOL route token program is unsupported.');
    const endpoint=mint.equals(request.inputMint)||mint.equals(request.outputMint);
    ok(endpoint||program.equals(TOKEN_PROGRAM_ID),'An intermediate SOL route token requires unsupported extensions.');
    const expectedProgram=mint.equals(request.inputMint)?request.inputProgram:mint.equals(request.outputMint)?request.outputProgram:program;
    ok(program.equals(expectedProgram),'The SOL route changed a token program.');
    const ata=getAssociatedTokenAddressSync(mint,request.wallet,false,program);
    account(ix,0,request.wallet,{signer:true,writable:true});account(ix,1,ata,{writable:true});account(ix,2,request.wallet);account(ix,3,mint);account(ix,4,SystemProgram.programId);account(ix,5,program);
    if(!mint.equals(NATIVE_MINT))result.set(ata.toBase58(),{address:ata,mint,program,endpoint});
  }
  return [...result.values()];
}
async function auditAccounts(chain,swap,setup,request,{mode='native'}={}) {
  const nativeAta=getAssociatedTokenAddressSync(NATIVE_MINT,request.wallet),token=mode==='token';
  const pairedMint=request.inputMint.equals(NATIVE_MINT)?request.outputMint:request.inputMint;
  const pairedProgram=request.inputMint.equals(NATIVE_MINT)?request.outputProgram:request.inputProgram;
  const pairedAta=getAssociatedTokenAddressSync(pairedMint,request.wallet,false,pairedProgram);
  // Token mode (reward baskets, v71.33): both of the wallet's own associated accounts are the route's endpoints, wrapped SOL
  // included (it stays wrapped: no temporary account). Their balances change by design; every other wallet account is monitored.
  const endpoints=new Set(token?[getAssociatedTokenAddressSync(request.inputMint,request.wallet,false,request.inputProgram).toBase58(),getAssociatedTokenAddressSync(request.outputMint,request.wallet,false,request.outputProgram).toBase58()]:[pairedAta.toBase58()]);
  const keys=[...new Map([...swap.keys.filter(a=>a.isWritable).map(a=>[a.pubkey.toBase58(),a.pubkey]),...setup.map(a=>[a.address.toBase58(),a.address])]).values()];
  // The user's pre-existing WSOL ATA is not included in the assembled message:
  // every reference is replaced with a fresh temporary token account below.
  const check=token?keys:keys.filter(k=>!k.equals(nativeAta));
  const response=await chain.c.getMultipleAccountsInfoAndContext(check,{commitment:'confirmed'});
  ok(Number.isSafeInteger(response?.context?.slot)&&Array.isArray(response.value)&&response.value.length===check.length,'The RPC could not verify the SOL route accounts.');
  const existing=new Map(check.map((key,i)=>[key.toBase58(),response.value[i]])),monitored=new Map();
  for(let i=0;i<check.length;i++){
    const value=response.value[i];if(!value)continue;
    if(![TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID].some(p=>value.owner.equals(p)))continue;
    // Token programs own three distinct state layouts. Meteora routes can write
    // vault LP mints, which are not wallet balance accounts. Classify exact
    // layouts before unpacking; never turn an arbitrary parse failure into an
    // exemption from the wallet-balance and permission checks below.
    const data=value.data,extended=value.owner.equals(TOKEN_2022_PROGRAM_ID),invalid='The SOL route contains an invalid token account.';
    ok(Buffer.isBuffer(data)&&!value.executable,invalid);
    const mint=data.length===MINT_SIZE||(extended&&data.length>ACCOUNT_SIZE&&data.length!==MULTISIG_SIZE&&data[ACCOUNT_SIZE]===AccountType.Mint);
    if(mint){
      ok(!check[i].equals(pairedAta)&&!setup.some(a=>a.address.equals(check[i])),invalid);
      ok([0,1].includes(data.readUInt32LE(0))&&data[45]===1&&[0,1].includes(data.readUInt32LE(46)),invalid);
      if(data.length>MINT_SIZE)ok(data.subarray(MINT_SIZE,ACCOUNT_SIZE).every(byte=>byte===0),invalid);
      let parsed;try{parsed=unpackMint(check[i],value,value.owner);}catch{throw new Error(invalid);}
      // Extended mints may carry additional authorities. Do not skip those
      // controls until their full extension state has an explicit audit.
      ok(parsed.tlvData.length===0,'A writable SOL route mint has unsupported extensions.');
      ok(!parsed.mintAuthority?.equals(request.wallet)&&!parsed.freezeAuthority?.equals(request.wallet),'The SOL route cannot use wallet-controlled mint authorities.');
      continue;
    }
    if(data.length===MULTISIG_SIZE){
      ok(!check[i].equals(pairedAta)&&!setup.some(a=>a.address.equals(check[i])),invalid);
      let parsed;try{parsed=unpackMultisig(check[i],value,value.owner);}catch{throw new Error(invalid);}
      ok(data[2]===1&&parsed.m>=1&&parsed.m<=parsed.n&&parsed.n<=11,invalid);
      ok(Array.from({length:parsed.n},(_,n)=>parsed[`signer${n+1}`]).every(signer=>!signer.equals(request.wallet)),'The SOL route cannot use wallet-controlled multisig authorities.');
      continue;
    }
    ok(data.length===ACCOUNT_SIZE||(extended&&data.length>ACCOUNT_SIZE&&data[ACCOUNT_SIZE]===AccountType.Account),invalid);
    ok([0,1].includes(data.readUInt32LE(72))&&[0,1,2].includes(data[108])&&[0,1].includes(data.readUInt32LE(109))&&[0,1].includes(data.readUInt32LE(129)),invalid);
    let a;try{a=unpackAccount(check[i],value,value.owner);}catch{throw new Error('The SOL route contains an invalid token account.');}
    if(a.owner.equals(request.wallet)){
      ok(a.isInitialized&&!a.isFrozen&&!a.delegate&&a.delegatedAmount===0n&&!a.closeAuthority&&(!a.isNative||token&&a.mint.equals(NATIVE_MINT)),'A SOL route token account has unexpected permissions.');
      if(endpoints.has(check[i].toBase58())){const expectedMint=token?(a.mint.equals(request.inputMint)?request.inputMint:request.outputMint):pairedMint,expectedProgram=token?(expectedMint.equals(request.inputMint)?request.inputProgram:request.outputProgram):pairedProgram;ok(a.mint.equals(expectedMint)&&value.owner.equals(expectedProgram)&&check[i].equals(getAssociatedTokenAddressSync(expectedMint,request.wallet,false,expectedProgram)),'The SOL route pairing account is invalid.');}
      else {
        ok(check[i].equals(getAssociatedTokenAddressSync(a.mint,request.wallet,false,value.owner)),'The SOL route contains a non-associated wallet token account.');
        ok(Number.isSafeInteger(value.lamports)&&value.lamports>=0,'The SOL route returned an invalid token rent balance.');
        // Intermediate accounts may already hold tokens. The composite trade's
        // final simulation must preserve those balances, rent, and permissions.
        monitored.set(check[i].toBase58(),{address:check[i].toBase58(),mint:a.mint.toBase58(),program:value.owner.toBase58(),minimumAmountRaw:a.amount.toString(),minimumLamports:value.lamports});
      }
    }else ok(!a.delegate?.equals(request.wallet),'The SOL route cannot use delegated wallet balances.');
  }
  let rent=0n;const rentValue=await chain.c.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
  ok(Number.isSafeInteger(rentValue)&&rentValue>=0&&rentValue<=10000000,'The RPC returned an invalid SOL routing rent estimate.');if(!token)rent+=BigInt(rentValue);
  const existingSetupAccounts=new Set();
  for(const a of setup){
    const value=existing.get(a.address.toBase58());
    if(value){
      const parsed=unpackAccount(a.address,value,a.program);
      ok(parsed.owner.equals(request.wallet)&&parsed.mint.equals(a.mint)&&parsed.isInitialized&&!parsed.isFrozen,'The SOL route setup account is invalid.');
      existingSetupAccounts.add(a.address.toBase58());
    }
    // The native pair builder separately accounts for the paired ATA's rent.
    else if(!a.endpoint){rent+=BigInt(rentValue);monitored.set(a.address.toBase58(),{address:a.address.toBase58(),mint:a.mint.toBase58(),program:a.program.toBase58(),minimumAmountRaw:'0',minimumLamports:rentValue});}
  }
  return {rentLamports:rent.toString(),nativeRent:rentValue,slot:response.context.slot,monitoredAccounts:[...monitored.values()],existingSetupAccounts};
}

/** Only the operator's connection/key is used; no trader RPC or API key exists
 * in this contract. A single build response is retained privately until prepare. */
export async function quoteConversion(chain,{inputMint,outputMint,amountRaw,slippageBps,wallet,inputProgram=TOKEN_PROGRAM_ID,outputProgram=TOKEN_PROGRAM_ID,maxAccounts=32}) {
  const request={inputMint:pk(inputMint),outputMint:pk(outputMint),inputProgram:pk(inputProgram),outputProgram:pk(outputProgram),amountRaw:String(amountRaw),wallet:pk(wallet)};
  ok(PublicKey.isOnCurve(request.wallet.toBytes())&&(request.inputMint.equals(NATIVE_MINT)!==request.outputMint.equals(NATIVE_MINT))&&decimal(request.amountRaw),'The SOL conversion request is invalid.');
  ok([request.inputProgram,request.outputProgram].every(p=>p.equals(TOKEN_PROGRAM_ID)||p.equals(TOKEN_2022_PROGRAM_ID))&&Number.isInteger(slippageBps)&&slippageBps>=0&&slippageBps<=10000,'The SOL conversion slippage or token program is invalid.');
  ok((request.inputMint.equals(NATIVE_MINT)?request.inputProgram:request.outputProgram).equals(TOKEN_PROGRAM_ID),'SOL must use the native token program.');
  ok(SOL_ROUTE_ACCOUNT_BUDGETS.includes(maxAccounts),'The SOL route account budget is invalid.');
  const deadline=Math.min(Date.now()+15000,chain.rpcContext?.getStore?.()?.deadline??Infinity);
  ok(deadline>Date.now(),'The SOL quote deadline passed. Please try again.');
  const signal=AbortSignal.timeout(Math.max(1,Math.ceil(deadline-Date.now()))),config={jupiterKey:chain.jupiterKey||''};
  const query=new URLSearchParams({inputMint:request.inputMint.toBase58(),outputMint:request.outputMint.toBase58(),amount:request.amountRaw,taker:request.wallet.toBase58(),slippageBps:String(slippageBps),mode:'fast',maxAccounts:String(maxAccounts),wrapAndUnwrapSol:'false',platformFeeBps:'0'});
  const b=await requestBuild(chain,'https://api.jup.ag/swap/v2/build?'+query,config,signal,deadline);
  ok(b.inputMint===inputMint.toString()&&b.outputMint===outputMint.toString()&&b.inAmount===request.amountRaw&&b.swapMode==='ExactIn'&&b.slippageBps===slippageBps&&decimal(b.outAmount)&&(decimal(b.otherAmountThreshold)||slippageBps===10000&&b.otherAmountThreshold==='0'),'The SOL route differs from the requested trade.');
  ok(!b.tipInstruction&&!b.cleanupInstruction&&(!b.otherInstructions||Array.isArray(b.otherInstructions)&&b.otherInstructions.length===0)&&(!b.platformFee||Number(b.platformFee.feeBps)===0&&BigInt(b.platformFee.amount||0)===0n),'The SOL route contains an unexpected fee or transfer.');
  ok(Array.isArray(b.routePlan)&&b.routePlan.length>0&&b.routePlan.length<=16&&Number.isFinite(Number(b.priceImpactPct))&&Math.abs(Number(b.priceImpactPct))<=0.05,'The SOL conversion route has excessive price impact.');
  const expected=BigInt(b.outAmount),minimum=expected*BigInt(10000-slippageBps)/10000n,reported=BigInt(b.otherAmountThreshold);
  ok((minimum>0n||slippageBps===10000)&&reported>=minimum&&reported<=minimum+1n,'The SOL route minimum output is invalid.');
  const swap=decodeSwap(b.swapInstruction,request,expected,slippageBps),setup=setupAccounts(b.setupInstructions||[],request),cost=await auditAccounts(chain,swap,setup,request);
  const mapping=b.addressesByLookupTableAddress||{};ok(typeof mapping==='object'&&!Array.isArray(mapping)&&Object.keys(mapping).length<=20,'The SOL route returned invalid lookup tables.');
  const tables=Object.keys(mapping);for(const key of tables)pk(key);
  const result=Object.freeze({inputMint:request.inputMint.toBase58(),outputMint:request.outputMint.toBase58(),amountRaw:request.amountRaw,expectedRaw:expected.toString(),minimumRaw:minimum.toString(),rentLamports:cost.rentLamports,slot:cost.slot,expiresAt:Date.now()+TTL,route:'Jupiter'});
  plans.set(result,{chain,request,swap,setup,tables,nativeRent:cost.nativeRent,monitoredAccounts:cost.monitoredAccounts,existingSetupAccounts:cost.existingSetupAccounts});return result;
}

/** Return instructions to compose with the direct Launchpad/Raydium leg. They must
 * be simulated and signed together; this adapter never signs or broadcasts. */
export async function buildConversion(chain,result) {
  const plan=plans.get(result);ok(plan&&plan.chain===chain&&result.expiresAt>Date.now(),'The SOL route expired. Review a fresh quote.');
  const {request,swap,setup,tables,nativeRent}=plan,seed=randomUUID().replaceAll('-',''),temporary=await PublicKey.createWithSeed(request.wallet,seed,TOKEN_PROGRAM_ID),nativeAta=getAssociatedTokenAddressSync(NATIVE_MINT,request.wallet);
  const funding=BigInt(nativeRent)+(request.inputMint.equals(NATIVE_MINT)?BigInt(request.amountRaw):0n);
  ok(funding<=BigInt(Number.MAX_SAFE_INTEGER),'The SOL amount is too large for this route.');
  // Reference the already-present wallet and native mint rather than embedding
  // the 32-byte owner in InitializeAccount3. The verified lookup tables can
  // compress the fixed Rent sysvar, keeping tight atomic routes within v0 size.
  // The full random seed, exact funding and temporary-account cleanup remain.
  const instructions=[SystemProgram.createAccountWithSeed({fromPubkey:request.wallet,basePubkey:request.wallet,seed,newAccountPubkey:temporary,lamports:Number(funding),space:ACCOUNT_SIZE,programId:TOKEN_PROGRAM_ID}),createInitializeAccountInstruction(temporary,NATIVE_MINT,request.wallet)];
  // Omit only ATAs whose onchain program, owner, mint and initialized state
  // passed this quote's audit. Fresh preparation requotes and audits again;
  // missing accounts retain idempotent setup. A later account closure makes
  // the atomic swap fail, and cannot redirect funds or weaken simulation.
  for(const a of setup)if(!plan.existingSetupAccounts.has(a.address.toBase58()))instructions.push(createAssociatedTokenAccountIdempotentInstruction(request.wallet,a.address,request.wallet,a.mint,a.program));
  instructions.push(new TransactionInstruction({programId:swap.programId,data:Buffer.from(swap.data),keys:swap.keys.map(a=>({...a,pubkey:a.pubkey.equals(nativeAta)?temporary:a.pubkey}))}),createCloseAccountInstruction(temporary,request.wallet,request.wallet));
  const lookupTables=tables.length?await chain.lookupTables(tables):[];
  plans.delete(result);
  return {instructions,lookupTables,rentLamports:result.rentLamports,nativeAccount:temporary.toBase58(),monitoredAccounts:plan.monitoredAccounts};
}

/** Token → token conversion for a managed wallet (reward baskets, v71.33). The wallet's own associated token accounts are the
 * route's source and destination (wrapped SOL stays wrapped: no temporary account), so this never spends or unwraps native
 * SOL. Audited like quoteConversion: the fixed authority, mints and recipients, no unexpected signer or fee, bounded impact and
 * route size, every other writable wallet-owned account an associated account whose balance and rent the caller's simulation
 * must preserve (`monitoredAccounts`). The caller simulates the composed transaction and checks the exact input debit and the
 * minimum output credit before anything is signed. */
export async function tokenConversion(chain,{inputMint,outputMint,amountRaw,slippageBps,wallet,inputProgram=TOKEN_PROGRAM_ID,outputProgram=TOKEN_PROGRAM_ID,maxAccounts=32}) {
  const request={inputMint:pk(inputMint),outputMint:pk(outputMint),inputProgram:pk(inputProgram),outputProgram:pk(outputProgram),amountRaw:String(amountRaw),wallet:pk(wallet)};
  ok(PublicKey.isOnCurve(request.wallet.toBytes())&&!request.inputMint.equals(request.outputMint)&&decimal(request.amountRaw),'The token conversion request is invalid.');
  ok([request.inputProgram,request.outputProgram].every(p=>p.equals(TOKEN_PROGRAM_ID)||p.equals(TOKEN_2022_PROGRAM_ID))&&Number.isInteger(slippageBps)&&slippageBps>=0&&slippageBps<=10000,'The token conversion slippage or token program is invalid.');
  for(const [mint,program] of [[request.inputMint,request.inputProgram],[request.outputMint,request.outputProgram]])if(mint.equals(NATIVE_MINT))ok(program.equals(TOKEN_PROGRAM_ID),'Wrapped SOL must use the native token program.');
  ok(SOL_ROUTE_ACCOUNT_BUDGETS.includes(maxAccounts),'The route account budget is invalid.');
  const deadline=Math.min(Date.now()+15000,chain.rpcContext?.getStore?.()?.deadline??Infinity);
  ok(deadline>Date.now(),'The conversion quote deadline passed. Please try again.');
  const signal=AbortSignal.timeout(Math.max(1,Math.ceil(deadline-Date.now()))),config={jupiterKey:chain.jupiterKey||''};
  const query=new URLSearchParams({inputMint:request.inputMint.toBase58(),outputMint:request.outputMint.toBase58(),amount:request.amountRaw,taker:request.wallet.toBase58(),slippageBps:String(slippageBps),mode:'fast',maxAccounts:String(maxAccounts),wrapAndUnwrapSol:'false',platformFeeBps:'0'});
  const b=await requestBuild(chain,'https://api.jup.ag/swap/v2/build?'+query,config,signal,deadline);
  ok(b.inputMint===request.inputMint.toBase58()&&b.outputMint===request.outputMint.toBase58()&&b.inAmount===request.amountRaw&&b.swapMode==='ExactIn'&&b.slippageBps===slippageBps&&decimal(b.outAmount)&&(decimal(b.otherAmountThreshold)||slippageBps===10000&&b.otherAmountThreshold==='0'),'The conversion route differs from the requested trade.');
  ok(!b.tipInstruction&&!b.cleanupInstruction&&(!b.otherInstructions||Array.isArray(b.otherInstructions)&&b.otherInstructions.length===0)&&(!b.platformFee||Number(b.platformFee.feeBps)===0&&BigInt(b.platformFee.amount||0)===0n),'The conversion route contains an unexpected fee or transfer.');
  ok(Array.isArray(b.routePlan)&&b.routePlan.length>0&&b.routePlan.length<=16&&Number.isFinite(Number(b.priceImpactPct))&&Math.abs(Number(b.priceImpactPct))<=0.05,'The conversion route has excessive price impact.');
  const expected=BigInt(b.outAmount),minimum=expected*BigInt(10000-slippageBps)/10000n,reported=BigInt(b.otherAmountThreshold);
  ok((minimum>0n||slippageBps===10000)&&reported>=minimum&&reported<=minimum+1n,'The conversion route minimum output is invalid.');
  const swap=decodeSwap(b.swapInstruction,request,expected,slippageBps),setup=setupAccounts(b.setupInstructions||[],request),cost=await auditAccounts(chain,swap,setup,request,{mode:'token'});
  const mapping=b.addressesByLookupTableAddress||{};ok(typeof mapping==='object'&&!Array.isArray(mapping)&&Object.keys(mapping).length<=20,'The conversion route returned invalid lookup tables.');
  const tables=Object.keys(mapping);for(const key of tables)pk(key);
  const result=Object.freeze({inputMint:request.inputMint.toBase58(),outputMint:request.outputMint.toBase58(),amountRaw:request.amountRaw,expectedRaw:expected.toString(),minimumRaw:minimum.toString(),priceImpactPct:String(b.priceImpactPct),rentLamports:cost.rentLamports,slot:cost.slot,expiresAt:Date.now()+TTL,route:'Jupiter',kind:'token'});
  plans.set(result,{chain,request,swap,setup,tables,monitoredAccounts:cost.monitoredAccounts,existingSetupAccounts:cost.existingSetupAccounts,token:true});return result;
}
/** Instructions for a tokenConversion quote: the destination and the route's missing setup accounts created idempotently with
 * `payer` paying their rent (the managed gas wallet; the owner stays the converting wallet), then the audited swap as built.
 * No temporary account, no unwrap. The caller composes, simulates and signs. */
export async function buildTokenConversion(chain,result,{payer}={}) {
  const plan=plans.get(result);ok(plan&&plan.token===true&&plan.chain===chain&&result.expiresAt>Date.now(),'The conversion route expired. Review a fresh quote.');
  const {request,swap,setup,tables}=plan,rentPayer=payer?pk(payer):request.wallet;
  const source=getAssociatedTokenAddressSync(request.inputMint,request.wallet,false,request.inputProgram),destination=getAssociatedTokenAddressSync(request.outputMint,request.wallet,false,request.outputProgram);
  const instructions=[createAssociatedTokenAccountIdempotentInstruction(rentPayer,destination,request.wallet,request.outputMint,request.outputProgram)];
  for(const a of setup)if(!a.address.equals(destination)&&!plan.existingSetupAccounts.has(a.address.toBase58()))instructions.push(createAssociatedTokenAccountIdempotentInstruction(rentPayer,a.address,request.wallet,a.mint,a.program));
  instructions.push(new TransactionInstruction({programId:swap.programId,data:Buffer.from(swap.data),keys:swap.keys.map(a=>({...a}))}));
  const lookupTables=tables.length?await chain.lookupTables(tables):[];
  plans.delete(result);
  return {instructions,lookupTables,rentLamports:result.rentLamports,monitoredAccounts:plan.monitoredAccounts,source:source.toBase58(),destination:destination.toBase58()};
}
