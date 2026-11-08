// Read-only bridge to dependency-free modules of the real source tree, so the
// preview reuses the real asset catalogue and API allowlist instead of copies.
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// The preview folder sits next to public/ and src/; LAUNCHPAD_SOURCE can point at another checkout.
const here = dirname(fileURLToPath(import.meta.url)), parent = resolve(here, '..');
export const SOURCE_ROOT = (process.env.LAUNCHPAD_SOURCE || parent).replace(/[\\/]$/, '');
export const sourceModule = relative => import(pathToFileURL(resolve(SOURCE_ROOT, relative)).href);
export const { LAUNCH_ASSETS } = await sourceModule('public/launch-assets.mjs');
export const { QUOTE_LOGO_PATHS } = await sourceModule('public/quote-logo-paths.mjs');
export const { launchpadApi, launchpadAccount } = await sourceModule('src/product-mode.mjs');
export const { pumpClassicDisclosure } = await sourceModule('public/pump-classic-catalog.mjs');

// v71.28: the transfer hook catalogue (rule names and the sentences the program enforces) for hooked preview coins.
export const { HOOK_RULES, HOOK_ROUTES, hookRuleById, describeHookRule } = await sourceModule('public/hook-catalog.mjs');

// v71.41: the pool maths every Robinhood coin's numbers come from (shared server/browser module) and the trade links.
export const { planPositions, quoteSwap, poolPrice, curveNumbers, tickAtSqrtPrice, graduationPositions } = await sourceModule('public/robinhood-pool-math.mjs');
export const { plannedSupply } = await sourceModule('public/robinhood-curve-math.mjs');
export const { robinhoodTradeLinks, robinhoodFeesFor } = await sourceModule('public/robinhood-launch-catalog.mjs');
