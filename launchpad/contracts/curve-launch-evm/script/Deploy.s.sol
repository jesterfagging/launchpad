// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "../test/utils/Vm.sol";
import {LaunchFeeEscrow} from "../src/LaunchFeeEscrow.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {LaunchLocker} from "../src/LaunchLocker.sol";
import {LaunchRuleEngine} from "../src/LaunchRuleEngine.sol";
import {LaunchTokenDeployer} from "../src/LaunchDeployers.sol";
import {LaunchSwapRouter} from "../src/LaunchSwapRouter.sol";
import {LaunchPayouts} from "../src/LaunchPayouts.sol";

/// @notice Deploys the launch stack on Robinhood Chain (chain 4663) and configures it from the environment:
///
///   LAUNCHPAD_RH_PLATFORM_RECIPIENT   the Launchpad treasury that claims the platform share (required)
///   LAUNCHPAD_RH_OWNER                the factory owner (default: the deployer); a different owner must `acceptOwnership`
///   LAUNCHPAD_RH_POOL_MANAGER         the Uniswap v4 PoolManager on Robinhood Chain (default below)
///   LAUNCHPAD_RH_USDG                 the USDG token to approve as a pair asset (default below; 0 = skip)
///   LAUNCHPAD_RH_LAUNCH_FEE_WEI       the launch fee in wei (default 0.001 ETH)
///   LAUNCHPAD_RH_ETH_USD_CENTS        ETH's price in US cents at deploy time (required unless the ETH curve is given in wei):
///                                 the default ETH curve is the $20k -> $50k tier expressed in ETH at that price
///   LAUNCHPAD_RH_TIER_START_USD / LAUNCHPAD_RH_TIER_GRADUATION_USD       the default tier in whole dollars (20000 / 50000)
///   LAUNCHPAD_RH_ETH_VIRTUAL_WEI / LAUNCHPAD_RH_ETH_GRADUATION_WEI      the default ETH curve given directly instead (0 = from the tier)
///   LAUNCHPAD_RH_USDG_VIRTUAL / LAUNCHPAD_RH_USDG_GRADUATION             the default USDG curve in 6-decimal units (0 = the tier, exactly)
///   LAUNCHPAD_RH_CUSTOM_MIN_BPS / LAUNCHPAD_RH_CUSTOM_MAX_BPS            a custom raise may be this share of the default (500 / 100000 = 5% to 10x)
///   LAUNCHPAD_RH_MIN_RATIO_BPS / LAUNCHPAD_RH_MAX_RATIO_BPS              a custom curve's graduation / virtual quote (2000 / 100000 = 0.2 to 10)
///   LAUNCHPAD_RH_CURVE_PROTOCOL_FEE_BPS / LAUNCHPAD_RH_CURVE_CREATOR_FEE_BPS    the curve pool's fee parts (125 / 50)
///   LAUNCHPAD_RH_POOL_PROTOCOL_FEE_BPS / LAUNCHPAD_RH_POOL_CREATOR_FEE_BPS      the graduation pool's (25 / 25)
///   LAUNCHPAD_RH_TAX_PLATFORM_SHARE_BPS, LAUNCHPAD_RH_MIN_TAX_BPS, LAUNCHPAD_RH_MAX_TAX_BPS
///                                 the platform's share of a holder tax and the tax bounds (500, 100, 300)
///   LAUNCHPAD_RH_TICK_SPACING         the tick spacing the start and graduation prices round to (10)
///
/// The tiers the host offers (a $4k start and a $20k start, both graduating at $50k, as on Launchpad's Solana launches)
/// live in the Launchpad service: it turns the chosen tier into curve numbers with `curveForTargets` at the live ETH /
/// USDG price and passes them in each launch, inside the bounds set here. The on-chain defaults only serve a launch
/// that passes no numbers. The supply is a billion, split between the curve position and the upper position by the
/// tier (v71.41: every coin is a Uniswap v4 pool from its first block; the positions are locked in the locker).
///
/// Run: forge script script/Deploy.s.sol --rpc-url robinhood --broadcast --private-key $DEPLOYER_KEY
/// The Uniswap address is the one recorded in src/robinhood-contracts.mjs from the official deployment registry;
/// confirm it on robinhoodchain.blockscout.com before broadcasting.
contract Deploy {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant DEFAULT_POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant DEFAULT_USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint256 public constant ETH_CONFIG = 1;
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    function run() external returns (address escrow, address factory, address locker, address engine, address tokenDeployer, address router, address payouts) {
        address platform = vm.envOr("LAUNCHPAD_RH_PLATFORM_RECIPIENT", address(0));
        require(platform != address(0), "set LAUNCHPAD_RH_PLATFORM_RECIPIENT");
        address owner = vm.envOr("LAUNCHPAD_RH_OWNER", address(0));
        address poolManager = vm.envOr("LAUNCHPAD_RH_POOL_MANAGER", DEFAULT_POOL_MANAGER);
        address usdg = vm.envOr("LAUNCHPAD_RH_USDG", DEFAULT_USDG);
        uint256 launchFee = vm.envOr("LAUNCHPAD_RH_LAUNCH_FEE_WEI", uint256(0.001 ether));
        uint256 tierStartUsd = vm.envOr("LAUNCHPAD_RH_TIER_START_USD", uint256(20_000));
        uint256 tierGraduationUsd = vm.envOr("LAUNCHPAD_RH_TIER_GRADUATION_USD", uint256(50_000));
        uint256 ethUsdCents = vm.envOr("LAUNCHPAD_RH_ETH_USD_CENTS", uint256(0));
        uint256 ethVirtual = vm.envOr("LAUNCHPAD_RH_ETH_VIRTUAL_WEI", uint256(0));
        uint256 ethGraduation = vm.envOr("LAUNCHPAD_RH_ETH_GRADUATION_WEI", uint256(0));
        uint256 usdgVirtual = vm.envOr("LAUNCHPAD_RH_USDG_VIRTUAL", uint256(0));
        uint256 usdgGraduation = vm.envOr("LAUNCHPAD_RH_USDG_GRADUATION", uint256(0));
        uint256 customMinBps = vm.envOr("LAUNCHPAD_RH_CUSTOM_MIN_BPS", uint256(500));
        uint256 customMaxBps = vm.envOr("LAUNCHPAD_RH_CUSTOM_MAX_BPS", uint256(100_000));
        require(tierStartUsd > 0 && tierGraduationUsd > tierStartUsd, "tier: graduation must be above the start");
        require((ethVirtual > 0 && ethGraduation > 0) || ethUsdCents > 0, "set LAUNCHPAD_RH_ETH_USD_CENTS (ETH price in cents) or the ETH curve in wei");
        LaunchFactory.LaunchConfig memory cfg = LaunchFactory.LaunchConfig({
            totalSupply: TOTAL_SUPPLY,
            // Raydium's shape (v71.41): 1% Launchpad + Raydium's 0.25% slot on the curve, a flat 0.5% creator fee there;
            // after graduation a 0.25% LP fee (the platform's, the whole position being locked) and a 0.25% creator fee;
            // holder-reward coins carry a 1–3% tax in place of the creator fee, 5% of it the platform's.
            curveProtocolFeeBps: uint16(vm.envOr("LAUNCHPAD_RH_CURVE_PROTOCOL_FEE_BPS", uint256(125))),
            curveCreatorFeeBps: uint16(vm.envOr("LAUNCHPAD_RH_CURVE_CREATOR_FEE_BPS", uint256(50))),
            poolProtocolFeeBps: uint16(vm.envOr("LAUNCHPAD_RH_POOL_PROTOCOL_FEE_BPS", uint256(25))),
            poolCreatorFeeBps: uint16(vm.envOr("LAUNCHPAD_RH_POOL_CREATOR_FEE_BPS", uint256(25))),
            taxPlatformShareBps: uint16(vm.envOr("LAUNCHPAD_RH_TAX_PLATFORM_SHARE_BPS", uint256(500))),
            minTaxBps: uint16(vm.envOr("LAUNCHPAD_RH_MIN_TAX_BPS", uint256(100))),
            maxTaxBps: uint16(vm.envOr("LAUNCHPAD_RH_MAX_TAX_BPS", uint256(300))),
            tickSpacing: int24(int256(vm.envOr("LAUNCHPAD_RH_TICK_SPACING", uint256(10)))),
            minRatioBps: uint32(vm.envOr("LAUNCHPAD_RH_MIN_RATIO_BPS", uint256(2_000))),
            maxRatioBps: uint32(vm.envOr("LAUNCHPAD_RH_MAX_RATIO_BPS", uint256(100_000))),
            enabled: true
        });

        vm.startBroadcast();
        address deployer = msg.sender;
        LaunchFeeEscrow escrowContract = new LaunchFeeEscrow();
        LaunchFactory factoryContract = new LaunchFactory(deployer, address(escrowContract), poolManager, platform);
        LaunchLocker lockerContract = new LaunchLocker(address(factoryContract));
        LaunchRuleEngine engineContract = new LaunchRuleEngine(address(factoryContract));
        LaunchTokenDeployer tokenDeployerContract = new LaunchTokenDeployer(address(factoryContract));
        LaunchSwapRouter routerContract = new LaunchSwapRouter(address(factoryContract));
        LaunchPayouts payoutsContract = new LaunchPayouts();
        factoryContract.setLocker(address(lockerContract));
        factoryContract.setRouter(address(routerContract));
        factoryContract.setDeployers(address(tokenDeployerContract));
        factoryContract.setRuleEngine(address(engineContract));
        factoryContract.setLaunchConfig(ETH_CONFIG, cfg);
        if (ethVirtual == 0 || ethGraduation == 0) {
            // The default tier in ETH at today's price: $20k start, $50k graduation.
            (ethVirtual, ethGraduation) = factoryContract.curveForTargets(tierStartUsd * 1e18 * 100 / ethUsdCents, tierGraduationUsd * 1e18 * 100 / ethUsdCents);
        }
        if (usdgVirtual == 0 || usdgGraduation == 0) {
            (usdgVirtual, usdgGraduation) = factoryContract.curveForTargets(tierStartUsd * 1e6, tierGraduationUsd * 1e6);
        }
        factoryContract.setPairAsset(address(0), LaunchFactory.PairAsset({
            approved: true,
            virtualQuote: ethVirtual,
            graduationQuote: ethGraduation,
            minGraduationQuote: ethGraduation * customMinBps / 10_000,
            maxGraduationQuote: ethGraduation * customMaxBps / 10_000
        }));
        if (usdg != address(0)) {
            factoryContract.setPairAsset(usdg, LaunchFactory.PairAsset({
                approved: true,
                virtualQuote: usdgVirtual,
                graduationQuote: usdgGraduation,
                minGraduationQuote: usdgGraduation * customMinBps / 10_000,
                maxGraduationQuote: usdgGraduation * customMaxBps / 10_000
            }));
        }
        factoryContract.setLaunchFee(launchFee);
        factoryContract.setLaunchesOpen(true);
        if (owner != address(0) && owner != deployer) factoryContract.transferOwnership(owner);
        vm.stopBroadcast();
        return (address(escrowContract), address(factoryContract), address(lockerContract), address(engineContract), address(tokenDeployerContract), address(routerContract), address(payoutsContract));
    }
}
