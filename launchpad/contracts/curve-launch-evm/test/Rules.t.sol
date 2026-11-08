// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchFixture} from "./utils/LaunchFixture.sol";
import {ExactOutBuyer} from "./utils/ExactOutBuyer.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {LaunchRuleEngine} from "../src/LaunchRuleEngine.sol";
import {LaunchTypes} from "../src/interfaces/ILaunch.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {MockERC20} from "./mocks/MockTokens.sol";
import {Oscillator} from "../src/lib/Oscillator.sol";

/// @notice A contract that moves tokens on a wallet's behalf (a router): what `dex_only` lets through.
contract Forwarder {
    function move(address token, address from, address to, uint256 amount) external {
        require(IERC20(token).transferFrom(from, to, amount), "move");
    }
}

/// @notice Every ported rule, accepted and refused, through real launches on the fixture (v71.41: the venue is the
/// Uniswap v4 PoolManager; a buy is the pool manager's transfer to the buyer, a sell the trader's transfer into it).
contract RulesTest is LaunchFixture {
    ExactOutBuyer internal buyer;

    uint256 internal constant TUE_JAN6_1500_UTC = 1767711600; // 10:00 New York, open
    uint256 internal constant TUE_JAN6_2200_UTC = 1767736800; // 17:00 New York, closed
    uint256 internal constant MON_JAN19_1500_UTC = 1768834800; // Martin Luther King Jr. Day, 10:00 New York
    uint256 internal constant SAT_JAN10_1500_UTC = 1768057200;
    uint256 internal constant TUE_JUL7_1400_UTC = 1783432800; // 10:00 New York in summer time, open
    uint256 internal constant TUE_JUL7_1300_UTC = 1783429200; // 09:00 New York in summer time, closed
    uint256 internal constant TUE_JAN6_1200_UTC = 1767700800;
    uint256 internal constant TUE_JAN6_1700_UTC = 1767718800;

    // Uniswap v4 wraps a token's revert during `take` (CurrencyLibrary.transfer → CustomRevert.bubbleUpAndRevertWith):
    // WrappedError(token, transfer.selector, RuleRefused(kind), ERC20TransferFailed()).
    bytes4 internal constant WRAPPED_ERROR = bytes4(keccak256("WrappedError(address,bytes4,bytes,bytes)"));
    bytes4 internal constant ERC20_TRANSFER_FAILED = bytes4(keccak256("ERC20TransferFailed()"));

    function setUp() public override {
        super.setUp();
        buyer = new ExactOutBuyer(address(factory));
        vm.label(address(buyer), "ExactOutBuyer");
    }

    function refused(uint8 kind) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(LaunchRuleEngine.RuleRefused.selector, kind);
    }

    function refusedBuy(LaunchToken token, uint8 kind) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(WRAPPED_ERROR, address(token), IERC20.transfer.selector, refused(kind), abi.encodeWithSelector(ERC20_TRANSFER_FAILED));
    }

    /// @dev Buys exactly `bps` of the supply for `who` (an exact-output swap; the ETH not needed comes back).
    function buyShare(LaunchToken token, address who, uint256 bps) internal returns (uint256) {
        return buyShareFor(token, who, bps, who);
    }

    function buyShareFor(LaunchToken token, address who, uint256 bps, address recipient) internal returns (uint256 tokens) {
        tokens = pct(bps);
        vm.prank(who);
        buyer.buyExact{value: 500 ether}(address(token), tokens, recipient);
    }

    function expectBuyRefused(LaunchToken token, address who, uint256 bps, uint8 kind) internal {
        vm.prank(who);
        vm.expectRevert(refusedBuy(token, kind));
        buyer.buyExact{value: 500 ether}(address(token), pct(bps), who);
    }

    function expectSellRefused(LaunchToken token, address who, uint256 amount, uint8 kind) internal {
        vm.startPrank(who);
        token.approve(address(router), amount);
        vm.expectRevert(refused(kind));
        router.sell(address(token), amount, 0, who, block.timestamp);
        vm.stopPrank();
    }

    function expectSendRefused(LaunchToken token, address from, address to, uint256 amount, uint8 kind) internal {
        vm.prank(from);
        vm.expectRevert(refused(kind));
        token.transfer(to, amount);
    }

    // ---------------------------------------------------------------- installation rules

    function testInstallRefusesDuplicatesConflictsUnsupportedAndBadParams() public {
        LaunchTypes.RuleSetup memory setup = noRules();
        setup.rules = new LaunchTypes.Rule[](2);
        setup.rules[0] = LaunchTypes.Rule({kind: 7, p: params(100, 0, 0, 0, 0, 0)});
        setup.rules[1] = LaunchTypes.Rule({kind: 7, p: params(200, 0, 0, 0, 0, 0)});
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchRuleEngine.DuplicateRule.selector, uint8(7)));
        factory.launch{value: LAUNCH_FEE}(launchParams(setup, address(0), ETH_CONFIG, 0, 0));
        setup.rules[1] = LaunchTypes.Rule({kind: 9, p: params(100, 1e24, 0, 0, 0, 0)}); // max_per_wallet / chapters
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchRuleEngine.ConflictingRules.selector, uint8(7), uint8(9)));
        factory.launch{value: LAUNCH_FEE}(launchParams(setup, address(0), ETH_CONFIG, 0, 0));
        for (uint8 kind = 26; kind <= 27; kind++) {
            vm.prank(creator);
            vm.expectRevert(abi.encodeWithSelector(LaunchRuleEngine.InvalidRuleParams.selector, kind));
            factory.launch{value: LAUNCH_FEE}(launchParams(oneRule(kind, params(1, 0, 0, 0, 0, 0)), address(0), ETH_CONFIG, 0, 0));
        }
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchRuleEngine.InvalidRuleParams.selector, uint8(21)));
        factory.launch{value: LAUNCH_FEE}(launchParams(oneRule(21, params(0, 0, 0, 0, 0, 0)), address(0), ETH_CONFIG, 0, 0));
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchRuleEngine.InvalidRuleParams.selector, uint8(7)));
        factory.launch{value: LAUNCH_FEE}(launchParams(oneRule(7, params(10_001, 0, 0, 0, 0, 0)), address(0), ETH_CONFIG, 0, 0));
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchRuleEngine.InvalidRuleParams.selector, uint8(2)));
        factory.launch{value: LAUNCH_FEE}(launchParams(oneRule(2, params(1, 0, 0, 0, 0, 0)), address(0), ETH_CONFIG, 0, 0)); // no gate token
        setup.rules = new LaunchTypes.Rule[](5);
        for (uint8 i = 0; i < 5; i++) setup.rules[i] = LaunchTypes.Rule({kind: 10 + i, p: params(100, 1, 1, 1, 0, 0)});
        vm.prank(creator);
        vm.expectRevert(LaunchRuleEngine.TooManyRules.selector);
        factory.launch{value: LAUNCH_FEE}(launchParams(setup, address(0), ETH_CONFIG, 0, 0));
        assertTrue(engine.conflicts(4, 10) && engine.conflicts(10, 4) && !engine.conflicts(3, 25), "conflict table is symmetric");
    }

    function testOnlyTheTokenCanDriveItsOwnRules() public {
        (LaunchToken token,) = launchEth(oneRule(7, params(100, 0, 0, 0, 0, 0)), 0, 0);
        vm.expectRevert(LaunchRuleEngine.NotInstalledToken.selector);
        engine.onTransfer(alice, bob, 1, 0, 1, alice);
        vm.expectRevert(LaunchRuleEngine.NotFactory.selector);
        engine.deactivate(address(token));
        vm.expectRevert(LaunchToken.NotFactory.selector);
        token.markGraduated();
    }

    // ---------------------------------------------------------------- 1 allowlist · 17 blocklist · 2 holder-gated

    function testAllowlist() public {
        LaunchTypes.RuleSetup memory setup = oneRule(1, params(0, 0, 0, 0, 0, 0));
        setup.allowlist = new address[](1);
        setup.allowlist[0] = alice;
        (LaunchToken token,) = launchEth(setup, 0, 0);
        buyShare(token, alice, 50);
        expectBuyRefused(token, bob, 50, 1);
        expectSendRefused(token, alice, carol, 1e18, 1);
        send(token, alice, creator, 1e18); // an exempt receiver is always allowed
        address[] memory add = new address[](1);
        add[0] = bob;
        vm.prank(alice);
        vm.expectRevert(LaunchRuleEngine.NotCreator.selector);
        engine.setAllowed(address(token), add, true);
        vm.prank(creator);
        engine.setAllowed(address(token), add, true);
        buyShare(token, bob, 50);
        sell(token, bob, token.balanceOf(bob)); // selling into the venue is never gated
    }

    function testBlocklistIsSealedAtLaunch() public {
        LaunchTypes.RuleSetup memory setup = oneRule(17, params(0, 0, 0, 0, 0, 0));
        setup.blocklist = new address[](1);
        setup.blocklist[0] = bob;
        (LaunchToken token,) = launchEth(setup, 0, 0);
        buyShare(token, alice, 50);
        expectBuyRefused(token, bob, 50, 17);
        expectSendRefused(token, alice, bob, 1e18, 17);
        send(token, alice, carol, 1e18);
    }

    function testHolderGated() public {
        MockERC20 gate = new MockERC20("Gate", "GATE", 18);
        LaunchTypes.RuleSetup memory setup = oneRule(2, params(100e18, 0, 0, 0, 0, 0));
        setup.gateToken = address(gate);
        (LaunchToken token,) = launchEth(setup, 0, 0);
        gate.mint(alice, 100e18);
        gate.mint(bob, 99e18);
        buyShare(token, alice, 50);
        expectBuyRefused(token, bob, 50, 2);
        expectSendRefused(token, alice, bob, 1e18, 2);
        gate.mint(bob, 1e18);
        send(token, alice, bob, 1e18);
    }

    // ---------------------------------------------------------------- 3 holder vesting

    function testHolderVesting() public {
        // No early window, 1 h cliff, 25% every hour, every receipt counts.
        (LaunchToken token,) = launchEth(oneRule(3, params(0, 3600, 3600, 2500, 0, 0)), 0, 0);
        uint256 got = buyShare(token, alice, 100);
        (uint64 first, uint256 received) = engine.wallets(address(token), alice);
        assertEq(received, got, "receipt recorded");
        assertEq(first, block.timestamp, "clock started at the receipt");
        expectSellRefused(token, alice, 1, 3);
        vm.warp(block.timestamp + 3600);
        expectSellRefused(token, alice, got / 4 + 1e18, 3);
        sell(token, alice, got / 4);
        vm.warp(block.timestamp + 3 * 3600);
        sell(token, alice, token.balanceOf(alice)); // fully unlocked
        assertEq(token.balanceOf(alice), 0, "all sold");
    }

    function testHolderVestingEarlyWindowAndMinimum() public {
        // Only receipts in the first hour vest, and only those of at least 0.5% of supply.
        (LaunchToken token,) = launchEth(oneRule(3, params(3600, 3600, 3600, 2500, 5000, 0)), 0, 0);
        buyShare(token, bob, 10); // under the minimum: free
        sell(token, bob, token.balanceOf(bob));
        buyShare(token, alice, 100); // in the window: locked
        expectSellRefused(token, alice, 1, 3);
        vm.warp(block.timestamp + 3601);
        uint256 late = buyShare(token, carol, 100); // after the window: free
        sell(token, carol, late);
        uint256 more = buyShare(token, alice, 100); // a vesting wallet keeps vesting its later receipts
        (, uint256 received) = engine.wallets(address(token), alice);
        assertTrue(received > more, "later receipt added");
    }

    // ---------------------------------------------------------------- 4 anti-dump · 10 trade guard · 6 graduated sell caps · 5 sliding caps

    function testAntiDumpCaps() public {
        (LaunchToken token,) = launchEth(oneRule(4, params(200, 100, 0, 0, 0, 0)), 0, 0);
        expectBuyRefused(token, alice, 300, 4);
        buyShare(token, alice, 150);
        buyShare(token, alice, 150);
        expectSellRefused(token, alice, pct(120), 4);
        sell(token, alice, pct(90));
        expectSendRefused(token, alice, bob, pct(120), 4);
        send(token, alice, bob, pct(90));
    }

    function testTradeGuardCapsEveryDirection() public {
        (LaunchToken token,) = launchEth(oneRule(10, params(100, 0, 0, 0, 0, 0)), 0, 0);
        expectBuyRefused(token, alice, 150, 10);
        buyShare(token, alice, 50);
        buyShare(token, alice, 50);
        buyShare(token, alice, 50);
        expectSellRefused(token, alice, pct(120), 10);
        expectSendRefused(token, alice, bob, pct(120), 10);
        send(token, alice, bob, pct(90));
    }

    function testGraduatedSellCaps() public {
        // Small holders sell up to 5% in one go; bags of 10%+ only 1%.
        (LaunchToken token,) = launchEth(oneRule(6, params(500, 100, 1000, 0, 0, 0)), 0, 0);
        buyShare(token, alice, 200);
        sell(token, alice, pct(150)); // cap for a 2% bag: 5% − 4% × 0.2 = 4.2%
        buyShare(token, bob, 1200);
        expectSellRefused(token, bob, pct(150), 6);
        sell(token, bob, pct(90));
    }

    function testSlidingCaps() public {
        // Two levels: buys 2% then 10%, sells 1% then 5%, the step at 50% of the way to graduation.
        uint256 buys = 200 | (1000 << 16);
        uint256 sells = 100 | (500 << 16);
        uint256 breakpoints = 5000;
        (LaunchToken token,) = launchEth(oneRule(5, params(2, buys, sells, breakpoints, 0, 0)), 0, 0);
        expectBuyRefused(token, alice, 300, 5);
        buyShare(token, alice, 150);
        expectSellRefused(token, alice, pct(120), 5);
        sell(token, alice, pct(90));
        buy(token, creator, 45 ether); // the creator is exempt; the raise (net of fees) is now past half of R
        assertTrue(locker.progressBps(address(token)) >= 5000 && locker.progressBps(address(token)) < 8500, "past the breakpoint, with room left");
        buyShare(token, alice, 500);
        expectBuyRefused(token, alice, 1100, 5);
        sell(token, alice, pct(300));
    }

    // ---------------------------------------------------------------- 7 max per wallet · 8 rising · 9 chapters

    function testMaxPerWallet() public {
        (LaunchToken token,) = launchEth(oneRule(7, params(100, 0, 0, 0, 0, 0)), 0, 0);
        expectBuyRefused(token, alice, 150, 7);
        buyShare(token, alice, 50);
        expectBuyRefused(token, alice, 60, 7);
        buyShare(token, bob, 51);
        expectSendRefused(token, bob, alice, pct(51), 7); // alice would hold just over 1% (exactly 1% is allowed)
        send(token, bob, creator, pct(51)); // the creator is exempt from the cap
    }

    function testRisingMaxPerWallet() public {
        // Starts at 1%, rises by 1% every 10 minutes from the first trade.
        (LaunchToken token,) = launchEth(oneRule(8, params(100, 0, 100, 600, 0, 0)), 0, 0);
        expectBuyRefused(token, alice, 150, 8);
        buyShare(token, alice, 50); // starts the clock
        vm.warp(block.timestamp + 600);
        buyShare(token, alice, 120); // cap is 2% now
        expectBuyRefused(token, alice, 100, 8);
        vm.warp(block.timestamp + 1200);
        buyShare(token, alice, 150); // 4%
    }

    function testRisingMaxPerWalletDoubling() public {
        (LaunchToken token,) = launchEth(oneRule(8, params(100, 1, 0, 600, 0, 0)), 0, 0);
        buyShare(token, alice, 50);
        vm.warp(block.timestamp + 1800); // three intervals: 8%
        buyShare(token, alice, 700);
        expectBuyRefused(token, alice, 100, 8);
    }

    function testChapters() public {
        // 1% per wallet, doubling every 2% of supply bought by capped wallets (an exempt buy counts for nothing, as on Solana).
        (LaunchToken token,) = launchEth(oneRule(9, params(100, pct(200), 0, 0, 0, 0)), 0, 0);
        expectBuyRefused(token, alice, 150, 9);
        buyShare(token, alice, 90);
        buyShare(token, bob, 90);
        buyShare(token, creator, 500); // exempt: no cap, no volume
        expectBuyRefused(token, alice, 90, 9); // 1.8% of supply bought so far: still the first chapter, cap 1%
        buyShare(token, carol, 90); // 2.7%: the second chapter, cap 2%
        buyShare(token, alice, 90);
        expectBuyRefused(token, alice, 30, 9);
    }

    // ---------------------------------------------------------------- 11 anti-bundle · 12 venue-locked · 19 dex-only · 20 p2p-only

    function testAntiBundle() public {
        (LaunchToken token,) = launchEth(oneRule(11, params(2, 0, 0, 0, 0, 0)), 0, 0);
        buyShare(token, alice, 10);
        buyShare(token, bob, 10);
        expectBuyRefused(token, carol, 10, 11);
        send(token, alice, carol, 1e18); // sends are not pool trades
        vm.roll(block.number + 1);
        buyShare(token, carol, 10);
        sell(token, alice, 1e18);
        expectSellRefused(token, bob, 1e18, 11);
    }

    function testVenueLocked() public {
        (LaunchToken token,) = launchEth(oneRule(12, params(0, 0, 0, 0, 0, 0)), 0, 0);
        buyShare(token, alice, 50);
        expectSendRefused(token, alice, bob, 1e18, 12);
        send(token, alice, creator, 1e18); // to an exempt wallet
        sell(token, alice, 1e18);
    }

    function testDexOnly() public {
        (LaunchToken token,) = launchEth(oneRule(19, params(0, 0, 0, 0, 0, 0)), 0, 0);
        buyShare(token, alice, 50);
        expectSendRefused(token, alice, bob, 1e18, 19);
        Forwarder forwarder = new Forwarder();
        vm.prank(alice);
        token.approve(address(forwarder), 1e18);
        forwarder.move(address(token), alice, bob, 1e18); // moved by a contract
        assertEq(token.balanceOf(bob), 1e18, "routed send");
        sell(token, alice, 1e18);
    }

    function testP2pOnly() public {
        (LaunchToken token,) = launchEth(oneRule(20, params(0, 0, 0, 0, 0, 0)), 0, 0);
        expectBuyRefused(token, alice, 50, 20);
        buyShareFor(token, alice, 50, creator); // the receiver is what counts: a buy for the creator passes
        assertTrue(token.balanceOf(creator) >= pct(50), "the creator received it");
    }

    function testP2pOnlyCreatorBuysAndHoldersPassItOn() public {
        (LaunchToken token,) = launchEth(oneRule(20, params(0, 0, 0, 0, 0, 0)), 0, 0);
        buyShare(token, creator, 500);
        send(token, creator, alice, pct(100));
        send(token, alice, bob, pct(50));
        expectSellRefused(token, alice, 1e18, 20);
    }

    // ---------------------------------------------------------------- 13 market hours · 22 trading hours

    function testMarketHours() public {
        (LaunchToken token,) = launchEth(oneRule(13, params(0, 0, 0, 0, 0, 0)), 0, 0);
        vm.warp(TUE_JAN6_1500_UTC);
        buyShare(token, alice, 50);
        vm.warp(TUE_JAN6_2200_UTC);
        expectBuyRefused(token, alice, 10, 13);
        expectSellRefused(token, alice, 1e18, 13);
        send(token, alice, bob, 1e18); // sends always work
        vm.warp(SAT_JAN10_1500_UTC);
        expectBuyRefused(token, alice, 10, 13);
        vm.warp(MON_JAN19_1500_UTC);
        expectBuyRefused(token, alice, 10, 13); // a holiday
        vm.warp(TUE_JUL7_1300_UTC);
        expectBuyRefused(token, alice, 10, 13); // 09:00 in summer time
        vm.warp(TUE_JUL7_1400_UTC);
        buyShare(token, alice, 10); // 10:00 in summer time
    }

    function testMarketHoursAfterHoursSellsAndHolidaysIgnored() public {
        (LaunchToken token,) = launchEth(oneRule(13, params(1, 1, 0, 0, 0, 0)), 0, 0);
        vm.warp(MON_JAN19_1500_UTC);
        buyShare(token, alice, 50); // holidays ignored
        vm.warp(TUE_JAN6_2200_UTC + 14 days);
        expectBuyRefused(token, alice, 10, 13);
        sell(token, alice, 1e18); // sells stay open after hours
    }

    function testTradingHours() public {
        // 10:00–16:00 UTC, Monday to Friday, no daylight saving.
        (LaunchToken token,) = launchEth(oneRule(22, params(600, 960, 31, 1440, 0, 0)), 0, 0);
        vm.warp(TUE_JAN6_1200_UTC);
        buyShare(token, alice, 50);
        vm.warp(TUE_JAN6_1700_UTC);
        expectBuyRefused(token, alice, 10, 22);
        expectSellRefused(token, alice, 1e18, 22);
        vm.warp(SAT_JAN10_1500_UTC);
        expectBuyRefused(token, alice, 10, 22);
    }

    // ---------------------------------------------------------------- 14 ping pong · 18 hot potato

    function testPingPong() public {
        (LaunchToken token,) = launchEth(oneRule(14, params(0, 0, 0, 0, 0, 0)), 0, 0);
        buyShare(token, alice, 50);
        expectBuyRefused(token, bob, 50, 14);
        sell(token, alice, 1e18);
        expectSellRefused(token, alice, 1e18, 14);
        buyShare(token, bob, 50);
        send(token, alice, bob, 1e18); // sends never take a turn
    }

    function testPingPongTurnFreesUpAndSmallTradesDoNotTakeIt() public {
        // Trades under 0.1% of supply do not take the turn; the turn frees after 10 minutes.
        (LaunchToken token,) = launchEth(oneRule(14, params(1000, 600, 0, 0, 0, 0)), 0, 0);
        buyShare(token, alice, 50);
        buyShare(token, bob, 5); // too small to take or need the turn
        expectBuyRefused(token, carol, 50, 14);
        vm.warp(block.timestamp + 600);
        buyShare(token, carol, 50);
    }

    function testHotPotato() public {
        (LaunchToken token,) = launchEth(oneRule(18, params(0, 0, 0, 0, 0, 0)), 0, 0);
        buyShare(token, alice, 50);
        expectSellRefused(token, alice, 1e18, 18);
        expectSendRefused(token, alice, bob, 1e18, 18);
        buyShare(token, bob, 50); // bob holds the potato now
        sell(token, alice, 1e18);
        expectSellRefused(token, bob, 1e18, 18);
    }

    function testHotPotatoGoesCold() public {
        (LaunchToken token,) = launchEth(oneRule(18, params(0, 600, 0, 0, 0, 0)), 0, 0);
        buyShare(token, alice, 50);
        expectSellRefused(token, alice, 1e18, 18);
        vm.warp(block.timestamp + 600);
        sell(token, alice, 1e18);
    }

    // ---------------------------------------------------------------- 15 breathing cap · 16 momentum · 23 resonance · 24 coupled resonator

    function testBreathingCap() public {
        // A 10-minute cycle around 1% with a 50% swing, floor 0.5%.
        (LaunchToken token,) = launchEth(oneRule(15, params(600, 100, 50, 50, 0, 0)), 0, 0);
        expectBuyRefused(token, alice, 120, 15); // before the clock starts the cap is the base
        buyShare(token, alice, 50); // starts the clock
        vm.warp(block.timestamp + 150); // quarter cycle: the peak, 1.5%
        buyShare(token, alice, 140);
        vm.warp(block.timestamp + 300); // three quarters: the trough, the 0.5% floor
        expectBuyRefused(token, alice, 70, 15);
        buyShare(token, alice, 40);
    }

    function testMomentumKicksAndDecays() public {
        // 10-minute oscillator, 1%/s damping, a full-cap buy adds 50% energy; base cap 1%, floor 0.5%.
        (LaunchToken token,) = launchEth(oneRule(16, params(600, 1, 50, 100, 50, 0)), 0, 0);
        expectBuyRefused(token, alice, 120, 16);
        buyShare(token, alice, 99); // (almost) a full buy: energy ~0.5
        (,,,,,,, Oscillator.State memory o) = engine.stateOf(address(token));
        assertApprox(o.energy, 500_000, 6_000, "half energy");
        vm.warp(block.timestamp + 150); // quarter period: sin = 1; energy decayed to 0.99^150 x 0.5 ~ 0.11
        expectBuyRefused(token, bob, 120, 16); // cap ~ 1.11%
        buyShare(token, bob, 105);
        vm.warp(block.timestamp + 1000); // long idle: energy gone, cap back at the base
        expectBuyRefused(token, carol, 105, 16);
    }

    function testResonanceOnTheBeat() public {
        // 10-minute beat; a buy on the beat adds its full energy and the cap widens at once (no sin term).
        (LaunchToken token,) = launchEth(oneRule(23, params(600, 1, 50, 100, 50, 0)), 0, 0);
        buyShare(token, alice, 99); // elapsed 0: on the beat
        (,,,,,,, Oscillator.State memory o) = engine.stateOf(address(token));
        assertApprox(o.energy, 500_000, 6_000, "full kick on the beat");
        buyShare(token, bob, 140); // cap = 1% * ~1.5; this full-size buy kicks the energy to ~1.0
        buyShare(token, bob, 190); // cap = 1% * ~2
        expectBuyRefused(token, bob, 210, 23);
        vm.warp(block.timestamp + 300); // half a beat later: off the beat, energy decayed to ~0.05
        buyShare(token, carol, 100);
        (,,,,,,, o) = engine.stateOf(address(token));
        assertTrue(o.energy < 100_000, "an off-beat buy adds almost nothing");
    }

    function testCoupledResonator() public {
        (LaunchToken token,) = launchEth(oneRule(24, params(600, 50, 1, 50, 100, 50)), 0, 0);
        buyShare(token, alice, 99);
        (,,,,,,, Oscillator.State memory o) = engine.stateOf(address(token));
        assertApprox(o.energy, 500_000, 6_000, "kick");
        assertEq(o.energy2, 0, "second oscillator still at rest");
        vm.warp(block.timestamp + 150);
        buyShare(token, bob, 10); // steps the oscillators
        (,,,,,,, o) = engine.stateOf(address(token));
        assertTrue(o.energy2 > 0 && o.energy2 < o.energy, "energy flowed into the second oscillator");
    }

    // ---------------------------------------------------------------- after graduation everything is free

    function testRulesStopAtGraduation() public {
        (LaunchToken token,) = launchEth(oneRule(7, params(100, 0, 0, 0, 0, 0)), 0, 0);
        buyShare(token, alice, 50);
        buy(token, creator, 100 ether); // the creator fills the curve position: the price is past the graduation tick
        assertTrue(locker.crossed(address(token)), "crossed");
        locker.graduate(address(token)); // anyone records it; the rules switch off
        assertTrue(token.graduated(), "graduated");
        send(token, creator, bob, pct(500)); // 5% into one wallet: no cap any more
        assertEq(token.balanceOf(bob), pct(500), "received");
    }
}
