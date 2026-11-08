import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { availableParallelism, totalmem } from 'node:os';
import { operatorCapacity } from '../src/operator-capacity.mjs';
import { launchpadEnv } from '../src/brand-env.mjs';

// Read-only configuration estimate. Never sends RPC, submits a transaction,
// changes a plan, reads wallet keys or prints endpoint/key values.
export function assessReadiness(env = process.env, targetTradesPerMinute = 100) {
  if (!Number.isSafeInteger(targetTradesPerMinute) || targetTradesPerMinute < 1 || targetTradesPerMinute > 10000) throw Error('Choose a whole-number trade target from 1 to 10000 per minute.');
  const capacity = operatorCapacity({}, env), checks = [];
  const check = (name, passed, detail) => checks.push({ name, passed, detail });
  let origin = false;
  try { const url = new URL(launchpadEnv('PUBLIC_URL', env)); origin = url.protocol === 'https:' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash; } catch {}
  check('HTTPS origin', origin, 'Set LAUNCHPAD_PUBLIC_URL to the production HTTPS origin.');
  check('Operator RPC configured', !!launchpadEnv('PUBLIC_RPC_URL', env), 'Use an operator-owned RPC endpoint; do not rely on the public mainnet fallback.');
  check('Operator routing key configured', !!launchpadEnv('PUBLIC_JUPITER_KEY', env), 'Keep the routing key server-side; visitors need no API key.');
  const maxUsers = Number(launchpadEnv('MAX_USERS', env) || launchpadEnv('TELEGRAM_MAX_USERS', env) || 1000);
  check('Account capacity', Number.isSafeInteger(maxUsers) && maxUsers >= 1000 && maxUsers <= 10000, 'Set LAUNCHPAD_MAX_USERS to at least 1000, up to 10000.');
  // Sizing assumptions, not measured transaction throughput. 30% headroom,
  // 25 RPC calls + 2 route builds per trade, and 10 RPC/s for other work.
  const estimated = {
    rpcRequestsPerSecond: Math.ceil((targetTradesPerMinute * 25 / 60 + 10) * 1.3),
    sendRequestsPerSecond: Math.ceil(targetTradesPerMinute / 60 * 1.3),
    jupiterRequestsPerSecond: Math.ceil(targetTradesPerMinute * 2 / 60 * 1.3),
  };
  for (const [key, value] of Object.entries(estimated)) check(key, capacity[key] >= value, `Declared ${capacity[key]}; illustrative target requires ${value}. Do not raise settings above your purchased provider limits.`);
  return { configuration: checks.every(row => row.passed) ? 'meets_declared_estimate' : 'needs_attention', targetOnlineUsers: 1000, targetTradesPerMinute, capacity, estimated, checks,
    limitation: 'This checks declared settings, not provider entitlement or real throughput. Passing does not certify 1000-user launch readiness. Run staging load, recovery and supervised funded canary tests.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const option = process.argv.find(value => value.startsWith('--trades-per-minute='));
    const result = assessReadiness(process.env, option ? Number(option.split('=')[1]) : 100);
    let memoryMax = totalmem();
    try { const value = Number((await readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim()); if (Number.isSafeInteger(value) && value > 0) memoryMax = Math.min(memoryMax, value); } catch {}
    result.machine = { availableCpuCores: availableParallelism(), memoryLimitBytes: memoryMax };
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.configuration === 'meets_declared_estimate' ? 0 : 2;
  } catch (error) { console.error(String(error.message).replace(/https?:\/\/\S+/g, '[endpoint]')); process.exitCode = 1; }
}
