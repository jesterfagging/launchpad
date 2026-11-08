// Robinhood Chain launch readiness check for operators (v71.39). Read-only: it reads the configuration, the chain
// (chain id, head, fees), the factory as deployed (owner, switches, fee, platform recipient, the launch config the
// policy expects, which pair assets are approved), the pair list from Robinhood's stock-token API with live prices,
// ETH's price from the chain's own pools, and what one launch on each tier would cost. Nothing is signed, nothing is
// broadcast and no secret value is printed. Run with:
//   node scripts/check-robinhood.mjs [/etc/launchpad.env] [--pairs] [--tier 4k|20k] [--pair ETH|USDG|<symbol>]
import { readFileSync } from 'node:fs';
import { launchpadEnv } from '../src/brand-env.mjs';
import { robinhoodLaunchConfig } from '../src/robinhood-launch/service.mjs';
import { RobinhoodLaunchChain } from '../src/robinhood-launch/chain.mjs';
import { PairBook } from '../src/robinhood-launch/pairs.mjs';
import { ROBINHOOD_LAUNCH_POLICY, ROBINHOOD_LAUNCH_POLICY_HASH, fundingPlan, tierById } from '../src/robinhood-launch/policy.mjs';
import { curveForTargets, plannedSupply, tierTargetsInPair, unitsToUsd } from '../public/robinhood-curve-math.mjs';
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_NATIVE, robinhoodTier } from '../public/robinhood-launch-catalog.mjs';
import { formatUnits } from '../src/evm/hex.mjs';

const args = process.argv.slice(2), flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const envFile = args.find((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--'));
let env = { ...process.env };
if (envFile) { for (const line of readFileSync(envFile, 'utf8').split('\n')) { const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (match && !line.trim().startsWith('#')) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2'); } }
let failed = 0;
const check = (condition, message) => { if (!condition) { failed++; console.error('FAIL ' + message); } else console.log('ok   ' + message); };
const note = message => console.log('     ' + message);
const lower = v => String(v || '').toLowerCase();

const config = robinhoodLaunchConfig(env);
console.log(`Robinhood Chain launch readiness (${envFile || 'process environment'})`);
check(config.enabled, 'LAUNCHPAD_ROBINHOOD_LAUNCH_ENABLED=1 (master switch)' + (config.enabled ? '' : ' - every Robinhood route answers 503 until this is set'));
note(`policy ${ROBINHOOD_LAUNCH_POLICY.version} hash ${ROBINHOOD_LAUNCH_POLICY_HASH}`);
note('database ' + (config.dbPath || '<accounts dir>/robinhood-launch/robinhood-launch.sqlite') + ' · backups ' + (config.backupDir || '<accounts dir>/robinhood-launch/backups'));
for (const [key, name] of [['factory', 'LAUNCHPAD_RH_LAUNCH_FACTORY'], ['escrow', 'LAUNCHPAD_RH_FEE_ESCROW'], ['locker', 'LAUNCHPAD_RH_LAUNCH_LOCKER'], ['engine', 'LAUNCHPAD_RH_RULE_ENGINE'], ['payouts', 'LAUNCHPAD_RH_PAYOUTS'], ['router', 'LAUNCHPAD_RH_SWAP_ROUTER'], ['poolManager', 'LAUNCHPAD_RH_POOL_MANAGER (default: the official PoolManager)']]) check(!!config.addresses[key], `${name} set` + (config.addresses[key] ? ` (${config.addresses[key]})` : ''));
check(!!config.treasury, 'LAUNCHPAD_RH_TREASURY set (the platform share is swept there)' + (config.treasury ? ` (${config.treasury})` : ' - until it is set the platform wallet only claims'));
check(!!launchpadEnv('PUBLIC_URL', env), 'LAUNCHPAD_PUBLIC_URL set (coin metadata is served from it)');
note(`RPC ${config.rpcUrl}`);
if (!Object.values(config.addresses).every(Boolean)) { console.error(`\n${failed} check(s) failed.`); process.exit(1); }

// A loopback RPC (a local anvil with the stack deployed) is allowed for this check only; the service itself requires a public HTTPS endpoint.
const chain = RobinhoodLaunchChain.fromEnv({ rpcUrl: config.rpcUrl, addresses: config.addresses, policy: ROBINHOOD_LAUNCH_POLICY, log: () => {}, insecure: /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/.test(config.rpcUrl) });
try {
  const chainId = await chain.chainId(), head = await chain.blockNumber(), fees = await chain.feeData();
  check(chainId === ROBINHOOD_CHAIN_ID, `RPC answers for chain ${chainId} (Robinhood Chain is ${ROBINHOOD_CHAIN_ID}) · head ${head} · max fee ${formatUnits(fees.maxFeePerGas, 9, 4)} gwei`);
  const factory = await chain.factoryState(BigInt(ROBINHOOD_LAUNCH_POLICY.config.id));
  const p = ROBINHOOD_LAUNCH_POLICY.config, c = factory.config;
  // The fee shape (v71.41, Raydium's): the curve pool's platform and creator parts, the graduation pool's, the platform's share of a holder tax and the tax bounds.
  const FEE_KEYS = ['curveProtocolFeeBps', 'curveCreatorFeeBps', 'poolProtocolFeeBps', 'poolCreatorFeeBps', 'taxPlatformShareBps', 'minTaxBps', 'maxTaxBps', 'tickSpacing'];
  const pct = bps => (Number(bps) / 100) + '%';
  check(c.enabled && String(c.totalSupply) === p.totalSupply && FEE_KEYS.every(k => Number(c[k]) === Number(p[k])), `factory config ${p.id}: supply ${formatUnits(c.totalSupply, 18, 0)} · curve pool ${pct(c.curveProtocolFeeBps)} Launchpad + ${pct(c.curveCreatorFeeBps)} creator · graduation pool ${pct(c.poolProtocolFeeBps)} + ${pct(c.poolCreatorFeeBps)} · ${pct(c.taxPlatformShareBps)} of a holder tax to Launchpad · tax ${pct(c.minTaxBps)}–${pct(c.maxTaxBps)} · tick spacing ${c.tickSpacing}` + (c.enabled ? '' : ' · DISABLED') + (FEE_KEYS.every(k => Number(c[k]) === Number(p[k])) ? '' : ` · POLICY MISMATCH (expected ${FEE_KEYS.map(k => k + '=' + p[k]).join(', ')})`));
  check(factory.launchesOpen, 'launches open on the factory' + (factory.launchesOpen ? '' : ' (closed: the owner opens them from Admin → Robinhood Chain)'));
  check(lower(factory.escrow) === lower(config.addresses.escrow) && lower(factory.locker) === lower(config.addresses.locker) && lower(factory.ruleEngine) === lower(config.addresses.engine) && lower(factory.router) === lower(config.addresses.router) && lower(factory.poolManager) === lower(config.addresses.poolManager), 'the factory names the configured escrow, locker, rule engine, router and pool manager');
  check(factory.payoutsDeployed, 'LaunchPayouts deployed at LAUNCHPAD_RH_PAYOUTS');
  note(`owner ${factory.owner}${factory.pendingOwner && !/^0x0{40}$/.test(factory.pendingOwner) ? ' · pending owner ' + factory.pendingOwner : ''} · platform recipient ${factory.platformRecipient} · launch fee ${formatUnits(factory.launchFee, 18)} ETH · pool manager ${factory.poolManager}`);
  note('after the first start the host owner wallet must accept the factory ownership and become the platform recipient (Admin → Tokens → Robinhood Chain); fund both host wallets with a little ETH first');
  const book = new PairBook({ rpc: chain.rpc, policy: ROBINHOOD_LAUNCH_POLICY, ethUsdOverride: config.ethUsdOverride });
  const pairs = await book.pairs({ refresh: true });
  const eth = await book.priceUsd(ROBINHOOD_NATIVE);
  check(Number(eth.usd) > 0, `ETH price ${eth.usd} USD (${config.ethUsdOverride ? 'LAUNCHPAD_RH_ETH_USD override' : 'from the chain’s Uniswap pools'})`);
  const stocks = pairs.filter(x => x.kind !== 'native' && x.kind !== 'stable');
  check(pairs.some(x => x.kind === 'native') && pairs.some(x => x.kind === 'stable'), `pairs: ETH, USDG and ${stocks.length} tokenised stocks / ETFs from Robinhood's stock-token API`);
  let approved = 0;
  // Batched (50 reads per request): the public endpoint throttles a few hundred single reads.
  const assets = await chain.pairAssets(pairs.map(p => p.address));
  for (const [i, pair] of pairs.entries()) { const asset = assets[i]; if (asset.approved) approved++; if (args.includes('--pairs')) note(`${(pair.symbol || '?').padEnd(8)} ${pair.address} ${String(pair.kind).padEnd(7)} ${asset.approved ? 'approved' : 'not approved'}${pair.kind === 'native' || pair.kind === 'stable' ? '' : ' · $' + (await book.priceUsd(pair.address).catch(() => ({ usd: '?' }))).usd}`); }
  check(approved >= 2, `${approved} of ${pairs.length} pairs approved on the factory (ETH and USDG at least; stocks are approved from the admin panel)`);
  const tierId = flag('--tier') || '20k', tier = tierById(tierId) && robinhoodTier(tierId), symbol = (flag('--pair') || 'ETH').toUpperCase();
  const pair = pairs.find(x => (x.symbol || '').toUpperCase() === symbol); check(!!tier && !!pair, `tier ${tierId} on ${symbol}`);
  if (tier && pair) {
    const price = await book.priceUsd(pair.address), targets = tierTargetsInPair(tier, price.usd, pair.decimals), curve = curveForTargets(targets.startFdv, targets.graduationFdv), supply = plannedSupply(ROBINHOOD_LAUNCH_POLICY.config.totalSupply, curve.virtualQuote, curve.graduationQuote);
    note(`${tier.label} on ${pair.symbol} at $${price.usd}: virtual ${formatUnits(curve.virtualQuote, pair.decimals, 6)} ${pair.symbol} · raise ${formatUnits(curve.graduationQuote, pair.decimals, 6)} ${pair.symbol} (~$${unitsToUsd(curve.graduationQuote, price.usd, pair.decimals).toFixed(0)}) · sells ${formatUnits(supply.sellSupply, 18, 0)} · pool ${formatUnits(supply.lpSupply, 18, 0)}`);
    const onChain = await chain.pairAsset(pair.address);
    check(!onChain.approved || onChain.maxGraduationQuote === 0n || curve.graduationQuote >= onChain.minGraduationQuote && curve.graduationQuote <= onChain.maxGraduationQuote, `the ${tier.label} raise is inside the pair's approved range on the factory`);
    const plan = fundingPlan({ launchFeeWei: factory.launchFee, devBuyWei: 0n, pairIsEth: pair.kind === 'native', maxFeePerGas: fees.maxFeePerGas });
    note(`a creator funds about ${formatUnits(plan.totalWei, 18, 6)} ETH for a launch without a first buy (fee ${formatUnits(plan.launchFee, 18)} + gas budget ${formatUnits(plan.gasBudget, 18, 6)} + option wallet gas ${formatUnits(plan.feeWalletGas, 18)}); the unused part is refunded`);
  }
} catch (error) { check(false, 'chain reads: ' + String(error?.message || error).replace(/(?:https?|wss?):\/\/\S+/g, '[provider]')); }
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
