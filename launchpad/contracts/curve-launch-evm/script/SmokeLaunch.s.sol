// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "../test/utils/Vm.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {LaunchSwapRouter} from "../src/LaunchSwapRouter.sol";
import {LaunchFeeEscrow} from "../src/LaunchFeeEscrow.sol";
import {LaunchLocker} from "../src/LaunchLocker.sol";
import {LaunchToken} from "../src/LaunchToken.sol";
import {LaunchTypes} from "../src/interfaces/ILaunch.sol";

/// @notice A smoke test of a deployed stack on the real chain, for pennies (v71.41, the pool-native launch): the
/// broadcaster (who must still own the factory, so run it right after the deploy and before handing the factory to
/// the host) launches a tiny ETH coin with a raise of LAUNCHPAD_RH_SMOKE_RAISE_WEI (default 0.002 ETH), buys through the
/// Launchpad router, sells a tenth back, collects the pool's fees into the escrow, buys the rest of the curve position,
/// graduates (the liquidity moves into the 0.5% graduation pool) and trades once more there. The coin is a Uniswap v4 pool from its first block, so after this script it can also be
/// traded from the Uniswap app, GMGN or any wallet to confirm the third-party routes. The ETH pair's minimum raise is
/// lowered to 1 wei for the launch and put back afterwards; nothing else changes. Everything the script spends: the
/// launch fee (0.001 ETH by default), the raise plus its fees, and gas.
///
///   LAUNCHPAD_RH_FACTORY           the factory (required)
///   LAUNCHPAD_RH_SMOKE_RAISE_WEI   the raise (default 0.002 ether; the virtual quote is twice it)
///   LAUNCHPAD_RH_SMOKE_SYMBOL      the ticker (default SMOKE)
///
/// Run: forge script script/SmokeLaunch.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --broadcast --private-key $DEPLOYER_KEY --evm-version cancun
/// (`--evm-version cancun`: the chain's Uniswap v4 PoolManager uses transient storage, which forge's simulation only has from Cancun on;
/// without it the simulated `unlock` fails with NotActivated before anything is broadcast.)
contract SmokeLaunch {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    event SmokeResult(address token, bytes32 poolId, uint256 bought, uint256 soldFor, uint256 feesCollectedWei, bool graduated, uint256 creatorEscrowWei, uint256 platformEscrowWei);

    function run() external returns (address token, bytes32 poolId, bool graduated) {
        address factoryAddress = vm.envOr("LAUNCHPAD_RH_FACTORY", address(0));
        require(factoryAddress != address(0), "set LAUNCHPAD_RH_FACTORY");
        uint256 raise = vm.envOr("LAUNCHPAD_RH_SMOKE_RAISE_WEI", uint256(0.002 ether));
        string memory symbol = vm.envOr("LAUNCHPAD_RH_SMOKE_SYMBOL", string("SMOKE"));
        LaunchFactory factory = LaunchFactory(payable(factoryAddress));
        LaunchSwapRouter router = LaunchSwapRouter(payable(factory.router()));
        LaunchLocker locker = LaunchLocker(payable(factory.locker()));
        LaunchFeeEscrow escrow = LaunchFeeEscrow(payable(factory.escrow()));
        (bool approved, uint256 vq, uint256 r, uint256 minR, uint256 maxR) = factory.pairAssets(address(0));
        require(approved, "ETH is not an approved pair");
        require(factory.launchesOpen(), "launches are closed on the factory: setLaunchesOpen(true) first");
        require(address(router) != address(0) && address(locker) != address(0), "router and locker must be set");

        vm.startBroadcast();
        address me = msg.sender;
        require(factory.owner() == me, "the broadcaster must own the factory (run this before the handover)");
        // Let a tiny raise through for this one launch.
        factory.setPairAsset(address(0), LaunchFactory.PairAsset({approved: true, virtualQuote: vq, graduationQuote: r, minGraduationQuote: 1, maxGraduationQuote: maxR}));

        LaunchTypes.RuleSetup memory rules;
        rules.rules = new LaunchTypes.Rule[](0);
        rules.allowlist = new address[](0);
        rules.blocklist = new address[](0);
        rules.exempt = new address[](0);
        LaunchFactory.LaunchParams memory p;
        p.name = "Smoke Test";
        p.symbol = symbol;
        p.metadataURI = "";
        p.creator = me;
        p.creatorFeeRecipient = me;
        p.devBuyRecipient = me;
        p.taxBps = 0; // a Creator-mode coin: the flat creator fee; the collect below credits both the creator and the platform
        p.pairToken = address(0);
        p.configId = 1;
        p.virtualQuote = raise * 2; // a steepness of 0.5, inside the config's 0.2 - 10
        p.graduationQuote = raise;
        p.salt = keccak256(abi.encodePacked("smoke", me, block.timestamp));
        p.devBuyQuote = 0;
        p.minDevBuyTokens = 0;
        p.rules = rules;
        (token, poolId) = factory.launch{value: factory.launchFee()}(p);

        // A quarter of the raise through the router, a tenth of what came back sold again (approve the router first).
        uint256 bought = router.buy{value: raise / 4}(token, raise / 4, 0, me, block.timestamp + 600);
        LaunchToken(token).approve(address(router), bought / 10);
        uint256 soldFor = router.sell(token, bought / 10, 0, me, block.timestamp + 600);
        // The pool's fees so far, into the escrow (the coin-side fee of the sell is sold in the same call).
        (uint256 collected,) = locker.collect(token);
        // The rest of the curve position: the raise plus its 1.75% of fees, rounded up, and a little more for the rounding
        // of the ticks; the router returns what the pool cannot take.
        uint256 rest = (raise * 10_000) / 9_825 + raise / 20;
        router.buy{value: rest}(token, rest, 0, me, block.timestamp + 600);
        // The graduation: the curve pool's last fees collected, its liquidity moved into the 0.5% graduation pool.
        if (locker.crossed(token)) locker.graduate(token);
        graduated = LaunchToken(token).graduated();
        // One more trade in the graduation pool, through the same router (it follows the coin's pool).
        if (graduated) router.buy{value: raise / 100}(token, raise / 100, 0, me, block.timestamp + 600);
        // Put the pair's minimum raise back.
        factory.setPairAsset(address(0), LaunchFactory.PairAsset({approved: true, virtualQuote: vq, graduationQuote: r, minGraduationQuote: minR, maxGraduationQuote: maxR}));
        vm.stopBroadcast();

        LaunchLocker.Launch memory l = locker.launchOf(token);
        require(l.curvePoolId == poolId && l.positions.length > 0 && l.positions[0].liquidity > 0, "the locker does not hold the pool's positions");
        require(!graduated || l.poolId != poolId, "a graduated coin trades in its graduation pool");
        require(graduated, "the coin did not graduate: raise the extra in `rest` and run again, or call locker.graduate(token) once the price crosses");
        emit SmokeResult(token, poolId, bought, soldFor, collected, graduated, escrow.balanceOf(me), escrow.balanceOf(factory.platformRecipient()));
    }
}
