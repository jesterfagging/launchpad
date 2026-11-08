import { createHash } from 'node:crypto';
import { launchpadEnv } from './brand-env.mjs';

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const digest = value => createHash('sha256').update(value).digest('hex');
export const rpcEndpointHash = value => digest(new URL(value || DEFAULT_RPC).href);
const numberSetting = (name, fallback, minimum, maximum, integer, env) => {
  const raw = launchpadEnv(name, env);
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+(?:\.\d+)?$/.test(String(raw)) || !Number.isFinite(value) || value < minimum || value > maximum || integer && !Number.isInteger(value))
    throw Error(`LAUNCHPAD_${name} must be ${integer ? 'a whole number' : 'a number'} from ${minimum} to ${maximum}.`);
  return value;
};

// These are operator declarations of purchased capacity, not provider plan
// detection. A customer's different credential never inherits a paid limit.
export function operatorCapacity({ rpcUrl, jupiterKey } = {}, env = process.env) {
  const configuredRpc = launchpadEnv('PUBLIC_RPC_URL', env) || DEFAULT_RPC;
  const configuredKey = launchpadEnv('PUBLIC_JUPITER_KEY', env) || '';
  const rpcRate = numberSetting('PUBLIC_RPC_RPS', 8, 1, 1000, true, env);
  const sendRate = numberSetting('PUBLIC_SEND_RPS', 1, 1, 1000, true, env);
  const jupiterRate = numberSetting('PUBLIC_JUPITER_RPS', configuredKey ? 1 : .5, .1, 1000, false, env);
  if (!configuredKey && jupiterRate > .5) throw Error('LAUNCHPAD_PUBLIC_JUPITER_RPS above 0.5 requires LAUNCHPAD_PUBLIC_JUPITER_KEY.');
  const key = jupiterKey === undefined ? configuredKey : jupiterKey;
  const operatorRpc = rpcEndpointHash(rpcUrl || configuredRpc) === rpcEndpointHash(configuredRpc);
  return {
    rpcRequestsPerSecond: operatorRpc ? rpcRate : 8,
    sendRequestsPerSecond: operatorRpc ? Math.min(sendRate, rpcRate) : 1,
    jupiterRequestsPerSecond: key && key === configuredKey ? jupiterRate : key ? 1 : Math.min(.5, jupiterRate),
    maxRpcQueue: numberSetting('PUBLIC_RPC_QUEUE', 100, 1, 10000, true, env),
    maxProviderQueue: numberSetting('PUBLIC_PROVIDER_QUEUE', 100, 1, 10000, true, env),
    requestDeadlineMs: numberSetting('PUBLIC_REQUEST_DEADLINE_MS', 15000, 1000, 60000, true, env),
  };
}

export function operatorRpcOptions(endpointHash, env = process.env) {
  const limits = operatorCapacity({}, env);
  return {
    ...(endpointHash === rpcEndpointHash(launchpadEnv('PUBLIC_RPC_URL', env) || DEFAULT_RPC) ? { aggregateRate: limits.rpcRequestsPerSecond, sendRate: limits.sendRequestsPerSecond } : { sendRate: 1 }),
    maxQueue: limits.maxRpcQueue,
    requestDeadlineMs: limits.requestDeadlineMs,
  };
}

export function operatorJupiterInterval(keyHash, env = process.env) {
  const configuredKey = launchpadEnv('PUBLIC_JUPITER_KEY', env) || '';
  const limits = operatorCapacity({}, env);
  // Preserve a 5% timing margin, including the existing 1050/2100 defaults.
  if (configuredKey && keyHash === digest(configuredKey)) return Math.ceil(1050 / limits.jupiterRequestsPerSecond);
  return keyHash === digest('public') ? 2100 : 1050;
}
