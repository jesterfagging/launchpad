//! Instruction data: a 1-byte tag for Launchpad's own instructions and the 8-byte
//! SPL transfer-hook interface discriminators for Execute (and, as an alias,
//! InitializeExtraAccountMetaList). Fixed layouts, no borsh.
//!
//! | bytes | instruction |
//! |---|---|
//! | `[0]` (a trailing byte is accepted and ignored) | InitializeExtraAccountMetaList |
//! | `[43,34,13,49,167,88,235,235]` (+ optional byte) | same, interface discriminator |
//! | `[1] ++ InitConfigArgs (493 bytes)` | InitConfig |
//! | `[2] ++ wallet[32]` | AddAllowed |
//! | `[3]` | RemoveAllowed |
//! | `[4]` | RegisterWallet |
//! | `[5, n] ++ n x wallet[32]` (1 <= n <= 28) | AddBlocked |
//! | `[105,37,101,197,75,251,102,26] ++ amount u64` | Execute (Token-2022 calls this) |
//!
//! The tags 0..=5 never collide with the discriminators, whose first bytes are
//! 43 and 105, and the update-extra-account-metas discriminator is rejected on
//! purpose: the list is immutable once written. The account lists live in
//! `lib.rs` (and README.md); note that InitializeExtraAccountMetaList takes the
//! HookConfig as its sixth account and derives the list's shape from it, so it
//! runs after InitConfig.

use crate::state::{Rule, MAX_RULES};

/// sha256("spl-transfer-hook-interface:execute")[0..8]
pub const EXECUTE_DISCRIMINATOR: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];
/// sha256("spl-transfer-hook-interface:initialize-extra-account-metas")[0..8]
pub const INITIALIZE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR: [u8; 8] = [43, 34, 13, 49, 167, 88, 235, 235];
/// sha256("spl-transfer-hook-interface:update-extra-account-metas")[0..8] (rejected)
pub const UPDATE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR: [u8; 8] = [157, 105, 42, 146, 102, 85, 241, 174];

pub const TAG_INITIALIZE_EXTRA_ACCOUNT_META_LIST: u8 = 0;
pub const TAG_INIT_CONFIG: u8 = 1;
pub const TAG_ADD_ALLOWED: u8 = 2;
pub const TAG_REMOVE_ALLOWED: u8 = 3;
pub const TAG_REGISTER_WALLET: u8 = 4;
pub const TAG_ADD_BLOCKED: u8 = 5;

/// Wallets per AddBlocked instruction (`HOOK_LIMITS.blocklistBatch` in the catalogue).
pub const MAX_BLOCK_BATCH: usize = 28;

/// InitConfig payload offsets (after the tag).
pub mod init_config {
    pub const EXEMPT: usize = 0; // [4][32]
    pub const VENUES: usize = 128; // [2][32]
    pub const GATE_MINT: usize = 192; // [32]
    pub const GATE_TOKEN_PROGRAM: usize = 224; // [32]
    pub const TITHE_RECIPIENT: usize = 256; // [32]
    pub const SWAP_BASE_AMOUNT: usize = 288; // u64
    pub const RULE_COUNT: usize = 296; // u8
    pub const RULES: usize = 297; // [4] x 49
    pub const LEN: usize = 493; // 297 + 4 * 49
}

/// InitConfig payload after the tag: exempt[4][32], venues[2][32], gate_mint[32],
/// gate_token_program[32], tithe_recipient[32], swap_base_amount u64, rule_count
/// u8, rules[4]{kind u8, params[6] u64}.
pub const INIT_CONFIG_ARGS_LEN: usize = init_config::LEN;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InitConfigArgs {
    pub exempt: [[u8; 32]; 4],
    pub venues: [[u8; 32]; 2],
    pub gate_mint: [u8; 32],
    pub gate_token_program: [u8; 32],
    pub tithe_recipient: [u8; 32],
    pub swap_base_amount: u64,
    pub rule_count: u8,
    pub rules: [Rule; MAX_RULES],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(clippy::large_enum_variant)] // InitConfigArgs is 493 bytes; parsed once per call, well inside the BPF stack frame
pub enum HookInstruction {
    /// The list's shape and gate keys come from the HookConfig (account 5).
    InitializeExtraAccountMetaList,
    InitConfig(InitConfigArgs),
    AddAllowed { wallet: [u8; 32] },
    RemoveAllowed,
    RegisterWallet,
    /// `count` wallets follow the two header bytes; `blocked_wallets` reads them.
    AddBlocked { count: u8 },
    Execute { amount: u64 },
}

/// None = malformed or unknown instruction data.
pub fn parse(data: &[u8]) -> Option<HookInstruction> {
    if data.len() >= 8 {
        let disc: [u8; 8] = data[..8].try_into().ok()?;
        if disc == EXECUTE_DISCRIMINATOR {
            if data.len() != 16 {
                return None;
            }
            let amount = u64::from_le_bytes(data[8..16].try_into().ok()?);
            return Some(HookInstruction::Execute { amount });
        }
        if disc == INITIALIZE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR {
            return match data.len() {
                8 | 9 => Some(HookInstruction::InitializeExtraAccountMetaList),
                _ => None,
            };
        }
        if disc == UPDATE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR {
            return None;
        }
    }
    let (tag, rest) = data.split_first()?;
    match *tag {
        TAG_INITIALIZE_EXTRA_ACCOUNT_META_LIST if rest.len() <= 1 => Some(HookInstruction::InitializeExtraAccountMetaList),
        TAG_INIT_CONFIG => Some(HookInstruction::InitConfig(parse_init_config(rest)?)),
        TAG_ADD_ALLOWED => {
            if rest.len() != 32 {
                return None;
            }
            Some(HookInstruction::AddAllowed { wallet: rest.try_into().ok()? })
        }
        TAG_REMOVE_ALLOWED if rest.is_empty() => Some(HookInstruction::RemoveAllowed),
        TAG_REGISTER_WALLET if rest.is_empty() => Some(HookInstruction::RegisterWallet),
        TAG_ADD_BLOCKED => {
            let (count, wallets) = rest.split_first()?;
            let n = *count as usize;
            if n == 0 || n > MAX_BLOCK_BATCH || wallets.len() != n * 32 {
                return None;
            }
            Some(HookInstruction::AddBlocked { count: *count })
        }
        _ => None,
    }
}

/// The `i`-th wallet of an AddBlocked instruction's data (`[5, n] ++ wallets`).
pub fn blocked_wallet(data: &[u8], i: usize) -> Option<[u8; 32]> {
    key(data, 2 + i * 32)
}

fn key(d: &[u8], p: usize) -> Option<[u8; 32]> {
    d.get(p..p + 32)?.try_into().ok()
}

fn parse_init_config(d: &[u8]) -> Option<InitConfigArgs> {
    use init_config::*;
    if d.len() != LEN {
        return None;
    }
    let rule_count = d[RULE_COUNT];
    if rule_count as usize > MAX_RULES {
        return None;
    }
    let mut rules = [Rule::default(); MAX_RULES];
    for (i, slot) in rules.iter_mut().enumerate() {
        *slot = Rule::unpack(&d[RULES + i * Rule::LEN..]).ok()?;
    }
    Some(InitConfigArgs {
        exempt: [key(d, EXEMPT)?, key(d, EXEMPT + 32)?, key(d, EXEMPT + 64)?, key(d, EXEMPT + 96)?],
        venues: [key(d, VENUES)?, key(d, VENUES + 32)?],
        gate_mint: key(d, GATE_MINT)?,
        gate_token_program: key(d, GATE_TOKEN_PROGRAM)?,
        tithe_recipient: key(d, TITHE_RECIPIENT)?,
        swap_base_amount: u64::from_le_bytes(d[SWAP_BASE_AMOUNT..SWAP_BASE_AMOUNT + 8].try_into().ok()?),
        rule_count,
        rules,
    })
}

/// Serializes InitConfig arguments (the inverse of `parse`; used by tests and
/// handy for anyone building instructions in Rust).
pub fn pack_init_config(args: &InitConfigArgs, out: &mut [u8; INIT_CONFIG_ARGS_LEN]) {
    use init_config::*;
    for (i, k) in args.exempt.iter().enumerate() {
        out[EXEMPT + i * 32..EXEMPT + i * 32 + 32].copy_from_slice(k);
    }
    for (i, k) in args.venues.iter().enumerate() {
        out[VENUES + i * 32..VENUES + i * 32 + 32].copy_from_slice(k);
    }
    out[GATE_MINT..GATE_MINT + 32].copy_from_slice(&args.gate_mint);
    out[GATE_TOKEN_PROGRAM..GATE_TOKEN_PROGRAM + 32].copy_from_slice(&args.gate_token_program);
    out[TITHE_RECIPIENT..TITHE_RECIPIENT + 32].copy_from_slice(&args.tithe_recipient);
    out[SWAP_BASE_AMOUNT..SWAP_BASE_AMOUNT + 8].copy_from_slice(&args.swap_base_amount.to_le_bytes());
    out[RULE_COUNT] = args.rule_count;
    for (i, r) in args.rules.iter().enumerate() {
        let p = RULES + i * Rule::LEN;
        r.pack(&mut out[p..p + Rule::LEN]).expect("fixed buffer");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execute_needs_exactly_sixteen_bytes() {
        let mut d = EXECUTE_DISCRIMINATOR.to_vec();
        d.extend_from_slice(&123_456_789u64.to_le_bytes());
        assert_eq!(parse(&d), Some(HookInstruction::Execute { amount: 123_456_789 }));
        assert_eq!(parse(&d[..15]), None);
        d.push(0);
        assert_eq!(parse(&d), None);
        assert_eq!(parse(&EXECUTE_DISCRIMINATOR), None);
    }

    #[test]
    fn initialize_metas_accepts_tag_and_interface_forms() {
        assert_eq!(parse(&[0]), Some(HookInstruction::InitializeExtraAccountMetaList));
        assert_eq!(parse(&[0, 1]), Some(HookInstruction::InitializeExtraAccountMetaList), "a trailing flag is ignored");
        assert_eq!(parse(&[0, 0]), Some(HookInstruction::InitializeExtraAccountMetaList));
        assert_eq!(parse(&[0, 1, 1]), None);
        assert_eq!(parse(&INITIALIZE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR), Some(HookInstruction::InitializeExtraAccountMetaList));
        let mut d = INITIALIZE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR.to_vec();
        d.push(1);
        assert_eq!(parse(&d), Some(HookInstruction::InitializeExtraAccountMetaList));
        d.push(0);
        assert_eq!(parse(&d), None);
        assert_eq!(parse(&UPDATE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR), None, "the list is immutable");
    }

    #[test]
    fn small_instructions_parse_exactly() {
        let wallet = [9u8; 32];
        let mut d = vec![2];
        d.extend_from_slice(&wallet);
        assert_eq!(parse(&d), Some(HookInstruction::AddAllowed { wallet }));
        assert_eq!(parse(&d[..32]), None);
        assert_eq!(parse(&[3]), Some(HookInstruction::RemoveAllowed));
        assert_eq!(parse(&[3, 0]), None);
        assert_eq!(parse(&[4]), Some(HookInstruction::RegisterWallet));
        assert_eq!(parse(&[4, 1]), None);
        assert_eq!(parse(&[6]), None);
        assert_eq!(parse(&[]), None);
    }

    #[test]
    fn add_blocked_carries_one_to_twenty_eight_wallets() {
        let mut d = vec![5u8, 2];
        d.extend_from_slice(&[1u8; 32]);
        d.extend_from_slice(&[2u8; 32]);
        assert_eq!(parse(&d), Some(HookInstruction::AddBlocked { count: 2 }));
        assert_eq!(blocked_wallet(&d, 0), Some([1u8; 32]));
        assert_eq!(blocked_wallet(&d, 1), Some([2u8; 32]));
        assert_eq!(blocked_wallet(&d, 2), None);
        d.push(0);
        assert_eq!(parse(&d), None, "length is exact");
        assert_eq!(parse(&[5]), None);
        assert_eq!(parse(&[5, 0]), None, "at least one wallet");
        let mut full = vec![5u8, 28];
        full.extend_from_slice(&[3u8; 28 * 32]);
        assert_eq!(parse(&full), Some(HookInstruction::AddBlocked { count: 28 }));
        let mut over = vec![5u8, 29];
        over.extend_from_slice(&[3u8; 29 * 32]);
        assert_eq!(parse(&over), None, "at most 28");
        assert_eq!(MAX_BLOCK_BATCH, 28);
    }

    #[test]
    fn init_config_round_trips_through_the_493_byte_layout() {
        assert_eq!(INIT_CONFIG_ARGS_LEN, 493);
        let args = InitConfigArgs {
            exempt: [[1; 32], [2; 32], [3; 32], [0; 32]],
            venues: [[4; 32], [0; 32]],
            gate_mint: [5; 32],
            gate_token_program: [6; 32],
            tithe_recipient: [7; 32],
            swap_base_amount: 800_000_000_000_000,
            rule_count: 3,
            rules: [
                Rule { kind: 1, params: [0; 6] },
                Rule { kind: 22, params: [540, 1020, 31, 1440, 1, 0] },
                Rule { kind: 24, params: [180, 20, 2, 40, 100, 25] },
                Rule::default(),
            ],
        };
        let mut body = [0u8; INIT_CONFIG_ARGS_LEN];
        pack_init_config(&args, &mut body);
        let mut d = vec![1u8];
        d.extend_from_slice(&body);
        assert_eq!(d.len(), 494);
        assert_eq!(parse(&d), Some(HookInstruction::InitConfig(args)));
        // offsets inside the payload
        assert_eq!(&body[128..160], &[4u8; 32]);
        assert_eq!(&body[192..224], &[5u8; 32]);
        assert_eq!(&body[224..256], &[6u8; 32]);
        assert_eq!(&body[256..288], &[7u8; 32]);
        assert_eq!(u64::from_le_bytes(body[288..296].try_into().unwrap()), 800_000_000_000_000);
        assert_eq!(body[296], 3);
        assert_eq!(body[297], 1);
        assert_eq!(body[297 + 49], 22);
        assert_eq!(u64::from_le_bytes(body[297 + 49 + 1 + 24..297 + 49 + 1 + 32].try_into().unwrap()), 1440);
        assert_eq!(body[297 + 98], 24);
        assert_eq!(u64::from_le_bytes(body[297 + 98 + 1 + 40..297 + 98 + 1 + 48].try_into().unwrap()), 25, "sixth parameter");
        d.push(0);
        assert_eq!(parse(&d), None, "length is exact");
        let mut too_many = body;
        too_many[296] = 5;
        let mut d2 = vec![1u8];
        d2.extend_from_slice(&too_many);
        assert_eq!(parse(&d2), None);
    }
}
