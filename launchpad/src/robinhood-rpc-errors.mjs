// Keep useful provider diagnostics without logging RPC credentials or wire payloads.
export function scrubRpcMessage(value, rpcUrl = '') {
  let text = String(value || 'RPC rejected the request.');
  const secrets = [rpcUrl];
  try {
    const url = new URL(rpcUrl);
    secrets.push(url.username, url.password, ...url.searchParams.values());
    // Providers such as Alchemy put credentials in a path segment.
    secrets.push(...url.pathname.split('/').filter(part => part.length >= 8));
  } catch { /* No endpoint supplied. */ }
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    const variants = new Set([secret, encodeURIComponent(secret)]);
    try { variants.add(decodeURIComponent(secret)); } catch { /* Malformed escape. */ }
    for (const variant of variants) if (variant) text = text.split(variant).join('[redacted]');
  }
  return text
    .replace(/(?:https?|wss?):(?:\\?\/){2}[^\s"'<>]+/gi, '[RPC URL]')
    .replace(/\b(?:0x)?[0-9a-f]{64,}\b/gi, '[hex data]')
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|authorization|bearer|password|secret)\s*[:=]?\s*)[^\s,;"'}]+/gi, '$1[redacted]')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function deploymentErrorMessage(error) {
  const seen = new Set(); let current = error, stage = '', rpc;
  for (let depth = 0; current && depth < 20 && !seen.has(current); depth++) {
    seen.add(current);
    if (!stage && current.deploymentStage) stage = current.deploymentStage;
    if (current.rpcMethod) rpc = current;
    current = current.cause;
  }
  if (rpc) return scrubRpcMessage(`${stage ? `${stage}: ` : ''}Robinhood RPC ${rpc.rpcMethod} failed (${rpc.rpcCode ?? 'RPC error'}): ${rpc.rpcReason || 'Provider supplied no reason.'}`);
  return scrubRpcMessage(error?.message || error?.shortMessage || 'Deployment check failed.');
}

export function rpcRateLimit(error) {
  const seen = new Set();
  for (let current = error; current && seen.size < 20 && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current.rateLimited || current.rpcStatus === 429) return current;
  }
  return null;
}

export function throwIfRpcUnavailable(error) {
  if (rpcRateLimit(error)) throw error;
  const seen = new Set();
  for (let current = error; current && seen.size < 20 && !seen.has(current); current = current.cause) {
    seen.add(current);
    if (current.rpcStatus || current.rpcMethod && /time.?out|timed out|fetch failed|ECONN|network|invalid response|request stopped|aborted/i.test(current.rpcReason || current.message)) throw error;
  }
}

export function robinhoodErrorMessage(error, rpcUrl = '') {
  const seen = new Set(); let rpc;
  for (let current = error; current && seen.size < 20 && !seen.has(current); current = current.cause) {
    seen.add(current); if (current.rpcMethod) rpc = current;
  }
  if (rpc) return scrubRpcMessage(`Robinhood RPC ${rpc.rpcMethod}: ${rpc.rpcReason || rpc.message}`, rpcUrl);
  const limited = rpcRateLimit(error);
  return scrubRpcMessage(limited?.message || error?.message || error?.shortMessage || 'Robinhood operation failed.', rpcUrl);
}
