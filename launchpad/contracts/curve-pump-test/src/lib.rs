//! Local-validator-only experiment, NOT audited or deployable production custody.
//! Default build rejects every instruction. local-test uses a PUBLIC fixture key.
#![allow(unexpected_cfgs)]
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};
solana_program::entrypoint!(entry);
#[cfg(all(feature = "local-test", feature = "owner-test"))]
compile_error!("local-test and owner-test are mutually exclusive");
#[cfg(feature = "owner-test")]
const OWNER_OPERATOR: &str = env!(
    "LAUNCHPAD_TEST_OPERATOR",
    "Set explicit owner public key to compile owner-test; do not use fixture key"
);
fn operator() -> Result<Pubkey, ProgramError> {
    #[cfg(feature = "owner-test")]
    {
        use std::str::FromStr;
        let k = Pubkey::from_str(OWNER_OPERATOR).map_err(|_| err(Error::Disabled))?;
        need(k != ADMIN, Error::Disabled)?;
        return Ok(k);
    }
    #[cfg(not(feature = "owner-test"))]
    {
        Ok(ADMIN)
    }
}
const ADMIN: Pubkey = pubkey!("CJfRUQxyonG6B5mnztsNUqxknbFT89DJdrdrzV9F96mU");
const TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN22: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const PUMP: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const GLOBAL: Pubkey = pubkey!("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
const LEN: usize = 256;
const SUPPLY: u64 = 1_000_000_000_000_000;
const MAGIC: &[u8; 8] = b"CRVPTEST";
#[repr(u32)]
#[derive(Clone, Copy, Debug)]
pub enum Error {
    Disabled = 7000,
    Accounts,
    Unauthorized,
    State,
    Math,
    Slippage,
    Phase,
    Insolvent,
    Mint,
    Cpi,
    Policy,
}
fn err(e: Error) -> ProgramError {
    ProgramError::Custom(e as u32)
}
fn need(ok: bool, e: Error) -> ProgramResult {
    if ok {
        Ok(())
    } else {
        Err(err(e))
    }
}
fn u64at(d: &[u8], p: usize) -> Result<u64, ProgramError> {
    let s = d.get(p..p + 8).ok_or(err(Error::State))?;
    Ok(u64::from_le_bytes(s.try_into().unwrap()))
}
fn keyat(d: &[u8], p: usize) -> Result<Pubkey, ProgramError> {
    Ok(Pubkey::new_from_array(
        d.get(p..p + 32)
            .ok_or(err(Error::State))?
            .try_into()
            .unwrap(),
    ))
}
fn add(a: u64, b: u64) -> Result<u64, ProgramError> {
    a.checked_add(b).ok_or(err(Error::Math))
}
fn sub(a: u64, b: u64) -> Result<u64, ProgramError> {
    a.checked_sub(b).ok_or(err(Error::Math))
}
fn md(a: u64, b: u64, d: u64, ceil: bool) -> Result<u64, ProgramError> {
    need(d > 0, Error::Math)?;
    let n = (a as u128).checked_mul(b as u128).ok_or(err(Error::Math))?;
    let x = if ceil {
        n.checked_add(d as u128 - 1).ok_or(err(Error::Math))? / d as u128
    } else {
        n / d as u128
    };
    u64::try_from(x).map_err(|_| err(Error::Math))
}
#[derive(Clone, Debug)]
struct State {
    phase: u8,
    bump: u8,
    admin: Pubkey,
    treasury: Pubkey,
    mint: Pubkey,
    vb: u64,
    vq: u64,
    cap: u64,
    sold: u64,
    quote: u64,
    rent_floor: u64,
    grad: u64,
    trade: u64,
    initial_vb: u64,
    initial_vq: u64,
}
impl State {
    fn load(a: &AccountInfo, p: &Pubkey) -> Result<Self, ProgramError> {
        need(a.owner == p, Error::State)?;
        let d = a.try_borrow_data()?;
        need(d.len() == LEN && &d[..8] == MAGIC, Error::State)?;
        Ok(Self {
            phase: d[8],
            bump: d[9],
            admin: keyat(&d, 16)?,
            treasury: keyat(&d, 48)?,
            mint: keyat(&d, 80)?,
            vb: u64at(&d, 112)?,
            vq: u64at(&d, 120)?,
            cap: u64at(&d, 128)?,
            sold: u64at(&d, 136)?,
            quote: u64at(&d, 144)?,
            rent_floor: u64at(&d, 152)?,
            grad: u64at(&d, 160)?,
            trade: u64at(&d, 168)?,
            initial_vb: u64at(&d, 176)?,
            initial_vq: u64at(&d, 184)?,
        })
    }
    fn save(&self, a: &AccountInfo) -> ProgramResult {
        let mut d = a.try_borrow_mut_data()?;
        need(d.len() == LEN, Error::State)?;
        d.fill(0);
        d[..8].copy_from_slice(MAGIC);
        d[8] = self.phase;
        d[9] = self.bump;
        for (p, k) in [(16, self.admin), (48, self.treasury), (80, self.mint)] {
            d[p..p + 32].copy_from_slice(k.as_ref());
        }
        for (i, v) in [
            self.vb,
            self.vq,
            self.cap,
            self.sold,
            self.quote,
            self.rent_floor,
            self.grad,
            self.trade,
            self.initial_vb,
            self.initial_vq,
        ]
        .iter()
        .enumerate()
        {
            let p = 112 + i * 8;
            d[p..p + 8].copy_from_slice(&v.to_le_bytes());
        }
        Ok(())
    }
}
fn entry(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    if !cfg!(any(feature = "local-test", feature = "owner-test")) {
        return Err(err(Error::Disabled));
    }
    // Test key seed is public (99 repeated 32 times); never deploy this feature.
    need(
        !a.is_empty() && a[0].is_signer && *a[0].key == operator()?,
        Error::Unauthorized,
    )?;
    match d.first() {
        Some(0) => init(p, a, &d[1..]),
        Some(1) => trade(p, a, &d[1..], true),
        Some(2) => trade(p, a, &d[1..], false),
        Some(3) => migrate(p, a, &d[1..]),
        _ => Err(err(Error::State)),
    }
}
fn unique(a: &[AccountInfo]) -> ProgramResult {
    for (i, x) in a.iter().enumerate() {
        for y in &a[i + 1..] {
            need(x.key != y.key, Error::Accounts)?;
        }
    }
    Ok(())
}
fn program(a: &AccountInfo, k: &Pubkey) -> ProgramResult {
    need(a.key == k && a.executable, Error::Accounts)
}
fn system_wallet(a: &AccountInfo) -> ProgramResult {
    need(
        a.owner == &system_program::id() && a.data_is_empty(),
        Error::Accounts,
    )
}
fn ata(owner: &Pubkey, mint: &Pubkey, token: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token.as_ref(), mint.as_ref()], &ATA).0
}
fn token_account(
    a: &AccountInfo,
    mint: &Pubkey,
    owner: &Pubkey,
    token: &Pubkey,
) -> Result<u64, ProgramError> {
    need(a.owner == token, Error::Mint)?;
    let d = a.try_borrow_data()?;
    need(
        d.len() >= 165 && keyat(&d, 0)? == *mint && keyat(&d, 32)? == *owner && d[108] == 1,
        Error::Mint,
    )?;
    need(d[72..76] == [0; 4] && d[129..133] == [0; 4], Error::Mint)?;
    u64at(&d, 64)
}
fn mint(a: &AccountInfo, authority: Option<&Pubkey>, supply: u64) -> ProgramResult {
    need(a.owner == &TOKEN, Error::Mint)?;
    let d = a.try_borrow_data()?;
    need(
        d.len() == 82
            && d[44] == 6
            && d[45] == 1
            && d[46..50] == [0; 4]
            && u64at(&d, 36)? == supply,
        Error::Mint,
    )?;
    match authority {
        Some(k) => need(d[..4] == [1, 0, 0, 0] && keyat(&d, 4)? == *k, Error::Mint),
        None => need(d[..4] == [0; 4], Error::Mint),
    }
}
fn xfer_sol<'a>(
    from: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    sys: &AccountInfo<'a>,
    amount: u64,
    seeds: &[&[u8]],
) -> ProgramResult {
    if amount == 0 {
        return Ok(());
    }
    let ix = system_instruction::transfer(from.key, to.key, amount);
    if seeds.is_empty() {
        invoke(&ix, &[from.clone(), to.clone(), sys.clone()])
    } else {
        invoke_signed(&ix, &[from.clone(), to.clone(), sys.clone()], &[seeds])
    }
}
fn token_ix<'a>(
    t: &AccountInfo<'a>,
    code: u8,
    amount: u64,
    accounts: &[AccountInfo<'a>],
    seeds: &[&[u8]],
) -> ProgramResult {
    let mut d = vec![code];
    d.extend_from_slice(&amount.to_le_bytes());
    let metas = accounts
        .iter()
        .enumerate()
        .map(|(i, a)| {
            if i == accounts.len() - 1 {
                AccountMeta::new_readonly(*a.key, true)
            } else {
                AccountMeta::new(*a.key, false)
            }
        })
        .collect();
    let ix = Instruction {
        program_id: *t.key,
        accounts: metas,
        data: d,
    };
    let mut ai = accounts.to_vec();
    ai.push(t.clone());
    if seeds.is_empty() {
        invoke(&ix, &ai)
    } else {
        invoke_signed(&ix, &ai, &[seeds])
    }
}
fn create_ata<'a>(
    payer: &AccountInfo<'a>,
    account: &AccountInfo<'a>,
    owner: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    sys: &AccountInfo<'a>,
    tok: &AccountInfo<'a>,
    associated: &AccountInfo<'a>,
    seeds: &[&[u8]],
) -> ProgramResult {
    need(
        *account.key == ata(owner.key, mint.key, tok.key),
        Error::Accounts,
    )?;
    let ix = Instruction {
        program_id: ATA,
        accounts: vec![
            AccountMeta::new(*payer.key, true),
            AccountMeta::new(*account.key, false),
            AccountMeta::new_readonly(*owner.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new_readonly(*sys.key, false),
            AccountMeta::new_readonly(*tok.key, false),
        ],
        data: vec![1],
    };
    let ai = [
        payer.clone(),
        account.clone(),
        owner.clone(),
        mint.clone(),
        sys.clone(),
        tok.clone(),
        associated.clone(),
    ];
    if seeds.is_empty() {
        invoke(&ix, &ai)
    } else {
        invoke_signed(&ix, &ai, &[seeds])
    }
}
// Init accounts: operator,state,authority,mint,baseATA,treasury,system,classicToken,ATA.
// Args: virtualBase,virtualQuote,soldCap,migrationRentBudget,graduationBps,tradeBps (u64 LE).
fn init(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    need(a.len() == 9 && d.len() == 48, Error::Accounts)?;
    unique(a)?;
    let [admin, state, auth, base, base_ata, treasury, sys, tok, associated] =
        <&[AccountInfo; 9]>::try_from(a).unwrap();
    program(sys, &system_program::id())?;
    program(tok, &TOKEN)?;
    program(associated, &ATA)?;
    system_wallet(admin)?;
    system_wallet(auth)?;
    system_wallet(treasury)?;
    let (sk, sb) = Pubkey::find_program_address(&[b"curve", base.key.as_ref()], p);
    let (ak, ab) = Pubkey::find_program_address(&[b"vault", base.key.as_ref()], p);
    need(*state.key == sk && *auth.key == ak, Error::Accounts)?;
    need(
        state.owner == &system_program::id() && state.data_is_empty(),
        Error::State,
    )?;
    let (vb, vq, cap, budget, grad, trade) = (
        u64at(d, 0)?,
        u64at(d, 8)?,
        u64at(d, 16)?,
        u64at(d, 24)?,
        u64at(d, 32)?,
        u64at(d, 40)?,
    );
    if cfg!(feature = "owner-test") {
        need(
            grad == 2885
                && trade == 100
                && vb == 1_372_346_627_033_820
                && cap == 758_614_557_685_785
                && budget <= 100_000_000,
            Error::Policy,
        )?;
        need(
            md(vq, cap, sub(vb, cap)?, true)? <= 3_000_000_000,
            Error::Policy,
        )?;
    }
    need(
        vb > SUPPLY
            && vq > 0
            && cap > 0
            && cap < SUPPLY
            && grad <= 3000
            && trade <= 300
            && budget >= 20_000_000
            && budget <= 1_000_000_000,
        Error::Policy,
    )?;
    mint(base, Some(auth.key), 0)?;
    let rent = Rent::get()?;
    let state_rent = rent.minimum_balance(LEN);
    xfer_sol(
        admin,
        state,
        sys,
        state_rent.saturating_sub(state.lamports()),
        &[],
    )?;
    let ss: &[&[u8]] = &[b"curve", base.key.as_ref(), &[sb]];
    invoke_signed(
        &system_instruction::allocate(state.key, LEN as u64),
        &[state.clone(), sys.clone()],
        &[ss],
    )?;
    invoke_signed(
        &system_instruction::assign(state.key, p),
        &[state.clone(), sys.clone()],
        &[ss],
    )?;
    // Native SOL rent subsidy is independent of curve principal. No withdrawal method exists.
    let floor = rent.minimum_balance(0);
    xfer_sol(admin, auth, sys, add(budget, floor)?, &[])?;
    create_ata(admin, base_ata, auth, base, sys, tok, associated, &[])?;
    need(
        token_account(base_ata, base.key, auth.key, &TOKEN)? == 0,
        Error::Mint,
    )?;
    let asd: &[&[u8]] = &[b"vault", base.key.as_ref(), &[ab]];
    token_ix(
        tok,
        7,
        SUPPLY,
        &[base.clone(), base_ata.clone(), auth.clone()],
        asd,
    )?;
    let revoke = Instruction {
        program_id: TOKEN,
        accounts: vec![
            AccountMeta::new(*base.key, false),
            AccountMeta::new_readonly(*auth.key, true),
        ],
        data: vec![6, 0, 0],
    };
    invoke_signed(&revoke, &[base.clone(), auth.clone(), tok.clone()], &[asd])?;
    mint(base, None, SUPPLY)?;
    State {
        phase: 0,
        bump: ab,
        admin: *admin.key,
        treasury: *treasury.key,
        mint: *base.key,
        vb,
        vq,
        cap,
        sold: 0,
        quote: 0,
        rent_floor: floor,
        grad,
        trade,
        initial_vb: vb,
        initial_vq: vq,
    }
    .save(state)
}
fn common(p: &Pubkey, a: &[AccountInfo]) -> Result<State, ProgramError> {
    let s = State::load(&a[1], p)?;
    need(
        *a[0].key == s.admin && a[0].is_signer && *a[3].key == s.mint,
        Error::Unauthorized,
    )?;
    need(
        Pubkey::find_program_address(&[b"curve", s.mint.as_ref()], p).0 == *a[1].key,
        Error::Accounts,
    )?;
    let (k, b) = Pubkey::find_program_address(&[b"vault", s.mint.as_ref()], p);
    need(k == *a[2].key && b == s.bump, Error::Accounts)?;
    system_wallet(&a[2])?;
    need(*a[4].key == ata(a[2].key, &s.mint, &TOKEN), Error::Accounts)?;
    let actual_supply = {
        let md = a[3].try_borrow_data()?;
        u64at(&md, 36)?
    };
    need(actual_supply <= SUPPLY, Error::Mint)?;
    mint(&a[3], None, actual_supply)?;
    need(
        token_account(&a[4], &s.mint, a[2].key, &TOKEN)? >= sub(SUPPLY, s.sold)?,
        Error::Insolvent,
    )?;
    need(
        a[2].lamports() >= add(s.quote, s.rent_floor)?,
        Error::Insolvent,
    )?;
    Ok(s)
}
// Trade accounts: operator,state,authority,mint,baseATA,operatorATA,treasury,system,classicToken.
// Args: exact input (max lamports for buy / token atoms for sell), minimum output (u64 LE).
fn trade(p: &Pubkey, a: &[AccountInfo], d: &[u8], buy: bool) -> ProgramResult {
    need(a.len() == 9 && d.len() == 16, Error::Accounts)?;
    unique(a)?;
    let mut s = common(p, a)?;
    need(s.phase == 0 || (!buy && s.phase == 1), Error::Phase)?;
    let [admin, state, auth, base, base_ata, user_ata, treasury, sys, tok] =
        <&[AccountInfo; 9]>::try_from(a).unwrap();
    program(sys, &system_program::id())?;
    program(tok, &TOKEN)?;
    need(*treasury.key == s.treasury, Error::Accounts)?;
    system_wallet(treasury)?;
    token_account(user_ata, base.key, admin.key, &TOKEN)?;
    let input = u64at(d, 0)?;
    let min = u64at(d, 8)?;
    need(input > 0 && min > 0, Error::Slippage)?;
    let seeds: &[&[u8]] = &[b"vault", base.key.as_ref(), &[s.bump]];
    if buy {
        let maxnet = md(input, 10000 - s.trade, 10000, false)?;
        let wanted = md(s.vb, maxnet, add(s.vq, maxnet)?, false)?;
        let remaining = sub(s.cap, s.sold)?;
        let output = wanted.min(remaining);
        need(output > 0 && output >= min, Error::Slippage)?;
        // Charge only the quote required for actual output, rounding toward the reserve.
        let net = md(s.vq, output, sub(s.vb, output)?, true)?;
        let gross = md(net, 10000, 10000 - s.trade, true)?;
        need(gross <= input, Error::Slippage)?;
        let fee = sub(gross, net)?;
        xfer_sol(admin, auth, sys, gross, &[])?;
        xfer_sol(auth, treasury, sys, fee, seeds)?;
        token_ix(
            tok,
            3,
            output,
            &[base_ata.clone(), user_ata.clone(), auth.clone()],
            seeds,
        )?;
        s.vb = sub(s.vb, output)?;
        s.vq = add(s.vq, net)?;
        s.quote = add(s.quote, net)?;
        if cfg!(feature = "owner-test") {
            need(s.quote <= 3_000_000_000, Error::Policy)?;
        }
        s.sold = add(s.sold, output)?;
        if s.sold == s.cap {
            s.phase = 1;
        }
    } else {
        need(input <= s.sold, Error::Insolvent)?;
        let gross = md(s.vq, input, add(s.vb, input)?, false)?;
        need(gross <= s.quote, Error::Insolvent)?;
        let fee = md(gross, s.trade, 10000, true)?;
        let output = sub(gross, fee)?;
        need(output > 0 && output >= min, Error::Slippage)?;
        token_ix(
            tok,
            3,
            input,
            &[user_ata.clone(), base_ata.clone(), admin.clone()],
            &[],
        )?;
        xfer_sol(auth, admin, sys, output, seeds)?;
        xfer_sol(auth, treasury, sys, fee, seeds)?;
        s.vb = add(s.vb, input)?;
        s.vq = sub(s.vq, gross)?;
        s.quote = sub(s.quote, gross)?;
        s.sold = sub(s.sold, input)?;
        s.phase = 0;
    }
    need(
        auth.lamports() >= add(s.quote, s.rent_floor)?,
        Error::Insolvent,
    )?;
    s.save(state)
}
// Migration accounts: operator,state,authority,baseMint,baseATA,treasury,
// PumpGlobal,pool,WSOLMint,lpMint,authorityWSOL,authorityLP,poolBase,poolQuote,
// system,classicToken,token2022,ATA,eventAuthority,PumpProgram. Args: u16 pool index.
// Failed attempts may choose another canonical pool index; economics never change.
fn migrate(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    need(a.len() == 20 && d.len() == 2, Error::Accounts)?;
    unique(a)?;
    let mut s = State::load(&a[1], p)?;
    need(*a[0].key == s.admin && a[0].is_signer, Error::Unauthorized)?;
    let [admin, state, auth, base, base_ata, treasury, global, pool, wsol, lp_mint, quote_ata, lp_ata, pool_base, pool_quote, sys, tok, tok22, associated, event, pump] =
        <&[AccountInfo; 20]>::try_from(a).unwrap();
    program(sys, &system_program::id())?;
    program(tok, &TOKEN)?;
    program(tok22, &TOKEN22)?;
    program(associated, &ATA)?;
    program(pump, &PUMP)?;
    need(
        *treasury.key == s.treasury
            && *global.key == GLOBAL
            && global.owner == &PUMP
            && *wsol.key == WSOL
            && wsol.owner == &TOKEN,
        Error::Accounts,
    )?;
    system_wallet(treasury)?;
    let index: [u8; 2] = d.try_into().unwrap();
    let expected_pool = Pubkey::find_program_address(
        &[
            b"pool",
            &index,
            auth.key.as_ref(),
            base.key.as_ref(),
            wsol.key.as_ref(),
        ],
        &PUMP,
    )
    .0;
    need(
        *pool.key == expected_pool
            && *lp_mint.key
                == Pubkey::find_program_address(&[b"pool_lp_mint", pool.key.as_ref()], &PUMP).0
            && *event.key == Pubkey::find_program_address(&[b"__event_authority"], &PUMP).0,
        Error::Accounts,
    )?;
    need(
        *lp_ata.key == ata(auth.key, lp_mint.key, &TOKEN22)
            && *quote_ata.key == ata(auth.key, wsol.key, &TOKEN)
            && *pool_base.key == ata(pool.key, base.key, &TOKEN)
            && *pool_quote.key == ata(pool.key, wsol.key, &TOKEN),
        Error::Accounts,
    )?;
    need(
        Pubkey::find_program_address(&[b"curve", s.mint.as_ref()], p).0 == *state.key
            && Pubkey::find_program_address(&[b"vault", s.mint.as_ref()], p).0 == *auth.key
            && *base.key == s.mint,
        Error::Accounts,
    )?;
    if s.phase == 2 {
        let saved = state.try_borrow_data()?;
        need(
            pool.owner == &PUMP && keyat(&saved, 208)? == *pool.key && u64at(&saved, 192)? > 0,
            Error::State,
        )?;
        return Ok(());
    }
    s = common(p, a)?;
    need(s.phase == 1 && s.sold == s.cap && s.quote > 0, Error::Phase)?;
    need(
        pool.owner == &system_program::id()
            && pool.data_is_empty()
            && lp_mint.data_is_empty()
            && lp_ata.data_is_empty(),
        Error::State,
    )?;
    let seeds: &[&[u8]] = &[b"vault", base.key.as_ref(), &[s.bump]];
    let fee = md(s.quote, s.grad, 10000, true)?;
    let quote = sub(s.quote, fee)?;
    let tokens = sub(SUPPLY, s.sold)?;
    need(quote > 0 && tokens > 0, Error::Policy)?;
    create_ata(auth, quote_ata, auth, wsol, sys, tok, associated, seeds)?;
    create_ata(auth, pool_base, pool, base, sys, tok, associated, seeds)?;
    create_ata(auth, pool_quote, pool, wsol, sys, tok, associated, seeds)?;
    // Vault donations must never replace the accounted curve amounts. Pool reserve
    // donations are a documented migration liveness issue: fail closed, never shift price.
    need(
        token_account(pool_base, base.key, pool.key, &TOKEN)? == 0
            && token_account(pool_quote, wsol.key, pool.key, &TOKEN)? == 0,
        Error::Policy,
    )?;
    let quote_before = token_account(quote_ata, wsol.key, auth.key, &TOKEN)?;
    let base_before = token_account(base_ata, base.key, auth.key, &TOKEN)?;
    xfer_sol(auth, quote_ata, sys, quote, seeds)?;
    invoke(
        &Instruction {
            program_id: TOKEN,
            accounts: vec![AccountMeta::new(*quote_ata.key, false)],
            data: vec![17],
        },
        &[quote_ata.clone(), tok.clone()],
    )?;
    let mut data = vec![233, 146, 209, 142, 207, 104, 64, 188];
    data.extend_from_slice(&index);
    data.extend_from_slice(&tokens.to_le_bytes());
    data.extend_from_slice(&quote.to_le_bytes());
    data.extend_from_slice(&[0; 32]);
    data.extend_from_slice(&[0, 0]);
    data.extend_from_slice(&0u64.to_le_bytes());
    data.push(0);
    let ai = vec![
        pool.clone(),
        global.clone(),
        auth.clone(),
        base.clone(),
        wsol.clone(),
        lp_mint.clone(),
        base_ata.clone(),
        quote_ata.clone(),
        lp_ata.clone(),
        pool_base.clone(),
        pool_quote.clone(),
        sys.clone(),
        tok22.clone(),
        tok.clone(),
        tok.clone(),
        associated.clone(),
        event.clone(),
        pump.clone(),
    ];
    let metas = ai
        .iter()
        .enumerate()
        .map(|(i, x)| {
            let writable = [0, 2, 5, 6, 7, 8, 9, 10].contains(&i);
            if writable {
                AccountMeta::new(*x.key, i == 2)
            } else {
                AccountMeta::new_readonly(*x.key, i == 2)
            }
        })
        .collect();
    invoke_signed(
        &Instruction {
            program_id: PUMP,
            accounts: metas,
            data,
        },
        &ai,
        &[seeds],
    )?;
    need(pool.owner == &PUMP && lp_mint.owner == &TOKEN22, Error::Cpi)?;
    need(
        token_account(base_ata, base.key, auth.key, &TOKEN)? == sub(base_before, tokens)?
            && token_account(quote_ata, wsol.key, auth.key, &TOKEN)? == quote_before,
        Error::Cpi,
    )?;
    need(
        token_account(pool_base, base.key, pool.key, &TOKEN)? == tokens
            && token_account(pool_quote, wsol.key, pool.key, &TOKEN)? == quote,
        Error::Cpi,
    )?;
    let received = token_account(lp_ata, lp_mint.key, auth.key, &TOKEN22)?;
    // Pump initializes with sqrt(base * quote) LP atoms, withholding minimum liquidity.
    // A fixed program-computed bound prevents caller-chosen zero min-LP protection.
    let minimum = isqrt(
        (tokens as u128)
            .checked_mul(quote as u128)
            .ok_or(err(Error::Math))?,
    );
    need(minimum > 1000 && received >= minimum - 1000, Error::Cpi)?;
    let lp_supply_before = {
        let ld = lp_mint.try_borrow_data()?;
        u64at(&ld, 36)?
    };
    token_ix(
        tok22,
        8,
        received,
        &[lp_ata.clone(), lp_mint.clone(), auth.clone()],
        seeds,
    )?;
    let lp_supply_after = {
        let ld = lp_mint.try_borrow_data()?;
        u64at(&ld, 36)?
    };
    need(
        token_account(lp_ata, lp_mint.key, auth.key, &TOKEN22)? == 0
            && sub(lp_supply_before, lp_supply_after)? == received,
        Error::Cpi,
    )?;
    xfer_sol(auth, treasury, sys, fee, seeds)?;
    need(auth.lamports() >= s.rent_floor, Error::Insolvent)?;
    s.quote = 0;
    s.phase = 2;
    s.save(state)?;
    let mut sd = state.try_borrow_mut_data()?;
    sd[192..200].copy_from_slice(&received.to_le_bytes());
    sd[200..208].copy_from_slice(&fee.to_le_bytes());
    sd[208..240].copy_from_slice(pool.key.as_ref());
    sd[240..242].copy_from_slice(&index);
    let _ = admin;
    Ok(())
}
fn isqrt(n: u128) -> u64 {
    if n < 2 {
        return n as u64;
    }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x as u64
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn directional_math() {
        assert_eq!(md(10, 11, 3, false).unwrap(), 36);
        assert_eq!(md(10, 11, 3, true).unwrap(), 37);
        assert_eq!(isqrt(99), 9);
        assert_eq!(isqrt(100), 10);
        assert!(md(u64::MAX, u64::MAX, 1, false).is_err());
    }
    #[test]
    fn no_feature_default() {
        if !cfg!(any(feature = "local-test", feature = "owner-test")) {
            assert_eq!(
                entry(&Pubkey::new_unique(), &[], &[0]),
                Err(err(Error::Disabled))
            );
        }
    }
}
