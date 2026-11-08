import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PublicKey, Keypair, TransactionMessage, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { LaunchChain, ray, decodeRay, rayCurveAtTarget } from '../src/launchpad-chain.mjs';
import { newLaunchKeys } from '../src/launchpad-receipts.mjs';
import { transactionSize } from '../src/providers.mjs';
import { launchInput, SOL_MINT } from '../public/launchpad-model.mjs';
import { JUPITER } from '../src/core.mjs';

const fixture = JSON.parse(await readFile(new URL('./launchpad-accounts.json', import.meta.url), 'utf8'));
const config = decodeRay({ ...fixture.rayConfig.account, owner: new PublicKey(fixture.rayConfig.account.owner), data: Buffer.from(fixture.rayConfig.account.data[0], 'base64') }, ray.LAUNCHPAD_PROGRAM, ray.LaunchpadConfig, 'GlobalConfig');
const compile = (payer, instructions) => new TransactionMessage({
  payerKey: new PublicKey(payer), recentBlockhash: Keypair.generate().publicKey.toBase58(),
  instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }), ...instructions],
}).compileToV0Message();
function draft(quoteKind, feeMode, taxPercent, gross) {
  const keys = newLaunchKeys(); keys.platform = keys.wallet;
  keys.payer = { address: Keypair.generate().publicKey.toBase58(), external: true };
  const quoteMint = quoteKind === 'sol' ? SOL_MINT : Keypair.generate().publicKey.toBase58();
  const input = launchInput({ name: 'N'.repeat(32), symbol: 'T'.repeat(10), quoteMint, feeMode, taxPercent, devBuySol: '0', walletMode: 'external', externalWallet: keys.payer.address });
  // Pricing is independently tested. Pin the reviewed raw values here to test
  // actual SDK serialization at the 100M-token cap, including every key role.
  input.devBuyMode = 'percent'; input.devBuyRaw = gross;
  const review = { ...rayCurveAtTarget(config, 9, '100'), configId: fixture.rayConfig.pubkey, cpConfigId: 'D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2',
    quoteProgram: (quoteKind === 'token2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID).toBase58(), quoteDecimals: 9,
    price: { usd: '100' }, minimumSol: '0.1', creatorFeeBps: 25, protocolFeeBps: 25, platformRent: '15000000', serviceReserve: '20000000', storageWalletRent: '890880',
    devBuy: { gross, net: String(BigInt(gross) - (BigInt(gross) * BigInt(input.taxBps) + 9999n) / 10000n), maxQuote: '1000000000', solBudget: '1000000000' } };
  input.image = 'https://gateway.irys.xyz/' + 'a'.repeat(44);
  return { keys, input, review, feeCustody:'relay', uri: 'https://gateway.irys.xyz/' + 'b'.repeat(44), publicOrigin: 'https://app.example/' + 'z'.repeat(850), storage: { provider: 'irys', budget: '0', items: [] } };
}

test('maximum supported token details and 100M atomic developer buy fit wallet v0 across quote programs and fee modes', async () => {
  const chain = new LaunchChain({ network: 'mainnet-beta', connection: { getMinimumBalanceForRentExemption: async () => 2039280 } });
  for (const quote of ['sol', 'spl', 'token2022']) for (const feeMode of ['creator', 'holders', 'buyback']) for (const tax of feeMode === 'holders' ? ['0', '5'] : ['0']) {
    const launch = draft(quote, feeMode, tax, '100000000000000');
    const instructions = await chain.launchInstructions(launch, 'create');
    const message = compile(launch.keys.payer.address, instructions), bytes = transactionSize(message);
    assert(bytes <= 1232, `${quote}/${feeMode}/${tax}: ${bytes} bytes exceeds wallet v0`);
    const rayInstructions = instructions.filter(ix => ix.programId.equals(ray.LAUNCHPAD_PROGRAM));
    assert.equal(rayInstructions.length, 2, 'Token creation and developer purchase remain together');
    assert.equal(rayInstructions[1].data.readBigUInt64LE(8), BigInt(launch.review.devBuy.net));
    assert.equal(message.header.numRequiredSignatures, 2, 'Only the external developer and mint sign the final atomic transaction');
    assert(message.staticAccountKeys.slice(0,2).some(key => key.toBase58() === launch.keys.mint.address));
    assert(!message.staticAccountKeys.slice(0,2).some(key=>key.toBase58()===launch.keys.wallet.address),'the managed fee authority does not add a developer approval');
    const creatorVault=ray.getPdaCreatorVault(ray.LAUNCHPAD_PROGRAM,new PublicKey(launch.keys.wallet.address),new PublicKey(launch.input.quoteMint)).publicKey;
    assert(rayInstructions[1].keys.some(key=>key.pubkey.equals(creatorVault)),'developer buy credits this coin’s separate creator vault');
  }
});

test('atomic creation keeps immutable Irys URI and excludes platform-only host/image duplication', async () => {
  const chain = new LaunchChain({ network: 'mainnet-beta', connection: {} });
  const launch = draft('token2022', 'holders', '0', '100000000000000');
  const before = await chain.launchInstructions(launch, 'create');
  assert(before[0].data.includes(Buffer.from(launch.uri)));
  assert(!before[0].data.includes(Buffer.from(launch.publicOrigin)));
  assert(!before[0].data.includes(Buffer.from(launch.input.image)));
  launch.publicOrigin = ''; launch.input.image = '';
  const after = await chain.launchInstructions(launch, 'create');
  assert.deepEqual(before.map(ix => ix.data), after.map(ix => ix.data));
  assert.equal(transactionSize(compile(launch.keys.payer.address,before)), transactionSize(compile(launch.keys.payer.address,after)));
});

// Provider-shaped route fixtures exercise packet sizing, not execution of a
// synthetic swap. The Raydium platform/create/buy instructions use the real SDK.
function fundingRoute(launch, accountCount=12, dataLength=0) {
  return { inputMint:SOL_MINT, outputMint:launch.input.quoteMint, inAmount:launch.review.devBuy.solBudget,
    otherAmountThreshold:launch.review.devBuy.maxQuote, slippageBps:100, priceImpactPct:'.001', swapMode:'ExactIn',
    swapInstruction:{programId:JUPITER,accounts:[{pubkey:launch.keys.payer.address,isSigner:true,isWritable:true},
      ...Array.from({length:accountCount},()=>({pubkey:Keypair.generate().publicKey.toBase58(),isSigner:false,isWritable:true}))],data:Buffer.alloc(dataLength).toString('base64')},addressesByLookupTableAddress:{} };
}
function routeHarness(launch, getRoute) {
  const limits=[];
  const chain=new LaunchChain({network:'mainnet-beta',connection:{getMinimumBalanceForRentExemption:async()=>2039280,getAccountInfoAndContext:async()=>({context:{slot:100},value:null})},fetcher:async url=>{
    const query=new URL(url).searchParams,limit=Number(query.get('maxAccounts'));limits.push(limit);
    assert.equal(query.get('amount'),launch.review.devBuy.solBudget);assert.equal(query.get('taker'),launch.keys.payer.address);
    assert.equal(query.get('inputMint'),SOL_MINT);assert.equal(query.get('outputMint'),launch.input.quoteMint);assert.equal(query.get('slippageBps'),'100');
    return new Response(JSON.stringify(getRoute(limit)));
  }});
  chain.jupiterGate={acquire:async()=>{},cooldown:()=>{}};
  return{chain,limits};
}

test('a 1451-byte non-SOL setup fits v0 after moving platform initialization to its funded signer',async t=>{
  const launch=draft('spl','creator','0','100000000000000');launch.executionPlan='compact-v2';launch.storage={provider:'irys',budget:'10000',recipient:Keypair.generate().publicKey.toBase58()};
  const route=fundingRoute(launch),{chain}=routeHarness(launch,()=>route);
  const prefix=[...await chain.launchInstructions(launch,'storage-credit'),...await chain.launchInstructions(launch,'platform')];
  let size=0,length=0;
  for(let attempt=0;attempt<3;attempt++){
    route.swapInstruction.data=Buffer.alloc(length).toString('base64');
    size=transactionSize(compile(launch.keys.payer.address,[...prefix,...await chain.quoteFundingInstructions(launch)]));
    if(size===1451)break;length+=1451-size;assert(length>=0);
  }
  assert.equal(size,1451,'reproduces the reported packet size using actual SDK platform instructions');
  await assert.rejects(chain.launchInstructions(launch,'setup'),error=>error.code==='LAUNCH_TRANSACTION_TOO_LARGE'&&error.transactionBytes===1451);
  launch.executionPlan='compact-v3';
  const review=await chain.preflightWalletSize(launch);assert.equal(review.transactions,2);
  const setup=await chain.launchInstructions(launch,'setup'),message=await chain.walletMessage(new PublicKey(launch.keys.payer.address),SystemProgram.programId.toBase58(),setup,1400000,'launch setup');
  assert(transactionSize(message)<=1232);assert.equal(message.header.numRequiredSignatures,1);t.diagnostic('Setup packet: 1451 → '+transactionSize(message)+' bytes');
  assert(!setup.some(ix=>ix.programId.equals(ray.LAUNCHPAD_PROGRAM)));
  const platform=await chain.launchInstructions(launch,'platform-setup');assert.equal(platform.length,1);assert(platform[0].programId.equals(ray.LAUNCHPAD_PROGRAM));
  const final=await chain.launchInstructions(launch,'create');assert.equal(final.filter(ix=>ix.programId.equals(ray.LAUNCHPAD_PROGRAM)).length,2);
});

test('oversized quote routes rebuild within the same reviewed budget and stop before payments if none fits',async()=>{
  const launch=draft('spl','holders','0','100000000000000');launch.executionPlan='compact-v3';
  const large=fundingRoute(launch,36,200),small=fundingRoute(launch,12,100);
  let safe=true,alwaysLarge=false;
  const {chain,limits}=routeHarness(launch,limit=>alwaysLarge||limit>16?large:{...small,otherAmountThreshold:safe?small.otherAmountThreshold:'1'});
  const reviewed=structuredClone(launch.review);let sends=0;
  chain.c.sendRawTransaction=async()=>{sends++;throw Error('Preflight must never send a transaction');};
  const setup=await chain.launchInstructions(launch,'setup');assert.deepEqual(limits,[32,24,16]);
  assert(transactionSize(compile(launch.keys.payer.address,setup))<=1232);
  limits.length=0;safe=false;
  await assert.rejects(chain.preflightWalletSize(launch),error=>error.code==='LAUNCH_FUNDING_PRICE_MOVED'&&error.retryable===true);assert.deepEqual(limits,[32,24,16]);
  assert.deepEqual(launch.review,reviewed,'a smaller route cannot lower the reviewed minimum or increase its budget');assert.equal(sends,0);
  limits.length=0;safe=true;alwaysLarge=true;
  await assert.rejects(chain.preflightWalletSize(launch),error=>error.code==='LAUNCH_TRANSACTION_TOO_LARGE');assert.deepEqual(limits,[32,24,16]);
  assert.equal(sends,0);
});
