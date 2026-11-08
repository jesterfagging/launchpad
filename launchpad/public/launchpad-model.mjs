import { GOTCHI_RAYDIUM_TAX_BPS, validGotchiId } from './gotchi-catalog.mjs';
import { AGENT_MODE, AGENT_VENUES, AGENT_PERSONALITIES, AGENT_LIMITS, validMission, validPersonality, normalizeDomains, capabilityMask, validObjective, objectiveById, objectiveMissingCapabilities, normalizeObjectiveSettings } from './agent-catalog.mjs';
import { influencerLaunchRequest } from './influencer-catalog.mjs';
import { PAYCHECK_POLICY, paycheckInput } from './paycheck-policy.mjs';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const FDV_MIN = 100, FDV_MAX = 50000;
export const PUBLIC_LAUNCH_FDV = 20000, ADMIN_LAUNCH_FDV_MAX = 100000;
export const LAUNCH_CURVE_POLICY = 'raydium-250-v1';
// The $4K start (a launchpad option, public/tenant-catalog.mjs START_TIERS): $4,000 to a $50,000 graduation.
export const LAUNCH_CURVE_POLICY_4K = 'raydium-4k-50k-v1';
export const LOW_START_FDV = 4000, LOW_START_GRADUATION_FDV = 50000;
export const TOTAL_SUPPLY = 1000000000n, MAX_DEV_TOKENS = 100000000n;
export const HOLDER_TAX_MIN_BPS = 100, HOLDER_TAX_MAX_BPS = 300;
export const isCurrentLaunch = input => input?.route === 'raydium' && input?.network === 'mainnet-beta';
export function requireValue(ok, message) { if (!ok) throw new Error(message); }
export function requireNewLaunchTax(input) {
  // A Paycheck launch (v71.44) is a holder-rewards launch funded by the 0.50% creator fee: it has no transfer tax.
  if(paycheckInput(input)) requireValue(input.taxBps === 0, 'Paycheck launches have no transfer tax.');
  else if(input.feeMode === 'holders') requireValue(Number.isInteger(input.taxBps) && input.taxBps >= HOLDER_TAX_MIN_BPS && input.taxBps <= HOLDER_TAX_MAX_BPS, 'New holder-reward launches require a transfer tax between 1% and 3%. Create a new review with a tax in that range.');
}
export function units(value, decimals = 9, label = 'Amount') {
  const s = String(value ?? '').trim();
  requireValue(Number.isInteger(decimals) && decimals >= 0 && decimals <= 18, 'Unsupported token decimals.');
  requireValue(/^(0|[1-9]\d*)(\.\d+)?$/.test(s) && s.length <= 64, `${label} must be a plain positive decimal.`);
  const [a,b=''] = s.split('.');
  requireValue(b.length <= decimals, `${label} supports at most ${decimals} decimal places.`);
  const n = BigInt(a) * 10n ** BigInt(decimals) + BigInt((b.padEnd(decimals, '0')) || '0');
  requireValue(n <= 18446744073709551615n, `${label} is too large.`); return n;
}
export function displayUnits(value, decimals = 9) {
  const n = BigInt(value), scale = 10n ** BigInt(decimals);
  const fraction = decimals ? (n % scale).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${n / scale}${fraction ? '.' + fraction : ''}`;
}
// New public launches target $20k -> $50k at the reviewed quote price. Keep
// the existing administrator starting-cap range with the same 2.5x model.
// These terms are selected by the server, never by fields in a raw request.
export function newLaunchCurvePolicy(input) {
  const startingCents = units(input.targetUsd, 2, 'Starting FDV');
  requireValue(startingCents > 0n, 'Starting FDV must be positive.');
  // Every other starting cap (public $20K, administrators' $20K-$100K) keeps the 2.5x model.
  if (startingCents === BigInt(LOW_START_FDV * 100)) return {curvePolicy:LAUNCH_CURVE_POLICY_4K,graduationTargetUsd:displayUnits(BigInt(LOW_START_GRADUATION_FDV * 100), 2)};
  return {curvePolicy:LAUNCH_CURVE_POLICY,graduationTargetUsd:displayUnits((startingCents * 5n + 1n) / 2n, 2)};
}
// The historical parser remains available for saved launches. New creation
// requests must explicitly select the public or administrator policy.
export function launchInput(raw, { marketCapPolicy = 'historical', publicStarts = [PUBLIC_LAUNCH_FDV] } = {}) {
  const walletMode = raw.walletMode ?? 'default';
  requireValue(['default','external'].includes(walletMode), 'Choose a default or connected launch wallet.');
  const externalWallet = walletMode === 'external' ? String(raw.externalWallet || '').trim() : '';
  requireValue(walletMode !== 'external' || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(externalWallet), 'Connect a Solana wallet before reviewing the launch.');
  const name = String(raw.name || '').trim(), symbol = String(raw.symbol || '').trim().toUpperCase();
  requireValue(new TextEncoder().encode(name).length >= 1 && new TextEncoder().encode(name).length <= 32 && !/[\x00-\x1f]/.test(name), 'Token name must contain 1–32 UTF-8 bytes.');
  requireValue(/^[A-Z0-9_]{1,10}$/.test(symbol), 'Symbol must contain 1–10 letters, numbers, or underscores.');
  requireValue(!raw.network || raw.network === 'mainnet-beta', 'Launches use Solana mainnet.');
  requireValue(!raw.route || raw.route === 'raydium', 'Launches use Raydium.');
  requireValue(['creator','holders','buyback','gotchi','agent','paycheck'].includes(raw.feeMode), 'Choose a fee destination.');
  // A Gotchi launch is a taxed holder-rewards launch whose rewards go to the
  // Gotchi pot: fixed 1% tax, no creator fee, pairing chosen once at launch.
  const gotchi = raw.feeMode === 'gotchi';
  if (gotchi) requireValue(validGotchiId(raw.gotchiId), 'Choose a Gotchi to pair your coin with.');
  else requireValue(raw.gotchiId === undefined || raw.gotchiId === '' || raw.gotchiId === null, 'A Gotchi pairing requires the Gotchi reward option.');
  // A Paycheck launch (v71.44) is a holder-rewards launch with no transfer tax: the
  // flat 0.50% creator fee is paid out every 15 minutes (holders, a $LAUNCHPAD burn,
  // Launchpad and the creator). It pairs with SOL only; the server keeps its ledger.
  const paycheck = raw.feeMode === 'paycheck';
  if (paycheck) requireValue(String(raw.quoteMint || SOL_MINT) === SOL_MINT, 'Paycheck launches pair with SOL only.');
  if (paycheck && raw.taxPercent !== undefined && raw.taxPercent !== '' && raw.taxPercent !== null) requireValue(Number(units(raw.taxPercent, 2, 'Transfer tax')) === 0, 'Paycheck launches have no transfer tax.');
  // An AI Agent launch is a creator-fee launch (flat 0.50%, no transfer tax)
  // whose creator entitlement is assigned to the agent's managed wallet. The
  // settings are normalized here; the server attaches the provisioned agent.
  const agent = raw.feeMode === 'agent';
  const agentRequest = agent ? agentLaunchRequest(raw.agent) : null;
  if (!agent) requireValue(raw.agent === undefined || raw.agent === null, 'Agent settings require the AI Agent launch option.');
  if (agent) requireValue(String(raw.quoteMint || SOL_MINT) === SOL_MINT, 'AI Agent launches pair with SOL only.');
  const feeMode = gotchi || paycheck ? 'holders' : agent ? 'creator' : raw.feeMode;
  // Retain the legacy field shape without accepting a caller-selected policy.
  const holderRewardMinimum = '';
  const taxBps = gotchi ? GOTCHI_RAYDIUM_TAX_BPS : paycheck ? 0 : Number(units(raw.taxPercent ?? (feeMode === 'holders' && marketCapPolicy !== 'historical' ? '2' : '0'), 2, 'Transfer tax'));
  if (gotchi && raw.taxPercent !== undefined && raw.taxPercent !== '') requireValue(Number(units(raw.taxPercent, 2, 'Transfer tax')) === GOTCHI_RAYDIUM_TAX_BPS, 'Gotchi launches use a fixed 1% transfer tax.');
  requireValue(taxBps <= 500, feeMode === 'holders' && marketCapPolicy !== 'historical' ? 'New holder-reward launches require a transfer tax between 1% and 3%.' : 'Transfer tax must be between 0% and 5%.');
  requireValue(!taxBps || feeMode === 'holders', 'Transfer tax is available only for holder-reward launches.');
  const paycheckPolicy = paycheck ? { policy: PAYCHECK_POLICY } : undefined;
  if(marketCapPolicy !== 'historical') requireNewLaunchTax({feeMode,taxBps,...(paycheckPolicy ? { paycheck: paycheckPolicy } : {})});
  const creatorFeeBps = Number(units(raw.creatorFeePercent ?? '0.25', 2, 'Creator fee'));
  requireValue(creatorFeeBps <= 50, 'Launchpad creator fees are capped at 0.50%.');
  const targetUsd = units(raw.targetUsd || '20000', 2, 'Starting FDV');
  requireValue(['public','admin','historical'].includes(marketCapPolicy), 'Invalid launch market cap policy.');
  // Public launches start where the host offers: $20,000 by default; a launchpad may offer the $4,000 start too (or only it).
  if (marketCapPolicy === 'public') requireValue(publicStarts.some(usd => targetUsd === BigInt(usd * 100)), publicStarts.length === 1 ? `Public launches start at a $${Number(publicStarts[0]).toLocaleString('en-US')} market cap.` : `Choose a starting market cap: ${publicStarts.map(usd => '$' + Number(usd).toLocaleString('en-US')).join(' or ')}.`);
  else if (marketCapPolicy === 'admin') requireValue(targetUsd >= BigInt(PUBLIC_LAUNCH_FDV * 100) && targetUsd <= BigInt(ADMIN_LAUNCH_FDV_MAX * 100), 'Administrator launches must start between $20,000 and $100,000.');
  else requireValue(targetUsd >= BigInt(FDV_MIN * 100) && targetUsd <= BigInt(FDV_MAX * 100), 'Starting market cap must be between $100 and $50,000.');
  // New launches specify a SOL spend limit. Retain explicitly supplied legacy
  // percentages so saved reviews and older clients continue to validate.
  const devBuyMode = raw.devBuySol !== undefined || raw.devBuyPercent === undefined ? 'sol' : 'percent';
  const devBuyLamports = devBuyMode === 'sol' ? units((String(raw.devBuySol ?? '0').trim() || '0').replace(/^\./,'0.'),9,'Developer buy') : 0n;
  const devBuyBps = devBuyMode === 'percent' ? Number(units(raw.devBuyPercent || '0', 2, 'Developer buy')) : 0;
  requireValue(devBuyBps <= 1000, 'Developer buys are limited to 10% of supply (100 million tokens).');
  const imageId = String(raw.imageId || '');
  requireValue(!imageId || /^[a-f0-9]{64}\.(png|jpg|webp)$/.test(imageId), 'Choose a valid token image.');
  const links = {};
  for (const key of ['website','twitter','telegram']) { const link = socialLink(key, raw[key], { max: 300 }); if (link) links[key] = link; }
  return { ...(marketCapPolicy === 'historical' ? {} : newLaunchCurvePolicy({targetUsd:displayUnits(targetUsd,2)})), name, symbol, walletMode, externalWallet, network: 'mainnet-beta', route: 'raydium', feeMode, ...(gotchi ? { gotchiId: raw.gotchiId } : {}), ...(agent ? { agentRequest } : {}), ...(paycheckPolicy ? { paycheck: paycheckPolicy } : {}), holderRewardMinimum,
    quoteMint: String(raw.quoteMint || SOL_MINT), recipient: String(raw.recipient || '').trim(),
    taxBps, creatorFeeBps, devBuyMode, devBuySol: displayUnits(devBuyLamports), devBuyLamports:devBuyLamports.toString(), devBuyBps, devBuyRaw: (TOTAL_SUPPLY * 1000000n * BigInt(devBuyBps) / 10000n).toString(), targetUsd: displayUnits(targetUsd,2), imageId, links,
    description: [...oneLine(raw.description || '')].slice(0,500).join('').trimEnd(),
    dailyGasLamports: feeMode === 'holders' ? '100000000' : '30000000', autoFees: agent || !(walletMode === 'external' && feeMode === 'creator') };
}
// A coin description is shown on one line on every venue (the Pump.fun and Meteora servers use this rule too): it is
// trimmed, each line break or tab inside it, with the spaces around it, becomes one space, and other control
// characters are removed.
const oneLine = value => String(value ?? '').replace(/[\x00-\x08\x0e-\x1f\x7f]/g, '').replace(/\s*[\t\n\v\f\r\u0085\u2028\u2029][\s\u0085]*/g, ' ').trim();
// A coin's website, X and Telegram links, read the same way on every venue (the Pump.fun and Meteora servers use
// these rules too): "@name" or "name" in the X or Telegram field becomes that profile's https link, an address
// without a scheme gets https://, and anything that is not an https address with a dotted host is refused with a
// message naming the field. A handle sent as "https://@name" or "https://name" (older launch pages) is a handle.
const SOCIAL_LINKS = Object.freeze({
  website: { label: 'website', help: 'Enter the website as an https:// address with a domain, like https://example.com.' },
  twitter: { label: 'X', handle: /^[A-Za-z0-9_]{1,15}$/, profile: 'https://x.com/', help: 'Enter X as @handle (up to 15 letters, numbers or _) or a full https:// link, like https://x.com/example.' },
  telegram: { label: 'Telegram', handle: /^[A-Za-z][A-Za-z0-9_]{3,31}$/, profile: 'https://t.me/', help: 'Enter Telegram as @username (4 to 32 letters, numbers or _, starting with a letter) or a full https:// link, like https://t.me/example.' },
});
const HANDLE_LIKE = /^(?:https?:\/\/)?@?([^\s/\\?#@:.]+)\/?$/i, LINK_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** A website ('website'), X ('twitter') or Telegram ('telegram') link as the https address to save ('' when empty). */
export function socialLink(kind, value, { max = 200 } = {}) {
  const link = SOCIAL_LINKS[kind]; requireValue(!!link, 'Unknown link field.');
  const text = String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim(); if (!text) return '';
  requireValue([...text].length <= max, `The ${link.label} link is too long. Use at most ${max} characters.`);
  const bare = HANDLE_LIKE.exec(text);
  if (bare) { requireValue(!!link.handle?.test(bare[1]), link.help); return link.profile + bare[1]; }
  const address = LINK_SCHEME.test(text) ? text : 'https://' + text, authority = address.replace(LINK_SCHEME, '').replace(/^[/\\]+/, '').split(/[/\\?#]/)[0];
  let url; try { url = new URL(address); } catch { throw new Error(link.help); }
  const host = url.hostname;
  requireValue(url.protocol === 'https:' && !authority.includes('@') && !url.username && !url.password && host.includes('.') && !host.startsWith('.') && !host.endsWith('.'), link.help);
  requireValue(url.href.length <= max + 100, `The ${link.label} link is too long. Use at most ${max} characters.`);
  return url.href;
}
/** Normalizes the creator's AI Agent settings from a launch form. Nothing here
 * is trusted beyond its shape: the server attaches the agent, wallet and policy. */
export function agentLaunchRequest(raw) {
  requireValue(raw && typeof raw === 'object' && !Array.isArray(raw), 'Describe your agent before launching.');
  requireValue(AGENT_VENUES.includes(raw.venue || 'raydium'), 'AI Agent launches are available on Raydium, Meteora and Pump.fun only.');
  const mission = String(raw.mission || '').trim();
  requireValue(validMission(mission), `Give your agent a mission of 1–${AGENT_LIMITS.missionChars} characters.`);
  const preset = String(raw.personalityPreset || 'analyst');
  requireValue(AGENT_PERSONALITIES.some(p => p.id === preset), 'Choose a personality preset.');
  const personality = preset === 'custom' ? String(raw.personality || '').trim() : '';
  requireValue(validPersonality(personality), `Custom personalities are limited to ${AGENT_LIMITS.personalityChars} characters.`);
  if (preset === 'custom') requireValue(personality.length > 0, 'Describe the custom personality or choose a preset.');
  const model = String(raw.model || '').trim();
  requireValue(/^[a-z0-9][a-z0-9._-]{1,60}\/[a-z0-9][a-z0-9._:-]{1,80}$/i.test(model), 'Choose a supported model.');
  const domains = normalizeDomains(raw.domains ?? []);
  const buyback = raw.buyback === true || raw.buyback === 'on' || raw.buyback === 'true', rewards = raw.rewards === true || raw.rewards === 'on' || raw.rewards === 'true';
  const capabilities = capabilityMask({ buyback, rewards });
  // Objective (v71.27): one of the catalogue's programs or 'custom'. A program that needs a financial capability requires it at launch.
  const objective = raw.objective === undefined || raw.objective === null || raw.objective === '' ? 'custom' : String(raw.objective);
  requireValue(validObjective(objective), 'Choose an objective for your agent.');
  const missing = objectiveMissingCapabilities(objective, capabilities);
  requireValue(missing.length === 0, `${objectiveById(objective).name} needs ${missing.length > 1 ? 'buy-and-burn or holder rewards' : missing[0] === 'buyback' ? 'buy-and-burn' : 'holder rewards'} enabled at launch.`);
  const objectiveSettings = normalizeObjectiveSettings(objective, raw.objectiveSettings);
  // AI influencer (v71.30): optional X posting and/or a generated character; null when the option is off. The server checks the X account and the reference upload.
  const influencer = influencerLaunchRequest(raw.influencer);
  return { mode: AGENT_MODE, venue: raw.venue || 'raydium', mission, personalityPreset: preset, personality, model, domains, buyback, rewards, capabilities, objective, objectiveSettings, ...(influencer ? { influencer } : {}) };
}
// Snapshot weights aggregate all eligible token accounts for an owner. Remainders
// and tiny payouts stay in the fee credit, never with an arbitrary last holder.
export function weightedRewards(total, rows, minimum = 1n) {
  const balances = new Map();
  for (const { owner, amount } of rows) { const n = BigInt(amount); requireValue(n >= 0n, 'Negative holder balance.'); if (n) balances.set(owner, (balances.get(owner) || 0n) + n); }
  const denominator = [...balances.values()].reduce((a,b)=>a+b,0n), budget = BigInt(total);
  requireValue(budget >= 0n && BigInt(minimum) > 0n, 'Invalid reward budget.');
  const payouts = denominator ? [...balances].sort(([a],[b])=>a.localeCompare(b)).map(([owner,n])=>({owner,amount:(budget*n/denominator).toString()})).filter(x=>BigInt(x.amount)>=BigInt(minimum)) : [];
  return { payouts, eligibleBalance: denominator.toString(), remainder: (budget-payouts.reduce((a,x)=>a+BigInt(x.amount),0n)).toString() };
}
