// A launchpad's first start (LAUNCHPAD_PRODUCT=tenant), run by src/host-server.mjs before the app is built and again on
// every start (each step is idempotent and keeps what an owner changed since):
//   1. the treasury: a server-made wallet, on as the system (src/tenant/treasury.mjs);
//   2. the protocol fee recipient: that wallet (Raydium needs it before any launch; Pump.fun and Meteora pay to it);
//   3. Pump.fun, when the launchpad offers it: new launches open (the "intake" rollout flag), once — an owner who
//      pauses intake later keeps it paused.
// Meteora's own setup needs the running service and happens when the app starts listening (src/account-app.mjs).
import { join } from 'node:path';
import { tenantConfig, platformShare } from './config.mjs';
import { TenantTreasury } from './treasury.mjs';
import { openPumpClassicDatabase, PumpClassicStore } from '../pump-classic/store.mjs';
import { launchpadEnv } from '../brand-env.mjs';

export async function bootstrapTenant({ accounts, env = process.env, now = Date.now, log = () => {} } = {}) {
  const config = tenantConfig(env); if (!config) return null;
  const treasury = new TenantTreasury({ accounts, now, share: platformShare(env) });
  const wallet = await treasury.ensureWallet();
  await treasury.locked(async () => {
    const saved = await accounts.hostStore.read('launch-protocol-fees', null);
    if (saved?.recipient === wallet && saved.recipientScope === 'launchpad') return;
    const at = now();
    await accounts.hostStore.write('launch-protocol-fees', {
      ...(saved || {}), recipient: wallet, recipientScope: 'launchpad', creationFeeSol: saved?.creationFeeSol || '0', autoHarvest: saved?.autoHarvest !== false,
      lpPolicy: 'platform_locked', platformLpPercent: 75, liquidityPolicyVersion: 1, updatedAt: at, updatedBy: 'launchpad',
      history: [...(saved?.history || []), { at, actorId: 'tenant-system', actor: 'launchpad', from: saved?.recipient || '', to: wallet, reason: 'The launchpad treasury receives protocol fees.', treasuryAutomation: true }],
    });
    log(`protocol fees go to the launchpad treasury ${wallet}`);
  }, { fee: true });
  if (config.venues.includes('pump-classic')) {
    const db = await openPumpClassicDatabase(launchpadEnv('PUMP_CLASSIC_DB_PATH', env) || join(accounts.dir, 'pump-classic', 'pump-classic.sqlite'), { now });
    try {
      const store = new PumpClassicStore(db, { now }), flags = store.flags();
      if (!flags.intake) { store.setFlag('intake', true, { reason: 'Launchpad created: Pump.fun launches open.', by: 'launchpad' }); log('Pump.fun launches opened'); }
    } finally { db.close(); }
  }
  return { wallet };
}
