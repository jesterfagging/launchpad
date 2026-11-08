import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import liquiditySdks from '../src/liquidity-sdks.cjs';
import { LiquidityAdapter, liquidityFeeTier } from '../src/liquidity.mjs';
import { SOL, PUMP_AMM } from '../src/core.mjs';
import { key1, mint } from './fixtures.mjs';

const mints = [new PublicKey(mint), new PublicKey(SOL)];
const owners = {
  'Meteora DLMM': 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  'Raydium CPMM': 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  'PumpSwap': PUMP_AMM,
  'Meteora DAMM v2': 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
};
const pool = venue => ({ id: key1.publicKey.toBase58(), venue, mints: mints.map(k => k.toBase58()), poolFeePpm: 0 });
function adapter(venue, sdks) {
  const a = new LiquidityAdapter({ c: { rpcUrl: 'https://rpc.example.com' } }, undefined, sdks);
  a.connection = { getAccountInfo: async () => ({ owner: new PublicKey(owners[venue]), data: Buffer.alloc(0) }) };
  return a;
}

test('LP management rates preserve exact tier boundaries and reject missing or malformed metadata', () => {
  for (const [poolRate, management] of [[0, 50], [499.999, 50], [500, 50], [500.001, 150], [3000, 150], [3000.001, 250], [1000000, 250]]) {
    assert.deepEqual(liquidityFeeTier(poolRate), { poolFeePpm: poolRate, managementFeePpm: management });
  }
  for (const value of [null, undefined, '', '500', NaN, Infinity, -1, 1000001]) assert.throws(() => liquidityFeeTier(value), /unavailable/);
});

test('DLMM uses the real SDK total fee including volatility and refreshes before each fee-bearing operation', async () => {
  const real = liquiditySdks.dlmm();
  let variable = 0, reads = 0;
  const a = adapter('Meteora DLMM', { dlmm: () => ({ create: async () => {
    reads++;
    return { lbPair: { tokenXMint: mints[0], tokenYMint: mints[1], activeId: 100, binStep: 25,
      parameters: { baseFactor: 2000, baseFeePowerFactor: 0, variableFeeControl: variable, filterPeriod: 30, decayPeriod: 600, reductionFactor: 5000, maxVolatilityAccumulator: 100000 },
      vParameters: { indexReference: 100, volatilityReference: 20000, volatilityAccumulator: 20000, lastUpdateTimestamp: new BN(Math.floor(Date.now() / 1000)) } },
      getDynamicFee: real.prototype.getDynamicFee };
  } }) });
  const p = pool('Meteora DLMM');
  assert.deepEqual(await a.feeTier(p), { poolFeePpm: 500, managementFeePpm: 50 });
  variable = 1;
  assert.deepEqual(await a.feeTier(p), { poolFeePpm: 500.003, managementFeePpm: 150 });
  assert.equal(reads, 2);
  assert.equal(p.poolFeePpm, 0, 'persisted fee metadata is never the billing authority');
});

test('pool owner and mint identity must match before computing an automatic fee', async () => {
  const a = adapter('Meteora DLMM', { dlmm: () => ({ create: async () => ({ lbPair: { tokenXMint: mints[1], tokenYMint: mints[0] } }) }) });
  await assert.rejects(a.feeTier(pool('Meteora DLMM')), /mints changed/);
  a.connection.getAccountInfo = async () => ({ owner: PublicKey.default });
  await assert.rejects(a.feeTier(pool('Meteora DLMM')), /program changed/);
  a.signal = AbortSignal.abort();
  await assert.rejects(a.feeTier(pool('Meteora DLMM')), /Stopped/);
});

test('Raydium reads config from RPC, adds an enabled creator fee, and does not add protocol shares again', async () => {
  let enabled = false;
  const a = adapter('Raydium CPMM', { raydium: () => ({
    CpmmPoolInfoLayout: { decode: () => ({ mintA: mints[0], mintB: mints[1], configId: key1.publicKey, enableCreatorFee: enabled }) },
    CpmmConfigInfoLayout: { decode: () => ({ tradeFeeRate: new BN(2500), creatorFeeRate: new BN(1000), protocolFeeRate: new BN(120000), fundFeeRate: new BN(40000) }) },
  }) });
  assert.deepEqual(await a.feeTier(pool('Raydium CPMM')), { poolFeePpm: 2500, managementFeePpm: 150 });
  enabled = true;
  assert.deepEqual(await a.feeTier(pool('Raydium CPMM')), { poolFeePpm: 3500, managementFeePpm: 250 });
});

test('PumpSwap uses quote-specific current SDK fee schedule and effective virtual reserves', async () => {
  let coinCreator = PublicKey.default, checked = false;
  const a = adapter('PumpSwap', { pump: () => ({
    OnlinePumpAmmSdk: class { async swapSolanaState() { return { globalConfig: {}, feeConfig: {}, pool: {
      baseMint: mints[0], quoteMint: mints[1], coinCreator, creator: key1.publicKey, virtualQuoteReserves: new BN(50), creatorFeeBps: new BN(10), isMayhemMode: false },
      baseMintAccount: { supply: 100000000n }, poolBaseAmount: new BN(1000), poolQuoteAmount: new BN(2000) }; } },
    computeFeesBps(args) {
      assert.equal(args.quoteMint, mints[1]); assert.equal(args.quoteReserve.toString(), '2050');
      assert.equal(args.creatorFeeBps.toString(), '10'); checked = true;
      return { lpFeeBps: new BN(25), protocolFeeBps: new BN(5), creatorFeeBps: new BN(10) };
    },
  }) });
  assert.deepEqual(await a.feeTier(pool('PumpSwap')), { poolFeePpm: 3000, managementFeePpm: 150 });
  coinCreator = key1.publicKey;
  assert.deepEqual(await a.feeTier(pool('PumpSwap')), { poolFeePpm: 4000, managementFeePpm: 250 });
  assert.equal(checked, true);
});

test('DAMM v2 uses current chain point and SDK numerator, and refuses size-dependent fee tiers', async () => {
  let mode = 0, currentTime = 200;
  const state = { tokenAMint: mints[0], tokenBMint: mints[1], activationType: 1, activationPoint: new BN(100), feeVersion: 1,
    poolFees: { baseFee: { baseFeeInfo: { data: [] } }, initSqrtPrice: new BN(1) }, sqrtPrice: new BN(2) };
  const a = adapter('Meteora DAMM v2', { damm: () => ({
    CpAmm: class { async fetchPoolState() { return state; } },
    BaseFeeMode: { RateLimiter: 2 }, ActivationType: { Slot: 0, Timestamp: 1 }, TradeDirection: { AtoB: 0 },
    getBaseFeeModeFromPodAlignedData: () => mode,
    getMaxFeeNumerator: version => { assert.equal(version, 1); return new BN(990000000); },
    getTotalTradingFeeFromIncludedFeeAmount: (fees, point) => {
      assert.equal(fees, state.poolFees); assert.equal(point.toString(), '200'); return new BN(3000001);
    },
  }) });
  a.connection.getSlot = async () => 500;
  a.connection.getBlockTime = async slot => { assert.equal(slot, 500); return currentTime; };
  assert.deepEqual(await a.feeTier(pool('Meteora DAMM v2')), { poolFeePpm: 3000.001, managementFeePpm: 250 });
  mode = 2;
  await assert.rejects(a.feeTier(pool('Meteora DAMM v2')), /size-dependent/);
  mode = 0; currentTime = null;
  await assert.rejects(a.feeTier(pool('Meteora DAMM v2')), /time is unavailable/);
});

test('missing fee metadata does not block inspecting or manually withdrawing an existing position', async () => {
  const ix = { name: 'withdraw' };
  const a = adapter('PumpSwap', { pump: () => ({
    OnlinePumpAmmSdk: class {
      async fetchPool() { return { baseMint: mints[0], quoteMint: mints[1], lpMint: key1.publicKey }; }
      async swapSolanaState() { throw Error('Fee lookup unavailable'); }
      async liquiditySolanaState() { return {}; }
    },
    PUMP_AMM_SDK: { withdrawInstructions: async () => [ix] },
  }) });
  const p = await a.inspect(key1.publicKey.toBase58(), { baseMint: mint, quoteMint: SOL }, key1.publicKey.toBase58());
  assert.equal(p.poolFeePpm, null);
  await assert.rejects(a.feeTier(p), /lookup unavailable/);
  const built = await a.build(p, { publicKey: key1.publicKey.toBase58() }, {}, { limits: { slippagePercent: 1 } }, { ...p, lpAmount: '10' });
  assert.deepEqual(built.instructions, [ix]);
});
