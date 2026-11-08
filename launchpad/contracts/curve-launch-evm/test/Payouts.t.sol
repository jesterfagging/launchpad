// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchFixture} from "./utils/LaunchFixture.sol";
import {LaunchPayouts} from "../src/LaunchPayouts.sol";
import {LaunchFactory} from "../src/LaunchFactory.sol";
import {MockERC20} from "./mocks/MockTokens.sol";
import {LaunchToken as CurveToken_} from "../src/LaunchToken.sol";

/// @dev A recipient that refuses ETH.
contract Refuser {
    receive() external payable { revert("no"); }
}

contract PayoutsTest is LaunchFixture {
    LaunchPayouts internal payouts;

    function setUp() public override {
        super.setUp();
        payouts = new LaunchPayouts();
    }

    function testPaysManyHoldersInEthAndSkipsTheOnesThatRefuse() public {
        address[] memory to = new address[](4);
        uint256[] memory amounts = new uint256[](4);
        Refuser refuser = new Refuser();
        to[0] = alice; to[1] = bob; to[2] = address(refuser); to[3] = carol;
        amounts[0] = 1 ether; amounts[1] = 2 ether; amounts[2] = 3 ether; amounts[3] = 0.5 ether;
        uint256 aliceBefore = alice.balance; uint256 bobBefore = bob.balance; uint256 carolBefore = carol.balance;
        vm.deal(creator, 100 ether);
        uint256 creatorBefore = creator.balance;
        vm.prank(creator);
        uint256 skipped = payouts.payEth{value: 7 ether}(to, amounts); // 0.5 ETH more than needed
        assertEq(skipped, 1, "the refuser was skipped");
        assertEq(alice.balance - aliceBefore, 1 ether, "alice");
        assertEq(bob.balance - bobBefore, 2 ether, "bob");
        assertEq(carol.balance - carolBefore, 0.5 ether, "carol");
        assertEq(creatorBefore - creator.balance, 3.5 ether, "the payer spent what was delivered: the excess and the skipped amount came back");
        assertEq(address(payouts).balance, 0, "nothing stays in the contract");
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(LaunchPayouts.InsufficientValue.selector, 6.5 ether, 1 ether));
        payouts.payEth{value: 1 ether}(to, amounts);
        amounts = new uint256[](3);
        vm.prank(creator);
        vm.expectRevert(LaunchPayouts.LengthMismatch.selector);
        payouts.payEth{value: 1 ether}(to, amounts);
    }

    function testPaysTokensFromTheCallerAndReportsRefusedTransfers() public {
        MockERC20 asset = new MockERC20("Global Dollar", "USDG", 6);
        asset.mint(creator, 1_000e6);
        address[] memory to = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        to[0] = alice; to[1] = bob; to[2] = carol;
        amounts[0] = 100e6; amounts[1] = 250e6; amounts[2] = 900e6; // the third exceeds what is left: refused, not reverted
        vm.startPrank(creator);
        asset.approve(address(payouts), 1_000e6);
        uint256 skipped = payouts.payToken(address(asset), to, amounts);
        vm.stopPrank();
        assertEq(skipped, 1, "one refused");
        assertEq(asset.balanceOf(alice), 100e6, "alice");
        assertEq(asset.balanceOf(bob), 250e6, "bob");
        assertEq(asset.balanceOf(carol), 0, "carol unpaid");
        assertEq(asset.balanceOf(creator), 650e6, "the payer keeps the rest");
    }

    /// @dev v71.41: the pool's fees are collected by the locker into the escrow under the fee wallet (the Holders mode's
    /// fee wallet), which claims them and pays the holders through LaunchPayouts.
    function testHolderPayoutsFromACoinsFeeWallet() public {
        (CurveToken_ token,) = launchEth(noRules(), 0, 300); // a holder-reward coin with a 3% tax: a 4.25% curve pool
        buy(token, alice, 60 ether);
        locker.collect(address(token));
        uint256 creatorShare = escrow.balanceOf(feeWallet);
        // The buy paid 2.55 ETH of pool fees; the platform's 1.25% plus 5% of the 3% tax (1.4 of 4.25) is the platform's,
        // the holders' wallet gets 95% of the tax: 2.85 of 4.25 = 1.71 ETH.
        assertApprox(creatorShare, 1.71 ether, 0.03 ether, "the fee wallet's share of the pool's fees");
        vm.prank(feeWallet);
        escrow.claimAll(feeWallet);
        address[] memory to = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        to[0] = alice; to[1] = bob; amounts[0] = 1 ether; amounts[1] = 0.4 ether;
        uint256 aliceBefore = alice.balance;
        vm.prank(feeWallet);
        payouts.payEth{value: 1.4 ether}(to, amounts);
        assertEq(alice.balance - aliceBefore, 1 ether, "alice paid from the fee wallet");
    }

    function testPairAssetsCanBeApprovedInABatch() public {
        MockERC20 nvda = new MockERC20("NVIDIA", "NVDAon", 18);
        MockERC20 tsla = new MockERC20("Tesla", "TSLAon", 18);
        address[] memory tokens = new address[](2);
        LaunchFactory.PairAsset[] memory assets = new LaunchFactory.PairAsset[](2);
        tokens[0] = address(nvda); tokens[1] = address(tsla);
        assets[0] = LaunchFactory.PairAsset({approved: true, virtualQuote: 185e18, graduationQuote: 107e18, minGraduationQuote: 5e18, maxGraduationQuote: 1070e18});
        assets[1] = LaunchFactory.PairAsset({approved: true, virtualQuote: 80e18, graduationQuote: 46e18, minGraduationQuote: 2e18, maxGraduationQuote: 460e18});
        vm.prank(alice);
        vm.expectRevert();
        factory.setPairAssets(tokens, assets);
        vm.prank(owner);
        factory.setPairAssets(tokens, assets);
        (bool approved, uint256 vq,,,) = factory.pairAssets(address(tsla));
        assertTrue(approved, "approved");
        assertEq(vq, 80e18, "numbers");
        LaunchFactory.PairAsset[] memory one = new LaunchFactory.PairAsset[](1);
        vm.prank(owner);
        vm.expectRevert(LaunchFactory.InvalidConfig.selector);
        factory.setPairAssets(tokens, one);
    }
}
