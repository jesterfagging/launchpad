import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { AccountLayout, MintLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TransferFeeConfigLayout, ExtensionType, getMintLen } from '@solana/spl-token';
import BN from 'bn.js';
import { LaunchChain, ray, newLaunchKeys } from '../src/launchpad-chain.mjs';
import { taxConversionAmount, TAX_CONVERSION_BURST_POLICY, TAX_CONVERSION_BACKLOG_UNITS } from '../src/launchpad-tax-conversion.mjs';

const key = () => Keypair.generate().publicKey;
const bn = value => new BN(String(value));
const BATCH_LIMIT = 1000000000000n; // 1,000,000 tokens, six decimals.

function rayAccount(layout, name, fields, owner = ray.LAUNCHPAD_PROGRAM) {
  const data = Buffer.alloc(layout.span);
  layout.encode({ ...layout.decode(data), ...fields }, data);
  createHash('sha256').update(`account:${name}`).digest().copy(data, 0, 0, 8);
  return { owner, data, lamports: 1000000, executable: false };
}

function tokenAccount(mint, owner, amount, program = TOKEN_PROGRAM_ID) {
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode({ mint, owner, amount: BigInt(amount), delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
  return { owner: program, data, lamports: 2039280, executable: false };
}

function mintAccount(authority, { taxBps = 0, program = TOKEN_PROGRAM_ID } = {}) {
  const data = Buffer.alloc(taxBps ? getMintLen([ExtensionType.TransferFeeConfig]) : MintLayout.span);
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 1000000000000000n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data);
  if (taxBps) {
    data[165] = 1;
    data.writeUInt16LE(ExtensionType.TransferFeeConfig, 166);
    data.writeUInt16LE(TransferFeeConfigLayout.span, 168);
    const fee = { epoch: 0n, maximumFee: 18446744073709551615n, transferFeeBasisPoints: taxBps };
    TransferFeeConfigLayout.encode({ transferFeeConfigAuthority: authority, withdrawWithheldAuthority: authority, olderTransferFee: fee, newerTransferFee: fee, withheldAmount: 0n }, data, 170);
  }
  return { owner: program, data, lamports: 1000000, executable: false };
}

function harness({ migrated = false, quoteIsA = false, reserveBase = 5000000000000n, reserveQuote = 10000000000n } = {}) {
  const [low, high] = [key(), key()].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
  const m = quoteIsA ? high : low, q = quoteIsA ? low : high;
  const w = key(), configId = key(), cpConfigId = key();
  const l = {
    keys: { wallet: { address: w.toBase58() }, mint: { address: m.toBase58() } },
    input: { route: 'raydium', network: 'mainnet-beta', feeMode: 'holders', taxBps: 400, creatorFeeBps: 50, quoteMint: q.toBase58() },
    review: { configId: configId.toBase58(), cpConfigId: cpConfigId.toBase58(), quoteProgram: TOKEN_PROGRAM_ID.toBase58(), quoteDecimals: 6 },
    credits: { base: '9000000000000', quote: '0' },
  };
  const accounts = new Map(), calls = [];
  const read = address => {
    calls.push(address.toBase58());
    return accounts.get(address.toBase58()) ?? null;
  };
  const c = new LaunchChain({ network: 'mainnet-beta', connection: {
    getAccountInfo: async address => read(address),
    getAccountInfoAndContext: async address => ({ context: { slot: 450000000 }, value: read(address) }),
    getMultipleAccountsInfo: async addresses => addresses.map(read),
    getMultipleAccountsInfoAndContext: async addresses => ({ context: { slot: 450000000 }, value: addresses.map(read) }),
    getTokenAccountBalance: async address => {
      const account = read(address);
      assert(account, 'requested token account must exist in the fixture');
      return { context: { slot: 450000000 }, value: { amount: AccountLayout.decode(account.data).amount.toString(), decimals: 6 } };
    },
    getSlot: async () => 450000000,
    getEpochInfo: async () => ({ epoch: 1041, absoluteSlot: 450000000 }),
  } });
  const a = c.addresses(l), cpKey = ray.getCpmmPdaPoolId(ray.CREATE_CPMM_POOL_PROGRAM, cpConfigId, low, high).publicKey;
  const cpVaultA = key(), cpVaultB = key(), curveVaultA = key(), curveVaultB = key();
  const curve = {
    creator: w, mintA: m, mintB: q, configId, platformId: a.platform,
    vaultA: curveVaultA, vaultB: curveVaultB, mintDecimalsA: 6, mintDecimalsB: 6,
    status: migrated ? 2 : 0, migrateType: 1, mintProgramFlag: 1,
    cpmmCreatorFeeOn: ray.CpmmCreatorFeeOn.OnlyTokenB,
    supply: bn('1000000000000000'), totalSellA: bn('800000000000000'), totalFundRaisingB: bn('20000000000'),
    virtualA: bn(reserveBase + 1000000000000n), realA: bn('1000000000000'),
    virtualB: bn(reserveQuote / 2n), realB: bn(reserveQuote - reserveQuote / 2n),
  };
  const cp = {
    configId: cpConfigId, poolCreator: w, mintA: low, mintB: high,
    vaultA: cpVaultA, vaultB: cpVaultB, observationId: key(),
    mintProgramA: quoteIsA ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID,
    mintProgramB: quoteIsA ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
    mintDecimalA: 6, mintDecimalB: 6, enableCreatorFee: true, feeOn: quoteIsA ? 1 : 2,
    protocolFeesMintA: bn('1000000'), fundFeesMintA: bn('2000000'), creatorFeesMintA: bn('3000000'),
    protocolFeesMintB: bn('4000000'), fundFeesMintB: bn('5000000'), creatorFeesMintB: bn('6000000'),
  };
  let currentBase = reserveBase, currentQuote = reserveQuote;
  function reset() {
    accounts.set(m.toBase58(), mintAccount(w, { taxBps: 400, program: TOKEN_2022_PROGRAM_ID }));
    accounts.set(q.toBase58(), mintAccount(w));
    accounts.set(a.pool.toBase58(), rayAccount(ray.LaunchpadPool, 'PoolState', curve));
    accounts.set(configId.toBase58(), rayAccount(ray.LaunchpadConfig, 'GlobalConfig', { mintB: q, curveType: 0, tradeFeeRate: bn(2500) }));
    accounts.set(a.platform.toBase58(), rayAccount(ray.PlatformConfig, 'PlatformConfig', { feeRate: bn(0), creatorFeeRate: bn(5000), cpConfigId, transferFeeExtensionAuth: w }));
    accounts.set(cpConfigId.toBase58(), rayAccount(ray.CpmmConfigInfoLayout, 'AmmConfig', { tradeFeeRate: bn(2500), creatorFeeRate: bn(500), protocolFeeRate: bn(120000), fundFeeRate: bn(40000) }, ray.CREATE_CPMM_POOL_PROGRAM));
    if (migrated) {
      accounts.set(cpKey.toBase58(), rayAccount(ray.CpmmPoolInfoLayout, 'PoolState', cp, ray.CREATE_CPMM_POOL_PROGRAM));
      const amountA = (quoteIsA ? currentQuote : currentBase) + BigInt(cp.protocolFeesMintA.add(cp.fundFeesMintA).add(cp.creatorFeesMintA).toString());
      const amountB = (quoteIsA ? currentBase : currentQuote) + BigInt(cp.protocolFeesMintB.add(cp.fundFeesMintB).add(cp.creatorFeesMintB).toString());
      accounts.set(cpVaultA.toBase58(), tokenAccount(low, ray.CREATE_CPMM_POOL_AUTH, amountA, cp.mintProgramA));
      accounts.set(cpVaultB.toBase58(), tokenAccount(high, ray.CREATE_CPMM_POOL_AUTH, amountB, cp.mintProgramB));
    }
  }
  reset();
  return { l, c, a, curve, cp, cpKey, accounts, calls, reset, setReserves(base, quote) { currentBase = base; currentQuote = quote; reset(); } };
}

test('tax batches cap a large backlog at 1,000,000 tokens instead of selling the full credit', () => {
  const plan = taxConversionAmount('9000000000000', '1000000000000000');
  assert.equal(BigInt(plan.amount), BATCH_LIMIT);
  assert(Number(plan.priceImpactBps) > 0 && Number(plan.priceImpactBps) <= 50);
  assert.equal(Number(plan.maxPriceImpactBps), 50);
});

test('one-million target fits a deep pool under the bounded impact policy', () => {
  const plan = taxConversionAmount('73419206851937', '598734261904415');
  assert.equal(BigInt(plan.amount), BATCH_LIMIT);
  assert.equal(plan.priceImpactBps, 34);
  assert.equal(plan.maxPriceImpactBps, 50);
});

test('thin pools reduce the batch to at most 0.25% of effective base reserves', () => {
  const plan = taxConversionAmount('9000000000000', '5000000000000');
  assert.equal(BigInt(plan.amount), 12500000000n);
  // A 0.25% input moves spot price approximately 0.4981%, independently of token tax.
  assert.equal(plan.priceImpactBps, 50);
});

test('tax batching never exceeds recorded credit, spendable base or tiny integer liquidity', () => {
  assert.equal(BigInt(taxConversionAmount('123', '5000000000000').amount), 123n);
  assert.equal(BigInt(taxConversionAmount('999999', '5000000000000', { availableBase: '17' }).amount), 17n);
  for (const [credit, reserve] of [['0', '5000000000000'], ['999999', '0'], ['999999', '399']]) {
    assert.equal(BigInt(taxConversionAmount(credit, reserve).amount), 0n);
  }
});

test('virtual quote liquidity cannot authorize a sale larger than the actual quote available', () => {
  const reserve = 5000000000000n, quote = 10000000000n;
  const plan = taxConversionAmount('9000000000000', reserve, { availableQuote: '10', quoteReserve: quote });
  const amount = BigInt(plan.amount);
  assert(amount > 0n && amount < 12500000000n);
  assert(amount * quote / (reserve + amount) <= 10n);
  assert.equal(BigInt(taxConversionAmount('9000000000000', reserve, { availableQuote: '0', quoteReserve: quote }).amount), 0n);
  assert.equal(BigInt(taxConversionAmount('1', reserve, { quoteReserve: '1' }).amount), 0n);
  assert.throws(() => taxConversionAmount('-1', reserve), /negative/i);
});

test('SDK-decoded bonding curve plans use virtual liquidity while respecting real quote available to sellers', async () => {
  const h = harness(), plan = await h.c.taxConversionPlan(h.l, '9000000000000');
  assert.equal(BigInt(plan.amount), 12500000000n);
  assert(Number(plan.priceImpactBps) <= 50);
  h.curve.realB = bn(0);h.reset();
  assert.equal(BigInt((await h.c.taxConversionPlan(h.l, '9000000000000')).amount), 0n);
});

for (const quoteIsA of [true, false]) {
  test(`deep CPMM pools prepare a one-million-token clip with quote on side ${quoteIsA ? 'A' : 'B'}`, async () => {
    const h = harness({ migrated: true, quoteIsA, reserveBase: 598734261904415n });
    const plan = await h.c.taxConversionPlan(h.l, h.l.credits.base);
    assert.equal(BigInt(plan.amount), BATCH_LIMIT);
    const instructions = await h.c.swapFeeInstructions(h.l, 'sell', plan.amount);
    assert.equal(instructions.at(-1).data.readBigUInt64LE(8), BATCH_LIMIT);
    await assert.rejects(h.c.swapFeeInstructions(h.l, 'sell', String(BATCH_LIMIT + 1n)), error => error.code === 'TAX_CONVERSION_DEFERRED');
  });

  test(`SDK-decoded CPMM tax planning handles quote token on sorted side ${quoteIsA ? 'A' : 'B'} and excludes fee counters`, async () => {
    const h = harness({ migrated: true, quoteIsA }), plan = await h.c.taxConversionPlan(h.l, '9000000000000');
    assert.equal(BigInt(plan.amount), 12500000000n);
    assert(Number(plan.priceImpactBps) <= 50);
    assert(h.calls.includes(h.cpKey.toBase58()));
    h.setReserves(0n, 10000000000n);
    assert.equal(BigInt((await h.c.taxConversionPlan(h.l, '9000000000000')).amount), 0n);
  });
}

test('a curve awaiting migration yields no tax sale until a tradable pool exists', async () => {
  const h = harness();h.curve.status = 1;h.reset();
  assert.equal(BigInt((await h.c.taxConversionPlan(h.l, '9000000000000')).amount), 0n);
});

test('direct fee-swap entry cannot bypass the batch and liquidity cap', async () => {
  for (const migrated of [false, true]) {
    const h = harness({ migrated });
    await assert.rejects(h.c.swapFeeInstructions(h.l, 'sell', '9000000000000'), error => error.code === 'TAX_CONVERSION_DEFERRED');
  }
});

test('tax planning rejects unearned credit and a pool belonging to another creator', async () => {
  const h = harness({ migrated: true });
  await assert.rejects(h.c.taxConversionPlan(h.l, '9000000000001'), /earned token credit/i);
  assert.equal(h.calls.length, 0);
  h.cp.poolCreator = key();h.reset();
  await assert.rejects(h.c.taxConversionPlan(h.l, '9000000000000'), /creator-fee policy/i);
});

test('CPMM swap pause and absent usable quote liquidity defer conversion', async () => {
  const h = harness({ migrated: true });
  h.cp.status = 4;h.reset();
  const paused=await h.c.taxConversionPlan(h.l, '9000000000000');
  assert.equal(BigInt(paused.amount), 0n);assert.equal(paused.waiting,true);
  assert.match(paused.reason,/swaps.*disabled/i);
  h.cp.status = 0;h.setReserves(5000000000000n, 0n);
  assert.equal(BigInt((await h.c.taxConversionPlan(h.l, '9000000000000')).amount), 0n);
});

test('a graduating curve reports a market wait rather than an unsellable dust balance', async () => {
  const h=harness();h.curve.status=1;h.reset();
  const plan=await h.c.taxConversionPlan(h.l,'9000000000000');
  assert.equal(plan.amount,'0');assert.equal(plan.waiting,true);assert.match(plan.reason,/graduation/i);
});

test('a small taxed curve sale uses the actual epoch and deducts quote transfer tax exactly once', async () => {
  const h = harness(), amount = 5000000000n;
  h.l.review.quoteProgram = TOKEN_2022_PROGRAM_ID.toBase58();
  h.curve.mintProgramFlag = 3;h.reset();
  const quoteMint = mintAccount(h.a.w, { taxBps: 100, program: TOKEN_2022_PROGRAM_ID });
  const fee = TransferFeeConfigLayout.decode(quoteMint.data, 170);
  fee.newerTransferFee = { ...fee.newerTransferFee, epoch: 2000n, transferFeeBasisPoints: 200 };
  TransferFeeConfigLayout.encode(fee, quoteMint.data, 170);
  h.accounts.set(h.a.q.toBase58(), quoteMint);
  // The SDK's slot approximation would choose the older fee; finalized epoch wins.
  h.c.c.getEpochInfo = async () => ({ epoch: 2000, absoluteSlot: 450000000 });
  const ixs = await h.c.swapFeeInstructions(h.l, 'sell', amount.toString());
  const ix = ixs.at(-1);
  assert(ix.programId.equals(ray.LAUNCHPAD_PROGRAM));
  assert.equal(ix.data.readBigUInt64LE(8), amount);
  const ceil = (n, d) => (n + d - 1n) / d;
  const netBase = amount - ceil(amount * 400n, 10000n);
  const grossQuote = netBase * 10000000000n / (5000000000000n + netBase);
  const afterTradingFees = grossQuote - ceil(grossQuote * 7500n, 1000000n);
  const expectedQuote = afterTradingFees - ceil(afterTradingFees * 200n, 10000n);
  assert.equal(ix.data.readBigUInt64LE(16), expectedQuote * 9975n / 10000n);
});

test('a reserve drop after planning is checked again before generating a sell instruction', async () => {
  for (const migrated of [false, true]) {
    const h = harness({ migrated }), read = h.c.c.getAccountInfo;
    let changed = false;
    h.c.c.getAccountInfo = async address => {
      if (!changed && address.equals(h.a.m)) {
        changed = true;
        if (migrated) h.setReserves(1000000n, 10000000000n);
        else { h.curve.virtualA = h.curve.realA.addn(1000000);h.reset(); }
      }
      return read(address);
    };
    await assert.rejects(h.c.swapFeeInstructions(h.l, 'sell', '5000000000'), error => error.code === 'TAX_CONVERSION_DEFERRED');
    assert.equal(changed, true);
  }
});


test('separate rewards swaps preserve Raydium creator identity on the curve and both CPMM mint orderings',async()=>{
  for(const options of [{},{migrated:true},{migrated:true,quoteIsA:true}]){
    const h=harness(options),creator=h.l.keys.wallet.address,rewards=newLaunchKeys().wallet;
    h.l.keys.rewards=rewards;h.l.rewardsWallet={version:1,status:'active',address:rewards.address};
    const selection={version:1,source:'rewards',address:rewards.address,signerSource:'rewards'},operation={kind:'sell',rewardsWallet:selection};
    const ixs=await h.c.swapFeeInstructions(h.l,'sell','5000000000',{operation}),swap=ixs.at(-1);
    assert.equal(swap.keys.find(k=>k.isSigner).pubkey.toBase58(),rewards.address);
    assert(!swap.keys.filter(k=>k.isSigner).some(k=>k.pubkey.toBase58()===creator));
    assert.equal(h.c.addresses(h.l).w.toBase58(),creator,'authority derivation stays original');
    if(!options.migrated){
      const oldVault=ray.getPdaCreatorVault(ray.LAUNCHPAD_PROGRAM,new PublicKey(creator),h.a.q).publicKey;
      const wrongVault=ray.getPdaCreatorVault(ray.LAUNCHPAD_PROGRAM,new PublicKey(rewards.address),h.a.q).publicKey;
      assert(swap.keys.some(k=>k.pubkey.equals(oldVault)));assert(!swap.keys.some(k=>k.pubkey.equals(wrongVault)));
    }else{
      h.cp.poolCreator=new PublicKey(rewards.address);h.reset();
      await assert.rejects(h.c.swapFeeInstructions(h.l,'sell','5000000000',{operation}),/creator-fee policy/i);
      h.cp.poolCreator=new PublicKey(creator);h.reset();
    }
    const invalid={kind:'sell',rewardsWallet:{...selection,address:key().toBase58()}};
    await assert.rejects(h.c.swapFeeInstructions(h.l,'sell','5000000000',{operation:invalid}),/no longer matches/);
  }
});


for(const quoteIsA of [true,false])test(`explicit backlog policy builds one exact ten-million CPMM sell on quote side ${quoteIsA?'A':'B'} while ordinary calls stay capped`,async()=>{
  const h=harness({migrated:true,quoteIsA,reserveBase:598734261904415n});h.l.credits.base='21000000000000';
  const options={policy:TAX_CONVERSION_BURST_POLICY},plan=await h.c.taxConversionPlan(h.l,TAX_CONVERSION_BACKLOG_UNITS.toString(),options);
  assert.equal(plan.amount,TAX_CONVERSION_BACKLOG_UNITS.toString());assert.equal(plan.maxPriceImpactBps,500);assert(plan.priceImpactBps<=500);
  const instructions=await h.c.swapFeeInstructions(h.l,'sell',plan.amount,{operation:{kind:'sell',taxConversionPolicy:TAX_CONVERSION_BURST_POLICY}});
  assert.equal(instructions.at(-1).data.readBigUInt64LE(8),TAX_CONVERSION_BACKLOG_UNITS);
  await assert.rejects(h.c.swapFeeInstructions(h.l,'sell',plan.amount),error=>error.code==='TAX_CONVERSION_DEFERRED');
  await assert.rejects(h.c.swapFeeInstructions(h.l,'sell',BATCH_LIMIT.toString(),{operation:{kind:'sell',taxConversionPolicy:TAX_CONVERSION_BURST_POLICY}}),/exactly 10,000,000/);
  h.setReserves(100000000000000n,10000000000n);
  const guarded=await h.c.taxConversionPlan(h.l,TAX_CONVERSION_BACKLOG_UNITS.toString(),options);assert(BigInt(guarded.amount)<TAX_CONVERSION_BACKLOG_UNITS);
  await assert.rejects(h.c.swapFeeInstructions(h.l,'sell',plan.amount,{operation:{kind:'sell',taxConversionPolicy:TAX_CONVERSION_BURST_POLICY}}),error=>error.code==='TAX_CONVERSION_DEFERRED');
});
