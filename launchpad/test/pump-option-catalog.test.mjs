// The shared Pump.fun launch-option catalogue (v71.35): validation, defaults,
// ranges, the wording with the creator's numbers, and the pure maths the
// server runs (streak multipliers, the Earned floor, the Insured pot share).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PUMP_OPTIONS, PUMP_OPTION_IDS, PUMP_OPTION_DAY_MS, normalizePumpOption, pumpOptionRequest, diamondMultiplierBps, diamondCapStreak, earnedFloor, earnedProbationEnd, insuredPotShare, insuredDeadline, insuredGraduationTarget, describePumpOption } from '../public/pump-option-catalog.mjs';

test('every option has settings with ranges, steps and defaults inside the range', () => {
  assert.deepEqual(PUMP_OPTION_IDS, ['diamond_hands', 'earned', 'insured']);
  for (const id of PUMP_OPTION_IDS) for (const field of PUMP_OPTIONS[id].settings) {
    assert.ok(field.value >= field.min && field.value <= field.max, `${id}.${field.key} default in range`);
    if (field.options) assert.ok(field.options.includes(field.value) && field.labels.length === field.options.length);
    else assert.ok(field.step > 0 && Number.isInteger((field.value - field.min) / field.step * 1e6) === true || Math.abs(((field.value - field.min) / field.step) % 1) < 1e-9, `${id}.${field.key} default on the step`);
  }
  assert.ok(Object.isFrozen(PUMP_OPTIONS) && Object.isFrozen(PUMP_OPTIONS.earned.settings));
});

test('normalize: defaults for absent keys, exact ranges and steps, unknown keys dropped, strings accepted', () => {
  assert.deepEqual(normalizePumpOption('diamond_hands', {}), { streakBonusPercent: 10, maxBonusPercent: 100 });
  assert.deepEqual(normalizePumpOption('earned', { probationDays: '45', floorPercent: 75, extra: 1 }), { probationDays: 45, floorPercent: 75 });
  assert.deepEqual(normalizePumpOption('insured', { coveragePercent: 100, deadlineDays: 7, onGraduation: '1' }), { coveragePercent: 100, deadlineDays: 7, onGraduation: 1 });
  assert.throws(() => normalizePumpOption('earned', { probationDays: 91 }), /Probation must be between 7 and 90 days/);
  assert.throws(() => normalizePumpOption('earned', { floorPercent: 52 }), /Floor must be between 10 and 200/, 'off the 5% step');
  assert.throws(() => normalizePumpOption('insured', { coveragePercent: 5 }), /Coverage must be between 10 and 100/);
  assert.throws(() => normalizePumpOption('insured', { onGraduation: 2 }), /one of 0, 1/);
  assert.throws(() => normalizePumpOption('diamond_hands', { streakBonusPercent: 60 }), /between 0 and 50/);
  assert.throws(() => normalizePumpOption('diamond_hands', { streakBonusPercent: 0, maxBonusPercent: 50 }), /set a bonus per payout/);
  assert.deepEqual(normalizePumpOption('diamond_hands', { streakBonusPercent: 0, maxBonusPercent: 0 }), { streakBonusPercent: 0, maxBonusPercent: 0 }, 'streaks without a bonus are allowed');
  assert.throws(() => normalizePumpOption('creator', {}), /Choose Diamond Hands, Earned or Insured/);
  assert.throws(() => normalizePumpOption('earned', { probationDays: 'x' }), /Probation must be/);
});

test('request: wraps validated settings for option modes, refuses settings on other modes, accepts flat or nested input', () => {
  assert.deepEqual(pumpOptionRequest('earned', undefined), { version: 1, kind: 'earned', settings: { probationDays: 30, floorPercent: 50 } });
  assert.deepEqual(pumpOptionRequest('insured', { settings: { coveragePercent: 20 } }).settings, { coveragePercent: 20, deadlineDays: 30, onGraduation: 0 });
  assert.deepEqual(pumpOptionRequest('insured', { coveragePercent: 20 }).settings.coveragePercent, 20);
  assert.equal(pumpOptionRequest('creator', undefined), null); assert.equal(pumpOptionRequest('holders', {}), null); assert.equal(pumpOptionRequest('holders', ''), null);
  assert.throws(() => pumpOptionRequest('creator', { settings: { probationDays: 30 } }), /Option settings require Diamond Hands, Earned or Insured/);
  assert.throws(() => pumpOptionRequest('earned', { settings: { floorPercent: 7 } }), /Floor must be between 10 and 200/);
});

test('Diamond Hands maths: the first payout has no bonus, each streak adds the bonus, the cap holds', () => {
  const s = { streakBonusPercent: 10, maxBonusPercent: 100 };
  assert.equal(diamondMultiplierBps(1, s), 10000); assert.equal(diamondMultiplierBps(2, s), 11000); assert.equal(diamondMultiplierBps(11, s), 20000); assert.equal(diamondMultiplierBps(50, s), 20000);
  assert.equal(diamondMultiplierBps(0, s), 10000, 'a missing streak counts as the first payout'); assert.equal(diamondCapStreak(s), 11);
  assert.equal(diamondMultiplierBps(7, { streakBonusPercent: 25, maxBonusPercent: 60 }), 16000); assert.equal(diamondCapStreak({ streakBonusPercent: 25, maxBonusPercent: 60 }), 4);
  assert.equal(diamondMultiplierBps(9, { streakBonusPercent: 0, maxBonusPercent: 0 }), 10000); assert.equal(diamondCapStreak({ streakBonusPercent: 0, maxBonusPercent: 0 }), 1);
});

test('Earned and Insured maths: floors, deadlines, pot shares and the graduation target', () => {
  assert.equal(earnedFloor(27958993000n, { floorPercent: 50 }), 13979496500n); assert.equal(earnedFloor('1000', { floorPercent: 200 }), 2000n);
  assert.equal(earnedProbationEnd(1000, { probationDays: 7 }), 1000 + 7 * PUMP_OPTION_DAY_MS);
  assert.equal(insuredPotShare(900000000n, { coveragePercent: 40 }), 360000000n); assert.equal(insuredPotShare(1n, { coveragePercent: 40 }), 0n, 'rounds down');
  assert.equal(insuredDeadline(5, { deadlineDays: 30 }), 5 + 30 * PUMP_OPTION_DAY_MS);
  assert.equal(insuredGraduationTarget({}), 'developer'); assert.equal(insuredGraduationTarget({ onGraduation: 1 }), 'holders');
});

test('descriptions carry the creator’s numbers', () => {
  assert.equal(describePumpOption('diamond_hands', { streakBonusPercent: 20, maxBonusPercent: 60 }), 'Payouts skip any wallet that sold since its last payout. Each consecutive payout a wallet holds through adds 20% to its share, up to 60% (reached at a streak of 4).');
  assert.equal(describePumpOption('diamond_hands', { streakBonusPercent: 0, maxBonusPercent: 0 }), 'Payouts skip any wallet that sold since its last payout. Streaks are counted but do not change shares.');
  assert.match(describePumpOption('earned', { probationDays: 14, floorPercent: 75 }), /^Creator fees stay in escrow for 14 days from launch\. .*below 75% of the day-one baseline fails the coin/);
  assert.match(describePumpOption('insured', { coveragePercent: 30, deadlineDays: 21, onGraduation: 1 }), /^30% of the creator’s fee share is kept as a refund pot.*within 21 days.*paid to holders as a bonus/);
  assert.match(describePumpOption('insured', {}), /released to the creator/);
  assert.equal(describePumpOption('creator'), '');
});
