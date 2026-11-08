import { parentPort, workerData } from 'node:worker_threads';
import { installTelegramNetworkGuard } from './telegram-network.mjs';
import { TelegramStore, TelegramLedger } from './telegram-store.mjs';
import { ChainStore } from './robinhood-settings.mjs';
import { workerRpcGate } from './worker-rpc.mjs';
import { RunErrorStop } from './run-error-stop.mjs';

if (parentPort && workerData) {
  installTelegramNetworkGuard();
  const { RobinhoodEngine, safeError } = await import('./robinhood-engine.mjs');
  const kind = workerData.journalKind;
  if (!['copy','sniper','liquidity','market'].includes(kind)) throw Error('Invalid Robinhood worker kind.');
  const store = new ChainStore(new TelegramStore(workerData.dir, Buffer.from(workerData.key), workerData.context));
  const ledger = await new TelegramLedger(store, kind === 'copy' ? 'live' : `${kind}-live`).load();
  const runtime = new RobinhoodEngine(ledger, workerData.platformContext, kind, { gate: workerData.sharedRpc ? workerRpcGate(parentPort) : null });
  const errorStop = new RunErrorStop(runtime);
  let changed;
  runtime.on('change', () => { if (!changed) changed = setTimeout(() => { changed = null; parentPort.postMessage({ type: 'status', value: errorStop.status() }); }, 30); });
  parentPort.on('message', async ({ type, id, method, raw, kind: requestedKind, trade, wallet, allocation }) => {
    if (type?.startsWith('rpc-')) return;
    try {
      if (method === 'start' || (['manualTrade', 'withdraw', 'claimFees', 'convertInventory'].includes(method) && runtime.state === 'stopped')) errorStop.arm();
      if (['stop', 'close'].includes(method)) errorStop.disarm();
      if (method === 'start') await runtime.start(raw, requestedKind);
      else if (method === 'manualTrade') await runtime.manualTrade(raw, trade);
      else if (method === 'claimFees') await runtime.claimFees(wallet, raw);
      else if (method === 'withdraw') await runtime.withdraw(wallet, raw);
      else if (method === 'convertInventory') await runtime.convertInventory(wallet, raw);
      else if (method === 'release') await runtime.releaseInventory(allocation);
      else if (method === 'stop') runtime.stop();
      else if (method === 'close') { await runtime.close(); clearTimeout(changed); parentPort.postMessage({ type: 'reply', id, value: errorStop.status() }); parentPort.close(); return; }
      else throw Error('Unknown Robinhood operation.');
      parentPort.postMessage({ type: 'reply', id, value: errorStop.status() });
    } catch (error) { parentPort.postMessage({ type: 'reply', id, value: errorStop.status(), error: safeError(error) }); }
  });
  parentPort.postMessage({ type: 'ready' });
}
