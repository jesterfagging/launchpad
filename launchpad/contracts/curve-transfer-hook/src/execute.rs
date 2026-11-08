//! The rule engine: pure functions over plain inputs, so every rule boundary is
//! unit-testable on a host toolchain without accounts or a validator.
//!
//! `lib.rs` loads the accounts of an Execute call into a [`Transfer`], a
//! [`ConfigState`] and two [`WalletView`]s, calls [`evaluate`], and writes back
//! whatever changed. Nothing here allocates.
//!
//! Vocabulary (from the brief): a transfer whose source token account is a
//! venue (the DBC base vault) is a *buy*, one whose destination is a venue is a
//! *sell*, anything else is a *send* (wallet-to-wallet). An *exempt* owner
//! (creator, Launchpad partner authority, leftover receiver, DAMM v2 pool authority)
//! skips every rule when the transfer touches a venue (fee claims, settlement);
//! sends by or to an exempt owner are still checked except where a rule says the
//! creator is exempt (the destination-side rules skip an exempt receiver). The
//! owner of a venue account itself (the DBC pool authority) is never consulted:
//! it signs every buy, so testing it would exempt every trade. Balances are
//! post-transfer because Token-2022 calls the hook after moving the funds;
//! `pre_balance = source post-balance + amount`. Zero-amount transfers are
//! no-ops. The clock (`started_at`, `start_slot`) starts at the first venue
//! transfer.
//!
//! Evaluation order: clock and oscillator bookkeeping (every venue transfer),
//! then — unless the transfer is skipped — every rule's check in config order
//! (the first failure wins, with that rule's code), then every rule's state
//! update. A rule's check therefore sees the state before this transfer.

use crate::calendar;
use crate::errors::HookError;
use crate::osc::{self, Oscillator};
pub use crate::state::ConfigState;
use crate::state::{Rule, WalletState, MAX_RULES, TURN_BUY, TURN_SELL, ZERO_KEY};
use crate::sysvar::{AppMark, APP_MARK_PROGRAM, APP_MARK_PROGRAM_ACCOUNT, APP_MARK_SIGNER};

pub const BPS: u64 = 10_000;
pub const PPM: u64 = 1_000_000;
/// Highest rule kind in the catalogue (v71.35: 27, the two app-only rules).
pub const MAX_KIND: u8 = 27;
/// Transfers signed directly from a wallet run Token-2022 at stack height 1 and
/// the hook at 2; through the pool or a router the hook runs at 3 or deeper.
pub const MIN_DEX_STACK_HEIGHT: u64 = 3;

pub const KIND_ALLOWLIST: u8 = 1;
pub const KIND_HOLDER_GATED: u8 = 2;
pub const KIND_HOLDER_VESTING: u8 = 3;
pub const KIND_ANTI_DUMP: u8 = 4;
pub const KIND_SLIDING_CAPS: u8 = 5;
pub const KIND_GRADUATED_SELL_CAPS: u8 = 6;
pub const KIND_MAX_PER_WALLET: u8 = 7;
pub const KIND_RISING_MAX_PER_WALLET: u8 = 8;
pub const KIND_CHAPTERS: u8 = 9;
pub const KIND_TRADE_GUARD: u8 = 10;
pub const KIND_ANTI_BUNDLE: u8 = 11;
pub const KIND_VENUE_LOCKED: u8 = 12;
pub const KIND_MARKET_HOURS: u8 = 13;
pub const KIND_PING_PONG: u8 = 14;
pub const KIND_BREATHING_CAP: u8 = 15;
pub const KIND_MOMENTUM: u8 = 16;
pub const KIND_BLOCKLIST: u8 = 17;
pub const KIND_HOT_POTATO: u8 = 18;
pub const KIND_DEX_ONLY: u8 = 19;
pub const KIND_P2P_ONLY: u8 = 20;
pub const KIND_SNIPER_FEE_CAP: u8 = 21;
pub const KIND_TRADING_HOURS: u8 = 22;
pub const KIND_RESONANCE: u8 = 23;
pub const KIND_COUPLED_RESONATOR: u8 = 24;
pub const KIND_TITHE: u8 = 25;
/// v71.35/v71.36: pool trades only when the transaction carries one app's mark while on the curve (the mark's key is packed into
/// params 0..3, its kind in p4 — program invoked, wallet signing, or program invoked with account slot p5 filled).
pub const KIND_FOMO_ONLY: u8 = 26;
pub const KIND_PUMP_APP_ONLY: u8 = 27;

/// Rule pairs that cannot share a coin (the catalogue's `HOOK_CONFLICTS`, by kind,
/// in the catalogue's order; `test/hook-program.test.mjs` compares the two tables).
pub const CONFLICTS: [(u8, u8); 49] = [
    (1, 17),  // allowlist / blocklist
    (1, 2),   // allowlist / holder_gated
    (17, 2),  // blocklist / holder_gated
    (4, 10),  // anti_dump / trade_guard
    (4, 6),   // anti_dump / graduated_sell_caps
    (4, 5),   // anti_dump / sliding_caps
    (10, 5),  // trade_guard / sliding_caps
    (6, 5),   // graduated_sell_caps / sliding_caps
    (10, 6),  // trade_guard / graduated_sell_caps
    (7, 9),   // max_per_wallet / chapters
    (7, 8),   // max_per_wallet / rising_max_per_wallet
    (9, 8),   // chapters / rising_max_per_wallet
    (12, 19), // venue_locked / dex_only
    (12, 20), // venue_locked / p2p_only
    (19, 20), // dex_only / p2p_only
    (13, 22), // market_hours / trading_hours
    (15, 16), // breathing_cap / momentum
    (15, 23), // breathing_cap / resonance
    (15, 24), // breathing_cap / coupled_resonator
    (16, 23), // momentum / resonance
    (16, 24), // momentum / coupled_resonator
    (23, 24), // resonance / coupled_resonator
    (4, 15),  // anti_dump / breathing_cap
    (4, 16),  // anti_dump / momentum
    (4, 23),  // anti_dump / resonance
    (4, 24),  // anti_dump / coupled_resonator
    (5, 15),  // sliding_caps / breathing_cap
    (5, 16),  // sliding_caps / momentum
    (5, 23),  // sliding_caps / resonance
    (5, 24),  // sliding_caps / coupled_resonator
    (20, 18), // p2p_only / hot_potato
    (20, 14), // p2p_only / ping_pong
    (20, 11), // p2p_only / anti_bundle
    (20, 21), // p2p_only / sniper_fee_cap
    (26, 27), // fomo_only / pump_app_only
    (26, 12), // fomo_only / venue_locked
    (26, 19), // fomo_only / dex_only
    (26, 20), // fomo_only / p2p_only
    (26, 1),  // fomo_only / allowlist
    (26, 2),  // fomo_only / holder_gated
    (26, 3),  // fomo_only / holder_vesting
    (26, 25), // fomo_only / tithe
    (27, 12), // pump_app_only / venue_locked
    (27, 19), // pump_app_only / dex_only
    (27, 20), // pump_app_only / p2p_only
    (27, 1),  // pump_app_only / allowlist
    (27, 2),  // pump_app_only / holder_gated
    (27, 3),  // pump_app_only / holder_vesting
    (27, 25), // pump_app_only / tithe
];

/// One transfer as the engine sees it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Transfer {
    pub amount: u64,
    /// Clock unix timestamp (seconds).
    pub now: i64,
    pub slot: u64,
    /// Mint supply (mint data [36..44]).
    pub supply: u64,
    pub src_is_venue: bool,
    pub dst_is_venue: bool,
    /// The source token account's owner is in the config's exempt list. Ignored
    /// when the source is a venue (see [`Transfer::skips_rules`]).
    pub src_owner_exempt: bool,
    /// The destination token account's owner is in the exempt list (ignored for venues).
    pub dst_owner_exempt: bool,
    /// Source and destination token accounts share one owner (a self-transfer).
    pub same_owner: bool,
    pub src_post_balance: u64,
    pub dst_post_balance: u64,
    pub src_owner: [u8; 32],
    pub dst_owner: [u8; 32],
    /// The destination owner is the config's creator (p2p_only).
    pub dst_is_creator: bool,
    /// The destination owner has an AllowEntry.
    pub dst_allowed: bool,
    /// The destination owner is in the BlockList.
    pub dst_blocked: bool,
    /// Balance of the destination owner's gate ATA (0 when it does not exist).
    pub dst_gate_balance: u64,
    /// `get_stack_height()` of the hook invocation (dex_only).
    pub stack_height: u64,
    /// From the instructions sysvar (sniper_fee_cap, tithe); 0 when not read.
    pub priority_fee_lamports: u64,
    pub jito_tip_lamports: u64,
    /// The largest single System transfer to the tithe recipient in the transaction.
    pub tithe_lamports: u64,
    /// Whether the transaction carries the app mark an app-only rule names (v71.35/v71.36: a program invoked, a wallet that
    /// signed, or a program invoked with a given account slot filled).
    pub app_mark_present: bool,
}

impl Transfer {
    pub fn touches_venue(&self) -> bool {
        self.src_is_venue || self.dst_is_venue
    }
    pub fn is_sell(&self) -> bool {
        self.dst_is_venue && !self.src_is_venue
    }
    pub fn is_buy(&self) -> bool {
        self.src_is_venue && !self.dst_is_venue
    }
    pub fn wallet_to_wallet(&self) -> bool {
        !self.src_is_venue && !self.dst_is_venue
    }
    /// The sending wallet (not a venue) has an exempt owner.
    pub fn src_exempt(&self) -> bool {
        !self.src_is_venue && self.src_owner_exempt
    }
    /// The receiving wallet (not a venue) has an exempt owner.
    pub fn dst_exempt(&self) -> bool {
        !self.dst_is_venue && self.dst_owner_exempt
    }
    /// Venue-to-venue moves and venue transfers whose wallet side is exempt skip
    /// every rule: a sell by an exempt wallet, a buy into one, and settlement
    /// flows (fee claims, leftover, graduation into the migration pool). Only the
    /// wallet side's owner counts; the venue's own owner signs every trade.
    pub fn skips_rules(&self) -> bool {
        (self.src_is_venue && self.dst_is_venue)
            || (self.src_is_venue && self.dst_owner_exempt)
            || (self.dst_is_venue && self.src_owner_exempt)
    }
    /// A wallet (not a venue) is sending: a sell or a send.
    pub fn out_of_wallet(&self) -> bool {
        !self.src_is_venue
    }
    /// A plain wallet (not a venue, not exempt) is receiving: holder rules and wallet caps apply.
    pub fn into_capped_wallet(&self) -> bool {
        !self.dst_is_venue && !self.dst_owner_exempt
    }
    /// A buy by a plain, non-exempt receiver (the per-buy caps).
    pub fn capped_buy(&self) -> bool {
        self.is_buy() && self.into_capped_wallet()
    }
    /// The source balance before the transfer.
    pub fn pre_balance(&self) -> Result<u64, HookError> {
        self.src_post_balance.checked_add(self.amount).ok_or(HookError::Overflow)
    }
    /// The venue account's post balance in a buy or sell (None for a send).
    pub fn venue_post_balance(&self) -> Option<u64> {
        if self.is_buy() {
            Some(self.src_post_balance)
        } else if self.is_sell() {
            Some(self.dst_post_balance)
        } else {
            None
        }
    }
}

/// A WalletState account as Execute sees it; `registered` is false when the
/// account does not exist (0 lamports / not owned by the program).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WalletView {
    pub registered: bool,
    pub state: WalletState,
}

/// Rules that read or write per-wallet state (the catalogue's `needsWalletState`).
pub const fn needs_wallet_state(kind: u8) -> bool {
    kind == KIND_HOLDER_VESTING
}

/// Rules that read the instructions sysvar (the catalogue's `needsSysvar`).
pub const fn needs_sysvar(kind: u8) -> bool {
    matches!(kind, KIND_SNIPER_FEE_CAP | KIND_TITHE | KIND_FOMO_ONLY | KIND_PUMP_APP_ONLY)
}

/// Rules that lock pool trades to one app (its mark is packed into the rule's params: the key in 0..4, the kind in 4, the
/// account slot in 5).
pub const fn is_app_only(kind: u8) -> bool {
    matches!(kind, KIND_FOMO_ONLY | KIND_PUMP_APP_ONLY)
}

/// The 32-byte key packed little-endian into four u64 params (params 0..4 of an app-only rule).
pub fn packed_key(params: &[u64; 6]) -> [u8; 32] {
    let mut key = [0u8; 32];
    for (i, p) in params[..4].iter().enumerate() {
        key[i * 8..i * 8 + 8].copy_from_slice(&p.to_le_bytes());
    }
    key
}

/// The app mark an app-only rule of `rules` names, if any.
pub fn app_mark(rules: &[Rule]) -> Option<AppMark> {
    rules.iter().find(|r| is_app_only(r.kind)).map(|r| AppMark { kind: r.params[4] as u8, key: packed_key(&r.params), index: r.params[5] as u8 })
}

/// Whether an app mark's kind and slot are ones the program knows (p4 1..3; p5 an account slot under 64 for kind 3, else 0).
const fn valid_app_mark(p4: u64, p5: u64) -> bool {
    match p4 as u8 {
        APP_MARK_PROGRAM | APP_MARK_SIGNER => p4 < 256 && p5 == 0,
        APP_MARK_PROGRAM_ACCOUNT => p4 < 256 && p5 < 64,
        _ => false,
    }
}

/// The three energy rules share the config's oscillator fields.
pub const fn is_oscillator(kind: u8) -> bool {
    matches!(kind, KIND_MOMENTUM | KIND_RESONANCE | KIND_COUPLED_RESONATOR)
}

pub fn has_rule(rules: &[Rule], kind: u8) -> bool {
    rules.iter().any(|r| r.kind == kind)
}

/// `total * bps / 10000` with a u128 intermediate.
pub fn share(total: u64, bps: u64) -> Result<u64, HookError> {
    let v = (total as u128).checked_mul(bps as u128).ok_or(HookError::Overflow)? / BPS as u128;
    u64::try_from(v).map_err(|_| HookError::Overflow)
}

/// `total * ppm / 1_000_000` with a u128 intermediate.
pub fn share_ppm(total: u64, ppm: u64) -> Result<u64, HookError> {
    let v = (total as u128).checked_mul(ppm as u128).ok_or(HookError::Overflow)? / PPM as u128;
    u64::try_from(v).map_err(|_| HookError::Overflow)
}

/// Seconds since the first venue transfer; None before the clock started.
pub fn elapsed_since(started_at: i64, now: i64) -> Option<u64> {
    if started_at == 0 {
        return None;
    }
    Some(now.saturating_sub(started_at).max(0) as u64)
}

/// Field `i` (0..=3) of a u64 packing four u16 values.
pub const fn unpack16(packed: u64, i: usize) -> u64 {
    (packed >> (16 * i)) & 0xffff
}

/// dex_only: the hook must run under a program other than Token-2022 itself.
pub const fn dex_only_ok(stack_height: u64) -> bool {
    stack_height >= MIN_DEX_STACK_HEIGHT
}

// --- per-rule math (pure, tested one by one) ---------------------------------------------

/// holder_vesting: whether a receipt of `amount` is a qualifying (locked) one.
/// Early-window rule: p0 == 0 (everyone vests), or the clock has not started
/// (pre-launch receipts count as early), or now ≤ started_at + p0, or the
/// receiver already vests.
pub fn vesting_qualifies(amount: u64, supply: u64, started_at: i64, now: i64, early_window: u64, min_ppm: u64, receiver: &WalletState) -> Result<bool, HookError> {
    if amount < share_ppm(supply, min_ppm)? {
        return Ok(false);
    }
    Ok(early_window == 0 || started_at == 0 || now <= started_at.saturating_add(i64::try_from(early_window).unwrap_or(i64::MAX)) || receiver.first_receipt_ts != 0)
}

/// holder_vesting: the unlocked share in bps of a wallet whose clock started at `first`:
/// 0 before `first + cliff`, then `unlock_bps × (1 + floor((now − first − cliff) / period))`, at most 10000.
pub fn vesting_unlocked_bps(first: i64, now: i64, cliff: u64, period: u64, unlock_bps: u64) -> u64 {
    let held = now.saturating_sub(first).max(0) as u64;
    if held < cliff {
        return 0;
    }
    let periods = 1 + (held - cliff) / period.max(1);
    unlock_bps.saturating_mul(periods).min(BPS)
}

/// holder_vesting: tokens still locked = received − unlocked share of received.
pub fn vesting_locked(state: &WalletState, now: i64, cliff: u64, period: u64, unlock_bps: u64) -> Result<u64, HookError> {
    if state.first_receipt_ts == 0 {
        return Ok(0);
    }
    let f = vesting_unlocked_bps(state.first_receipt_ts, now, cliff, period, unlock_bps);
    Ok(state.received_total - share(state.received_total, f)?)
}

/// sliding_caps: progress to graduation in bps from the vault's balances (0 before the first buy).
pub fn progress_bps(vault_initial: u64, vault_now: u64, swap_base_amount: u64) -> u64 {
    if vault_initial == 0 || swap_base_amount == 0 {
        return 0;
    }
    let sold = vault_initial.saturating_sub(vault_now) as u128;
    (sold * BPS as u128 / swap_base_amount as u128).min(BPS as u128) as u64
}

/// sliding_caps: the number of breakpoints (u16 bps fields of `breakpoints`, levels − 1 of them) at or below `progress`.
pub fn sliding_level(breakpoints: u64, levels: u64, progress: u64) -> usize {
    let levels = levels.clamp(1, 5) as usize;
    (0..levels - 1).filter(|i| unpack16(breakpoints, *i) <= progress).count()
}

/// sliding_caps: the cap of `level` from the packed level fields (levels 0..3 in `packed`, level 4 in `p4`: buy low, sell high).
pub fn sliding_cap(packed: u64, p4: u64, level: usize, buy: bool) -> u64 {
    if level < 4 {
        unpack16(packed, level)
    } else {
        unpack16(p4, if buy { 0 } else { 1 })
    }
}

/// graduated_sell_caps: `small − (small − big) × min(pre, bag) / bag` with `bag = share(supply, bag_bps)`.
pub fn graduated_cap_bps(small: u64, big: u64, bag_bps: u64, pre_balance: u64, supply: u64) -> Result<u64, HookError> {
    let bag = share(supply, bag_bps)?;
    if bag == 0 || pre_balance >= bag {
        return Ok(big.min(small));
    }
    let drop = small.saturating_sub(big) as u128 * pre_balance as u128 / bag as u128;
    Ok(small - drop as u64)
}

/// rising_max_per_wallet: `start + n × step` or `start × 2^n` (n = whole intervals since the clock started), at most 10000.
pub fn rising_cap_bps(start: u64, mode: u64, step: u64, interval: u64, elapsed: Option<u64>) -> u64 {
    let n = match elapsed {
        Some(e) if interval > 0 => e / interval,
        _ => 0,
    };
    let cap = if mode == 1 {
        if n >= 64 {
            BPS
        } else {
            start.saturating_mul(1u64 << n)
        }
    } else {
        start.saturating_add(step.saturating_mul(n))
    };
    cap.min(BPS)
}

/// chapters: `start × 2^floor(volume_bought / volume_per_chapter)`, at most 10000.
pub fn chapters_cap_bps(start: u64, volume_per_chapter: u64, volume_bought: u64) -> u64 {
    if volume_per_chapter == 0 {
        return start.min(BPS);
    }
    let n = volume_bought / volume_per_chapter;
    if n >= 64 {
        return BPS;
    }
    start.saturating_mul(1u64 << n).min(BPS)
}

/// breathing_cap: `max(floor, base + base × swing% × sin(2π × elapsed / cycle))`, the base before the clock starts.
pub fn breathing_cap_bps(cycle: u64, base: u64, swing_pct: u64, floor: u64, elapsed: Option<u64>) -> u64 {
    let sin = match elapsed {
        Some(e) => osc::sin_q16(osc::phase_in_cycle(e, cycle)),
        None => 0,
    };
    osc::breathing_cap(base, swing_pct, sin, floor)
}

/// sniper_fee_cap: the launch window is open before the clock starts, forever when `window` is 0, else for `window` seconds.
pub fn sniper_window_open(started_at: i64, now: i64, window: u64) -> bool {
    started_at == 0 || window == 0 || now < started_at.saturating_add(i64::try_from(window).unwrap_or(i64::MAX))
}

/// ping_pong: which turn a venue trade takes.
fn turn_side(t: &Transfer) -> u8 {
    if t.is_buy() {
        TURN_BUY
    } else {
        TURN_SELL
    }
}

fn oscillator_of(cfg: &ConfigState) -> Oscillator {
    Oscillator { energy: cfg.osc_energy, energy2: cfg.osc_energy2, phase: cfg.osc_phase, ts: cfg.osc_ts }
}

fn store_oscillator(cfg: &mut ConfigState, o: &Oscillator) {
    cfg.osc_energy = o.energy;
    cfg.osc_energy2 = o.energy2;
    cfg.osc_phase = o.phase;
    cfg.osc_ts = o.ts;
}

/// Advances the shared oscillator to `now` for the energy rule in force.
pub fn step_oscillator(cfg: &mut ConfigState, rule: &Rule, now: i64) {
    let [p0, p1, p2, ..] = rule.params;
    let mut o = oscillator_of(cfg);
    match rule.kind {
        KIND_MOMENTUM | KIND_RESONANCE => o.step(now, p0, p1, 0),
        KIND_COUPLED_RESONATOR => o.step(now, p0, p2, p1),
        _ => return,
    }
    store_oscillator(cfg, &o);
}

// --- validation ----------------------------------------------------------------------------

/// Whether two kinds are a catalogue conflict pair.
pub fn conflicts(a: u8, b: u8) -> bool {
    CONFLICTS.iter().any(|(x, y)| (*x == a && *y == b) || (*x == b && *y == a))
}

/// InitConfig validation: kinds, duplicates, conflict pairs, parameter ranges
/// and divisors. The catalogue already validates the creator's input; this is
/// the on-chain backstop so a malformed config can never divide by zero or grant
/// more than 100%.
pub fn validate_rules(rules: &[Rule]) -> Result<(), HookError> {
    if rules.is_empty() || rules.len() > MAX_RULES {
        return Err(HookError::ConfigMismatch);
    }
    for (i, r) in rules.iter().enumerate() {
        if rules[..i].iter().any(|o| o.kind == r.kind || conflicts(o.kind, r.kind)) {
            return Err(HookError::ConfigMismatch);
        }
        validate_rule(r)?;
    }
    Ok(())
}

fn sliding_caps_valid(levels: u64, buys: u64, sells: u64, breakpoints: u64, p4: u64) -> bool {
    if !(1..=5).contains(&levels) || p4 >> 32 != 0 {
        return false;
    }
    for level in 0..levels as usize {
        if sliding_cap(buys, p4, level, true) > BPS || !(1..=BPS).contains(&sliding_cap(sells, p4, level, false)) {
            return false;
        }
    }
    let mut last = 0;
    for i in 0..(levels as usize - 1) {
        let at = unpack16(breakpoints, i);
        if at <= last || at >= BPS {
            return false;
        }
        last = at;
    }
    true
}

pub fn validate_rule(r: &Rule) -> Result<(), HookError> {
    let [p0, p1, p2, p3, p4, p5] = r.params;
    let bps = |v: u64| (1..=BPS).contains(&v);
    let bps0 = |v: u64| v <= BPS;
    let pct = |v: u64| v <= 100;
    let pct1 = |v: u64| (1..=100).contains(&v);
    let ok = match r.kind {
        KIND_ALLOWLIST | KIND_VENUE_LOCKED | KIND_BLOCKLIST | KIND_DEX_ONLY | KIND_P2P_ONLY | KIND_SNIPER_FEE_CAP => true,
        KIND_HOLDER_GATED => p0 >= 1,
        KIND_HOLDER_VESTING => p2 >= 1 && bps(p3) && p4 <= PPM,
        KIND_ANTI_DUMP => bps0(p0) && bps(p1),
        KIND_SLIDING_CAPS => sliding_caps_valid(p0, p1, p2, p3, p4),
        KIND_GRADUATED_SELL_CAPS => bps(p0) && bps(p1) && p1 <= p0 && bps(p2),
        KIND_MAX_PER_WALLET => bps(p0),
        KIND_RISING_MAX_PER_WALLET => bps(p0) && p1 <= 1 && bps0(p2) && (p1 == 1 || p2 >= 1) && p3 >= 1,
        KIND_CHAPTERS => bps(p0) && p1 >= 1,
        KIND_TRADE_GUARD => bps(p0),
        KIND_ANTI_BUNDLE => p0 >= 1,
        KIND_MARKET_HOURS => p0 <= 1 && p1 <= 1,
        KIND_PING_PONG => p0 <= PPM,
        KIND_BREATHING_CAP => p0 >= 1 && bps(p1) && pct1(p2) && bps0(p3) && p3 <= p1,
        KIND_MOMENTUM | KIND_RESONANCE => p0 >= 1 && pct1(p1) && pct1(p2) && bps(p3) && p4 <= p3,
        KIND_HOT_POTATO => p0 <= PPM,
        KIND_TRADING_HOURS => {
            p0 < calendar::MINUTES_PER_DAY && (1..=calendar::MINUTES_PER_DAY).contains(&p1) && (1..=127).contains(&p2) && (600..=2280).contains(&p3) && p4 <= 2 && p5 <= 1
        }
        KIND_COUPLED_RESONATOR => p0 >= 1 && pct1(p1) && pct(p2) && pct1(p3) && bps(p4) && p5 <= p4,
        KIND_TITHE => p0 >= 1,
        KIND_FOMO_ONLY | KIND_PUMP_APP_ONLY => packed_key(&r.params) != ZERO_KEY && valid_app_mark(p4, p5),
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(HookError::ConfigMismatch)
    }
}

// --- evaluation -------------------------------------------------------------------------------

/// Runs every rule of `rules` against one transfer, mutating the config fields
/// and wallet views in place. On `Err` nothing must be persisted (the
/// transaction fails anyway).
pub fn evaluate(rules: &[Rule], cfg: &mut ConfigState, src: &mut WalletView, dst: &mut WalletView, t: &Transfer) -> Result<(), HookError> {
    // A zero-amount transfer moves nothing: it cannot break a cap and must not touch any state.
    if t.amount == 0 {
        return Ok(());
    }
    if t.touches_venue() {
        // 1. The first venue transfer starts the clock of every time-based rule.
        if cfg.started_at == 0 {
            cfg.started_at = t.now;
            cfg.start_slot = t.slot;
        }
        // 2. The first buy (exempt or not) records the vault's balance before anyone bought.
        if t.is_buy() && cfg.vault_initial == 0 && has_rule(rules, KIND_SLIDING_CAPS) {
            cfg.vault_initial = t.pre_balance()?;
        }
        // 3. The oscillator decays and turns on every venue transfer, exempt or not.
        if let Some(rule) = rules.iter().find(|r| is_oscillator(r.kind)) {
            step_oscillator(cfg, rule, t.now);
        }
    }
    if t.skips_rules() {
        return Ok(());
    }
    let elapsed = elapsed_since(cfg.started_at, t.now);
    for rule in rules {
        check_rule(rule, cfg, src, dst, t, elapsed)?;
    }
    for rule in rules {
        record_rule(rule, cfg, dst, t, elapsed)?;
    }
    Ok(())
}

fn check_rule(rule: &Rule, cfg: &mut ConfigState, src: &WalletView, dst: &WalletView, t: &Transfer, elapsed: Option<u64>) -> Result<(), HookError> {
    let [p0, p1, p2, p3, p4, p5] = rule.params;
    let fail = HookError::for_rule(rule.kind).ok_or(HookError::ConfigMismatch)?;
    let need = |ok: bool| if ok { Ok(()) } else { Err(fail) };
    let buy_cap = |cap: u64| if t.capped_buy() { need(t.amount <= share(t.supply, cap)?) } else { Ok(()) };
    match rule.kind {
        KIND_ALLOWLIST => need(!t.into_capped_wallet() || t.dst_allowed),
        KIND_HOLDER_GATED => need(!t.into_capped_wallet() || t.dst_gate_balance >= p0),
        KIND_HOLDER_VESTING => {
            // Receipt side: a qualifying receipt needs the receiver's record (a self-transfer receives nothing new).
            if t.into_capped_wallet() && !t.same_owner && !dst.registered && vesting_qualifies(t.amount, t.supply, cfg.started_at, t.now, p0, p4, &dst.state)? {
                return Err(HookError::WalletNotRegistered);
            }
            // Sending side: the post balance must still cover the locked tokens.
            if t.out_of_wallet() && !t.src_owner_exempt && src.registered {
                let locked = vesting_locked(&src.state, t.now, p1, p2, p3)?;
                return need(t.src_post_balance >= locked);
            }
            Ok(())
        }
        KIND_ANTI_DUMP => {
            if t.is_buy() {
                need(p0 == 0 || t.amount <= share(t.supply, p0)?)
            } else {
                need(t.amount <= share(t.supply, p1)?)
            }
        }
        KIND_SLIDING_CAPS => match t.venue_post_balance() {
            None => Ok(()),
            Some(vault_now) => {
                let level = sliding_level(p3, p0, progress_bps(cfg.vault_initial, vault_now, cfg.swap_base_amount));
                if t.is_buy() {
                    let cap = sliding_cap(p1, p4, level, true);
                    need(cap == 0 || t.amount <= share(t.supply, cap)?)
                } else {
                    need(t.amount <= share(t.supply, sliding_cap(p2, p4, level, false))?)
                }
            }
        },
        KIND_GRADUATED_SELL_CAPS => {
            if t.out_of_wallet() {
                let cap = graduated_cap_bps(p0, p1, p2, t.pre_balance()?, t.supply)?;
                return need(t.amount <= share(t.supply, cap)?);
            }
            Ok(())
        }
        KIND_MAX_PER_WALLET => need(!t.into_capped_wallet() || t.dst_post_balance <= share(t.supply, p0)?),
        KIND_RISING_MAX_PER_WALLET => {
            let cap = rising_cap_bps(p0, p1, p2, p3, elapsed);
            need(!t.into_capped_wallet() || t.dst_post_balance <= share(t.supply, cap)?)
        }
        KIND_CHAPTERS => {
            let cap = chapters_cap_bps(p0, p1, cfg.volume_bought);
            need(!t.into_capped_wallet() || t.dst_post_balance <= share(t.supply, cap)?)
        }
        KIND_TRADE_GUARD => need(t.amount <= share(t.supply, p0)?),
        KIND_ANTI_BUNDLE => {
            if t.touches_venue() {
                if cfg.last_slot == t.slot {
                    cfg.slot_trades = cfg.slot_trades.saturating_add(1);
                } else {
                    cfg.last_slot = t.slot;
                    cfg.slot_trades = 1;
                }
                return need(cfg.slot_trades <= p0);
            }
            Ok(())
        }
        // "exactly one side is a venue (or exempt)": an exempt owner may still move coins wallet-to-wallet.
        KIND_VENUE_LOCKED => need(!t.wallet_to_wallet() || t.src_exempt() || t.dst_exempt()),
        KIND_MARKET_HOURS => {
            if t.is_buy() || (t.is_sell() && p0 != 1) {
                return need(calendar::nyse_open(t.now, p1 == 1));
            }
            Ok(())
        }
        KIND_PING_PONG => {
            if t.touches_venue() && t.amount >= share_ppm(t.supply, p0)? {
                let same = cfg.turn_side == turn_side(t);
                let held = p1 == 0 || t.now < cfg.turn_ts.saturating_add(i64::try_from(p1).unwrap_or(i64::MAX));
                return need(!(same && held));
            }
            Ok(())
        }
        KIND_BREATHING_CAP => buy_cap(breathing_cap_bps(p0, p1, p2, p3, elapsed)),
        KIND_MOMENTUM => buy_cap(osc::cap_with_swing(p3, cfg.osc_energy, osc::sin_q16(cfg.osc_phase), p4)),
        KIND_RESONANCE => buy_cap(osc::cap_with_energy(p3, cfg.osc_energy, p4)),
        KIND_COUPLED_RESONATOR => buy_cap(osc::cap_with_swing(p4, cfg.osc_energy, osc::sin_q16(cfg.osc_phase), p5)),
        KIND_BLOCKLIST => need(!t.into_capped_wallet() || !t.dst_blocked),
        KIND_HOT_POTATO => {
            if t.out_of_wallet() && cfg.potato_holder != ZERO_KEY && t.src_owner == cfg.potato_holder {
                let cold = p1 > 0 && t.now >= cfg.potato_since.saturating_add(i64::try_from(p1).unwrap_or(i64::MAX));
                return need(cold);
            }
            Ok(())
        }
        KIND_DEX_ONLY => need(dex_only_ok(t.stack_height)),
        KIND_P2P_ONLY => {
            if t.is_buy() {
                need(t.dst_is_creator)
            } else {
                need(!t.is_sell())
            }
        }
        KIND_SNIPER_FEE_CAP => {
            if t.capped_buy() && sniper_window_open(cfg.started_at, t.now, p0) {
                return need(t.priority_fee_lamports <= p1 && t.jito_tip_lamports <= p2);
            }
            Ok(())
        }
        KIND_TRADING_HOURS => {
            if t.is_buy() || (t.is_sell() && p5 != 1) {
                let offset_minutes = p3 as i64 - calendar::MINUTES_PER_DAY as i64;
                return need(calendar::trading_window_open(t.now, p0, p1, p2, offset_minutes, p4.min(255) as u8));
            }
            Ok(())
        }
        KIND_TITHE => need(!t.touches_venue() || t.tithe_lamports >= p0),
        // The app's mark must be in the trade's transaction as the host named it: its program as a top-level instruction (inner calls are not it), its wallet among the signers, or its program invoked with the named account slot filled.
        KIND_FOMO_ONLY | KIND_PUMP_APP_ONLY => need(!t.touches_venue() || t.app_mark_present),
        _ => Err(HookError::ConfigMismatch),
    }
}

/// State updates after every check passed (the transfer is not skipped).
fn record_rule(rule: &Rule, cfg: &mut ConfigState, dst: &mut WalletView, t: &Transfer, elapsed: Option<u64>) -> Result<(), HookError> {
    let [p0, _, p2, p3, p4, _] = rule.params;
    match rule.kind {
        KIND_HOLDER_VESTING => {
            if t.into_capped_wallet() && !t.same_owner && dst.registered && vesting_qualifies(t.amount, t.supply, cfg.started_at, t.now, p0, p4, &dst.state)? {
                if dst.state.first_receipt_ts == 0 {
                    dst.state.first_receipt_ts = t.now;
                }
                dst.state.received_total = dst.state.received_total.checked_add(t.amount).ok_or(HookError::Overflow)?;
            }
        }
        KIND_CHAPTERS => {
            if t.is_buy() {
                cfg.volume_bought = cfg.volume_bought.saturating_add(t.amount);
            }
        }
        KIND_PING_PONG => {
            if t.touches_venue() && t.amount >= share_ppm(t.supply, p0)? {
                cfg.turn_side = turn_side(t);
                cfg.turn_ts = t.now;
            }
        }
        KIND_MOMENTUM => {
            if t.capped_buy() {
                cfg.osc_energy = osc::kick(cfg.osc_energy, p2, t.amount, share(t.supply, p3)?, osc::Q16_ONE as u64);
            }
        }
        KIND_RESONANCE => {
            if t.capped_buy() {
                let alignment = osc::alignment_q16(elapsed.unwrap_or(0), p0);
                cfg.osc_energy = osc::kick(cfg.osc_energy, p2, t.amount, share(t.supply, p3)?, alignment);
            }
        }
        KIND_COUPLED_RESONATOR => {
            if t.capped_buy() {
                cfg.osc_energy = osc::kick(cfg.osc_energy, p3, t.amount, share(t.supply, p4)?, osc::Q16_ONE as u64);
            }
        }
        KIND_HOT_POTATO if t.capped_buy() && t.amount >= share_ppm(t.supply, p0)? => {
            cfg.potato_holder = t.dst_owner;
            cfg.potato_since = t.now;
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::days_from_civil;
    use crate::osc::{apply_decay, cap_with_swing, decay_factor, sin_q16, ENERGY_ONE, PHASE_QUARTER, Q16_ONE};
    use crate::state::TURN_NONE;

    const SUPPLY: u64 = 1_000_000_000_000_000; // 1e9 tokens with 6 decimals
    const SWAP_BASE: u64 = 800_000_000_000_000; // 80% of the supply is sold on the curve
    const NOW: i64 = 1_700_000_000;
    const SLOT: u64 = 250_000_000;
    const ALICE: [u8; 32] = [1; 32];
    const BOB: [u8; 32] = [2; 32];
    const CAROL: [u8; 32] = [3; 32];

    fn rule(kind: u8, params: &[u64]) -> Rule {
        let mut p = [0u64; 6];
        p[..params.len()].copy_from_slice(params);
        Rule { kind, params: p }
    }
    fn registered() -> WalletView {
        WalletView { registered: true, state: WalletState::new(255) }
    }
    fn unregistered() -> WalletView {
        WalletView::default()
    }
    fn started() -> ConfigState {
        ConfigState { started_at: NOW - 1000, start_slot: SLOT - 2500, swap_base_amount: SWAP_BASE, ..ConfigState::default() }
    }
    fn fresh() -> ConfigState {
        ConfigState { swap_base_amount: SWAP_BASE, ..ConfigState::default() }
    }
    /// A send from Alice to Bob through the pool program (stack height 3).
    fn base() -> Transfer {
        Transfer {
            amount: 1_000,
            now: NOW,
            slot: SLOT,
            supply: SUPPLY,
            src_post_balance: 9_000,
            dst_post_balance: 1_000,
            src_owner: ALICE,
            dst_owner: BOB,
            stack_height: 3,
            ..Transfer::default()
        }
    }
    /// Alice sells into the vault.
    fn sell() -> Transfer {
        Transfer { dst_is_venue: true, src_post_balance: SUPPLY / 2, dst_post_balance: SUPPLY / 2, ..base() }
    }
    /// Bob buys from the vault.
    fn buy() -> Transfer {
        Transfer { src_is_venue: true, src_post_balance: SUPPLY / 2, dst_post_balance: 1_000, ..base() }
    }
    fn run(rules: &[Rule], cfg: &mut ConfigState, src: &mut WalletView, dst: &mut WalletView, t: &Transfer) -> Result<(), HookError> {
        evaluate(rules, cfg, src, dst, t)
    }
    fn simple(rules: &[Rule], t: &Transfer) -> Result<(), HookError> {
        run(rules, &mut started(), &mut unregistered(), &mut unregistered(), t)
    }
    fn pct(bps: u64) -> u64 {
        SUPPLY * bps / 10_000
    }

    #[test]
    fn roles_and_skip() {
        assert!(sell().is_sell() && !sell().is_buy() && !sell().wallet_to_wallet() && sell().out_of_wallet());
        assert!(buy().is_buy() && !buy().out_of_wallet() && buy().capped_buy());
        assert!(base().wallet_to_wallet() && !base().skips_rules() && base().into_capped_wallet());
        assert!(Transfer { src_owner_exempt: true, ..sell() }.skips_rules());
        assert!(Transfer { dst_owner_exempt: true, ..buy() }.skips_rules());
        assert!(!Transfer { src_owner_exempt: true, ..base() }.skips_rules(), "exempt wallet-to-wallet is checked");
        assert!(Transfer { src_is_venue: true, dst_is_venue: true, ..base() }.skips_rules());
        // the venue's own owner (the pool authority) signs every buy and receives every sell: never an exemption
        assert!(!Transfer { src_owner_exempt: true, ..buy() }.skips_rules());
        assert!(!Transfer { dst_owner_exempt: true, ..sell() }.skips_rules());
        assert!(!Transfer { src_owner_exempt: true, ..buy() }.src_exempt());
        assert!(Transfer { src_owner_exempt: true, ..base() }.src_exempt());
        assert!(!Transfer { dst_owner_exempt: true, ..base() }.into_capped_wallet());
        assert!(!Transfer { dst_owner_exempt: true, ..buy() }.capped_buy());
        assert_eq!(base().pre_balance().unwrap(), 10_000);
        assert_eq!(Transfer { src_post_balance: u64::MAX, ..base() }.pre_balance(), Err(HookError::Overflow));
        assert_eq!(buy().venue_post_balance(), Some(SUPPLY / 2));
        assert_eq!(sell().venue_post_balance(), Some(SUPPLY / 2));
        assert_eq!(base().venue_post_balance(), None);
    }

    #[test]
    fn clock_starts_on_the_first_venue_transfer_and_zero_amounts_are_no_ops() {
        let r = [rule(KIND_TRADE_GUARD, &[5000])];
        let mut cfg = fresh();
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &base()).unwrap();
        assert_eq!(cfg.started_at, 0, "a send does not start the clock");
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: 0, ..buy() }).unwrap();
        assert_eq!(cfg.started_at, 0, "a zero-amount buy is a no-op");
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &buy()).unwrap();
        assert_eq!((cfg.started_at, cfg.start_slot), (NOW, SLOT));
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { now: NOW + 50, slot: SLOT + 100, ..sell() }).unwrap();
        assert_eq!((cfg.started_at, cfg.start_slot), (NOW, SLOT), "set once");
        // an exempt venue transfer starts the clock too, and is otherwise skipped
        let mut cfg = fresh();
        run(&[rule(KIND_MAX_PER_WALLET, &[1])], &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { dst_owner_exempt: true, dst_post_balance: SUPPLY, ..buy() }).unwrap();
        assert_eq!(cfg.started_at, NOW);
        // a zero-amount transfer never fails a rule
        simple(&[rule(KIND_VENUE_LOCKED, &[])], &Transfer { amount: 0, ..base() }).unwrap();
        assert_eq!(elapsed_since(0, NOW), None);
        assert_eq!(elapsed_since(NOW - 5, NOW), Some(5));
        assert_eq!(elapsed_since(NOW + 5, NOW), Some(0), "a clock running backwards reads zero");
    }

    #[test]
    fn allowlist() {
        let r = [rule(KIND_ALLOWLIST, &[])];
        assert_eq!(simple(&r, &base()), Err(HookError::Allowlist));
        simple(&r, &Transfer { dst_allowed: true, ..base() }).unwrap();
        simple(&r, &sell()).unwrap();
        simple(&r, &Transfer { dst_owner_exempt: true, ..base() }).unwrap();
        assert_eq!(simple(&r, &buy()), Err(HookError::Allowlist), "a buyer must be allowed too");
        simple(&r, &Transfer { dst_allowed: true, ..buy() }).unwrap();
    }

    #[test]
    fn holder_gated() {
        let r = [rule(KIND_HOLDER_GATED, &[1_000_000, 6])];
        assert_eq!(simple(&r, &Transfer { dst_gate_balance: 999_999, ..buy() }), Err(HookError::HolderGated));
        simple(&r, &Transfer { dst_gate_balance: 1_000_000, ..buy() }).unwrap();
        assert_eq!(simple(&r, &Transfer { dst_gate_balance: 0, ..base() }), Err(HookError::HolderGated), "sends are gated too");
        simple(&r, &Transfer { dst_gate_balance: 0, ..sell() }).unwrap();
        simple(&r, &Transfer { dst_gate_balance: 0, dst_owner_exempt: true, ..base() }).unwrap();
    }

    #[test]
    fn holder_vesting_receipts() {
        // everyone vests; cliff 1 day; 10% per day; receipts of at least 0.05% of supply qualify
        let r = [rule(KIND_HOLDER_VESTING, &[0, 86_400, 86_400, 1_000, 500])];
        let min = SUPPLY / 2_000;
        assert_eq!(share_ppm(SUPPLY, 500).unwrap(), min);
        // a qualifying buy needs the buyer's record
        assert_eq!(run(&r, &mut started(), &mut unregistered(), &mut unregistered(), &Transfer { amount: min, ..buy() }), Err(HookError::WalletNotRegistered));
        let mut bob = registered();
        run(&r, &mut started(), &mut unregistered(), &mut bob, &Transfer { amount: min, ..buy() }).unwrap();
        assert_eq!((bob.state.first_receipt_ts, bob.state.received_total), (NOW, min), "first receipt stamped, total recorded");
        run(&r, &mut started(), &mut unregistered(), &mut bob, &Transfer { amount: min, now: NOW + 10, ..buy() }).unwrap();
        assert_eq!((bob.state.first_receipt_ts, bob.state.received_total), (NOW, 2 * min), "stamped once, totals add up");
        // a smaller receipt is free: no record needed, nothing recorded
        run(&r, &mut started(), &mut unregistered(), &mut unregistered(), &Transfer { amount: min - 1, ..buy() }).unwrap();
        let mut carol = registered();
        run(&r, &mut started(), &mut unregistered(), &mut carol, &Transfer { amount: min - 1, ..buy() }).unwrap();
        assert_eq!(carol.state, WalletState::new(255));
        // sends of qualifying size are receipts too (documented limitation)
        assert_eq!(run(&r, &mut started(), &mut unregistered(), &mut unregistered(), &Transfer { amount: min, src_post_balance: SUPPLY, ..base() }), Err(HookError::WalletNotRegistered));
        // exempt receivers and venues never need a record
        run(&r, &mut started(), &mut unregistered(), &mut unregistered(), &Transfer { amount: min, dst_owner_exempt: true, src_post_balance: SUPPLY, ..base() }).unwrap();
        run(&r, &mut started(), &mut unregistered(), &mut unregistered(), &Transfer { amount: min, src_post_balance: SUPPLY, ..sell() }).unwrap();
        // a self-transfer receives nothing new: no record needed, nothing added
        let mut me = registered();
        me.state.first_receipt_ts = NOW - 10;
        me.state.received_total = 5;
        run(&r, &mut started(), &mut me, &mut unregistered(), &Transfer { amount: min, same_owner: true, src_post_balance: SUPPLY, ..base() }).unwrap();
        assert_eq!(me.state.received_total, 5);
        // early window: 1 h; receipts after it are not locked unless the wallet already vests
        let early = [rule(KIND_HOLDER_VESTING, &[3_600, 86_400, 86_400, 1_000, 500])];
        let mut cfg = ConfigState { started_at: NOW, start_slot: SLOT, swap_base_amount: SWAP_BASE, ..ConfigState::default() };
        assert_eq!(run(&early, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: min, now: NOW + 3_600, ..buy() }), Err(HookError::WalletNotRegistered), "inside the window");
        run(&early, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: min, now: NOW + 3_601, ..buy() }).unwrap();
        let mut late = registered();
        run(&early, &mut cfg, &mut unregistered(), &mut late, &Transfer { amount: min, now: NOW + 3_601, ..buy() }).unwrap();
        assert_eq!(late.state.received_total, 0, "a late receipt is not recorded even with a record");
        let mut early_bird = registered();
        early_bird.state.first_receipt_ts = NOW + 1;
        run(&early, &mut cfg, &mut unregistered(), &mut early_bird, &Transfer { amount: min, now: NOW + 9_999, ..buy() }).unwrap();
        assert_eq!(early_bird.state.received_total, min, "a wallet that already vests keeps vesting its later receipts");
        // before the clock starts (a pre-launch send) receipts count as early
        assert_eq!(run(&early, &mut fresh(), &mut unregistered(), &mut unregistered(), &Transfer { amount: min, src_post_balance: SUPPLY, ..base() }), Err(HookError::WalletNotRegistered));
        // the first buy starts the clock in the same evaluation and is inside the window
        assert_eq!(run(&early, &mut fresh(), &mut unregistered(), &mut unregistered(), &Transfer { amount: min, ..buy() }), Err(HookError::WalletNotRegistered));
    }

    #[test]
    fn holder_vesting_unlocks() {
        let (cliff, period, unlock) = (86_400u64, 86_400u64, 1_000u64);
        assert_eq!(vesting_unlocked_bps(NOW, NOW + 86_399, cliff, period, unlock), 0);
        assert_eq!(vesting_unlocked_bps(NOW, NOW + 86_400, cliff, period, unlock), 1_000, "the cliff unlocks the first share");
        assert_eq!(vesting_unlocked_bps(NOW, NOW + 2 * 86_400 - 1, cliff, period, unlock), 1_000);
        assert_eq!(vesting_unlocked_bps(NOW, NOW + 2 * 86_400, cliff, period, unlock), 2_000);
        assert_eq!(vesting_unlocked_bps(NOW, NOW + 10 * 86_400, cliff, period, unlock), 10_000);
        assert_eq!(vesting_unlocked_bps(NOW, NOW + 1_000 * 86_400, cliff, period, unlock), 10_000, "capped at 100%");
        assert_eq!(vesting_unlocked_bps(NOW, NOW, 0, 3_600, 2_500), 2_500, "no cliff: a share unlocks at once");
        assert_eq!(vesting_unlocked_bps(NOW, NOW - 50, 0, 3_600, 2_500), 2_500, "a clock running backwards is held at zero");
        assert_eq!(vesting_unlocked_bps(NOW, NOW, 0, 0, 2_500), 2_500, "a zero period cannot divide by zero");
        let r = [rule(KIND_HOLDER_VESTING, &[0, cliff, period, unlock, 500])];
        let mut alice = registered();
        alice.state.first_receipt_ts = NOW;
        alice.state.received_total = 1_000_000_000_000; // 1e12 locked
        let at = |alice: &mut WalletView, when: i64, post: u64| run(&r, &mut started(), alice, &mut unregistered(), &Transfer { now: when, src_post_balance: post, ..sell() });
        // before the cliff everything is locked: the post balance must keep the whole receipt
        at(&mut alice, NOW + 86_399, 1_000_000_000_000).unwrap();
        assert_eq!(at(&mut alice, NOW + 86_399, 999_999_999_999), Err(HookError::HolderVesting));
        // at the cliff 10% unlock
        at(&mut alice, NOW + 86_400, 900_000_000_000).unwrap();
        assert_eq!(at(&mut alice, NOW + 86_400, 899_999_999_999), Err(HookError::HolderVesting));
        // two days: 20%
        at(&mut alice, NOW + 2 * 86_400, 800_000_000_000).unwrap();
        assert_eq!(at(&mut alice, NOW + 2 * 86_400, 799_999_999_999), Err(HookError::HolderVesting));
        // ten days: everything is free
        at(&mut alice, NOW + 10 * 86_400, 0).unwrap();
        at(&mut alice, NOW + 100 * 86_400, 0).unwrap();
        // a send out of the wallet is checked the same way
        assert_eq!(run(&r, &mut started(), &mut alice, &mut unregistered(), &Transfer { now: NOW + 100, src_post_balance: 999_999_999_999, ..base() }), Err(HookError::HolderVesting));
        // nothing locked: no record, or a record that never qualified
        run(&r, &mut started(), &mut unregistered(), &mut unregistered(), &Transfer { src_post_balance: 0, ..sell() }).unwrap();
        run(&r, &mut started(), &mut registered(), &mut unregistered(), &Transfer { src_post_balance: 0, ..sell() }).unwrap();
        // exempt senders are never checked
        run(&r, &mut started(), &mut alice, &mut unregistered(), &Transfer { src_owner_exempt: true, src_post_balance: 0, ..base() }).unwrap();
        // selling does not change the record
        assert_eq!((alice.state.first_receipt_ts, alice.state.received_total), (NOW, 1_000_000_000_000));
        assert_eq!(vesting_locked(&WalletState::new(1), NOW, cliff, period, unlock).unwrap(), 0);
    }

    #[test]
    fn anti_dump() {
        let r = [rule(KIND_ANTI_DUMP, &[200, 25])]; // buys 2%, sells 0.25%
        simple(&r, &Transfer { amount: pct(200), ..buy() }).unwrap();
        assert_eq!(simple(&r, &Transfer { amount: pct(200) + 1, ..buy() }), Err(HookError::AntiDump));
        simple(&r, &Transfer { amount: pct(25), ..sell() }).unwrap();
        assert_eq!(simple(&r, &Transfer { amount: pct(25) + 1, ..sell() }), Err(HookError::AntiDump));
        simple(&r, &Transfer { amount: pct(25), src_post_balance: SUPPLY, ..base() }).unwrap();
        assert_eq!(simple(&r, &Transfer { amount: pct(25) + 1, src_post_balance: SUPPLY, ..base() }), Err(HookError::AntiDump), "sends are capped like sells");
        let no_buy_cap = [rule(KIND_ANTI_DUMP, &[0, 25])];
        simple(&no_buy_cap, &Transfer { amount: SUPPLY, ..buy() }).unwrap();
        assert_eq!(simple(&no_buy_cap, &Transfer { amount: pct(25) + 1, ..sell() }), Err(HookError::AntiDump));
        // exempt venue flows skip
        simple(&r, &Transfer { amount: SUPPLY, src_owner_exempt: true, ..sell() }).unwrap();
    }

    #[test]
    fn sliding_caps_math() {
        assert_eq!(progress_bps(0, 123, SWAP_BASE), 0, "no baseline yet");
        assert_eq!(progress_bps(SUPPLY, SUPPLY, SWAP_BASE), 0);
        assert_eq!(progress_bps(SUPPLY, SUPPLY - SWAP_BASE / 4, SWAP_BASE), 2_500);
        assert_eq!(progress_bps(SUPPLY, SUPPLY - SWAP_BASE, SWAP_BASE), 10_000);
        assert_eq!(progress_bps(SUPPLY, 0, SWAP_BASE), 10_000, "clamped");
        assert_eq!(progress_bps(SUPPLY, SUPPLY + 5, SWAP_BASE), 0, "a vault above its baseline reads zero");
        assert_eq!(progress_bps(SUPPLY, 0, 0), 0, "no division by zero");
        let ats = 2_500 | (6_000 << 16) | (8_000 << 32) | (9_000 << 48);
        assert_eq!(sliding_level(ats, 5, 0), 0);
        assert_eq!(sliding_level(ats, 5, 2_499), 0);
        assert_eq!(sliding_level(ats, 5, 2_500), 1, "a breakpoint at exactly the progress counts");
        assert_eq!(sliding_level(ats, 5, 7_999), 2);
        assert_eq!(sliding_level(ats, 5, 10_000), 4);
        assert_eq!(sliding_level(ats, 3, 10_000), 2, "only levels − 1 breakpoints exist");
        assert_eq!(sliding_level(ats, 1, 10_000), 0);
        let buys = 200 | (300 << 16) | (500 << 32) | (1_000 << 48);
        let p4 = 2_000 | (1_000 << 16);
        assert_eq!(sliding_cap(buys, p4, 0, true), 200);
        assert_eq!(sliding_cap(buys, p4, 3, true), 1_000);
        assert_eq!(sliding_cap(buys, p4, 4, true), 2_000, "level 4 lives in p4");
        assert_eq!(sliding_cap(buys, p4, 4, false), 1_000);
    }

    #[test]
    fn sliding_caps_rule() {
        // three levels: buys 2% / 3% / 5%, sells 1% / 1.5% / 2%, breakpoints 25% and 60%
        let r = [rule(KIND_SLIDING_CAPS, &[3, 200 | (300 << 16) | (500 << 32), 100 | (150 << 16) | (200 << 32), 2_500 | (6_000 << 16), 0])];
        let mut cfg = fresh();
        // the first buy: vault pre balance = SUPPLY; the baseline is captured and level 0 applies
        let first = |amount: u64| Transfer { amount, src_post_balance: SUPPLY - amount, ..buy() };
        assert_eq!(run(&r, &mut fresh(), &mut unregistered(), &mut unregistered(), &first(pct(200) + 1)), Err(HookError::SlidingCaps));
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &first(pct(200))).unwrap();
        assert_eq!(cfg.vault_initial, SUPPLY);
        // just under 25% sold: still level 0
        let vault_at = |sold: u64, amount: u64| Transfer { amount, src_post_balance: SUPPLY - sold, ..buy() };
        assert_eq!(run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &vault_at(SWAP_BASE / 4 - 1, pct(200) + 1)), Err(HookError::SlidingCaps));
        // at 25%: level 1 buys up to 3%
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &vault_at(SWAP_BASE / 4, pct(300))).unwrap();
        assert_eq!(run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &vault_at(SWAP_BASE / 4, pct(300) + 1)), Err(HookError::SlidingCaps));
        // sells read the vault from the destination side: 60% sold -> level 2 sells up to 2%
        let sell_at = |sold: u64, amount: u64| Transfer { amount, dst_post_balance: SUPPLY - sold, src_post_balance: SUPPLY, ..sell() };
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &sell_at(SWAP_BASE * 6 / 10, pct(200))).unwrap();
        assert_eq!(run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &sell_at(SWAP_BASE * 6 / 10, pct(200) + 1)), Err(HookError::SlidingCaps));
        assert_eq!(run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &sell_at(0, pct(100) + 1)), Err(HookError::SlidingCaps), "level 0 sells up to 1%");
        // sends are never capped by this rule
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: SUPPLY / 2, src_post_balance: SUPPLY / 2, ..base() }).unwrap();
        // a sell before any buy has no baseline: level 0
        let mut virgin = fresh();
        assert_eq!(run(&r, &mut virgin, &mut unregistered(), &mut unregistered(), &sell_at(0, pct(100) + 1)), Err(HookError::SlidingCaps));
        assert_eq!(virgin.vault_initial, 0);
        // an exempt first buy still captures the baseline (but is otherwise skipped)
        let mut cfg2 = fresh();
        run(&r, &mut cfg2, &mut unregistered(), &mut unregistered(), &Transfer { dst_owner_exempt: true, ..first(SUPPLY / 10) }).unwrap();
        assert_eq!(cfg2.vault_initial, SUPPLY);
        // a zero buy cap means no cap
        let open = [rule(KIND_SLIDING_CAPS, &[1, 0, 100, 0, 0])];
        run(&open, &mut fresh(), &mut unregistered(), &mut unregistered(), &first(SUPPLY / 2)).unwrap();
        // five levels: the fifth level's caps come from p4 (buy 20%, sell 10%) once 90% is sold
        let five = [rule(KIND_SLIDING_CAPS, &[5, 200 | (300 << 16) | (500 << 32) | (1_000 << 48), 100 | (150 << 16) | (200 << 32) | (500 << 48), 1_000 | (2_000 << 16) | (3_000 << 32) | (9_000 << 48), 2_000 | (1_000 << 16)])];
        let mut cfg5 = ConfigState { vault_initial: SUPPLY, ..fresh() };
        run(&five, &mut cfg5, &mut unregistered(), &mut unregistered(), &vault_at(SWAP_BASE * 9 / 10, pct(2_000))).unwrap();
        assert_eq!(run(&five, &mut cfg5, &mut unregistered(), &mut unregistered(), &vault_at(SWAP_BASE * 9 / 10, pct(2_000) + 1)), Err(HookError::SlidingCaps));
        run(&five, &mut cfg5, &mut unregistered(), &mut unregistered(), &sell_at(SWAP_BASE, pct(1_000))).unwrap();
        assert_eq!(run(&five, &mut cfg5, &mut unregistered(), &mut unregistered(), &sell_at(SWAP_BASE, pct(1_000) + 1)), Err(HookError::SlidingCaps));
        // level 3 (30%..90% sold): buy 10%, sell 5%
        run(&five, &mut cfg5, &mut unregistered(), &mut unregistered(), &vault_at(SWAP_BASE / 2, pct(1_000))).unwrap();
        assert_eq!(run(&five, &mut cfg5, &mut unregistered(), &mut unregistered(), &vault_at(SWAP_BASE / 2, pct(1_000) + 1)), Err(HookError::SlidingCaps));
    }

    #[test]
    fn graduated_sell_caps() {
        // small holders 1%, big bags 0.1%, bag = 3% of supply
        let r = [rule(KIND_GRADUATED_SELL_CAPS, &[100, 10, 300])];
        let bag = pct(300);
        assert_eq!(graduated_cap_bps(100, 10, 300, 0, SUPPLY).unwrap(), 100);
        assert_eq!(graduated_cap_bps(100, 10, 300, bag / 2, SUPPLY).unwrap(), 55);
        assert_eq!(graduated_cap_bps(100, 10, 300, bag, SUPPLY).unwrap(), 10);
        assert_eq!(graduated_cap_bps(100, 10, 300, SUPPLY, SUPPLY).unwrap(), 10);
        assert_eq!(graduated_cap_bps(100, 10, 300, bag / 3, SUPPLY).unwrap(), 70);
        assert_eq!(graduated_cap_bps(100, 10, 1, 5, 100).unwrap(), 10, "a bag that rounds to zero uses the big-bag cap");
        let t = |pre: u64, amount: u64| Transfer { amount, src_post_balance: pre - amount, ..sell() };
        // a small holder (0.1% of supply, a thirtieth of the bag) has a 0.97% cap: it may sell everything
        simple(&r, &t(pct(10), pct(10))).unwrap();
        // a wallet holding 1% is a third of the bag: its cap is 0.7%
        simple(&r, &t(pct(100), pct(70))).unwrap();
        assert_eq!(simple(&r, &t(pct(100), pct(70) + 1)), Err(HookError::GraduatedSellCaps));
        // half a bag: 0.55%
        simple(&r, &t(bag / 2, pct(55))).unwrap();
        assert_eq!(simple(&r, &t(bag / 2, pct(55) + 1)), Err(HookError::GraduatedSellCaps));
        // a full bag and more: 0.1%
        simple(&r, &t(bag, pct(10))).unwrap();
        assert_eq!(simple(&r, &t(bag, pct(10) + 1)), Err(HookError::GraduatedSellCaps));
        assert_eq!(simple(&r, &t(SUPPLY / 2, pct(10) + 1)), Err(HookError::GraduatedSellCaps));
        // sends are capped like sells; buys never
        assert_eq!(simple(&r, &Transfer { amount: pct(10) + 1, src_post_balance: SUPPLY / 2, ..base() }), Err(HookError::GraduatedSellCaps));
        simple(&r, &Transfer { amount: SUPPLY / 2, ..buy() }).unwrap();
    }

    #[test]
    fn max_per_wallet() {
        let r = [rule(KIND_MAX_PER_WALLET, &[200])]; // 2%
        let cap = pct(200);
        simple(&r, &Transfer { dst_post_balance: cap, ..buy() }).unwrap();
        assert_eq!(simple(&r, &Transfer { dst_post_balance: cap + 1, ..buy() }), Err(HookError::MaxPerWallet));
        assert_eq!(simple(&r, &Transfer { dst_post_balance: cap + 1, ..base() }), Err(HookError::MaxPerWallet));
        simple(&r, &Transfer { dst_post_balance: SUPPLY, ..sell() }).unwrap();
        simple(&r, &Transfer { dst_post_balance: SUPPLY, dst_owner_exempt: true, ..base() }).unwrap();
    }

    #[test]
    fn rising_max_per_wallet() {
        assert_eq!(rising_cap_bps(10, 0, 10, 300, None), 10, "the start cap before the clock");
        assert_eq!(rising_cap_bps(10, 0, 10, 300, Some(299)), 10);
        assert_eq!(rising_cap_bps(10, 0, 10, 300, Some(300)), 20);
        assert_eq!(rising_cap_bps(10, 0, 10, 300, Some(3_000)), 110);
        assert_eq!(rising_cap_bps(10, 0, 10, 300, Some(u64::MAX)), 10_000, "saturates at 100%");
        assert_eq!(rising_cap_bps(10, 1, 0, 300, Some(300)), 20);
        assert_eq!(rising_cap_bps(10, 1, 0, 300, Some(600)), 40);
        assert_eq!(rising_cap_bps(10, 1, 0, 300, Some(3_000)), 10_000, "2^10 x 10 bps = 102.4% -> 100%");
        assert_eq!(rising_cap_bps(10, 1, 0, 300, Some(300 * 70)), 10_000, "huge exponents saturate");
        assert_eq!(rising_cap_bps(10, 0, 10, 0, Some(300)), 10, "a zero interval never rises");
        let r = [rule(KIND_RISING_MAX_PER_WALLET, &[10, 0, 10, 300])]; // 0.1% + 0.1% every 5 min
        let mut cfg = ConfigState { started_at: NOW, start_slot: SLOT, ..fresh() };
        let mut go = |elapsed: i64, balance: u64| run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { now: NOW + elapsed, dst_post_balance: balance, ..buy() });
        go(0, pct(10)).unwrap();
        assert_eq!(go(0, pct(10) + 1), Err(HookError::RisingMaxPerWallet));
        assert_eq!(go(299, pct(10) + 1), Err(HookError::RisingMaxPerWallet));
        go(300, pct(20)).unwrap();
        assert_eq!(go(300, pct(20) + 1), Err(HookError::RisingMaxPerWallet));
        go(300 * 999, SUPPLY).unwrap();
        // doubling mode and the clock not started yet
        let d = [rule(KIND_RISING_MAX_PER_WALLET, &[10, 1, 0, 300])];
        assert_eq!(run(&d, &mut fresh(), &mut unregistered(), &mut unregistered(), &Transfer { dst_post_balance: pct(10) + 1, ..base() }), Err(HookError::RisingMaxPerWallet));
        let mut cfg2 = ConfigState { started_at: NOW, start_slot: SLOT, ..fresh() };
        run(&d, &mut cfg2, &mut unregistered(), &mut unregistered(), &Transfer { now: NOW + 600, dst_post_balance: pct(40), ..buy() }).unwrap();
        assert_eq!(run(&d, &mut cfg2, &mut unregistered(), &mut unregistered(), &Transfer { now: NOW + 600, dst_post_balance: pct(40) + 1, ..buy() }), Err(HookError::RisingMaxPerWallet));
        simple(&r, &Transfer { dst_post_balance: SUPPLY, dst_owner_exempt: true, ..buy() }).unwrap();
    }

    #[test]
    fn chapters() {
        let chapter = 1_000_000_000_000u64; // 1M tokens
        assert_eq!(chapters_cap_bps(100, chapter, 0), 100);
        assert_eq!(chapters_cap_bps(100, chapter, chapter - 1), 100);
        assert_eq!(chapters_cap_bps(100, chapter, chapter), 200);
        assert_eq!(chapters_cap_bps(100, chapter, 3 * chapter), 800);
        assert_eq!(chapters_cap_bps(100, chapter, 7 * chapter), 10_000, "2^7 x 1% = 128% -> 100%");
        assert_eq!(chapters_cap_bps(100, chapter, u64::MAX), 10_000);
        assert_eq!(chapters_cap_bps(100, 0, 5), 100, "a zero chapter never doubles");
        let r = [rule(KIND_CHAPTERS, &[100, chapter])];
        let mut cfg = fresh();
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: chapter / 2, dst_post_balance: pct(100), ..buy() }).unwrap();
        assert_eq!(cfg.volume_bought, chapter / 2);
        assert_eq!(run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: chapter / 2, dst_post_balance: pct(100) + 1, ..buy() }), Err(HookError::Chapters));
        assert_eq!(cfg.volume_bought, chapter / 2, "a failed buy adds nothing");
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: chapter / 2, dst_post_balance: pct(100), ..buy() }).unwrap();
        assert_eq!(cfg.volume_bought, chapter, "chapter two begins");
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: 1, dst_post_balance: pct(200), ..buy() }).unwrap();
        assert_eq!(run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: 1, dst_post_balance: pct(200) + 1, ..buy() }), Err(HookError::Chapters));
        // sells never fail and never count; exempt buys do not count; sends are capped but do not count
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: SUPPLY / 2, dst_post_balance: SUPPLY, ..sell() }).unwrap();
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: SUPPLY / 2, dst_owner_exempt: true, dst_post_balance: SUPPLY, ..buy() }).unwrap();
        assert_eq!(run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { dst_post_balance: pct(200) + 1, ..base() }), Err(HookError::Chapters));
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { dst_post_balance: pct(200), ..base() }).unwrap();
        assert_eq!(cfg.volume_bought, chapter + 1);
    }

    #[test]
    fn trade_guard() {
        let r = [rule(KIND_TRADE_GUARD, &[50])]; // 0.5%
        simple(&r, &Transfer { amount: pct(50), ..buy() }).unwrap();
        assert_eq!(simple(&r, &Transfer { amount: pct(50) + 1, ..buy() }), Err(HookError::TradeGuard));
        assert_eq!(simple(&r, &Transfer { amount: pct(50) + 1, ..sell() }), Err(HookError::TradeGuard));
        assert_eq!(simple(&r, &Transfer { amount: pct(50) + 1, src_post_balance: SUPPLY, ..base() }), Err(HookError::TradeGuard));
        // the creator is not exempt on sends; exempt venue flows still skip
        assert_eq!(simple(&r, &Transfer { amount: pct(50) + 1, src_owner_exempt: true, src_post_balance: SUPPLY, ..base() }), Err(HookError::TradeGuard));
        simple(&r, &Transfer { amount: SUPPLY, src_owner_exempt: true, ..sell() }).unwrap();
    }

    #[test]
    fn anti_bundle() {
        let r = [rule(KIND_ANTI_BUNDLE, &[3])];
        let mut cfg = fresh();
        for _ in 0..3 {
            run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &buy()).unwrap();
        }
        assert_eq!((cfg.last_slot, cfg.slot_trades), (SLOT, 3));
        assert_eq!(run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &buy()), Err(HookError::AntiBundle), "the fourth trade in the block");
        assert_eq!(run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &sell()), Err(HookError::AntiBundle), "sells count too");
        // sends do not count
        cfg.slot_trades = 3;
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &base()).unwrap();
        assert_eq!(cfg.slot_trades, 3);
        // a new slot starts a new count
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { slot: SLOT + 1, ..buy() }).unwrap();
        assert_eq!((cfg.last_slot, cfg.slot_trades), (SLOT + 1, 1));
        // exempt trades are skipped and not counted
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { slot: SLOT + 1, dst_owner_exempt: true, ..buy() }).unwrap();
        assert_eq!(cfg.slot_trades, 1);
        let one = [rule(KIND_ANTI_BUNDLE, &[1])];
        let mut cfg1 = fresh();
        run(&one, &mut cfg1, &mut unregistered(), &mut unregistered(), &buy()).unwrap();
        assert_eq!(run(&one, &mut cfg1, &mut unregistered(), &mut unregistered(), &buy()), Err(HookError::AntiBundle));
    }

    #[test]
    fn venue_locked() {
        let r = [rule(KIND_VENUE_LOCKED, &[])];
        simple(&r, &buy()).unwrap();
        simple(&r, &sell()).unwrap();
        assert_eq!(simple(&r, &base()), Err(HookError::VenueLocked));
        assert_eq!(simple(&r, &Transfer { same_owner: true, ..base() }), Err(HookError::VenueLocked));
        // "(or exempt)": the creator or Launchpad's authority may move coins wallet-to-wallet
        simple(&r, &Transfer { src_owner_exempt: true, ..base() }).unwrap();
        simple(&r, &Transfer { dst_owner_exempt: true, ..base() }).unwrap();
    }

    #[test]
    fn market_hours() {
        let open = days_from_civil(2024, 1, 2) * 86_400 + 15 * 3_600; // Tuesday 10:00 New York (15:00 UTC, winter)
        let closed = open + 7 * 3_600; // 17:00 New York
        let holiday = days_from_civil(2024, 7, 4) * 86_400 + 15 * 3_600; // Independence Day, 11:00 EDT
        let r = [rule(KIND_MARKET_HOURS, &[0, 0])];
        simple(&r, &Transfer { now: open, ..buy() }).unwrap();
        simple(&r, &Transfer { now: open, ..sell() }).unwrap();
        assert_eq!(simple(&r, &Transfer { now: closed, ..buy() }), Err(HookError::MarketHours));
        assert_eq!(simple(&r, &Transfer { now: closed, ..sell() }), Err(HookError::MarketHours));
        assert_eq!(simple(&r, &Transfer { now: holiday, ..buy() }), Err(HookError::MarketHours));
        simple(&r, &Transfer { now: closed, ..base() }).unwrap();
        simple(&r, &Transfer { now: holiday, ..base() }).unwrap();
        // sells stay open after hours
        let sells_open = [rule(KIND_MARKET_HOURS, &[1, 0])];
        assert_eq!(simple(&sells_open, &Transfer { now: closed, ..buy() }), Err(HookError::MarketHours));
        simple(&sells_open, &Transfer { now: closed, ..sell() }).unwrap();
        simple(&sells_open, &Transfer { now: holiday, ..sell() }).unwrap();
        // holidays ignored
        let no_holidays = [rule(KIND_MARKET_HOURS, &[0, 1])];
        simple(&no_holidays, &Transfer { now: holiday, ..buy() }).unwrap();
        assert_eq!(simple(&no_holidays, &Transfer { now: closed, ..buy() }), Err(HookError::MarketHours));
        // exempt flows skip even when closed
        simple(&r, &Transfer { now: closed, src_owner_exempt: true, ..sell() }).unwrap();
        // the boundaries: 09:30 opens, 16:00 closes (winter: 14:30 / 21:00 UTC)
        let day = days_from_civil(2024, 1, 2) * 86_400;
        assert_eq!(simple(&r, &Transfer { now: day + 14 * 3_600 + 29 * 60 + 59, ..buy() }), Err(HookError::MarketHours));
        simple(&r, &Transfer { now: day + 14 * 3_600 + 30 * 60, ..buy() }).unwrap();
        simple(&r, &Transfer { now: day + 20 * 3_600 + 59 * 60 + 59, ..buy() }).unwrap();
        assert_eq!(simple(&r, &Transfer { now: day + 21 * 3_600, ..buy() }), Err(HookError::MarketHours));
    }

    #[test]
    fn ping_pong() {
        let r = [rule(KIND_PING_PONG, &[10_000, 600])]; // trades of at least 1% take the turn; the turn frees after 10 min
        let min = share_ppm(SUPPLY, 10_000).unwrap();
        assert_eq!(min, pct(100));
        let mut cfg = fresh();
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: min, ..buy() }).unwrap();
        assert_eq!((cfg.turn_side, cfg.turn_ts), (TURN_BUY, NOW));
        assert_eq!(run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: min, now: NOW + 1, ..buy() }), Err(HookError::PingPong), "two buys in a row");
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: min - 1, now: NOW + 1, ..buy() }).unwrap();
        assert_eq!((cfg.turn_side, cfg.turn_ts), (TURN_BUY, NOW), "a small buy passes and leaves the turn alone");
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: min, now: NOW + 2, ..sell() }).unwrap();
        assert_eq!((cfg.turn_side, cfg.turn_ts), (TURN_SELL, NOW + 2));
        assert_eq!(run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: min, now: NOW + 601, ..sell() }), Err(HookError::PingPong), "still held one second before it frees");
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: min, now: NOW + 602, ..sell() }).unwrap();
        assert_eq!((cfg.turn_side, cfg.turn_ts), (TURN_SELL, NOW + 602), "a freed turn is taken again");
        // sends never touch the turn; exempt trades are skipped
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: SUPPLY / 2, src_post_balance: SUPPLY / 2, now: NOW + 603, ..base() }).unwrap();
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: min, now: NOW + 603, src_owner_exempt: true, ..sell() }).unwrap();
        assert_eq!((cfg.turn_side, cfg.turn_ts), (TURN_SELL, NOW + 602));
        // never frees, any size takes the turn
        let strict = [rule(KIND_PING_PONG, &[0, 0])];
        let mut cfg2 = fresh();
        assert_eq!(cfg2.turn_side, TURN_NONE);
        run(&strict, &mut cfg2, &mut unregistered(), &mut unregistered(), &Transfer { amount: 1, ..sell() }).unwrap();
        assert_eq!(run(&strict, &mut cfg2, &mut unregistered(), &mut unregistered(), &Transfer { amount: 1, now: NOW + 1_000_000, ..sell() }), Err(HookError::PingPong));
        run(&strict, &mut cfg2, &mut unregistered(), &mut unregistered(), &Transfer { amount: 1, now: NOW + 1_000_000, ..buy() }).unwrap();
    }

    #[test]
    fn breathing_cap() {
        let (cycle, base_bps, swing, floor) = (300u64, 100u64, 60u64, 10u64);
        assert_eq!(breathing_cap_bps(cycle, base_bps, swing, floor, None), 100, "the base before the clock starts");
        assert_eq!(breathing_cap_bps(cycle, base_bps, swing, floor, Some(0)), 100);
        assert_eq!(breathing_cap_bps(cycle, base_bps, swing, floor, Some(75)), 160, "the peak at a quarter cycle");
        assert_eq!(breathing_cap_bps(cycle, base_bps, swing, floor, Some(150)), 100);
        assert_eq!(breathing_cap_bps(cycle, base_bps, swing, floor, Some(225)), 40, "the trough");
        assert_eq!(breathing_cap_bps(cycle, base_bps, swing, floor, Some(300)), 100);
        assert_eq!(breathing_cap_bps(cycle, base_bps, swing, floor, Some(3_075)), 160, "periodic");
        assert_eq!(breathing_cap_bps(cycle, base_bps, 100, floor, Some(225)), 10, "the floor holds");
        assert_eq!(breathing_cap_bps(cycle, 9_000, 100, floor, Some(75)), 10_000, "never above 100%");
        for e in 0..=2 * cycle {
            let v = breathing_cap_bps(cycle, base_bps, swing, floor, Some(e));
            assert!((40..=160).contains(&v), "{} at {}", v, e);
        }
        let r = [rule(KIND_BREATHING_CAP, &[cycle, base_bps, swing, floor])];
        let mut cfg = ConfigState { started_at: NOW, start_slot: SLOT, ..fresh() };
        let mut go = |elapsed: i64, amount: u64| run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { now: NOW + elapsed, amount, ..buy() });
        go(0, pct(100)).unwrap();
        assert_eq!(go(0, pct(100) + 1), Err(HookError::BreathingCap));
        go(75, pct(160)).unwrap();
        assert_eq!(go(75, pct(160) + 1), Err(HookError::BreathingCap));
        go(225, pct(40)).unwrap();
        assert_eq!(go(225, pct(40) + 1), Err(HookError::BreathingCap));
        // sells and sends are never capped; exempt buyers skip
        simple(&r, &Transfer { amount: SUPPLY, ..sell() }).unwrap();
        simple(&r, &Transfer { amount: SUPPLY, src_post_balance: 0, ..base() }).unwrap();
        simple(&r, &Transfer { amount: SUPPLY, dst_owner_exempt: true, ..buy() }).unwrap();
        // before the clock starts the first buy is capped at the base
        assert_eq!(run(&r, &mut fresh(), &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(100) + 1, ..buy() }), Err(HookError::BreathingCap));
    }

    #[test]
    fn momentum() {
        let r = [rule(KIND_MOMENTUM, &[120, 8, 40, 100, 25])]; // 2 min period, 8%/s damping, 40% kick, 1% base, 0.25% floor
        let mut cfg = fresh();
        // at rest the cap is the base; a buy of the base size adds 40% of full energy
        assert_eq!(run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(100) + 1, ..buy() }), Err(HookError::Momentum));
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(100), ..buy() }).unwrap();
        assert_eq!((cfg.osc_energy, cfg.osc_phase, cfg.osc_ts), (400_000, 0, NOW));
        // 30 s later: the energy has decayed and the phase is a quarter in (sin = 1), so the cap is above the base
        let energy = apply_decay(400_000, decay_factor(8, 30));
        let cap = cap_with_swing(100, energy, Q16_ONE, 25);
        assert!(cap > 100 && cap < 110, "cap {}", cap);
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(cap), now: NOW + 30, ..buy() }).unwrap();
        assert_eq!((cfg.osc_phase, cfg.osc_ts), (PHASE_QUARTER, NOW + 30));
        assert_eq!(cfg.osc_energy, energy + 400_000, "a second full-size buy adds another 40%");
        let mut probe = ConfigState { osc_energy: 400_000, osc_ts: NOW, ..fresh() };
        assert_eq!(run(&r, &mut probe, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(cap) + 1, now: NOW + 30, ..buy() }), Err(HookError::Momentum));
        // full energy at the peak doubles the cap; at the trough the floor holds
        let mut peak = ConfigState { osc_energy: ENERGY_ONE, osc_phase: PHASE_QUARTER, osc_ts: NOW, ..fresh() };
        run(&r, &mut peak, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(200), ..buy() }).unwrap();
        let mut trough = ConfigState { osc_energy: ENERGY_ONE, osc_phase: 3 * PHASE_QUARTER, osc_ts: NOW, ..fresh() };
        run(&r, &mut trough, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(25), ..buy() }).unwrap();
        assert_eq!(run(&r, &mut ConfigState { osc_energy: ENERGY_ONE, osc_phase: 3 * PHASE_QUARTER, osc_ts: NOW, ..fresh() }, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(25) + 1, ..buy() }), Err(HookError::Momentum));
        // a half-size buy adds half the kick; energy never exceeds 1.0
        let mut half = fresh();
        run(&r, &mut half, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(50), ..buy() }).unwrap();
        assert_eq!(half.osc_energy, 200_000);
        let mut full = ConfigState { osc_energy: 900_000, osc_ts: NOW, ..fresh() };
        run(&r, &mut full, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(100), ..buy() }).unwrap();
        assert_eq!(full.osc_energy, ENERGY_ONE);
        // sells and sends are never capped and never kick; exempt buys decay the oscillator but do not kick
        let mut quiet = ConfigState { osc_energy: 400_000, osc_ts: NOW, ..fresh() };
        run(&r, &mut quiet, &mut unregistered(), &mut unregistered(), &Transfer { amount: SUPPLY / 2, now: NOW + 10, ..sell() }).unwrap();
        assert_eq!((quiet.osc_energy, quiet.osc_ts), (apply_decay(400_000, decay_factor(8, 10)), NOW + 10));
        run(&r, &mut quiet, &mut unregistered(), &mut unregistered(), &Transfer { amount: SUPPLY / 2, src_post_balance: 0, now: NOW + 20, ..base() }).unwrap();
        assert_eq!(quiet.osc_ts, NOW + 10, "sends do not touch the oscillator");
        run(&r, &mut quiet, &mut unregistered(), &mut unregistered(), &Transfer { amount: SUPPLY / 2, dst_owner_exempt: true, now: NOW + 20, ..buy() }).unwrap();
        assert_eq!(quiet.osc_ts, NOW + 20);
        assert_eq!(quiet.osc_energy, apply_decay(400_000, decay_factor(8, 20)));
        // long idle: back to rest
        run(&r, &mut quiet, &mut unregistered(), &mut unregistered(), &Transfer { amount: 1, now: NOW + 100_000, ..buy() }).unwrap();
        assert_eq!(quiet.osc_energy, 0 + osc::kick(0, 40, 1, pct(100), Q16_ONE as u64));
    }

    #[test]
    fn resonance() {
        let r = [rule(KIND_RESONANCE, &[60, 2, 40, 100, 25])]; // 60 s beat, 2%/s damping, 40% kick, 1% base
        let mut cfg = fresh();
        // the first buy starts the clock on the beat: full kick
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(100), ..buy() }).unwrap();
        assert_eq!(cfg.osc_energy, 400_000);
        // one beat later, on the beat again: the cap is base x (1 + E) and the kick is full
        let energy = apply_decay(400_000, decay_factor(2, 60));
        let cap = 100 + 100 * energy / ENERGY_ONE;
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(cap), now: NOW + 60, ..buy() }).unwrap();
        assert_eq!(cfg.osc_energy, energy + 400_000);
        let mut probe = ConfigState { started_at: NOW, osc_energy: 400_000, osc_ts: NOW, ..fresh() };
        assert_eq!(run(&r, &mut probe, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(cap) + 1, now: NOW + 60, ..buy() }), Err(HookError::Resonance));
        // half way between beats a buy adds nothing; a quarter beat in it adds half
        let mut off = ConfigState { started_at: NOW, osc_ts: NOW + 30, ..fresh() };
        run(&r, &mut off, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(100), now: NOW + 30, ..buy() }).unwrap();
        assert_eq!(off.osc_energy, 0);
        let mut quarter = ConfigState { started_at: NOW, osc_ts: NOW + 15, ..fresh() };
        run(&r, &mut quarter, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(100), now: NOW + 15, ..buy() }).unwrap();
        assert_eq!(quarter.osc_energy, 200_000);
        // full energy doubles the cap, whatever the phase
        let mut full = ConfigState { started_at: NOW, osc_energy: ENERGY_ONE, osc_ts: NOW + 30, ..fresh() };
        run(&r, &mut full, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(200), now: NOW + 30, ..buy() }).unwrap();
        assert_eq!(run(&r, &mut ConfigState { started_at: NOW, osc_energy: ENERGY_ONE, osc_ts: NOW + 30, ..fresh() }, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(200) + 1, now: NOW + 30, ..buy() }), Err(HookError::Resonance));
        // sells are free
        simple(&r, &Transfer { amount: SUPPLY, ..sell() }).unwrap();
    }

    #[test]
    fn coupled_resonator() {
        let r = [rule(KIND_COUPLED_RESONATOR, &[180, 20, 2, 40, 100, 25])];
        let mut cfg = fresh();
        assert_eq!(run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(100) + 1, ..buy() }), Err(HookError::CoupledResonator));
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(100), ..buy() }).unwrap();
        assert_eq!((cfg.osc_energy, cfg.osc_energy2), (400_000, 0), "buys kick the first oscillator only");
        // one second later energy has flowed to the second oscillator and both decayed
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: 1, now: NOW + 1, ..sell() }).unwrap();
        assert_eq!((cfg.osc_energy, cfg.osc_energy2), (352_800, 39_200));
        assert_eq!(cfg.osc_phase, 65_536 / 180);
        // the cap follows E1 and the phase
        let sin = sin_q16(cfg.osc_phase);
        let cap = cap_with_swing(100, 352_800, sin, 25);
        assert!(cap > 100);
        let snapshot = cfg;
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(cap), now: NOW + 1, ..buy() }).unwrap();
        assert_eq!(run(&r, &mut snapshot.clone(), &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(cap) + 1, now: NOW + 1, ..buy() }), Err(HookError::CoupledResonator));
        // the second oscillator feeds back: after a long quiet spell with no damping the two equalise
        let free = [rule(KIND_COUPLED_RESONATOR, &[180, 20, 0, 40, 100, 25])];
        let mut lossless = ConfigState { osc_energy: 800_000, osc_ts: NOW, ..fresh() };
        run(&free, &mut lossless, &mut unregistered(), &mut unregistered(), &Transfer { amount: 1, now: NOW + 1_000, ..sell() }).unwrap();
        assert_eq!((lossless.osc_energy, lossless.osc_energy2), (400_000, 400_000));
        // the floor holds at the trough
        let mut trough = ConfigState { osc_energy: ENERGY_ONE, osc_phase: 3 * PHASE_QUARTER, osc_ts: NOW, ..fresh() };
        run(&r, &mut trough, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(25), ..buy() }).unwrap();
        assert_eq!(run(&r, &mut ConfigState { osc_energy: ENERGY_ONE, osc_phase: 3 * PHASE_QUARTER, osc_ts: NOW, ..fresh() }, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(25) + 1, ..buy() }), Err(HookError::CoupledResonator));
    }

    #[test]
    fn blocklist() {
        let r = [rule(KIND_BLOCKLIST, &[])];
        simple(&r, &base()).unwrap();
        assert_eq!(simple(&r, &Transfer { dst_blocked: true, ..base() }), Err(HookError::Blocklist));
        assert_eq!(simple(&r, &Transfer { dst_blocked: true, ..buy() }), Err(HookError::Blocklist));
        simple(&r, &Transfer { dst_blocked: true, ..sell() }).unwrap();
        simple(&r, &Transfer { dst_blocked: true, dst_owner_exempt: true, ..base() }).unwrap();
        simple(&r, &Transfer { dst_blocked: true, dst_owner_exempt: true, ..buy() }).unwrap();
    }

    #[test]
    fn hot_potato() {
        let r = [rule(KIND_HOT_POTATO, &[10_000, 600])]; // buys of at least 1% take the potato; it goes cold after 10 min
        let min = pct(100);
        let mut cfg = fresh();
        let buy_by = |who: [u8; 32], amount: u64, when: i64| Transfer { amount, now: when, dst_owner: who, ..buy() };
        let sell_by = |who: [u8; 32], when: i64| Transfer { now: when, src_owner: who, ..sell() };
        let send_by = |who: [u8; 32], when: i64| Transfer { now: when, src_owner: who, ..base() };
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &buy_by(BOB, min, NOW)).unwrap();
        assert_eq!((cfg.potato_holder, cfg.potato_since), (BOB, NOW));
        assert_eq!(run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &sell_by(BOB, NOW + 1)), Err(HookError::HotPotato));
        assert_eq!(run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &send_by(BOB, NOW + 1)), Err(HookError::HotPotato));
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &sell_by(ALICE, NOW + 1)).unwrap();
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &send_by(ALICE, NOW + 1)).unwrap();
        // a small buy does not take the potato
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &buy_by(CAROL, min - 1, NOW + 2)).unwrap();
        assert_eq!(cfg.potato_holder, BOB);
        // an exempt buyer never holds it
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { dst_owner_exempt: true, ..buy_by(CAROL, min, NOW + 2) }).unwrap();
        assert_eq!(cfg.potato_holder, BOB);
        // cold after 600 s
        assert_eq!(run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &sell_by(BOB, NOW + 599)), Err(HookError::HotPotato));
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &sell_by(BOB, NOW + 600)).unwrap();
        // another qualifying buy passes it on
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &buy_by(CAROL, min, NOW + 700)).unwrap();
        assert_eq!((cfg.potato_holder, cfg.potato_since), (CAROL, NOW + 700));
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &sell_by(BOB, NOW + 701)).unwrap();
        assert_eq!(run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &sell_by(CAROL, NOW + 701)), Err(HookError::HotPotato));
        // the holder buying again keeps and refreshes it
        run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &buy_by(CAROL, min, NOW + 800)).unwrap();
        assert_eq!(cfg.potato_since, NOW + 800);
        // never cold, any buy qualifies
        let forever = [rule(KIND_HOT_POTATO, &[0, 0])];
        let mut cfg2 = fresh();
        run(&forever, &mut cfg2, &mut unregistered(), &mut unregistered(), &buy_by(BOB, 1, NOW)).unwrap();
        assert_eq!(run(&forever, &mut cfg2, &mut unregistered(), &mut unregistered(), &sell_by(BOB, NOW + 1_000_000)), Err(HookError::HotPotato));
        // nobody holds it yet: everyone sells freely
        run(&forever, &mut fresh(), &mut unregistered(), &mut unregistered(), &sell_by(BOB, NOW)).unwrap();
    }

    #[test]
    fn dex_only() {
        assert!(!dex_only_ok(1) && !dex_only_ok(2) && dex_only_ok(3) && dex_only_ok(4) && dex_only_ok(u64::MAX));
        let r = [rule(KIND_DEX_ONLY, &[])];
        simple(&r, &base()).unwrap();
        simple(&r, &buy()).unwrap();
        simple(&r, &sell()).unwrap();
        assert_eq!(simple(&r, &Transfer { stack_height: 2, ..base() }), Err(HookError::DexOnly), "a send signed directly");
        assert_eq!(simple(&r, &Transfer { stack_height: 2, ..buy() }), Err(HookError::DexOnly));
        assert_eq!(simple(&r, &Transfer { stack_height: 2, src_owner_exempt: true, ..base() }), Err(HookError::DexOnly), "the creator is not exempt on sends");
        simple(&r, &Transfer { stack_height: 2, src_owner_exempt: true, ..sell() }).unwrap();
    }

    #[test]
    fn p2p_only() {
        let r = [rule(KIND_P2P_ONLY, &[])];
        assert_eq!(simple(&r, &buy()), Err(HookError::P2pOnly));
        simple(&r, &Transfer { dst_is_creator: true, ..buy() }).unwrap();
        assert_eq!(simple(&r, &sell()), Err(HookError::P2pOnly));
        assert_eq!(simple(&r, &Transfer { dst_is_creator: true, ..sell() }), Err(HookError::P2pOnly));
        simple(&r, &base()).unwrap();
        simple(&r, &Transfer { src_owner_exempt: true, ..base() }).unwrap();
        // fee claims (venue -> exempt) and exempt sells skip
        simple(&r, &Transfer { dst_owner_exempt: true, ..buy() }).unwrap();
        simple(&r, &Transfer { src_owner_exempt: true, ..sell() }).unwrap();
    }

    #[test]
    fn sniper_fee_cap() {
        let r = [rule(KIND_SNIPER_FEE_CAP, &[600, 2_000_000, 2_000_000])];
        assert!(sniper_window_open(0, NOW, 600) && sniper_window_open(NOW, NOW + 599, 600) && !sniper_window_open(NOW, NOW + 600, 600));
        assert!(sniper_window_open(NOW, NOW + 1_000_000, 0), "a zero window is forever");
        let mut cfg = ConfigState { started_at: NOW, start_slot: SLOT, ..fresh() };
        let mut go = |when: i64, fee: u64, tip: u64| run(&r, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { now: when, priority_fee_lamports: fee, jito_tip_lamports: tip, ..buy() });
        go(NOW + 599, 2_000_000, 2_000_000).unwrap();
        assert_eq!(go(NOW + 599, 2_000_001, 0), Err(HookError::SniperFeeCap));
        assert_eq!(go(NOW + 599, 0, 2_000_001), Err(HookError::SniperFeeCap));
        go(NOW + 600, u64::MAX, u64::MAX).unwrap();
        // the first buy starts the clock and is inside the window
        assert_eq!(run(&r, &mut fresh(), &mut unregistered(), &mut unregistered(), &Transfer { priority_fee_lamports: 2_000_001, ..buy() }), Err(HookError::SniperFeeCap));
        // forever
        let forever = [rule(KIND_SNIPER_FEE_CAP, &[0, 1_000, 1_000])];
        assert_eq!(simple(&forever, &Transfer { now: NOW + 1_000_000, jito_tip_lamports: 1_001, ..buy() }), Err(HookError::SniperFeeCap));
        simple(&forever, &Transfer { now: NOW + 1_000_000, jito_tip_lamports: 1_000, priority_fee_lamports: 1_000, ..buy() }).unwrap();
        // sells and sends pass; exempt buyers skip
        simple(&forever, &Transfer { priority_fee_lamports: u64::MAX, ..sell() }).unwrap();
        simple(&forever, &Transfer { priority_fee_lamports: u64::MAX, ..base() }).unwrap();
        simple(&forever, &Transfer { priority_fee_lamports: u64::MAX, dst_owner_exempt: true, ..buy() }).unwrap();
    }

    #[test]
    fn trading_hours() {
        // Mon-Fri 09:00-17:00 UTC, no DST, buys and sells closed outside
        let r = [rule(KIND_TRADING_HOURS, &[540, 1_020, 31, 1_440, 0, 0])];
        let monday_10 = days_from_civil(2024, 1, 1) * 86_400 + 10 * 3_600;
        let monday_18 = monday_10 + 8 * 3_600;
        simple(&r, &Transfer { now: monday_10, ..buy() }).unwrap();
        simple(&r, &Transfer { now: monday_10, ..sell() }).unwrap();
        assert_eq!(simple(&r, &Transfer { now: monday_18, ..buy() }), Err(HookError::TradingHours));
        assert_eq!(simple(&r, &Transfer { now: monday_18, ..sell() }), Err(HookError::TradingHours));
        assert_eq!(simple(&r, &Transfer { now: monday_10 + 5 * 86_400, ..buy() }), Err(HookError::TradingHours), "Saturday");
        simple(&r, &Transfer { now: monday_18, ..base() }).unwrap();
        // sells stay open outside the window
        let sells_open = [rule(KIND_TRADING_HOURS, &[540, 1_020, 31, 1_440, 0, 1])];
        assert_eq!(simple(&sells_open, &Transfer { now: monday_18, ..buy() }), Err(HookError::TradingHours));
        simple(&sells_open, &Transfer { now: monday_18, ..sell() }).unwrap();
        // New York 09:30-16:00 with US DST: Monday 2024-07-08 13:30 UTC opens
        let ny = [rule(KIND_TRADING_HOURS, &[570, 960, 31, 1_440 - 300, 1, 0])];
        let july_8 = days_from_civil(2024, 7, 8) * 86_400;
        assert_eq!(simple(&ny, &Transfer { now: july_8 + 13 * 3_600 + 29 * 60, ..buy() }), Err(HookError::TradingHours));
        simple(&ny, &Transfer { now: july_8 + 13 * 3_600 + 30 * 60, ..buy() }).unwrap();
        // past midnight, Fridays 22:00-02:00 in Tokyo (UTC+9): Friday 22:00 Tokyo = Friday 13:00 UTC
        let tokyo = [rule(KIND_TRADING_HOURS, &[1_320, 120, 16, 1_440 + 540, 0, 0])];
        let friday = days_from_civil(2024, 1, 5) * 86_400;
        assert_eq!(simple(&tokyo, &Transfer { now: friday + 12 * 3_600 + 59 * 60, ..buy() }), Err(HookError::TradingHours));
        simple(&tokyo, &Transfer { now: friday + 13 * 3_600, ..buy() }).unwrap();
        simple(&tokyo, &Transfer { now: friday + 16 * 3_600 + 59 * 60, ..buy() }).unwrap(); // Saturday 01:59 Tokyo
        assert_eq!(simple(&tokyo, &Transfer { now: friday + 17 * 3_600, ..buy() }), Err(HookError::TradingHours)); // Saturday 02:00 Tokyo
        // exempt flows skip
        simple(&r, &Transfer { now: monday_18, src_owner_exempt: true, ..sell() }).unwrap();
    }

    #[test]
    fn tithe() {
        let r = [rule(KIND_TITHE, &[5_000_000])];
        assert_eq!(simple(&r, &buy()), Err(HookError::Tithe));
        assert_eq!(simple(&r, &Transfer { tithe_lamports: 4_999_999, ..buy() }), Err(HookError::Tithe));
        simple(&r, &Transfer { tithe_lamports: 5_000_000, ..buy() }).unwrap();
        assert_eq!(simple(&r, &Transfer { tithe_lamports: 4_999_999, ..sell() }), Err(HookError::Tithe));
        simple(&r, &Transfer { tithe_lamports: 5_000_000, ..sell() }).unwrap();
        simple(&r, &base()).unwrap();
        // the creator's own trades skip
        simple(&r, &Transfer { src_owner_exempt: true, ..sell() }).unwrap();
        simple(&r, &Transfer { dst_owner_exempt: true, ..buy() }).unwrap();
    }

    #[test]
    fn app_only_rules_need_the_app_mark_in_the_transaction() {
        let app = [7u8; 32];
        let mut params = [0u64; 6];
        for i in 0..4 {
            params[i] = u64::from_le_bytes(app[i * 8..i * 8 + 8].try_into().unwrap());
        }
        params[4] = APP_MARK_PROGRAM as u64;
        assert_eq!(packed_key(&params), app);
        let rules = [Rule { kind: KIND_FOMO_ONLY, params }];
        assert_eq!(app_mark(&rules), Some(AppMark { kind: APP_MARK_PROGRAM, key: app, index: 0 }));
        assert_eq!(app_mark(&[rule(KIND_TITHE, &[1])]), None);
        assert!(needs_sysvar(KIND_FOMO_ONLY) && needs_sysvar(KIND_PUMP_APP_ONLY) && is_app_only(KIND_PUMP_APP_ONLY) && !is_app_only(KIND_TITHE));
        validate_rule(&rules[0]).unwrap();
        // every mark kind validates with its own slot rule; a zero key, an unknown kind or a stray slot do not
        let with = |kind: u64, slot: u64| Rule { kind: KIND_PUMP_APP_ONLY, params: [params[0], params[1], params[2], params[3], kind, slot] };
        validate_rule(&with(2, 0)).unwrap();
        validate_rule(&with(3, 5)).unwrap();
        validate_rule(&with(3, 63)).unwrap();
        assert_eq!(app_mark(&[with(3, 5)]), Some(AppMark { kind: APP_MARK_PROGRAM_ACCOUNT, key: app, index: 5 }));
        assert_eq!(validate_rule(&with(0, 0)), Err(HookError::ConfigMismatch), "the kind is required");
        assert_eq!(validate_rule(&with(4, 0)), Err(HookError::ConfigMismatch), "an unknown kind");
        assert_eq!(validate_rule(&with(1, 5)), Err(HookError::ConfigMismatch), "a slot only belongs to kind 3");
        assert_eq!(validate_rule(&with(2, 1)), Err(HookError::ConfigMismatch));
        assert_eq!(validate_rule(&with(3, 64)), Err(HookError::ConfigMismatch), "slots are under 64");
        assert_eq!(validate_rule(&rule(KIND_PUMP_APP_ONLY, &[0, 0, 0, 0, 1])), Err(HookError::ConfigMismatch), "a zero key is no app");
        // Buys and sells pass only with the mark in the transaction; sends always; the creator's own trades skip.
        assert_eq!(simple(&rules, &buy()), Err(HookError::FomoOnly));
        assert_eq!(simple(&rules, &sell()), Err(HookError::FomoOnly));
        simple(&rules, &Transfer { app_mark_present: true, ..buy() }).unwrap();
        simple(&rules, &Transfer { app_mark_present: true, ..sell() }).unwrap();
        simple(&rules, &base()).unwrap();
        simple(&rules, &Transfer { src_owner_exempt: true, ..sell() }).unwrap();
        simple(&rules, &Transfer { dst_owner_exempt: true, ..buy() }).unwrap();
        let pump = [with(3, 5)];
        assert_eq!(simple(&pump, &buy()), Err(HookError::PumpAppOnly));
        simple(&pump, &Transfer { app_mark_present: true, ..buy() }).unwrap();
    }

    #[test]
    fn several_rules_run_in_order_and_the_first_failure_wins() {
        let rules = [rule(KIND_MAX_PER_WALLET, &[100]), rule(KIND_TRADE_GUARD, &[10])];
        let t = Transfer { amount: pct(50), src_post_balance: SUPPLY / 2, dst_post_balance: SUPPLY, ..base() };
        assert_eq!(simple(&rules, &t), Err(HookError::MaxPerWallet));
        let rev = [rules[1], rules[0]];
        assert_eq!(simple(&rev, &t), Err(HookError::TradeGuard));
        let unknown = [rule(28, &[])];
        assert_eq!(simple(&unknown, &base()), Err(HookError::ConfigMismatch));
        assert_eq!(simple(&[rule(0, &[])], &base()), Err(HookError::ConfigMismatch));
        // a failing later rule leaves the earlier rule's state untouched (nothing is persisted on error anyway)
        let combo = [rule(KIND_CHAPTERS, &[100, 1_000]), rule(KIND_TRADE_GUARD, &[10])];
        let mut cfg = fresh();
        assert_eq!(run(&combo, &mut cfg, &mut unregistered(), &mut unregistered(), &Transfer { amount: pct(50), ..buy() }), Err(HookError::TradeGuard));
        assert_eq!(cfg.volume_bought, 0);
    }

    #[test]
    fn share_math() {
        assert_eq!(share(10_000, 2_500).unwrap(), 2_500);
        assert_eq!(share(u64::MAX, 10_000).unwrap(), u64::MAX);
        assert_eq!(share(999, 1).unwrap(), 0);
        assert_eq!(share(SUPPLY, 1).unwrap(), SUPPLY / 10_000);
        assert_eq!(share(u64::MAX, 10_001), Err(HookError::Overflow));
        assert_eq!(share_ppm(SUPPLY, 10_000).unwrap(), SUPPLY / 100);
        assert_eq!(share_ppm(SUPPLY, 1).unwrap(), SUPPLY / 1_000_000);
        assert_eq!(share_ppm(u64::MAX, 1_000_000).unwrap(), u64::MAX);
        assert_eq!(share_ppm(u64::MAX, 1_000_001), Err(HookError::Overflow));
        assert_eq!(unpack16(0x0004_0003_0002_0001, 0), 1);
        assert_eq!(unpack16(0x0004_0003_0002_0001, 3), 4);
    }

    #[test]
    fn rule_validation() {
        let ok = |kind: u8, p: &[u64]| validate_rule(&rule(kind, p)).is_ok();
        // no parameters
        for kind in [1, 12, 17, 19, 20, 21] {
            assert!(ok(kind, &[]) && ok(kind, &[u64::MAX; 6]), "kind {}", kind);
        }
        assert!(ok(2, &[1, 6]) && !ok(2, &[0, 6]));
        assert!(ok(3, &[0, 86_400, 86_400, 1_000, 500]) && ok(3, &[604_800, 0, 1, 10_000, 1_000_000]));
        assert!(!ok(3, &[0, 86_400, 0, 1_000, 500]) && !ok(3, &[0, 86_400, 86_400, 0, 500]) && !ok(3, &[0, 86_400, 86_400, 10_001, 500]) && !ok(3, &[0, 86_400, 86_400, 1_000, 1_000_001]));
        assert!(ok(4, &[200, 25]) && ok(4, &[0, 1]) && ok(4, &[10_000, 10_000]) && !ok(4, &[10_001, 25]) && !ok(4, &[200, 0]) && !ok(4, &[200, 10_001]));
        // sliding caps: levels, per-level ranges, rising breakpoints, p4 only two fields
        let buys = 200 | (300 << 16) | (500 << 32) | (1_000 << 48);
        let sells = 100 | (150 << 16) | (200 << 32) | (500 << 48);
        let ats = 2_500 | (6_000 << 16) | (8_000 << 32) | (9_000 << 48);
        assert!(ok(5, &[3, buys, sells, ats, 0]) && ok(5, &[1, 0, 1, 0, 0]) && ok(5, &[5, buys, sells, ats, 2_000 | (1_000 << 16)]));
        assert!(!ok(5, &[0, buys, sells, ats, 0]) && !ok(5, &[6, buys, sells, ats, 0]));
        assert!(!ok(5, &[1, 0, 0, 0, 0]), "a zero sell cap");
        assert!(!ok(5, &[1, 10_001, 1, 0, 0]), "a buy cap above 100%");
        assert!(!ok(5, &[2, buys, sells, 0, 0]), "a zero breakpoint");
        assert!(!ok(5, &[3, buys, sells, 6_000 | (2_500 << 16), 0]), "breakpoints must rise");
        assert!(!ok(5, &[3, buys, sells, 2_500 | (2_500 << 16), 0]), "strictly");
        assert!(!ok(5, &[2, buys, sells, 10_000, 0]), "a breakpoint at 100% is never reached");
        assert!(!ok(5, &[5, buys, sells, ats, 2_000 | (0 << 16)]), "level 4 sell cap zero");
        assert!(!ok(5, &[5, buys, sells, ats, (2_000 | (1_000 << 16)) | (1 << 32)]), "p4 holds two fields");
        assert!(ok(6, &[100, 10, 300]) && ok(6, &[100, 100, 300]) && !ok(6, &[10, 100, 300]) && !ok(6, &[100, 0, 300]) && !ok(6, &[100, 10, 0]) && !ok(6, &[10_001, 10, 300]));
        assert!(ok(7, &[10]) && ok(7, &[10_000]) && !ok(7, &[0]) && !ok(7, &[10_001]));
        assert!(ok(8, &[10, 0, 10, 300]) && ok(8, &[10, 1, 0, 300]) && ok(8, &[10, 1, 10, 300]));
        assert!(!ok(8, &[0, 0, 10, 300]) && !ok(8, &[10, 2, 10, 300]) && !ok(8, &[10, 0, 0, 300]) && !ok(8, &[10, 0, 10, 0]) && !ok(8, &[10, 0, 10_001, 300]));
        assert!(ok(9, &[100, 1]) && !ok(9, &[0, 1]) && !ok(9, &[100, 0]) && !ok(9, &[10_001, 1]));
        assert!(ok(10, &[50]) && !ok(10, &[0]) && !ok(10, &[10_001]));
        assert!(ok(11, &[1]) && ok(11, &[20]) && !ok(11, &[0]));
        assert!(ok(13, &[0, 0]) && ok(13, &[1, 1]) && !ok(13, &[2, 0]) && !ok(13, &[0, 2]));
        assert!(ok(14, &[0, 0]) && ok(14, &[1_000_000, 86_400]) && !ok(14, &[1_000_001, 0]));
        assert!(ok(15, &[300, 100, 60, 10]) && ok(15, &[1, 1, 1, 0]) && ok(15, &[30, 100, 100, 100]));
        assert!(!ok(15, &[0, 100, 60, 10]) && !ok(15, &[300, 0, 60, 10]) && !ok(15, &[300, 100, 0, 10]) && !ok(15, &[300, 100, 101, 10]) && !ok(15, &[300, 100, 60, 101]));
        for kind in [16, 23] {
            assert!(ok(kind, &[120, 8, 40, 100, 25]) && ok(kind, &[1, 1, 1, 1, 0]) && ok(kind, &[1_200, 100, 100, 10_000, 10_000]));
            assert!(!ok(kind, &[0, 8, 40, 100, 25]) && !ok(kind, &[120, 0, 40, 100, 25]) && !ok(kind, &[120, 101, 40, 100, 25]) && !ok(kind, &[120, 8, 0, 100, 25]) && !ok(kind, &[120, 8, 40, 0, 25]) && !ok(kind, &[120, 8, 40, 100, 101]));
        }
        assert!(ok(18, &[0, 0]) && ok(18, &[1_000_000, 86_400]) && !ok(18, &[1_000_001, 0]));
        assert!(ok(22, &[540, 1_020, 31, 1_440, 0, 0]) && ok(22, &[0, 1_440, 127, 600, 2, 1]) && ok(22, &[1_439, 1, 1, 2_280, 1, 0]));
        assert!(!ok(22, &[1_440, 1_020, 31, 1_440, 0, 0]) && !ok(22, &[540, 0, 31, 1_440, 0, 0]) && !ok(22, &[540, 1_441, 31, 1_440, 0, 0]));
        assert!(!ok(22, &[540, 1_020, 0, 1_440, 0, 0]) && !ok(22, &[540, 1_020, 128, 1_440, 0, 0]) && !ok(22, &[540, 1_020, 31, 599, 0, 0]) && !ok(22, &[540, 1_020, 31, 2_281, 0, 0]));
        assert!(!ok(22, &[540, 1_020, 31, 1_440, 3, 0]) && !ok(22, &[540, 1_020, 31, 1_440, 0, 2]));
        assert!(ok(24, &[180, 20, 2, 40, 100, 25]) && ok(24, &[1, 1, 0, 1, 1, 0]) && ok(24, &[1_200, 100, 100, 100, 10_000, 10_000]));
        assert!(!ok(24, &[0, 20, 2, 40, 100, 25]) && !ok(24, &[180, 0, 2, 40, 100, 25]) && !ok(24, &[180, 101, 2, 40, 100, 25]) && !ok(24, &[180, 20, 101, 40, 100, 25]));
        assert!(!ok(24, &[180, 20, 2, 0, 100, 25]) && !ok(24, &[180, 20, 2, 40, 0, 25]) && !ok(24, &[180, 20, 2, 40, 100, 101]));
        assert!(ok(25, &[1]) && !ok(25, &[0]));
        assert!(!ok(0, &[]) && !ok(28, &[]) && !ok(255, &[]));
        // sets: empty, too many, duplicates, conflicts
        assert_eq!(validate_rules(&[]), Err(HookError::ConfigMismatch));
        assert_eq!(validate_rules(&[rule(1, &[]); 5]), Err(HookError::ConfigMismatch));
        assert_eq!(validate_rules(&[rule(1, &[]), rule(1, &[])]), Err(HookError::ConfigMismatch));
        assert_eq!(validate_rules(&[rule(1, &[]), rule(17, &[])]), Err(HookError::ConfigMismatch), "allowlist / blocklist");
        assert_eq!(validate_rules(&[rule(16, &[120, 8, 40, 100, 25]), rule(4, &[200, 25])]), Err(HookError::ConfigMismatch), "conflicts are symmetric");
        assert_eq!(validate_rules(&[rule(13, &[0, 0]), rule(7, &[100]), rule(22, &[540, 1_020, 31, 1_440, 0, 0])]), Err(HookError::ConfigMismatch), "a conflict anywhere in the set");
        validate_rules(&[rule(1, &[]), rule(3, &[0, 86_400, 86_400, 1_000, 500]), rule(13, &[0, 0]), rule(25, &[5_000_000])]).unwrap();
        validate_rules(&[rule(17, &[]), rule(18, &[10_000, 600]), rule(21, &[600, 2_000_000, 2_000_000]), rule(24, &[180, 20, 2, 40, 100, 25])]).unwrap();
        assert_eq!(CONFLICTS.len(), 49);
        assert!(conflicts(1, 17) && conflicts(17, 1) && conflicts(20, 21) && !conflicts(1, 3) && !conflicts(7, 7));
        for (a, b) in CONFLICTS {
            assert!((1..=MAX_KIND).contains(&a) && (1..=MAX_KIND).contains(&b) && a != b);
            assert_eq!(validate_rules(&[rule(a, &[]), rule(b, &[])]), Err(HookError::ConfigMismatch));
        }
        assert_eq!(needs_wallet_state(3), true);
        assert!(!needs_wallet_state(5) && !needs_wallet_state(10) && !needs_wallet_state(14));
        assert!(needs_sysvar(21) && needs_sysvar(25) && !needs_sysvar(1));
        assert!(is_oscillator(16) && is_oscillator(23) && is_oscillator(24) && !is_oscillator(15));
    }
}
