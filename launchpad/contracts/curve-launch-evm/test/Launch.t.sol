// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchFixture} from "./utils/LaunchFixture.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {LaunchLocker} from "../src/LaunchLocker.sol";
import {LaunchSwapRouter} from "../src/LaunchSwapRouter.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {LaunchRuleEngine} from "../src/LaunchRuleEngine.sol";
import {LaunchTypes} from "../src/interfaces/ILaunch.sol";
import {IPoolManager, IUnlockCallback, PoolKey, SwapParams} from "../src/interfaces/IUniswapV4.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {Ownable2Step} from "../src/lib/Ownable2Step.sol";
import {V4Math} from "../src/lib/V4Math.sol";
import {CurveMath} from "../src/lib/CurveMath.sol";
import {MockERC20} from "./mocks/MockTokens.sol";

/// @notice The pool-native launch (v71.41) against the real Uniswap v4 PoolManager: the coin, the curve pool and its
/// two locked positions from one call; buys and sells through the router from the first block; the curve position's
/// price path matching the virtual-reserve curve; fees collected into the escrow with Raydium's shape (1.25% + 0.5%
/// on the curve, 0.25% + 0.25% after graduation, a holder tax with 5% to the platform); the graduation moving the
/// liquidity into the 0.5% pool at the same price; both pool orientations; the owner's configuration.
contract LaunchTest is LaunchFixture {
    // ---------------------------------------------------------------- supply, addresses, the launch itself

    function testPlannedSupplyMatchesTheCurveMath() public view {
        (uint256 supply, uint256 sellSupply, uint256 lpSupply, uint256 virtualToken) = factory.plannedSupply(ETH_CONFIG, address(0), 0, 0);
        assertEq(supply, SUPPLY, "the whole supply, as configured");
        assertEq(lpSupply, LP, "upper supply = N * Vq / (2 Vq + R): Pump.fun's 206.9 M of a billion at 30 : 85");
        assertEq(sellSupply, SELL, "the curve position sells the rest: 793.1 M");
        assertEq(virtualToken, VT, "virtual token = S * (Vq + R) / R");
    }

    function testLaunchCreatesTokenPoolPositionsAndRules() public {
        LaunchFactory.LaunchParams memory p = launchParams(noRules(), address(0), ETH_CONFIG, 0, 0);
        address predicted = factory.predictToken(p.name, p.symbol, p.metadataURI, p.configId, p.pairToken, 0, 0, p.salt);
        LaunchFactory.Plan memory plan = factory.planFor(predicted, ETH_CONFIG, address(0), 0, 0);
        (LaunchToken token, bytes32 poolId) = launchEth(noRules(), 0, 0);
        assertEq(address(token), predicted, "CREATE2 prediction");
        assertTrue(SUPPLY - token.totalSupply() < 1e9, "minted once; a few wei of rounding burned at most");
        assertEq(token.balanceOf(address(pm)), token.totalSupply(), "the whole supply sits in the pool manager");
        assertEq(token.balanceOf(address(locker)), 0, "the locker keeps no coins");
        assertTrue(token.rulesActive(), "rules active");
        assertEq(token.engine(), address(engine), "engine");
        assertEq(keccak256(bytes(token.contractURI())), keccak256(bytes(p.metadataURI)), "ERC-7572 contractURI is the metadata document");
        assertEq(keccak256(bytes(token.tokenURI())), keccak256(bytes(p.metadataURI)), "ERC-1046 tokenURI is the same document");
        (PoolKey memory key, bool tokenIs0) = factory.poolKeyOf(address(token));
        assertTrue(!tokenIs0, "ETH (address zero) is currency0, the coin currency1");
        assertEq(key.currency0, address(0), "native ETH is currency0");
        assertEq(key.currency1, address(token), "the coin is currency1");
        assertEq(uint256(key.fee), 17500, "the curve pool: 1.25% for the platform (Launchpad's 1% and Raydium's 0.25% slot) plus the flat 0.5% creator fee");
        LaunchFactory.Fees memory fees = factory.feesFor(ETH_CONFIG, 0);
        assertEq(uint256(fees.poolFee), 5000, "the graduation pool: 0.25% LP fee (the platform's) + 0.25% creator fee");
        assertEq(uint256(fees.curveShareBps), 7142, "the platform's share of the curve pool's fees: 1.25 of 1.75");
        assertEq(uint256(fees.poolShareBps), 5000, "and half of the graduation pool's");
        (uint160 gradSqrt,) = V4Math.slot0(pm, V4Math.poolId(PoolKey({currency0: key.currency0, currency1: key.currency1, fee: 5000, tickSpacing: key.tickSpacing, hooks: address(0)})));
        assertEq(uint256(gradSqrt), uint256(V4Math.getSqrtPriceAtTick(plan.graduationTick)), "the graduation pool exists from the first block, opened at the graduation price, empty");
        assertEq(uint256(int256(key.tickSpacing)), uint256(int256(SPACING)), "tick spacing");
        assertEq(key.hooks, address(0), "no hooks: a plain pool every router trades");
        assertEq(V4Math.poolId(key), poolId, "pool id is the key's hash");
        LaunchLocker.Launch memory l = launchOf(token);
        assertEq(l.poolId, poolId, "locker knows the pool");
        assertEq(int256(l.startTick), int256(plan.startTick), "start tick as planned");
        assertEq(int256(l.graduationTick), int256(plan.graduationTick), "graduation tick as planned");
        assertTrue(l.startTick > l.graduationTick, "coins per ETH fall as the coin is bought: the curve runs downwards");
        assertEq(l.positions.length, 2, "two positions");
        assertEq(uint256(l.positions[0].liquidity), uint256(plan.curveLiquidity), "curve position liquidity");
        assertEq(uint256(l.positions[1].liquidity), uint256(plan.upperLiquidity), "upper position liquidity");
        assertEq(l.curvePoolId, poolId, "the curve pool is where it starts");
        assertEq(int256(tickOf(poolId)), int256(l.startTick), "the pool opened at the start tick");
        assertEq(uint256(V4Math.poolLiquidity(pm, poolId)), 0, "at the very start the curve position sits just outside the current tick; the first buy crosses into it");
        assertEq(escrow.balanceOf(platform), LAUNCH_FEE, "launch fee in the platform's escrow balance");
        assertTrue(engine.isExempt(address(token), creator), "creator exempt");
        assertTrue(engine.isExempt(address(token), address(locker)), "locker exempt");
        assertTrue(engine.isExempt(address(token), feeWallet), "fee wallet exempt");
        assertTrue(!engine.isExempt(address(token), address(pm)), "the pool manager is the venue, not an exempt wallet");
        assertEq(locker.progressBps(address(token)), 0, "nothing raised yet");
        assertEq(factory.graduated(address(token)), false, "not graduated");
        assertEq(factory.launchCount(), 1, "counted");
    }

    function testLaunchRefusesWrongValueClosedLaunchesUnknownPairsHighTaxAndTithe() public {
        LaunchFactory.LaunchParams memory p = launchParams(noRules(), address(0), ETH_CONFIG, 0, 0);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchFactory.LaunchFeeMismatch.selector, LAUNCH_FEE, LAUNCH_FEE - 1));
        factory.launch{value: LAUNCH_FEE - 1}(p);
        p.taxBps = 301;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchFactory.TaxOutOfBounds.selector, uint16(301), uint16(100), uint16(300)));
        factory.launch{value: LAUNCH_FEE}(p);
        p.taxBps = 99;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchFactory.TaxOutOfBounds.selector, uint16(99), uint16(100), uint16(300)));
        factory.launch{value: LAUNCH_FEE}(p);
        p.taxBps = 0;
        p.pairToken = address(0xDEAD);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchFactory.PairNotApproved.selector, address(0xDEAD)));
        factory.launch{value: LAUNCH_FEE}(p);
        p.pairToken = address(0);
        LaunchTypes.RuleSetup memory tithe = oneRule(25, params(100, 0, 0, 0, 0, 0));
        tithe.titheRecipient = titheTo;
        p.rules = tithe;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchFactory.UnsupportedRule.selector, uint8(25)));
        factory.launch{value: LAUNCH_FEE}(p);
        p.rules = noRules();
        vm.prank(owner);
        factory.setLaunchesOpen(false);
        vm.prank(creator);
        vm.expectRevert(LaunchFactory.LaunchesClosed.selector);
        factory.launch{value: LAUNCH_FEE}(p);
    }

    function testDevBuyGoesToTheCreatorThroughThePool() public {
        (LaunchToken token, bytes32 poolId) = launchEth(noRules(), 1 ether, 0);
        uint256 got = token.balanceOf(creator);
        assertTrue(got > 0, "the creator holds the first buy");
        assertTrue(tickOf(poolId) < launchOf(token).startTick, "the price moved: the pool is live from the launch transaction");
        assertApprox(got, cpmmTokensOut(1 ether, 0), got / 50, "the first buy prices as the virtual-reserve curve would (within 2%)");
        assertEq(address(factory).balance, 0, "nothing stays in the factory");
        assertEq(address(router).balance, 0, "nothing stays in the router");
    }

    // ---------------------------------------------------------------- trading through the router

    /// @dev The virtual-reserve curve's answer for a buy of `quote` from the current real raise `raised`: the yardstick
    /// the pool-native position must match (its range is that curve, rounded to the tick spacing).
    function cpmmTokensOut(uint256 quote, uint256 raised) internal pure returns (uint256) {
        uint256 net = quote - quote * 175 / 10_000; // the 1.75% curve-pool fee
        uint256 q = VQ + raised;
        uint256 t = VT - (VT - CurveMath.mulDiv(VQ * VT, 1, q)); // tokens left in the virtual reserve at `q`
        uint256 k = VQ * VT;
        return t - CurveMath.mulDivUp(k, 1, q + net);
    }

    function testBuysFollowTheCurveAndSellsPayBack() public {
        (LaunchToken token, bytes32 poolId) = launchEth(noRules(), 0, 0);
        uint256 out1 = buy(token, alice, 1 ether);
        assertApprox(out1, cpmmTokensOut(1 ether, 0), out1 / 50, "1 ETH buys what the curve would give (within 2%)");
        uint256 out2 = buy(token, bob, 5 ether);
        assertApprox(out2, cpmmTokensOut(5 ether, 1 ether), out2 / 50, "the next 5 ETH too, from where the first buy left the price");
        assertTrue(out2 < 5 * out1, "later buys get fewer coins: the price rose");
        assertTrue(tickOf(poolId) < launchOf(token).startTick, "the tick moved down the curve (coins per ETH fell)");
        uint256 progress = locker.progressBps(address(token));
        assertApprox(progress, 6 ether * 9825 / 10_000 * 10_000 / R, 150, "progress = quote raised / the raise, about 7%");
        uint256 bobEthBefore = bob.balance;
        uint256 back = sell(token, bob, out2);
        assertEq(bob.balance - bobEthBefore, back, "the sell pays ETH to the seller");
        assertTrue(back < 5 ether && back > 4.8 ether, "selling straight back returns the 5 ETH less two 1.75% fees and rounding");
        assertEq(token.balanceOf(bob), 0, "bob sold everything");
        // Slippage and deadline guards.
        uint256 wouldGet = quoteOut(token, alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LaunchSwapRouter.Slippage.selector, wouldGet, type(uint256).max));
        router.buy{value: 1 ether}(address(token), 1 ether, type(uint256).max, alice, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LaunchSwapRouter.Expired.selector, block.timestamp - 1));
        router.buy{value: 1 ether}(address(token), 1 ether, 0, alice, block.timestamp - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LaunchSwapRouter.ValueMismatch.selector, 1 ether, 0.5 ether));
        router.buy{value: 0.5 ether}(address(token), 1 ether, 0, alice, block.timestamp);
        vm.prank(alice);
        vm.expectRevert(LaunchSwapRouter.ZeroAddress.selector);
        router.buy{value: 1 ether}(address(token), 1 ether, 0, address(0), block.timestamp);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LaunchSwapRouter.UnknownToken.selector, address(0xDEAD)));
        router.buy{value: 1 ether}(address(0xDEAD), 1 ether, 0, alice, block.timestamp);
    }

    /// @dev What a buy of `quote` would return right now (a dry run on a snapshot).
    function quoteOut(LaunchToken token, address who, uint256 quote) internal returns (uint256 out) {
        uint256 snap = vm.snapshotState();
        vm.prank(who);
        out = router.buy{value: quote}(address(token), quote, 0, who, block.timestamp);
        vm.revertToState(snap);
    }

    function testSellsNeedTheRouterApproval() public {
        (LaunchToken token,) = launchEth(noRules(), 0, 0);
        uint256 got = buy(token, alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert();
        router.sell(address(token), got, 0, alice, block.timestamp);
        assertEq(sell(token, alice, got) > 0, true, "with the approval the sell goes through");
    }

    // ---------------------------------------------------------------- fees

    function testFeesCollectIntoTheEscrowSplitAndCoinFeesAreSold() public {
        // A holder-reward coin with a 2% tax: the curve pool charges 1.25% + 2% = 3.25%; of what it collects the platform
        // gets 1.25% plus 5% of the 2% = 1.35 of 3.25 (4153 bps), the holders' wallet the rest.
        (LaunchToken token,) = launchEth(noRules(), 0, 200);
        (PoolKey memory key,) = factory.poolKeyOf(address(token));
        assertEq(uint256(key.fee), 32500, "1.25% platform + 2% holder tax = a 3.25% curve pool");
        LaunchFactory.Fees memory fees = factory.feesFor(ETH_CONFIG, 200);
        assertEq(uint256(fees.curveShareBps), 4153, "platform share on the curve: (125 + 10) / 325");
        assertEq(uint256(fees.poolFee), 25000, "after graduation: 0.25% + 0.25% + the 2% tax");
        assertEq(uint256(fees.poolShareBps), 1400, "platform share after graduation: (25 + 10) / 250");
        uint256 got = buy(token, alice, 10 ether);
        sell(token, alice, got / 2);
        uint256 platformBefore = escrow.balanceOf(platform);
        (uint256 quote, uint256 coinsSold) = locker.collect(address(token));
        assertTrue(quote > 0, "ETH fees collected");
        assertTrue(coinsSold > 0, "the coin-side fees of the sell were sold into the pool");
        assertEq(token.balanceOf(address(locker)), 0, "the locker keeps no coins");
        assertEq(address(locker).balance, 0, "nor ETH");
        uint256 platformGot = escrow.balanceOf(platform) - platformBefore;
        uint256 creatorGot = escrow.balanceOf(feeWallet);
        assertEq(platformGot + creatorGot, quote, "everything collected is credited");
        assertEq(platformGot, quote * 4153 / 10_000, "the platform's share: its 1.25% and 5% of the tax");
        // The buy's fee was 3.25% of 10 ETH = 0.325 ETH, the sell's fee came in coins and was sold.
        assertTrue(quote >= 0.325 ether && quote < 0.55 ether, "about 0.325 ETH from the buy plus the sold coin fees");
        // Selling the coin-side fees is itself a swap of the pool, so it leaves the pool's fee on that sale (3.25% of the
        // coins sold) as the next collection's coin-side fees; nothing else is left.
        (uint256 again, uint256 againCoins) = locker.collect(address(token));
        assertTrue(againCoins <= coinsSold * 325 / 10_000 + 1 && again <= quote / 20, "only the fee of the fee sale was left");
        LaunchLocker.Launch memory l = launchOf(token);
        assertEq(uint256(l.positions[0].liquidity) + uint256(l.positions[1].liquidity), uint256(factory.planFor(address(token), ETH_CONFIG, address(0), 0, 0).curveLiquidity) + uint256(factory.planFor(address(token), ETH_CONFIG, address(0), 0, 0).upperLiquidity), "collecting never touches the liquidity");
    }

    function testCreatorModeFeesSplitLikeRaydium() public {
        // Creator mode: 1.75% on the curve, 1.25 of it the platform's (7142 bps), 0.5 the creator's.
        (LaunchToken token,) = launchEth(noRules(), 0, 0);
        buy(token, alice, 10 ether);
        uint256 platformBefore = escrow.balanceOf(platform);
        (uint256 quote,) = locker.collect(address(token));
        assertApprox(quote, 0.175 ether, 0.001 ether, "1.75% of 10 ETH");
        assertEq(escrow.balanceOf(platform) - platformBefore, quote * 7142 / 10_000, "the platform's 1.25% of the 1.75%");
        assertEq(escrow.balanceOf(feeWallet), quote - quote * 7142 / 10_000, "the creator's 0.5%");
    }

    function testFeeRecipientCanHandOverAndEscrowClaimsWork() public {
        (LaunchToken token,) = launchEth(noRules(), 0, 0);
        buy(token, alice, 10 ether);
        locker.collect(address(token));
        uint256 owed = escrow.balanceOf(feeWallet);
        assertTrue(owed > 0, "creator share accrued");
        vm.prank(alice);
        vm.expectRevert(LaunchFactory.NotCreatorFeeRecipient.selector);
        factory.transferCreatorFeeRecipient(address(token), alice);
        vm.prank(feeWallet);
        factory.transferCreatorFeeRecipient(address(token), carol);
        buy(token, bob, 10 ether);
        locker.collect(address(token));
        assertTrue(escrow.balanceOf(carol) > 0, "the new recipient gets the next fees");
        assertEq(escrow.balanceOf(feeWallet), owed, "the old one keeps what it had");
        uint256 before = alice.balance;
        vm.prank(feeWallet);
        escrow.claimAll(alice);
        assertEq(alice.balance - before, owed, "claimed to any address");
        assertEq(escrow.balanceOf(feeWallet), 0, "balance cleared");
    }

    // ---------------------------------------------------------------- graduation

    function testGraduationWhenThePriceCrossesTheTick() public {
        (LaunchToken token, bytes32 poolId) = launchEth(noRules(), 0, 0);
        vm.expectRevert(abi.encodeWithSelector(LaunchLocker.NotCrossed.selector, tickOf(poolId), launchOf(token).graduationTick));
        locker.graduate(address(token));
        // The curve position empties when R (85 ETH, net of the 1.75% fee) has gone in: a hair less does not cross, 2% more does.
        buy(token, alice, R * 10_000 / 9_825 - R / 100);
        assertTrue(!locker.crossed(address(token)), "1% short of the raise: still on the curve");
        assertTrue(locker.progressBps(address(token)) > 9_700 && locker.progressBps(address(token)) < 10_000, "progress just under 100%");
        buy(token, alice, R / 100 + R / 50);
        assertTrue(locker.crossed(address(token)), "past the graduation tick: the raise is the curve's R within 2%");
        assertEq(locker.progressBps(address(token)), 10_000, "progress capped at 100%");
        assertTrue(!token.graduated(), "nobody has recorded it yet");
        (PoolKey memory curveKey,) = factory.poolKeyOf(address(token));
        uint256 platformBefore = escrow.balanceOf(platform);
        uint256 pmEthBefore = address(pm).balance;
        locker.graduate(address(token));
        assertTrue(token.graduated(), "the token knows");
        assertTrue(!token.rulesActive(), "rules off");
        assertTrue(factory.graduated(address(token)), "the factory knows");
        LaunchLocker.Launch memory l = launchOf(token);
        assertTrue(l.graduatedAt == block.timestamp, "the locker recorded when");
        vm.expectRevert(abi.encodeWithSelector(LaunchLocker.AlreadyGraduated.selector, address(token)));
        locker.graduate(address(token));
        // The liquidity moved: the curve pool is empty, the graduation pool (the same pair at 0.5%) holds the raise and the
        // remaining supply as one full-range position at the price the curve pool had, plus a sliver for the rounding.
        (PoolKey memory key,) = factory.poolKeyOf(address(token));
        assertEq(uint256(key.fee), 5000, "the coin's pool is now the 0.5% graduation pool");
        assertEq(l.poolId, V4Math.poolId(key), "the locker's record says so");
        assertEq(l.curvePoolId, poolId, "and remembers where it started");
        assertEq(uint256(V4Math.poolLiquidity(pm, poolId)), 0, "the curve pool has no liquidity left");
        assertTrue(l.positions.length >= 1 && l.positions.length <= 3, "a full-range position and at most two slivers");
        assertTrue(l.positions[0].liquidity > 0, "the full-range position has liquidity");
        assertEq(uint256(V4Math.poolLiquidity(pm, l.poolId)), uint256(l.positions[0].liquidity), "the pool's active liquidity is the full-range position alone: the slivers sit next to the price, out of range");
        for (uint256 i = 1; i < l.positions.length; i++) assertTrue(l.positions[i].liquidity < l.positions[0].liquidity / 100, "a sliver is a rounding leftover, under 1% of the position");
        // The graduation pool holds the raise and the remaining supply: a full-range position at the graduation price is
        // exactly R : lpSupply (the curve's shape makes R / lpSupply the graduation price), so almost nothing is left over.
        assertApprox(token.balanceOf(address(pm)), LP, LP / 50, "the remaining supply (within 2%: the fee sale and the ticks' rounding)");
        (int24 lo, int24 hi) = V4Math.fullRange(SPACING);
        assertTrue(l.positions[0].tickLower == lo && l.positions[0].tickUpper == hi, "full range");
        (uint160 sqrtNew, int24 tickNew) = V4Math.slot0(pm, l.poolId);
        (uint160 sqrtOld,) = V4Math.slot0(pm, poolId);
        assertApprox(uint256(sqrtNew), uint256(sqrtOld), uint256(sqrtOld) / 1000, "the graduation pool opened at the curve pool's price (the fee sale moved it a hair)");
        assertTrue(tickNew < launchOf(token).graduationTick + SPACING, "past the graduation tick");
        assertEq(token.balanceOf(address(locker)), 0, "the locker keeps no coins");
        assertEq(address(locker).balance, 0, "nor ETH");
        assertApprox(address(pm).balance, pmEthBefore, pmEthBefore / 50, "the raise is still in the pool manager (less the fees collected)");
        assertTrue(escrow.balanceOf(platform) > platformBefore, "the curve pool's last fees were collected on the way");
        // The platform's share of those fees was the curve stage's (1.25 of 1.75), not the graduation pool's half.
        uint256 feesTaken = escrow.balanceOf(platform) - platformBefore + escrow.balanceOf(feeWallet);
        assertEq(escrow.balanceOf(platform) - platformBefore, feesTaken * 7142 / 10_000, "curve-stage split on the curve pool's fees");
        // Trading continues in the graduation pool through the same router, at 0.5%: a buy and its sale back lose about 1%.
        uint256 more = buy(token, bob, 5 ether);
        assertTrue(more > 0, "buys continue past graduation");
        uint256 back = sell(token, bob, more);
        assertTrue(back > 4.94 ether && back < 5 ether, "and sell back, two 0.5% fees apart");
        assertTrue(sell(token, alice, token.balanceOf(alice) / 10) > 0, "the early buyer sells into the raised ETH at 0.5% too");
        // Fees collected now split the graduation pool's way: half and half.
        uint256 platformMid = escrow.balanceOf(platform);
        uint256 creatorMid = escrow.balanceOf(feeWallet);
        (uint256 quote,) = locker.collect(address(token));
        assertTrue(quote > 0, "graduation-pool fees collected");
        assertEq(escrow.balanceOf(platform) - platformMid, quote * 5000 / 10_000, "half to the platform");
        assertEq(escrow.balanceOf(feeWallet) - creatorMid, quote - quote * 5000 / 10_000, "half to the creator");
        assertEq(uint256(curveKey.fee), 17500, "the curve pool's key was the 1.75% one");
    }

    function testGraduationRaiseMatchesTheCurveForBothTiers() public {
        // The $4k tier: a start FDV a fifth of the default's. Its raise must still be ~ sqrt(start * graduation) of the sell supply.
        (uint256 vq, uint256 r) = factory.curveForTargets(1 ether, 12.5 ether);
        LaunchFactory.LaunchParams memory p = launchParams(noRules(), address(0), ETH_CONFIG, 0, 0);
        p.virtualQuote = vq;
        p.graduationQuote = r;
        vm.prank(creator);
        (address t,) = factory.launch{value: LAUNCH_FEE}(p);
        LaunchToken token = LaunchToken(t);
        buy(token, alice, r * 10_000 / 9_825 - r / 100);
        assertTrue(!locker.crossed(address(token)), "1% short: not yet");
        buy(token, alice, r / 100 + r / 50);
        assertTrue(locker.crossed(address(token)), "the $4k-shaped curve graduates at its own raise, within 2%");
    }

    // ---------------------------------------------------------------- the other orientation and ERC-20 pairs

    function testUsdgPairInBothOrientations() public {
        for (uint256 i = 0; i < 2; i++) {
            bool tokenIs0 = i == 0;
            (LaunchToken token, bytes32 poolId) = launchUsdg(noRules(), 0, 100, tokenIs0);
            (PoolKey memory key, bool is0) = factory.poolKeyOf(address(token));
            assertEq(is0, tokenIs0, "orientation as requested");
            assertEq(tokenIs0 ? key.currency0 : key.currency1, address(token), "the coin's side");
            assertEq(uint256(key.fee), 22500, "1.25% + a 1% holder tax");
            LaunchLocker.Launch memory l = launchOf(token);
            if (tokenIs0) assertTrue(l.graduationTick > l.startTick, "USDG per coin rises: the curve runs upwards");
            else assertTrue(l.graduationTick < l.startTick, "coins per USDG fall: the curve runs downwards");
            uint256 out = buyUsdg(token, alice, 1_000e6);
            assertTrue(out > 0, "bought with USDG");
            assertEq(usdg.balanceOf(address(router)), 0, "the router keeps nothing");
            uint256 before = usdg.balanceOf(alice);
            uint256 back = sell(token, alice, out);
            assertEq(usdg.balanceOf(alice) - before, back, "USDG paid to the seller");
            assertTrue(back > 950e6 && back < 1_000e6, "back less two fees");
            // The sell left coin-side fees; collect them (sold into the pool) so the graduation moves principal only.
            (uint256 quote0, uint256 coins0) = locker.collect(address(token));
            assertTrue(quote0 > 0 && coins0 > 0, "fees in USDG, coin fees sold");
            buyUsdg(token, bob, USDG_R * 10_000 / 9_775 + 100e6);
            assertTrue(locker.crossed(address(token)), "graduated with USDG");
            uint256 escrowBefore = escrow.balanceOfToken(platform, address(usdg)) + escrow.balanceOfToken(feeWallet, address(usdg));
            locker.graduate(address(token));
            assertTrue(escrow.balanceOfToken(platform, address(usdg)) + escrow.balanceOfToken(feeWallet, address(usdg)) > escrowBefore, "the curve pool's last fees were credited in USDG");
            LaunchLocker.Launch memory g = launchOf(token);
            assertTrue(g.poolId != poolId && g.curvePoolId == poolId, "moved into the graduation pool");
            assertEq(uint256(V4Math.poolLiquidity(pm, poolId)), 0, "the curve pool is empty");
            assertTrue(V4Math.poolLiquidity(pm, g.poolId) > 0, "the graduation pool has the liquidity");
            (PoolKey memory gradKey,) = factory.poolKeyOf(address(token));
            assertEq(uint256(gradKey.fee), 15000, "0.25% + 0.25% + the 1% tax");
            assertEq(usdg.balanceOf(address(locker)), 0, "the locker keeps no USDG");
            uint256 more = buyUsdg(token, carol, 500e6);
            assertTrue(sell(token, carol, more) > 470e6, "trades continue in the graduation pool in both orientations");
            assertEq(int256(tickOf(poolId)) * 0, 0, "pool readable");
        }
    }

    // ---------------------------------------------------------------- the tiers and the owner's bounds

    function testCurveForTargetsStartsAndGraduatesAtTheRequestedFdv() public view {
        (uint256 vq, uint256 r) = factory.curveForTargets(20_000e6, 50_000e6);
        (uint256 startFdv, uint256 graduationFdv) = factory.fdvFor(USDG_CONFIG, address(usdg), vq, r);
        assertApprox(startFdv, 20_000e6, 20_000e6 / 1000, "starts at $20k");
        assertApprox(graduationFdv, 50_000e6, 50_000e6 / 1000, "graduates at $50k");
        (uint256 supply, uint256 sellSupply,,) = factory.plannedSupply(USDG_CONFIG, address(usdg), vq, r);
        assertEq(supply, SUPPLY, "supply fixed");
        assertApprox(r, sellSupply * CurveMath.sqrt(uint256(20_000e6) * 50_000e6) / SUPPLY, r / 1000, "the raise is sqrt(start * graduation) of the sold share");
    }

    function testCustomCurveBoundsAreEnforced() public {
        LaunchFactory.LaunchParams memory p = launchParams(noRules(), address(0), ETH_CONFIG, 0, 0);
        p.virtualQuote = VQ;
        p.graduationQuote = R * 11;
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchFactory.RaiseOutOfBounds.selector, R * 11, R / 100, R * 10));
        factory.launch{value: LAUNCH_FEE}(p);
        p.graduationQuote = R;
        p.virtualQuote = R * 10; // ratio 0.1 < 0.2
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchFactory.RatioOutOfBounds.selector, uint256(1_000), uint256(2_000), uint256(100_000)));
        factory.launch{value: LAUNCH_FEE}(p);
        p.virtualQuote = 0;
        vm.prank(creator);
        vm.expectRevert(LaunchFactory.InvalidCurve.selector);
        factory.launch{value: LAUNCH_FEE}(p);
    }

    function testOwnerConfigValidation() public {
        LaunchFactory.LaunchConfig memory cfg = launchConfig();
        cfg.tickSpacing = 0;
        vm.prank(owner);
        vm.expectRevert(LaunchFactory.InvalidConfig.selector);
        factory.setLaunchConfig(3, cfg);
        cfg = launchConfig();
        cfg.curveProtocolFeeBps = 1_001;
        vm.prank(owner);
        vm.expectRevert(LaunchFactory.InvalidBps.selector);
        factory.setLaunchConfig(3, cfg);
        cfg = launchConfig();
        cfg.minTaxBps = 400;
        vm.prank(owner);
        vm.expectRevert(LaunchFactory.InvalidBps.selector);
        factory.setLaunchConfig(3, cfg);
        cfg = launchConfig();
        cfg.taxPlatformShareBps = 10_001;
        vm.prank(owner);
        vm.expectRevert(LaunchFactory.InvalidBps.selector);
        factory.setLaunchConfig(3, cfg);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable2Step.OwnableUnauthorized.selector, alice));
        factory.setLaunchesOpen(false);
        vm.prank(owner);
        vm.expectRevert(LaunchFactory.LockerAlreadySet.selector);
        factory.setLocker(address(1));
        vm.prank(owner);
        vm.expectRevert(LaunchFactory.DeployersAlreadySet.selector);
        factory.setDeployers(address(1));
        vm.prank(alice);
        vm.expectRevert(LaunchFactory.NotLocker.selector);
        factory.graduationReached(address(0xDEAD), bytes32(0));
    }

    // ---------------------------------------------------------------- locked forever

    function testNothingRemovesLiquidityAndOnlyTheFactoryLocks() public {
        (LaunchToken token,) = launchEth(noRules(), 0, 0);
        (PoolKey memory key,) = factory.poolKeyOf(address(token));
        int24[2] memory ticks = [int24(0), int24(10)];
        vm.prank(alice);
        vm.expectRevert(LaunchLocker.NotFactory.selector);
        locker.lockLaunch(address(token), key, 5000, false, 0, 0, ticks, 1, ticks, 0);
        vm.prank(alice);
        vm.expectRevert(LaunchLocker.NotPoolManager.selector);
        locker.unlockCallback(abi.encode(uint8(1), address(token)));
        // The positions belong to the locker inside the pool manager; the locker exposes no way to shrink them, only to
        // move them into the graduation pool once the price has crossed, and that only once.
        LaunchLocker.Launch memory l = launchOf(token);
        assertTrue(l.positions.length == 2 && l.positions[0].liquidity > 0 && l.positions[1].liquidity > 0, "two positions");
        buy(token, alice, 3 ether);
        locker.collect(address(token));
        LaunchLocker.Launch memory after_ = launchOf(token);
        assertEq(uint256(after_.positions[0].liquidity), uint256(l.positions[0].liquidity), "unchanged by collect");
        assertEq(uint256(after_.positions[1].liquidity), uint256(l.positions[1].liquidity), "unchanged by collect");
        vm.expectRevert(abi.encodeWithSelector(LaunchLocker.NotCrossed.selector, tickOf(l.poolId), l.graduationTick));
        locker.graduate(address(token));
        assertEq(address(locker).balance, 0, "the locker holds nothing");
    }

    function testGraduationHandlesAPriceAlreadyPastTheTickAndAForeignGraduationPool() public {
        // Buyers kept going in the upper position before anyone recorded the graduation, and someone traded the graduation
        // pool (opened empty at launch) to a price of their own: the graduation still lands at the curve pool's price.
        (LaunchToken token, bytes32 poolId) = launchEth(noRules(), 0, 0);
        buy(token, alice, R * 10_000 / 9_825 + 10 ether); // well past the tick, into the upper position
        assertTrue(locker.crossed(address(token)), "crossed");
        (uint160 sqrtCurve,) = V4Math.slot0(pm, poolId);
        // A stranger moves the empty graduation pool's price far away (a swap of 1 wei against no liquidity just moves the price).
        (PoolKey memory key,) = factory.poolKeyOf(address(token));
        PoolKey memory gradKey = PoolKey({currency0: key.currency0, currency1: key.currency1, fee: 5000, tickSpacing: key.tickSpacing, hooks: address(0)});
        PriceMover mover = new PriceMover(pm);
        mover.move(gradKey, V4Math.getSqrtPriceAtTick(launchOf(token).startTick + 20_000));
        (uint160 sqrtForeign,) = V4Math.slot0(pm, V4Math.poolId(gradKey));
        assertTrue(sqrtForeign != sqrtCurve, "the graduation pool sits at a foreign price");
        locker.graduate(address(token));
        LaunchLocker.Launch memory l = launchOf(token);
        (uint160 sqrtAfter,) = V4Math.slot0(pm, l.poolId);
        assertApprox(uint256(sqrtAfter), uint256(sqrtCurve), uint256(sqrtCurve) / 1000, "the graduation pool was brought back to the curve pool's price");
        assertTrue(V4Math.poolLiquidity(pm, l.poolId) > 0, "and holds the liquidity");
        assertEq(uint256(V4Math.poolLiquidity(pm, poolId)), 0, "the curve pool is empty");
        assertEq(token.balanceOf(address(locker)), 0, "no coins left in the locker");
        assertEq(address(locker).balance, 0, "no ETH left in the locker");
        uint256 more = buy(token, bob, 1 ether);
        assertTrue(sell(token, bob, more) > 0.98 ether, "trading continues at 0.5%");
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzzTradesKeepTheBooks(uint96 a, uint96 b, uint16 sellBps) public {
        uint256 buyA = 0.01 ether + uint256(a) % 40 ether;
        uint256 buyB = 0.01 ether + uint256(b) % 40 ether;
        uint256 share = 1 + uint256(sellBps) % 10_000;
        (LaunchToken token,) = launchEth(noRules(), 0, 200);
        uint256 outA = buy(token, alice, buyA);
        uint256 toSell = outA * share / 10_000;
        uint256 back = toSell > 0 ? sell(token, alice, toSell) : 0;
        assertTrue(back <= buyA, "selling straight back (nobody else traded) never returns more than went in for that share");
        uint256 outB = buy(token, bob, buyB);
        assertEq(token.balanceOf(alice) + token.balanceOf(bob) + token.balanceOf(address(pm)), token.totalSupply(), "every coin is somewhere");
        uint256 ethIn = buyA + buyB;
        assertTrue(address(pm).balance <= ethIn, "the pool never holds more than it was paid");
        assertTrue(address(pm).balance + back >= ethIn - 1, "and never loses a wei: what left went to the seller");
        locker.collect(address(token));
        assertTrue(escrow.balanceOf(platform) + escrow.balanceOf(feeWallet) > LAUNCH_FEE, "fees credited");
        assertEq(outB * 0, 0, "ok");
    }
}

/// @dev A stranger's tool: swaps 1 wei against a pool with no liquidity, which only moves its price to the limit.
contract PriceMover is IUnlockCallback {
    IPoolManager internal immutable pm;
    PoolKey internal key;
    uint160 internal target;
    constructor(IPoolManager pm_) { pm = pm_; }
    receive() external payable {}
    function move(PoolKey memory key_, uint160 target_) external {
        key = key_;
        target = target_;
        pm.unlock("");
    }
    function unlockCallback(bytes calldata) external override returns (bytes memory) {
        (uint160 sqrtP,) = V4Math.slot0(pm, V4Math.poolId(key));
        bool zeroForOne = sqrtP > target;
        int256 delta = pm.swap(key, SwapParams({zeroForOne: zeroForOne, amountSpecified: -1, sqrtPriceLimitX96: target}), "");
        // Nothing to settle against an empty pool; whatever rounding asks for is paid in ETH if the pool wants it.
        int128 d0 = V4Math.amount0(delta);
        if (d0 < 0) pm.settle{value: uint256(uint128(-d0))}();
        return "";
    }
}
