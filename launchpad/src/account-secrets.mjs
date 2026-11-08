import { createHmac } from 'node:crypto';
import { invariant } from './core.mjs';

export const secretFields = ['heliusKey', 'jupiterKey', 'rpcUrl', 'wsUrl', 'jitoUrl', 'jitoAuth', 'senderUrl', 'coingeckoKey', 'blockscoutKey'];
export const savedPrefix = 'relay-saved-v1:';
const isReference = value => typeof value === 'string' && value.startsWith(savedPrefix);

// These are account-scoped references, not encrypted keys or bearer credentials.
// Only the authenticated account can resolve them, against its own saved setup.
export function settingsSecrets(master, id, saved) {
  const values = new Map();
  const reference = (field, value) => {
    if (!value) return value;
    const ref = savedPrefix + createHmac('sha256', master).update(JSON.stringify(['settings-v1', id, field, value])).digest('base64url');
    values.set(ref, { field, value }); return ref;
  };
  const protectedSettings = structuredClone(saved);
  for (const field of secretFields) if (saved[field]) protectedSettings[field] = reference(field, saved[field]);
  protectedSettings.wallets = (saved.wallets || []).map(row => ({ ...row, privateKey: reference('privateKey', row.privateKey) }));
  const resolve = raw => {
    invariant(raw && typeof raw === 'object' && !Array.isArray(raw), 'Invalid settings.');
    const result = structuredClone(raw);
    const value = (field, input) => {
      if (!isReference(input)) return input;
      const stored = values.get(input);
      invariant(stored?.field === field, 'A saved credential changed or belongs to another account. Reload your saved settings.');
      return stored.value;
    };
    for (const field of secretFields) if (field in result) result[field] = value(field, result[field]);
    if (Array.isArray(result.wallets)) result.wallets = result.wallets.map(row => ({ ...row, privateKey: value('privateKey', row.privateKey) }));
    return result;
  };
  return { protectedSettings, resolve };
}
