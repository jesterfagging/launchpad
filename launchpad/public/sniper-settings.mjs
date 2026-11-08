export const sniperDefaults = () => ({
  developers: '', funding: 'sol', amountMode: 'fixed', buyAmount: '0.05', randomMin: '0.03', randomMax: '0.07',
  sellMode: 'percent', mirrorFraction: true, percentStep: '25', marketcapStep: '100000', sellPercent: '100',
  prioritySol: '0.0003', jitoSol: '0', heliusSol: '0', senderTier: 'swqos', sendRpc: true,
});
export const sniperFields = Object.keys(sniperDefaults()).filter(k => k !== 'developers');
export function cleanSniper(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid launch-sniping settings.');
  const out = sniperDefaults();
  for (const [key, fallback] of Object.entries(out)) if (value[key] !== undefined) {
    if (typeof fallback === 'boolean') {
      if (typeof value[key] !== 'boolean') throw Error(`Invalid sniper setting: ${key}.`);
      out[key] = value[key];
    } else {
      if (!['string', 'number'].includes(typeof value[key]) || String(value[key]).length > (key === 'developers' ? 10000 : 100)) throw Error(`Invalid sniper setting: ${key}.`);
      out[key] = String(value[key]);
    }
  }
  const addresses = [...new Set(out.developers.split(/[\s,]+/).filter(Boolean))];
  if (addresses.length > 100 || addresses.some(v => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v))) throw Error('Enter up to 100 developer public addresses.');
  out.developers = addresses.join('\n'); return out;
}
export function sniperRunSettings(raw) {
  const s = cleanSniper(raw.sniper);
  return { ...raw, ...s, leads: s.developers, sniperMode: true };
}
