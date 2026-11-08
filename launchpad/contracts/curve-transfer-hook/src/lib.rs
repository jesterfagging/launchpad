//! Launchpad transfer hook (v71.28, rules v2): the Token-2022 transfer hook that
//! enforces a creator's transfer rules while their coin trades on Meteora's
//! Dynamic Bonding Curve. Rules are written once at launch (InitConfig); the
//! creator may only add and remove allowlist wallets afterwards, and fill the
//! blocklist before the first trade. The program never moves funds: it can only
//! fail a transfer.
//!
//! Hand-written layouts over `solana-program` alone (no Anchor, no spl crates),
//! like `contracts/curve-damm-pump-fee`. The rule engine (`execute.rs`), the
//! account layouts (`state.rs`), the instruction parser (`instructions.rs`), the
//! ExtraAccountMetaList writer (`tlv.rs`), the calendar (`calendar.rs`), the
//! oscillator math (`osc.rs`) and the instructions-sysvar parser (`sysvar.rs`)
//! depend on nothing but core, so `cargo test` runs their unit tests on a plain
//! host toolchain; this file wires them to accounts, PDAs, rent, the clock, the
//! stack height and the sysvar account. Not professionally audited.
//!
//! Instructions (1-byte tag; the interface discriminators are accepted too):
//! 0 InitializeExtraAccountMetaList, 1 InitConfig, 2 AddAllowed, 3 RemoveAllowed,
//! 4 RegisterWallet, 5 AddBlocked, Execute = sha256("spl-transfer-hook-interface:execute")[0..8].
//! See README.md for every account and byte.
#![allow(unexpected_cfgs)]

pub mod calendar;
pub mod errors;
pub mod execute;
pub mod instructions;
pub mod osc;
pub mod state;
pub mod sysvar;
pub mod tlv;

use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::get_stack_height,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};

use errors::HookError;
use execute::{evaluate, validate_rules, Transfer, WalletView, KIND_HOLDER_GATED, KIND_SLIDING_CAPS, KIND_TITHE};
use instructions::{blocked_wallet, parse, HookInstruction, InitConfigArgs, MAX_BLOCK_BATCH};
use state::{mint_supply, token_account_view, AllowEntry, BlockList, ConfigState, HookConfig, WalletState, VERSION, ZERO_KEY};
use sysvar::{AppMark, TxSummary, SYSVAR_INSTRUCTIONS_ID};
use tlv::{Positions, Shape};

solana_program::entrypoint!(process_instruction);

/// TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb — the only token program whose accounts Execute accepts.
pub const TOKEN_2022_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77, 131, 185, 13, 39, 254,
    189, 249, 40, 216, 161, 139, 252,
]);
/// ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL — resolves the gate ATA of a holder-gated transfer.
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey = Pubkey::new_from_array(tlv::ASSOCIATED_TOKEN_PROGRAM);

pub const SEED_CONFIG: &[u8] = b"config";
pub const SEED_WALLET: &[u8] = b"wallet";
pub const SEED_ALLOW: &[u8] = b"allow";
pub const SEED_BLOCK: &[u8] = b"block";
pub const SEED_EXTRA_METAS: &[u8] = b"extra-account-metas";

impl From<HookError> for ProgramError {
    fn from(e: HookError) -> ProgramError {
        ProgramError::Custom(e.code())
    }
}

fn need(ok: bool, e: HookError) -> ProgramResult {
    if ok {
        Ok(())
    } else {
        Err(e.into())
    }
}

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match parse(data).ok_or(ProgramError::InvalidInstructionData)? {
        HookInstruction::Execute { amount } => {
            let clock = Clock::get()?;
            execute_transfer(program_id, accounts, amount, clock.unix_timestamp, clock.slot, get_stack_height() as u64)
        }
        HookInstruction::InitializeExtraAccountMetaList => initialize_extra_account_meta_list(program_id, accounts),
        HookInstruction::InitConfig(args) => init_config(program_id, accounts, &args),
        HookInstruction::AddAllowed { wallet } => add_allowed(program_id, accounts, &wallet),
        HookInstruction::RemoveAllowed => remove_allowed(program_id, accounts),
        HookInstruction::RegisterWallet => register_wallet(program_id, accounts),
        HookInstruction::AddBlocked { count } => add_blocked(program_id, accounts, data, count),
    }
}

// --- shared checks --------------------------------------------------------------

/// Re-derives a PDA from its seeds and stored bump (one `create_program_address`, no search).
fn derive(seeds: &[&[u8]], bump: u8, program_id: &Pubkey) -> Result<Pubkey, ProgramError> {
    need(seeds.len() <= 3, HookError::BadAccounts)?;
    let bump_seed = [bump];
    let mut all: [&[u8]; 4] = [&[], &[], &[], &[]];
    all[..seeds.len()].copy_from_slice(seeds);
    all[seeds.len()] = &bump_seed;
    Pubkey::create_program_address(&all[..=seeds.len()], program_id).map_err(|_| HookError::BadAccounts.into())
}

fn check_system_program(a: &AccountInfo) -> ProgramResult {
    need(*a.key == system_program::id(), HookError::BadAccounts)
}

/// Loads a HookConfig: owned by this program, well formed, and at its own PDA.
fn load_config(account: &AccountInfo, program_id: &Pubkey) -> Result<HookConfig, ProgramError> {
    need(account.owner == program_id, HookError::ConfigMismatch)?;
    let cfg = {
        let d = account.try_borrow_data()?;
        HookConfig::unpack(&d)?
    };
    let expected = derive(&[SEED_CONFIG, &cfg.mint[..]], cfg.bump, program_id)?;
    need(*account.key == expected, HookError::BadAccounts)?;
    Ok(cfg)
}

/// A WalletState passed to Execute: absent (not owned by this program) means
/// "not registered"; present means it must be well formed and at its PDA.
fn load_wallet_state(account: &AccountInfo, program_id: &Pubkey, mint: &[u8; 32], owner: &[u8; 32]) -> Result<WalletView, ProgramError> {
    if account.owner != program_id {
        return Ok(WalletView::default());
    }
    let state = {
        let d = account.try_borrow_data()?;
        WalletState::unpack(&d)?
    };
    let expected = derive(&[SEED_WALLET, &mint[..], &owner[..]], state.bump, program_id)?;
    need(*account.key == expected, HookError::BadAccounts)?;
    Ok(WalletView { registered: true, state })
}

/// An AllowEntry passed to Execute: present and valid = the wallet is allowed.
fn allow_entry_exists(account: &AccountInfo, program_id: &Pubkey, mint: &[u8; 32], wallet: &[u8; 32]) -> Result<bool, ProgramError> {
    if account.owner != program_id {
        return Ok(false);
    }
    let entry = {
        let d = account.try_borrow_data()?;
        AllowEntry::unpack(&d)?
    };
    need(entry.mint == *mint && entry.wallet == *wallet, HookError::BadAccounts)?;
    let expected = derive(&[SEED_ALLOW, &mint[..], &wallet[..]], entry.bump, program_id)?;
    need(*account.key == expected, HookError::BadAccounts)?;
    Ok(true)
}

/// The BlockList passed to Execute: a block PDA not owned by the program is an
/// empty list; an owned one must be well formed and at its PDA.
fn blocklist_contains(account: &AccountInfo, program_id: &Pubkey, mint: &[u8; 32], owner: &[u8; 32]) -> Result<bool, ProgramError> {
    if account.owner != program_id {
        return Ok(false);
    }
    let d = account.try_borrow_data()?;
    let (bump, _) = BlockList::header(&d)?;
    let expected = derive(&[SEED_BLOCK, &mint[..]], bump, program_id)?;
    need(*account.key == expected, HookError::BadAccounts)?;
    Ok(BlockList::contains(&d, owner)?)
}

/// Balance of the destination owner's gate token account (the four gate
/// accounts of a holder-gated shape). A missing account counts as zero; an
/// account that is not a token account of that owner for the gate mint is a
/// wiring error.
fn gate_balance(accounts: &[AccountInfo], pos: &Positions, cfg: &HookConfig, owner: &[u8; 32]) -> Result<u64, ProgramError> {
    let (ata_program, gate_program, gate_mint, gate_account) = match (pos.ata_program, pos.gate_token_program, pos.gate_mint, pos.gate_ata) {
        (Some(a), Some(p), Some(m), Some(g)) => (&accounts[a as usize], &accounts[p as usize], &accounts[m as usize], &accounts[g as usize]),
        _ => return Err(HookError::BadAccounts.into()),
    };
    need(
        *ata_program.key == ASSOCIATED_TOKEN_PROGRAM_ID
            && gate_program.key.to_bytes() == cfg.gate_token_program
            && gate_mint.key.to_bytes() == cfg.gate_mint,
        HookError::BadAccounts,
    )?;
    if gate_account.owner.to_bytes() != cfg.gate_token_program || gate_account.data_is_empty() {
        return Ok(0);
    }
    let view = token_account_view(&gate_account.try_borrow_data()?)?;
    need(view.mint == cfg.gate_mint && view.owner == *owner, HookError::BadAccounts)?;
    Ok(view.amount)
}

/// The instructions sysvar of a sysvar shape: must be the sysvar account; its
/// data is summarised by the pure parser.
fn read_sysvar(account: &AccountInfo, tithe_recipient: &[u8; 32], app: Option<AppMark>) -> Result<TxSummary, ProgramError> {
    need(account.key.to_bytes() == SYSVAR_INSTRUCTIONS_ID, HookError::BadSysvar)?;
    let d = account.try_borrow_data()?;
    Ok(sysvar::summarize_with(&d, tithe_recipient, app.as_ref())?)
}

/// Creates a rent-exempt, program-owned account at a PDA, paid by `payer`. An
/// address that already holds lamports (anyone can send some) is topped up,
/// allocated and assigned in place, so nobody can block a wallet's registration
/// or an allowlist entry by pre-funding its address.
fn create_pda_account<'a>(payer: &AccountInfo<'a>, target: &AccountInfo<'a>, system: &AccountInfo<'a>, program_id: &Pubkey, space: usize, seeds: &[&[u8]]) -> ProgramResult {
    need(*target.owner == system_program::id() && target.data_is_empty(), HookError::AlreadyInitialized)?;
    need(payer.is_signer && payer.is_writable && target.is_writable, HookError::BadAccounts)?;
    let required = Rent::get()?.minimum_balance(space);
    let current = target.lamports();
    if current == 0 {
        return invoke_signed(
            &system_instruction::create_account(payer.key, target.key, required, space as u64, program_id),
            &[payer.clone(), target.clone(), system.clone()],
            &[seeds],
        );
    }
    if required > current {
        invoke(&system_instruction::transfer(payer.key, target.key, required - current), &[payer.clone(), target.clone(), system.clone()])?;
    }
    invoke_signed(&system_instruction::allocate(target.key, space as u64), &[target.clone(), system.clone()], &[seeds])?;
    invoke_signed(&system_instruction::assign(target.key, program_id), &[target.clone(), system.clone()], &[seeds])
}

fn write_wallet_state(account: &AccountInfo, state: &WalletState) -> ProgramResult {
    need(account.is_writable, HookError::BadAccounts)?;
    let mut d = account.try_borrow_mut_data()?;
    state.pack(&mut d[..])?;
    Ok(())
}

// --- Execute ------------------------------------------------------------------------

/// Token-2022 calls this after moving the funds, with the signer flags removed:
/// 0 source token account, 1 mint, 2 destination token account, 3 authority,
/// 4 ExtraAccountMetaList, 5 HookConfig (w), then the entries the config's
/// rules need, in `tlv::Shape` order: instructions sysvar, BlockList,
/// source-owner WalletState (w), destination-owner WalletState (w),
/// destination-owner AllowEntry, associated-token program, gate token program,
/// gate mint, destination owner's gate ATA. `now`/`slot`/`stack_height` come
/// from the clock sysvar and `get_stack_height()` (passed in so the whole path
/// is unit-testable).
pub fn execute_transfer(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64, now: i64, slot: u64, stack_height: u64) -> ProgramResult {
    need(accounts.len() >= 6, HookError::BadAccounts)?;
    let (source, mint, destination, config_account) = (&accounts[0], &accounts[1], &accounts[2], &accounts[5]);
    need(
        *source.owner == TOKEN_2022_PROGRAM_ID && *destination.owner == TOKEN_2022_PROGRAM_ID && *mint.owner == TOKEN_2022_PROGRAM_ID,
        HookError::BadAccounts,
    )?;
    let src = token_account_view(&source.try_borrow_data()?)?;
    let dst = token_account_view(&destination.try_borrow_data()?)?;
    let mint_key = mint.key.to_bytes();
    need(src.mint == mint_key && dst.mint == mint_key, HookError::BadAccounts)?;
    // Only Token-2022 sets the transferring flag, and only for the duration of a transfer.
    need(src.transferring == Some(true) && dst.transferring == Some(true), HookError::NotTransferring)?;
    let supply = mint_supply(&mint.try_borrow_data()?)?;

    let cfg = load_config(config_account, program_id)?;
    need(cfg.mint == mint_key, HookError::ConfigMismatch)?;
    let shape = Shape::from_rules(cfg.rules());
    let pos = shape.positions();
    need(accounts.len() >= pos.accounts, HookError::BadAccounts)?;

    let same_owner = src.owner == dst.owner;
    let fees = match pos.sysvar {
        Some(i) => read_sysvar(&accounts[i as usize], &cfg.tithe_recipient, execute::app_mark(cfg.rules()))?,
        None => TxSummary::default(),
    };
    let dst_blocked = match pos.blocklist {
        Some(i) => blocklist_contains(&accounts[i as usize], program_id, &mint_key, &dst.owner)?,
        None => false,
    };
    // A self-transfer resolves both WalletStates to the same account; it is read and written once.
    let (src_state_account, dst_state_account) = match (pos.src_wallet, pos.dst_wallet) {
        (Some(s), Some(d)) => (Some(&accounts[s as usize]), Some(&accounts[d as usize])),
        _ => (None, None),
    };
    let src_view = match src_state_account {
        Some(a) => load_wallet_state(a, program_id, &mint_key, &src.owner)?,
        None => WalletView::default(),
    };
    let dst_view = match dst_state_account {
        Some(a) if !same_owner => load_wallet_state(a, program_id, &mint_key, &dst.owner)?,
        _ => WalletView::default(),
    };
    let dst_allowed = match pos.allow {
        Some(i) => allow_entry_exists(&accounts[i as usize], program_id, &mint_key, &dst.owner)?,
        None => false,
    };
    let dst_gate_balance = if pos.gate_ata.is_some() { gate_balance(accounts, &pos, &cfg, &dst.owner)? } else { 0 };

    let transfer = Transfer {
        amount,
        now,
        slot,
        supply,
        src_is_venue: cfg.is_venue(&source.key.to_bytes()),
        dst_is_venue: cfg.is_venue(&destination.key.to_bytes()),
        src_owner_exempt: cfg.is_exempt(&src.owner),
        dst_owner_exempt: cfg.is_exempt(&dst.owner),
        same_owner,
        src_post_balance: src.amount,
        dst_post_balance: dst.amount,
        src_owner: src.owner,
        dst_owner: dst.owner,
        dst_is_creator: dst.owner == cfg.creator,
        dst_allowed,
        dst_blocked,
        dst_gate_balance,
        stack_height,
        priority_fee_lamports: fees.priority_fee_lamports(),
        jito_tip_lamports: fees.jito_tip_lamports,
        tithe_lamports: fees.tithe_lamports,
        app_mark_present: fees.app_mark_present,
    };
    let before = cfg.state;
    let (mut state, mut sv, mut dv) = (before, src_view, dst_view);
    evaluate(cfg.rules(), &mut state, &mut sv, &mut dv, &transfer)?;

    if state != before {
        need(config_account.is_writable, HookError::BadAccounts)?;
        let mut d = config_account.try_borrow_mut_data()?;
        state::pack_dynamic(&state, &mut d[..])?;
    }
    if let Some(a) = src_state_account {
        if sv.registered && sv.state != src_view.state {
            write_wallet_state(a, &sv.state)?;
        }
    }
    if let Some(a) = dst_state_account {
        if !same_owner && dv.registered && dv.state != dst_view.state {
            write_wallet_state(a, &dv.state)?;
        }
    }
    Ok(())
}

// --- InitializeExtraAccountMetaList -------------------------------------------------

/// Accounts: 0 extra-metas PDA (w), 1 mint, 2 authority (signer: the creator),
/// 3 system program, 4 payer (signer, w), 5 HookConfig. Runs after InitConfig:
/// the list's shape and the gate keys come from the config. Data: `[0]`.
fn initialize_extra_account_meta_list(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    need(accounts.len() >= 6, HookError::BadAccounts)?;
    let (metas, mint, authority, system, payer, config_account) = (&accounts[0], &accounts[1], &accounts[2], &accounts[3], &accounts[4], &accounts[5]);
    check_system_program(system)?;
    need(authority.is_signer, HookError::BadAccounts)?;
    let cfg = load_config(config_account, program_id)?;
    need(cfg.mint == mint.key.to_bytes(), HookError::ConfigMismatch)?;
    need(authority.key.to_bytes() == cfg.creator, HookError::NotAllowed)?;
    let shape = Shape::from_rules(cfg.rules());
    let (expected, bump) = Pubkey::find_program_address(&[SEED_EXTRA_METAS, mint.key.as_ref()], program_id);
    need(*metas.key == expected, HookError::BadAccounts)?;
    create_pda_account(payer, metas, system, program_id, shape.list_len(), &[SEED_EXTRA_METAS, mint.key.as_ref(), &[bump]])?;
    let mut d = metas.try_borrow_mut_data()?;
    tlv::write_list(&mut d[..], &shape, &cfg.gate_token_program, &cfg.gate_mint)?;
    Ok(())
}

// --- InitConfig ------------------------------------------------------------------------

/// Accounts: 0 config PDA (w), 1 mint (need not exist yet: the launch
/// transaction creates it afterwards), 2 creator (signer), 3 payer (signer, w),
/// 4 system program. Fails if the config exists.
fn init_config(program_id: &Pubkey, accounts: &[AccountInfo], args: &InitConfigArgs) -> ProgramResult {
    need(accounts.len() >= 5, HookError::BadAccounts)?;
    let (config_account, mint, creator, payer, system) = (&accounts[0], &accounts[1], &accounts[2], &accounts[3], &accounts[4]);
    check_system_program(system)?;
    need(creator.is_signer, HookError::BadAccounts)?;
    let rules = &args.rules[..(args.rule_count as usize).min(args.rules.len())];
    validate_rules(rules)?;
    need(args.venues[0] != ZERO_KEY, HookError::ConfigMismatch)?;
    let has = |kind: u8| rules.iter().any(|r| r.kind == kind);
    need(!has(KIND_HOLDER_GATED) || (args.gate_mint != ZERO_KEY && args.gate_token_program != ZERO_KEY), HookError::ConfigMismatch)?;
    need(!has(KIND_TITHE) || args.tithe_recipient != ZERO_KEY, HookError::ConfigMismatch)?;
    need(!has(KIND_SLIDING_CAPS) || args.swap_base_amount != 0, HookError::ConfigMismatch)?;
    let (expected, bump) = Pubkey::find_program_address(&[SEED_CONFIG, mint.key.as_ref()], program_id);
    need(*config_account.key == expected, HookError::BadAccounts)?;
    create_pda_account(payer, config_account, system, program_id, HookConfig::LEN, &[SEED_CONFIG, mint.key.as_ref(), &[bump]])?;
    let cfg = HookConfig {
        version: VERSION,
        bump,
        mint: mint.key.to_bytes(),
        creator: creator.key.to_bytes(),
        exempt: args.exempt,
        venues: args.venues,
        gate_mint: args.gate_mint,
        gate_token_program: args.gate_token_program,
        rule_count: args.rule_count,
        rules: args.rules,
        tithe_recipient: args.tithe_recipient,
        state: ConfigState { swap_base_amount: args.swap_base_amount, ..ConfigState::default() },
    };
    let mut d = config_account.try_borrow_mut_data()?;
    cfg.pack(&mut d[..])?;
    Ok(())
}

// --- AddAllowed / RemoveAllowed -------------------------------------------------------

/// Accounts: 0 config, 1 creator (signer), 2 payer (signer, w), 3 allow PDA (w),
/// 4 system program. Idempotent: an existing entry for the wallet is fine.
fn add_allowed(program_id: &Pubkey, accounts: &[AccountInfo], wallet: &[u8; 32]) -> ProgramResult {
    need(accounts.len() >= 5, HookError::BadAccounts)?;
    let (config_account, creator, payer, allow, system) = (&accounts[0], &accounts[1], &accounts[2], &accounts[3], &accounts[4]);
    check_system_program(system)?;
    need(creator.is_signer, HookError::BadAccounts)?;
    let cfg = load_config(config_account, program_id)?;
    need(creator.key.to_bytes() == cfg.creator, HookError::NotAllowed)?;
    need(*wallet != ZERO_KEY, HookError::BadAccounts)?;
    let (expected, bump) = Pubkey::find_program_address(&[SEED_ALLOW, &cfg.mint[..], &wallet[..]], program_id);
    need(*allow.key == expected, HookError::BadAccounts)?;
    if allow.owner == program_id {
        let entry = {
            let d = allow.try_borrow_data()?;
            AllowEntry::unpack(&d)?
        };
        need(entry.mint == cfg.mint && entry.wallet == *wallet && entry.bump == bump, HookError::BadAccounts)?;
        return Ok(());
    }
    create_pda_account(payer, allow, system, program_id, AllowEntry::LEN, &[SEED_ALLOW, &cfg.mint[..], &wallet[..], &[bump]])?;
    let entry = AllowEntry { version: VERSION, bump, mint: cfg.mint, wallet: *wallet };
    let mut d = allow.try_borrow_mut_data()?;
    entry.pack(&mut d[..])?;
    Ok(())
}

/// Accounts: 0 config, 1 creator (signer), 2 allow PDA (w), 3 refund wallet (w).
/// Closes the entry: its lamports go to the refund wallet, the data is wiped and
/// the account is handed back to the system program.
fn remove_allowed(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    need(accounts.len() >= 4, HookError::BadAccounts)?;
    let (config_account, creator, allow, refund) = (&accounts[0], &accounts[1], &accounts[2], &accounts[3]);
    need(creator.is_signer && allow.is_writable && refund.is_writable, HookError::BadAccounts)?;
    let cfg = load_config(config_account, program_id)?;
    need(creator.key.to_bytes() == cfg.creator, HookError::NotAllowed)?;
    need(allow.owner == program_id, HookError::BadAccounts)?;
    let entry = {
        let d = allow.try_borrow_data()?;
        AllowEntry::unpack(&d)?
    };
    need(entry.mint == cfg.mint, HookError::BadAccounts)?;
    let expected = derive(&[SEED_ALLOW, &cfg.mint[..], &entry.wallet[..]], entry.bump, program_id)?;
    need(*allow.key == expected && refund.key != allow.key, HookError::BadAccounts)?;
    let refunded = refund.lamports().checked_add(allow.lamports()).ok_or(HookError::Overflow)?;
    **refund.try_borrow_mut_lamports()? = refunded;
    **allow.try_borrow_mut_lamports()? = 0;
    allow.try_borrow_mut_data()?.fill(0);
    allow.assign(&system_program::id());
    Ok(())
}

// --- RegisterWallet ----------------------------------------------------------------------

/// Accounts: 0 config, 1 wallet (the owner; need not sign), 2 payer (signer, w),
/// 3 wallet-state PDA (w), 4 system program. Anyone may pay to register any
/// wallet; an existing record is fine (idempotent).
fn register_wallet(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    need(accounts.len() >= 5, HookError::BadAccounts)?;
    let (config_account, wallet, payer, state_account, system) = (&accounts[0], &accounts[1], &accounts[2], &accounts[3], &accounts[4]);
    check_system_program(system)?;
    let cfg = load_config(config_account, program_id)?;
    let (expected, bump) = Pubkey::find_program_address(&[SEED_WALLET, &cfg.mint[..], wallet.key.as_ref()], program_id);
    need(*state_account.key == expected, HookError::BadAccounts)?;
    if state_account.owner == program_id {
        let state = {
            let d = state_account.try_borrow_data()?;
            WalletState::unpack(&d)?
        };
        need(state.bump == bump, HookError::BadAccounts)?;
        return Ok(());
    }
    create_pda_account(payer, state_account, system, program_id, WalletState::LEN, &[SEED_WALLET, &cfg.mint[..], wallet.key.as_ref(), &[bump]])?;
    let mut d = state_account.try_borrow_mut_data()?;
    WalletState::new(bump).pack(&mut d[..])?;
    Ok(())
}

// --- AddBlocked ------------------------------------------------------------------------------

/// Accounts: 0 config, 1 creator (signer), 2 payer (signer, w), 3 block PDA (w),
/// 4 system program. Data: `[5, n] ++ n × wallet[32]` (n ≤ 28). Creates the
/// BlockList on first use (rent paid by the payer), appends the wallets (listed
/// ones are skipped), refuses more than 200 entries (`BlocklistFull`) and
/// anything after the first trade (`LaunchStarted`: `started_at != 0`).
fn add_blocked(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8], count: u8) -> ProgramResult {
    need(accounts.len() >= 5, HookError::BadAccounts)?;
    let (config_account, creator, payer, block, system) = (&accounts[0], &accounts[1], &accounts[2], &accounts[3], &accounts[4]);
    check_system_program(system)?;
    need(creator.is_signer && block.is_writable, HookError::BadAccounts)?;
    let cfg = load_config(config_account, program_id)?;
    need(creator.key.to_bytes() == cfg.creator, HookError::NotAllowed)?;
    need(cfg.state.started_at == 0, HookError::LaunchStarted)?;
    let n = (count as usize).min(MAX_BLOCK_BATCH);
    need(n >= 1, HookError::BadAccounts)?;
    let mut wallets = [[0u8; 32]; MAX_BLOCK_BATCH];
    for (i, slot) in wallets[..n].iter_mut().enumerate() {
        *slot = blocked_wallet(data, i).ok_or(HookError::BadAccounts)?;
    }
    let (expected, bump) = Pubkey::find_program_address(&[SEED_BLOCK, &cfg.mint[..]], program_id);
    need(*block.key == expected, HookError::BadAccounts)?;
    if block.owner == program_id {
        let d = block.try_borrow_data()?;
        let (stored_bump, _) = BlockList::header(&d)?;
        need(stored_bump == bump, HookError::BadAccounts)?;
    } else {
        create_pda_account(payer, block, system, program_id, BlockList::LEN, &[SEED_BLOCK, &cfg.mint[..], &[bump]])?;
        let mut d = block.try_borrow_mut_data()?;
        BlockList::init(&mut d[..], bump)?;
    }
    let mut d = block.try_borrow_mut_data()?;
    BlockList::append(&mut d[..], &wallets[..n])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use execute::{KIND_ALLOWLIST, KIND_BLOCKLIST, KIND_DEX_ONLY, KIND_FOMO_ONLY, KIND_HOLDER_VESTING, KIND_MAX_PER_WALLET, KIND_PING_PONG, KIND_TRADE_GUARD};
    use instructions::{EXECUTE_DISCRIMINATOR, INITIALIZE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR, UPDATE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR};
    use solana_program::hash::hash;
    use state::{put_u64, Rule, TOKEN_ACCOUNT_LEN};

    const SUPPLY: u64 = 1_000_000_000_000_000;
    const NOW: i64 = 1_700_000_000;
    const SLOT: u64 = 250_000_000;
    const VIA_POOL: u64 = 3;

    fn rule(kind: u8, params: &[u64]) -> Rule {
        let mut p = [0u64; 6];
        p[..params.len()].copy_from_slice(params);
        Rule { kind, params: p }
    }

    #[test]
    fn interface_discriminators_are_the_sha256_prefixes() {
        assert_eq!(&hash(b"spl-transfer-hook-interface:execute").to_bytes()[..8], &EXECUTE_DISCRIMINATOR);
        assert_eq!(&hash(b"spl-transfer-hook-interface:initialize-extra-account-metas").to_bytes()[..8], &INITIALIZE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR);
        assert_eq!(&hash(b"spl-transfer-hook-interface:update-extra-account-metas").to_bytes()[..8], &UPDATE_EXTRA_ACCOUNT_METAS_DISCRIMINATOR);
    }

    #[test]
    fn well_known_program_ids_decode() {
        assert_eq!(TOKEN_2022_PROGRAM_ID.to_string(), "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
        assert_eq!(ASSOCIATED_TOKEN_PROGRAM_ID.to_string(), "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
        assert_eq!(system_program::id().to_string(), "11111111111111111111111111111111");
        assert_eq!(Pubkey::new_from_array(SYSVAR_INSTRUCTIONS_ID).to_string(), "Sysvar1nstructions1111111111111111111111111");
        assert_eq!(Pubkey::new_from_array(sysvar::COMPUTE_BUDGET_PROGRAM_ID).to_string(), "ComputeBudget111111111111111111111111111111");
        let tips = [
            "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
            "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
            "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
            "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
            "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
            "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
            "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
            "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
        ];
        for (bytes, text) in sysvar::JITO_TIP_ACCOUNTS.iter().zip(tips) {
            assert_eq!(Pubkey::new_from_array(*bytes).to_string(), text);
        }
    }

    #[test]
    fn hook_errors_become_custom_program_errors() {
        let e: ProgramError = HookError::MaxPerWallet.into();
        assert_eq!(e, ProgramError::Custom(6007));
        let t: ProgramError = HookError::Tithe.into();
        assert_eq!(t, ProgramError::Custom(6025));
        assert_eq!(need(false, HookError::NotTransferring), Err(ProgramError::Custom(6104)));
        assert_eq!(need(false, HookError::BadSysvar), Err(ProgramError::Custom(6109)));
        assert_eq!(need(true, HookError::NotTransferring), Ok(()));
    }

    #[test]
    fn derive_matches_find_program_address() {
        let program = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let (key, bump) = Pubkey::find_program_address(&[SEED_WALLET, mint.as_ref(), owner.as_ref()], &program);
        assert_eq!(derive(&[SEED_WALLET, mint.as_ref(), owner.as_ref()], bump, &program).unwrap(), key);
        assert_ne!(derive(&[SEED_ALLOW, mint.as_ref(), owner.as_ref()], bump, &program).unwrap_or_default(), key);
        let (block, bump) = Pubkey::find_program_address(&[SEED_BLOCK, mint.as_ref()], &program);
        assert_eq!(derive(&[SEED_BLOCK, mint.as_ref()], bump, &program).unwrap(), block);
        assert_eq!(derive(&[&[1], &[2], &[3], &[4]], bump, &program), Err(ProgramError::Custom(6103)));
    }

    // --- an in-memory transfer -------------------------------------------------------

    struct Acc {
        key: Pubkey,
        lamports: u64,
        data: Vec<u8>,
        owner: Pubkey,
        signer: bool,
        writable: bool,
    }

    fn acc(key: Pubkey, owner: Pubkey, data: Vec<u8>, writable: bool) -> Acc {
        Acc { key, lamports: if data.is_empty() { 0 } else { 1_000_000 }, data, owner, signer: false, writable }
    }

    fn empty(key: Pubkey) -> Acc {
        acc(key, system_program::id(), Vec::new(), true)
    }

    fn infos(accs: &mut [Acc]) -> Vec<AccountInfo<'_>> {
        accs.iter_mut()
            .map(|a| {
                let Acc { key, lamports, data, owner, signer, writable } = a;
                AccountInfo::new(key, *signer, *writable, lamports, data.as_mut_slice(), owner, false, 0)
            })
            .collect()
    }

    /// A Token-2022 account with the ImmutableOwner and TransferHookAccount extensions.
    fn token_account(mint: &Pubkey, owner: &Pubkey, amount: u64, transferring: bool) -> Vec<u8> {
        let mut d = vec![0u8; TOKEN_ACCOUNT_LEN];
        d[..32].copy_from_slice(mint.as_ref());
        d[32..64].copy_from_slice(owner.as_ref());
        put_u64(&mut d, 64, amount);
        d[108] = 1;
        d.push(2);
        d.extend_from_slice(&[7, 0, 0, 0, 15, 0, 1, 0, transferring as u8]);
        d
    }

    fn mint_data(supply: u64) -> Vec<u8> {
        let mut m = vec![0u8; 82];
        put_u64(&mut m, 36, supply);
        m[45] = 1;
        m
    }

    struct World {
        program: Pubkey,
        mint: Pubkey,
        vault: Pubkey,
        pool_authority: Pubkey,
        buyer: Pubkey,
        creator: Pubkey,
        tithe_recipient: Pubkey,
        config_key: Pubkey,
        config: Vec<u8>,
    }

    fn world(rules: &[Rule]) -> World {
        world_in(Pubkey::new_unique(), rules)
    }

    fn world_in(program: Pubkey, rules: &[Rule]) -> World {
        let mint = Pubkey::new_unique();
        let vault = Pubkey::new_unique();
        let pool_authority = Pubkey::new_unique();
        let buyer = Pubkey::new_unique();
        let creator = Pubkey::new_unique();
        let tithe_recipient = Pubkey::new_unique();
        let (config_key, bump) = Pubkey::find_program_address(&[SEED_CONFIG, mint.as_ref()], &program);
        let mut packed = [Rule::default(); 4];
        packed[..rules.len()].copy_from_slice(rules);
        let cfg = HookConfig {
            version: VERSION,
            bump,
            mint: mint.to_bytes(),
            creator: creator.to_bytes(),
            exempt: [creator.to_bytes(), ZERO_KEY, ZERO_KEY, ZERO_KEY],
            venues: [vault.to_bytes(), ZERO_KEY],
            gate_mint: ZERO_KEY,
            gate_token_program: ZERO_KEY,
            rule_count: rules.len() as u8,
            rules: packed,
            tithe_recipient: tithe_recipient.to_bytes(),
            state: ConfigState { swap_base_amount: SUPPLY * 8 / 10, ..ConfigState::default() },
        };
        let mut config = vec![0u8; HookConfig::LEN];
        cfg.pack(&mut config).unwrap();
        World { program, mint, vault, pool_authority, buyer, creator, tithe_recipient, config_key, config }
    }

    /// Accounts 0..=5 of a buy: vault -> buyer; the shape's extra entries are appended by the caller.
    fn buy_accounts(w: &World, amount: u64, buyer_balance: u64, transferring: bool) -> Vec<Acc> {
        let buyer_ata = Pubkey::new_unique();
        let (metas, _) = Pubkey::find_program_address(&[SEED_EXTRA_METAS, w.mint.as_ref()], &w.program);
        vec![
            acc(w.vault, TOKEN_2022_PROGRAM_ID, token_account(&w.mint, &w.pool_authority, SUPPLY - amount, transferring), true),
            acc(w.mint, TOKEN_2022_PROGRAM_ID, mint_data(SUPPLY), false),
            acc(buyer_ata, TOKEN_2022_PROGRAM_ID, token_account(&w.mint, &w.buyer, buyer_balance, transferring), true),
            acc(w.pool_authority, system_program::id(), Vec::new(), false),
            acc(metas, w.program, vec![0u8; tlv::Shape::CONFIG_ONLY.list_len()], false),
            acc(w.config_key, w.program, w.config.clone(), true),
        ]
    }

    /// Accounts 0..=5 of a sell: buyer -> vault.
    fn sell_accounts(w: &World, amount: u64, buyer_post: u64) -> Vec<Acc> {
        let mut a = buy_accounts(w, 0, buyer_post, true);
        a.swap(0, 2);
        a[2].data = token_account(&w.mint, &w.pool_authority, SUPPLY / 2 + amount, true);
        a[3] = acc(w.buyer, system_program::id(), Vec::new(), false);
        a
    }

    fn wallet_pdas(w: &World, src_owner: &Pubkey) -> (Pubkey, Pubkey) {
        let (src_state, _) = Pubkey::find_program_address(&[SEED_WALLET, w.mint.as_ref(), src_owner.as_ref()], &w.program);
        let (dst_state, _) = Pubkey::find_program_address(&[SEED_WALLET, w.mint.as_ref(), w.buyer.as_ref()], &w.program);
        (src_state, dst_state)
    }

    #[test]
    fn execute_runs_a_buy_and_starts_the_clock_with_the_config_only_shape() {
        let w = world(&[rule(KIND_MAX_PER_WALLET, &[200])]);
        let cap = SUPPLY / 50;
        let mut accs = buy_accounts(&w, cap, cap, true);
        {
            let infos = infos(&mut accs);
            execute_transfer(&w.program, &infos, cap, NOW, SLOT, VIA_POOL).unwrap();
        }
        let cfg = HookConfig::unpack(&accs[5].data).unwrap();
        assert_eq!((cfg.state.started_at, cfg.state.start_slot), (NOW, SLOT), "the first venue transfer starts the clock");
        assert_eq!(cfg.creator, w.creator.to_bytes(), "static fields are untouched");
        assert_eq!(cfg.state.swap_base_amount, SUPPLY * 8 / 10);
        // one token over the cap fails with the rule's code
        let mut over = buy_accounts(&w, cap + 1, cap + 1, true);
        assert_eq!(execute_transfer(&w.program, &infos(&mut over), cap + 1, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6007)));
        // dex_only reads the stack height
        let d = world(&[rule(KIND_DEX_ONLY, &[])]);
        let mut direct = buy_accounts(&d, 1_000, 1_000, true);
        assert_eq!(execute_transfer(&d.program, &infos(&mut direct), 1_000, NOW, SLOT, 2), Err(ProgramError::Custom(6019)));
        execute_transfer(&d.program, &infos(&mut direct), 1_000, NOW, SLOT, 3).unwrap();
    }

    #[test]
    fn execute_rejects_foreign_or_idle_accounts() {
        let w = world(&[rule(KIND_MAX_PER_WALLET, &[200])]);
        // not inside a transfer
        let mut idle = buy_accounts(&w, 1_000, 1_000, false);
        assert_eq!(execute_transfer(&w.program, &infos(&mut idle), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6104)));
        // a classic SPL token account
        let mut spl = buy_accounts(&w, 1_000, 1_000, true);
        spl[0].owner = Pubkey::new_unique();
        assert_eq!(execute_transfer(&w.program, &infos(&mut spl), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6103)));
        // the config of another mint (a genuine config of this program, at its own PDA)
        let other = world_in(w.program, &[rule(KIND_MAX_PER_WALLET, &[200])]);
        let mut mixed = buy_accounts(&w, 1_000, 1_000, true);
        mixed[5] = acc(other.config_key, w.program, other.config.clone(), true);
        assert_eq!(execute_transfer(&w.program, &infos(&mut mixed), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6102)));
        // a config account that is not owned by the program
        let mut stray = buy_accounts(&w, 1_000, 1_000, true);
        stray[5].owner = system_program::id();
        assert_eq!(execute_transfer(&w.program, &infos(&mut stray), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6102)));
        // too few accounts for the shape
        let mut short = buy_accounts(&w, 1_000, 1_000, true);
        short.truncate(5);
        assert_eq!(execute_transfer(&w.program, &infos(&mut short), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6103)));
        let v = world(&[rule(KIND_HOLDER_VESTING, &[0, 86_400, 86_400, 1_000, 500])]);
        let mut no_wallets = buy_accounts(&v, 1_000, 1_000, true);
        assert_eq!(execute_transfer(&v.program, &infos(&mut no_wallets), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6103)), "the vesting shape needs two more accounts");
    }

    #[test]
    fn vesting_shape_sees_registration_and_writes_the_record_back() {
        let w = world(&[rule(KIND_HOLDER_VESTING, &[0, 86_400, 86_400, 1_000, 500])]);
        let qualifying = SUPPLY / 2_000;
        let (src_state, dst_state) = wallet_pdas(&w, &w.pool_authority);
        // unregistered buyer, qualifying amount: WalletNotRegistered
        let mut accs = buy_accounts(&w, qualifying, qualifying, true);
        accs.push(empty(src_state));
        accs.push(empty(dst_state));
        assert_eq!(execute_transfer(&w.program, &infos(&mut accs), qualifying, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6100)));
        // a smaller buy needs no record
        let mut small = buy_accounts(&w, qualifying - 1, qualifying - 1, true);
        small.push(empty(src_state));
        small.push(empty(dst_state));
        execute_transfer(&w.program, &infos(&mut small), qualifying - 1, NOW, SLOT, VIA_POOL).unwrap();
        // registered buyer: the record is stamped
        let (_, bump) = Pubkey::find_program_address(&[SEED_WALLET, w.mint.as_ref(), w.buyer.as_ref()], &w.program);
        let mut record = vec![0u8; WalletState::LEN];
        WalletState::new(bump).pack(&mut record).unwrap();
        accs[7] = acc(dst_state, w.program, record, true);
        {
            let infos = infos(&mut accs);
            execute_transfer(&w.program, &infos, qualifying, NOW, SLOT, VIA_POOL).unwrap();
        }
        let state = WalletState::unpack(&accs[7].data).unwrap();
        assert_eq!((state.first_receipt_ts, state.received_total), (NOW, qualifying));
        // the buyer sells before the cliff: locked
        let mut sell = sell_accounts(&w, 1, qualifying - 1);
        let (buyer_state, pool_state) = wallet_pdas(&w, &w.buyer);
        sell.push(acc(buyer_state, w.program, accs[7].data.clone(), true));
        sell.push(empty(pool_state));
        assert_eq!(execute_transfer(&w.program, &infos(&mut sell), 1, NOW + 100, SLOT, VIA_POOL), Err(ProgramError::Custom(6003)));
        // ...and after the cliff 10% is free
        let mut later = sell_accounts(&w, qualifying / 10, qualifying - qualifying / 10);
        later.push(acc(buyer_state, w.program, accs[7].data.clone(), true));
        later.push(empty(pool_state));
        execute_transfer(&w.program, &infos(&mut later), qualifying / 10, NOW + 86_400, SLOT, VIA_POOL).unwrap();
        // a record at the wrong address is refused
        accs[7].key = Pubkey::new_unique();
        assert_eq!(execute_transfer(&w.program, &infos(&mut accs), qualifying, NOW + 60, SLOT, VIA_POOL), Err(ProgramError::Custom(6103)));
    }

    #[test]
    fn blocklist_shape_reads_the_list_or_treats_a_missing_one_as_empty() {
        let w = world(&[rule(KIND_BLOCKLIST, &[])]);
        let (block_key, bump) = Pubkey::find_program_address(&[SEED_BLOCK, w.mint.as_ref()], &w.program);
        // no list yet: nobody is blocked
        let mut open = buy_accounts(&w, 1_000, 1_000, true);
        open.push(empty(block_key));
        execute_transfer(&w.program, &infos(&mut open), 1_000, NOW, SLOT, VIA_POOL).unwrap();
        // a list naming the buyer
        let mut list = vec![0u8; BlockList::LEN];
        BlockList::init(&mut list, bump).unwrap();
        BlockList::append(&mut list, &[Pubkey::new_unique().to_bytes(), w.buyer.to_bytes()]).unwrap();
        let mut blocked = buy_accounts(&w, 1_000, 1_000, true);
        blocked.push(acc(block_key, w.program, list.clone(), false));
        assert_eq!(execute_transfer(&w.program, &infos(&mut blocked), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6017)));
        // the buyer sells: never blocked on the way out
        let mut sell = sell_accounts(&w, 1_000, 0);
        sell.push(acc(block_key, w.program, list.clone(), false));
        execute_transfer(&w.program, &infos(&mut sell), 1_000, NOW, SLOT, VIA_POOL).unwrap();
        // a list at the wrong address is a wiring error
        let mut wrong = buy_accounts(&w, 1_000, 1_000, true);
        wrong.push(acc(Pubkey::new_unique(), w.program, list, false));
        assert_eq!(execute_transfer(&w.program, &infos(&mut wrong), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6103)));
    }

    #[test]
    fn sysvar_shape_reads_the_instructions_sysvar() {
        let w = world(&[rule(KIND_TITHE, &[5_000_000])]);
        let sysvar_key = Pubkey::new_from_array(SYSVAR_INSTRUCTIONS_ID);
        let payer = [11u8; 32];
        let paid = sysvar::tests::serialize(&[sysvar::tests::transfer(payer, w.tithe_recipient.to_bytes(), 5_000_000), sysvar::tests::other([33; 32], 12)], 1);
        let short = sysvar::tests::serialize(&[sysvar::tests::transfer(payer, w.tithe_recipient.to_bytes(), 4_999_999), sysvar::tests::other([33; 32], 12)], 1);
        let mut ok = buy_accounts(&w, 1_000, 1_000, true);
        ok.push(acc(sysvar_key, Pubkey::new_unique(), paid.clone(), false));
        execute_transfer(&w.program, &infos(&mut ok), 1_000, NOW, SLOT, VIA_POOL).unwrap();
        let mut unpaid = buy_accounts(&w, 1_000, 1_000, true);
        unpaid.push(acc(sysvar_key, Pubkey::new_unique(), short, false));
        assert_eq!(execute_transfer(&w.program, &infos(&mut unpaid), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6025)));
        // the wrong account in the sysvar slot, or malformed sysvar data
        let mut wrong = buy_accounts(&w, 1_000, 1_000, true);
        wrong.push(acc(Pubkey::new_unique(), Pubkey::new_unique(), paid.clone(), false));
        assert_eq!(execute_transfer(&w.program, &infos(&mut wrong), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6109)));
        let mut malformed = buy_accounts(&w, 1_000, 1_000, true);
        malformed.push(acc(sysvar_key, Pubkey::new_unique(), vec![1, 0, 200, 0], false));
        assert_eq!(execute_transfer(&w.program, &infos(&mut malformed), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6109)));
        // the creator's own buy skips the tithe (and still needs the account to be present)
        let mut creator_buy = buy_accounts(&w, 1_000, 1_000, true);
        creator_buy[2].data = token_account(&w.mint, &w.creator, 1_000, true);
        creator_buy.push(acc(sysvar_key, Pubkey::new_unique(), vec![0, 0, 0, 0], false));
        execute_transfer(&w.program, &infos(&mut creator_buy), 1_000, NOW, SLOT, VIA_POOL).unwrap();
    }

    #[test]
    fn app_only_shape_reads_the_app_mark_out_of_the_instructions_sysvar() {
        // v71.35/v71.36: the config's packed mark decides; here kind 1, a top-level instruction of that program lets the trade through.
        let app = [42u8; 32];
        let mut params = [0u64; 6];
        for i in 0..4 {
            params[i] = u64::from_le_bytes(app[i * 8..i * 8 + 8].try_into().unwrap());
        }
        params[4] = sysvar::APP_MARK_PROGRAM as u64;
        let w = world(&[Rule { kind: KIND_FOMO_ONLY, params }, rule(KIND_MAX_PER_WALLET, &[5_000])]);
        let sysvar_key = Pubkey::new_from_array(SYSVAR_INSTRUCTIONS_ID);
        let through_app = sysvar::tests::serialize(&[sysvar::tests::other(app, 3), sysvar::tests::other([33; 32], 12)], 1);
        let through_curve = sysvar::tests::serialize(&[sysvar::tests::other([7; 32], 3), sysvar::tests::other([33; 32], 12)], 1);
        let mut ok = buy_accounts(&w, 1_000, 1_000, true);
        ok.push(acc(sysvar_key, Pubkey::new_unique(), through_app.clone(), false));
        execute_transfer(&w.program, &infos(&mut ok), 1_000, NOW, SLOT, VIA_POOL).unwrap();
        let mut refused = buy_accounts(&w, 1_000, 1_000, true);
        refused.push(acc(sysvar_key, Pubkey::new_unique(), through_curve.clone(), false));
        assert_eq!(execute_transfer(&w.program, &infos(&mut refused), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6026)));
        // a plain send between wallets never consults the app; the creator's own trade through Launchpad passes (exempt)
        let mut creator_buy = buy_accounts(&w, 1_000, 1_000, true);
        creator_buy[2].data = token_account(&w.mint, &w.creator, 1_000, true);
        creator_buy.push(acc(sysvar_key, Pubkey::new_unique(), through_curve, false));
        execute_transfer(&w.program, &infos(&mut creator_buy), 1_000, NOW, SLOT, VIA_POOL).unwrap();
        // the other rules of the set still run on a trade through the app
        let mut too_big = buy_accounts(&w, 600_000_000_000_000, 600_000_000_000_000, true);
        too_big.push(acc(sysvar_key, Pubkey::new_unique(), through_app, false));
        assert_eq!(execute_transfer(&w.program, &infos(&mut too_big), 600_000_000_000_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6007)));
    }

    #[test]
    fn app_only_signer_mark_needs_the_wallet_among_the_signers() {
        // v71.36: kind 2 — the app's co-signing wallet must sign the transaction (FOMO's model); the router does not matter.
        let cosigner = [43u8; 32];
        let mut params = [0u64; 6];
        for i in 0..4 {
            params[i] = u64::from_le_bytes(cosigner[i * 8..i * 8 + 8].try_into().unwrap());
        }
        params[4] = sysvar::APP_MARK_SIGNER as u64;
        let w = world(&[Rule { kind: KIND_FOMO_ONLY, params }]);
        let sysvar_key = Pubkey::new_from_array(SYSVAR_INSTRUCTIONS_ID);
        let mut cosigned_swap = sysvar::tests::other([33; 32], 6);
        cosigned_swap.accounts.push((3, cosigner));
        let cosigned = sysvar::tests::serialize(&[sysvar::tests::set_limit(1), cosigned_swap], 1);
        let mut ok = buy_accounts(&w, 1_000, 1_000, true);
        ok.push(acc(sysvar_key, Pubkey::new_unique(), cosigned, false));
        execute_transfer(&w.program, &infos(&mut ok), 1_000, NOW, SLOT, VIA_POOL).unwrap();
        let mut listed_swap = sysvar::tests::other([33; 32], 6);
        listed_swap.accounts.push((2, cosigner)); // present but not signing
        let listed = sysvar::tests::serialize(&[sysvar::tests::set_limit(1), listed_swap], 1);
        let mut refused = buy_accounts(&w, 1_000, 1_000, true);
        refused.push(acc(sysvar_key, Pubkey::new_unique(), listed, false));
        assert_eq!(execute_transfer(&w.program, &infos(&mut refused), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6026)));
    }

    #[test]
    fn holder_gated_shape_uses_the_shifted_gate_positions() {
        let gate_mint = Pubkey::new_unique();
        let gate_program = TOKEN_2022_PROGRAM_ID;
        let mut w = world(&[rule(KIND_TITHE, &[1]), rule(execute::KIND_HOLDER_GATED, &[1_000_000, 6])]);
        // write the gate keys into the config
        let mut cfg = HookConfig::unpack(&w.config).unwrap();
        cfg.gate_mint = gate_mint.to_bytes();
        cfg.gate_token_program = gate_program.to_bytes();
        cfg.pack(&mut w.config).unwrap();
        let sysvar_key = Pubkey::new_from_array(SYSVAR_INSTRUCTIONS_ID);
        let paid = sysvar::tests::serialize(&[sysvar::tests::transfer([11; 32], w.tithe_recipient.to_bytes(), 1)], 0);
        let (ata, _) = Pubkey::find_program_address(&[w.buyer.as_ref(), gate_program.as_ref(), gate_mint.as_ref()], &ASSOCIATED_TOKEN_PROGRAM_ID);
        let gate_account = |amount: u64| {
            let mut d = vec![0u8; TOKEN_ACCOUNT_LEN];
            d[..32].copy_from_slice(gate_mint.as_ref());
            d[32..64].copy_from_slice(w.buyer.as_ref());
            put_u64(&mut d, 64, amount);
            d[108] = 1;
            d
        };
        let with_gate = |balance: Option<u64>| {
            let mut a = buy_accounts(&w, 1_000, 1_000, true);
            a.push(acc(sysvar_key, Pubkey::new_unique(), paid.clone(), false)); // 6
            a.push(acc(ASSOCIATED_TOKEN_PROGRAM_ID, Pubkey::new_unique(), Vec::new(), false)); // 7
            a.push(acc(gate_program, Pubkey::new_unique(), Vec::new(), false)); // 8
            a.push(acc(gate_mint, gate_program, Vec::new(), false)); // 9
            a.push(match balance {
                Some(b) => acc(ata, gate_program, gate_account(b), false),
                None => empty(ata),
            }); // 10
            a
        };
        execute_transfer(&w.program, &infos(&mut with_gate(Some(1_000_000))), 1_000, NOW, SLOT, VIA_POOL).unwrap();
        assert_eq!(execute_transfer(&w.program, &infos(&mut with_gate(Some(999_999))), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6002)));
        assert_eq!(execute_transfer(&w.program, &infos(&mut with_gate(None)), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6002)), "a missing ATA holds zero");
        // the literal gate accounts must match the config
        let mut swapped = with_gate(Some(1_000_000));
        swapped[9].key = Pubkey::new_unique();
        assert_eq!(execute_transfer(&w.program, &infos(&mut swapped), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6103)));
        // a gate account of another owner is a wiring error
        let mut foreign = with_gate(Some(1_000_000));
        foreign[10].data[32..64].copy_from_slice(Pubkey::new_unique().as_ref());
        assert_eq!(execute_transfer(&w.program, &infos(&mut foreign), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6103)));
        // a client that resolved the gate entries without the sysvar slot: too few accounts, or the ATA program where the sysvar belongs
        let mut missing = with_gate(Some(1_000_000));
        missing.remove(6);
        assert_eq!(execute_transfer(&w.program, &infos(&mut missing), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6103)));
        let mut shifted = with_gate(Some(1_000_000));
        shifted[6] = acc(ASSOCIATED_TOKEN_PROGRAM_ID, Pubkey::new_unique(), Vec::new(), false);
        assert_eq!(execute_transfer(&w.program, &infos(&mut shifted), 1_000, NOW, SLOT, VIA_POOL), Err(ProgramError::Custom(6109)));
    }

    #[test]
    fn creator_only_instructions_check_the_signer_before_any_cpi() {
        let w = world(&[rule(KIND_ALLOWLIST, &[])]);
        let wallet = Pubkey::new_unique();
        let (allow_key, _) = Pubkey::find_program_address(&[SEED_ALLOW, w.mint.as_ref(), wallet.as_ref()], &w.program);
        let intruder = Pubkey::new_unique();
        let mut accs = vec![
            acc(w.config_key, w.program, w.config.clone(), false),
            acc(intruder, system_program::id(), Vec::new(), false),
            acc(intruder, system_program::id(), Vec::new(), true),
            empty(allow_key),
            acc(system_program::id(), system_program::id(), Vec::new(), false),
        ];
        accs[1].signer = true;
        accs[2].signer = true;
        assert_eq!(add_allowed(&w.program, &infos(&mut accs), &wallet.to_bytes()), Err(ProgramError::Custom(6101)));
        // the creator without a signature
        accs[1].key = w.creator;
        accs[1].signer = false;
        assert_eq!(add_allowed(&w.program, &infos(&mut accs), &wallet.to_bytes()), Err(ProgramError::Custom(6103)));
        // an existing entry is idempotent and needs no CPI
        let (_, bump) = Pubkey::find_program_address(&[SEED_ALLOW, w.mint.as_ref(), wallet.as_ref()], &w.program);
        let mut entry = vec![0u8; AllowEntry::LEN];
        AllowEntry { version: VERSION, bump, mint: w.mint.to_bytes(), wallet: wallet.to_bytes() }.pack(&mut entry).unwrap();
        accs[1].signer = true;
        accs[3] = acc(allow_key, w.program, entry, true);
        add_allowed(&w.program, &infos(&mut accs), &wallet.to_bytes()).unwrap();
        // an unknown instruction byte is rejected before touching accounts
        assert_eq!(process_instruction(&w.program, &infos(&mut accs), &[9]), Err(ProgramError::InvalidInstructionData));
        // InitializeExtraAccountMetaList: wrong authority, then an existing list
        let (metas_key, _) = Pubkey::find_program_address(&[SEED_EXTRA_METAS, w.mint.as_ref()], &w.program);
        let mut init = vec![
            acc(metas_key, w.program, vec![0u8; 51], true),
            acc(w.mint, TOKEN_2022_PROGRAM_ID, Vec::new(), false),
            acc(intruder, system_program::id(), Vec::new(), false),
            acc(system_program::id(), system_program::id(), Vec::new(), false),
            acc(w.creator, system_program::id(), Vec::new(), true),
            acc(w.config_key, w.program, w.config.clone(), false),
        ];
        init[2].signer = true;
        init[4].signer = true;
        assert_eq!(process_instruction(&w.program, &infos(&mut init), &[0]), Err(ProgramError::Custom(6101)));
        init[2].key = w.creator;
        assert_eq!(process_instruction(&w.program, &infos(&mut init), &[0]), Err(ProgramError::Custom(6106)), "the list exists");
    }

    #[test]
    fn register_wallet_is_idempotent_and_init_config_refuses_bad_or_existing_configs() {
        let w = world(&[rule(KIND_PING_PONG, &[0, 0])]);
        let wallet = Pubkey::new_unique();
        let payer = Pubkey::new_unique();
        let (state_key, bump) = Pubkey::find_program_address(&[SEED_WALLET, w.mint.as_ref(), wallet.as_ref()], &w.program);
        let mut record = vec![0u8; WalletState::LEN];
        WalletState::new(bump).pack(&mut record).unwrap();
        let mut accs = vec![
            acc(w.config_key, w.program, w.config.clone(), false),
            acc(wallet, system_program::id(), Vec::new(), false),
            acc(payer, system_program::id(), Vec::new(), true),
            acc(state_key, w.program, record, true),
            acc(system_program::id(), system_program::id(), Vec::new(), false),
        ];
        accs[2].signer = true;
        register_wallet(&w.program, &infos(&mut accs)).unwrap();
        // the wrong PDA is refused
        accs[3].key = Pubkey::new_unique();
        assert_eq!(register_wallet(&w.program, &infos(&mut accs)), Err(ProgramError::Custom(6103)));
        // InitConfig on an existing config fails before the CPI
        let args = InitConfigArgs {
            exempt: [w.creator.to_bytes(), ZERO_KEY, ZERO_KEY, ZERO_KEY],
            venues: [w.vault.to_bytes(), ZERO_KEY],
            gate_mint: ZERO_KEY,
            gate_token_program: ZERO_KEY,
            tithe_recipient: ZERO_KEY,
            swap_base_amount: 0,
            rule_count: 1,
            rules: [rule(KIND_PING_PONG, &[0, 0]), Rule::default(), Rule::default(), Rule::default()],
        };
        let mut init = vec![
            acc(w.config_key, w.program, w.config.clone(), true),
            acc(w.mint, system_program::id(), Vec::new(), false),
            acc(w.creator, system_program::id(), Vec::new(), false),
            acc(payer, system_program::id(), Vec::new(), true),
            acc(system_program::id(), system_program::id(), Vec::new(), false),
        ];
        init[2].signer = true;
        init[3].signer = true;
        assert_eq!(init_config(&w.program, &infos(&mut init), &args), Err(ProgramError::Custom(6106)));
        // a config without a venue or with an invalid rule is refused earlier still
        let mut no_venue = args;
        no_venue.venues = [ZERO_KEY, ZERO_KEY];
        assert_eq!(init_config(&w.program, &infos(&mut init), &no_venue), Err(ProgramError::Custom(6102)));
        let mut bad_rule = args;
        bad_rule.rules[0] = rule(4, &[10_001, 25]);
        assert_eq!(init_config(&w.program, &infos(&mut init), &bad_rule), Err(ProgramError::Custom(6102)));
        let mut conflict = args;
        conflict.rule_count = 2;
        conflict.rules[1] = rule(execute::KIND_P2P_ONLY, &[]);
        assert_eq!(init_config(&w.program, &infos(&mut init), &conflict), Err(ProgramError::Custom(6102)), "ping_pong / p2p_only conflict");
        let mut tithe_without_recipient = args;
        tithe_without_recipient.rules[0] = rule(KIND_TITHE, &[1_000]);
        assert_eq!(init_config(&w.program, &infos(&mut init), &tithe_without_recipient), Err(ProgramError::Custom(6102)));
        let mut sliding_without_base = args;
        sliding_without_base.rules[0] = rule(KIND_SLIDING_CAPS, &[1, 0, 100, 0, 0]);
        assert_eq!(init_config(&w.program, &infos(&mut init), &sliding_without_base), Err(ProgramError::Custom(6102)));
        let mut gated_without_gate = args;
        gated_without_gate.rules[0] = rule(KIND_HOLDER_GATED, &[1, 6]);
        assert_eq!(init_config(&w.program, &infos(&mut init), &gated_without_gate), Err(ProgramError::Custom(6102)));
        // the same, well formed, still fails only because the config exists
        let mut tithe_ok = tithe_without_recipient;
        tithe_ok.tithe_recipient = Pubkey::new_unique().to_bytes();
        assert_eq!(init_config(&w.program, &infos(&mut init), &tithe_ok), Err(ProgramError::Custom(6106)));
    }

    #[test]
    fn add_blocked_appends_dedupes_seals_and_fills() {
        let w = world(&[rule(KIND_BLOCKLIST, &[]), rule(KIND_TRADE_GUARD, &[100])]);
        let payer = Pubkey::new_unique();
        let (block_key, bump) = Pubkey::find_program_address(&[SEED_BLOCK, w.mint.as_ref()], &w.program);
        let mut list = vec![0u8; BlockList::LEN];
        BlockList::init(&mut list, bump).unwrap();
        let a = Pubkey::new_unique().to_bytes();
        let b = Pubkey::new_unique().to_bytes();
        let data = |wallets: &[[u8; 32]]| {
            let mut d = vec![5u8, wallets.len() as u8];
            for w in wallets {
                d.extend_from_slice(w);
            }
            d
        };
        let mut accs = vec![
            acc(w.config_key, w.program, w.config.clone(), false),
            acc(w.creator, system_program::id(), Vec::new(), false),
            acc(payer, system_program::id(), Vec::new(), true),
            acc(block_key, w.program, list, true),
            acc(system_program::id(), system_program::id(), Vec::new(), false),
        ];
        accs[1].signer = true;
        accs[2].signer = true;
        process_instruction(&w.program, &infos(&mut accs), &data(&[a, b, a])).unwrap();
        assert_eq!(BlockList::header(&accs[3].data).unwrap(), (bump, 2));
        process_instruction(&w.program, &infos(&mut accs), &data(&[b])).unwrap();
        assert_eq!(BlockList::header(&accs[3].data).unwrap().1, 2, "listed wallets are skipped");
        assert!(BlockList::contains(&accs[3].data, &a).unwrap() && BlockList::contains(&accs[3].data, &b).unwrap());
        // an intruder
        accs[1].key = payer;
        assert_eq!(process_instruction(&w.program, &infos(&mut accs), &data(&[a])), Err(ProgramError::Custom(6101)));
        accs[1].key = w.creator;
        // the wrong PDA
        accs[3].key = Pubkey::new_unique();
        assert_eq!(process_instruction(&w.program, &infos(&mut accs), &data(&[a])), Err(ProgramError::Custom(6103)));
        accs[3].key = block_key;
        // fill up to 200, then one more
        let mut remaining = 198;
        while remaining > 0 {
            let n = remaining.min(28);
            let batch: Vec<[u8; 32]> = (0..n).map(|_| Pubkey::new_unique().to_bytes()).collect();
            process_instruction(&w.program, &infos(&mut accs), &data(&batch)).unwrap();
            remaining -= n;
        }
        assert_eq!(BlockList::header(&accs[3].data).unwrap().1, 200);
        assert_eq!(process_instruction(&w.program, &infos(&mut accs), &data(&[Pubkey::new_unique().to_bytes()])), Err(ProgramError::Custom(6107)));
        process_instruction(&w.program, &infos(&mut accs), &data(&[a])).unwrap();
        // sealed by the first trade
        let mut started = HookConfig::unpack(&accs[0].data).unwrap();
        started.state.started_at = NOW;
        started.pack(&mut accs[0].data).unwrap();
        assert_eq!(process_instruction(&w.program, &infos(&mut accs), &data(&[a])), Err(ProgramError::Custom(6108)));
        // malformed data never reaches the handler
        assert_eq!(process_instruction(&w.program, &infos(&mut accs), &[5, 0]), Err(ProgramError::InvalidInstructionData));
        assert_eq!(process_instruction(&w.program, &infos(&mut accs), &[5, 1, 0]), Err(ProgramError::InvalidInstructionData));
    }
}
