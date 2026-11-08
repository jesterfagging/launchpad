import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ACCOUNT_SIZE, MINT_SIZE, MULTISIG_SIZE, AccountType, MintLayout, AccountLayout, MultisigLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { quoteConversion, buildConversion } from '../src/launchpad-trading-route.mjs';

const captured=JSON.parse(readFileSync(new URL('./fixtures/sol-wbtc-token-types-mainnet.json',import.meta.url),'utf8'));
const wallet=new PublicKey(captured.request.taker),external=Keypair.generate().publicKey;
const meta=pubkey=>({pubkey:pubkey.toBase58(),isSigner:false,isWritable:true});
function fixture(){
  const body=structuredClone(captured.response),existing=new Map(captured.tokenAccounts.map(({address,account})=>[address,{...account,owner:new PublicKey(account.owner),data:Buffer.from(account.data[0],'base64')}]));
  const args={inputMint:captured.request.inputMint,outputMint:captured.request.outputMint,amountRaw:captured.request.amount,wallet:wallet.toBase58(),slippageBps:Number(captured.request.slippageBps)};
  const chain={jupiterGate:{async acquire(){},cooldown(){}},fetcher:async()=>({ok:true,status:200,json:async()=>body}),c:{async getMultipleAccountsInfoAndContext(keys){return{context:{slot:captured.slot},value:keys.map(k=>existing.get(k.toBase58())||null)};},async getMinimumBalanceForRentExemption(){return 2039280;}},lookupTables:async()=>[]};
  return {body,existing,args,chain};
}
function mintInfo({program=TOKEN_PROGRAM_ID,authority=external,freeze=null,length=MINT_SIZE}={}){
  const data=Buffer.alloc(length);MintLayout.encode({mintAuthorityOption:authority?1:0,mintAuthority:authority||PublicKey.default,supply:10000n,decimals:6,isInitialized:true,freezeAuthorityOption:freeze?1:0,freezeAuthority:freeze||PublicKey.default},data);
  if(length>ACCOUNT_SIZE)data[ACCOUNT_SIZE]=AccountType.Mint;
  return{owner:program,data,lamports:1461600,executable:false};
}
function multisigInfo({program=TOKEN_PROGRAM_ID,signers=[external],m=1}={}){
  const data=Buffer.alloc(MULTISIG_SIZE);MultisigLayout.encode({m,n:signers.length,isInitialized:true,...Object.fromEntries(Array.from({length:11},(_,i)=>[`signer${i+1}`,signers[i]||PublicKey.default]))},data);
  return{owner:program,data,lamports:3361680,executable:false};
}
function accountInfo({owner=wallet,mint=external,delegate=null,program=TOKEN_PROGRAM_ID,length=ACCOUNT_SIZE}={}){
  const data=Buffer.alloc(length);AccountLayout.encode({mint,owner,amount:10n,delegateOption:delegate?1:0,delegate:delegate||PublicKey.default,state:1,isNativeOption:0,isNative:0n,delegatedAmount:delegate?10n:0n,closeAuthorityOption:0,closeAuthority:PublicKey.default},data);
  if(length>ACCOUNT_SIZE)data[ACCOUNT_SIZE]=AccountType.Account;
  return{owner:program,data,lamports:2039280,executable:false};
}
function append(f,value,address=Keypair.generate().publicKey){f.body.swapInstruction.accounts.push(meta(address));f.existing.set(address.toBase58(),value);return address;}

test('captured SOL/WBTC Meteora route has two writable SPL LP mints and keeps actual balance accounts audited',async()=>{
  const f=fixture(),mints=[...f.existing.entries()].filter(([,v])=>v.data.length===MINT_SIZE);
  assert.equal(mints.length,2);assert(f.body.routePlan.some(step=>step.swapInfo.label==='Meteora'));
  for(const [address,value] of mints){assert.equal(value.owner.toBase58(),TOKEN_PROGRAM_ID.toBase58());assert(f.body.swapInstruction.accounts.some(meta=>meta.pubkey===address&&meta.isWritable));}
  const quote=await quoteConversion(f.chain,f.args),route=await buildConversion(f.chain,quote);
  assert.equal(quote.expectedRaw,captured.response.outAmount);assert.equal(quote.amountRaw,'50000000');assert.equal(quote.slot,captured.slot);
  assert(!JSON.stringify(route.monitoredAccounts).includes(mints[0][0]));assert(!JSON.stringify(route.monitoredAccounts).includes(mints[1][0]));
});
for(const program of [TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID]){
  test(`accepts an initialized external mint with no extension authorities (${program.toBase58()})`,async()=>{
    const f=fixture();append(f,mintInfo({program}));await quoteConversion(f.chain,f.args);
  });
  test(`accepts a valid external multisig (${program.toBase58()})`,async()=>{
    const f=fixture();append(f,multisigInfo({program}));await quoteConversion(f.chain,f.args);
  });
}
for(const [name,info,pattern] of [
  ['wallet mint authority',()=>mintInfo({authority:wallet}),/wallet-controlled mint/],
  ['wallet freeze authority',()=>mintInfo({freeze:wallet}),/wallet-controlled mint/],
  ['wallet multisig signer',()=>multisigInfo({signers:[external,wallet],m:2}),/wallet-controlled multisig/],
  ['uninitialized mint',()=>{const v=mintInfo();v.data[45]=0;return v;},/invalid token/],
  ['invalid mint option',()=>{const v=mintInfo();v.data.writeUInt32LE(2,0);return v;},/invalid token/],
  ['invalid freeze option',()=>{const v=mintInfo();v.data.writeUInt32LE(2,46);return v;},/invalid token/],
  ['uninitialized multisig',()=>{const v=multisigInfo();v.data[2]=0;return v;},/invalid token/],
  ['invalid multisig threshold',()=>multisigInfo({m:2}),/invalid token/],
  ['invalid multisig signer count',()=>{const v=multisigInfo();v.data[1]=12;return v;},/invalid token/],
  ['truncated token data',()=>({...mintInfo(),data:Buffer.alloc(81)}),/invalid token/],
  ['executable token state',()=>({...mintInfo(),executable:true}),/invalid token/],
  ['legacy account with extension marker',()=>accountInfo({length:ACCOUNT_SIZE+1}),/invalid token/],
  ['unknown Token-2022 account type',()=>{const v=accountInfo({program:TOKEN_2022_PROGRAM_ID,length:ACCOUNT_SIZE+1});v.data[ACCOUNT_SIZE]=3;return v;},/invalid token/],
  ['Token-2022 mint extension authority',()=>mintInfo({program:TOKEN_2022_PROGRAM_ID,length:ACCOUNT_SIZE+6}),/unsupported extensions/],
  ['Token-2022 mint nonzero padding',()=>{const v=mintInfo({program:TOKEN_2022_PROGRAM_ID,length:ACCOUNT_SIZE+1});v.data[MINT_SIZE]=1;return v;},/invalid token/],
  ['delegated external token balance',()=>accountInfo({owner:external,delegate:wallet}),/delegated wallet balances/],
  ['wallet non-associated token balance',()=>accountInfo(),/non-associated wallet/],
  ['invalid token option',()=>{const v=accountInfo();v.data.writeUInt32LE(2,72);return v;},/invalid token/],
  ['invalid token state',()=>{const v=accountInfo();v.data[108]=3;return v;},/invalid token/],
])test(`does not exempt ${name} from the SOL route audit`,async()=>{
  const f=fixture();append(f,info());await assert.rejects(quoteConversion(f.chain,f.args),pattern);
});
test('accepts typed Token-2022 mint with empty extensions',async()=>{
  const f=fixture();append(f,mintInfo({program:TOKEN_2022_PROGRAM_ID,length:ACCOUNT_SIZE+1}));await quoteConversion(f.chain,f.args);
});
for(const kind of ['mint','multisig'])test(`does not accept a ${kind} at the paired wallet balance address`,async()=>{
  const f=fixture(),address=getAssociatedTokenAddressSync(new PublicKey(f.args.outputMint),wallet);f.existing.set(address.toBase58(),kind==='mint'?mintInfo():multisigInfo());await assert.rejects(quoteConversion(f.chain,f.args),/invalid token/);
});
test('wallet intermediate token balances still require full simulation preservation after mint classification',async()=>{
  const f=fixture(),address=getAssociatedTokenAddressSync(external,wallet);append(f,accountInfo(),address);
  const quote=await quoteConversion(f.chain,f.args),route=await buildConversion(f.chain,quote);
  assert(route.monitoredAccounts.some(a=>a.address===address.toBase58()&&a.minimumAmountRaw==='10'&&a.minimumLamports===2039280));
});
