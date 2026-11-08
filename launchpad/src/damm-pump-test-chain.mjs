/** Owner-only micro-launch adapter. Production economics and deployment remain separate. */
import BN from 'bn.js';
import { SwapMode, Rounding, getAmountBFromLiquidityDeltaForConcentratedLiquidity } from '@meteora-ag/cp-amm-sdk';
import { DammPumpGraduationFeeAdapter, DAMM_PUMP_FEE_DEFAULTS } from './damm-pump-fee-chain.mjs';
import { DAMM_PUMP_ADMIN_TEST_POLICY, dammPumpAdminTestCurveAtGraduationTarget } from './damm-pump-admin-test-policy.mjs';
import { verifyDammPumpTestDeployment } from './damm-pump-test-deployment-service.mjs';

const bn = value => new BN(String(value));
const ensure = (condition, message) => { if (!condition) throw Object.assign(Error(message), {statusCode:409}); };
const ceilDiv = (n, d) => (n + d - 1n) / d;

export class DammPumpTestClientAdapter extends DammPumpGraduationFeeAdapter {
  constructor(options = {}) {
    super({...options, deploymentVerifier:options.deploymentVerifier || verifyDammPumpTestDeployment});
  }

  launchTerms(){return {policyVersion:DAMM_PUMP_ADMIN_TEST_POLICY.version,defaults:{...DAMM_PUMP_FEE_DEFAULTS,initialFdvUsd:50,graduationFdvUsd:100}};}

  model(launch) {
    return dammPumpAdminTestCurveAtGraduationTarget({
      quoteDecimals:launch.quoteDecimals, quoteUsdMicros:launch.priceSnapshot.quoteUsdMicros,
    });
  }

  async prepare(config, args) {
    const bundle = await super.prepare(config, args);
    return {...bundle, review:{...bundle.review, adminTest:true, initialFdvUsd:50,
      graduationFdvUsd:100, launchModeLabel:'Admin test · $50 → $100'}};
  }

  /** Return a reviewed input budget; PartialFill charges only the required input. */
  async buyToGraduationRaw(config, launch) {
    const saved = await this.rawState(config, launch, 'finalized');
    if (!saved.state || saved.state.phase === 2) return null;
    const snapshot = await this.dammSnapshot(config, launch, 'finalized', saved.slot);
    const pool = snapshot.pool;
    const current = BigInt(pool.sqrtPrice.toString()), maximum = BigInt(snapshot.state.sqrtMaxPrice);
    if (current >= maximum) return null;
    const net = BigInt(getAmountBFromLiquidityDeltaForConcentratedLiquidity(
      bn(current), bn(maximum), pool.liquidity, Rounding.Up,
    ).toString());
    // Fixed 125 bps fee is verified by dammSnapshot. Two raw units cover integer
    // fee/price rounding; the SDK must independently prove the endpoint is reached.
    const budget = ceilDiv(net * 10000n, 9875n) + 2n;
    ensure(net > 0n && budget < (1n << 64n), 'The remaining graduation buy is outside the supported range.');
    const quote = this.cp.getQuote2({inputTokenMint:snapshot.addresses.quoteMint,
      slippage:0, currentPoint:bn(pool.activationType === 0 ? snapshot.slot : Math.floor(this.now()/1000)),
      poolState:pool, tokenADecimal:6, tokenBDecimal:launch.quoteDecimals, hasReferral:false,
      swapMode:SwapMode.PartialFill, amountIn:bn(budget)});
    ensure(BigInt(quote.nextSqrtPrice.toString()) === maximum
      && BigInt(quote.includedFeeInputAmount.toString()) > 0n
      && BigInt(quote.includedFeeInputAmount.toString()) <= budget
      && BigInt(quote.outputAmount.toString()) > 0n,
    'The remaining buy could not be verified against the graduation endpoint.');
    return budget.toString();
  }
}
