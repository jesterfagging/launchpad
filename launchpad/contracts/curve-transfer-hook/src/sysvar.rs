//! Instructions-sysvar reading for sniper_fee_cap and tithe: a pure parser over
//! the sysvar account's bytes that sums what the transaction pays in priority
//! fees, Jito tips and tithe transfers. `lib.rs` only checks the account key and
//! hands over its data, so everything here is unit-testable on the host.
//!
//! Serialization (`solana_program::sysvar::instructions`):
//!
//! ```text
//! u16 LE  number of top-level instructions
//! u16 LE  offset of each instruction (from the start of the data)
//! per instruction, at its offset:
//!   u16 LE  number of accounts
//!   per account: u8 meta flags (bit 0 signer, bit 1 writable) ++ [32] key
//!   [32]    program id
//!   u16 LE  data length ++ data
//! u16 LE  index of the instruction being executed (trailer; not needed here)
//! ```
//!
//! Only top-level instructions are listed, so a tip or tithe paid by an inner
//! instruction is not seen (documented).

use crate::errors::HookError;

/// Sysvar1nstructions1111111111111111111111111
pub const SYSVAR_INSTRUCTIONS_ID: [u8; 32] = [
    6, 167, 213, 23, 24, 123, 209, 102, 53, 218, 212, 4, 85, 253, 194, 192, 193, 36, 198, 143, 33, 86, 117, 165, 219, 186,
    203, 95, 8, 0, 0, 0,
];
/// ComputeBudget111111111111111111111111111111
pub const COMPUTE_BUDGET_PROGRAM_ID: [u8; 32] = [
    3, 6, 70, 111, 229, 33, 23, 50, 255, 236, 173, 186, 114, 195, 155, 231, 188, 140, 229, 187, 197, 247, 18, 107, 44, 67,
    155, 58, 64, 0, 0, 0,
];
/// 11111111111111111111111111111111
pub const SYSTEM_PROGRAM_ID: [u8; 32] = [0u8; 32];

/// The 8 mainnet Jito tip accounts (docs.jito.wtf).
pub const JITO_TIP_ACCOUNTS: [[u8; 32]; 8] = [
    // 96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5
    [120, 82, 28, 177, 121, 206, 187, 133, 137, 181, 86, 162, 213, 236, 148, 210, 73, 134, 130, 253, 249, 187, 42, 245, 173, 100, 228, 145, 204, 65, 83, 218],
    // HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe
    [241, 135, 236, 135, 209, 247, 69, 203, 58, 3, 56, 74, 38, 166, 158, 218, 12, 162, 209, 170, 15, 65, 228, 36, 22, 55, 126, 145, 255, 91, 93, 49],
    // Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY
    [177, 78, 13, 229, 94, 159, 186, 134, 57, 110, 191, 213, 72, 207, 248, 201, 32, 17, 234, 199, 183, 91, 170, 155, 45, 156, 106, 134, 245, 161, 113, 65],
    // ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49
    [136, 241, 255, 163, 162, 223, 230, 23, 189, 196, 227, 87, 50, 81, 163, 34, 227, 252, 174, 129, 229, 164, 87, 57, 14, 100, 117, 28, 0, 164, 101, 226],
    // DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh
    [188, 43, 87, 6, 94, 241, 221, 102, 84, 48, 190, 96, 107, 166, 89, 108, 2, 149, 48, 27, 173, 239, 139, 90, 252, 65, 1, 65, 80, 244, 18, 116],
    // ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt
    [137, 7, 125, 85, 165, 187, 19, 48, 118, 62, 183, 103, 245, 94, 192, 119, 180, 26, 13, 7, 95, 125, 225, 215, 63, 186, 202, 60, 99, 213, 84, 113],
    // DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL
    [191, 151, 27, 89, 16, 139, 91, 133, 160, 79, 176, 147, 241, 226, 27, 78, 63, 212, 196, 200, 244, 135, 221, 9, 185, 87, 82, 118, 159, 13, 216, 195],
    // 3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT
    [32, 38, 16, 30, 194, 3, 40, 150, 74, 50, 171, 171, 19, 108, 84, 5, 185, 31, 58, 227, 142, 228, 246, 76, 182, 189, 232, 121, 184, 104, 56, 210],
];

/// ComputeBudget instruction tags.
pub const COMPUTE_BUDGET_SET_UNIT_LIMIT: u8 = 2;
pub const COMPUTE_BUDGET_SET_UNIT_PRICE: u8 = 3;
/// System program instruction index of Transfer (u32 LE).
pub const SYSTEM_TRANSFER: u32 = 2;
/// The runtime's default compute budget per non-ComputeBudget instruction and its ceiling.
pub const DEFAULT_UNITS_PER_INSTRUCTION: u64 = 200_000;
pub const MAX_COMPUTE_UNITS: u64 = 1_400_000;
pub const MICRO_LAMPORTS_PER_LAMPORT: u128 = 1_000_000;

/// What the transaction's top-level instructions pay.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TxSummary {
    pub instruction_count: u16,
    /// Top-level instructions that are not ComputeBudget (the default budget counts these).
    pub budgeted_instructions: u16,
    /// SetComputeUnitLimit value, when set.
    pub compute_unit_limit: Option<u32>,
    /// SetComputeUnitPrice value in micro-lamports per CU (0 = none).
    pub compute_unit_price: u64,
    /// Sum of System transfers to the 8 Jito tip accounts.
    pub jito_tip_lamports: u64,
    /// The largest single System transfer to the tithe recipient.
    pub tithe_lamports: u64,
    /// Whether the transaction carries the app mark of an app-only rule (v71.35/v71.36: see `AppMark`).
    pub app_mark_present: bool,
}

/// How an app-only rule (kinds 26/27) recognises its app in the transaction, as the host configured it at launch
/// (`LAUNCHPAD_HOOK_FOMO_MARK` / `LAUNCHPAD_HOOK_PUMP_APP_MARK`) and the rule's parameters carry it: p0..p3 the key,
/// p4 the kind, p5 the account slot of kind 3.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AppMark {
    /// 1 = `key` is a program invoked by a top-level instruction; 2 = `key` is a wallet that signed (it appears with
    /// the signer flag in a top-level instruction's accounts); 3 = `key` is a program invoked by a top-level
    /// instruction whose account at `index` is present and is not the program itself (a filled optional slot, such as
    /// a router's commission account).
    pub kind: u8,
    pub key: [u8; 32],
    pub index: u8,
}

pub const APP_MARK_PROGRAM: u8 = 1;
pub const APP_MARK_SIGNER: u8 = 2;
pub const APP_MARK_PROGRAM_ACCOUNT: u8 = 3;
/// Account flag bits of the instructions sysvar's account metas.
pub const META_IS_SIGNER: u8 = 1;

impl TxSummary {
    /// The compute unit limit the runtime applies: the set limit, else 200k per budgeted instruction capped at 1.4M.
    pub fn compute_units(&self) -> u64 {
        match self.compute_unit_limit {
            Some(limit) => limit as u64,
            None => (self.budgeted_instructions as u64 * DEFAULT_UNITS_PER_INSTRUCTION).min(MAX_COMPUTE_UNITS),
        }
    }

    /// `ceil(price × units / 1e6)` lamports, as the runtime charges it; 0 without a price.
    pub fn priority_fee_lamports(&self) -> u64 {
        if self.compute_unit_price == 0 {
            return 0;
        }
        let micro = self.compute_unit_price as u128 * self.compute_units() as u128;
        let fee = micro.div_ceil(MICRO_LAMPORTS_PER_LAMPORT);
        fee.min(u64::MAX as u128) as u64
    }
}

fn u16_at(d: &[u8], p: usize) -> Result<usize, HookError> {
    let s = d.get(p..p + 2).ok_or(HookError::BadSysvar)?;
    Ok(u16::from_le_bytes([s[0], s[1]]) as usize)
}

fn slice(d: &[u8], p: usize, len: usize) -> Result<&[u8], HookError> {
    d.get(p..p.checked_add(len).ok_or(HookError::BadSysvar)?).ok_or(HookError::BadSysvar)
}

/// Walks every top-level instruction of the sysvar data. Malformed data is `BadSysvar`.
pub fn summarize(data: &[u8], tithe_recipient: &[u8; 32]) -> Result<TxSummary, HookError> {
    summarize_with(data, tithe_recipient, None)
}

/// `summarize`, also noting whether the transaction carries `app` (an app-only rule, v71.35/v71.36): the mark is looked
/// for in every top-level instruction (inner instructions are not in the sysvar), whatever else the instruction does.
pub fn summarize_with(data: &[u8], tithe_recipient: &[u8; 32], app: Option<&AppMark>) -> Result<TxSummary, HookError> {
    let count = u16_at(data, 0)?;
    let mut out = TxSummary { instruction_count: count as u16, ..TxSummary::default() };
    for i in 0..count {
        let mut p = u16_at(data, 2 + 2 * i)?;
        let accounts = u16_at(data, p)?;
        p += 2;
        let accounts_start = p;
        p = p.checked_add(accounts.checked_mul(33).ok_or(HookError::BadSysvar)?).ok_or(HookError::BadSysvar)?;
        let program: &[u8] = slice(data, p, 32)?;
        p += 32;
        let data_len = u16_at(data, p)?;
        p += 2;
        let ix_data = slice(data, p, data_len)?;
        if let Some(mark) = app {
            if !out.app_mark_present && app_mark_in(data, accounts_start, accounts, program, mark)? {
                out.app_mark_present = true;
            }
        }
        if program == COMPUTE_BUDGET_PROGRAM_ID {
            match ix_data.first() {
                Some(&COMPUTE_BUDGET_SET_UNIT_LIMIT) if ix_data.len() >= 5 => {
                    out.compute_unit_limit = Some(u32::from_le_bytes([ix_data[1], ix_data[2], ix_data[3], ix_data[4]]));
                }
                Some(&COMPUTE_BUDGET_SET_UNIT_PRICE) if ix_data.len() >= 9 => {
                    out.compute_unit_price = u64::from_le_bytes(ix_data[1..9].try_into().map_err(|_| HookError::BadSysvar)?);
                }
                _ => {}
            }
            continue;
        }
        out.budgeted_instructions = out.budgeted_instructions.saturating_add(1);
        if program == SYSTEM_PROGRAM_ID && ix_data.len() >= 12 && accounts >= 2 {
            let tag = u32::from_le_bytes([ix_data[0], ix_data[1], ix_data[2], ix_data[3]]);
            if tag != SYSTEM_TRANSFER {
                continue;
            }
            let lamports = u64::from_le_bytes(ix_data[4..12].try_into().map_err(|_| HookError::BadSysvar)?);
            let to: &[u8] = slice(data, accounts_start + 33 + 1, 32)?;
            if JITO_TIP_ACCOUNTS.iter().any(|tip| tip[..] == *to) {
                out.jito_tip_lamports = out.jito_tip_lamports.saturating_add(lamports);
            }
            if *to == tithe_recipient[..] {
                out.tithe_lamports = out.tithe_lamports.max(lamports);
            }
        }
    }
    Ok(out)
}

/// Whether one top-level instruction (its account metas at `accounts_start`, `accounts` of them, and its `program`)
/// carries the mark.
fn app_mark_in(data: &[u8], accounts_start: usize, accounts: usize, program: &[u8], mark: &AppMark) -> Result<bool, HookError> {
    match mark.kind {
        APP_MARK_PROGRAM => Ok(*program == mark.key[..]),
        APP_MARK_SIGNER => {
            for a in 0..accounts {
                let meta = slice(data, accounts_start + 33 * a, 33)?;
                if meta[0] & META_IS_SIGNER != 0 && meta[1..] == mark.key[..] {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        APP_MARK_PROGRAM_ACCOUNT => {
            if *program != mark.key[..] || accounts <= mark.index as usize {
                return Ok(false);
            }
            let meta = slice(data, accounts_start + 33 * mark.index as usize, 33)?;
            Ok(meta[1..] != mark.key[..])
        }
        _ => Ok(false),
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub struct Ix {
        pub program: [u8; 32],
        pub accounts: Vec<(u8, [u8; 32])>,
        pub data: Vec<u8>,
    }

    /// Mirrors `solana_program::sysvar::instructions::serialize_instructions` plus the current-index trailer.
    pub fn serialize(ixs: &[Ix], current: u16) -> Vec<u8> {
        let mut d = Vec::new();
        d.extend_from_slice(&(ixs.len() as u16).to_le_bytes());
        for _ in ixs {
            d.extend_from_slice(&[0, 0]);
        }
        for (i, ix) in ixs.iter().enumerate() {
            let off = d.len() as u16;
            d[2 + 2 * i..4 + 2 * i].copy_from_slice(&off.to_le_bytes());
            d.extend_from_slice(&(ix.accounts.len() as u16).to_le_bytes());
            for (flags, key) in &ix.accounts {
                d.push(*flags);
                d.extend_from_slice(key);
            }
            d.extend_from_slice(&ix.program);
            d.extend_from_slice(&(ix.data.len() as u16).to_le_bytes());
            d.extend_from_slice(&ix.data);
        }
        d.extend_from_slice(&current.to_le_bytes());
        d
    }

    pub fn set_limit(units: u32) -> Ix {
        let mut data = vec![COMPUTE_BUDGET_SET_UNIT_LIMIT];
        data.extend_from_slice(&units.to_le_bytes());
        Ix { program: COMPUTE_BUDGET_PROGRAM_ID, accounts: vec![], data }
    }

    pub fn set_price(micro_lamports: u64) -> Ix {
        let mut data = vec![COMPUTE_BUDGET_SET_UNIT_PRICE];
        data.extend_from_slice(&micro_lamports.to_le_bytes());
        Ix { program: COMPUTE_BUDGET_PROGRAM_ID, accounts: vec![], data }
    }

    pub fn transfer(from: [u8; 32], to: [u8; 32], lamports: u64) -> Ix {
        let mut data = SYSTEM_TRANSFER.to_le_bytes().to_vec();
        data.extend_from_slice(&lamports.to_le_bytes());
        Ix { program: SYSTEM_PROGRAM_ID, accounts: vec![(3, from), (2, to)], data }
    }

    pub fn other(program: [u8; 32], n_accounts: usize) -> Ix {
        Ix { program, accounts: (0..n_accounts).map(|i| (1, [i as u8; 32])).collect(), data: vec![9, 9, 9] }
    }

    const PAYER: [u8; 32] = [11; 32];
    const RECIPIENT: [u8; 32] = [22; 32];
    const DEX: [u8; 32] = [33; 32];

    #[test]
    fn well_known_ids_have_the_right_shape() {
        assert_eq!(SYSVAR_INSTRUCTIONS_ID[29..], [0, 0, 0]);
        assert_eq!(COMPUTE_BUDGET_PROGRAM_ID[29..], [0, 0, 0]);
        assert_eq!(SYSTEM_PROGRAM_ID, [0; 32]);
        let mut tips: Vec<[u8; 32]> = JITO_TIP_ACCOUNTS.to_vec();
        tips.sort();
        tips.dedup();
        assert_eq!(tips.len(), 8, "eight distinct tip accounts");
    }

    #[test]
    fn priority_fee_from_price_and_limit() {
        let d = serialize(&[set_limit(300_000), set_price(10_000), other(DEX, 12)], 2);
        let s = summarize(&d, &RECIPIENT).unwrap();
        assert_eq!(s.instruction_count, 3);
        assert_eq!(s.budgeted_instructions, 1);
        assert_eq!(s.compute_unit_limit, Some(300_000));
        assert_eq!(s.compute_unit_price, 10_000);
        assert_eq!(s.compute_units(), 300_000);
        assert_eq!(s.priority_fee_lamports(), 3_000, "10 000 micro-lamports x 300 000 CU = 3 000 lamports");
        // no limit set: 200k per budgeted instruction, capped at 1.4M
        let d = serialize(&[set_price(1_000), other(DEX, 3), other(DEX, 3)], 1);
        let s = summarize(&d, &RECIPIENT).unwrap();
        assert_eq!(s.compute_units(), 400_000);
        assert_eq!(s.priority_fee_lamports(), 400);
        let many: Vec<Ix> = core::iter::once(set_price(1_000)).chain((0..10).map(|_| other(DEX, 1))).collect();
        let s = summarize(&serialize(&many, 1), &RECIPIENT).unwrap();
        assert_eq!(s.compute_units(), 1_400_000, "ten instructions would be 2M; the cap is 1.4M");
        assert_eq!(s.priority_fee_lamports(), 1_400);
        // no price: no priority fee whatever the limit
        let s = summarize(&serialize(&[set_limit(1_400_000), other(DEX, 1)], 1), &RECIPIENT).unwrap();
        assert_eq!(s.priority_fee_lamports(), 0);
        // rounding up like the runtime
        let s = summarize(&serialize(&[set_limit(1), set_price(1), other(DEX, 1)], 2), &RECIPIENT).unwrap();
        assert_eq!(s.priority_fee_lamports(), 1);
        // a huge price saturates instead of overflowing
        let s = summarize(&serialize(&[set_limit(u32::MAX), set_price(u64::MAX), other(DEX, 1)], 2), &RECIPIENT).unwrap();
        assert_eq!(s.priority_fee_lamports(), u64::MAX);
        // the empty transaction
        let s = summarize(&serialize(&[], 0), &RECIPIENT).unwrap();
        assert_eq!(s, TxSummary::default());
    }

    #[test]
    fn jito_tips_are_summed_and_tithes_take_the_largest_transfer() {
        let d = serialize(
            &[
                transfer(PAYER, JITO_TIP_ACCOUNTS[0], 1_000),
                transfer(PAYER, RECIPIENT, 5_000_000),
                other(DEX, 15),
                transfer(PAYER, JITO_TIP_ACCOUNTS[7], 2_500),
                transfer(PAYER, [44; 32], 9_000_000_000),
                transfer(PAYER, RECIPIENT, 4_000_000),
            ],
            2,
        );
        let s = summarize(&d, &RECIPIENT).unwrap();
        assert_eq!(s.jito_tip_lamports, 3_500);
        assert_eq!(s.tithe_lamports, 5_000_000, "the largest single transfer, not the sum");
        assert_eq!(s.budgeted_instructions, 6);
        // a transfer to another wallet is neither; a non-transfer System instruction to a tip account is ignored
        let mut create = transfer(PAYER, JITO_TIP_ACCOUNTS[1], 7);
        create.data[0] = 0; // CreateAccount
        let s = summarize(&serialize(&[create, other(DEX, 2)], 1), &RECIPIENT).unwrap();
        assert_eq!((s.jito_tip_lamports, s.tithe_lamports), (0, 0));
        // a transfer from the recipient (accounts[0]) is not a payment to it
        let s = summarize(&serialize(&[transfer(RECIPIENT, PAYER, 7)], 0), &RECIPIENT).unwrap();
        assert_eq!(s.tithe_lamports, 0);
        // a tip-sized transfer by a program that is not the system program does not count
        let mut fake = transfer(PAYER, JITO_TIP_ACCOUNTS[2], 1_000);
        fake.program = DEX;
        assert_eq!(summarize(&serialize(&[fake], 0), &RECIPIENT).unwrap().jito_tip_lamports, 0);
        // tips saturate instead of overflowing
        let s = summarize(&serialize(&[transfer(PAYER, JITO_TIP_ACCOUNTS[3], u64::MAX), transfer(PAYER, JITO_TIP_ACCOUNTS[3], 5)], 0), &RECIPIENT).unwrap();
        assert_eq!(s.jito_tip_lamports, u64::MAX);
    }

    #[test]
    fn app_marks_are_seen_only_in_top_level_instructions() {
        let app = [9u8; 32];
        let program = AppMark { kind: APP_MARK_PROGRAM, key: app, index: 0 };
        let data = serialize(&[set_limit(400_000), other(app, 12), other([33; 32], 2)], 1);
        assert!(summarize_with(&data, &[0; 32], Some(&program)).unwrap().app_mark_present);
        assert!(!summarize_with(&data, &[0; 32], Some(&AppMark { kind: APP_MARK_PROGRAM, key: [8u8; 32], index: 0 })).unwrap().app_mark_present);
        assert!(!summarize_with(&data, &[0; 32], None).unwrap().app_mark_present);
        assert!(!summarize(&data, &[0; 32]).unwrap().app_mark_present);
        let without = serialize(&[set_limit(400_000), other([33; 32], 2)], 1);
        assert!(!summarize_with(&without, &[0; 32], Some(&program)).unwrap().app_mark_present);
        // Kind 2: the key must be among an instruction's accounts with the signer flag; as a plain account it is no mark.
        let cosigner = [77u8; 32];
        let signer = AppMark { kind: APP_MARK_SIGNER, key: cosigner, index: 0 };
        let mut swap = other([33; 32], 4);
        swap.accounts.push((3, cosigner)); // signer + writable
        let signed = serialize(&[set_limit(1), swap], 1);
        assert!(summarize_with(&signed, &[0; 32], Some(&signer)).unwrap().app_mark_present);
        let mut unsigned = other([33; 32], 4);
        unsigned.accounts.push((2, cosigner)); // writable, not a signer
        assert!(!summarize_with(&serialize(&[unsigned], 0), &[0; 32], Some(&signer)).unwrap().app_mark_present);
        assert!(!summarize_with(&serialize(&[other([33; 32], 4)], 0), &[0; 32], Some(&signer)).unwrap().app_mark_present);
        assert!(!summarize_with(&signed, &[0; 32], Some(&AppMark { kind: APP_MARK_SIGNER, key: [78u8; 32], index: 0 })).unwrap().app_mark_present);
        // Kind 3: the program invoked with account `index` filled by something other than the program itself.
        let router = [44u8; 32];
        let commission = AppMark { kind: APP_MARK_PROGRAM_ACCOUNT, key: router, index: 5 };
        let mut with_fee = other(router, 8);
        with_fee.accounts[5] = (2, [55u8; 32]);
        assert!(summarize_with(&serialize(&[with_fee], 0), &[0; 32], Some(&commission)).unwrap().app_mark_present);
        let mut placeholder = other(router, 8);
        placeholder.accounts[5] = (0, router); // the optional slot carries the program id = empty
        assert!(!summarize_with(&serialize(&[placeholder], 0), &[0; 32], Some(&commission)).unwrap().app_mark_present);
        assert!(!summarize_with(&serialize(&[other(router, 5)], 0), &[0; 32], Some(&commission)).unwrap().app_mark_present, "too few accounts");
        let mut wrong_program = other([45u8; 32], 8);
        wrong_program.accounts[5] = (2, [55u8; 32]);
        assert!(!summarize_with(&serialize(&[wrong_program], 0), &[0; 32], Some(&commission)).unwrap().app_mark_present);
        // An unknown kind never matches.
        assert!(!summarize_with(&data, &[0; 32], Some(&AppMark { kind: 9, key: app, index: 0 })).unwrap().app_mark_present);
    }

    #[test]
    fn malformed_data_is_bad_sysvar() {
        assert_eq!(summarize(&[], &RECIPIENT), Err(HookError::BadSysvar));
        assert_eq!(summarize(&[1], &RECIPIENT), Err(HookError::BadSysvar));
        assert_eq!(summarize(&[1, 0], &RECIPIENT), Err(HookError::BadSysvar), "count says one, no offset table");
        assert_eq!(summarize(&[1, 0, 200, 0], &RECIPIENT), Err(HookError::BadSysvar), "offset beyond the data");
        let good = serialize(&[set_price(5), transfer(PAYER, RECIPIENT, 10)], 1);
        summarize(&good, &RECIPIENT).unwrap();
        assert_eq!(summarize(&good[..good.len() - 20], &RECIPIENT), Err(HookError::BadSysvar), "truncated instruction");
        let mut huge_accounts = good.clone();
        let off = u16::from_le_bytes([good[4], good[5]]) as usize;
        huge_accounts[off..off + 2].copy_from_slice(&u16::MAX.to_le_bytes());
        assert_eq!(summarize(&huge_accounts, &RECIPIENT), Err(HookError::BadSysvar));
        // a short ComputeBudget payload is ignored rather than fatal
        let mut short_price = set_price(5);
        short_price.data.truncate(3);
        let s = summarize(&serialize(&[short_price, other(DEX, 1)], 1), &RECIPIENT).unwrap();
        assert_eq!(s.compute_unit_price, 0);
        // a System transfer with too little data is ignored
        let mut short_transfer = transfer(PAYER, RECIPIENT, 10);
        short_transfer.data.truncate(11);
        assert_eq!(summarize(&serialize(&[short_transfer], 0), &RECIPIENT).unwrap().tithe_lamports, 0);
        // a transfer with a single account cannot name a receiver
        let mut one_account = transfer(PAYER, RECIPIENT, 10);
        one_account.accounts.truncate(1);
        assert_eq!(summarize(&serialize(&[one_account], 0), &RECIPIENT).unwrap().tithe_lamports, 0);
    }
}
