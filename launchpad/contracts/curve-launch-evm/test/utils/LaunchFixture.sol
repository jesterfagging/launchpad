// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TestBase} from "./TestBase.sol";
import {LaunchFeeEscrow} from "../../src/LaunchFeeEscrow.sol";
import {LaunchFactory} from "../../src/LaunchFactory.sol";
import {LaunchLocker} from "../../src/LaunchLocker.sol";
import {LaunchSwapRouter} from "../../src/LaunchSwapRouter.sol";
import {LaunchTokenDeployer} from "../../src/LaunchDeployers.sol";
import {LaunchRuleEngine} from "../../src/LaunchRuleEngine.sol";
import {LaunchToken} from "../../src/LaunchToken.sol";
import {LaunchTypes} from "../../src/interfaces/ILaunch.sol";
import {IPoolManager, PoolKey} from "../../src/interfaces/IUniswapV4.sol";
import {V4Math} from "../../src/lib/V4Math.sol";
import {MockERC20} from "../mocks/MockTokens.sol";
import {PoolManager} from "../vendor/v4-core/src/PoolManager.sol";

/// @notice The deployed stack every launch test starts from: escrow, factory, locker, router, engine, the real
/// Uniswap v4 PoolManager (vendored from v4-core for tests only), one ETH launch config (1 billion supply, Raydium's
/// fee shape: 1.25% + 0.5% on the curve, 0.25% + 0.25% after graduation, a 1–3% holder tax with 5% to the platform,
/// tick spacing 10) and one USDG config. Both pair assets allow custom curves: a raise between
/// a hundredth and ten times the default (the Pump.fun-shaped 85 ETH; the $4k tier's 2.76 ETH must fit), a steepness (graduationQuote / virtualQuote) between 0.2 and 10.
///
/// The ETH default curve is Pump.fun's 30 : 85 shape (a 30 ETH phantom reserve, 85 ETH raised); the pool-native launch
/// turns it into a one-sided position between the curve's start and graduation prices, so the raise, the price path
/// and the supply split are the same numbers the virtual-reserve curve had.
abstract contract LaunchFixture is TestBase {
    LaunchFeeEscrow internal escrow;
    IPoolManager internal pm;
    LaunchFactory internal factory;
    LaunchLocker internal locker;
    LaunchSwapRouter internal router;
    LaunchTokenDeployer internal tokenDeployer;
    LaunchRuleEngine internal engine;
    MockERC20 internal usdg;

    address internal owner = address(0xA11CE);
    address internal platform = address(0xBEEF);
    address internal creator = address(0xC0FFEE);
    address internal feeWallet = address(0xFEE1);
    address internal alice = address(0xA1);
    address internal bob = address(0xB0B);
    address internal carol = address(0xCA201);
    address internal titheTo = address(0x717E);

    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant VQ = 30 ether;
    uint256 internal constant R = 85 ether;
    uint256 internal constant LP = 206896551724137931034482758; // SUPPLY * 30 / 145
    uint256 internal constant SELL = SUPPLY - LP;
    uint256 internal constant VT = 1073022312373225152129817445; // SELL * 115 / 85
    uint256 internal constant LAUNCH_FEE = 0.001 ether;
    uint256 internal constant ETH_CONFIG = 1;
    uint256 internal constant USDG_CONFIG = 2;
    uint256 internal constant USDG_VQ = 6_000e6;
    uint256 internal constant USDG_R = 17_000e6;
    int24 internal constant SPACING = 10;

    function setUp() public virtual {
        escrow = new LaunchFeeEscrow();
        pm = IPoolManager(address(new PoolManager(address(this))));
        usdg = new MockERC20("Global Dollar", "USDG", 6);
        factory = new LaunchFactory(owner, address(escrow), address(pm), platform);
        locker = new LaunchLocker(address(factory));
        router = new LaunchSwapRouter(address(factory));
        engine = new LaunchRuleEngine(address(factory));
        tokenDeployer = new LaunchTokenDeployer(address(factory));
        vm.startPrank(owner);
        factory.setLocker(address(locker));
        factory.setRouter(address(router));
        factory.setDeployers(address(tokenDeployer));
        factory.setRuleEngine(address(engine));
        factory.setLaunchConfig(ETH_CONFIG, launchConfig());
        factory.setLaunchConfig(USDG_CONFIG, launchConfig());
        factory.setPairAsset(address(0), LaunchFactory.PairAsset({approved: true, virtualQuote: VQ, graduationQuote: R, minGraduationQuote: R / 100, maxGraduationQuote: R * 10}));
        factory.setPairAsset(address(usdg), LaunchFactory.PairAsset({approved: true, virtualQuote: USDG_VQ, graduationQuote: USDG_R, minGraduationQuote: USDG_R / 20, maxGraduationQuote: USDG_R * 10}));
        factory.setLaunchFee(LAUNCH_FEE);
        factory.setLaunchesOpen(true);
        vm.stopPrank();
        vm.deal(creator, 1_000 ether);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);
        vm.label(creator, "creator");
        vm.label(alice, "alice");
        vm.label(bob, "bob");
        vm.label(carol, "carol");
        vm.label(address(pm), "PoolManager");
        vm.label(address(router), "LaunchSwapRouter");
        vm.label(address(locker), "LaunchLocker");
    }

    function launchConfig() internal pure returns (LaunchFactory.LaunchConfig memory) {
        return LaunchFactory.LaunchConfig({totalSupply: SUPPLY, curveProtocolFeeBps: 125, curveCreatorFeeBps: 50, poolProtocolFeeBps: 25, poolCreatorFeeBps: 25, taxPlatformShareBps: 500, minTaxBps: 100, maxTaxBps: 300, tickSpacing: SPACING, minRatioBps: 2_000, maxRatioBps: 100_000, enabled: true});
    }

    function noRules() internal pure returns (LaunchTypes.RuleSetup memory setup) {
        setup.rules = new LaunchTypes.Rule[](0);
        setup.allowlist = new address[](0);
        setup.blocklist = new address[](0);
        setup.exempt = new address[](0);
    }

    function oneRule(uint8 kind, uint256[6] memory p) internal pure returns (LaunchTypes.RuleSetup memory setup) {
        setup = noRules();
        setup.rules = new LaunchTypes.Rule[](1);
        setup.rules[0] = LaunchTypes.Rule({kind: kind, p: p});
    }

    function params(uint256 a, uint256 b, uint256 c, uint256 d, uint256 e, uint256 f) internal pure returns (uint256[6] memory p) {
        p[0] = a; p[1] = b; p[2] = c; p[3] = d; p[4] = e; p[5] = f;
    }

    function launchParams(LaunchTypes.RuleSetup memory rules, address pairToken, uint256 configId, uint256 devBuy, uint16 taxBps) internal view returns (LaunchFactory.LaunchParams memory p) {
        p.name = "Launchpad Coin";
        p.symbol = "LAUNCHPAD";
        p.metadataURI = "https://launchpad.example/token-metadata/LAUNCHPAD.json";
        p.creator = creator;
        p.creatorFeeRecipient = feeWallet;
        p.devBuyRecipient = creator;
        p.taxBps = taxBps;
        p.pairToken = pairToken;
        p.configId = configId;
        p.virtualQuote = 0;
        p.graduationQuote = 0;
        p.salt = keccak256(abi.encodePacked("salt", rules.rules.length, devBuy, taxBps, pairToken));
        p.devBuyQuote = devBuy;
        p.minDevBuyTokens = 0;
        p.rules = rules;
    }

    /// @dev Launches an ETH-paired coin from the creator with the given rules and dev buy. ETH is address(0), so the
    /// coin is always currency1: the pool quotes coins per ETH, falling as the coin is bought.
    function launchEth(LaunchTypes.RuleSetup memory rules, uint256 devBuy, uint16 taxBps) internal returns (LaunchToken token, bytes32 poolId) {
        LaunchFactory.LaunchParams memory p = launchParams(rules, address(0), ETH_CONFIG, devBuy, taxBps);
        vm.prank(creator);
        (address t, bytes32 id) = factory.launch{value: LAUNCH_FEE + devBuy}(p);
        token = LaunchToken(t);
        poolId = id;
    }

    /// @dev Launches a USDG-paired coin; `wantToken0` picks a salt that puts the coin below (currency0) or above
    /// (currency1) the USDG address, so both pool orientations are exercised.
    function launchUsdg(LaunchTypes.RuleSetup memory rules, uint256 devBuy, uint16 taxBps, bool wantToken0) internal returns (LaunchToken token, bytes32 poolId) {
        LaunchFactory.LaunchParams memory p = launchParams(rules, address(usdg), USDG_CONFIG, devBuy, taxBps);
        for (uint256 i = 0; i < 512; i++) {
            p.salt = keccak256(abi.encodePacked("usdg", i, rules.rules.length, devBuy, taxBps));
            address predicted = factory.predictToken(p.name, p.symbol, p.metadataURI, p.configId, p.pairToken, 0, 0, p.salt);
            if ((predicted < address(usdg)) == wantToken0) break;
        }
        if (devBuy > 0) {
            usdg.mint(creator, devBuy);
            vm.prank(creator);
            usdg.approve(address(factory), devBuy);
        }
        vm.prank(creator);
        (address t, bytes32 id) = factory.launch{value: LAUNCH_FEE}(p);
        token = LaunchToken(t);
        poolId = id;
    }

    function buy(LaunchToken token, address who, uint256 quote) internal returns (uint256 out) {
        vm.prank(who);
        out = router.buy{value: quote}(address(token), quote, 0, who, block.timestamp);
    }

    function buyFor(LaunchToken token, address who, uint256 quote, address recipient) internal returns (uint256 out) {
        vm.prank(who);
        out = router.buy{value: quote}(address(token), quote, 0, recipient, block.timestamp);
    }

    function buyUsdg(LaunchToken token, address who, uint256 quote) internal returns (uint256 out) {
        usdg.mint(who, quote);
        vm.startPrank(who);
        usdg.approve(address(router), quote);
        out = router.buy(address(token), quote, 0, who, block.timestamp);
        vm.stopPrank();
    }

    function sell(LaunchToken token, address who, uint256 tokens) internal returns (uint256 out) {
        vm.startPrank(who);
        token.approve(address(router), tokens);
        out = router.sell(address(token), tokens, 0, who, block.timestamp);
        vm.stopPrank();
    }

    function send(LaunchToken token, address from, address to, uint256 amount) internal {
        vm.prank(from);
        token.transfer(to, amount);
    }

    function pct(uint256 bps) internal pure returns (uint256) { return SUPPLY * bps / 10_000; }

    function sqrtPrice(bytes32 poolId) internal view returns (uint160) { return V4Math.sqrtPriceX96(pm, poolId); }
    function tickOf(bytes32 poolId) internal view returns (int24 tick) { (, tick) = V4Math.slot0(pm, poolId); }
    function launchOf(LaunchToken token) internal view returns (LaunchLocker.Launch memory) { return locker.launchOf(address(token)); }
}
