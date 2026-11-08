// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Oscillator
/// @notice The physics rules' math (breathing_cap, momentum, resonance, coupled_resonator), ported from the Solana hook
/// program's `osc.rs`: a quarter-wave sine table in 16.16 fixed point, phases in 1/65536 of a cycle, energies in
/// millionths (1_000_000 = 1.0) and exponential decay by squaring in 1e12 fixed point. Integer only; every input that
/// passed the rule validation (periods ≥ 1, percentages ≤ 100) is safe.
library Oscillator {
    uint256 internal constant ENERGY_ONE = 1_000_000;
    uint256 internal constant PHASE_CYCLE = 65_536;
    uint256 internal constant PHASE_QUARTER = 16_384;
    int256 internal constant Q16_ONE = 65_536;
    uint256 internal constant DECAY_CUTOFF_SECS = 600;
    uint256 internal constant DECAY_SCALE = 1_000_000_000_000;
    uint256 internal constant BPS = 10_000;

    /// @dev The shared oscillator state of a coin (the three energy rules are mutually exclusive).
    struct State {
        uint64 energy;
        uint64 energy2;
        uint64 phase;
        uint64 ts;
    }

    /// @dev `round(65536 × sin(π/2 × i / 256))` for i = 0..=256: a quarter wave in 16.16 fixed point (1024 table steps
    /// per cycle), the same 257 entries as the hook program's `SIN_Q`. Entries 0..255 are two bytes each in SIN_TABLE;
    /// entry 256 is 65536.
    bytes internal constant SIN_TABLE = hex"00000192032404b6064807da096c0afe0c900e210fb3114412d5146615f7178719181aa81c381dc71f5620e5227424022590271e28ab2a382bc42d502edc306731f1337c3505368e3817399f3b273cae3e343fba413f42c3444745cb474d48cf4a504bd14d504ecf504d51cb534854c3563e57b959325aaa5c225d995f0f608461f8636b64dd664e67be692d6a9b6c086d746edf704971b2731a748075e6774a78ad7a107b707cd07e2f7f8c80e88243839c84f5864c87a188f68a498b9a8ceb8e3a8f8890d4921f936894b095f7973c988099c29b039c429d809ebc9ff7a130a268a39ea4d2a605a736a866a994aac1abebad14ae3caf62b086b1a8b2c9b3e8b505b620b73ab852b968ba7dbb8fbca0bdafbebcbfc7c0d1c1d8c2dec3e2c4e4c5e4c6e2c7dec8d9c9d1cac7cbbcccaecd9fce8ecf7ad065d14dd234d318d3fbd4dbd5bad696d770d848d91ed9f2dac4db94dc62dd2dddf7debedf83e046e107e1c6e282e33ce3f4e4aae55ee610e6bfe76ce817e8bfe966ea0aeaabeb4bebe8ec83ed1cedb3ee47eed9ef68eff5f080f109f18ff213f295f314f391f40cf484f4faf56ef5dff64ef6baf724f78cf7f1f854f8b4f913f96ef9c8fa1ffa73fac5fb15fb62fbadfbf5fc3bfc7ffcc0fcfefd3bfd74fdacfde1fe13fe43fe71fe9cfec4feebff0eff30ff4eff6bff85ff9cffb1ffc4ffd4ffe1ffecfff5fffbffff";

    function sinQuarter(uint256 i) internal pure returns (uint256) {
        if (i >= 256) return 65_536;
        bytes memory t = SIN_TABLE;
        return (uint256(uint8(t[2 * i])) << 8) | uint256(uint8(t[2 * i + 1]));
    }

    /// @dev sin at one of the 1024 table steps of a cycle, in 16.16.
    function sinStep(uint256 tableStep) internal pure returns (int256) {
        tableStep = tableStep % 1024;
        uint256 i = tableStep & 255;
        uint256 quarter = tableStep >> 8;
        if (quarter == 0) return int256(sinQuarter(i));
        if (quarter == 1) return int256(sinQuarter(256 - i));
        if (quarter == 2) return -int256(sinQuarter(i));
        return -int256(sinQuarter(256 - i));
    }

    /// @dev `sin(2π × phase / 65536)` in 16.16 fixed point, linearly interpolated between table steps (64 phase units apart).
    function sinQ16(uint256 phase) internal pure returns (int256) {
        uint256 p = phase % PHASE_CYCLE;
        uint256 s = p >> 6;
        int256 a = sinStep(s);
        int256 b = sinStep(s + 1);
        return a + (b - a) * int256(p & 63) / 64;
    }

    /// @dev `cos(2π × phase / 65536)` in 16.16 fixed point.
    function cosQ16(uint256 phase) internal pure returns (int256) {
        return sinQ16((phase + PHASE_QUARTER) % PHASE_CYCLE);
    }

    /// @dev Phase of `elapsed` seconds inside a cycle of `period` seconds (0 when period is 0).
    function phaseInCycle(uint256 elapsed, uint256 period) internal pure returns (uint256) {
        if (period == 0) return 0;
        return (elapsed % period) * PHASE_CYCLE / period;
    }

    /// @dev `phase + dt × 65536 / period`, modulo one cycle.
    function advancePhase(uint256 phase, uint256 dt, uint256 period) internal pure returns (uint256) {
        if (period == 0) return phase % PHASE_CYCLE;
        uint256 advance = (dt * PHASE_CYCLE / period) % PHASE_CYCLE;
        return (phase % PHASE_CYCLE + advance) % PHASE_CYCLE;
    }

    /// @dev `(1 + cos(2π × elapsed / beat)) / 2` in 16.16: 65536 exactly on the beat, 0 half way between beats.
    function alignmentQ16(uint256 elapsed, uint256 beat) internal pure returns (uint256) {
        return uint256((Q16_ONE + cosQ16(phaseInCycle(elapsed, beat))) / 2);
    }

    /// @dev `base^exp` in DECAY_SCALE fixed point, by squaring.
    function powScaled(uint256 base, uint256 exp) internal pure returns (uint256 result) {
        result = DECAY_SCALE;
        while (exp > 0) {
            if (exp & 1 == 1) result = result * base / DECAY_SCALE;
            base = base * base / DECAY_SCALE;
            exp >>= 1;
        }
    }

    /// @dev `(1 − pct/100)^dt` in DECAY_SCALE fixed point. No loss for pct 0; zero after DECAY_CUTOFF_SECS idle seconds
    /// when pct ≥ 1 (0.99^600 < 0.3 %).
    function decayFactor(uint256 pctPerSec, uint256 dt) internal pure returns (uint256) {
        if (pctPerSec == 0 || dt == 0) return DECAY_SCALE;
        if (pctPerSec >= 100 || dt >= DECAY_CUTOFF_SECS) return 0;
        return powScaled((100 - pctPerSec) * DECAY_SCALE / 100, dt);
    }

    function applyDecay(uint256 energy, uint256 factor) internal pure returns (uint256) {
        return energy * factor / DECAY_SCALE;
    }

    /// @dev A buy's energy kick: `energyPct/100 × alignment × min(1, amount / baseAmount)` of full energy, added and capped at 1.0.
    function kick(uint256 energy, uint256 energyPct, uint256 amount, uint256 baseAmount, uint256 alignmentQ16_) internal pure returns (uint256) {
        uint256 ratioQ16 = (baseAmount == 0 || amount >= baseAmount) ? uint256(Q16_ONE) : amount * uint256(Q16_ONE) / baseAmount;
        uint256 alignment = alignmentQ16_ > uint256(Q16_ONE) ? uint256(Q16_ONE) : alignmentQ16_;
        uint256 add = energyPct * (ENERGY_ONE / 100) * ratioQ16 * alignment / (uint256(Q16_ONE) * uint256(Q16_ONE));
        uint256 next = energy + add;
        return next > ENERGY_ONE ? ENERGY_ONE : next;
    }

    /// @dev `clamp(base × (1 + energy × sin), floor, 10000)` with `sin` in 16.16 and `energy` in millionths.
    function capWithSwing(uint256 baseBps, uint256 energy, int256 sin, uint256 floorBps) internal pure returns (uint256) {
        int256 delta = int256(baseBps) * int256(energy) * sin / (int256(ENERGY_ONE) * Q16_ONE);
        return clampCap(int256(baseBps) + delta, floorBps);
    }

    /// @dev `clamp(base × (1 + energy), floor, 10000)`.
    function capWithEnergy(uint256 baseBps, uint256 energy, uint256 floorBps) internal pure returns (uint256) {
        return clampCap(int256(baseBps) + int256(baseBps * energy / ENERGY_ONE), floorBps);
    }

    /// @dev `clamp(base + base × swingPct/100 × sin, floor, 10000)` (breathing cap).
    function breathingCap(uint256 baseBps, uint256 swingPct, int256 sin, uint256 floorBps) internal pure returns (uint256) {
        int256 delta = int256(baseBps) * int256(swingPct) * sin / (100 * Q16_ONE);
        return clampCap(int256(baseBps) + delta, floorBps);
    }

    function clampCap(int256 cap, uint256 floorBps) internal pure returns (uint256) {
        int256 lo = int256(floorBps > BPS ? BPS : floorBps);
        if (cap < lo) cap = lo;
        if (cap > int256(BPS)) cap = int256(BPS);
        return uint256(cap);
    }

    /// @dev One coupled time step of `dt` seconds: both energies decay by `dampingPct` per second while a share
    /// `couplingPct/100 × (E1 − E2)/2` flows from the higher to the lower each second. Closed form: the sum decays by
    /// d^dt and the difference by (d × (1 − c))^dt.
    function coupledStep(uint256 e1, uint256 e2, uint256 couplingPct, uint256 dampingPct, uint256 dt) internal pure returns (uint256 first, uint256 second) {
        if (dt == 0) return (e1, e2);
        uint256 decay = decayFactor(dampingPct, dt);
        uint256 sum = (e1 + e2) * decay / DECAY_SCALE;
        uint256 diffFactor = decay * decayFactor(couplingPct, dt) / DECAY_SCALE;
        int256 diff = (int256(e1) - int256(e2)) * int256(diffFactor) / int256(DECAY_SCALE);
        int256 a = (int256(sum) + diff) / 2;
        int256 b = (int256(sum) - diff) / 2;
        first = a < 0 ? 0 : uint256(a);
        second = b < 0 ? 0 : uint256(b);
        if (first > ENERGY_ONE) first = ENERGY_ONE;
        if (second > ENERGY_ONE) second = ENERGY_ONE;
    }

    /// @dev Advances the state to `now`: decay over the idle seconds (plus the coupling flow when `couplingPct` is
    /// nonzero) and the phase advance by `period`. The first call (`ts == 0`) only stamps the time.
    function step(State memory o, uint256 nowTs, uint256 period, uint256 dampingPct, uint256 couplingPct) internal pure {
        uint256 dt = o.ts == 0 ? 0 : (nowTs > o.ts ? nowTs - o.ts : 0);
        if (dt > 0) {
            if (couplingPct > 0) {
                (uint256 a, uint256 b) = coupledStep(o.energy, o.energy2, couplingPct, dampingPct, dt);
                o.energy = uint64(a);
                o.energy2 = uint64(b);
            } else {
                uint256 f = decayFactor(dampingPct, dt);
                o.energy = uint64(applyDecay(o.energy, f));
                o.energy2 = uint64(applyDecay(o.energy2, f));
            }
            o.phase = uint64(advancePhase(o.phase, dt, period));
        }
        o.ts = uint64(nowTs);
    }
}
