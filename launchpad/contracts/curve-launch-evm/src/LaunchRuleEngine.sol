// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchTypes, ILaunchRuleEngine, ILaunchFactory, ILaunchLocker} from "./interfaces/ILaunch.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IArbSys} from "./interfaces/IUniswapV4.sol";
import {Calendar} from "./lib/Calendar.sol";
import {Oscillator} from "./lib/Oscillator.sol";
import {CurveMath} from "./lib/CurveMath.sol";

/// @title LaunchRuleEngine
/// @notice The transfer rules of every Launchpad launch token on Robinhood Chain, in one singleton: the Solana hook
/// program's rule engine (`execute.rs`) ported rule for rule, with the same kinds, the same six parameters per rule and
/// the same vocabulary — a transfer out of the venue (the bonding curve) is a *buy*, one into it a *sell*, anything
/// else a *send*; an exempt wallet (the creator, Launchpad's per-coin wallets, the factory, the locker) skips every rule
/// when the transfer touches the venue, and the destination-side rules skip an exempt receiver. Balances are the
/// post-transfer balances, as Token-2022 hands them to the hook. Rules run while the coin is on the curve; the factory
/// deactivates them at graduation, after which the token moves freely (Uniswap pools must never see a refusal).
///
/// Differences from the Solana program, all forced by the chain: `dex_only` means "moved by a contract" (a router or
/// the curve) rather than "under another program"; `anti_bundle` counts trades per L2 block; `holder_vesting` needs no
/// wallet registration (state is created on first receipt); `tithe` is enforced by the curve, which takes the donation
/// with the trade; `sniper_fee_cap` and the two app-only rules do not exist here (priority fees, Jito tips and the FOMO
/// and Pump apps are Solana things). A token calls `onTransfer` from its own transfer hook and nothing else can.
contract LaunchRuleEngine is ILaunchRuleEngine {
    using CurveMath for uint256;
    using Oscillator for Oscillator.State;

    error NotFactory();
    error NotInstalledToken();
    error AlreadyInstalled();
    error NotCreator();
    error TooManyRules();
    error UnsupportedRule(uint8 kind);
    error DuplicateRule(uint8 kind);
    error ConflictingRules(uint8 a, uint8 b);
    error InvalidRuleParams(uint8 kind);
    error TooManyAddresses();
    error RuleRefused(uint8 kind);
    error ZeroAddress();

    event Installed(address indexed token, address indexed venue, address indexed creator, uint256 ruleCount);
    event Deactivated(address indexed token);
    event AllowlistChanged(address indexed token, address indexed wallet, bool allowed);

    uint8 public constant KIND_ALLOWLIST = 1;
    uint8 public constant KIND_HOLDER_GATED = 2;
    uint8 public constant KIND_HOLDER_VESTING = 3;
    uint8 public constant KIND_ANTI_DUMP = 4;
    uint8 public constant KIND_SLIDING_CAPS = 5;
    uint8 public constant KIND_GRADUATED_SELL_CAPS = 6;
    uint8 public constant KIND_MAX_PER_WALLET = 7;
    uint8 public constant KIND_RISING_MAX_PER_WALLET = 8;
    uint8 public constant KIND_CHAPTERS = 9;
    uint8 public constant KIND_TRADE_GUARD = 10;
    uint8 public constant KIND_ANTI_BUNDLE = 11;
    uint8 public constant KIND_VENUE_LOCKED = 12;
    uint8 public constant KIND_MARKET_HOURS = 13;
    uint8 public constant KIND_PING_PONG = 14;
    uint8 public constant KIND_BREATHING_CAP = 15;
    uint8 public constant KIND_MOMENTUM = 16;
    uint8 public constant KIND_BLOCKLIST = 17;
    uint8 public constant KIND_HOT_POTATO = 18;
    uint8 public constant KIND_DEX_ONLY = 19;
    uint8 public constant KIND_P2P_ONLY = 20;
    uint8 public constant KIND_TRADING_HOURS = 22;
    uint8 public constant KIND_RESONANCE = 23;
    uint8 public constant KIND_COUPLED_RESONATOR = 24;
    uint8 public constant KIND_TITHE = 25;

    uint256 public constant MAX_RULES = 4;
    uint256 public constant MAX_BLOCKLIST = 200;
    uint256 public constant MAX_ALLOWLIST = 200;
    uint256 public constant MAX_EXEMPT = 8;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant PPM = 1_000_000;
    uint8 internal constant TURN_NONE = 0;
    uint8 internal constant TURN_BUY = 1;
    uint8 internal constant TURN_SELL = 2;
    address internal constant ARB_SYS = 0x0000000000000000000000000000000000000064;

    struct Config {
        bool installed;
        bool active;
        address venue;
        address creator;
        address gateToken;
        address titheRecipient;
        uint256 supply;
        uint8 ruleCount;
        LaunchTypes.Rule[4] rules;
        // the shared state (the hook program's ConfigState)
        uint64 startedAt;
        uint64 startBlock;
        uint64 lastBlock;
        uint64 blockTrades;
        uint256 volumeBought;
        address potatoHolder;
        uint64 potatoSince;
        uint8 turnSide;
        uint64 turnTs;
        Oscillator.State osc;
    }

    struct WalletState {
        uint64 firstReceiptTs;
        uint256 receivedTotal;
    }

    /// @dev One transfer as the engine sees it (the hook program's `Transfer`).
    struct Xfer {
        address from;
        address to;
        uint256 amount;
        uint256 fromPost;
        uint256 toPost;
        bool srcVenue;
        bool dstVenue;
        bool srcExempt;
        bool dstExempt;
        bool callerIsContract;
        uint256 nowTs;
        uint256 supply;
        bool hasClock;
        uint256 elapsed;
    }

    address public immutable factory;
    mapping(address token => Config) internal _configs;
    mapping(address token => mapping(address wallet => bool)) public exemptWallets;
    mapping(address token => mapping(address wallet => bool)) public allowlist;
    mapping(address token => mapping(address wallet => bool)) public blocklist;
    mapping(address token => mapping(address wallet => WalletState)) public wallets;

    constructor(address factory_) {
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
    }

    // ------------------------------------------------------------------ installation (the factory, at launch)

    /// @notice Installs and activates a token's rules. Only the factory calls this, once per token, before the first
    /// trade; the token's own transfer hook starts consulting the engine when the factory activates it.
    function install(address token, address venue, address creator, uint256 supply, LaunchTypes.RuleSetup calldata setup, address[] calldata platformExempt) external {
        if (msg.sender != factory) revert NotFactory();
        if (token == address(0) || venue == address(0) || creator == address(0)) revert ZeroAddress();
        Config storage c = _configs[token];
        if (c.installed) revert AlreadyInstalled();
        if (setup.rules.length > MAX_RULES) revert TooManyRules();
        if (setup.exempt.length > MAX_EXEMPT || setup.blocklist.length > MAX_BLOCKLIST || setup.allowlist.length > MAX_ALLOWLIST) revert TooManyAddresses();
        c.installed = true;
        c.active = true;
        c.venue = venue;
        c.creator = creator;
        c.gateToken = setup.gateToken;
        c.titheRecipient = setup.titheRecipient;
        c.supply = supply;
        c.ruleCount = uint8(setup.rules.length);
        for (uint256 i = 0; i < setup.rules.length; i++) {
            LaunchTypes.Rule calldata r = setup.rules[i];
            for (uint256 j = 0; j < i; j++) {
                if (setup.rules[j].kind == r.kind) revert DuplicateRule(r.kind);
                if (conflicts(setup.rules[j].kind, r.kind)) revert ConflictingRules(setup.rules[j].kind, r.kind);
            }
            if (!validRule(r, setup.gateToken, setup.titheRecipient)) revert InvalidRuleParams(r.kind);
            c.rules[i] = r;
        }
        exemptWallets[token][creator] = true;
        for (uint256 i = 0; i < platformExempt.length; i++) if (platformExempt[i] != address(0)) exemptWallets[token][platformExempt[i]] = true;
        for (uint256 i = 0; i < setup.exempt.length; i++) if (setup.exempt[i] != address(0)) exemptWallets[token][setup.exempt[i]] = true;
        for (uint256 i = 0; i < setup.allowlist.length; i++) allowlist[token][setup.allowlist[i]] = true;
        for (uint256 i = 0; i < setup.blocklist.length; i++) blocklist[token][setup.blocklist[i]] = true;
        emit Installed(token, venue, creator, setup.rules.length);
    }

    /// @notice Switches a token's rules off for good (graduation). Only the factory.
    function deactivate(address token) external {
        if (msg.sender != factory) revert NotFactory();
        Config storage c = _configs[token];
        if (!c.installed) revert NotInstalledToken();
        c.active = false;
        emit Deactivated(token);
    }

    /// @notice The creator edits the allowlist after launch (allowlist rule). The blocklist is sealed.
    function setAllowed(address token, address[] calldata list, bool allowed_) external {
        Config storage c = _configs[token];
        if (!c.installed) revert NotInstalledToken();
        if (msg.sender != c.creator) revert NotCreator();
        for (uint256 i = 0; i < list.length; i++) {
            allowlist[token][list[i]] = allowed_;
            emit AllowlistChanged(token, list[i], allowed_);
        }
    }

    // ------------------------------------------------------------------ views

    function tithe(address token) external view returns (address recipient, uint256 amount) {
        Config storage c = _configs[token];
        if (!c.active) return (address(0), 0);
        for (uint256 i = 0; i < c.ruleCount; i++) if (c.rules[i].kind == KIND_TITHE) return (c.titheRecipient, c.rules[i].p[0]);
        return (address(0), 0);
    }

    function isExempt(address token, address wallet) external view returns (bool) { return exemptWallets[token][wallet]; }
    function isActive(address token) external view returns (bool) { return _configs[token].active; }
    function ruleCount(address token) external view returns (uint256) { return _configs[token].ruleCount; }

    function ruleAt(address token, uint256 index) external view returns (uint8 kind, uint256[6] memory p) {
        LaunchTypes.Rule storage r = _configs[token].rules[index];
        return (r.kind, r.p);
    }

    function hasRule(address token, uint8 kind) public view returns (bool) {
        Config storage c = _configs[token];
        for (uint256 i = 0; i < c.ruleCount; i++) if (c.rules[i].kind == kind) return true;
        return false;
    }

    function configOf(address token) external view returns (bool installed, bool active, address venue, address creator, address gateToken, address titheRecipient, uint256 supply, uint64 startedAt) {
        Config storage c = _configs[token];
        return (c.installed, c.active, c.venue, c.creator, c.gateToken, c.titheRecipient, c.supply, c.startedAt);
    }

    function stateOf(address token) external view returns (uint64 startedAt, uint64 startBlock, uint256 volumeBought, address potatoHolder, uint64 potatoSince, uint8 turn, uint64 turnTs, Oscillator.State memory osc) {
        Config storage c = _configs[token];
        return (c.startedAt, c.startBlock, c.volumeBought, c.potatoHolder, c.potatoSince, c.turnSide, c.turnTs, c.osc);
    }

    // ------------------------------------------------------------------ the transfer hook

    /// @notice Called by a launch token after every transfer while its rules are active. Reverts with `RuleRefused(kind)`
    /// when a rule refuses the transfer, which reverts the transfer itself.
    function onTransfer(address from, address to, uint256 amount, uint256 fromPost, uint256 toPost, address caller) external {
        Config storage c = _configs[msg.sender];
        if (!c.installed) revert NotInstalledToken();
        if (!c.active || amount == 0) return;
        Xfer memory t;
        t.from = from;
        t.to = to;
        t.amount = amount;
        t.fromPost = fromPost;
        t.toPost = toPost;
        t.srcVenue = from == c.venue;
        t.dstVenue = to == c.venue;
        t.srcExempt = exemptWallets[msg.sender][from];
        // A burn (to the zero address) counts as a send to an exempt receiver: the holder's own rules still apply.
        t.dstExempt = to == address(0) || exemptWallets[msg.sender][to];
        t.callerIsContract = caller.code.length > 0;
        t.nowTs = block.timestamp;
        t.supply = c.supply;
        if (t.srcVenue || t.dstVenue) {
            // 1. The first venue transfer starts the clock of every time-based rule.
            if (c.startedAt == 0) {
                c.startedAt = uint64(block.timestamp);
                c.startBlock = uint64(blockNumber());
            }
            // 2. The oscillator decays and turns on every venue transfer, exempt or not.
            for (uint256 i = 0; i < c.ruleCount; i++) {
                LaunchTypes.Rule storage r = c.rules[i];
                if (r.kind == KIND_MOMENTUM || r.kind == KIND_RESONANCE) { Oscillator.State memory o = c.osc; o.step(block.timestamp, r.p[0], r.p[1], 0); c.osc = o; }
                else if (r.kind == KIND_COUPLED_RESONATOR) { Oscillator.State memory o = c.osc; o.step(block.timestamp, r.p[0], r.p[2], r.p[1]); c.osc = o; }
            }
        }
        if (skipsRules(t)) return;
        t.hasClock = c.startedAt != 0;
        t.elapsed = t.hasClock ? block.timestamp - c.startedAt : 0;
        for (uint256 i = 0; i < c.ruleCount; i++) checkRule(c, msg.sender, c.rules[i], t);
        for (uint256 i = 0; i < c.ruleCount; i++) recordRule(c, msg.sender, c.rules[i], t);
    }

    // ------------------------------------------------------------------ transfer vocabulary

    function touchesVenue(Xfer memory t) internal pure returns (bool) { return t.srcVenue || t.dstVenue; }
    function isSell(Xfer memory t) internal pure returns (bool) { return t.dstVenue && !t.srcVenue; }
    function isBuy(Xfer memory t) internal pure returns (bool) { return t.srcVenue && !t.dstVenue; }
    function walletToWallet(Xfer memory t) internal pure returns (bool) { return !t.srcVenue && !t.dstVenue; }
    function srcExempt(Xfer memory t) internal pure returns (bool) { return !t.srcVenue && t.srcExempt; }
    function dstExempt(Xfer memory t) internal pure returns (bool) { return !t.dstVenue && t.dstExempt; }
    /// @dev Venue-to-venue moves and venue transfers whose wallet side is exempt skip every rule.
    function skipsRules(Xfer memory t) internal pure returns (bool) {
        return (t.srcVenue && t.dstVenue) || (t.srcVenue && t.dstExempt) || (t.dstVenue && t.srcExempt);
    }
    function outOfWallet(Xfer memory t) internal pure returns (bool) { return !t.srcVenue; }
    function intoCappedWallet(Xfer memory t) internal pure returns (bool) { return !t.dstVenue && !t.dstExempt; }
    function cappedBuy(Xfer memory t) internal pure returns (bool) { return isBuy(t) && intoCappedWallet(t); }
    function preBalance(Xfer memory t) internal pure returns (uint256) { return t.fromPost + t.amount; }

    function need(bool ok, uint8 kind) internal pure {
        if (!ok) revert RuleRefused(kind);
    }

    function buyCap(Xfer memory t, uint256 capBps, uint8 kind) internal pure {
        if (cappedBuy(t)) need(t.amount <= t.supply.share(capBps), kind);
    }

    // ------------------------------------------------------------------ checks (the state before this transfer)

    function checkRule(Config storage c, address token, LaunchTypes.Rule storage r, Xfer memory t) internal {
        uint8 kind = r.kind;
        uint256 p0 = r.p[0];
        uint256 p1 = r.p[1];
        if (kind == KIND_ALLOWLIST) { need(!intoCappedWallet(t) || allowlist[token][t.to], kind); return; }
        if (kind == KIND_HOLDER_GATED) { need(!intoCappedWallet(t) || gateBalance(c.gateToken, t.to) >= p0, kind); return; }
        if (kind == KIND_HOLDER_VESTING) {
            if (outOfWallet(t) && !t.srcExempt) {
                WalletState storage w = wallets[token][t.from];
                uint256 locked = vestingLocked(w, t.nowTs, p1, r.p[2], r.p[3]);
                need(t.fromPost >= locked, kind);
            }
            return;
        }
        if (kind == KIND_ANTI_DUMP) {
            if (isBuy(t)) need(p0 == 0 || t.amount <= t.supply.share(p0), kind);
            else need(t.amount <= t.supply.share(p1), kind);
            return;
        }
        if (kind == KIND_SLIDING_CAPS) {
            if (isBuy(t) || isSell(t)) {
                uint256 level = slidingLevel(r.p[3], p0, ILaunchLocker(ILaunchFactory(factory).locker()).progressBps(token));
                if (isBuy(t)) { uint256 cap = slidingCap(p1, r.p[4], level, true); need(cap == 0 || t.amount <= t.supply.share(cap), kind); }
                else need(t.amount <= t.supply.share(slidingCap(r.p[2], r.p[4], level, false)), kind);
            }
            return;
        }
        if (kind == KIND_GRADUATED_SELL_CAPS) {
            if (outOfWallet(t)) need(t.amount <= t.supply.share(graduatedCapBps(p0, p1, r.p[2], preBalance(t), t.supply)), kind);
            return;
        }
        if (kind == KIND_MAX_PER_WALLET) { need(!intoCappedWallet(t) || t.toPost <= t.supply.share(p0), kind); return; }
        if (kind == KIND_RISING_MAX_PER_WALLET) {
            uint256 cap = risingCapBps(p0, p1, r.p[2], r.p[3], t.hasClock, t.elapsed);
            need(!intoCappedWallet(t) || t.toPost <= t.supply.share(cap), kind);
            return;
        }
        if (kind == KIND_CHAPTERS) { need(!intoCappedWallet(t) || t.toPost <= t.supply.share(chaptersCapBps(p0, p1, c.volumeBought)), kind); return; }
        if (kind == KIND_TRADE_GUARD) { need(t.amount <= t.supply.share(p0), kind); return; }
        if (kind == KIND_ANTI_BUNDLE) {
            if (touchesVenue(t)) {
                uint64 blk = uint64(blockNumber());
                if (c.lastBlock == blk) c.blockTrades += 1; else { c.lastBlock = blk; c.blockTrades = 1; }
                need(c.blockTrades <= p0, kind);
            }
            return;
        }
        if (kind == KIND_VENUE_LOCKED) { need(!walletToWallet(t) || srcExempt(t) || dstExempt(t), kind); return; }
        if (kind == KIND_MARKET_HOURS) {
            if (isBuy(t) || (isSell(t) && p0 != 1)) need(Calendar.nyseOpen(int256(t.nowTs), p1 == 1), kind);
            return;
        }
        if (kind == KIND_PING_PONG) {
            if (touchesVenue(t) && t.amount >= sharePpm(t.supply, p0)) {
                bool same = c.turnSide == turnSide(t);
                bool held = p1 == 0 || t.nowTs < uint256(c.turnTs) + p1;
                need(!(same && held), kind);
            }
            return;
        }
        if (kind == KIND_BREATHING_CAP) { buyCap(t, breathingCapBps(p0, p1, r.p[2], r.p[3], t.hasClock, t.elapsed), kind); return; }
        if (kind == KIND_MOMENTUM) { buyCap(t, Oscillator.capWithSwing(r.p[3], c.osc.energy, Oscillator.sinQ16(c.osc.phase), r.p[4]), kind); return; }
        if (kind == KIND_RESONANCE) { buyCap(t, Oscillator.capWithEnergy(r.p[3], c.osc.energy, r.p[4]), kind); return; }
        if (kind == KIND_COUPLED_RESONATOR) { buyCap(t, Oscillator.capWithSwing(r.p[4], c.osc.energy, Oscillator.sinQ16(c.osc.phase), r.p[5]), kind); return; }
        if (kind == KIND_BLOCKLIST) { need(!intoCappedWallet(t) || !blocklist[token][t.to], kind); return; }
        if (kind == KIND_HOT_POTATO) {
            if (outOfWallet(t) && c.potatoHolder != address(0) && t.from == c.potatoHolder) {
                bool cold = p1 > 0 && t.nowTs >= uint256(c.potatoSince) + p1;
                need(cold, kind);
            }
            return;
        }
        if (kind == KIND_DEX_ONLY) { need(t.callerIsContract, kind); return; }
        if (kind == KIND_P2P_ONLY) {
            if (isBuy(t)) need(t.to == c.creator, kind); else need(!isSell(t), kind);
            return;
        }
        if (kind == KIND_TRADING_HOURS) {
            if (isBuy(t) || (isSell(t) && r.p[5] != 1)) {
                int256 offsetMinutes = int256(r.p[3]) - int256(Calendar.MINUTES_PER_DAY);
                need(Calendar.tradingWindowOpen(int256(t.nowTs), p0, p1, r.p[2], offsetMinutes, uint8(r.p[4] > 255 ? 255 : r.p[4])), kind);
            }
            return;
        }
        if (kind == KIND_TITHE) return; // the curve takes the donation with the trade
        revert UnsupportedRule(kind);
    }

    // ------------------------------------------------------------------ state updates (after every check passed)

    function recordRule(Config storage c, address token, LaunchTypes.Rule storage r, Xfer memory t) internal {
        uint8 kind = r.kind;
        if (kind == KIND_HOLDER_VESTING) {
            if (intoCappedWallet(t) && t.from != t.to) {
                WalletState storage w = wallets[token][t.to];
                if (vestingQualifies(t.amount, t.supply, c.startedAt, t.nowTs, r.p[0], r.p[4], w)) {
                    if (w.firstReceiptTs == 0) w.firstReceiptTs = uint64(t.nowTs);
                    w.receivedTotal += t.amount;
                }
            }
        } else if (kind == KIND_CHAPTERS) {
            if (isBuy(t)) c.volumeBought += t.amount;
        } else if (kind == KIND_PING_PONG) {
            if (touchesVenue(t) && t.amount >= sharePpm(t.supply, r.p[0])) { c.turnSide = turnSide(t); c.turnTs = uint64(t.nowTs); }
        } else if (kind == KIND_MOMENTUM) {
            if (cappedBuy(t)) c.osc.energy = uint64(Oscillator.kick(c.osc.energy, r.p[2], t.amount, t.supply.share(r.p[3]), uint256(Oscillator.Q16_ONE)));
        } else if (kind == KIND_RESONANCE) {
            if (cappedBuy(t)) {
                uint256 alignment = Oscillator.alignmentQ16(t.hasClock ? t.elapsed : 0, r.p[0]);
                c.osc.energy = uint64(Oscillator.kick(c.osc.energy, r.p[2], t.amount, t.supply.share(r.p[3]), alignment));
            }
        } else if (kind == KIND_COUPLED_RESONATOR) {
            if (cappedBuy(t)) c.osc.energy = uint64(Oscillator.kick(c.osc.energy, r.p[3], t.amount, t.supply.share(r.p[4]), uint256(Oscillator.Q16_ONE)));
        } else if (kind == KIND_HOT_POTATO) {
            if (cappedBuy(t) && t.amount >= sharePpm(t.supply, r.p[0])) { c.potatoHolder = t.to; c.potatoSince = uint64(t.nowTs); }
        }
    }

    // ------------------------------------------------------------------ per-rule math (pure)

    function sharePpm(uint256 total, uint256 ppm) internal pure returns (uint256) { return CurveMath.mulDiv(total, ppm, PPM); }

    function turnSide(Xfer memory t) internal pure returns (uint8) { return isBuy(t) ? TURN_BUY : TURN_SELL; }

    function gateBalance(address gateToken, address wallet) internal view returns (uint256) {
        if (gateToken == address(0)) return 0;
        return IERC20(gateToken).balanceOf(wallet);
    }

    /// @dev Field `i` (0..3) of a word packing four 16-bit values.
    function unpack16(uint256 packed, uint256 i) internal pure returns (uint256) { return (packed >> (16 * i)) & 0xffff; }

    /// @dev holder_vesting: whether a receipt of `amount` is a qualifying (locked) one. p0 == 0 (everyone vests), or
    /// the clock has not started, or now ≤ startedAt + earlyWindow, or the receiver already vests.
    function vestingQualifies(uint256 amount, uint256 supply, uint64 startedAt, uint256 nowTs, uint256 earlyWindow, uint256 minPpm, WalletState storage w) internal view returns (bool) {
        if (amount < sharePpm(supply, minPpm)) return false;
        return earlyWindow == 0 || startedAt == 0 || nowTs <= uint256(startedAt) + earlyWindow || w.firstReceiptTs != 0;
    }

    /// @dev holder_vesting: the unlocked share in bps of a wallet whose clock started at `first`.
    function vestingUnlockedBps(uint256 first, uint256 nowTs, uint256 cliff, uint256 period, uint256 unlockBps) internal pure returns (uint256) {
        uint256 held = nowTs > first ? nowTs - first : 0;
        if (held < cliff) return 0;
        uint256 periods = 1 + (held - cliff) / (period == 0 ? 1 : period);
        uint256 unlocked = unlockBps * periods;
        return unlocked > BPS ? BPS : unlocked;
    }

    /// @dev holder_vesting: tokens still locked = received − unlocked share of received.
    function vestingLocked(WalletState storage w, uint256 nowTs, uint256 cliff, uint256 period, uint256 unlockBps) internal view returns (uint256) {
        if (w.firstReceiptTs == 0) return 0;
        uint256 f = vestingUnlockedBps(w.firstReceiptTs, nowTs, cliff, period, unlockBps);
        return w.receivedTotal - w.receivedTotal.share(f);
    }

    /// @dev sliding_caps: the number of breakpoints (16-bit bps fields of `breakpoints`, levels − 1 of them) at or below `progress`.
    function slidingLevel(uint256 breakpoints, uint256 levels, uint256 progress) internal pure returns (uint256 level) {
        if (levels < 1) levels = 1;
        if (levels > 5) levels = 5;
        for (uint256 i = 0; i + 1 < levels; i++) if (unpack16(breakpoints, i) <= progress) level++;
    }

    /// @dev sliding_caps: the cap of `level` from the packed level fields (levels 0..3 in `packed`, level 4 in `p4`: buy low, sell high).
    function slidingCap(uint256 packed, uint256 p4, uint256 level, bool buy) internal pure returns (uint256) {
        if (level < 4) return unpack16(packed, level);
        return unpack16(p4, buy ? 0 : 1);
    }

    /// @dev graduated_sell_caps: `small − (small − big) × min(pre, bag) / bag` with `bag = share(supply, bagBps)`.
    function graduatedCapBps(uint256 small, uint256 big, uint256 bagBps, uint256 pre, uint256 supply) internal pure returns (uint256) {
        uint256 bag = supply.share(bagBps);
        if (bag == 0 || pre >= bag) return big < small ? big : small;
        uint256 drop = (small > big ? small - big : 0) * pre / bag;
        return small - drop;
    }

    /// @dev rising_max_per_wallet: `start + n × step` or `start × 2^n` (n = whole intervals since the clock started), at most 10000.
    function risingCapBps(uint256 start, uint256 mode, uint256 step_, uint256 interval, bool hasClock, uint256 elapsed) internal pure returns (uint256) {
        uint256 n = (hasClock && interval > 0) ? elapsed / interval : 0;
        uint256 cap;
        if (mode == 1) cap = n >= 64 ? BPS : start << n;
        else cap = start + step_ * n;
        return cap > BPS ? BPS : cap;
    }

    /// @dev chapters: `start × 2^floor(volumeBought / volumePerChapter)`, at most 10000.
    function chaptersCapBps(uint256 start, uint256 volumePerChapter, uint256 volumeBought) internal pure returns (uint256) {
        if (volumePerChapter == 0) return start > BPS ? BPS : start;
        uint256 n = volumeBought / volumePerChapter;
        if (n >= 64) return BPS;
        uint256 cap = start << n;
        return cap > BPS ? BPS : cap;
    }

    /// @dev breathing_cap: `max(floor, base + base × swing% × sin(2π × elapsed / cycle))`, the base before the clock starts.
    function breathingCapBps(uint256 cycle, uint256 base, uint256 swingPct, uint256 floorBps, bool hasClock, uint256 elapsed) internal pure returns (uint256) {
        int256 sin = hasClock ? Oscillator.sinQ16(Oscillator.phaseInCycle(elapsed, cycle)) : int256(0);
        return Oscillator.breathingCap(base, swingPct, sin, floorBps);
    }

    /// @dev The L2 block number on Arbitrum-family chains (ArbSys), `block.number` elsewhere (tests, other EVMs).
    function blockNumber() internal view returns (uint256) {
        if (ARB_SYS.code.length == 0) return block.number;
        (bool ok, bytes memory ret) = ARB_SYS.staticcall(abi.encodeCall(IArbSys.arbBlockNumber, ()));
        if (!ok || ret.length < 32) return block.number;
        return abi.decode(ret, (uint256));
    }

    // ------------------------------------------------------------------ validation (the on-chain backstop)

    /// @dev Bit `b` of `conflictMask(a)` is set when kinds a and b cannot share a coin (the catalogue's HOOK_CONFLICTS).
    function conflictMask(uint8 kind) internal pure returns (uint256) {
        if (kind == 1) return bits2(2, 17);
        if (kind == 2) return bits2(1, 17);
        if (kind == 4) return (1 << 5) | (1 << 6) | (1 << 10) | (1 << 15) | (1 << 16) | (1 << 23) | (1 << 24);
        if (kind == 5) return (1 << 4) | (1 << 6) | (1 << 10) | (1 << 15) | (1 << 16) | (1 << 23) | (1 << 24);
        if (kind == 6) return (1 << 4) | (1 << 5) | (1 << 10);
        if (kind == 7) return bits2(8, 9);
        if (kind == 8) return bits2(7, 9);
        if (kind == 9) return bits2(7, 8);
        if (kind == 10) return (1 << 4) | (1 << 5) | (1 << 6);
        if (kind == 11) return 1 << 20;
        if (kind == 12) return bits2(19, 20);
        if (kind == 13) return 1 << 22;
        if (kind == 14) return 1 << 20;
        if (kind == 15) return (1 << 4) | (1 << 5) | (1 << 16) | (1 << 23) | (1 << 24);
        if (kind == 16) return (1 << 4) | (1 << 5) | (1 << 15) | (1 << 23) | (1 << 24);
        if (kind == 17) return bits2(1, 2);
        if (kind == 18) return 1 << 20;
        if (kind == 19) return bits2(12, 20);
        if (kind == 20) return (1 << 11) | (1 << 12) | (1 << 14) | (1 << 18) | (1 << 19);
        if (kind == 22) return 1 << 13;
        if (kind == 23) return (1 << 4) | (1 << 5) | (1 << 15) | (1 << 16) | (1 << 24);
        if (kind == 24) return (1 << 4) | (1 << 5) | (1 << 15) | (1 << 16) | (1 << 23);
        return 0;
    }

    function bits2(uint256 a, uint256 b) private pure returns (uint256) { return (1 << a) | (1 << b); }

    function conflicts(uint8 a, uint8 b) public pure returns (bool) {
        return (conflictMask(a) >> b) & 1 == 1;
    }

    function supportedKind(uint8 kind) public pure returns (bool) {
        return kind >= 1 && kind <= 25 && kind != 21;
    }

    /// @dev The hook program's `validate_rule`, with the parameters widened to uint256.
    function validRule(LaunchTypes.Rule calldata r, address gateToken, address titheRecipient) public pure returns (bool) {
        uint8 kind = r.kind;
        uint256 p0 = r.p[0]; uint256 p1 = r.p[1]; uint256 p2 = r.p[2]; uint256 p3 = r.p[3]; uint256 p4 = r.p[4]; uint256 p5 = r.p[5];
        if (kind == KIND_ALLOWLIST || kind == KIND_VENUE_LOCKED || kind == KIND_BLOCKLIST || kind == KIND_DEX_ONLY || kind == KIND_P2P_ONLY) return true;
        if (kind == KIND_HOLDER_GATED) return p0 >= 1 && gateToken != address(0);
        if (kind == KIND_HOLDER_VESTING) return p2 >= 1 && bps(p3) && p4 <= PPM && p0 <= type(uint64).max && p1 <= type(uint64).max && p2 <= type(uint64).max;
        if (kind == KIND_ANTI_DUMP) return bps0(p0) && bps(p1);
        if (kind == KIND_SLIDING_CAPS) return slidingCapsValid(p0, p1, p2, p3, p4);
        if (kind == KIND_GRADUATED_SELL_CAPS) return bps(p0) && bps(p1) && p1 <= p0 && bps(p2);
        if (kind == KIND_MAX_PER_WALLET) return bps(p0);
        if (kind == KIND_RISING_MAX_PER_WALLET) return bps(p0) && p1 <= 1 && bps0(p2) && (p1 == 1 || p2 >= 1) && p3 >= 1 && p3 <= type(uint64).max;
        if (kind == KIND_CHAPTERS) return bps(p0) && p1 >= 1;
        if (kind == KIND_TRADE_GUARD) return bps(p0);
        if (kind == KIND_ANTI_BUNDLE) return p0 >= 1;
        if (kind == KIND_MARKET_HOURS) return p0 <= 1 && p1 <= 1;
        if (kind == KIND_PING_PONG) return p0 <= PPM && p1 <= type(uint64).max;
        if (kind == KIND_BREATHING_CAP) return p0 >= 1 && p0 <= type(uint64).max && bps(p1) && pct1(p2) && bps0(p3) && p3 <= p1;
        if (kind == KIND_MOMENTUM || kind == KIND_RESONANCE) return p0 >= 1 && p0 <= type(uint64).max && pct1(p1) && pct1(p2) && bps(p3) && p4 <= p3;
        if (kind == KIND_HOT_POTATO) return p0 <= PPM && p1 <= type(uint64).max;
        if (kind == KIND_TRADING_HOURS) return p0 < Calendar.MINUTES_PER_DAY && p1 >= 1 && p1 <= Calendar.MINUTES_PER_DAY && p2 >= 1 && p2 <= 127 && p3 >= 600 && p3 <= 2280 && p4 <= 2 && p5 <= 1;
        if (kind == KIND_COUPLED_RESONATOR) return p0 >= 1 && p0 <= type(uint64).max && pct1(p1) && p2 <= 100 && pct1(p3) && bps(p4) && p5 <= p4;
        if (kind == KIND_TITHE) return p0 >= 1 && titheRecipient != address(0);
        return false;
    }

    function slidingCapsValid(uint256 levels, uint256 buys, uint256 sells, uint256 breakpoints, uint256 p4) internal pure returns (bool) {
        if (levels < 1 || levels > 5 || p4 >> 32 != 0 || buys >> 64 != 0 || sells >> 64 != 0 || breakpoints >> 64 != 0) return false;
        for (uint256 level = 0; level < levels; level++) {
            if (slidingCap(buys, p4, level, true) > BPS) return false;
            uint256 sell = slidingCap(sells, p4, level, false);
            if (sell < 1 || sell > BPS) return false;
        }
        uint256 last = 0;
        for (uint256 i = 0; i + 1 < levels; i++) {
            uint256 at = unpack16(breakpoints, i);
            if (at <= last || at >= BPS) return false;
            last = at;
        }
        return true;
    }

    function bps(uint256 v) private pure returns (bool) { return v >= 1 && v <= BPS; }
    function bps0(uint256 v) private pure returns (bool) { return v <= BPS; }
    function pct1(uint256 v) private pure returns (bool) { return v >= 1 && v <= 100; }
}
