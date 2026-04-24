// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AnimaAgentNFT} from "../src/AnimaAgentNFT.sol";

/// @notice Deploy AnimaAgentNFT via CREATE2 so mainnet + testnet (or any future
/// chain) land on the same address when the same deployer runs this script.
///
/// Usage (dev.deployer as broadcaster):
///   forge script contracts/script/Deploy.s.sol:Deploy \
///     --rpc-url og_testnet --broadcast --private-key $DEV_DEPLOYER_PK \
///     --sig 'run(string,string,address)' "Anima" "ANIMA" 0xC635...87Ec \
///     --priority-gas-price 2000000000 --with-gas-price 2500000000
contract Deploy is Script {
    bytes32 public constant SALT = keccak256("anima:AnimaAgentNFT:v1");

    function run(string memory name_, string memory symbol_, address oracle_)
        external
        returns (AnimaAgentNFT nft)
    {
        vm.startBroadcast();
        nft = new AnimaAgentNFT{salt: SALT}(name_, symbol_, oracle_);
        vm.stopBroadcast();
        console2.log("AnimaAgentNFT deployed at:", address(nft));
        console2.log("Salt:", vm.toString(SALT));
        console2.log("Oracle:", oracle_);
        console2.log("Chain id:", block.chainid);
    }
}
