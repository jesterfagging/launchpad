//! Account layouts: fixed sizes, little-endian, explicit byte offsets, no borsh.
//!
//! Every struct here packs to and unpacks from a plain byte slice so the same
//! offsets can be mirrored by the JS decoders in `src/hooks/program.mjs`
//! (`HOOK_CONFIG_LAYOUT`, `WALLET_STATE_LAYOUT`, `ALLOW_ENTRY_LAYOUT`,
//! `BLOCKLIST_LAYOUT`). Keys are `[u8; 32]` rather than `Pubkey` so this module
//! (and the rule engine that consumes it) compiles and tests without the Solana
//! SDK. The BlockList (6408 bytes) is never materialised as a struct: a BPF
//! stack frame is 4 KiB, so it is read and written in place through slice views.

use crate::errors::HookError;

/// Layout version written into byte 0 of every account. Nothing of the earlier
/// layout was ever deployed, so the v2 layouts keep byte value 1.
pub const VERSION: u8 = 1;
pub const MAX_RULES: usize = 4;
/// u64 parameters per rule (`HOOK_PARAM_COUNT` in the catalogue).
pub const PARAM_COUNT: usize = 6;
pub const ZERO_KEY: [u8; 32] = [0u8; 32];

/// One rule: a kind (1..=27, see the catalogue) and its six u64 parameters.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Rule {
    pub kind: u8,
    pub params: [u64; PARAM_COUNT],
}

impl Rule {
    pub const LEN: usize = 1 + PARAM_COUNT * 8; // 49

    pub fn unpack(d: &[u8]) -> Result<Rule, HookError> {
        if d.len() < Rule::LEN {
            return Err(HookError::ConfigMismatch);
        }
        let mut params = [0u64; PARAM_COUNT];
        for (i, p) in params.iter_mut().enumerate() {
            *p = u64_at(d, 1 + i * 8)?;
        }
        Ok(Rule { kind: d[0], params })
    }

    pub fn pack(&self, d: &mut [u8]) -> Result<(), HookError> {
        if d.len() < Rule::LEN {
            return Err(HookError::ConfigMismatch);
        }
        d[0] = self.kind;
        for (i, p) in self.params.iter().enumerate() {
            put_u64(d, 1 + i * 8, *p);
        }
        Ok(())
    }
}

/// `HookConfig` PDA ["config", mint]; byte offsets of every field.
pub mod config {
    pub const VERSION: usize = 0; // u8 = 1
    pub const BUMP: usize = 1; // u8
    pub const MINT: usize = 2; // [32]
    pub const CREATOR: usize = 34; // [32]
    pub const EXEMPT: usize = 66; // [4][32] -> 66, 98, 130, 162
    pub const VENUES: usize = 194; // [2][32] -> 194, 226
    pub const GATE_MINT: usize = 258; // [32]
    pub const GATE_TOKEN_PROGRAM: usize = 290; // [32]
    pub const STARTED_AT: usize = 322; // i64
    pub const START_SLOT: usize = 330; // u64
    pub const RULE_COUNT: usize = 338; // u8
    pub const RULES: usize = 339; // [4] x 49 bytes -> 339, 388, 437, 486
    pub const TITHE_RECIPIENT: usize = 535; // [32]
    pub const SWAP_BASE_AMOUNT: usize = 567; // u64
    pub const VAULT_INITIAL: usize = 575; // u64 (first mutable field)
    pub const VOLUME_BOUGHT: usize = 583; // u64
    pub const LAST_SLOT: usize = 591; // u64
    pub const SLOT_TRADES: usize = 599; // u64
    pub const POTATO_HOLDER: usize = 607; // [32]
    pub const POTATO_SINCE: usize = 639; // i64
    pub const TURN_SIDE: usize = 647; // u8: 0 none, 1 buy, 2 sell
    pub const TURN_TS: usize = 648; // i64
    pub const OSC_ENERGY: usize = 656; // u64 (1e6 = 1.0)
    pub const OSC_ENERGY2: usize = 664; // u64
    pub const OSC_PHASE: usize = 672; // u64 (1/65536 cycle)
    pub const OSC_TS: usize = 680; // i64
    pub const RESERVED: usize = 688; // [64]
    pub const LEN: usize = 752;
}

pub const TURN_NONE: u8 = 0;
pub const TURN_BUY: u8 = 1;
pub const TURN_SELL: u8 = 2;

/// The HookConfig fields the rule engine reads and (apart from `swap_base_amount`,
/// which is static) may change. `HookConfig::pack_dynamic` writes exactly these.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ConfigState {
    pub started_at: i64,
    pub start_slot: u64,
    /// Base tokens the curve sells before graduation (static; sliding caps).
    pub swap_base_amount: u64,
    /// The base vault's balance before the first buy (0 = not yet captured).
    pub vault_initial: u64,
    pub volume_bought: u64,
    pub last_slot: u64,
    pub slot_trades: u64,
    pub potato_holder: [u8; 32],
    pub potato_since: i64,
    pub turn_side: u8,
    pub turn_ts: i64,
    pub osc_energy: u64,
    pub osc_energy2: u64,
    pub osc_phase: u64,
    pub osc_ts: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HookConfig {
    pub version: u8,
    pub bump: u8,
    pub mint: [u8; 32],
    pub creator: [u8; 32],
    pub exempt: [[u8; 32]; 4],
    pub venues: [[u8; 32]; 2],
    pub gate_mint: [u8; 32],
    pub gate_token_program: [u8; 32],
    pub rule_count: u8,
    pub rules: [Rule; MAX_RULES],
    pub tithe_recipient: [u8; 32],
    pub state: ConfigState,
}

impl HookConfig {
    pub const LEN: usize = config::LEN;

    pub fn unpack(d: &[u8]) -> Result<HookConfig, HookError> {
        if d.len() != config::LEN || d[config::VERSION] != VERSION {
            return Err(HookError::ConfigMismatch);
        }
        let rule_count = d[config::RULE_COUNT];
        if rule_count as usize > MAX_RULES || d[config::TURN_SIDE] > TURN_SELL {
            return Err(HookError::ConfigMismatch);
        }
        let mut rules = [Rule::default(); MAX_RULES];
        for (i, slot) in rules.iter_mut().enumerate() {
            *slot = Rule::unpack(&d[config::RULES + i * Rule::LEN..])?;
        }
        Ok(HookConfig {
            version: d[config::VERSION],
            bump: d[config::BUMP],
            mint: key_at(d, config::MINT)?,
            creator: key_at(d, config::CREATOR)?,
            exempt: [
                key_at(d, config::EXEMPT)?,
                key_at(d, config::EXEMPT + 32)?,
                key_at(d, config::EXEMPT + 64)?,
                key_at(d, config::EXEMPT + 96)?,
            ],
            venues: [key_at(d, config::VENUES)?, key_at(d, config::VENUES + 32)?],
            gate_mint: key_at(d, config::GATE_MINT)?,
            gate_token_program: key_at(d, config::GATE_TOKEN_PROGRAM)?,
            rule_count,
            rules,
            tithe_recipient: key_at(d, config::TITHE_RECIPIENT)?,
            state: ConfigState {
                started_at: i64_at(d, config::STARTED_AT)?,
                start_slot: u64_at(d, config::START_SLOT)?,
                swap_base_amount: u64_at(d, config::SWAP_BASE_AMOUNT)?,
                vault_initial: u64_at(d, config::VAULT_INITIAL)?,
                volume_bought: u64_at(d, config::VOLUME_BOUGHT)?,
                last_slot: u64_at(d, config::LAST_SLOT)?,
                slot_trades: u64_at(d, config::SLOT_TRADES)?,
                potato_holder: key_at(d, config::POTATO_HOLDER)?,
                potato_since: i64_at(d, config::POTATO_SINCE)?,
                turn_side: d[config::TURN_SIDE],
                turn_ts: i64_at(d, config::TURN_TS)?,
                osc_energy: u64_at(d, config::OSC_ENERGY)?,
                osc_energy2: u64_at(d, config::OSC_ENERGY2)?,
                osc_phase: u64_at(d, config::OSC_PHASE)?,
                osc_ts: i64_at(d, config::OSC_TS)?,
            },
        })
    }

    /// Writes every field; the reserved tail is zeroed.
    pub fn pack(&self, d: &mut [u8]) -> Result<(), HookError> {
        if d.len() != config::LEN {
            return Err(HookError::ConfigMismatch);
        }
        d.fill(0);
        d[config::VERSION] = self.version;
        d[config::BUMP] = self.bump;
        put_key(d, config::MINT, &self.mint);
        put_key(d, config::CREATOR, &self.creator);
        for (i, k) in self.exempt.iter().enumerate() {
            put_key(d, config::EXEMPT + i * 32, k);
        }
        for (i, k) in self.venues.iter().enumerate() {
            put_key(d, config::VENUES + i * 32, k);
        }
        put_key(d, config::GATE_MINT, &self.gate_mint);
        put_key(d, config::GATE_TOKEN_PROGRAM, &self.gate_token_program);
        d[config::RULE_COUNT] = self.rule_count;
        for (i, r) in self.rules.iter().enumerate() {
            r.pack(&mut d[config::RULES + i * Rule::LEN..])?;
        }
        put_key(d, config::TITHE_RECIPIENT, &self.tithe_recipient);
        put_u64(d, config::SWAP_BASE_AMOUNT, self.state.swap_base_amount);
        pack_dynamic(&self.state, d)
    }

    /// Writes only the fields Execute changes (clock and rule state); the static
    /// fields, `swap_base_amount` included, are left as they are.
    pub fn pack_dynamic(&self, d: &mut [u8]) -> Result<(), HookError> {
        pack_dynamic(&self.state, d)
    }

    /// The active rules (the first `rule_count` slots).
    pub fn rules(&self) -> &[Rule] {
        &self.rules[..(self.rule_count as usize).min(MAX_RULES)]
    }

    pub fn has_rule(&self, kind: u8) -> bool {
        self.rules().iter().any(|r| r.kind == kind)
    }

    /// A zero key is an unused slot and never matches.
    pub fn is_exempt(&self, owner: &[u8; 32]) -> bool {
        *owner != ZERO_KEY && self.exempt.iter().any(|k| k == owner)
    }

    pub fn is_venue(&self, token_account: &[u8; 32]) -> bool {
        *token_account != ZERO_KEY && self.venues.iter().any(|k| k == token_account)
    }
}

/// Writes the mutable fields of a config (see [`ConfigState`]) into a packed account.
pub fn pack_dynamic(s: &ConfigState, d: &mut [u8]) -> Result<(), HookError> {
    if d.len() != config::LEN || s.turn_side > TURN_SELL {
        return Err(HookError::ConfigMismatch);
    }
    put_i64(d, config::STARTED_AT, s.started_at);
    put_u64(d, config::START_SLOT, s.start_slot);
    put_u64(d, config::VAULT_INITIAL, s.vault_initial);
    put_u64(d, config::VOLUME_BOUGHT, s.volume_bought);
    put_u64(d, config::LAST_SLOT, s.last_slot);
    put_u64(d, config::SLOT_TRADES, s.slot_trades);
    put_key(d, config::POTATO_HOLDER, &s.potato_holder);
    put_i64(d, config::POTATO_SINCE, s.potato_since);
    d[config::TURN_SIDE] = s.turn_side;
    put_i64(d, config::TURN_TS, s.turn_ts);
    put_u64(d, config::OSC_ENERGY, s.osc_energy);
    put_u64(d, config::OSC_ENERGY2, s.osc_energy2);
    put_u64(d, config::OSC_PHASE, s.osc_phase);
    put_i64(d, config::OSC_TS, s.osc_ts);
    Ok(())
}

/// `WalletState` PDA ["wallet", mint, owner]; byte offsets. Only holder_vesting uses it.
pub mod wallet {
    pub const VERSION: usize = 0; // u8
    pub const BUMP: usize = 1; // u8
    pub const FIRST_RECEIPT_TS: usize = 2; // i64: start of the wallet's vesting clock (0 = never qualified)
    pub const RECEIVED_TOTAL: usize = 10; // u64: sum of qualifying receipts
    pub const RESERVED: usize = 18; // [16]
    pub const LEN: usize = 34;
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WalletState {
    pub version: u8,
    pub bump: u8,
    pub first_receipt_ts: i64,
    pub received_total: u64,
}

impl WalletState {
    pub const LEN: usize = wallet::LEN;

    pub fn new(bump: u8) -> WalletState {
        WalletState { version: VERSION, bump, ..WalletState::default() }
    }

    pub fn unpack(d: &[u8]) -> Result<WalletState, HookError> {
        if d.len() != wallet::LEN || d[wallet::VERSION] != VERSION {
            return Err(HookError::BadAccounts);
        }
        Ok(WalletState {
            version: d[wallet::VERSION],
            bump: d[wallet::BUMP],
            first_receipt_ts: i64_at(d, wallet::FIRST_RECEIPT_TS)?,
            received_total: u64_at(d, wallet::RECEIVED_TOTAL)?,
        })
    }

    pub fn pack(&self, d: &mut [u8]) -> Result<(), HookError> {
        if d.len() != wallet::LEN {
            return Err(HookError::BadAccounts);
        }
        d[wallet::VERSION] = self.version;
        d[wallet::BUMP] = self.bump;
        put_i64(d, wallet::FIRST_RECEIPT_TS, self.first_receipt_ts);
        put_u64(d, wallet::RECEIVED_TOTAL, self.received_total);
        d[wallet::RESERVED..wallet::LEN].fill(0);
        Ok(())
    }
}

/// `AllowEntry` PDA ["allow", mint, wallet]: existence = allowed. The mint and
/// wallet are stored so RemoveAllowed can recompute the address (a creator can
/// only close entries of their own mint) and so an allowlist can be listed from
/// chain with `getProgramAccounts` (dataSize 66, memcmp offset 2 = mint).
pub mod allow {
    pub const VERSION: usize = 0; // u8
    pub const BUMP: usize = 1; // u8
    pub const MINT: usize = 2; // [32]
    pub const WALLET: usize = 34; // [32]
    pub const LEN: usize = 66;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AllowEntry {
    pub version: u8,
    pub bump: u8,
    pub mint: [u8; 32],
    pub wallet: [u8; 32],
}

impl AllowEntry {
    pub const LEN: usize = allow::LEN;

    pub fn unpack(d: &[u8]) -> Result<AllowEntry, HookError> {
        if d.len() != allow::LEN || d[allow::VERSION] != VERSION {
            return Err(HookError::BadAccounts);
        }
        Ok(AllowEntry {
            version: d[allow::VERSION],
            bump: d[allow::BUMP],
            mint: key_at(d, allow::MINT)?,
            wallet: key_at(d, allow::WALLET)?,
        })
    }

    pub fn pack(&self, d: &mut [u8]) -> Result<(), HookError> {
        if d.len() != allow::LEN {
            return Err(HookError::BadAccounts);
        }
        d[allow::VERSION] = self.version;
        d[allow::BUMP] = self.bump;
        put_key(d, allow::MINT, &self.mint);
        put_key(d, allow::WALLET, &self.wallet);
        Ok(())
    }
}

/// `BlockList` PDA ["block", mint]: up to 200 wallets that may never receive the
/// coin. Written by AddBlocked before the first trade (sealed by `started_at`);
/// read in place by Execute. Byte offsets:
pub mod block {
    pub const VERSION: usize = 0; // u8
    pub const BUMP: usize = 1; // u8
    pub const COUNT: usize = 2; // u8 (0..=200)
    pub const PADDING: usize = 3; // [5], zero
    pub const WALLETS: usize = 8; // 200 x [32]
    pub const MAX: usize = 200;
    pub const LEN: usize = 6408; // 8 + MAX * 32
}

/// Slice views over a BlockList account's data (never a struct: 6.4 KiB would
/// overflow the 4 KiB BPF stack frame).
pub struct BlockList;

impl BlockList {
    pub const LEN: usize = block::LEN;
    pub const MAX: usize = block::MAX;

    /// Initialises an empty list in zeroed account data.
    pub fn init(d: &mut [u8], bump: u8) -> Result<(), HookError> {
        if d.len() != block::LEN {
            return Err(HookError::BadAccounts);
        }
        d.fill(0);
        d[block::VERSION] = VERSION;
        d[block::BUMP] = bump;
        Ok(())
    }

    /// (bump, count) of a well-formed list.
    pub fn header(d: &[u8]) -> Result<(u8, u8), HookError> {
        if d.len() != block::LEN || d[block::VERSION] != VERSION || d[block::COUNT] as usize > block::MAX {
            return Err(HookError::BadAccounts);
        }
        Ok((d[block::BUMP], d[block::COUNT]))
    }

    pub fn wallet_at(d: &[u8], i: usize) -> Result<[u8; 32], HookError> {
        key_at(d, block::WALLETS + i * 32)
    }

    /// Whether `owner` is one of the listed wallets.
    pub fn contains(d: &[u8], owner: &[u8; 32]) -> Result<bool, HookError> {
        let (_, count) = BlockList::header(d)?;
        for i in 0..count as usize {
            if d[block::WALLETS + i * 32..block::WALLETS + i * 32 + 32] == owner[..] {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Appends `wallets`, skipping ones already listed; refuses zero keys
    /// (`BadAccounts`) and a result above 200 entries (`BlocklistFull`, nothing
    /// written). Returns the new count.
    pub fn append(d: &mut [u8], wallets: &[[u8; 32]]) -> Result<u8, HookError> {
        let (_, mut count) = BlockList::header(d)?;
        // First pass: how many are new (dedupe against the list and the batch itself).
        let mut added = 0usize;
        for (i, w) in wallets.iter().enumerate() {
            if *w == ZERO_KEY {
                return Err(HookError::BadAccounts);
            }
            if wallets[..i].contains(w) || BlockList::contains(d, w)? {
                continue;
            }
            added += 1;
        }
        if count as usize + added > block::MAX {
            return Err(HookError::BlocklistFull);
        }
        for w in wallets {
            if BlockList::contains(d, w)? {
                continue;
            }
            put_key(d, block::WALLETS + count as usize * 32, w);
            count += 1;
            d[block::COUNT] = count;
        }
        Ok(count)
    }
}

// --- Token-2022 views ---------------------------------------------------------
//
// Only the fields the hook needs. A Token-2022 account is the 165-byte SPL
// layout, then (when extensions exist) byte 165 = account type (2 = Account)
// and a TLV list from byte 166: u16 type, u16 length, value. A mint is 82 bytes
// (supply at 36..44), padded to 165 and followed by type byte 1 and its TLV.

pub const TOKEN_ACCOUNT_LEN: usize = 165;
pub const MINT_LEN: usize = 82;
const ACCOUNT_TYPE_ACCOUNT: u8 = 2;
/// ExtensionType::TransferHookAccount, whose single byte is the `transferring` flag
/// that Token-2022 sets on both token accounts for the duration of a transfer.
const EXTENSION_TRANSFER_HOOK_ACCOUNT: u16 = 15;
const EXTENSION_UNINITIALIZED: u16 = 0;
const ACCOUNT_STATE_INITIALIZED: u8 = 1;
const ACCOUNT_STATE_FROZEN: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TokenAccountView {
    pub mint: [u8; 32],
    pub owner: [u8; 32],
    pub amount: u64,
    /// Some(flag) when the TransferHookAccount extension is present.
    pub transferring: Option<bool>,
}

/// Parses a Token-2022 token account. Fails for uninitialized accounts and for
/// data too short to be a token account.
pub fn token_account_view(d: &[u8]) -> Result<TokenAccountView, HookError> {
    if d.len() < TOKEN_ACCOUNT_LEN {
        return Err(HookError::BadAccounts);
    }
    let state = d[108];
    if state != ACCOUNT_STATE_INITIALIZED && state != ACCOUNT_STATE_FROZEN {
        return Err(HookError::BadAccounts);
    }
    Ok(TokenAccountView {
        mint: key_at(d, 0)?,
        owner: key_at(d, 32)?,
        amount: u64_at(d, 64)?,
        transferring: transferring_flag(d),
    })
}

/// Finds the TransferHookAccount extension in a Token-2022 account's TLV list.
pub fn transferring_flag(d: &[u8]) -> Option<bool> {
    if d.len() <= TOKEN_ACCOUNT_LEN || d[TOKEN_ACCOUNT_LEN] != ACCOUNT_TYPE_ACCOUNT {
        return None;
    }
    let mut pos = TOKEN_ACCOUNT_LEN + 1;
    while pos + 4 <= d.len() {
        let kind = u16::from_le_bytes([d[pos], d[pos + 1]]);
        let len = u16::from_le_bytes([d[pos + 2], d[pos + 3]]) as usize;
        if kind == EXTENSION_UNINITIALIZED {
            return None; // zero padding: no more entries
        }
        let value = pos + 4;
        if value + len > d.len() {
            return None;
        }
        if kind == EXTENSION_TRANSFER_HOOK_ACCOUNT {
            return if len == 1 { Some(d[value] != 0) } else { None };
        }
        pos = value + len;
    }
    None
}

/// Supply of a (Token-2022 or classic) mint: u64 at offset 36.
pub fn mint_supply(d: &[u8]) -> Result<u64, HookError> {
    if d.len() < MINT_LEN || d[45] != 1 {
        // byte 45 = is_initialized
        return Err(HookError::BadAccounts);
    }
    u64_at(d, 36)
}

// --- byte helpers -------------------------------------------------------------

pub fn u64_at(d: &[u8], p: usize) -> Result<u64, HookError> {
    let s = d.get(p..p + 8).ok_or(HookError::BadAccounts)?;
    Ok(u64::from_le_bytes(s.try_into().map_err(|_| HookError::BadAccounts)?))
}

pub fn i64_at(d: &[u8], p: usize) -> Result<i64, HookError> {
    Ok(u64_at(d, p)? as i64)
}

pub fn key_at(d: &[u8], p: usize) -> Result<[u8; 32], HookError> {
    let s = d.get(p..p + 32).ok_or(HookError::BadAccounts)?;
    s.try_into().map_err(|_| HookError::BadAccounts)
}

pub fn put_u64(d: &mut [u8], p: usize, v: u64) {
    d[p..p + 8].copy_from_slice(&v.to_le_bytes());
}

pub fn put_i64(d: &mut [u8], p: usize, v: i64) {
    d[p..p + 8].copy_from_slice(&v.to_le_bytes());
}

pub fn put_key(d: &mut [u8], p: usize, k: &[u8; 32]) {
    d[p..p + 32].copy_from_slice(k);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(n: u8) -> [u8; 32] {
        let mut k = [n; 32];
        k[31] = n.wrapping_mul(7);
        k
    }

    fn sample_config() -> HookConfig {
        HookConfig {
            version: VERSION,
            bump: 253,
            mint: key(1),
            creator: key(2),
            exempt: [key(2), key(3), key(4), ZERO_KEY],
            venues: [key(5), ZERO_KEY],
            gate_mint: key(6),
            gate_token_program: key(7),
            rule_count: 2,
            rules: [
                Rule { kind: 4, params: [200, 25, 0, 0, 0, 0] },
                Rule { kind: 16, params: [120, 8, 40, 100, 25, 0] },
                Rule::default(),
                Rule::default(),
            ],
            tithe_recipient: key(8),
            state: ConfigState {
                started_at: 1_700_000_000,
                start_slot: 250_000_000,
                swap_base_amount: 800_000_000_000_000,
                vault_initial: 1_000_000_000_000_000,
                volume_bought: 123,
                last_slot: 250_000_010,
                slot_trades: 2,
                potato_holder: key(9),
                potato_since: 1_700_000_100,
                turn_side: TURN_SELL,
                turn_ts: 1_700_000_200,
                osc_energy: 500_000,
                osc_energy2: 250_000,
                osc_phase: 32_768,
                osc_ts: 1_700_000_300,
            },
        }
    }

    #[test]
    fn config_offsets_are_contiguous_and_total_752() {
        assert_eq!(Rule::LEN, 49);
        assert_eq!(config::MINT, 2);
        assert_eq!(config::CREATOR, 34);
        assert_eq!(config::EXEMPT, 66);
        assert_eq!(config::VENUES, 66 + 4 * 32);
        assert_eq!(config::GATE_MINT, config::VENUES + 64);
        assert_eq!(config::GATE_TOKEN_PROGRAM, config::GATE_MINT + 32);
        assert_eq!(config::STARTED_AT, config::GATE_TOKEN_PROGRAM + 32);
        assert_eq!(config::START_SLOT, config::STARTED_AT + 8);
        assert_eq!(config::RULE_COUNT, config::START_SLOT + 8);
        assert_eq!(config::RULES, config::RULE_COUNT + 1);
        assert_eq!(config::TITHE_RECIPIENT, config::RULES + 4 * Rule::LEN);
        assert_eq!(config::TITHE_RECIPIENT, 535);
        assert_eq!(config::SWAP_BASE_AMOUNT, config::TITHE_RECIPIENT + 32);
        assert_eq!(config::VAULT_INITIAL, config::SWAP_BASE_AMOUNT + 8);
        assert_eq!(config::VOLUME_BOUGHT, config::VAULT_INITIAL + 8);
        assert_eq!(config::LAST_SLOT, config::VOLUME_BOUGHT + 8);
        assert_eq!(config::SLOT_TRADES, config::LAST_SLOT + 8);
        assert_eq!(config::POTATO_HOLDER, config::SLOT_TRADES + 8);
        assert_eq!(config::POTATO_SINCE, config::POTATO_HOLDER + 32);
        assert_eq!(config::TURN_SIDE, config::POTATO_SINCE + 8);
        assert_eq!(config::TURN_TS, config::TURN_SIDE + 1);
        assert_eq!(config::OSC_ENERGY, config::TURN_TS + 8);
        assert_eq!(config::OSC_ENERGY2, config::OSC_ENERGY + 8);
        assert_eq!(config::OSC_PHASE, config::OSC_ENERGY2 + 8);
        assert_eq!(config::OSC_TS, config::OSC_PHASE + 8);
        assert_eq!(config::RESERVED, config::OSC_TS + 8);
        assert_eq!(config::LEN, config::RESERVED + 64);
        assert_eq!(config::LEN, 752);
        assert_eq!(wallet::RECEIVED_TOTAL + 8, wallet::RESERVED);
        assert_eq!(wallet::RESERVED + 16, wallet::LEN);
        assert_eq!(wallet::LEN, 34);
        assert_eq!(allow::LEN, 66);
        assert_eq!(allow::WALLET + 32, allow::LEN);
        assert_eq!(block::WALLETS, 8);
        assert_eq!(block::LEN, 6408);
        assert_eq!(BlockList::LEN, 8 + 200 * 32);
    }

    #[test]
    fn config_round_trips_and_rejects_bad_versions() {
        let c = sample_config();
        let mut d = [0u8; config::LEN];
        c.pack(&mut d).unwrap();
        assert_eq!(d[0], 1);
        assert_eq!(d[1], 253);
        assert_eq!(&d[config::MINT..config::MINT + 32], &key(1));
        assert_eq!(u64_at(&d, config::START_SLOT).unwrap(), 250_000_000);
        assert_eq!(d[config::RULES], 4);
        assert_eq!(u64_at(&d, config::RULES + 1).unwrap(), 200);
        assert_eq!(u64_at(&d, config::RULES + 9).unwrap(), 25);
        assert_eq!(d[config::RULES + Rule::LEN], 16);
        assert_eq!(u64_at(&d, config::RULES + Rule::LEN + 1 + 4 * 8).unwrap(), 25, "sixth parameter slot");
        assert_eq!(&d[config::TITHE_RECIPIENT..config::TITHE_RECIPIENT + 32], &key(8));
        assert_eq!(u64_at(&d, config::SWAP_BASE_AMOUNT).unwrap(), 800_000_000_000_000);
        assert_eq!(u64_at(&d, config::VOLUME_BOUGHT).unwrap(), 123);
        assert_eq!(d[config::TURN_SIDE], 2);
        assert_eq!(u64_at(&d, config::OSC_PHASE).unwrap(), 32_768);
        assert!(d[config::RESERVED..].iter().all(|b| *b == 0));
        let back = HookConfig::unpack(&d).unwrap();
        assert_eq!(back, c);
        assert_eq!(back.rules().len(), 2);
        assert!(back.has_rule(16));
        assert!(!back.has_rule(2));
        assert!(back.is_exempt(&key(3)));
        assert!(!back.is_exempt(&ZERO_KEY), "zero slots never match");
        assert!(back.is_venue(&key(5)));
        assert!(!back.is_venue(&ZERO_KEY));
        d[0] = 2;
        assert_eq!(HookConfig::unpack(&d), Err(HookError::ConfigMismatch));
        d[0] = 1;
        assert_eq!(HookConfig::unpack(&d[..751]), Err(HookError::ConfigMismatch));
        d[config::RULE_COUNT] = 5;
        assert_eq!(HookConfig::unpack(&d), Err(HookError::ConfigMismatch));
        d[config::RULE_COUNT] = 2;
        d[config::TURN_SIDE] = 3;
        assert_eq!(HookConfig::unpack(&d), Err(HookError::ConfigMismatch));
    }

    #[test]
    fn pack_dynamic_touches_only_the_mutable_fields() {
        let c = sample_config();
        let mut d = [0u8; config::LEN];
        c.pack(&mut d).unwrap();
        let mut changed = c;
        changed.state = ConfigState {
            started_at: 1,
            start_slot: 2,
            swap_base_amount: 3, // static: must NOT be written by pack_dynamic
            vault_initial: 4,
            volume_bought: 5,
            last_slot: 6,
            slot_trades: 7,
            potato_holder: key(11),
            potato_since: 8,
            turn_side: TURN_BUY,
            turn_ts: 9,
            osc_energy: 10,
            osc_energy2: 11,
            osc_phase: 12,
            osc_ts: 13,
        };
        changed.creator = key(9); // must NOT be written by pack_dynamic
        changed.tithe_recipient = key(10); // nor this
        changed.pack_dynamic(&mut d).unwrap();
        let back = HookConfig::unpack(&d).unwrap();
        assert_eq!(back.state, ConfigState { swap_base_amount: 800_000_000_000_000, ..changed.state });
        assert_eq!(back.creator, key(2));
        assert_eq!(back.tithe_recipient, key(8));
        let mut bad = changed.state;
        bad.turn_side = 7;
        assert_eq!(pack_dynamic(&bad, &mut d), Err(HookError::ConfigMismatch));
    }

    #[test]
    fn wallet_state_round_trips() {
        let w = WalletState { version: 1, bump: 254, first_receipt_ts: -5, received_total: u64::MAX };
        let mut d = [7u8; wallet::LEN];
        w.pack(&mut d).unwrap();
        assert_eq!(i64_at(&d, 2).unwrap(), -5);
        assert_eq!(u64_at(&d, 10).unwrap(), u64::MAX);
        assert!(d[18..].iter().all(|b| *b == 0), "reserved bytes are zeroed");
        assert_eq!(WalletState::unpack(&d).unwrap(), w);
        d[0] = 2;
        assert_eq!(WalletState::unpack(&d), Err(HookError::BadAccounts));
        assert_eq!(WalletState::unpack(&[1u8; 33]), Err(HookError::BadAccounts));
        let fresh = WalletState::new(200);
        assert_eq!((fresh.version, fresh.bump, fresh.first_receipt_ts, fresh.received_total), (1, 200, 0, 0));
    }

    #[test]
    fn allow_entry_round_trips() {
        let a = AllowEntry { version: 1, bump: 251, mint: key(1), wallet: key(8) };
        let mut d = [0u8; allow::LEN];
        a.pack(&mut d).unwrap();
        assert_eq!(&d[2..34], &key(1));
        assert_eq!(&d[34..66], &key(8));
        assert_eq!(AllowEntry::unpack(&d).unwrap(), a);
        assert_eq!(AllowEntry::unpack(&d[..65]), Err(HookError::BadAccounts));
    }

    #[test]
    fn blocklist_views_append_dedupe_and_fill() {
        let mut d = vec![9u8; block::LEN];
        BlockList::init(&mut d, 250).unwrap();
        assert_eq!(BlockList::header(&d).unwrap(), (250, 0));
        assert!(!BlockList::contains(&d, &key(1)).unwrap());
        assert_eq!(BlockList::append(&mut d, &[key(1), key(2), key(1)]).unwrap(), 2, "a duplicate inside the batch is skipped");
        assert_eq!(BlockList::append(&mut d, &[key(2), key(3)]).unwrap(), 3, "a wallet already listed is skipped");
        assert!(BlockList::contains(&d, &key(1)).unwrap() && BlockList::contains(&d, &key(3)).unwrap());
        assert!(!BlockList::contains(&d, &key(4)).unwrap());
        assert_eq!(BlockList::wallet_at(&d, 2).unwrap(), key(3));
        assert_eq!(d[block::COUNT], 3);
        assert_eq!(BlockList::append(&mut d, &[ZERO_KEY]), Err(HookError::BadAccounts));
        // fill to 200 exactly, then one more is refused and nothing changes
        let mut batch = Vec::new();
        for i in 0..197u8 {
            let mut k = key(100);
            k[0] = i;
            k[1] = 77;
            batch.push(k);
        }
        for chunk in batch.chunks(28) {
            BlockList::append(&mut d, chunk).unwrap();
        }
        assert_eq!(BlockList::header(&d).unwrap().1, 200);
        let before = d.clone();
        assert_eq!(BlockList::append(&mut d, &[key(50)]), Err(HookError::BlocklistFull));
        assert_eq!(d, before);
        assert_eq!(BlockList::append(&mut d, &[key(1)]).unwrap(), 200, "re-adding a listed wallet at the cap is a no-op");
        d[block::COUNT] = 201;
        assert_eq!(BlockList::header(&d), Err(HookError::BadAccounts));
        assert_eq!(BlockList::header(&d[..100]), Err(HookError::BadAccounts));
    }

    fn token_account(mint: [u8; 32], owner: [u8; 32], amount: u64, extensions: &[u8]) -> Vec<u8> {
        let mut d = vec![0u8; TOKEN_ACCOUNT_LEN];
        d[..32].copy_from_slice(&mint);
        d[32..64].copy_from_slice(&owner);
        put_u64(&mut d, 64, amount);
        d[108] = ACCOUNT_STATE_INITIALIZED;
        if !extensions.is_empty() {
            d.push(ACCOUNT_TYPE_ACCOUNT);
            d.extend_from_slice(extensions);
        }
        d
    }

    #[test]
    fn token_account_view_reads_the_transferring_flag() {
        // ImmutableOwner (7, len 0) then TransferHookAccount (15, len 1) = true, then padding.
        let ext = [7, 0, 0, 0, 15, 0, 1, 0, 1, 0, 0, 0, 0];
        let d = token_account(key(1), key(2), 42, &ext);
        let v = token_account_view(&d).unwrap();
        assert_eq!(v.mint, key(1));
        assert_eq!(v.owner, key(2));
        assert_eq!(v.amount, 42);
        assert_eq!(v.transferring, Some(true));
        let off = token_account(key(1), key(2), 42, &[15, 0, 1, 0, 0]);
        assert_eq!(token_account_view(&off).unwrap().transferring, Some(false));
        let plain = token_account(key(1), key(2), 42, &[]);
        assert_eq!(token_account_view(&plain).unwrap().transferring, None);
        let other_only = token_account(key(1), key(2), 42, &[7, 0, 0, 0]);
        assert_eq!(token_account_view(&other_only).unwrap().transferring, None);
        let mut uninit = token_account(key(1), key(2), 42, &[]);
        uninit[108] = 0;
        assert_eq!(token_account_view(&uninit), Err(HookError::BadAccounts));
        assert_eq!(token_account_view(&[0u8; 100]), Err(HookError::BadAccounts));
    }

    #[test]
    fn mint_supply_reads_offset_36() {
        let mut m = vec![0u8; MINT_LEN];
        put_u64(&mut m, 36, 1_000_000_000_000_000);
        m[45] = 1;
        assert_eq!(mint_supply(&m).unwrap(), 1_000_000_000_000_000);
        m[45] = 0;
        assert_eq!(mint_supply(&m), Err(HookError::BadAccounts));
        assert_eq!(mint_supply(&[0u8; 81]), Err(HookError::BadAccounts));
    }
}
