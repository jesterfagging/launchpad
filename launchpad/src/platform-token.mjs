// The platform's own token (optional). With LAUNCHPAD_TOKEN_MINT set, the header shows its price, the protocol treasury
// buys it back and burns it with its share of revenue, and the analytics page charts those burns. Its own launch can burn
// its withheld transfer tax from the launch's dedicated rewards wallet (LAUNCHPAD_TOKEN_BURN_WALLET). Without a token
// the treasury keeps all revenue in SOL and none of these features appear.
import { launchpadEnv } from './brand-env.mjs';

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function address(name, env) {
  const value = String(launchpadEnv(name, env) ?? '').trim();
  if (value && !ADDRESS.test(value)) throw new Error(`LAUNCHPAD_${name} must be a Solana address.`);
  return value;
}
export const platformTokenMint = (env = process.env) => address('TOKEN_MINT', env);
export const platformTokenBurnWallet = (env = process.env) => address('TOKEN_BURN_WALLET', env);
/** The token's ticker for page copy (LAUNCHPAD_TOKEN_SYMBOL, without the $), or '' to keep the template's $LAUNCHPAD. */
export function platformTokenSymbol(env = process.env) {
  const value = String(launchpadEnv('TOKEN_SYMBOL', env) ?? '').trim().replace(/^\$/, '');
  if (value && !/^[A-Za-z0-9]{1,12}$/.test(value)) throw new Error('LAUNCHPAD_TOKEN_SYMBOL must be 1 to 12 letters or digits.');
  return value.toUpperCase();
}
export const PLATFORM_TOKEN_MINT = platformTokenMint();
export const PLATFORM_TOKEN_BURN_WALLET = platformTokenBurnWallet();
