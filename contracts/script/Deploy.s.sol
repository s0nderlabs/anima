// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AnimaAgentNFT} from "../src/AnimaAgentNFT.sol";

/// @notice Deploy AnimaAgentNFT to the selected network.
/// Usage:
///   forge script contracts/script/Deploy.s.sol:Deploy \
///     --rpc-url og_testnet --broadcast \
///     --private-key $DEV_DEPLOYER_PK \
///     --sig "run(string,string,address)" "Anima" "ANIMA" 0x...oracle
contract Deploy is Script {
    function run(string memory name_, string memory symbol_, address oracle_)
        external
        returns (AnimaAgentNFT nft)
    {
        vm.startBroadcast();
        nft = new AnimaAgentNFT(name_, symbol_, oracle_);
        vm.stopBroadcast();
        console2.log("AnimaAgentNFT deployed at:", address(nft));
        console2.log("Oracle:", oracle_);
        console2.log("Chain id:", block.chainid);
    }
}
