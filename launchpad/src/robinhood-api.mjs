import { settingsSecrets } from './account-secrets.mjs';
import { ensureRobinhoodAccount, evmWallet } from './robinhood-settings.mjs';
import { cashbackSummary } from './account-policy.mjs';

export async function robinhoodApi({ path, method, url, body, account, session, currentSession, accounts, manager, policy, send, sendView = send, requireAdmin, limits }) {
  if (!path.startsWith('/api/robinhood/')) return false;
  if (!manager || !policy) { send(503, { error: 'Robinhood is unavailable on this host.' }); return true; }
  const id = account.id, scope = `${id}:robinhood`, route = path.slice('/api/robinhood/'.length);
  const saved = await manager.readSettings(id);
  const secrets = settingsSecrets(accounts.master, scope, saved.settings);
  const protect = value => ({ ...value, settings: settingsSecrets(accounts.master, scope, value.settings).protectedSettings });
  const resolve = value => secrets.resolve(value);
  if (method === 'GET') {
    if (route === 'account') { const data = await ensureRobinhoodAccount(accounts, id); send(200, { account: { ...account, chain: 'robinhood', mainWallet: data.mainWallet.publicKey }, fees: await policy.get(id), cashback: await cashbackSummary(manager.storeFor(id)) }); }
    else if (route === 'settings') send(200, protect(saved));
    else if (route === 'status') sendView(200, await manager.view(id, url.searchParams.get('kind') || 'copy'));
    else send(404, { error: 'Unknown Robinhood request.' });
    return true;
  }
  if (method !== 'POST') { send(405, { error: 'Method not allowed.' }); return true; }
  const value = await body(), kind = value.kind || 'copy';
  if (route === 'settings') send(200, protect(await manager.saveSettings(id, resolve(value.settings), value.revision)));
  else if (route === 'wallets/generate') { limits.check(`wallet-generation:${id}`, 10); const result = await manager.generateWallets(id, resolve(value.settings), value.revision, value.count, kind); await accounts.audit(id, 'robinhood-wallets-generated'); send(200, protect(result)); }
  else if (route === 'wallets/check') { const config = resolve(value.settings); send(200, { wallets: config.wallets.map((w, i) => { const checked = evmWallet(w, i); return { publicKey: checked.publicKey, label: checked.label, tool: checked.tool }; }) }); }
  else if (route === 'account/export' || route === 'settings/export') {
    limits.check(`export:${id}`, 5, 15 * 60000); await accounts.reauthenticate(id, value.password, value.code);
    await accounts.audit(id, route === 'account/export' ? 'robinhood-main-wallet-exported' : 'robinhood-setup-exported');
    send(200, route === 'account/export' ? (await ensureRobinhoodAccount(accounts, id)).mainWallet : { settings: resolve(value.settings || saved.settings) });
  } else if (route === 'admin/fees') {
    requireAdmin(session); limits.check(`admin:${id}`, 10, 15 * 60000); await accounts.reauthenticate(id, value.password, value.code);
    requireAdmin(currentSession ? await currentSession() : {...session,account:await accounts.get(id)});
    await policy.setRecipient(value.recipient); await accounts.audit(id, 'robinhood-fee-recipient-updated'); send(200, { fees: await policy.get(id) });
  } else if (route === 'start') { await manager.get(id).start(resolve(value.settings), kind); sendView(200, await manager.view(id, kind)); }
  else if (route === 'stop') { manager.get(id).stop(value.all ? undefined : kind); sendView(200, await manager.view(id, kind)); }
  else if (route === 'manual') { const result = await manager.get(id).manualTrade(resolve(value.settings), value.trade, kind); sendView(200, { ...await manager.view(id, kind), manualResult: result.manualResult }); }
  else if (route === 'inventory/release') { await manager.get(id).releaseInventory(value.wallet, kind); sendView(200, await manager.view(id, kind)); }
  else if (route === 'inventory/convert') { if (kind !== 'liquidity') throw Error('Choose Liquidity to complete an ETH withdrawal.'); await manager.get(id).convertInventory(value.wallet, resolve(value.settings)); sendView(200, await manager.view(id, kind)); }
  else if (route === 'claim-fees') { await manager.get(id).claimFees(value.allocation, resolve(value.settings)); sendView(200, await manager.view(id, 'liquidity')); }
  else if (route === 'withdraw') { await manager.get(id).withdraw(value.allocation, resolve(value.settings)); sendView(200, await manager.view(id, 'liquidity')); }
  else send(404, { error: 'Unknown Robinhood action.' });
  return true;
}
