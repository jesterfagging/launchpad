// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20Base} from "./lib/ERC20Base.sol";
import {ILaunchRuleEngine, ILaunchToken} from "./interfaces/ILaunch.sol";

/// @title LaunchToken
/// @notice The coin a Launchpad launch creates on Robinhood Chain: a fixed-supply ERC-20 (18 decimals, minted once to the
/// factory, which hands it to the bonding curve) whose transfers consult the rule engine while the coin is on the curve.
/// The factory activates the rules right after launch and switches them off at graduation; afterwards the token is a
/// plain ERC-20 forever. Anyone can burn their own balance (buyback & burn sends to the dead address or burns here).
/// Created with CREATE2 by the factory's token deployer, so a vanity address is a matter of grinding the salt off chain.
contract LaunchToken is ERC20Base, ILaunchToken {
    error NotFactory();
    error AlreadyGraduated();

    address public immutable override factory;
    address public immutable override engine;
    uint256 public immutable launchSupply;
    bool public override rulesActive;
    bool public override graduated;
    string public metadataURI;

    event RulesActivated();
    event Graduated();
    /// @dev ERC-7572: emitted when the contract-level metadata is (first) set, so indexers fetch it.
    event ContractURIUpdated();

    constructor(address factory_, string memory name_, string memory symbol_, uint256 supply_, address engine_, string memory metadataURI_) ERC20Base(name_, symbol_) {
        factory = factory_;
        engine = engine_;
        launchSupply = supply_;
        metadataURI = metadataURI_;
        _mint(factory_, supply_);
        emit ContractURIUpdated();
    }

    /// @notice The coin's metadata (name, symbol, description, image, website, socials) as ERC-7572 names it:
    /// explorers, aggregators and trading terminals read `contractURI()` for a token's image and links.
    function contractURI() external view returns (string memory) {
        return metadataURI;
    }

    /// @notice The same document under the ERC-1046 name for fungible tokens.
    function tokenURI() external view returns (string memory) {
        return metadataURI;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    /// @notice The factory switches the rules on once the engine holds the token's configuration.
    function activateRules() external override onlyFactory {
        if (graduated) revert AlreadyGraduated();
        rulesActive = true;
        emit RulesActivated();
    }

    /// @notice Graduation: rules off for good, before the liquidity moves to the pool.
    function markGraduated() external override onlyFactory {
        graduated = true;
        rulesActive = false;
        emit Graduated();
    }

    function burn(uint256 amount) external override {
        _burn(msg.sender, amount);
    }

    function _afterTokenTransfer(address from, address to, uint256 value) internal override {
        if (rulesActive && from != address(0)) ILaunchRuleEngine(engine).onTransfer(from, to, value, balanceOf(from), balanceOf(to), msg.sender);
    }
}
