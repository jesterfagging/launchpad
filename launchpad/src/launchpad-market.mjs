import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint, getExtensionTypes } from '@solana/spl-token';
import { quoteLabel } from '../public/quote-identity.mjs';
import { quoteMetadataFromMint } from './launchpad-quote-metadata.mjs';
import { displayUnits, requireValue as ok } from '../public/launchpad-model.mjs';

const QUOTE_TTL = 60000;
const number = value => {
  const n = Number(value);
  ok(Number.isFinite(n) && n >= 0, 'The launch market returned an invalid amount.');
  return n;
};
const amount = (value, decimals) => number(displayUnits(value.toString(), decimals));
const validReference = (ref, mint) => ref && (!ref.mint || ref.mint === mint) &&
  (typeof ref.usd === 'number' || typeof ref.usd === 'string' && ref.usd.trim() !== '') &&
  Number.isFinite(Number(ref.usd)) && Number(ref.usd) > 0 && Number(ref.usd) < 1e9;
const freshReference = (ref, mint, now) => validReference(ref, mint) && ref.stale !== true &&
  Number.isSafeInteger(ref.at) && ref.at > 0 && ref.at <= now && now - ref.at <= QUOTE_TTL;

function mintInfo(key, account) {
  ok(account && !account.executable && [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(owner => owner.equals(account.owner)), 'The launch market mint has the wrong program owner.');
  const mint = unpackMint(key, account, account.owner);
  ok(mint.isInitialized && mint.decimals <= 12, 'The launch market mint is not initialized or has unsupported decimals.');
  return {key, program:account.owner, mint, extensions:getExtensionTypes(mint.tlvData)};
}

async function quoteReferenceFor(launch, mint, provided, lookup) {
  const now = Date.now(), address = mint.key.toBase58();
  if (provided?.mint === address && freshReference(provided, address, now)) return {...provided, stale:false};
  // Null explicitly requests a quote-native snapshot. A background feed can
  // refresh the reference separately without holding an account read open.
  if (provided !== null) {
    let timeout;
    try {
      const result = await Promise.race([
        lookup(launch.input, mint),
        new Promise(resolve => { timeout = setTimeout(() => resolve(null), 1200); }),
      ]);
      if (freshReference(result, address, Date.now())) return {...result, stale:false};
    } catch { /* A missing USD reference must not hide the onchain market. */ }
    finally { clearTimeout(timeout); }
  }
  const previous = provided?.mint === address && validReference(provided, address) ? provided : launch.review?.price;
  return validReference(previous, address)
    ? {usd:Number(previous.usd), at:Number.isSafeInteger(previous.at) && previous.at > 0 ? previous.at : 0, source:String(previous.source || 'Launch review reference').slice(0,120), stale:true}
    : {usd:null, at:0, source:'Unavailable', stale:true};
}

/** Read-only, same-slot market values. Numbers are display approximations;
 * transaction building continues to use integer token amounts elsewhere. */
export async function readLaunchMarketSnapshot({connection, addresses, ray, decodeRay, referencePrice}, launch, {quoteReference} = {}) {
  const {m, q, pool, platform, w, program} = addresses;
  ok(launch.input?.network === 'mainnet-beta' && launch.input?.route === 'raydium', 'This launch market is not on Solana mainnet.');
  const expectedPool = ray.getPdaLaunchpadPoolId(program, m, q), configKey = new PublicKey(launch.review.configId);
  ok(expectedPool.publicKey.equals(pool) && (!launch.curve || launch.curve === pool.toBase58()), 'The launch curve address does not match this token.');
  const response = await connection.getMultipleAccountsInfoAndContext([pool, m, q, configKey], {commitment:'confirmed'});
  ok(Number.isSafeInteger(response?.context?.slot) && response.context.slot >= 0 && Array.isArray(response.value) && response.value.length === 4, 'The launch market RPC returned an invalid snapshot.');
  const [poolAccount, baseAccount, quoteAccount, configAccount] = response.value;
  ok(!poolAccount?.executable && !configAccount?.executable, 'The launch market contains an invalid executable account.');
  const state = decodeRay(poolAccount, program, ray.LaunchpadPool, 'PoolState');
  const config = decodeRay(configAccount, program, ray.LaunchpadConfig, 'GlobalConfig');
  ok(state.mintA.equals(m) && state.mintB.equals(q) && state.configId.equals(configKey) && state.platformId.equals(platform) && state.creator.equals(w), 'The launch curve belongs to a different token or launch.');
  // The SDK names this `bump`, but Raydium stores `auth_bump`: the shared
  // vault authority bump. The pool address itself is verified separately above.
  ok(state.bump === ray.getPdaLaunchpadAuth(program).nonce && config.curveType === 0 && config.mintB.equals(q) && ray.getPdaLaunchpadConfigId(program, q, config.curveType, config.index).publicKey.equals(configKey), 'The launch curve configuration does not match this pair.');
  ok(state.vaultA.equals(ray.getPdaLaunchpadVaultId(program, pool, m).publicKey) && state.vaultB.equals(ray.getPdaLaunchpadVaultId(program, pool, q).publicKey), 'The launch curve vault addresses do not match this pair.');
  ok(['supply','totalSellA','totalFundRaisingB','virtualA','virtualB'].every((key, index) => state[key].toString() === String(launch.review[['supply','sell','raise','virtualBase','virtualQuote'][index]])), 'The launch curve terms differ from this launch.');
  ok([0,1,2].includes(state.status), 'The launch curve has an unsupported status.');
  const base = mintInfo(m, baseAccount), quoteMint = mintInfo(q, quoteAccount);
  ok(base.mint.decimals === 6 && state.mintDecimalsA === base.mint.decimals && state.mintDecimalsB === quoteMint.mint.decimals && quoteMint.mint.decimals === launch.review.quoteDecimals && quoteMint.program.toBase58() === launch.review.quoteProgram, 'The launch market token decimals or program do not match this launch.');
  ok(base.mint.supply <= BigInt(state.supply.toString()), 'The launch market supply exceeds its original supply.');
  ok(state.virtualA.gt(state.realA) && state.virtualB.gtn(0) && state.totalFundRaisingB.gtn(0) && state.realA.lte(state.totalSellA), 'The launch curve contains invalid reserves.');

  const status = ['curve','migrating','migrated'][state.status];
  // Once migration starts these reserves stop describing a tradable market.
  // Do not extend their final price as though it were a live AMM quote.
  const priceQuote = status === 'curve' ? number(ray.Launchpad.getPrice({poolInfo:state, curveType:config.curveType, decimalA:base.mint.decimals, decimalB:quoteMint.mint.decimals}).toString()) : null;
  const supply = amount(base.mint.supply, base.mint.decimals);
  const fdvQuote = priceQuote === null ? null : number(priceQuote * supply);
  const raisedQuote = amount(state.realB, quoteMint.mint.decimals), targetQuote = amount(state.totalFundRaisingB, quoteMint.mint.decimals);
  const ref = await quoteReferenceFor(launch, quoteMint, quoteReference, referencePrice);
  const quote = {mint:q.toBase58(), symbol:quoteLabel(q.toBase58(),quoteMetadataFromMint(q.toBase58(),quoteAccount)?.symbol,launch.review?.quoteSymbol), usd:ref.usd === null ? null : Number(ref.usd), at:ref.at, source:String(ref.source || 'Live market reference').slice(0,120), stale:ref.stale};
  const priceUsd = priceQuote !== null && !quote.stale ? number(priceQuote * quote.usd) : null;
  const fdvUsd = fdvQuote !== null && !quote.stale ? number(fdvQuote * quote.usd) : null;
  return {mint:m.toBase58(), curve:pool.toBase58(), status, at:Date.now(), slot:response.context.slot, priceQuote, supply, fdvQuote, raisedQuote, targetQuote, progressPercent:Math.min(100,number(raisedQuote / targetQuote * 100)), quote, priceUsd, fdvUsd, source:'Raydium onchain', warning:status === 'migrated' ? 'This curve has graduated. Live prices now come from its AMM market.' : status === 'migrating' ? 'This curve has reached graduation and is waiting for its AMM market.' : quote.stale ? 'The current USD reference is unavailable. Prices are shown in the paired token.' : ''};
}
