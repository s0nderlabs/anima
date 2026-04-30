// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AnimaMarket} from "../src/AnimaMarket.sol";

/// @notice Deploy AnimaMarket via CREATE2. Same address on testnet + mainnet
/// (assuming nonce-free CREATE2 + identical bytecode).
///
///   forge script contracts/script/DeployMarket.s.sol:DeployMarket \
///     --rpc-url og_testnet --broadcast --private-key $DEV_DEPLOYER_PK \
///     --priority-gas-price 2000000000 --with-gas-price 2500000000
///
///   forge script contracts/script/DeployMarket.s.sol:DeployMarket \
///     --rpc-url og_mainnet --broadcast --private-key $DEV_DEPLOYER_PK \
///     --priority-gas-price 2000000000 --with-gas-price 2500000000
///
/// The fee recipient defaults to the deployer (msg.sender of broadcast).
/// Override with FEE_RECIPIENT env var if a different address should collect.
contract DeployMarket is Script {
    bytes32 public constant SALT = keccak256("anima:AnimaMarket:v1");

    function run() external returns (AnimaMarket market) {
        address feeRecipient = vm.envOr("FEE_RECIPIENT", address(0));
        vm.startBroadcast();
        if (feeRecipient == address(0)) {
            feeRecipient = msg.sender;
        }
        market = new AnimaMarket{salt: SALT}(feeRecipient);
        vm.stopBroadcast();
        console2.log("AnimaMarket deployed at:", address(market));
        console2.log("Fee recipient:", feeRecipient);
        console2.log("Salt:", vm.toString(SALT));
        console2.log("Chain ID:", block.chainid);
    }
}
