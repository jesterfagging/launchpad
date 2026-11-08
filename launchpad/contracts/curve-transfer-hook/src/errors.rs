//! Error codes of the Launchpad transfer hook program.
//!
//! Every rule has its own code (6000 + rule kind, 6001–6027) so a failed swap
//! can be explained to the trader by number alone; the structural codes start
//! at 6100. `src/hooks/program.mjs` (`HOOK_ERRORS`) mirrors this table and
//! `test/hook-program.test.mjs` reads this file to assert that both lists carry
//! the same codes, names and texts. The rule texts are the catalogue's `rule`
//! sentences (`public/hook-catalog.mjs`), verbatim.
//!
//! This module depends on nothing but core so the rule engine can be unit
//! tested on a plain host toolchain.

#[repr(u32)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookError {
    /// Rule 1 (allowlist): Only wallets you approve can receive the coin.
    Allowlist = 6001,
    /// Rule 2 (holder_gated): Only wallets holding another token can receive the coin.
    HolderGated = 6002,
    /// Rule 3 (holder_vesting): Each wallet’s tokens unlock on their own clock from the moment it buys.
    HolderVesting = 6003,
    /// Rule 4 (anti_dump): A loose buy cap and a tight sell cap, each a share of the supply.
    AntiDump = 6004,
    /// Rule 5 (sliding_caps): The max per buy and max per sell change as the curve fills.
    SlidingCaps = 6005,
    /// Rule 6 (graduated_sell_caps): Small holders sell freely; the bigger a wallet’s bag, the smaller its per-sell cap.
    GraduatedSellCaps = 6006,
    /// Rule 7 (max_per_wallet): No wallet can hold more than a share of the supply.
    MaxPerWallet = 6007,
    /// Rule 8 (rising_max_per_wallet): Every wallet’s max holding starts small and rises for everyone on a timer you set.
    RisingMaxPerWallet = 6008,
    /// Rule 9 (chapters): A max per wallet that grows with the coin: it doubles every chapter of volume.
    Chapters = 6009,
    /// Rule 10 (trade_guard): Every buy, sell and transfer is capped at the same share of supply.
    TradeGuard = 6010,
    /// Rule 11 (anti_bundle): Only a few trades per block.
    AntiBundle = 6011,
    /// Rule 12 (venue_locked): Trades only through its Meteora pool; a plain wallet-to-wallet transfer is refused.
    VenueLocked = 6012,
    /// Rule 13 (market_hours): Trades like a stock: Monday to Friday, 9:30am to 4:00pm New York time.
    MarketHours = 6013,
    /// Rule 14 (ping_pong): Buys and sells take turns: after a buy the next trade must be a sell.
    PingPong = 6014,
    /// Rule 15 (breathing_cap): The buy cap rises and falls on the clock, forever.
    BreathingCap = 6015,
    /// Rule 16 (momentum): Buying gives the market energy, which widens the buy cap; quiet markets tighten it.
    Momentum = 6016,
    /// Rule 17 (blocklist): Up to 200 wallets you name can never receive the coin.
    Blocklist = 6017,
    /// Rule 18 (hot_potato): Whoever bought last holds the hot potato: they can’t sell or send.
    HotPotato = 6018,
    /// Rule 19 (dex_only): Moves only when a program moves it, like a swap; a plain wallet-to-wallet send is refused.
    DexOnly = 6019,
    /// Rule 20 (p2p_only): It moves only wallet to wallet; nobody can buy or sell it on a market.
    P2pOnly = 6020,
    /// Rule 21 (sniper_fee_cap): For a launch window, buys that pay a big priority fee or Jito tip are refused.
    SniperFeeCap = 6021,
    /// Rule 22 (trading_hours): You set the trading week: which days it trades and the hours on each, in your time zone.
    TradingHours = 6022,
    /// Rule 23 (resonance): Momentum tuned for rhythm: buys that land in step pile energy on.
    Resonance = 6023,
    /// Rule 24 (coupled_resonator): Two oscillators inside one coin: buys energise the first, which sets the cap; the second stores energy and feeds it back.
    CoupledResonator = 6024,
    /// Rule 25 (tithe): Every trade donates to a cause you choose.
    Tithe = 6025,
    /// Rule 26 (fomo_only): While on the curve, the coin trades only through the FOMO app.
    FomoOnly = 6026,
    /// Rule 27 (pump_app_only): While on the curve, the coin trades only through the Pump App.
    PumpAppOnly = 6027,
    /// A rule needs a WalletState that does not exist (call RegisterWallet).
    WalletNotRegistered = 6100,
    /// The signer is not the creator recorded in the HookConfig.
    NotAllowed = 6101,
    /// The HookConfig is missing, malformed, for another mint, or its rules are invalid.
    ConfigMismatch = 6102,
    /// An account has the wrong owner, address, size or writability.
    BadAccounts = 6103,
    /// Execute was invoked outside a Token-2022 transfer (transferring flag unset).
    NotTransferring = 6104,
    /// Checked arithmetic overflowed (never for genuine token amounts).
    Overflow = 6105,
    /// The account to create already exists (InitConfig, InitializeExtraAccountMetaList).
    AlreadyInitialized = 6106,
    /// AddBlocked would take the blocklist past 200 wallets.
    BlocklistFull = 6107,
    /// AddBlocked after the first trade: the blocklist is sealed.
    LaunchStarted = 6108,
    /// The instructions sysvar account is missing, not the sysvar, or malformed.
    BadSysvar = 6109,
}

impl HookError {
    pub const fn code(self) -> u32 {
        self as u32
    }

    /// The error a rule of `kind` (1..=27) fails with.
    pub const fn for_rule(kind: u8) -> Option<HookError> {
        Some(match kind {
            1 => HookError::Allowlist,
            2 => HookError::HolderGated,
            3 => HookError::HolderVesting,
            4 => HookError::AntiDump,
            5 => HookError::SlidingCaps,
            6 => HookError::GraduatedSellCaps,
            7 => HookError::MaxPerWallet,
            8 => HookError::RisingMaxPerWallet,
            9 => HookError::Chapters,
            10 => HookError::TradeGuard,
            11 => HookError::AntiBundle,
            12 => HookError::VenueLocked,
            13 => HookError::MarketHours,
            14 => HookError::PingPong,
            15 => HookError::BreathingCap,
            16 => HookError::Momentum,
            17 => HookError::Blocklist,
            18 => HookError::HotPotato,
            19 => HookError::DexOnly,
            20 => HookError::P2pOnly,
            21 => HookError::SniperFeeCap,
            22 => HookError::TradingHours,
            23 => HookError::Resonance,
            24 => HookError::CoupledResonator,
            25 => HookError::Tithe,
            26 => HookError::FomoOnly,
            27 => HookError::PumpAppOnly,
            _ => return None,
        })
    }

    pub const fn name(self) -> &'static str {
        match self {
            HookError::Allowlist => "Allowlist",
            HookError::HolderGated => "HolderGated",
            HookError::HolderVesting => "HolderVesting",
            HookError::AntiDump => "AntiDump",
            HookError::SlidingCaps => "SlidingCaps",
            HookError::GraduatedSellCaps => "GraduatedSellCaps",
            HookError::MaxPerWallet => "MaxPerWallet",
            HookError::RisingMaxPerWallet => "RisingMaxPerWallet",
            HookError::Chapters => "Chapters",
            HookError::TradeGuard => "TradeGuard",
            HookError::AntiBundle => "AntiBundle",
            HookError::VenueLocked => "VenueLocked",
            HookError::MarketHours => "MarketHours",
            HookError::PingPong => "PingPong",
            HookError::BreathingCap => "BreathingCap",
            HookError::Momentum => "Momentum",
            HookError::Blocklist => "Blocklist",
            HookError::HotPotato => "HotPotato",
            HookError::DexOnly => "DexOnly",
            HookError::P2pOnly => "P2pOnly",
            HookError::SniperFeeCap => "SniperFeeCap",
            HookError::TradingHours => "TradingHours",
            HookError::Resonance => "Resonance",
            HookError::CoupledResonator => "CoupledResonator",
            HookError::Tithe => "Tithe",
            HookError::FomoOnly => "FomoOnly",
            HookError::PumpAppOnly => "PumpAppOnly",
            HookError::WalletNotRegistered => "WalletNotRegistered",
            HookError::NotAllowed => "NotAllowed",
            HookError::ConfigMismatch => "ConfigMismatch",
            HookError::BadAccounts => "BadAccounts",
            HookError::NotTransferring => "NotTransferring",
            HookError::Overflow => "Overflow",
            HookError::AlreadyInitialized => "AlreadyInitialized",
            HookError::BlocklistFull => "BlocklistFull",
            HookError::LaunchStarted => "LaunchStarted",
            HookError::BadSysvar => "BadSysvar",
        }
    }

    /// The sentence shown to a trader: for a rule, the catalogue's `rule` text
    /// (`public/hook-catalog.mjs`), verbatim; `HOOK_ERRORS` in the JS module carries the same text.
    pub const fn message(self) -> &'static str {
        match self {
            HookError::Allowlist => "A transfer to a wallet that is not on the allowlist fails. The creator adds and removes wallets after launch; the pool and the creator are always allowed.",
            HookError::HolderGated => "A transfer fails unless the receiving wallet holds at least the set amount of the gate token at that moment; checked on every buy and transfer.",
            HookError::HolderVesting => "A wallet’s qualifying receipts are locked; after the cliff a share unlocks every period until all of it is free. Tokens received after the early-buyer window are not locked. The wallet needs a small on-chain record, which Launchpad creates with the first trade.",
            HookError::AntiDump => "The hook tells buys from sells and caps each side separately: no single buy above the buy cap, no single sell or send above the sell cap.",
            HookError::SlidingCaps => "Per-buy and per-sell caps are set per level; the level steps up each time the curve passes a breakpoint of its progress to graduation (SOL raised against the graduation amount).",
            HookError::GraduatedSellCaps => "The share of supply a wallet may sell in one transfer slides from the small-holder cap down to the big-bag cap as its balance grows to the bag size; above the bag size the big-bag cap applies.",
            HookError::MaxPerWallet => "The hook checks what the receiving wallet now holds and refuses the transfer if it would go over. The pool and the creator are exempt.",
            HookError::RisingMaxPerWallet => "The per-wallet cap starts at the starting share and rises by a fixed step, or doubles, every interval from the first trade until it reaches 100%. The pool and the creator are exempt.",
            HookError::Chapters => "The per-wallet cap starts small and doubles every time the coin’s bought volume passes another chapter. Selling back into the pool always works.",
            HookError::TradeGuard => "No single transfer, in any direction, may move more than the set share of the total supply. The creator is not exempt.",
            HookError::AntiBundle => "The hook counts the pool trades in each Solana block and refuses any past the limit, so a bundle cannot take the launch in one block.",
            HookError::VenueLocked => "Every transfer must have the pool as its sender or its receiver; sending the coin to another wallet or another venue fails.",
            HookError::MarketHours => "Pool trades are allowed only during New York Stock Exchange hours; daylight saving and the exchange holidays are computed on chain. Wallet-to-wallet sends always work.",
            HookError::PingPong => "A pool trade of at least the minimum takes the turn; the next qualifying trade must go the other way until the turn frees up. Sends always work.",
            HookError::BreathingCap => "An oscillator inside the hook swings the per-buy cap up and down on a fixed cycle around the base cap; it never drops below the floor. Sells and sends are never capped; the creator is exempt.",
            HookError::Momentum => "A damped oscillator that starts at rest: every buy kicks it and the per-buy cap swings up around the base cap, then settles as the energy decays. Sells and sends are never capped; the creator is exempt.",
            HookError::Blocklist => "A transfer to a wallet on the blocklist fails. The list is written before the first trade and cannot be changed afterwards, by anyone.",
            HookError::HotPotato => "The wallet whose buy was the most recent qualifying one cannot transfer the coin out until another wallet buys, or until the potato goes cold.",
            HookError::DexOnly => "A transfer is allowed only when another program (the pool, a router) called the token program; a transfer signed directly from a wallet fails.",
            HookError::P2pOnly => "Only the creator can buy from the bonding curve, and nobody can sell into it; holders pass the coin wallet to wallet. When the curve fills it graduates and the rule switches off.",
            HookError::SniperFeeCap => "The hook reads each buy’s transaction: a compute-unit price above the priority-fee cap, or a SOL transfer to a Jito tip account above the tip cap, fails the buy. Sells are never blocked; the creator is exempt.",
            HookError::TradingHours => "Pool trades are allowed only inside the open window on the chosen weekdays, in the chosen time zone (US and EU daylight-saving rules are followed on chain). A window may run past midnight. Sends always work.",
            HookError::Resonance => "The hook keeps a beat from the first trade. A buy on the beat adds its full energy, a buy off the beat adds little; energy decays at the damping rate and widens the per-buy cap above the base cap. Sells and sends are never capped; the creator is exempt.",
            HookError::CoupledResonator => "Buys kick the first oscillator, which swings the per-buy cap around the base cap; energy flows between the two at the coupling rate so the swing outlasts the buying. Sells and sends are never capped; the creator is exempt.",
            HookError::Tithe => "A pool trade is allowed only if the same transaction pays at least the donation in SOL to the recipient set at launch. Launchpad adds the donation to every trade it builds; the creator is exempt.",
            HookError::FomoOnly => "A pool trade is allowed only when the transaction carries FOMO’s mark as the host names it (on mainnet, FOMO’s own wallet co-signing the trade); any other route, Launchpad included, is refused while the coin is on the curve. The creator is exempt; sends always work; the rule ends at graduation.",
            HookError::PumpAppOnly => "A pool trade is allowed only when the transaction carries the Pump App’s mark as the host names it (on mainnet, the OKX router swap the Pump App builds through Jupiter’s app API, commission slot filled); any other route, Launchpad included, is refused while the coin is on the curve. The creator is exempt; sends always work; the rule ends at graduation.",
            HookError::WalletNotRegistered => "This wallet has no record for the coin yet; register it first.",
            HookError::NotAllowed => "Only the coin's creator can do this.",
            HookError::ConfigMismatch => "The coin's hook configuration is missing or invalid.",
            HookError::BadAccounts => "The transfer did not carry the accounts the hook program expects.",
            HookError::NotTransferring => "The hook program can only run inside a Token-2022 transfer.",
            HookError::Overflow => "An amount in this transfer is too large.",
            HookError::AlreadyInitialized => "This hook account already exists.",
            HookError::BlocklistFull => "The blocklist can hold at most 200 wallets.",
            HookError::LaunchStarted => "The first trade has happened; the blocklist is sealed.",
            HookError::BadSysvar => "The transaction did not carry the instructions sysvar the hook program expects.",
        }
    }

    /// Every code, in table order; the JS error table must list exactly these.
    pub const ALL: [HookError; 35] = [
        HookError::Allowlist,
        HookError::HolderGated,
        HookError::HolderVesting,
        HookError::AntiDump,
        HookError::SlidingCaps,
        HookError::GraduatedSellCaps,
        HookError::MaxPerWallet,
        HookError::RisingMaxPerWallet,
        HookError::Chapters,
        HookError::TradeGuard,
        HookError::AntiBundle,
        HookError::VenueLocked,
        HookError::MarketHours,
        HookError::PingPong,
        HookError::BreathingCap,
        HookError::Momentum,
        HookError::Blocklist,
        HookError::HotPotato,
        HookError::DexOnly,
        HookError::P2pOnly,
        HookError::SniperFeeCap,
        HookError::TradingHours,
        HookError::Resonance,
        HookError::CoupledResonator,
        HookError::Tithe,
        HookError::WalletNotRegistered,
        HookError::NotAllowed,
        HookError::ConfigMismatch,
        HookError::BadAccounts,
        HookError::NotTransferring,
        HookError::Overflow,
        HookError::AlreadyInitialized,
        HookError::BlocklistFull,
        HookError::LaunchStarted,
        HookError::BadSysvar,
    ];
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rule_codes_are_6000_plus_kind() {
        for kind in 1..=27u8 {
            assert_eq!(HookError::for_rule(kind).unwrap().code(), 6000 + kind as u32);
        }
        assert_eq!(HookError::for_rule(0), None);
        assert_eq!(HookError::for_rule(28), None);
        assert_eq!(HookError::for_rule(255), None);
    }

    #[test]
    fn structural_codes_and_table_are_stable() {
        assert_eq!(HookError::WalletNotRegistered.code(), 6100);
        assert_eq!(HookError::NotAllowed.code(), 6101);
        assert_eq!(HookError::ConfigMismatch.code(), 6102);
        assert_eq!(HookError::BadAccounts.code(), 6103);
        assert_eq!(HookError::NotTransferring.code(), 6104);
        assert_eq!(HookError::Overflow.code(), 6105);
        assert_eq!(HookError::AlreadyInitialized.code(), 6106);
        assert_eq!(HookError::BlocklistFull.code(), 6107);
        assert_eq!(HookError::LaunchStarted.code(), 6108);
        assert_eq!(HookError::BadSysvar.code(), 6109);
        let mut codes: Vec<u32> = HookError::ALL.iter().map(|e| e.code()).collect();
        let before = codes.clone();
        codes.sort_unstable();
        codes.dedup();
        assert_eq!(codes, before, "table is ordered and free of duplicates");
        assert_eq!(codes.len(), 35);
        for e in HookError::ALL {
            assert!(!e.name().is_empty() && e.message().ends_with('.'), "{:?}", e);
        }
        assert_eq!(HookError::for_rule(18).unwrap().name(), "HotPotato");
        assert_eq!(HookError::for_rule(20).unwrap().name(), "P2pOnly");
    }
}
