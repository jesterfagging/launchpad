// Pump.fun launch-option settings (v71.35): Diamond Hands, Earned and Insured.
// Shared by the launch page, the server and the coin page; browser-safe, no
// Node imports. A creator's numbers are validated here once, written on the
// launch by the server and never change afterwards. Nothing here signs,
// spends or reads the chain: the rules themselves run in the Pump.fun Classic
// service (holder payouts, daily market-cap records, sweeps and refunds).
export const PUMP_OPTION_VERSION = 1;
export const PUMP_OPTION_DAY_MS = 86400000;
const setting = (key, label, { min, max, step = 1, value, unit = '', options = null, labels = null, hint = '' }) => Object.freeze({ key, label, min, max, step, value, unit, options: options ? Object.freeze(options) : null, labels: labels ? Object.freeze(labels) : null, hint });

export const PUMP_OPTIONS = Object.freeze({
  diamond_hands: Object.freeze({
    id: 'diamond_hands', name: 'Diamond Hands',
    summary: 'Holder rewards that skip sellers and grow with every payout a wallet holds through.',
    settings: Object.freeze([
      setting('streakBonusPercent', 'Bonus per payout held', { min: 0, max: 50, step: 1, value: 10, unit: '%', hint: 'added to a wallet’s share for each consecutive payout it held through' }),
      setting('maxBonusPercent', 'Bonus cap', { min: 0, max: 400, step: 5, value: 100, unit: '%', hint: '100% = up to double the share' }),
    ]),
  }),
  earned: Object.freeze({
    id: 'earned', name: 'Earned',
    summary: 'Creator fees in escrow, released only if the coin holds its value through probation.',
    settings: Object.freeze([
      setting('probationDays', 'Probation', { min: 7, max: 90, step: 1, value: 30, unit: 'days', hint: 'counted from the coin’s creation' }),
      setting('floorPercent', 'Floor', { min: 10, max: 200, step: 5, value: 50, unit: '% of the baseline market cap', hint: 'a daily record below the floor fails the coin' }),
    ]),
  }),
  insured: Object.freeze({
    id: 'insured', name: 'Insured',
    summary: 'A share of creator fees builds a refund pot for holders in case the coin never graduates.',
    settings: Object.freeze([
      setting('coveragePercent', 'Coverage', { min: 10, max: 100, step: 5, value: 50, unit: '% of your creator-fee share', hint: 'kept as the refund pot; the rest is paid to you' }),
      setting('deadlineDays', 'Graduation deadline', { min: 7, max: 90, step: 1, value: 30, unit: 'days', hint: 'counted from the coin’s creation' }),
      setting('onGraduation', 'If it graduates in time', { min: 0, max: 1, value: 0, options: [0, 1], labels: ['The pot is released to you', 'The pot is paid to holders as a bonus'] }),
    ]),
  }),
});
export const PUMP_OPTION_IDS = Object.freeze(Object.keys(PUMP_OPTIONS));
export const pumpOptionById = id => Object.hasOwn(PUMP_OPTIONS, id) ? PUMP_OPTIONS[id] : null;

const error = (message, code = 400) => Object.assign(Error(message), { statusCode: code });
const stepOk = (number, field) => { const steps = (number - field.min) / field.step; return Math.abs(steps - Math.round(steps)) <= 1e-6 * Math.max(1, Math.abs(steps)); };

/** Validated numbers for one option (unknown keys dropped, absent keys take defaults). Throws 400. */
export function normalizePumpOption(id, raw) {
  const item = pumpOptionById(id); if (!item) throw error('Choose Diamond Hands, Earned or Insured for option settings.');
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}, out = {};
  for (const field of item.settings) {
    const given = input[field.key]; if (given === undefined || given === null || given === '') { out[field.key] = field.value; continue; }
    const number = Number(given);
    if (!Number.isFinite(number) || number < field.min || number > field.max || (field.options && !field.options.includes(number)) || (!field.options && !stepOk(number, field))) throw error(`${item.name}: ${field.label} must be ${field.options ? 'one of ' + field.options.join(', ') : `between ${field.min} and ${field.max}`}${field.unit && !field.options ? ' ' + field.unit : ''}.`);
    out[field.key] = number;
  }
  if (id === 'diamond_hands' && out.maxBonusPercent > 0 && out.streakBonusPercent === 0) throw error('Diamond Hands: set a bonus per payout, or set the cap to 0% for streaks without a bonus.');
  return out;
}

/**
 * The creator's option from a launch form: `{ settings }` (or the settings themselves) → `{ version, kind, settings }`
 * for a mode that takes settings, null for one that does not (which then refuses any settings sent). Throws 400.
 */
export function pumpOptionRequest(mode, raw) {
  const item = pumpOptionById(mode);
  if (!item) { if (raw !== undefined && raw !== null && raw !== '' && !(typeof raw === 'object' && !Object.keys(raw).length)) throw error('Option settings require Diamond Hands, Earned or Insured.'); return null; }
  const settings = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.settings && typeof raw.settings === 'object' ? raw.settings : raw;
  return { version: PUMP_OPTION_VERSION, kind: mode, settings: normalizePumpOption(mode, settings) };
}

// ---- Diamond Hands maths --------------------------------------------------------------------------------------
/** A wallet's share multiplier in basis points for its streak (1 = its first payout): 10000 + bonus × (streak − 1), capped. */
export function diamondMultiplierBps(streak, settings) {
  const s = normalizePumpOption('diamond_hands', settings), n = Math.max(1, Math.floor(Number(streak) || 1));
  return 10000 + Math.min(s.streakBonusPercent * 100 * (n - 1), s.maxBonusPercent * 100);
}
/** The streak at which the cap is reached (1 when there is no bonus). */
export function diamondCapStreak(settings) {
  const s = normalizePumpOption('diamond_hands', settings);
  return s.streakBonusPercent > 0 && s.maxBonusPercent > 0 ? 1 + Math.ceil(s.maxBonusPercent / s.streakBonusPercent) : 1;
}

// ---- Earned and Insured maths ---------------------------------------------------------------------------------
const big = value => typeof value === 'bigint' ? value : BigInt(String(value ?? '0'));
/** The market cap (raw quote units) a daily record must reach: the baseline times the floor. */
export function earnedFloor(baseline, settings) { const s = normalizePumpOption('earned', settings); return big(baseline) * BigInt(s.floorPercent) / 100n; }
/** When the probation ends, from the coin's creation time. */
export function earnedProbationEnd(liveAt, settings) { const s = normalizePumpOption('earned', settings); return Number(liveAt) + s.probationDays * PUMP_OPTION_DAY_MS; }
/** The part of one creator-fee receipt kept as the refund pot. */
export function insuredPotShare(amount, settings) { const s = normalizePumpOption('insured', settings); return big(amount) * BigInt(s.coveragePercent) / 100n; }
export function insuredDeadline(liveAt, settings) { const s = normalizePumpOption('insured', settings); return Number(liveAt) + s.deadlineDays * PUMP_OPTION_DAY_MS; }
export function insuredGraduationTarget(settings) { return normalizePumpOption('insured', settings).onGraduation === 1 ? 'holders' : 'developer'; }

/** Plain sentences with the creator's numbers filled in, for the launch review, coin pages and receipts. */
export function describePumpOption(id, settings = {}) {
  if (!pumpOptionById(id)) return '';
  const s = normalizePumpOption(id, settings);
  switch (id) {
    case 'diamond_hands': return s.streakBonusPercent > 0 && s.maxBonusPercent > 0
      ? `Payouts skip any wallet that sold since its last payout. Each consecutive payout a wallet holds through adds ${s.streakBonusPercent}% to its share, up to ${s.maxBonusPercent}% (reached at a streak of ${diamondCapStreak(s)}).`
      : 'Payouts skip any wallet that sold since its last payout. Streaks are counted but do not change shares.';
    case 'earned': return `Creator fees stay in escrow for ${s.probationDays} days from launch. Launchpad records the market cap once a day; a record below ${s.floorPercent}% of the day-one baseline fails the coin, and the escrow and every later fee go to holders. Passing releases the escrow to the creator, who then receives every later fee.`;
    case 'insured': return `${s.coveragePercent}% of the creator’s fee share is kept as a refund pot; the rest is paid to the creator. If the coin has not graduated within ${s.deadlineDays} days of launch, the pot refunds holders and the coverage share keeps paying them. If it graduates in time, the pot ${s.onGraduation === 1 ? 'is paid to holders as a bonus' : 'is released to the creator'} and every later fee goes to the creator.`;
    default: return '';
  }
}
