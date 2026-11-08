// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PoolKey} from "./IUniswapV4.sol";

/// @notice Types shared by the launch contracts.
library LaunchTypes {
    /// @dev One transfer rule: the catalogue kind (1–25) and its six parameters, laid out exactly as the Solana hook
    /// program's `Rule { kind, params: [u64; 6] }` so `hookRuleParams` in public/hook-catalog.mjs packs both.
    struct Rule {
        uint8 kind;
        uint256[6] p;
    }

    /// @dev What the rule engine needs besides the rules themselves.
    struct RuleSetup {
        Rule[] rules; // at most 4, no duplicates, no catalogue conflict pair
        address gateToken; // holder_gated: the token whose balance gates receipts
        address titheRecipient; // tithe: who the donation goes to
        address[] allowlist; // allowlist: the initial wallets (the creator edits the list afterwards)
        address[] blocklist; // blocklist: sealed at launch, at most 200
        address[] exempt; // further rule-exempt wallets (Launchpad's per-coin wallets), at most 8
    }

    /// @dev Where a launch's fees go, read by the curve and the locker at every fee event so a redirect is honoured.
    struct FeeRecipients {
        address creator;
        address platform;
        uint16 platformShareBps;
    }
}

interface ILaunchFeeEscrow {
    event Credited(address indexed recipient, address indexed asset, uint256 amount, address indexed from);
    event Claimed(address indexed recipient, address indexed asset, uint256 amount, address indexed to);

    function credit(address recipient) external payable;
    function creditToken(address recipient, address token, uint256 amount) external;
    function claim(address to, uint256 amount) external returns (uint256);
    function claimAll(address to) external returns (uint256);
    function claimToken(address token, address to, uint256 amount) external returns (uint256);
    function claimAllToken(address token, address to) external returns (uint256);
    function balanceOf(address recipient) external view returns (uint256);
    function balanceOfToken(address recipient, address token) external view returns (uint256);
}

interface ILaunchRuleEngine {
    function install(address token, address venue, address creator, uint256 supply, LaunchTypes.RuleSetup calldata setup, address[] calldata platformExempt) external;
    function deactivate(address token) external;
    function onTransfer(address from, address to, uint256 amount, uint256 fromPost, uint256 toPost, address caller) external;
    function tithe(address token) external view returns (address recipient, uint256 amount);
    function isExempt(address token, address wallet) external view returns (bool);
    function hasRule(address token, uint8 kind) external view returns (bool);
    function ruleCount(address token) external view returns (uint256);
    function ruleAt(address token, uint256 index) external view returns (uint8 kind, uint256[6] memory p);
}

interface ILaunchToken {
    function activateRules() external;
    function markGraduated() external;
    function burn(uint256 amount) external;
    function engine() external view returns (address);
    function factory() external view returns (address);
    function graduated() external view returns (bool);
    function rulesActive() external view returns (bool);
}

interface ILaunchFactory {
    function feeRecipients(address token) external view returns (LaunchTypes.FeeRecipients memory);
    /// @dev The coin's pool key and whether the coin is the pool's currency0.
    function poolKeyOf(address token) external view returns (PoolKey memory key, bool tokenIs0);
    /// @dev The locker reports the graduation (the liquidity moved into the graduation pool): rules off, the coin
    /// marked graduated, the graduation pool the coin's pool from now on.
    function graduationReached(address token, bytes32 graduationPoolId) external;
    function escrow() external view returns (address);
    function locker() external view returns (address);
    function router() external view returns (address);
    function poolManager() external view returns (address);
    function platformRecipient() external view returns (address);
}

interface ILaunchLocker {
    /// @dev Mints a launch's two one-sided positions in the curve pool (the coins were transferred to the locker
    /// beforehand) and keeps them; `graduationFee` is the fee of the pool the launch graduates into. Returns the coins
    /// the positions took. The factory only, once per token.
    function lockLaunch(address token, PoolKey calldata key, uint24 graduationFee, bool tokenIs0, int24 startTick, int24 graduationTick, int24[2] calldata curveTicks, uint128 curveLiquidity, int24[2] calldata upperTicks, uint128 upperLiquidity) external returns (uint256 tokensLocked);
    /// @dev Takes the LP fees the positions earned, sells the coin side for the pair asset through the pool and credits
    /// the platform and the creator fee recipient in the escrow. Returns the pair asset credited and the coins sold.
    function collect(address token) external returns (uint256 quote, uint256 coinsSold);
    /// @dev Graduates a coin once the price sits at or past the graduation tick (anyone may call): the curve pool's last
    /// fees are collected, its liquidity moves into the graduation pool at the same price, locked here for good.
    function graduate(address token) external;
    /// @dev The pool the coin trades in now and whether the coin is its currency0.
    function poolKeyOf(address token) external view returns (PoolKey memory key, bool tokenIs0);
    /// @dev How far the price has travelled from the start tick to the graduation tick, in bps (10000 = graduated;
    /// the same number as the quote raised over the quote the curve position raises in full).
    function progressBps(address token) external view returns (uint256);
}

interface ILaunchSwapRouter {
    function buy(address token, uint256 quoteIn, uint256 minTokensOut, address recipient, uint256 deadline) external payable returns (uint256 tokensOut);
    function sell(address token, uint256 tokensIn, uint256 minQuoteOut, address recipient, uint256 deadline) external returns (uint256 quoteOut);
}
