import { requestKey, requestInterval } from './request-pacing.mjs';
import { rpcEndpointHash } from './operator-capacity.mjs';
export function workerRpcGate(port, service = 'rpc') {
  let sequence = 0; const pending = new Map();
  const key = config => service === 'rpc' ? rpcEndpointHash(config.rpcUrl) : requestKey(config, service);
  port.on('message', message => {
    if (message.type !== 'rpc-reply' || (message.service || 'rpc') !== service) return;
    const entry = pending.get(message.id); if (!entry) return;
    pending.delete(message.id); entry.cleanup();
    if (message.error) entry.reject(Object.assign(Error(message.error), message.details)); else entry.resolve();
  });
  return {
    acquire(config, signal, deadline, method = '') {
      signal?.throwIfAborted();
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const abort = () => { pending.delete(id); signal?.removeEventListener('abort', abort); port.postMessage({ type: 'rpc-cancel', service, id }); reject(signal.reason || Error('RPC request cancelled.')); };
        pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) });
        signal?.addEventListener('abort', abort, { once: true });
        port.postMessage({ type: 'rpc-permit', service, id, key: key(config), rate: config.rpcRequestsPerSecond, interval: requestInterval(config, service), deadline, method });
      });
    },
    cooldown(config, wait) { port.postMessage({ type: 'rpc-cooldown', service, key: key(config), wait }); },
  };
}
