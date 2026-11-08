// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LaunchToken} from "./LaunchToken.sol";

/// @title LaunchTokenDeployer
/// @notice Creates a launch's coin with CREATE2 on the factory's behalf. The creation code lives here rather than in the
/// factory so the factory stays under the 24 KB contract size limit; the factory is the only caller, and it is the
/// coin's `factory` and the holder of the minted supply. Vanity salts are ground against `predict`.
contract LaunchTokenDeployer {
    error NotFactory();

    struct TokenSpec {
        string name;
        string symbol;
        uint256 supply;
        address engine;
        string metadataURI;
    }

    address public immutable factory;

    constructor(address factory_) { factory = factory_; }

    function deploy(bytes32 salt, TokenSpec calldata spec) external returns (address) {
        if (msg.sender != factory) revert NotFactory();
        return address(new LaunchToken{salt: salt}(factory, spec.name, spec.symbol, spec.supply, spec.engine, spec.metadataURI));
    }

    function predict(bytes32 salt, TokenSpec calldata spec) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, _initHash(spec))))));
    }

    function _initHash(TokenSpec calldata spec) internal view returns (bytes32) {
        bytes memory args = abi.encode(factory, spec.name, spec.symbol, spec.supply, spec.engine, spec.metadataURI);
        return keccak256(abi.encodePacked(type(LaunchToken).creationCode, args));
    }
}
