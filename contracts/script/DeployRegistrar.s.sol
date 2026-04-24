// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AnimaSubnameRegistrar, ISidRegistry} from "../src/AnimaSubnameRegistrar.sol";

/// @notice Deploy AnimaSubnameRegistrar via CREATE2 (mainnet-only) and grant
/// the registrar write-access under `anima.0g`. Must be broadcast by the
/// anima.0g registry owner (dev.deployer).
///
///   forge script contracts/script/DeployRegistrar.s.sol:DeployRegistrar \
///     --rpc-url og_mainnet --broadcast --private-key $DEV_DEPLOYER_PK \
///     --priority-gas-price 2000000000 --with-gas-price 2500000000
contract DeployRegistrar is Script {
    bytes32 public constant SALT = keccak256("anima:AnimaSubnameRegistrar:v1");
    address constant REGISTRY = 0x5dC881dDA4e4a8d312be3544AD13118D1a04Cb17;
    address constant RESOLVER = 0x6D3B3F99177FB2A5de7F9E928a9BD807bF7b5BAD;

    function run() external returns (AnimaSubnameRegistrar reg) {
        address caller = msg.sender;
        vm.startBroadcast();
        reg = new AnimaSubnameRegistrar{salt: SALT}(REGISTRY, RESOLVER, caller);
        ISidRegistry(REGISTRY).setApprovalForAll(address(reg), true);
        vm.stopBroadcast();
        require(reg.isOperational(), "registrar not operational after deploy");
        console2.log("AnimaSubnameRegistrar deployed at:", address(reg));
        console2.log("Salt:", vm.toString(SALT));
        console2.log("Approval set by anima owner:", caller);
    }
}
