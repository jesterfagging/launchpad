// Concrete failures emitted by the shared request gates and Node's timeout
// signal. Matching a saved message must not accept an unrelated failure that
// merely mentions a scheduler or an unavailable provider.
const internalMessages = new Set([
  'RPC scheduler closed',
  'RPC worker closed',
  'Request scheduler closed',
  'Request worker closed',
  'Maximum signal age exceeded before the RPC request started',
  'RPC capacity is busy. Try again shortly; nothing new was submitted',
  'Provider capacity was unavailable before this trade expired. Nothing new was submitted',
]);
const accountWrapper = /^failed to get (?:info about|balance of) account [1-9A-HJ-NP-Za-km-z]{32,44}: (.*)$/;

export function knownRewardTransportMessage(value) {
  if (typeof value !== 'string') return false;
  let message = value;
  if (message.startsWith('Error: ')) message = message.slice(7);
  const wrapped = accountWrapper.exec(message);
  if (wrapped) message = wrapped[1];
  if (message.startsWith('Error: ')) message = message.slice(7);
  if (message.endsWith('.')) message = message.slice(0, -1);
  return internalMessages.has(message)
    || message === 'TimeoutError: The operation was aborted due to timeout'
    || message === 'The operation was aborted due to timeout';
}

// A transport error code or a provider's retry flag cannot override a failure
// of authority, receipt verification, or reward accounting.
export function rewardIntegrityMessage(message) {
  return /mismatch|\b(?:no longer matches|does not match)\b|\bdiffer(?:s|ent)?\b|invalid (?:(?:holder|token|reward) )?(?:authority|owner|signer|recipient|mint|account)|authority|unauthori[sz]ed|exceeds? (?:earned|.*credit|.*budget)|duplicate|already applied|accounting|invariant|signature (?:invalid|verification)|signer (?:unavailable|does not match)|private key|secret key/i.test(message);
}
