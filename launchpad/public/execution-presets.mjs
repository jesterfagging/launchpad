const fields = {
  solana: [
    { key: 'slippagePercent', label: 'Slippage (%)', fallback: '2', min: 0.01, max: 50, decimals: 2 },
    { key: 'prioritySol', label: 'Priority fee (SOL)', fallback: '0.0003', min: 0, max: 100, decimals: 9 },
    { key: 'jitoSol', label: 'Jito tip (SOL)', fallback: '0', min: 0, max: 100, decimals: 9 },
    { key: 'heliusSol', label: 'Helius tip (SOL)', fallback: '0', min: 0, max: 100, decimals: 9 },
    { key: 'senderTier', label: 'Helius Sender tier', fallback: 'swqos', options: ['swqos', 'max'] },
    { key: 'sendRpc', label: 'Submit through RPC', fallback: true, type: 'boolean' },
  ],
  robinhood: [
    { key: 'slippageBps', label: 'Slippage (%)', fallback: 200, min: 1, max: 5000, decimals: 0, scale: 100 },
    { key: 'maxGasGwei', label: 'Max gas price (Gwei)', fallback: '10', min: 0.000000001, max: 100000, decimals: 9 },
    { key: 'priorityGwei', label: 'Priority gas (Gwei)', fallback: '0', min: 0, max: 100000, decimals: 9 },
    { key: 'reserveEth', label: 'Wallet gas reserve (ETH)', fallback: '0.003', min: 0, max: 1e12, decimals: 18 },
  ],
};
export function executionFields(chain) {
  if (!Object.hasOwn(fields, chain)) throw Error('Choose Solana or Robinhood.');
  return fields[chain];
}
export function executionInputValue(field, value) {
  if (!field.scale) return value;
  const text = String(value).trim();
  if (!/^(?:\d+\.?\d{0,2}|\.\d{1,2})$/.test(text)) throw Error(`${field.label}: use at most two decimal places.`);
  return Math.round(Number(text) * field.scale);
}
export function executionValues(chain, input = {}) {
  const out = {};
  for (const f of executionFields(chain)) {
    const value = input[f.key] ?? f.fallback;
    if (f.type === 'boolean') {
      if (typeof value !== 'boolean') throw Error(`${f.label}: choose on or off.`);
      out[f.key] = value;
    } else if (f.options) {
      if (!f.options.includes(value)) throw Error(`${f.label}: choose ${f.options.join(' or ')}.`);
      out[f.key] = value;
    } else {
      const text = String(value).trim();
      if (!/^(?:\d+\.?\d*|\.\d+)$/.test(text) || text.length > 60 || (text.split('.')[1]?.length || 0) > f.decimals || !Number.isFinite(Number(text)) || Number(text) < f.min || Number(text) > f.max) throw Error(`${f.label}: enter ${f.min / (f.scale || 1)}–${f.max / (f.scale || 1)} with at most ${f.decimals + (f.scale ? 2 : 0)} decimal places.`);
      out[f.key] = f.scale ? Number(text) : text;
    }
  }
  if (chain === 'robinhood' && Number(out.priorityGwei) > Number(out.maxGasGwei)) throw Error('Priority gas cannot exceed the maximum gas price.');
  if (chain === 'solana') {
    const tip = Number(out.heliusSol), minimum = out.senderTier === 'max' ? 0.001 : 0.000005;
    if (tip > 0 && tip < minimum) throw Error(`The selected Helius Sender tier needs at least ${minimum} SOL, or zero to disable it.`);
    if (!out.sendRpc && Number(out.jitoSol) === 0 && tip === 0) throw Error('Enable RPC submission or at least one tipped relay.');
  }
  return out;
}
export function cleanExecutionPresets(chain, value, current = {}) {
  if (value == null) { const baseline = executionValues(chain, current); return { selected: null, slots: [0, 1, 2].map(i => ({ name: `P${i + 1}`, values: { ...baseline } })) }; }
  if (typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.slots) || value.slots.length !== 3 || value.selected !== null && ![0, 1, 2].includes(value.selected)) throw Error('Execution presets need exactly three slots: P1, P2 and P3.');
  return { selected: value.selected, slots: value.slots.map((slot, i) => {
    if (!slot || typeof slot !== 'object' || Array.isArray(slot) || typeof slot.values !== 'object' || !slot.values || Array.isArray(slot.values)) throw Error('Invalid execution preset.');
    const name = String(slot.name ?? `P${i + 1}`).trim();
    if (!name || name.length > 24 || /[\r\n\x00-\x1f]/.test(name)) throw Error('Preset names must contain 1–24 characters.');
    return { name, values: executionValues(chain, slot.values) };
  }) };
}
export function selectedExecutionValues(chain, settings) {
  if (settings.executionPresets?.selected == null) return null;
  const book = cleanExecutionPresets(chain, settings.executionPresets, settings), slot = book.slots[book.selected].values;
  const current = executionValues(chain, settings);
  return executionFields(chain).every(({ key }) => String(current[key]) === String(slot[key])) ? slot : null;
}
export function useExecutionPreset(chain, settings, index, slot) {
  if (![0, 1, 2].includes(index)) throw Error('Choose P1, P2 or P3.');
  const book = cleanExecutionPresets(chain, settings.executionPresets, settings);
  if (slot) book.slots[index] = slot;
  book.selected = index;
  const normalized = cleanExecutionPresets(chain, book, settings), values = normalized.slots[index].values;
  const next = { ...settings, ...values, executionPresets: normalized };
  if (chain === 'solana' && settings.sniper) next.sniper = { ...settings.sniper, ...Object.fromEntries(Object.entries(values).filter(([key]) => Object.hasOwn(settings.sniper, key))) };
  return next;
}
export function appliedExecutionValues(chain, settings) {
  if (settings.executionPresets?.selected == null) return null;
  cleanExecutionPresets(chain, settings.executionPresets, settings);
  // Later manual edits must not silently restore LP/MM's legacy automatic fees.
  return executionValues(chain, settings);
}
