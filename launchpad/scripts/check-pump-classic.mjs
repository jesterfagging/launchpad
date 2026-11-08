// Pump.fun launch readiness check for operators. Read-only: it reads Pump's live
// global and fee configuration and the pairs Pump admits for new coins, quotes a
// dev buy, checks the pinned PumpSwap SDK surface the strategies use and, with
// --payer, simulates (never sends) the exact atomic launch transaction against
// current mainnet state using a funded address as the stand-in launch wallet.
// Nothing is signed with a real key, nothing is broadcast and no secret value is
// printed. Run with:
//   node scripts/check-pump-classic.mjs [/etc/launchpad.env] [--payer <funded address>] [--dev-buy 0.01]
//        [--quote <pair mint>] [--creator-fee <bps>] [--dev-buy-sol <SOL>] [--pairs] [--mint <Pump.fun coin to read>]
// --quote checks a launch on another pair. There --dev-buy is in the pair asset
// and the payer must hold it (or use --dev-buy 0): a real launch first buys that
// asset with the creator's SOL, which --dev-buy-sol checks (the SOL route Launchpad
// would use, read-only; with --payer the purchase is also simulated end to end from the
// payer and stopped before signing). --pairs lists every pair.
import { readFileSync } from 'node:fs';
import { launchpadEnv } from '../src/brand-env.mjs';
import { PumpClassicChain } from '../src/pump-classic/chain.mjs';
import { pumpClassicConfig, generateWallet, lamportsFromSol, rawFromAmount, amountText, sol } from '../src/pump-classic/service.mjs';
import { PUMP_CLASSIC_POLICY, PUMP_CLASSIC_POLICY_HASH, pairDevBuyInSol } from '../src/pump-classic/policy.mjs';
import { quoteLabel } from '../public/quote-identity.mjs';
import { coinAddresses } from '../src/pump-classic/instructions.mjs';
import { isAddress } from '../src/pump-classic/codec.mjs';

const args = process.argv.slice(2), flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const envFile = args.find((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--'));
let env = { ...process.env };
if (envFile) { for (const line of readFileSync(envFile, 'utf8').split('\n')) { const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (match && !line.trim().startsWith('#')) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2'); } }
let failed = 0;
const check = (condition, message) => { if (!condition) { failed++; console.error('FAIL ' + message); } else console.log('ok   ' + message); };
const note = message => console.log('     ' + message);

const config = pumpClassicConfig(env), rpcUrl = launchpadEnv('PUBLIC_RPC_URL', env);
console.log(`Pump.fun launch readiness (${envFile || 'process environment'})`);
check(config.enabled, 'LAUNCHPAD_PUMP_CLASSIC_ENABLED=1 (master switch)' + (config.enabled ? '' : ' - every Pump.fun route answers 503 until this is set'));
note(`policy ${PUMP_CLASSIC_POLICY.version} hash ${PUMP_CLASSIC_POLICY_HASH}`);
note('database ' + (config.dbPath || '<accounts dir>/pump-classic/pump-classic.sqlite') + ' · backups ' + (config.backupDir || '<accounts dir>/pump-classic/backups'));
check(!!rpcUrl, 'LAUNCHPAD_PUBLIC_RPC_URL set (a dedicated mainnet RPC; public endpoints rate-limit transaction simulation)');
if (!rpcUrl) { console.error(`\n${failed} check(s) failed.`); process.exit(1); }

const chain = new PumpClassicChain({ network: 'mainnet-beta', rpcUrl, rpcScope: 'pump-classic-check', jupiterKey: launchpadEnv('PUBLIC_JUPITER_KEY', env) || '' });
try {
  await chain.init(); check(true, 'RPC genesis hash is Solana mainnet');
  const g = await chain.readGlobals();
  check(g.global.create_v2_enabled === true, 'Pump global: initialized and create_v2 enabled (slot ' + g.slot + ')');
  note(`initial virtual SOL ${sol(g.global.initial_virtual_sol_reserves)} · virtual tokens ${g.global.initial_virtual_token_reserves} · real tokens ${g.global.initial_real_token_reserves} · supply ${g.global.token_total_supply}`);
  check(!!g.feeConfig, 'Pump fee configuration readable (dynamic fee tiers)');
  check(!!g.ammGlobalConfig && !!g.ammFeeConfig, 'PumpSwap global and fee configuration readable');
  note(`buyback share: ${g.global.buyback_basis_points ?? 0} bps of Pump's protocol fee (PumpSwap ${g.ammGlobalConfig?.buyback_basis_points ?? '?'} bps). It is part of the protocol fee, not charged on top; Pump allows at most 10000.`);
  // Pairs: SOL, Pump's listed quote and its custom pairs, with whether Launchpad can launch on and convert each.
  const live = await chain.pumpQuotes(), others = live.quotes.filter(q => q.kind !== 'sol');
  check(live.quotes[0]?.kind === 'sol', `Pump pairs readable: SOL + ${others.filter(q => q.kind === 'listed').length} listed + ${others.filter(q => q.kind === 'custom').length} custom`);
  note(`${others.filter(q => q.supported).length} of ${others.length} other pairs supported by Launchpad · ${others.filter(q => q.convertible).length} convertible to SOL (needed for Holders and Gotchi) · custom creator fee ${live.creatorFee.configurable ? 'up to ' + live.creatorFee.maxBps + ' bps' : 'not configurable now'}`);
  if (args.includes('--pairs')) for (const q of others) note(`${q.kind.padEnd(6)} ${q.mint} ${quoteLabel(q.mint, q.metadata?.symbol).padEnd(12)} decimals ${q.decimals ?? '?'} · ${q.supported ? 'supported' : 'unsupported: ' + q.reason} · ${q.convertible ? 'convertible' : 'not convertible'}`);
  const quoteMint = flag('--quote') || 'So11111111111111111111111111111111111111112', creatorFeeBps = BigInt(flag('--creator-fee') ?? '0');
  const asset = await chain.quoteAsset(quoteMint), symbol = asset.kind === 'sol' ? 'SOL' : quoteLabel(quoteMint, asset.metadata?.symbol);
  if (asset.kind !== 'sol') check(asset.supported === true, `pair ${symbol} (${asset.kind}) is handled exactly by Launchpad` + (asset.supported ? `: ${asset.program === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' ? 'SPL Token' : 'Token-2022'}, ${asset.decimals} decimals` : ' - ' + asset.reason));
  const devBuy = asset.kind === 'sol' ? lamportsFromSol(flag('--dev-buy') ?? '0.01', 'the dev buy') : rawFromAmount(flag('--dev-buy') ?? '0', asset.decimals, 'the dev buy', symbol);
  const quote = await chain.quoteLaunch({ devBuyRaw: devBuy, quoteMint, creatorFeeBps });
  check(quote.tokens > 0n || devBuy === 0n, `quote: ${amountText(devBuy, asset.decimals)} ${symbol} buys ${quote.tokens} raw tokens on a fresh curve (cost ${amountText(quote.costLamports, asset.decimals)} ${symbol}, fee ${quote.feeBps} bps)`);
  if (asset.kind !== 'sol') {
    const convertible = (await chain.conversionSupport([quoteMint])).get(quoteMint) === true;
    check(true, `${symbol} fees ${convertible ? 'can' : 'cannot yet'} be converted to SOL by the treasury route` + (convertible ? '' : ' - Holders, Gotchi and dev buys are unavailable on this pair'));
    // From policy v3 a dev buy on another pair is paid in SOL: Launchpad buys the pair asset through this route first.
    if (pairDevBuyInSol(PUMP_CLASSIC_POLICY) && flag('--dev-buy-sol')) {
      const guard = PUMP_CLASSIC_POLICY.pairDevBuy, lamports = lamportsFromSol(flag('--dev-buy-sol'), 'the SOL dev buy');
      try {
        const c = await chain.quoteDevBuyConversion({ quoteMint, program: asset.program, lamports, taker: flag('--payer') || generateWallet().address, slippageBps: guard.slippageBps, maxImpactBps: guard.maxImpactBps });
        const reviewed = BigInt(c.minimumRaw) * BigInt(10000 - guard.quoteDriftBps) / 10000n;
        check(true, `SOL route to ${symbol}: ${sol(lamports)} SOL buys about ${amountText(BigInt(c.expectedRaw), asset.decimals)} ${symbol}, at least ${amountText(BigInt(c.minimumRaw), asset.decimals)} after ${guard.slippageBps / 100}% slippage (a quote reviews ${amountText(reviewed, asset.decimals)})`);
        note(`the dev buy for that SOL on a fresh ${symbol} curve: about ${(await chain.quoteLaunch({ devBuyRaw: BigInt(c.expectedRaw), quoteMint, creatorFeeBps })).tokens} raw tokens`);
      } catch (error) { check(false, `SOL route to ${symbol} for a ${sol(lamports)} SOL dev buy (price impact at most ${guard.maxImpactBps / 100}%): ${error?.message || error}`); }
      // The purchase itself, read-only, with --payer standing in for the launch wallet: the route, the
      // finalized snapshot, the simulation and every limit run as for a launch. It is then stopped on
      // purpose at signing with a throwaway key that does not match the payer, so nothing can be signed or sent.
      const payer = flag('--payer');
      if (payer && isAddress(payer)) {
        const throwaway = generateWallet(), started = Date.now();
        try {
          await chain.prepareDevBuyConversion({ wallet: { address: payer, secret: throwaway.secret }, quote: { mint: quoteMint, program: asset.program }, lamports, minSolReserve: '0', maxNetworkCostLamports: guard.maxNetworkCostLamports, slippageBps: guard.slippageBps, maxImpactBps: guard.maxImpactBps });
          check(false, `SOL purchase of ${symbol}: the check did not stop before signing`);
        } catch (error) {
          const stopped = /The treasury signer does not match its wallet/.test(String(error?.message));
          check(stopped, stopped ? `SOL purchase of ${symbol} simulated end to end from the payer (route, finalized snapshot, simulation and limits in ${Math.round((Date.now() - started) / 1000)} s; stopped before signing)` : `SOL purchase of ${symbol} from the payer: ${error?.message || error}`);
        }
      }
    }
  }

  // The strategies build PumpSwap trades and liquidity with the pinned SDK.
  try {
    const sdk = await import('@pump-fun/pump-swap-sdk'), api = sdk.PUMP_AMM_SDK;
    const needed = ['decodePool', 'decodeGlobalConfig', 'decodeFeeConfig', 'buyInstructionsNoPool', 'sellInstructionsNoPool', 'depositBaseInput', 'depositQuoteInput', 'depositInstructionsInternal', 'withdrawInstructions'];
    const missing = needed.filter(name => typeof api?.[name] !== 'function');
    check(!missing.length && typeof sdk.OnlinePumpAmmSdk === 'function', 'PumpSwap SDK exposes the methods the strategies use' + (missing.length ? ' - missing ' + missing.join(', ') : ''));
  } catch (error) { check(false, 'PumpSwap SDK loads (' + error.message + ')'); }

  const payer = flag('--payer');
  if (payer) {
    check(isAddress(payer), '--payer is a Solana address');
    const addresses = { mint: generateWallet().address, developer: generateWallet().address, protocol: generateWallet().address, recipient: generateWallet().address };
    if (asset.kind !== 'sol') {
      // A launch on another pair first creates its pair accounts in a setup transaction.
      const setup = await chain.checkLaunchSetup({ payer, mint: addresses.mint, quoteMint, program: asset.program, devBuy: devBuy > 0n });
      check(setup.ok, `setup transaction on ${symbol}: ${setup.created} account(s) to create` + (setup.created ? `, ${setup.size} bytes, ${setup.unitsConsumed ?? '?'} compute units` : '') + (setup.ok ? '' : ' - ' + JSON.stringify(setup.error)));
      if (!setup.ok) for (const line of setup.logs || []) note(line);
    }
    const report = await chain.checkLaunch({ payer, devBuyLamports: devBuy, addresses, quoteMint, creatorFeeBps });
    if (asset.kind !== 'sol') note('the creation check below creates the dev buy\'s accounts inline (a real launch has them from the setup transaction) and delivers the tokens in a later transaction, so a pass leaves margin');
    note(`simulated atomic launch on ${symbol}: ${report.size} bytes, ${report.unitsConsumed ?? '?'} compute units, payer balance ${sol(report.payerLamports)} SOL`);
    check(report.size <= 4096, 'atomic launch fits the v1 transaction size limit');
    check(report.ok, 'atomic launch simulation: create_v2, fee sharing with admin revoked, dev buy, delivery and transfers match the expected effects' + (report.ok ? ` (spends ${sol(report.spentLamports)} SOL${asset.kind === 'sol' ? '' : ` and ${amountText(report.spentQuote, asset.decimals)} ${symbol}`})` : ' - ' + JSON.stringify(report.error)));
    if (!report.ok) for (const line of report.logs || []) note(line);
  } else note('skipped the launch simulation: pass --payer <address with at least 0.1 SOL> to simulate the exact atomic launch (nothing is signed or sent)');

  const mint = flag('--mint');
  if (mint) {
    const pair = asset.kind === 'sol' ? null : { mint: quoteMint, program: asset.program };
    const coin = await chain.readCoin(mint, { commitment: 'confirmed', quote: pair });
    check(coin.exists, `${mint} is a Pump.fun coin paired with ${symbol}`);
    if (coin.exists) {
      note(`venue ${coin.venue} · sharing ${coin.sharing ? coin.sharing.status + (coin.sharing.admin_revoked ? ', admin revoked' : ', admin NOT revoked') : 'not configured'} · pending creator fees ${amountText(coin.fees.total, asset.decimals)} ${symbol} (curve ${amountText(coin.fees.curve, asset.decimals)}, PumpSwap ${amountText(coin.fees.amm, asset.decimals)})`);
      check(coin.curve.creator === coinAddresses(mint, pair).sharingConfig || !coin.sharing, 'curve creator is the fee-sharing configuration (when fee sharing is used)');
    }
  }
} catch (error) {
  check(false, 'readiness check could not finish: ' + (error?.message || error));
} finally { chain.close?.(); }
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed. Nothing was signed or sent.');
process.exit(failed ? 1 : 0);
