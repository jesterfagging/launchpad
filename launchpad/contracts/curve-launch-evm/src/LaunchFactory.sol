// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchTypes, ILaunchFeeEscrow, ILaunchFactory, ILaunchLocker, ILaunchRuleEngine, ILaunchSwapRouter, ILaunchToken} from "./interfaces/ILaunch.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {IPoolManager, PoolKey} from "./interfaces/IUniswapV4.sol";
import {LaunchTokenDeployer} from "./LaunchDeployers.sol";
import {SafeTransfer} from "./lib/SafeTransfer.sol";
import {Ownable2Step} from "./lib/Ownable2Step.sol";
import {ReentrancyGuard} from "./lib/ReentrancyGuard.sol";
import {CurveMath} from "./lib/CurveMath.sol";
import {V4Math} from "./lib/V4Math.sol";

/// @title LaunchFactory
/// @notice The launchpad's launch contract on Robinhood Chain, pool-native: one call creates a coin, its Uniswap v4 pool and
/// its liquidity, installs the coin's transfer rules and makes the creator's first buy. The whole supply goes into
/// the pool at once as two one-sided positions the locker holds forever: the sell supply between the tier's start
/// price and its graduation price — which is the bonding curve itself, as a concentrated range: the same raise, the
/// same price path as the virtual-reserve curve — and the rest from the graduation price upwards. The pool is a
/// plain v4 pool (no hook), so every router, aggregator, wallet and trading terminal trades the coin from its first
/// block; Launchpad's own site uses LaunchSwapRouter.
///
/// The owner (the Launchpad host) sets the launch configs (total supply, fee split, tick spacing, the allowed curve
/// steepness), the approved pair assets (ETH, USDG, stock tokens ... each with a default curve and the range a custom
/// raise may use), the launch fee and the platform's fee recipient; it can never move a launch's liquidity or change
/// a launched coin's rules. A launch picks its curve as before: the pair asset's default numbers, or its own
/// `virtualQuote` / `graduationQuote` inside the owner's bounds (`curveForTargets` turns a start and a graduation FDV
/// into the two numbers); the factory turns them into the pool's start tick, graduation tick and position liquidity.
///
/// Fees, shaped like Launchpad's Raydium launches (v71.41): the curve pool's LP fee is the platform's curve fee (the 1%
/// Launchpad protocol fee plus the 0.25% a Raydium launch pays Raydium, which has no counterpart here) plus either the
/// flat creator fee (Creator-mode coins) or the holder tax (1–3%, the holder-reward modes); at graduation the locker
/// moves the raise and the remaining supply into a second pool with Raydium's post-graduation numbers (the 0.25% LP
/// fee, all of it the platform's since the whole position is locked, plus the 0.25% creator fee, plus the tax). A
/// pool's fee is fixed for life on Uniswap v4, which is why there are two pools. Since the launch positions are the
/// pools' liquidity, the fees land in the locker, which credits the platform and the creator fee recipient in the
/// escrow with the share of the stage the fees were earned in (5% of a tax is the platform's, 95% the holders').
/// Fee recipients are read live, so the creator fee recipient can hand its role to another wallet at any time
/// (`transferCreatorFeeRecipient`) and the platform recipient can be rotated by the owner.
contract LaunchFactory is ILaunchFactory, Ownable2Step, ReentrancyGuard {
    using SafeTransfer for address;
    using CurveMath for uint256;

    error LaunchesClosed();
    error ConfigDisabled(uint256 configId);
    error PairNotApproved(address pairToken);
    error ZeroAddress();
    error InvalidBps();
    error TaxOutOfBounds(uint16 bps, uint16 min, uint16 max);
    error LaunchFeeMismatch(uint256 expected, uint256 sent);
    error NotLocker();
    error NotCreatorFeeRecipient();
    error UnknownToken(address token);
    error LockerAlreadySet();
    error DeployersAlreadySet();
    error InvalidConfig();
    error InvalidCurve();
    error CustomCurvesOff(address pairToken);
    error RaiseOutOfBounds(uint256 graduationQuote, uint256 min, uint256 max);
    error RatioOutOfBounds(uint256 ratioBps, uint256 min, uint256 max);
    error UnsupportedRule(uint8 kind);
    error RangeTooNarrow(int24 startTick, int24 graduationTick);

    event LaunchConfigSet(uint256 indexed configId, LaunchConfig config);
    event PairAssetSet(address indexed pairToken, PairAsset asset);
    event LaunchFeeSet(uint256 launchFee);
    event PlatformRecipientSet(address indexed recipient);
    event RuleEngineSet(address indexed engine);
    event LockerSet(address indexed locker);
    event RouterSet(address indexed router);
    event DeployersSet(address indexed tokenDeployer);
    event LaunchesOpenSet(bool open);
    event Launched(address indexed token, address indexed creator, address creatorFeeRecipient, address pairToken, uint256 configId, bytes32 poolId, bytes32 graduationPoolId, uint256 supply, uint256 sellSupply, uint256 lpSupply, uint256 virtualQuote, uint256 graduationQuote, int24 startTick, int24 graduationTick, uint24 curveFee, uint24 poolFee, uint16 taxBps);
    event CreatorFeeRecipientChanged(address indexed token, address indexed previous, address indexed next);
    event Graduated(address indexed token, bytes32 indexed curvePoolId, bytes32 indexed poolId);

    struct LaunchConfig {
        uint256 totalSupply; // the coin's whole supply (18 decimals); the curve numbers split it between the two positions
        uint16 curveProtocolFeeBps; // the platform's part of the curve pool's fee (125: Launchpad's 1% plus Raydium's 0.25% slot)
        uint16 curveCreatorFeeBps; // the flat creator fee on the curve, Creator-mode coins (50)
        uint16 poolProtocolFeeBps; // the graduation pool's LP fee, the platform's (25: Raydium's 0.25% LP fee, locked in full)
        uint16 poolCreatorFeeBps; // the creator fee after graduation (25)
        uint16 taxPlatformShareBps; // the platform's share of a holder tax (500 = 5%; the rest funds the holders)
        uint16 minTaxBps; // a holder-reward launch's tax must sit in [min, max] (100 – 300); a Creator-mode launch has none
        uint16 maxTaxBps;
        int24 tickSpacing; // the pool's tick spacing: the start and graduation prices round to it
        uint32 minRatioBps; // a custom curve's graduationQuote / virtualQuote, in bps, must sit in [min, max]
        uint32 maxRatioBps;
        bool enabled;
    }

    struct PairAsset {
        bool approved;
        uint256 virtualQuote; // the default curve: the phantom quote reserve, in the pair asset's units
        uint256 graduationQuote; // the default curve: the quote raised before graduation
        uint256 minGraduationQuote; // a custom curve's raise must sit in [min, max]; max 0 = only the default curve
        uint256 maxGraduationQuote;
    }

    struct Launch {
        address creator;
        address creatorFeeRecipient;
        address pairToken;
        uint256 configId;
        uint64 createdAt;
        uint64 graduatedAt;
        bytes32 curvePoolId; // the pool the coin starts in
        bytes32 poolId; // the pool trading now: the curve pool, then the graduation pool
        uint24 curveFee; // the curve pool's LP fee, in pips
        uint24 poolFee; // the graduation pool's
        int24 tickSpacing;
        int24 startTick;
        int24 graduationTick;
        uint16 taxBps; // 0 on a Creator-mode coin (the flat creator fee applies), the holder tax otherwise
        uint16 curveShareBps; // of everything the locker collects from the curve pool: the platform's share
        uint16 poolShareBps; // and from the graduation pool
    }

    struct LaunchParams {
        string name;
        string symbol;
        string metadataURI;
        address creator; // the launch's creator: rule-exempt, edits the allowlist, the p2p_only buyer
        address creatorFeeRecipient; // where the creator share of fees accrues (a Launchpad per-coin wallet, or the creator)
        address devBuyRecipient; // who receives the creator's first buy
        uint16 taxBps; // 0: a Creator-mode coin with the flat creator fee; 100–300: a holder-reward coin's tax, in both pools' fees
        address pairToken; // address(0) = ETH
        uint256 configId;
        uint256 virtualQuote; // the curve: both 0 = the pair asset's default, otherwise a custom curve inside the bounds
        uint256 graduationQuote;
        bytes32 salt; // CREATE2 salt (vanity addresses)
        uint256 devBuyQuote; // the creator's first buy, in the pair asset (ETH sent with the call, ERC-20 pulled from the caller)
        uint256 minDevBuyTokens;
        LaunchTypes.RuleSetup rules;
    }

    /// @dev The one-sided positions a launch's numbers map to, with the pool's opening price.
    struct Plan {
        bool tokenIs0;
        uint160 sqrtStart;
        int24 startTick;
        int24 graduationTick;
        int24[2] curveTicks;
        uint128 curveLiquidity;
        int24[2] upperTicks;
        uint128 upperLiquidity;
    }

    uint256 public constant MAX_FEE_BPS = 1_000; // no single fee part above 10%
    int24 public constant MAX_TICK_SPACING = 32767;
    uint8 internal constant KIND_TITHE = 25;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant ONE = 1e18;

    address public immutable override escrow;
    address public immutable override poolManager;
    address public override locker;
    address public override router;
    LaunchTokenDeployer public tokenDeployer;
    address public ruleEngine;
    address public override platformRecipient;
    uint256 public launchFee;
    bool public launchesOpen;
    uint256 public launchCount;

    mapping(uint256 configId => LaunchConfig) public launchConfigs;
    mapping(address pairToken => PairAsset) public pairAssets;
    mapping(address token => Launch) public launches;

    constructor(address owner_, address escrow_, address poolManager_, address platformRecipient_) Ownable2Step(owner_) {
        if (escrow_ == address(0) || poolManager_ == address(0) || platformRecipient_ == address(0)) revert ZeroAddress();
        escrow = escrow_;
        poolManager = poolManager_;
        platformRecipient = platformRecipient_;
    }

    // ------------------------------------------------------------------ owner configuration

    function setLocker(address locker_) external onlyOwner {
        if (locker_ == address(0)) revert ZeroAddress();
        if (locker != address(0)) revert LockerAlreadySet();
        locker = locker_;
        emit LockerSet(locker_);
    }

    function setRouter(address router_) external onlyOwner {
        if (router_ == address(0)) revert ZeroAddress();
        router = router_;
        emit RouterSet(router_);
    }

    function setDeployers(address tokenDeployer_) external onlyOwner {
        if (tokenDeployer_ == address(0)) revert ZeroAddress();
        if (address(tokenDeployer) != address(0)) revert DeployersAlreadySet();
        tokenDeployer = LaunchTokenDeployer(tokenDeployer_);
        emit DeployersSet(tokenDeployer_);
    }

    function setRuleEngine(address engine) external onlyOwner {
        if (engine == address(0)) revert ZeroAddress();
        ruleEngine = engine;
        emit RuleEngineSet(engine);
    }

    function setPlatformRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        platformRecipient = recipient;
        emit PlatformRecipientSet(recipient);
    }

    function setLaunchFee(uint256 fee) external onlyOwner {
        launchFee = fee;
        emit LaunchFeeSet(fee);
    }

    function setLaunchesOpen(bool open) external onlyOwner {
        launchesOpen = open;
        emit LaunchesOpenSet(open);
    }

    function setLaunchConfig(uint256 configId, LaunchConfig calldata cfg) external onlyOwner {
        if (cfg.totalSupply == 0 || cfg.tickSpacing <= 0 || cfg.tickSpacing > MAX_TICK_SPACING || cfg.minRatioBps == 0 || cfg.maxRatioBps < cfg.minRatioBps) revert InvalidConfig();
        if (cfg.curveProtocolFeeBps > MAX_FEE_BPS || cfg.curveCreatorFeeBps > MAX_FEE_BPS || cfg.poolProtocolFeeBps > MAX_FEE_BPS || cfg.poolCreatorFeeBps > MAX_FEE_BPS || cfg.maxTaxBps > MAX_FEE_BPS || cfg.minTaxBps > cfg.maxTaxBps || cfg.taxPlatformShareBps > BPS) revert InvalidBps();
        if (cfg.curveProtocolFeeBps + cfg.curveCreatorFeeBps == 0 || cfg.poolProtocolFeeBps + cfg.poolCreatorFeeBps == 0) revert InvalidBps();
        launchConfigs[configId] = cfg;
        emit LaunchConfigSet(configId, cfg);
    }

    function setPairAsset(address pairToken, PairAsset calldata asset) external onlyOwner {
        _setPairAsset(pairToken, asset);
    }

    function setPairAssets(address[] calldata pairTokens, PairAsset[] calldata assets) external onlyOwner {
        if (pairTokens.length != assets.length) revert InvalidConfig();
        for (uint256 i = 0; i < pairTokens.length; i++) _setPairAsset(pairTokens[i], assets[i]);
    }

    function _setPairAsset(address pairToken, PairAsset calldata asset) internal {
        if (asset.approved && (asset.virtualQuote == 0 || asset.graduationQuote == 0)) revert InvalidCurve();
        if (asset.maxGraduationQuote != 0 && asset.minGraduationQuote > asset.maxGraduationQuote) revert InvalidCurve();
        pairAssets[pairToken] = asset;
        emit PairAssetSet(pairToken, asset);
    }

    // ------------------------------------------------------------------ the curve numbers

    /// @notice The curve a launch gets: the pair asset's default when both numbers are 0, otherwise the given numbers,
    /// which must sit inside the pair asset's raise bounds and the config's steepness bounds.
    function curveNumbers(uint256 configId, address pairToken, uint256 virtualQuote, uint256 graduationQuote) public view returns (uint256 vq, uint256 r) {
        PairAsset storage pair = pairAssets[pairToken];
        if (!pair.approved) revert PairNotApproved(pairToken);
        if (virtualQuote == 0 && graduationQuote == 0) return (pair.virtualQuote, pair.graduationQuote);
        if (virtualQuote == 0 || graduationQuote == 0) revert InvalidCurve();
        if (pair.maxGraduationQuote == 0) revert CustomCurvesOff(pairToken);
        if (graduationQuote < pair.minGraduationQuote || graduationQuote > pair.maxGraduationQuote) revert RaiseOutOfBounds(graduationQuote, pair.minGraduationQuote, pair.maxGraduationQuote);
        LaunchConfig storage cfg = launchConfigs[configId];
        uint256 ratio = CurveMath.mulDiv(graduationQuote, BPS, virtualQuote);
        if (ratio < cfg.minRatioBps || ratio > cfg.maxRatioBps) revert RatioOutOfBounds(ratio, cfg.minRatioBps, cfg.maxRatioBps);
        return (virtualQuote, graduationQuote);
    }

    /// @notice The curve numbers that start a launch at `startFdv` and graduate it at `graduationFdv` (both in the pair
    /// asset's units, for the whole supply). The shape is fixed by the FDV multiple alone: with
    /// rho = sqrt(graduationFdv / startFdv) - 1, virtualQuote = startFdv (1 + rho)^2 / (rho (2 + rho)) and
    /// graduationQuote = rho virtualQuote. The supply does not enter; it only scales the token count.
    function curveForTargets(uint256 startFdv, uint256 graduationFdv) public pure returns (uint256 virtualQuote, uint256 graduationQuote) {
        if (startFdv == 0 || graduationFdv <= startFdv) revert InvalidCurve();
        uint256 rho = CurveMath.sqrt(CurveMath.mulDiv(graduationFdv, ONE * ONE, startFdv)) - ONE;
        if (rho == 0) revert InvalidCurve();
        uint256 onePlus = ONE + rho;
        virtualQuote = CurveMath.mulDiv(startFdv, onePlus * onePlus, rho * (2 * ONE + rho));
        graduationQuote = CurveMath.mulDiv(virtualQuote, rho, ONE);
        if (virtualQuote == 0 || graduationQuote == 0) revert InvalidCurve();
    }

    /// @notice What a curve means: the FDV (whole supply at the curve's price) at the start and at graduation, in the pair asset.
    function fdvFor(uint256 configId, address pairToken, uint256 virtualQuote, uint256 graduationQuote) external view returns (uint256 startFdv, uint256 graduationFdv) {
        (uint256 vq, uint256 r) = curveNumbers(configId, pairToken, virtualQuote, graduationQuote);
        (uint256 supply, uint256 sellSupply,, uint256 virtualToken) = _plannedSupply(configId, vq, r);
        startFdv = CurveMath.mulDiv(supply, vq, virtualToken);
        graduationFdv = CurveMath.mulDiv(supply, vq + r, virtualToken - sellSupply);
    }

    /// @notice How a launch's total supply splits between the curve position and the upper position: the upper share
    /// is sized so the market above graduation opens with the liquidity a full-range pool of the raise would have,
    /// `lpSupply = supply * Vq / (2 Vq + R)` (that is `sellSupply * Vq / (Vq + R)`), and the curve sells the rest --
    /// Pump.fun's 793 M / 207 M at its 30 : 85 shape.
    function plannedSupply(uint256 configId, address pairToken, uint256 virtualQuote, uint256 graduationQuote) public view returns (uint256 supply, uint256 sellSupply, uint256 lpSupply, uint256 virtualToken) {
        (uint256 vq, uint256 r) = curveNumbers(configId, pairToken, virtualQuote, graduationQuote);
        return _plannedSupply(configId, vq, r);
    }

    function _plannedSupply(uint256 configId, uint256 vq, uint256 r) internal view returns (uint256 supply, uint256 sellSupply, uint256 lpSupply, uint256 virtualToken) {
        supply = launchConfigs[configId].totalSupply;
        lpSupply = CurveMath.mulDiv(supply, vq, 2 * vq + r);
        sellSupply = supply - lpSupply;
        virtualToken = CurveMath.mulDiv(sellSupply, vq + r, r);
    }

    /// @notice The pool a launch with these numbers gets: its orientation, opening price, start and graduation ticks
    /// and the liquidity of its two positions. The curve position holds `sellSupply` between the ticks; the price
    /// path through it is the virtual-reserve curve's, rounded to the tick spacing.
    function planFor(address token, uint256 configId, address pairToken, uint256 virtualQuote, uint256 graduationQuote) public view returns (Plan memory plan) {
        (uint256 vq, uint256 r) = curveNumbers(configId, pairToken, virtualQuote, graduationQuote);
        (, uint256 sellSupply, uint256 lpSupply, uint256 virtualToken) = _plannedSupply(configId, vq, r);
        return _plan(token < pairToken, launchConfigs[configId].tickSpacing, vq, r, sellSupply, lpSupply, virtualToken);
    }

    function _plan(bool tokenIs0, int24 spacing, uint256 vq, uint256 r, uint256 sellSupply, uint256 lpSupply, uint256 virtualToken) internal pure returns (Plan memory plan) {
        plan.tokenIs0 = tokenIs0;
        // The opening and graduation prices as the pool quotes them (currency1 per currency0).
        uint160 sqrtA = tokenIs0 ? V4Math.sqrtPriceForAmounts(virtualToken, vq) : V4Math.sqrtPriceForAmounts(vq, virtualToken);
        uint160 sqrtB = tokenIs0 ? V4Math.sqrtPriceForAmounts(virtualToken - sellSupply, vq + r) : V4Math.sqrtPriceForAmounts(vq + r, virtualToken - sellSupply);
        int24 tickA = V4Math.alignDown(V4Math.getTickAtSqrtPrice(sqrtA), spacing);
        int24 tickB = V4Math.alignDown(V4Math.getTickAtSqrtPrice(sqrtB), spacing);
        (int24 lo, int24 hi) = V4Math.fullRange(spacing);
        if (tokenIs0) {
            // The coin's price rises with the tick: the curve runs from tickA up to tickB, the rest sits above tickB.
            if (tickB <= tickA) revert RangeTooNarrow(tickA, tickB);
            plan.startTick = tickA;
            plan.graduationTick = tickB;
            plan.curveTicks = [tickA, tickB];
            plan.upperTicks = [tickB, hi];
            plan.sqrtStart = V4Math.getSqrtPriceAtTick(tickA);
            plan.curveLiquidity = _fit0(V4Math.getSqrtPriceAtTick(tickA), V4Math.getSqrtPriceAtTick(tickB), sellSupply);
            plan.upperLiquidity = tickB < hi ? _fit0(V4Math.getSqrtPriceAtTick(tickB), V4Math.getSqrtPriceAtTick(hi), lpSupply) : 0;
        } else {
            // The pool quotes coins per pair asset, which falls as the coin is bought: the curve runs from tickA down to tickB.
            if (tickA <= tickB) revert RangeTooNarrow(tickA, tickB);
            plan.startTick = tickA;
            plan.graduationTick = tickB;
            plan.curveTicks = [tickB, tickA];
            plan.upperTicks = [lo, tickB];
            plan.sqrtStart = V4Math.getSqrtPriceAtTick(tickA);
            plan.curveLiquidity = _fit1(V4Math.getSqrtPriceAtTick(tickB), V4Math.getSqrtPriceAtTick(tickA), sellSupply);
            plan.upperLiquidity = tickB > lo ? _fit1(V4Math.getSqrtPriceAtTick(lo), V4Math.getSqrtPriceAtTick(tickB), lpSupply) : 0;
        }
    }

    /// @dev The largest liquidity `amount` of token0 funds over [sqrtA, sqrtB] whose mint (rounded up) still fits in `amount`.
    function _fit0(uint160 sqrtA, uint160 sqrtB, uint256 amount) internal pure returns (uint128 liquidity) {
        uint256 l = V4Math.liquidityForAmount0(sqrtA, sqrtB, amount);
        if (l > type(uint128).max) l = type(uint128).max;
        while (l > 0 && V4Math.amount0Delta(sqrtA, sqrtB, l) > amount) l -= l / 1_000_000_000 + 1;
        return uint128(l);
    }

    /// @dev The same for token1.
    function _fit1(uint160 sqrtA, uint160 sqrtB, uint256 amount) internal pure returns (uint128 liquidity) {
        uint256 l = V4Math.liquidityForAmount1(sqrtA, sqrtB, amount);
        if (l > type(uint128).max) l = type(uint128).max;
        while (l > 0 && V4Math.amount1Delta(sqrtA, sqrtB, l) > amount) l -= l / 1_000_000_000 + 1;
        return uint128(l);
    }

    /// @notice The address `launch` will give the coin for these parameters (vanity salts are ground against this).
    function predictToken(string calldata name, string calldata symbol, string calldata metadataURI, uint256 configId, address pairToken, uint256 virtualQuote, uint256 graduationQuote, bytes32 salt) external view returns (address) {
        (uint256 supply,,,) = plannedSupply(configId, pairToken, virtualQuote, graduationQuote);
        return tokenDeployer.predict(salt, LaunchTokenDeployer.TokenSpec({name: name, symbol: symbol, supply: supply, engine: ruleEngine, metadataURI: metadataURI}));
    }

    // ------------------------------------------------------------------ launching

    /// @notice Creates the coin, its pool and its liquidity, installs the rules and makes the creator's first buy.
    /// `msg.value` = the launch fee, plus the dev buy for an ETH pair (an ERC-20 dev buy is pulled from the caller).
    function launch(LaunchParams calldata p) external payable nonReentrant returns (address token, bytes32 poolId) {
        if (!launchesOpen) revert LaunchesClosed();
        if (ruleEngine == address(0) || locker == address(0) || router == address(0) || address(tokenDeployer) == address(0)) revert ZeroAddress();
        LaunchConfig storage cfg = launchConfigs[p.configId];
        if (!cfg.enabled) revert ConfigDisabled(p.configId);
        if (p.creator == address(0) || p.creatorFeeRecipient == address(0) || p.devBuyRecipient == address(0)) revert ZeroAddress();
        if (p.taxBps != 0 && (p.taxBps < cfg.minTaxBps || p.taxBps > cfg.maxTaxBps)) revert TaxOutOfBounds(p.taxBps, cfg.minTaxBps, cfg.maxTaxBps);
        for (uint256 i = 0; i < p.rules.rules.length; i++) if (p.rules.rules[i].kind == KIND_TITHE) revert UnsupportedRule(KIND_TITHE);
        uint256 expectedValue = launchFee + (p.pairToken == address(0) ? p.devBuyQuote : 0);
        if (msg.value != expectedValue) revert LaunchFeeMismatch(expectedValue, msg.value);
        (uint256 vq, uint256 r) = curveNumbers(p.configId, p.pairToken, p.virtualQuote, p.graduationQuote);
        (uint256 supply, uint256 sellSupply, uint256 lpSupply, uint256 virtualToken) = _plannedSupply(p.configId, vq, r);
        // 1. The coin (minted to this factory) at its CREATE2 address.
        token = tokenDeployer.deploy(p.salt, LaunchTokenDeployer.TokenSpec({name: p.name, symbol: p.symbol, supply: supply, engine: ruleEngine, metadataURI: p.metadataURI}));
        // 2. The pool, opened at the start price, and the two positions the locker keeps forever.
        Plan memory plan = _plan(token < p.pairToken, cfg.tickSpacing, vq, r, sellSupply, lpSupply, virtualToken);
        Fees memory f = _fees(cfg, p.taxBps);
        PoolKey memory key = PoolKey({currency0: plan.tokenIs0 ? token : p.pairToken, currency1: plan.tokenIs0 ? p.pairToken : token, fee: f.curveFee, tickSpacing: cfg.tickSpacing, hooks: address(0)});
        poolId = V4Math.poolId(key);
        IPoolManager(poolManager).initialize(key, plan.sqrtStart);
        // The graduation pool exists from the first block too, opened at the graduation price with no liquidity, so no one
        // else can open it at a price of their choosing; the locker fills it when the curve position empties.
        PoolKey memory graduationKey = PoolKey({currency0: key.currency0, currency1: key.currency1, fee: f.poolFee, tickSpacing: cfg.tickSpacing, hooks: address(0)});
        bytes32 graduationPoolId = V4Math.poolId(graduationKey);
        if (V4Math.sqrtPriceX96(IPoolManager(poolManager), graduationPoolId) == 0) IPoolManager(poolManager).initialize(graduationKey, V4Math.getSqrtPriceAtTick(plan.graduationTick));
        launches[token] = Launch({
            creator: p.creator,
            creatorFeeRecipient: p.creatorFeeRecipient,
            pairToken: p.pairToken,
            configId: p.configId,
            createdAt: uint64(block.timestamp),
            graduatedAt: 0,
            curvePoolId: poolId,
            poolId: poolId,
            curveFee: f.curveFee,
            poolFee: f.poolFee,
            tickSpacing: cfg.tickSpacing,
            startTick: plan.startTick,
            graduationTick: plan.graduationTick,
            taxBps: p.taxBps,
            curveShareBps: f.curveShareBps,
            poolShareBps: f.poolShareBps
        });
        launchCount += 1;
        token.safeTransfer(locker, supply); // rules are not active yet
        ILaunchLocker(locker).lockLaunch(token, key, f.poolFee, plan.tokenIs0, plan.startTick, plan.graduationTick, plan.curveTicks, plan.curveLiquidity, plan.upperTicks, plan.upperLiquidity);
        // 3. Rules: the venue is the pool manager; the platform's wallets are exempt; then the token consults the engine.
        address[] memory platformExempt = new address[](4);
        platformExempt[0] = address(this);
        platformExempt[1] = locker;
        platformExempt[2] = platformRecipient;
        platformExempt[3] = p.creatorFeeRecipient;
        ILaunchRuleEngine(ruleEngine).install(token, poolManager, p.creator, supply, p.rules, platformExempt);
        ILaunchToken(token).activateRules();
        // 4. The launch fee, then the creator's first buy through the router.
        if (launchFee > 0) ILaunchFeeEscrow(escrow).credit{value: launchFee}(platformRecipient);
        emit Launched(token, p.creator, p.creatorFeeRecipient, p.pairToken, p.configId, poolId, graduationPoolId, supply, sellSupply, lpSupply, vq, r, plan.startTick, plan.graduationTick, f.curveFee, f.poolFee, p.taxBps);
        if (p.devBuyQuote > 0) {
            if (p.pairToken == address(0)) {
                uint256 before = address(this).balance - p.devBuyQuote;
                ILaunchSwapRouter(router).buy{value: p.devBuyQuote}(token, p.devBuyQuote, p.minDevBuyTokens, p.devBuyRecipient, block.timestamp);
                uint256 refund = address(this).balance - before; // an ETH buy the pool could not take in full comes back from the router
                if (refund > 0) msg.sender.sendValue(refund);
            } else {
                p.pairToken.safeTransferFrom(msg.sender, address(this), p.devBuyQuote);
                p.pairToken.forceApprove(router, p.devBuyQuote);
                ILaunchSwapRouter(router).buy(token, p.devBuyQuote, p.minDevBuyTokens, p.devBuyRecipient, block.timestamp);
                p.pairToken.forceApprove(router, 0);
                uint256 rest = IERC20(p.pairToken).balanceOf(address(this)); // a buy the pool could not take in full leaves the rest here
                if (rest > 0) p.pairToken.safeTransfer(msg.sender, rest);
            }
        }
    }

    /// @dev The router returns unused ETH of a dev buy here.
    receive() external payable {}

    // ------------------------------------------------------------------ fee recipients and reads

    /// @inheritdoc ILaunchFactory
    function feeRecipients(address token) external view override returns (LaunchTypes.FeeRecipients memory) {
        Launch storage l = launches[token];
        if (l.createdAt == 0) revert UnknownToken(token);
        // Fees collected before the graduation is recorded were earned in the curve pool (the locker collects the curve
        // pool's last fees inside the graduation, before it reports it).
        return LaunchTypes.FeeRecipients({creator: l.creatorFeeRecipient, platform: platformRecipient, platformShareBps: l.graduatedAt == 0 ? l.curveShareBps : l.poolShareBps});
    }

    /// @dev A launch's fee numbers (Fees), from the config and its tax.
    struct Fees {
        uint24 curveFee; // pips
        uint24 poolFee;
        uint16 curveShareBps;
        uint16 poolShareBps;
    }

    function _fees(LaunchConfig storage cfg, uint16 taxBps) internal view returns (Fees memory f) {
        uint256 curveBps = uint256(cfg.curveProtocolFeeBps) + (taxBps > 0 ? taxBps : cfg.curveCreatorFeeBps);
        uint256 poolBps = uint256(cfg.poolProtocolFeeBps) + cfg.poolCreatorFeeBps + taxBps;
        uint256 platformTax = uint256(taxBps) * cfg.taxPlatformShareBps / BPS; // the platform's bps of a tax
        f.curveFee = uint24(curveBps * 100);
        f.poolFee = uint24(poolBps * 100);
        f.curveShareBps = uint16((uint256(cfg.curveProtocolFeeBps) + platformTax) * BPS / curveBps);
        f.poolShareBps = uint16((uint256(cfg.poolProtocolFeeBps) + platformTax) * BPS / poolBps);
    }

    /// @notice The fee numbers a launch with this tax gets on this config: both pools' fees (pips) and the platform's
    /// share of what each stage's fees collect.
    function feesFor(uint256 configId, uint16 taxBps) external view returns (Fees memory) { return _fees(launchConfigs[configId], taxBps); }

    /// @notice The current creator fee recipient hands the role to another wallet; the locker credits the new one
    /// from the next collection on.
    function transferCreatorFeeRecipient(address token, address next) external {
        Launch storage l = launches[token];
        if (l.createdAt == 0) revert UnknownToken(token);
        if (msg.sender != l.creatorFeeRecipient) revert NotCreatorFeeRecipient();
        if (next == address(0)) revert ZeroAddress();
        emit CreatorFeeRecipientChanged(token, l.creatorFeeRecipient, next);
        l.creatorFeeRecipient = next;
    }

    /// @inheritdoc ILaunchFactory
    function poolKeyOf(address token) external view override returns (PoolKey memory key, bool tokenIs0) {
        Launch storage l = launches[token];
        if (l.createdAt == 0) revert UnknownToken(token);
        tokenIs0 = token < l.pairToken;
        key = PoolKey({currency0: tokenIs0 ? token : l.pairToken, currency1: tokenIs0 ? l.pairToken : token, fee: l.graduatedAt == 0 ? l.curveFee : l.poolFee, tickSpacing: l.tickSpacing, hooks: address(0)});
    }

    function graduated(address token) external view returns (bool) { return launches[token].graduatedAt != 0; }

    // ------------------------------------------------------------------ graduation (the locker only)

    /// @inheritdoc ILaunchFactory
    function graduationReached(address token, bytes32 graduationPoolId) external override {
        if (msg.sender != locker || locker == address(0)) revert NotLocker();
        Launch storage l = launches[token];
        if (l.createdAt == 0) revert UnknownToken(token);
        if (l.graduatedAt != 0) return;
        l.graduatedAt = uint64(block.timestamp);
        l.poolId = graduationPoolId;
        ILaunchToken(token).markGraduated();
        ILaunchRuleEngine(ILaunchToken(token).engine()).deactivate(token);
        emit Graduated(token, l.curvePoolId, graduationPoolId);
    }
}
