//! Oscillator math for the physics rules (breathing_cap, momentum, resonance,
//! coupled_resonator): a quarter-wave sine table in 16.16 fixed point, phases in
//! 1/65536 of a cycle, energies in millionths (1_000_000 = 1.0) and exponential
//! decay by squaring in 1e12 fixed point. Integer only, no panics for any
//! input that passed `validate_rule` (periods ≥ 1, percentages ≤ 100).

/// Energy fixed point: 1.0.
pub const ENERGY_ONE: u64 = 1_000_000;
/// Phase units per cycle.
pub const PHASE_CYCLE: u64 = 65_536;
/// Quarter of a cycle in phase units.
pub const PHASE_QUARTER: u64 = 16_384;
/// 16.16 fixed point one.
pub const Q16_ONE: i64 = 65_536;
/// Idle time after which a damped energy (damping ≥ 1 %/s) is taken as zero.
pub const DECAY_CUTOFF_SECS: u64 = 600;
/// Fixed point scale of decay factors.
pub const DECAY_SCALE: u128 = 1_000_000_000_000;
pub const BPS: u64 = 10_000;

/// `round(65536 * sin(pi/2 * i / 256))` for i = 0..=256: a quarter wave in 16.16
/// fixed point (1024 table steps per cycle). `tests::sin_table_matches_f64_sin`
/// checks every entry against `f64::sin` within one unit.
pub const SIN_Q: [u32; 257] = [
    0, 402, 804, 1206, 1608, 2010, 2412, 2814, 3216, 3617, 4019, 4420, 4821, 5222, 5623, 6023, 6424, 6824, 7224,
    7623, 8022, 8421, 8820, 9218, 9616, 10014, 10411, 10808, 11204, 11600, 11996, 12391, 12785, 13180, 13573, 13966,
    14359, 14751, 15143, 15534, 15924, 16314, 16703, 17091, 17479, 17867, 18253, 18639, 19024, 19409, 19792, 20175,
    20557, 20939, 21320, 21699, 22078, 22457, 22834, 23210, 23586, 23961, 24335, 24708, 25080, 25451, 25821, 26190,
    26558, 26925, 27291, 27656, 28020, 28383, 28745, 29106, 29466, 29824, 30182, 30538, 30893, 31248, 31600, 31952,
    32303, 32652, 33000, 33347, 33692, 34037, 34380, 34721, 35062, 35401, 35738, 36075, 36410, 36744, 37076, 37407,
    37736, 38064, 38391, 38716, 39040, 39362, 39683, 40002, 40320, 40636, 40951, 41264, 41576, 41886, 42194, 42501,
    42806, 43110, 43412, 43713, 44011, 44308, 44604, 44898, 45190, 45480, 45769, 46056, 46341, 46624, 46906, 47186,
    47464, 47741, 48015, 48288, 48559, 48828, 49095, 49361, 49624, 49886, 50146, 50404, 50660, 50914, 51166, 51417,
    51665, 51911, 52156, 52398, 52639, 52878, 53114, 53349, 53581, 53812, 54040, 54267, 54491, 54714, 54934, 55152,
    55368, 55582, 55794, 56004, 56212, 56418, 56621, 56823, 57022, 57219, 57414, 57607, 57798, 57986, 58172, 58356,
    58538, 58718, 58896, 59071, 59244, 59415, 59583, 59750, 59914, 60075, 60235, 60392, 60547, 60700, 60851, 60999,
    61145, 61288, 61429, 61568, 61705, 61839, 61971, 62101, 62228, 62353, 62476, 62596, 62714, 62830, 62943, 63054,
    63162, 63268, 63372, 63473, 63572, 63668, 63763, 63854, 63944, 64031, 64115, 64197, 64277, 64354, 64429, 64501,
    64571, 64639, 64704, 64766, 64827, 64884, 64940, 64993, 65043, 65091, 65137, 65180, 65220, 65259, 65294, 65328,
    65358, 65387, 65413, 65436, 65457, 65476, 65492, 65505, 65516, 65525, 65531, 65535, 65536,
];

/// sin at one of the 1024 table steps of a cycle, in 16.16.
fn sin_step(step: usize) -> i64 {
    let step = step % 1024;
    let i = step & 255;
    match step >> 8 {
        0 => SIN_Q[i] as i64,
        1 => SIN_Q[256 - i] as i64,
        2 => -(SIN_Q[i] as i64),
        _ => -(SIN_Q[256 - i] as i64),
    }
}

/// `sin(2 pi * phase / 65536)` in 16.16 fixed point, linearly interpolated
/// between table steps (64 phase units apart).
pub fn sin_q16(phase: u64) -> i64 {
    let p = (phase % PHASE_CYCLE) as usize;
    let step = p >> 6;
    let a = sin_step(step);
    let b = sin_step(step + 1);
    a + (b - a) * (p & 63) as i64 / 64
}

/// `cos(2 pi * phase / 65536)` in 16.16 fixed point.
pub fn cos_q16(phase: u64) -> i64 {
    sin_q16(phase.wrapping_add(PHASE_QUARTER))
}

/// Phase of `elapsed` seconds inside a cycle of `period` seconds (0 when period is 0).
pub fn phase_in_cycle(elapsed: u64, period: u64) -> u64 {
    if period == 0 {
        return 0;
    }
    ((elapsed % period) as u128 * PHASE_CYCLE as u128 / period as u128) as u64
}

/// `phase + dt × 65536 / period`, modulo one cycle.
pub fn advance_phase(phase: u64, dt: u64, period: u64) -> u64 {
    if period == 0 {
        return phase % PHASE_CYCLE;
    }
    let advance = (dt as u128 * PHASE_CYCLE as u128 / period as u128) % PHASE_CYCLE as u128;
    ((phase % PHASE_CYCLE) as u128 + advance) as u64 % PHASE_CYCLE
}

/// `(1 + cos(2 pi * elapsed / beat)) / 2` in 16.16: 65536 exactly on the beat, 0 half way between beats.
pub fn alignment_q16(elapsed: u64, beat: u64) -> u64 {
    ((Q16_ONE + cos_q16(phase_in_cycle(elapsed, beat))) / 2) as u64
}

/// `base^exp` in DECAY_SCALE fixed point, by squaring.
fn pow_scaled(mut base: u128, mut exp: u64) -> u128 {
    let mut result = DECAY_SCALE;
    while exp > 0 {
        if exp & 1 == 1 {
            result = result * base / DECAY_SCALE;
        }
        base = base * base / DECAY_SCALE;
        exp >>= 1;
    }
    result
}

/// `(1 − pct/100)^dt` in DECAY_SCALE fixed point. No loss for pct 0; zero after
/// `DECAY_CUTOFF_SECS` idle seconds when pct ≥ 1 (0.99^600 < 0.3 %).
pub fn decay_factor(pct_per_sec: u64, dt: u64) -> u128 {
    if pct_per_sec == 0 || dt == 0 {
        return DECAY_SCALE;
    }
    if pct_per_sec >= 100 || dt >= DECAY_CUTOFF_SECS {
        return 0;
    }
    pow_scaled((100 - pct_per_sec) as u128 * DECAY_SCALE / 100, dt)
}

pub fn apply_decay(energy: u64, factor: u128) -> u64 {
    (energy as u128 * factor / DECAY_SCALE) as u64
}

/// A buy's energy kick: `energy_pct/100 × alignment × min(1, amount / base_amount)`
/// of full energy, added and capped at 1.0. `alignment_q16` = 65536 for a plain kick.
pub fn kick(energy: u64, energy_pct: u64, amount: u64, base_amount: u64, alignment_q16: u64) -> u64 {
    let ratio_q16: u128 = if base_amount == 0 || amount >= base_amount { Q16_ONE as u128 } else { amount as u128 * Q16_ONE as u128 / base_amount as u128 };
    let add = energy_pct as u128 * (ENERGY_ONE as u128 / 100) * ratio_q16 * alignment_q16.min(Q16_ONE as u64) as u128 / (Q16_ONE as u128 * Q16_ONE as u128);
    (energy as u128 + add).min(ENERGY_ONE as u128) as u64
}

/// `clamp(base × (1 + energy × sin), floor, 10000)` with `sin` in 16.16 and `energy` in millionths.
pub fn cap_with_swing(base_bps: u64, energy: u64, sin: i64, floor_bps: u64) -> u64 {
    let delta = base_bps as i128 * energy as i128 * sin as i128 / (ENERGY_ONE as i128 * Q16_ONE as i128);
    clamp_cap(base_bps as i128 + delta, floor_bps)
}

/// `clamp(base × (1 + energy), floor, 10000)`.
pub fn cap_with_energy(base_bps: u64, energy: u64, floor_bps: u64) -> u64 {
    clamp_cap(base_bps as i128 + base_bps as i128 * energy as i128 / ENERGY_ONE as i128, floor_bps)
}

/// `clamp(base + base × swing_pct/100 × sin, floor, 10000)` (breathing cap).
pub fn breathing_cap(base_bps: u64, swing_pct: u64, sin: i64, floor_bps: u64) -> u64 {
    let delta = base_bps as i128 * swing_pct as i128 * sin as i128 / (100 * Q16_ONE as i128);
    clamp_cap(base_bps as i128 + delta, floor_bps)
}

fn clamp_cap(cap: i128, floor_bps: u64) -> u64 {
    cap.clamp(floor_bps.min(BPS) as i128, BPS as i128) as u64
}

/// One coupled time step of `dt` seconds: both energies decay by `damping_pct`
/// per second while a share `coupling_pct/100 × (E1 − E2)/2` flows from the
/// higher to the lower each second. Closed form: the sum decays by d^dt and the
/// difference by (d × (1 − c))^dt.
pub fn coupled_step(e1: u64, e2: u64, coupling_pct: u64, damping_pct: u64, dt: u64) -> (u64, u64) {
    if dt == 0 {
        return (e1, e2);
    }
    let decay = decay_factor(damping_pct, dt);
    let sum = (e1 as u128 + e2 as u128) * decay / DECAY_SCALE;
    let diff_factor = decay * decay_factor(coupling_pct, dt) / DECAY_SCALE;
    let diff = (e1 as i128 - e2 as i128) * diff_factor as i128 / DECAY_SCALE as i128;
    let first = ((sum as i128 + diff) / 2).max(0) as u128;
    let second = ((sum as i128 - diff) / 2).max(0) as u128;
    (first.min(ENERGY_ONE as u128) as u64, second.min(ENERGY_ONE as u128) as u64)
}

/// The shared oscillator state of the config (one set of fields; the three
/// energy rules are mutually exclusive).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Oscillator {
    pub energy: u64,
    pub energy2: u64,
    pub phase: u64,
    pub ts: i64,
}

impl Oscillator {
    /// Advances the state to `now`: decay over the idle seconds (plus the
    /// coupling flow when `coupling_pct` is nonzero) and the phase advance by
    /// `period`. The first call (`ts == 0`) only stamps the time.
    pub fn step(&mut self, now: i64, period: u64, damping_pct: u64, coupling_pct: u64) {
        let dt = if self.ts == 0 { 0 } else { now.saturating_sub(self.ts).max(0) as u64 };
        if dt > 0 {
            if coupling_pct > 0 {
                let (a, b) = coupled_step(self.energy, self.energy2, coupling_pct, damping_pct, dt);
                self.energy = a;
                self.energy2 = b;
            } else {
                let f = decay_factor(damping_pct, dt);
                self.energy = apply_decay(self.energy, f);
                self.energy2 = apply_decay(self.energy2, f);
            }
            self.phase = advance_phase(self.phase, dt, period);
        }
        self.ts = now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::f64::consts::PI;

    #[test]
    fn sin_table_matches_f64_sin() {
        assert_eq!(SIN_Q.len(), 257);
        assert_eq!(SIN_Q[0], 0);
        assert_eq!(SIN_Q[128], 46_341, "sqrt(2)/2");
        assert_eq!(SIN_Q[256], 65_536);
        for i in 0..=256 {
            let exact = 65_536.0 * (PI / 2.0 * i as f64 / 256.0).sin();
            assert!((SIN_Q[i] as f64 - exact).abs() <= 0.5 + 1e-9, "entry {} off: {} vs {}", i, SIN_Q[i], exact);
            if i > 0 {
                assert!(SIN_Q[i] >= SIN_Q[i - 1], "monotonic");
            }
        }
    }

    #[test]
    fn sin_and_cos_over_a_whole_cycle() {
        assert_eq!(sin_q16(0), 0);
        assert_eq!(sin_q16(PHASE_QUARTER), Q16_ONE);
        assert_eq!(sin_q16(2 * PHASE_QUARTER), 0);
        assert_eq!(sin_q16(3 * PHASE_QUARTER), -Q16_ONE);
        assert_eq!(sin_q16(PHASE_CYCLE), 0, "wraps");
        assert_eq!(sin_q16(PHASE_CYCLE + PHASE_QUARTER), Q16_ONE);
        assert_eq!(cos_q16(0), Q16_ONE);
        assert_eq!(cos_q16(2 * PHASE_QUARTER), -Q16_ONE);
        assert_eq!(cos_q16(PHASE_QUARTER), 0);
        assert_eq!(sin_q16(8_192), 46_341, "45 degrees");
        for phase in 0..PHASE_CYCLE {
            let x = 2.0 * PI * phase as f64 / PHASE_CYCLE as f64;
            let s = sin_q16(phase);
            let c = cos_q16(phase);
            assert!((s as f64 - 65_536.0 * x.sin()).abs() <= 2.0, "sin at {}: {} vs {}", phase, s, 65_536.0 * x.sin());
            assert!((c as f64 - 65_536.0 * x.cos()).abs() <= 2.0, "cos at {}: {} vs {}", phase, c, 65_536.0 * x.cos());
            assert!((-Q16_ONE..=Q16_ONE).contains(&s));
            assert_eq!(sin_q16(phase + PHASE_CYCLE / 2), -s, "odd symmetry");
        }
    }

    #[test]
    fn phases_and_alignment() {
        assert_eq!(phase_in_cycle(0, 300), 0);
        assert_eq!(phase_in_cycle(75, 300), PHASE_QUARTER);
        assert_eq!(phase_in_cycle(150, 300), 2 * PHASE_QUARTER);
        assert_eq!(phase_in_cycle(300, 300), 0);
        assert_eq!(phase_in_cycle(10, 0), 0, "degenerate period");
        assert_eq!(advance_phase(0, 30, 120), PHASE_QUARTER);
        assert_eq!(advance_phase(3 * PHASE_QUARTER, 30, 120), 0, "wraps modulo a cycle");
        assert_eq!(advance_phase(100, 120 * 1_000_000, 120), 100, "whole cycles cancel");
        assert_eq!(advance_phase(100, u64::MAX, 1), 100, "a one-second period: every second is a whole cycle (no overflow either)");
        assert_eq!(advance_phase(100, u64::MAX, 7), (100 + (u64::MAX as u128 * 65_536 / 7) % 65_536) as u64 % PHASE_CYCLE);
        assert_eq!(advance_phase(70_000, 0, 120), 70_000 - PHASE_CYCLE);
        assert_eq!(alignment_q16(0, 60), Q16_ONE as u64, "on the beat");
        assert_eq!(alignment_q16(60, 60), Q16_ONE as u64);
        assert_eq!(alignment_q16(30, 60), 0, "half way between beats");
        assert_eq!(alignment_q16(15, 60), Q16_ONE as u64 / 2);
        assert!(alignment_q16(5, 60) > 55_000 && alignment_q16(5, 60) < Q16_ONE as u64);
    }

    #[test]
    fn decay_by_squaring_matches_the_formula() {
        assert_eq!(decay_factor(0, 1_000_000), DECAY_SCALE, "no damping, no decay");
        assert_eq!(decay_factor(8, 0), DECAY_SCALE);
        assert_eq!(decay_factor(100, 1), 0);
        assert_eq!(decay_factor(1, 600), 0, "cut off after 600 idle seconds");
        assert_ne!(decay_factor(1, 599), 0);
        for (pct, dt) in [(8u64, 1u64), (8, 10), (2, 100), (1, 599), (40, 5), (20, 30), (99, 3)] {
            let exact = (1.0 - pct as f64 / 100.0).powi(dt as i32) * DECAY_SCALE as f64;
            let got = decay_factor(pct, dt) as f64;
            assert!((got - exact).abs() <= exact * 1e-9 + 1.0, "{}% x {}s: {} vs {}", pct, dt, got, exact);
        }
        assert_eq!(apply_decay(ENERGY_ONE, decay_factor(8, 1)), 920_000);
        assert_eq!(apply_decay(500_000, decay_factor(50, 2)), 125_000);
        assert_eq!(apply_decay(ENERGY_ONE, DECAY_SCALE), ENERGY_ONE);
    }

    #[test]
    fn kicks_and_caps() {
        let base = 10_000_000u64;
        assert_eq!(kick(0, 40, base, base, Q16_ONE as u64), 400_000, "a buy the size of the base cap adds 40%");
        assert_eq!(kick(0, 40, 2 * base, base, Q16_ONE as u64), 400_000, "larger buys add no more");
        assert_eq!(kick(0, 40, base / 2, base, Q16_ONE as u64), 200_000);
        assert_eq!(kick(900_000, 40, base, base, Q16_ONE as u64), ENERGY_ONE, "capped at 1.0");
        assert_eq!(kick(0, 100, base, base, Q16_ONE as u64), ENERGY_ONE);
        assert_eq!(kick(0, 40, base, base, 0), 0, "off the beat adds nothing");
        assert_eq!(kick(0, 40, base, base, Q16_ONE as u64 / 2), 200_000);
        assert_eq!(kick(0, 40, 1, 0, Q16_ONE as u64), 400_000, "a zero base counts as a full-size buy");
        assert_eq!(cap_with_swing(100, 0, Q16_ONE, 25), 100, "at rest the cap is the base");
        assert_eq!(cap_with_swing(100, ENERGY_ONE, Q16_ONE, 25), 200, "full energy at the peak doubles it");
        assert_eq!(cap_with_swing(100, ENERGY_ONE, -Q16_ONE, 25), 25, "the trough is floored");
        assert_eq!(cap_with_swing(100, 500_000, Q16_ONE / 2, 25), 125);
        assert_eq!(cap_with_swing(9_000, ENERGY_ONE, Q16_ONE, 25), 10_000, "never above 100%");
        assert_eq!(cap_with_energy(100, 0, 25), 100);
        assert_eq!(cap_with_energy(100, 500_000, 25), 150);
        assert_eq!(cap_with_energy(100, ENERGY_ONE, 25), 200);
        assert_eq!(cap_with_energy(6_000, ENERGY_ONE, 25), 10_000);
        assert_eq!(breathing_cap(100, 60, Q16_ONE, 10), 160);
        assert_eq!(breathing_cap(100, 60, -Q16_ONE, 10), 40);
        assert_eq!(breathing_cap(100, 60, 0, 10), 100);
        assert_eq!(breathing_cap(100, 100, -Q16_ONE, 10), 10, "floored");
        assert_eq!(breathing_cap(100, 100, Q16_ONE, 10), 200);
        assert_eq!(breathing_cap(100, 60, Q16_ONE / 2, 10), 130);
    }

    #[test]
    fn coupled_steps_conserve_and_equalise() {
        // no damping: the sum is conserved and the difference decays by (1 - c)^dt
        let (a, b) = coupled_step(ENERGY_ONE, 0, 20, 0, 1);
        assert_eq!((a, b), (900_000, 100_000), "20% of the difference/2 flows across");
        let (a, b) = coupled_step(ENERGY_ONE, 0, 20, 0, 2);
        assert_eq!(a + b, ENERGY_ONE);
        assert_eq!((a, b), (820_000, 180_000));
        let (a, b) = coupled_step(ENERGY_ONE, 0, 20, 0, 600);
        assert_eq!((a, b), (500_000, 500_000), "long idle: equalised, nothing lost");
        // damping: both lose, the sum decays by d^dt
        let (a, b) = coupled_step(ENERGY_ONE, 0, 20, 2, 1);
        assert_eq!(a + b, 980_000);
        assert_eq!((a, b), (882_000, 98_000));
        let (a, b) = coupled_step(600_000, 600_000, 20, 2, 1);
        assert_eq!((a, b), (588_000, 588_000), "equal energies only decay");
        let (a, b) = coupled_step(0, ENERGY_ONE, 50, 0, 1);
        assert_eq!((a, b), (250_000, 750_000), "flows the other way too");
        assert_eq!(coupled_step(700_000, 300_000, 20, 2, 0), (700_000, 300_000));
        let (a, b) = coupled_step(ENERGY_ONE, ENERGY_ONE, 60, 20, 650);
        assert_eq!((a, b), (0, 0), "damped away after the cutoff");
        for dt in 0..200u64 {
            let (a, b) = coupled_step(ENERGY_ONE, 123_456, 20, 2, dt);
            assert!(a <= ENERGY_ONE && b <= ENERGY_ONE && a >= b);
        }
    }

    #[test]
    fn oscillator_step() {
        let mut o = Oscillator::default();
        o.step(1_000, 120, 8, 0);
        assert_eq!(o, Oscillator { energy: 0, energy2: 0, phase: 0, ts: 1_000 }, "the first step only stamps the time");
        o.energy = ENERGY_ONE;
        o.step(1_030, 120, 8, 0);
        assert_eq!(o.ts, 1_030);
        assert_eq!(o.phase, PHASE_QUARTER, "30 s of a 120 s period");
        assert_eq!(o.energy, apply_decay(ENERGY_ONE, decay_factor(8, 30)));
        o.step(1_030, 120, 8, 0);
        assert_eq!(o.phase, PHASE_QUARTER, "no time, no change");
        o.step(900, 120, 8, 0);
        assert_eq!(o.ts, 900, "a clock running backwards is stamped but does not decay");
        o.step(1_000_000, 120, 8, 0);
        assert_eq!(o.energy, 0);
        // coupled
        let mut c = Oscillator { energy: ENERGY_ONE, energy2: 0, phase: 0, ts: 500 };
        c.step(501, 180, 2, 20);
        assert_eq!((c.energy, c.energy2), (882_000, 98_000));
        assert_eq!(c.phase, PHASE_CYCLE / 180);
    }
}
