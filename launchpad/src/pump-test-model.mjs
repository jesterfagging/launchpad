/**
 * Admin-only PumpSwap research model. This module creates no transactions,
 * wallets or onchain custody. Its migration result is arithmetic, not proof of
 * a pool being created or its LP tokens being burned.
 */
const U64_MAX = (1n << 64n) - 1n;
const BPS = 10000n;
const ROOT_SCALE = 1000000000000000000n;
const USD_SCALE = 1000000n;
const PRESETS = Object.freeze({standard:Object.freeze({start:20000n * USD_SCALE, graduation:50000n * USD_SCALE}), 'micro-test':Object.freeze({start:100n * USD_SCALE, graduation:500n * USD_SCALE})});
const SUPPLY = 1000000000n * 1000000n;
const MAX_QUOTE_USD_MICROS = 1000000000n * USD_SCALE;
const states = new WeakSet();
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const ceilDiv = (a, b) => { ensure(b > 0n, 'Division by zero.'); return (a + b - 1n) / b; };
const abs = n => n < 0n ? -n : n;

function uint(value, label, max = U64_MAX) {
  ensure(typeof value === 'string' || typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value)), `Invalid ${label}.`);
  const text = String(value);
  ensure(text.length <= 24 && /^(0|[1-9]\d*)$/.test(text), `Invalid ${label}.`);
  const result = BigInt(text);
  ensure(result <= max, `${label} exceeds the supported range.`);
  return result;
}
function bps(value, name, max) {
  ensure(Number.isInteger(value) && value >= 0 && value <= max, `${name} must be an integer between 0 and ${max}.`);
  return value;
}
function sqrt(n) {
  ensure(n >= 0n, 'Negative square root.');
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (let i = 0; i < 256; i++) {
    const next = (x + n / x) / 2n;
    if (next >= x) return x;
    x = next;
  }
  throw new Error('Launchpad square root did not converge.');
}
function format(raw, decimals) {
  if (decimals === 0) return raw.toString();
  const scale = 10n ** BigInt(decimals);
  return `${raw / scale}.${String(raw % scale).padStart(decimals, '0')}`;
}
function config(input) {
  ensure(input && typeof input === 'object' && !Array.isArray(input), 'A model configuration is required.');
  const preset = input.preset ?? 'standard';
  ensure(typeof preset === 'string' && Object.hasOwn(PRESETS, preset), 'Preset must be standard or micro-test.');
  ensure(input.startingFdvUsd === undefined && input.graduationFdvUsd === undefined && input.startUsd === undefined && input.graduationUsd === undefined, 'Arbitrary FDV targets are not supported.');
  const price = uint(input.quoteUsdMicros ?? input.solUsdMicros, 'Quote/USD snapshot', MAX_QUOTE_USD_MICROS);
  ensure(price > 0n, 'Quote/USD snapshot must be positive.');
  const quoteDecimals = input.quoteDecimals ?? 9;
  ensure(Number.isInteger(quoteDecimals) && quoteDecimals >= 0 && quoteDecimals <= 18, 'Quote decimals must be an integer between 0 and 18.');
  const quoteSymbol = input.quoteSymbol ?? 'SOL';
  ensure(typeof quoteSymbol === 'string' && quoteSymbol.trim().length > 0 && [...quoteSymbol].length <= 32 && !/[\u0000-\u001f\u007f-\u009f]/u.test(quoteSymbol), 'Invalid quote symbol.');
  const quoteMint = input.quoteMint ?? null;
  ensure(quoteMint === null || typeof quoteMint === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(quoteMint), 'Invalid quote mint.');
  if (input.quoteUsdMicros != null && input.solUsdMicros != null) ensure(String(input.quoteUsdMicros) === String(input.solUsdMicros), 'Conflicting USD snapshots.');
  return Object.freeze({preset, graduationFeeBps:bps(input.graduationFeeBps, 'Graduation fee', 3000), tradeFeeBps:bps(input.tradeFeeBps, 'Trading fee', 300), quoteUsdMicros:price.toString(), quoteDecimals, quoteSymbol, quoteMint});
}
function derive(input) {
  const cfg = config(input), price = BigInt(cfg.quoteUsdMicros), quoteScale = 10n ** BigInt(cfg.quoteDecimals);
  const {start:startUsdTarget, graduation:graduationUsdTarget} = PRESETS[cfg.preset];
  // Ideal continuous model: k=sqrt(G/S), Q=G/(1+k-f), A/N=k/(1+k-f).
  // Virtual base B=A*k/(k-1). Fix integer B,V,A and calculate the exact
  // minimum quote required to reach A. Each subsequent trade rounds against
  // the trader; terminal price errors below include that initial rounding.
  const k = sqrt(graduationUsdTarget * ROOT_SCALE * ROOT_SCALE / startUsdTarget);
  const denominator = (BPS * (ROOT_SCALE + k) - BigInt(cfg.graduationFeeBps) * ROOT_SCALE) * (k - ROOT_SCALE);
  const virtualBase = SUPPLY * k * k * BPS / denominator;
  const virtualQuote = startUsdTarget * quoteScale * virtualBase / (price * SUPPLY);
  const sell = virtualBase * (k - ROOT_SCALE) / k;
  ensure(virtualBase > sell && sell > 0n && sell < SUPPLY && virtualQuote > 0n, 'Invalid derived curve reserves.');
  const raise = ceilDiv(virtualQuote * sell, virtualBase - sell);
  const graduationFee = ceilDiv(raise * BigInt(cfg.graduationFeeBps), BPS);
  const lpQuote = raise - graduationFee, lpBase = SUPPLY - sell;
  for (const n of [virtualBase, virtualQuote, virtualQuote + raise, sell, raise, lpQuote, lpBase]) ensure(n > 0n && n <= U64_MAX, 'Derived reserves exceed the supported range.');
  ensure(graduationFee >= 0n && graduationFee <= U64_MAX, 'Derived fee exceeds the supported range.');
  const startUsd = SUPPLY * virtualQuote * price / (virtualBase * quoteScale);
  const curveEndUsd = SUPPLY * (virtualQuote + raise) * price / ((virtualBase - sell) * quoteScale);
  const poolOpeningUsd = SUPPLY * lpQuote * price / (lpBase * quoteScale);
  // Fail closed if a supplied price cannot represent either target within 1 ppm.
  ensure(abs(startUsd - startUsdTarget) * 1000000n <= startUsdTarget && abs(poolOpeningUsd - graduationUsdTarget) * 1000000n <= graduationUsdTarget, 'Insufficient integer precision for the requested targets.');
  return {config:cfg, price, quoteScale, startUsdTarget, graduationUsdTarget, virtualBase, virtualQuote, sell, raise, graduationFee, lpQuote, lpBase, startUsd, curveEndUsd, poolOpeningUsd};
}

/** All preview fields are JSON safe. USD amounts are snapshot estimates. */
export function previewPumpTestModel(input) {
  const m = derive(input), usd = n => n * m.price / m.quoteScale;
  const netUsd = usd(m.lpQuote);
  return {
    mode:'admin-pumpswap-research', execution:'model-only', network:'none', ...m.config,
    tokenDecimals:6, totalSupplyTokens:'1000000000', totalSupplyRaw:SUPPLY.toString(),
    startingFdvUsd:format(m.startUsdTarget, 6), graduationFdvUsd:format(m.graduationUsdTarget, 6),
    virtualBaseRaw:m.virtualBase.toString(), virtualQuoteRaw:m.virtualQuote.toString(),
    tokensSoldAtGraduationRaw:m.sell.toString(), tokensForPoolRaw:m.lpBase.toString(),
    grossQuoteRaw:m.raise.toString(), graduationFeeRaw:m.graduationFee.toString(), netQuoteRaw:m.lpQuote.toString(),
    grossQuote:format(m.raise, m.config.quoteDecimals), graduationFeeQuote:format(m.graduationFee, m.config.quoteDecimals), netQuote:format(m.lpQuote, m.config.quoteDecimals),
    grossQuoteUsd:format(usd(m.raise), 6), graduationFeeUsd:format(usd(m.graduationFee), 6),
    quoteInPoolUsd:format(netUsd, 6), tokensInPoolUsd:format(netUsd, 6), totalLpUsd:format(netUsd * 2n, 6),
    actualStartingFdvUsd:format(m.startUsd, 6), actualCurveEndFdvUsd:format(m.curveEndUsd, 6), actualPoolOpeningFdvUsd:format(m.poolOpeningUsd, 6),
    openingFdvErrorUsdMicros:(m.poolOpeningUsd - m.graduationUsdTarget).toString(),
    ...(m.config.quoteSymbol === 'SOL' && m.config.quoteDecimals === 9 ? {solUsdMicros:m.config.quoteUsdMicros, virtualQuoteLamports:m.virtualQuote.toString(), grossQuoteLamports:m.raise.toString(), graduationFeeLamports:m.graduationFee.toString(), netQuoteLamports:m.lpQuote.toString(), grossQuoteSol:format(m.raise,9), graduationFeeSol:format(m.graduationFee,9), netQuoteSol:format(m.lpQuote,9)} : {}),
    lpBurnVerified:false, assumption:'Fixed quote/USD snapshot. Excludes setup, network and external venue fees. Trading fees are separate from curve reserves. No pool or LP burn is executed.'
  };
}

function makeState(raw) {
  for (const [name, value] of Object.entries(raw)) if (typeof value === 'bigint') { ensure(value >= 0n && value <= U64_MAX, `${name} exceeds u64.`); raw[name] = value.toString(); }
  const frozen = Object.freeze(raw); states.add(frozen); return frozen;
}
function verified(state) { ensure(states.has(state), 'Unrecognized model state. Create a fresh simulation.'); }
function n(state, key) { return BigInt(state[key]); }

/** Immutable in-memory simulation only. Accounted reserves exclude rent/donations. */
export function createPumpTestSimulation(input, {rentQuoteRaw = '0'} = {}) {
  const m = derive(input), rent = uint(rentQuoteRaw, 'Rent');
  return makeState({mode:'model-only', config:m.config, status:'bonding', supplyRaw:SUPPLY,
    initialVirtualBaseRaw:m.virtualBase, initialVirtualQuoteRaw:m.virtualQuote,
    virtualBaseRaw:m.virtualBase, virtualQuoteRaw:m.virtualQuote,
    tokensSoldRaw:0n, graduationTokensSoldRaw:m.sell, custodyBaseRaw:SUPPLY,
    accountedQuoteRaw:0n, custodyQuoteRaw:rent, rentQuoteRaw:rent, donatedQuoteRaw:0n,
    totalBuyGrossQuoteRaw:0n, totalSellPaidQuoteRaw:0n, tradeFeesQuoteRaw:0n,
    graduationFeeRaw:0n, poolQuoteRaw:0n, poolBaseRaw:0n,
    lpBurnVerified:false, trades:0});
}

export function donatePumpTestQuote(state, amount) {
  verified(state); const donation = uint(amount, 'Donation');
  return makeState({...state, custodyQuoteRaw:n(state,'custodyQuoteRaw') + donation, donatedQuoteRaw:n(state,'donatedQuoteRaw') + donation});
}

/** Buy amount is gross quote raw units; sell amount is exact base token raw units. */
export function simulatePumpTestTrade(state, {side, amount} = {}) {
  verified(state); ensure(state.status === 'bonding' || state.status === 'ready' && side === 'sell', 'This model has finished bonding.');
  const input = uint(amount, 'Trade amount'); ensure(input > 0n, 'Trade amount must be positive.');
  const feeBps = BigInt(state.config.tradeFeeBps), vb=n(state,'virtualBaseRaw'), vq=n(state,'virtualQuoteRaw');
  const sold=n(state,'tokensSoldRaw'), accounted=n(state,'accountedQuoteRaw');
  let next, result;
  if (side === 'buy') {
    const remaining = n(state,'graduationTokensSoldRaw') - sold;
    const budgetNet = input * (BPS - feeBps) / BPS;
    let tokens = vb * budgetNet / (vq + budgetNet);
    if (tokens >= remaining) tokens = remaining;
    ensure(tokens > 0n, 'Trade is too small after integer rounding.');
    // Charge only the minimum input needed for the actual integer output.
    // This also returns quote rounding dust on ordinary, non-final buys.
    const net = ceilDiv(vq * tokens, vb - tokens);
    const charged = ceilDiv(net * BPS, BPS - feeBps);
    ensure(net > 0n && charged <= input, 'Insufficient quote for the requested output.');
    const fee=charged-net, refund=input-charged, totalSold=sold+tokens;
    next=makeState({...state, virtualBaseRaw:vb-tokens, virtualQuoteRaw:vq+net,
      tokensSoldRaw:totalSold, custodyBaseRaw:n(state,'custodyBaseRaw')-tokens,
      accountedQuoteRaw:accounted+net, custodyQuoteRaw:n(state,'custodyQuoteRaw')+net,
      totalBuyGrossQuoteRaw:n(state,'totalBuyGrossQuoteRaw')+charged,
      tradeFeesQuoteRaw:n(state,'tradeFeesQuoteRaw')+fee,
      status:totalSold === n(state,'graduationTokensSoldRaw')?'ready':'bonding', trades:state.trades+1});
    result={side, requestedQuoteRaw:input.toString(), chargedQuoteRaw:charged.toString(), refundQuoteRaw:refund.toString(), feeQuoteRaw:fee.toString(), reserveCreditQuoteRaw:net.toString(), tokensOutRaw:tokens.toString()};
  } else if (side === 'sell') {
    ensure(input <= sold, 'Cannot sell more tokens than this curve has issued.');
    const gross = vq * input / (vb + input);
    const fee = ceilDiv(gross * feeBps, BPS), paid = gross-fee;
    ensure(gross > 0n && paid > 0n, 'Trade is too small after integer rounding.');
    ensure(gross <= accounted, 'Insufficient accounted quote reserves.');
    next=makeState({...state, virtualBaseRaw:vb+input, virtualQuoteRaw:vq-gross,
      tokensSoldRaw:sold-input, custodyBaseRaw:n(state,'custodyBaseRaw')+input,
      accountedQuoteRaw:accounted-gross, custodyQuoteRaw:n(state,'custodyQuoteRaw')-gross,
      totalSellPaidQuoteRaw:n(state,'totalSellPaidQuoteRaw')+paid,
      tradeFeesQuoteRaw:n(state,'tradeFeesQuoteRaw')+fee, status:'bonding', trades:state.trades+1});
    result={side, tokensInRaw:input.toString(), reserveDebitQuoteRaw:gross.toString(), paidQuoteRaw:paid.toString(), feeQuoteRaw:fee.toString()};
  } else throw new Error('Trade side must be buy or sell.');
  assertPumpTestConservation(next);
  return {state:next, result:Object.freeze(result)};
}

/** Idempotent modeled allocation. Does not create/burn actual PumpSwap LP. */
export function simulatePumpTestMigration(state) {
  verified(state);
  if (state.status === 'migrated') return {state, alreadyMigrated:true, lpBurnVerified:false};
  ensure(state.status === 'ready', 'The model has not reached graduation.');
  const quote=n(state,'accountedQuoteRaw'), fee=ceilDiv(quote*BigInt(state.config.graduationFeeBps),BPS);
  const poolQuote=quote-fee, poolBase=n(state,'custodyBaseRaw');
  ensure(poolQuote > 0n && poolBase > 0n, 'Empty modeled migration reserves.');
  const next=makeState({...state,status:'migrated',accountedQuoteRaw:0n,
    custodyQuoteRaw:n(state,'custodyQuoteRaw')-quote,custodyBaseRaw:0n,
    graduationFeeRaw:fee,poolQuoteRaw:poolQuote,poolBaseRaw:poolBase});
  assertPumpTestConservation(next);
  return {state:next, alreadyMigrated:false, lpBurnVerified:false};
}

export function assertPumpTestConservation(state) {
  verified(state);
  ensure(n(state,'custodyQuoteRaw') === n(state,'rentQuoteRaw')+n(state,'donatedQuoteRaw')+n(state,'accountedQuoteRaw'), 'Custody contains unaccounted quote.');
  ensure(n(state,'custodyBaseRaw')+n(state,'tokensSoldRaw')+n(state,'poolBaseRaw') === SUPPLY, 'Token conservation failed.');
  ensure(n(state,'totalBuyGrossQuoteRaw') === n(state,'totalSellPaidQuoteRaw')+n(state,'tradeFeesQuoteRaw')+n(state,'accountedQuoteRaw')+n(state,'graduationFeeRaw')+n(state,'poolQuoteRaw'), 'Quote conservation failed.');
  ensure(n(state,'tokensSoldRaw') <= n(state,'graduationTokensSoldRaw'), 'Launchpad oversold its launch allocation.');
  ensure(n(state,'virtualBaseRaw') === n(state,'initialVirtualBaseRaw')-n(state,'tokensSoldRaw'), 'Virtual base accounting failed.');
  const cumulativeReserve=n(state,'accountedQuoteRaw')+n(state,'graduationFeeRaw')+n(state,'poolQuoteRaw');
  ensure(n(state,'virtualQuoteRaw') === n(state,'initialVirtualQuoteRaw')+cumulativeReserve, 'Virtual quote accounting failed.');
  ensure(n(state,'virtualBaseRaw')*n(state,'virtualQuoteRaw') >= n(state,'initialVirtualBaseRaw')*n(state,'initialVirtualQuoteRaw'), 'Constant product decreased.');
  return true;
}
