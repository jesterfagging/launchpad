import { pathToFileURL } from 'node:url';
import { publicEndpoint, installTelegramNetworkGuard } from '../src/telegram-network.mjs';

export async function checkSavedRpc(settings, rpc) {
  const custom = String(settings.rpcUrl || '').trim(), key = String(settings.heliusKey || '').trim();
  if (!custom && !key) throw Error('No RPC URL or Helius API key is saved.');
  if (!custom && /^https?:\/\//i.test(key)) throw Error('The Helius API key field contains a URL. Put the complete URL in Custom RPC URL, or save only the key in Helius API key.');
  const url = publicEndpoint(custom || `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`).toString();
  const genesis = await rpc(url, 'getGenesisHash', [], AbortSignal.timeout(15000));
  if (genesis !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw Error('The saved RPC answered, but it is not Solana mainnet.');
  return { source: custom ? 'Custom RPC URL' : 'Helius API key', network: 'Solana mainnet' };
}
async function main() {
  const username = String(process.argv[2] || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(username)) throw Error('Usage: npm run rpc:check -- USERNAME');
  installTelegramNetworkGuard();
  const [{ AccountService }, { accountRoot }, { rpcCall }] = await Promise.all([import('../src/accounts.mjs'), import('../src/host-server.mjs'), import('../src/providers.mjs')]);
  const accounts = await new AccountService(accountRoot()).init(), user = (await accounts.list()).find(a => a.username === username);
  if (!user) throw Error('Username not found in this host’s account data. Check LAUNCHPAD_DATA_DIR.');
  const saved = await accounts.storeFor(user.id).read('settings', {});
  console.log(`Checking the saved ${saved.rpcUrl ? 'Custom RPC URL' : 'Helius API key'} from this bot host. Credentials remain hidden; no trades are started.`);
  const result = await checkSavedRpc(saved, rpcCall);
  console.log(`PASS: ${result.network} answered getGenesisHash using ${result.source}.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(String(error.message).replace(/(?:https?|wss?):\/\/\S+/g, '[RPC URL]')); process.exitCode = 1;
});
