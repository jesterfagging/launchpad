import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import { TelegramEngine } from './telegram-engine.mjs';
import { workerRpcGate } from './worker-rpc.mjs';

export class WalletBalances {
  constructor({rpcGate}={}) { this.cache = new Map(); this.pending = new Map(); this.workers = new Set(); this.rpcGate=rpcGate; this.brokers=new Map(); }
  async read(id, settings) {
    const rpcUrl = settings.rpcUrl || (settings.heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(settings.heliusKey)}` : '');
    if (!rpcUrl) throw Error('Save your RPC connection before refreshing balances.');
    const addresses = [...new Set(settings.wallets.map(w => w.publicKey).filter(Boolean))];
    if (!addresses.length) return { at: Date.now(), balances: {} };
    const key = createHash('sha256').update(JSON.stringify([rpcUrl, addresses])).digest('hex');
    const cached = this.cache.get(id);
    if (cached?.key === key && Date.now() - cached.at < 30000) return cached.value;
    if (this.pending.has(id)) return this.pending.get(id);
    if (this.workers.size >= 2) throw Error('Balance refresh is busy. Try again shortly.');
    const rate=Number(settings.rpcRequestsPerSecond??8);if(!Number.isInteger(rate)||rate<1||rate>1000)throw Error('Set a valid RPC request limit in Connections.');
    const worker = new Worker(new URL(import.meta.url), { workerData: { rpcUrl, addresses,rate,sharedRpc:!!this.rpcGate }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
    const broker={rpcGate:this.rpcGate,rpcClient:randomUUID(),rpcPending:new Map(),worker};this.brokers.set(worker,broker);
    this.workers.add(worker);
    const request = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(Error('Balance refresh timed out.')); worker.terminate(); }, 15000);
      worker.on('message', message => {if(message.type?.startsWith('rpc-')){TelegramEngine.prototype.rpcMessage.call(broker,message);return;}clearTimeout(timer); message.error ? reject(Error(message.error)) : resolve(message); });
      worker.once('error', () => { clearTimeout(timer); reject(Error('Balance refresh unavailable.')); });
      worker.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(Error('Balance refresh interrupted.')); });
    }).then(value => { this.cache.set(id, { key, at: Date.now(), value }); if (this.cache.size > 1000) this.cache.delete(this.cache.keys().next().value); return value; })
      .finally(() => { this.pending.delete(id); this.workers.delete(worker);this.releaseBroker(worker); worker.terminate(); });
    this.pending.set(id, request); return request;
  }
  releaseBroker(worker){const broker=this.brokers.get(worker);if(!broker)return;broker.closed=true;for(const controller of broker.rpcPending.values())controller.abort();this.rpcGate?.removeClient(broker.rpcClient);this.brokers.delete(worker);}
  close() { for (const worker of this.workers){this.releaseBroker(worker);worker.terminate();}this.cache.clear(); }
}
if (!isMainThread && parentPort) {
  const { installTelegramNetworkGuard, publicEndpoint } = await import('./telegram-network.mjs');
  installTelegramNetworkGuard();
  try {
    const url = publicEndpoint(workerData.rpcUrl).toString(), addresses = workerData.addresses;
    if (!Array.isArray(addresses) || addresses.length > 64 || addresses.some(a => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a))) throw Error();
    const signal = AbortSignal.timeout(12000),deadline=Date.now()+12000,gate=workerData.sharedRpc?workerRpcGate(parentPort):null,config={rpcUrl:url,rpcRequestsPerSecond:workerData.rate};
    const rpc = async (method, params) => {
      await gate?.acquire(config,signal,deadline,method);signal.throwIfAborted();
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal });
      if(response.status===429)gate?.cooldown(config,Math.max(1000,(Number(response.headers.get('retry-after'))||1)*1000));
      if (!response.ok) throw Error(); const result = await response.json(); if (result.error) throw Error(); return result.result;
    };
    if (await rpc('getGenesisHash', []) !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d') throw Error();
    const result = await rpc('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 0 } }]);
    if (result?.value?.length !== addresses.length) throw Error();
    const balances = Object.fromEntries(addresses.map((address, i) => { const v = result.value[i]; if (v && (!Number.isSafeInteger(v.lamports) || v.lamports < 0)) throw Error(); return [address, String(v?.lamports || 0)]; }));
    parentPort.postMessage({ at: Date.now(), balances });
  } catch { parentPort.postMessage({ error: 'SOL balances unavailable. Check the saved mainnet RPC connection.' }); }
}
