//! ExtraAccountMetaList writer: the standard `spl-tlv-account-resolution` layout
//! Token-2022 reads to find the extra accounts of an Execute call.
//!
//! ```text
//! [0..8]   TLV type   = EXECUTE_DISCRIMINATOR
//! [8..12]  TLV length = 4 + 35 * count          (u32 LE)
//! [12..16] count                                 (u32 LE)
//! [16..]   count x ExtraAccountMeta (35 bytes):
//!          discriminator u8 | address_config [32] | is_signer u8 | is_writable u8
//! ```
//! discriminator 0 = literal address (address_config is the key), 1 = PDA of the
//! hook program (address_config is a packed seed list), 128 + i = PDA of the
//! program whose account sits at instruction index i. Seed encodings:
//! literal `[1, len, bytes..]`, instruction data `[2, index, len]`, account key
//! `[3, index]`, account data `[4, account_index, data_index, len]`; unused
//! bytes are zero.
//!
//! Account indices in an Execute call: 0 source, 1 mint, 2 destination,
//! 3 authority, 4 this list, 5 the HookConfig, then the entries the config's
//! rules need, each present only when needed, in this fixed order ([`Shape`]):
//!
//! | # | account | when | seeds / address | writable |
//! |---|---|---|---|---|
//! | 0 | HookConfig | always | hook PDA: "config", key(1) | yes |
//! | 1 | Instructions sysvar | sniper_fee_cap, tithe | literal | no |
//! | 2 | BlockList | blocklist | hook PDA: "block", key(1) | no |
//! | 3 | source-owner WalletState | holder_vesting | hook PDA: "wallet", key(1), data(0)[32..64] | yes |
//! | 4 | destination-owner WalletState | holder_vesting | hook PDA: "wallet", key(1), data(2)[32..64] | yes |
//! | 5 | destination-owner AllowEntry | allowlist | hook PDA: "allow", key(1), data(2)[32..64] | no |
//! | 6 | associated-token program | holder_gated | literal | no |
//! | 7 | gate token program | holder_gated | literal (from the config) | no |
//! | 8 | gate mint | holder_gated | literal (from the config) | no |
//! | 9 | destination owner's gate ATA | holder_gated | PDA of the program at the ATA-program index: data(2)[32..64], key(gate token program index), key(gate mint index) | no |
//!
//! The gate ATA's external-PDA discriminator and key() seeds use the ACTUAL
//! instruction indices of the three literal entries, which shift when the
//! sysvar/blocklist/wallet entries are absent. Both WalletState seeds read the
//! owner out of the token account's data (bytes 32..64) rather than taking
//! account 3 (the transfer authority may be a delegate); the program verifies
//! every WalletState against the real owner anyway. The literal gate keys are
//! copied from the HookConfig when the list is written, which is why InitConfig
//! must run first. `test/fixtures/hook-tlv.json` pins the exact bytes of six
//! shapes; the JS encoder `extraAccountMetaListBytes` must match them byte for byte.

use crate::errors::HookError;
use crate::execute::{needs_sysvar, KIND_ALLOWLIST, KIND_BLOCKLIST, KIND_HOLDER_GATED, KIND_HOLDER_VESTING};
use crate::instructions::EXECUTE_DISCRIMINATOR;
use crate::state::Rule;
use crate::sysvar::SYSVAR_INSTRUCTIONS_ID;

pub const ENTRY_LEN: usize = 35;
pub const HEADER_LEN: usize = 16;
pub const MAX_ENTRIES: usize = 10;
pub const MAX_LIST_LEN: usize = HEADER_LEN + MAX_ENTRIES * ENTRY_LEN; // 366

/// ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL
pub const ASSOCIATED_TOKEN_PROGRAM: [u8; 32] = [
    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142,
    123, 216, 219, 233, 248, 89,
];

const DISC_LITERAL: u8 = 0;
const DISC_HOOK_PDA: u8 = 1;
const DISC_EXTERNAL_PDA_BASE: u8 = 128;
const SEED_LITERAL: u8 = 1;
const SEED_ACCOUNT_KEY: u8 = 3;
const SEED_ACCOUNT_DATA: u8 = 4;

// Instruction account indices referenced by the seeds.
const IDX_SOURCE: u8 = 0;
const IDX_MINT: u8 = 1;
const IDX_DESTINATION: u8 = 2;
/// The HookConfig is always the first extra account.
pub const IDX_CONFIG: u8 = 5;
const TOKEN_ACCOUNT_OWNER_OFFSET: u8 = 32;

/// Which optional entries a config's rules need.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Shape {
    pub sysvar: bool,
    pub blocklist: bool,
    pub wallet_state: bool,
    pub allowlist: bool,
    pub holder_gated: bool,
}

/// Instruction indices of every extra account of an Execute call for one shape
/// (`None` = not present), and the number of accounts the call must carry.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Positions {
    pub config: u8,
    pub sysvar: Option<u8>,
    pub blocklist: Option<u8>,
    pub src_wallet: Option<u8>,
    pub dst_wallet: Option<u8>,
    pub allow: Option<u8>,
    pub ata_program: Option<u8>,
    pub gate_token_program: Option<u8>,
    pub gate_mint: Option<u8>,
    pub gate_ata: Option<u8>,
    pub accounts: usize,
}

impl Shape {
    pub const CONFIG_ONLY: Shape = Shape { sysvar: false, blocklist: false, wallet_state: false, allowlist: false, holder_gated: false };
    pub const FULL: Shape = Shape { sysvar: true, blocklist: true, wallet_state: true, allowlist: true, holder_gated: true };

    /// The shape a rule set needs (the catalogue's needsSysvar / needsBlocklist / needsWalletState / allowlist / holder_gated).
    pub fn from_rules(rules: &[Rule]) -> Shape {
        let has = |kind: u8| rules.iter().any(|r| r.kind == kind);
        Shape {
            sysvar: rules.iter().any(|r| needs_sysvar(r.kind)),
            blocklist: has(KIND_BLOCKLIST),
            wallet_state: has(KIND_HOLDER_VESTING),
            allowlist: has(KIND_ALLOWLIST),
            holder_gated: has(KIND_HOLDER_GATED),
        }
    }

    /// Number of entries in the list (1..=10).
    pub const fn count(&self) -> usize {
        1 + self.sysvar as usize + self.blocklist as usize + 2 * self.wallet_state as usize + self.allowlist as usize + 4 * self.holder_gated as usize
    }

    /// Size of the ExtraAccountMetaList account: 16 + 35 × count.
    pub const fn list_len(&self) -> usize {
        HEADER_LEN + self.count() * ENTRY_LEN
    }

    /// Instruction indices of the present entries (config is always 5).
    pub fn positions(&self) -> Positions {
        let mut next = IDX_CONFIG + 1;
        let mut take = |present: bool| {
            if present {
                let i = next;
                next += 1;
                Some(i)
            } else {
                None
            }
        };
        let sysvar = take(self.sysvar);
        let blocklist = take(self.blocklist);
        let src_wallet = take(self.wallet_state);
        let dst_wallet = take(self.wallet_state);
        let allow = take(self.allowlist);
        let ata_program = take(self.holder_gated);
        let gate_token_program = take(self.holder_gated);
        let gate_mint = take(self.holder_gated);
        let gate_ata = take(self.holder_gated);
        Positions { config: IDX_CONFIG, sysvar, blocklist, src_wallet, dst_wallet, allow, ata_program, gate_token_program, gate_mint, gate_ata, accounts: next as usize }
    }
}

/// A seed list packed into the 32-byte address_config.
struct Seeds {
    bytes: [u8; 32],
    len: usize,
}

impl Seeds {
    const fn new() -> Seeds {
        Seeds { bytes: [0; 32], len: 0 }
    }
    fn push(&mut self, part: &[u8]) -> Result<(), HookError> {
        if self.len + part.len() > 32 {
            return Err(HookError::BadAccounts);
        }
        self.bytes[self.len..self.len + part.len()].copy_from_slice(part);
        self.len += part.len();
        Ok(())
    }
    fn literal(mut self, text: &[u8]) -> Result<Seeds, HookError> {
        if text.len() > 32 {
            return Err(HookError::BadAccounts);
        }
        self.push(&[SEED_LITERAL, text.len() as u8])?;
        self.push(text)?;
        Ok(self)
    }
    fn account_key(mut self, index: u8) -> Result<Seeds, HookError> {
        self.push(&[SEED_ACCOUNT_KEY, index])?;
        Ok(self)
    }
    fn account_data(mut self, index: u8, offset: u8, len: u8) -> Result<Seeds, HookError> {
        self.push(&[SEED_ACCOUNT_DATA, index, offset, len])?;
        Ok(self)
    }
}

fn write_entry(out: &mut [u8], n: usize, discriminator: u8, address_config: &[u8; 32], is_writable: bool) {
    let p = HEADER_LEN + n * ENTRY_LEN;
    out[p] = discriminator;
    out[p + 1..p + 33].copy_from_slice(address_config);
    out[p + 33] = 0; // is_signer: Token-2022 strips signer flags from hook calls
    out[p + 34] = is_writable as u8;
}

/// Writes the whole list into `out`, which must be exactly `shape.list_len()`
/// bytes. The gate keys are only read when the shape is holder-gated.
pub fn write_list(out: &mut [u8], shape: &Shape, gate_token_program: &[u8; 32], gate_mint: &[u8; 32]) -> Result<(), HookError> {
    let count = shape.count();
    if out.len() != shape.list_len() {
        return Err(HookError::BadAccounts);
    }
    out.fill(0);
    out[..8].copy_from_slice(&EXECUTE_DISCRIMINATOR);
    out[8..12].copy_from_slice(&((4 + count * ENTRY_LEN) as u32).to_le_bytes());
    out[12..16].copy_from_slice(&(count as u32).to_le_bytes());
    let pos = shape.positions();
    let mut n = 0;
    let config = Seeds::new().literal(b"config")?.account_key(IDX_MINT)?;
    write_entry(out, n, DISC_HOOK_PDA, &config.bytes, true);
    n += 1;
    if shape.sysvar {
        write_entry(out, n, DISC_LITERAL, &SYSVAR_INSTRUCTIONS_ID, false);
        n += 1;
    }
    if shape.blocklist {
        let block = Seeds::new().literal(b"block")?.account_key(IDX_MINT)?;
        write_entry(out, n, DISC_HOOK_PDA, &block.bytes, false);
        n += 1;
    }
    if shape.wallet_state {
        let source_wallet = Seeds::new().literal(b"wallet")?.account_key(IDX_MINT)?.account_data(IDX_SOURCE, TOKEN_ACCOUNT_OWNER_OFFSET, 32)?;
        write_entry(out, n, DISC_HOOK_PDA, &source_wallet.bytes, true);
        let destination_wallet = Seeds::new().literal(b"wallet")?.account_key(IDX_MINT)?.account_data(IDX_DESTINATION, TOKEN_ACCOUNT_OWNER_OFFSET, 32)?;
        write_entry(out, n + 1, DISC_HOOK_PDA, &destination_wallet.bytes, true);
        n += 2;
    }
    if shape.allowlist {
        let destination_allow = Seeds::new().literal(b"allow")?.account_key(IDX_MINT)?.account_data(IDX_DESTINATION, TOKEN_ACCOUNT_OWNER_OFFSET, 32)?;
        write_entry(out, n, DISC_HOOK_PDA, &destination_allow.bytes, false);
        n += 1;
    }
    if shape.holder_gated {
        let (ata_program, token_program, mint) = match (pos.ata_program, pos.gate_token_program, pos.gate_mint) {
            (Some(a), Some(t), Some(m)) => (a, t, m),
            _ => return Err(HookError::BadAccounts),
        };
        write_entry(out, n, DISC_LITERAL, &ASSOCIATED_TOKEN_PROGRAM, false);
        write_entry(out, n + 1, DISC_LITERAL, gate_token_program, false);
        write_entry(out, n + 2, DISC_LITERAL, gate_mint, false);
        let gate_ata = Seeds::new().account_data(IDX_DESTINATION, TOKEN_ACCOUNT_OWNER_OFFSET, 32)?.account_key(token_program)?.account_key(mint)?;
        write_entry(out, n + 3, DISC_EXTERNAL_PDA_BASE + ata_program, &gate_ata.bytes, false);
        n += 4;
    }
    debug_assert_eq!(n, count);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../test/fixtures/hook-tlv.json");

    /// Pulls `"<key>": "<hex>"` of a shape section out of test/fixtures/hook-tlv.json without a JSON crate.
    fn fixture_hex(section: &str) -> Vec<u8> {
        let start = FIXTURE.find(&format!("\"{}\": {{", section)).expect("fixture section");
        let rest = &FIXTURE[start..];
        let hex_key = rest.find("\"hex\"").expect("hex key");
        let after = &rest[hex_key + 5..];
        let open = after.find('"').expect("open quote") + 1;
        let close = after[open..].find('"').expect("close quote") + open;
        let hex = &after[open..close];
        (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex")).collect()
    }

    fn fixture_key(field: &str) -> [u8; 32] {
        let k = FIXTURE.find(&format!("\"{}\"", field)).expect("field");
        let after = &FIXTURE[k + field.len() + 2..];
        let open = after.find('[').expect("array") + 1;
        let close = after[open..].find(']').expect("array end") + open;
        let bytes: Vec<u8> = after[open..close].split(',').map(|s| s.trim().parse::<u8>().expect("byte")).collect();
        bytes.try_into().expect("32 bytes")
    }

    fn shape(sysvar: bool, blocklist: bool, wallet_state: bool, allowlist: bool, holder_gated: bool) -> Shape {
        Shape { sysvar, blocklist, wallet_state, allowlist, holder_gated }
    }

    fn rule(kind: u8) -> Rule {
        Rule { kind, params: [0; 6] }
    }

    fn written(s: &Shape, tp: &[u8; 32], gm: &[u8; 32]) -> Vec<u8> {
        let mut out = vec![0u8; s.list_len()];
        write_list(&mut out, s, tp, gm).unwrap();
        out
    }

    #[test]
    fn shapes_from_rules_counts_and_positions() {
        assert_eq!(Shape::from_rules(&[rule(4), rule(7)]), Shape::CONFIG_ONLY);
        assert_eq!(Shape::from_rules(&[rule(21)]), shape(true, false, false, false, false));
        assert_eq!(Shape::from_rules(&[rule(25), rule(13)]), shape(true, false, false, false, false));
        assert_eq!(Shape::from_rules(&[rule(17)]), shape(false, true, false, false, false));
        assert_eq!(Shape::from_rules(&[rule(3), rule(1)]), shape(false, false, true, true, false));
        assert_eq!(Shape::from_rules(&[rule(2)]), shape(false, false, false, false, true));
        assert_eq!(Shape::from_rules(&[]), Shape::CONFIG_ONLY);
        assert_eq!(Shape::CONFIG_ONLY.count(), 1);
        assert_eq!(Shape::CONFIG_ONLY.list_len(), 51);
        assert_eq!(shape(true, false, false, false, false).list_len(), 86);
        assert_eq!(shape(false, true, false, false, false).list_len(), 86);
        assert_eq!(shape(false, false, true, true, false).list_len(), 156);
        assert_eq!(shape(false, false, false, false, true).list_len(), 191);
        assert_eq!(Shape::FULL.count(), 10);
        assert_eq!(Shape::FULL.list_len(), 366);
        assert_eq!(MAX_LIST_LEN, 366);
        let p = Shape::CONFIG_ONLY.positions();
        assert_eq!((p.config, p.accounts), (5, 6));
        assert_eq!(p.sysvar, None);
        let p = shape(false, false, false, false, true).positions();
        assert_eq!((p.ata_program, p.gate_token_program, p.gate_mint, p.gate_ata, p.accounts), (Some(6), Some(7), Some(8), Some(9), 10));
        let p = shape(true, false, true, true, false).positions();
        assert_eq!((p.sysvar, p.blocklist, p.src_wallet, p.dst_wallet, p.allow, p.accounts), (Some(6), None, Some(7), Some(8), Some(9), 10));
        let p = Shape::FULL.positions();
        assert_eq!(p, Positions { config: 5, sysvar: Some(6), blocklist: Some(7), src_wallet: Some(8), dst_wallet: Some(9), allow: Some(10), ata_program: Some(11), gate_token_program: Some(12), gate_mint: Some(13), gate_ata: Some(14), accounts: 15 });
        let mut wrong = [0u8; 100];
        assert_eq!(write_list(&mut wrong, &Shape::CONFIG_ONLY, &[0; 32], &[0; 32]), Err(HookError::BadAccounts));
    }

    #[test]
    fn entry_layouts() {
        let tp = [7u8; 32];
        let gm = [9u8; 32];
        let out = written(&Shape::FULL, &tp, &gm);
        assert_eq!(&out[..8], &EXECUTE_DISCRIMINATOR);
        assert_eq!(u32::from_le_bytes(out[8..12].try_into().unwrap()), 4 + 10 * 35);
        assert_eq!(u32::from_le_bytes(out[12..16].try_into().unwrap()), 10);
        let entry = |n: usize| &out[16 + n * 35..16 + (n + 1) * 35];
        // 0 config PDA, writable
        assert_eq!(entry(0)[0], 1);
        assert_eq!(&entry(0)[1..11], &[1, 6, b'c', b'o', b'n', b'f', b'i', b'g', 3, 1]);
        assert!(entry(0)[11..33].iter().all(|b| *b == 0));
        assert_eq!(&entry(0)[33..], &[0, 1]);
        // 1 instructions sysvar, literal, readonly
        assert_eq!(entry(1)[0], 0);
        assert_eq!(&entry(1)[1..33], &SYSVAR_INSTRUCTIONS_ID);
        assert_eq!(&entry(1)[33..], &[0, 0]);
        // 2 blocklist PDA, readonly
        assert_eq!(entry(2)[0], 1);
        assert_eq!(&entry(2)[1..10], &[1, 5, b'b', b'l', b'o', b'c', b'k', 3, 1]);
        assert_eq!(&entry(2)[33..], &[0, 0]);
        // 3/4 wallet states (owner read from the token account data), writable
        assert_eq!(&entry(3)[1..15], &[1, 6, b'w', b'a', b'l', b'l', b'e', b't', 3, 1, 4, 0, 32, 32]);
        assert_eq!(&entry(3)[33..], &[0, 1]);
        assert_eq!(&entry(4)[1..15], &[1, 6, b'w', b'a', b'l', b'l', b'e', b't', 3, 1, 4, 2, 32, 32]);
        assert_eq!(&entry(4)[33..], &[0, 1]);
        // 5 allow entry, readonly
        assert_eq!(&entry(5)[1..14], &[1, 5, b'a', b'l', b'l', b'o', b'w', 3, 1, 4, 2, 32, 32]);
        assert_eq!(&entry(5)[33..], &[0, 0]);
        // 6..9 gate accounts: literals, then the ATA as a PDA of the program at index 11 with keys 12 and 13
        assert_eq!(entry(6)[0], 0);
        assert_eq!(&entry(6)[1..33], &ASSOCIATED_TOKEN_PROGRAM);
        assert_eq!(&entry(7)[1..33], &tp);
        assert_eq!(&entry(8)[1..33], &gm);
        assert_eq!(entry(9)[0], 128 + 11);
        assert_eq!(&entry(9)[1..9], &[4, 2, 32, 32, 3, 12, 3, 13]);
        assert!(entry(9)[9..33].iter().all(|b| *b == 0));
        assert_eq!(&entry(9)[33..], &[0, 0]);
        // the plain holder-gated shape: the gate entries sit right after the config, so the indices shift down
        let gated = written(&shape(false, false, false, false, true), &tp, &gm);
        assert_eq!(gated.len(), 191);
        assert_eq!(gated[16 + 4 * 35], 128 + 6);
        assert_eq!(&gated[16 + 4 * 35 + 1..16 + 4 * 35 + 9], &[4, 2, 32, 32, 3, 7, 3, 8]);
        assert_eq!(&gated[16..51], &out[16..51], "the config entry is identical in every shape");
        assert_eq!(&gated[51..86], entry(6));
        // route shape: config + wallets + allow
        let route = written(&shape(false, false, true, true, false), &tp, &gm);
        assert_eq!(route.len(), 156);
        assert_eq!(&route[51..86], entry(3));
        assert_eq!(&route[86..121], entry(4));
        assert_eq!(&route[121..156], entry(5));
    }

    #[test]
    fn matches_the_shared_fixture() {
        let tp = fixture_key("gateTokenProgramBytes");
        let gm = fixture_key("gateMintBytes");
        assert_eq!(tp, [7u8; 32]);
        assert_eq!(gm, [9u8; 32]);
        let cases: [(&str, Shape); 6] = [
            ("configOnly", Shape::CONFIG_ONLY),
            ("sysvar", shape(true, false, false, false, false)),
            ("blocklist", shape(false, true, false, false, false)),
            ("route", shape(false, false, true, true, false)),
            ("holderGated", shape(false, false, false, false, true)),
            ("full", Shape::FULL),
        ];
        for (name, s) in cases {
            let expected = fixture_hex(name);
            assert_eq!(expected.len(), s.list_len(), "{} size", name);
            assert_eq!(written(&s, &tp, &gm), expected, "{} shape differs from test/fixtures/hook-tlv.json", name);
        }
    }
}
