// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AnimaAgentNFT} from "../src/AnimaAgentNFT.sol";

contract AnimaAgentNFTTest is Test {
    AnimaAgentNFT nft;
    address owner;
    uint256 oraclePk;
    address oracle;
    address alice;
    address bob;

    function setUp() public {
        owner = address(this);
        oraclePk = 0xA11CE;
        oracle = vm.addr(oraclePk);
        alice = address(0xa1);
        bob = address(0xb0);

        nft = new AnimaAgentNFT("Anima", "ANIMA", oracle);
    }

    function _canonicalDatas() internal pure returns (AnimaAgentNFT.IntelligentData[] memory) {
        string[6] memory labels =
            ["memory-index", "identity", "persona", "profile", "keystore", "activity-log"];
        AnimaAgentNFT.IntelligentData[] memory ds = new AnimaAgentNFT.IntelligentData[](6);
        for (uint256 i = 0; i < 6; i++) {
            ds[i] = AnimaAgentNFT.IntelligentData({
                dataDescription: labels[i],
                dataHash: keccak256(abi.encodePacked("bootstrap:", labels[i]))
            });
        }
        return ds;
    }

    function test_MintSucceedsWithSixCanonicalSlots() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        assertEq(tokenId, 1);
        assertEq(nft.ownerOf(tokenId), alice);

        AnimaAgentNFT.IntelligentData[] memory got = nft.getIntelligentData(tokenId);
        assertEq(got.length, 6);
        assertEq(got[0].dataDescription, "memory-index");
        assertEq(got[5].dataDescription, "activity-log");
    }

    function test_MintEmptyReverts() public {
        AnimaAgentNFT.IntelligentData[] memory empty = new AnimaAgentNFT.IntelligentData[](0);
        vm.expectRevert(AnimaAgentNFT.EmptyIntelligentData.selector);
        nft.mint(alice, empty);
    }

    function test_UpdateBySlotIndexOwnerOnly() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        uint256[] memory slots = new uint256[](1);
        bytes32[] memory hashes = new bytes32[](1);
        slots[0] = 1; // identity
        hashes[0] = keccak256("new-identity-hash");

        vm.prank(alice);
        nft.update(tokenId, slots, hashes);
        assertEq(nft.getSlotHash(tokenId, 1), keccak256("new-identity-hash"));
    }

    function test_UpdateByOperatorApprovedForAllSucceeds() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        address infra = address(0x1F);

        vm.prank(alice);
        nft.setApprovalForAll(infra, true);

        uint256[] memory slots = new uint256[](1);
        bytes32[] memory hashes = new bytes32[](1);
        slots[0] = 0;
        hashes[0] = keccak256("via-infra");

        vm.prank(infra);
        nft.update(tokenId, slots, hashes);
        assertEq(nft.getSlotHash(tokenId, 0), keccak256("via-infra"));
    }

    function test_UpdateBySingleApprovalSucceeds() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        address infra = address(0x1F);

        vm.prank(alice);
        nft.approve(infra, tokenId);

        uint256[] memory slots = new uint256[](1);
        bytes32[] memory hashes = new bytes32[](1);
        slots[0] = 1;
        hashes[0] = keccak256("via-approve");

        vm.prank(infra);
        nft.update(tokenId, slots, hashes);
        assertEq(nft.getSlotHash(tokenId, 1), keccak256("via-approve"));
    }

    function test_UpdateNonOwnerReverts() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        uint256[] memory slots = new uint256[](1);
        bytes32[] memory hashes = new bytes32[](1);
        slots[0] = 0;
        hashes[0] = keccak256("x");

        vm.prank(bob);
        vm.expectRevert(AnimaAgentNFT.NotTokenOwner.selector);
        nft.update(tokenId, slots, hashes);
    }

    function test_UpdateInvalidSlotReverts() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        uint256[] memory slots = new uint256[](1);
        bytes32[] memory hashes = new bytes32[](1);
        slots[0] = 99;
        hashes[0] = keccak256("x");

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AnimaAgentNFT.InvalidSlotIndex.selector, 99));
        nft.update(tokenId, slots, hashes);
    }

    function test_ITransferFromWithOracleProof() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());

        bytes32[] memory newHashes = new bytes32[](6);
        for (uint256 i = 0; i < 6; i++) {
            newHashes[i] = keccak256(abi.encodePacked("reencrypted:", i));
        }
        bytes32 nonce = keccak256("transfer-nonce-1");

        bytes32 msgHash = keccak256(
            abi.encode(tokenId, alice, bob, newHashes, block.chainid, nonce, address(nft))
        );
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", msgHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, ethSigned);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(alice);
        nft.iTransferFrom(alice, bob, tokenId, newHashes, nonce, sig);

        assertEq(nft.ownerOf(tokenId), bob);
        assertEq(nft.getSlotHash(tokenId, 3), keccak256(abi.encodePacked("reencrypted:", uint256(3))));
    }

    function test_ITransferFromReplayReverts() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        bytes32[] memory newHashes = new bytes32[](6);
        for (uint256 i = 0; i < 6; i++) newHashes[i] = keccak256(abi.encodePacked("r:", i));
        bytes32 nonce = keccak256("n1");

        bytes32 msgHash =
            keccak256(abi.encode(tokenId, alice, bob, newHashes, block.chainid, nonce, address(nft)));
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", msgHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, ethSigned);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(alice);
        nft.iTransferFrom(alice, bob, tokenId, newHashes, nonce, sig);

        // Standard ERC-721 return transfer so alice is owner again; now replaying the proof
        // must revert on the consumed-proof check.
        vm.prank(bob);
        nft.transferFrom(bob, alice, tokenId);

        vm.prank(alice);
        vm.expectRevert(AnimaAgentNFT.ProofAlreadyConsumed.selector);
        nft.iTransferFrom(alice, bob, tokenId, newHashes, nonce, sig);
    }

    function test_ITransferFromFromStrangerReverts() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        bytes32[] memory newHashes = new bytes32[](6);
        for (uint256 i = 0; i < 6; i++) newHashes[i] = keccak256(abi.encodePacked("r:", i));
        bytes32 nonce = keccak256("n1");

        bytes32 msgHash =
            keccak256(abi.encode(tokenId, alice, bob, newHashes, block.chainid, nonce, address(nft)));
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", msgHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, ethSigned);
        bytes memory sig = abi.encodePacked(r, s, v);

        // A random address (carol) tries to move alice's token to bob with a valid oracle sig
        address carol = address(0xCA0FE);
        vm.prank(carol);
        vm.expectRevert(AnimaAgentNFT.NotTokenOwner.selector);
        nft.iTransferFrom(alice, bob, tokenId, newHashes, nonce, sig);
    }

    function test_ITransferFromWithBadOracleSigReverts() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        bytes32[] memory newHashes = new bytes32[](6);
        for (uint256 i = 0; i < 6; i++) newHashes[i] = keccak256(abi.encodePacked("r:", i));
        bytes32 nonce = keccak256("n1");

        uint256 badPk = 0xBAD;
        bytes32 msgHash =
            keccak256(abi.encode(tokenId, alice, bob, newHashes, block.chainid, nonce, address(nft)));
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", msgHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(badPk, ethSigned);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(alice);
        vm.expectRevert(AnimaAgentNFT.InvalidTransferProof.selector);
        nft.iTransferFrom(alice, bob, tokenId, newHashes, nonce, sig);
    }

    function test_SetOracleOwnerOnly() public {
        address newOracle = address(0xBEEF);
        nft.setOracle(newOracle);
        assertEq(nft.teeOracle(), newOracle);

        vm.prank(alice);
        vm.expectRevert();
        nft.setOracle(address(0xDEAD));
    }

    function test_UpdateLengthMismatchReverts() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        uint256[] memory slots = new uint256[](2);
        bytes32[] memory hashes = new bytes32[](1);
        slots[0] = 0;
        slots[1] = 1;
        hashes[0] = keccak256("x");

        vm.prank(alice);
        vm.expectRevert(AnimaAgentNFT.LengthMismatch.selector);
        nft.update(tokenId, slots, hashes);
    }

    function test_ITransferFromWrongFromReverts() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        bytes32[] memory newHashes = new bytes32[](6);
        for (uint256 i = 0; i < 6; i++) newHashes[i] = keccak256(abi.encodePacked("r:", i));
        bytes32 nonce = keccak256("nonce");

        // Bob claims to be the `from` (he is not, alice is)
        bytes32 msgHash =
            keccak256(abi.encode(tokenId, bob, alice, newHashes, block.chainid, nonce, address(nft)));
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", msgHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, ethSigned);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(bob);
        vm.expectRevert(AnimaAgentNFT.NotTokenOwner.selector);
        nft.iTransferFrom(bob, alice, tokenId, newHashes, nonce, sig);
    }

    function test_ITransferFromNewHashesLengthMismatchReverts() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        bytes32[] memory newHashes = new bytes32[](5); // should be 6
        for (uint256 i = 0; i < 5; i++) newHashes[i] = keccak256(abi.encodePacked("r:", i));
        bytes32 nonce = keccak256("nonce");

        bytes32 msgHash =
            keccak256(abi.encode(tokenId, alice, bob, newHashes, block.chainid, nonce, address(nft)));
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", msgHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, ethSigned);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(alice);
        vm.expectRevert(AnimaAgentNFT.LengthMismatch.selector);
        nft.iTransferFrom(alice, bob, tokenId, newHashes, nonce, sig);
    }

    function test_ITransferFromByApprovedSucceeds() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        address carol = address(0xCAA0);

        // alice approves carol for this specific tokenId
        vm.prank(alice);
        nft.approve(carol, tokenId);

        bytes32[] memory newHashes = new bytes32[](6);
        for (uint256 i = 0; i < 6; i++) newHashes[i] = keccak256(abi.encodePacked("r:", i));
        bytes32 nonce = keccak256("nonce");

        bytes32 msgHash =
            keccak256(abi.encode(tokenId, alice, bob, newHashes, block.chainid, nonce, address(nft)));
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", msgHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, ethSigned);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(carol);
        nft.iTransferFrom(alice, bob, tokenId, newHashes, nonce, sig);
        assertEq(nft.ownerOf(tokenId), bob);
    }

    function test_ITransferFromByOperatorSucceeds() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        address carol = address(0xCAA0);

        // alice approves carol for all her tokens
        vm.prank(alice);
        nft.setApprovalForAll(carol, true);

        bytes32[] memory newHashes = new bytes32[](6);
        for (uint256 i = 0; i < 6; i++) newHashes[i] = keccak256(abi.encodePacked("r:", i));
        bytes32 nonce = keccak256("nonce");

        bytes32 msgHash =
            keccak256(abi.encode(tokenId, alice, bob, newHashes, block.chainid, nonce, address(nft)));
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", msgHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, ethSigned);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(carol);
        nft.iTransferFrom(alice, bob, tokenId, newHashes, nonce, sig);
        assertEq(nft.ownerOf(tokenId), bob);
    }

    function test_TotalSupplyIncrementsAcrossMints() public {
        nft.mint(alice, _canonicalDatas());
        nft.mint(alice, _canonicalDatas());
        nft.mint(bob, _canonicalDatas());
        assertEq(nft.totalSupply(), 3);
    }

    function test_MintEmitsEvent() public {
        AnimaAgentNFT.IntelligentData[] memory datas = _canonicalDatas();
        vm.expectEmit(true, true, false, true, address(nft));
        emit AnimaAgentNFT.Minted(1, alice, datas);
        nft.mint(alice, datas);
    }

    function test_UpdateEmitsEvent() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        uint256[] memory slots = new uint256[](1);
        bytes32[] memory hashes = new bytes32[](1);
        slots[0] = 2;
        hashes[0] = keccak256("new-persona");

        vm.prank(alice);
        vm.expectEmit(true, false, false, true, address(nft));
        emit AnimaAgentNFT.Updated(tokenId, slots, hashes);
        nft.update(tokenId, slots, hashes);
    }

    function test_ITransferFromEmitsTransferredEvent() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        bytes32[] memory newHashes = new bytes32[](6);
        for (uint256 i = 0; i < 6; i++) newHashes[i] = keccak256(abi.encodePacked("e:", i));
        bytes32 nonce = keccak256("evt-nonce");

        bytes32 msgHash =
            keccak256(abi.encode(tokenId, alice, bob, newHashes, block.chainid, nonce, address(nft)));
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", msgHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, ethSigned);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(alice);
        vm.expectEmit(true, true, true, false, address(nft));
        emit AnimaAgentNFT.Transferred(tokenId, alice, bob);
        nft.iTransferFrom(alice, bob, tokenId, newHashes, nonce, sig);
    }

    function test_SetOracleEmitsOracleRotated() public {
        address newOracle = address(0xBEEF);
        vm.expectEmit(true, true, false, false, address(nft));
        emit AnimaAgentNFT.OracleRotated(oracle, newOracle);
        nft.setOracle(newOracle);
    }

    function test_GetSlotHashMatchesIntelligentData() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        AnimaAgentNFT.IntelligentData[] memory full = nft.getIntelligentData(tokenId);
        for (uint256 i = 0; i < full.length; i++) {
            assertEq(nft.getSlotHash(tokenId, i), full[i].dataHash);
        }
    }

    function test_NonExistentTokenOwnerOfReverts() public {
        vm.expectRevert();
        nft.ownerOf(999);
    }

    function test_UpdateOnNonExistentTokenReverts() public {
        uint256[] memory slots = new uint256[](1);
        bytes32[] memory hashes = new bytes32[](1);
        slots[0] = 0;
        hashes[0] = keccak256("x");
        vm.prank(alice);
        vm.expectRevert(AnimaAgentNFT.NotTokenOwner.selector);
        nft.update(999, slots, hashes);
    }

    function test_ITransferFromWithTamperedHashesReverts() public {
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        bytes32[] memory newHashes = new bytes32[](6);
        for (uint256 i = 0; i < 6; i++) newHashes[i] = keccak256(abi.encodePacked("r:", i));
        bytes32 nonce = keccak256("nonce");

        // Sign for one set of hashes, submit a DIFFERENT set
        bytes32 msgHash =
            keccak256(abi.encode(tokenId, alice, bob, newHashes, block.chainid, nonce, address(nft)));
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", msgHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, ethSigned);
        bytes memory sig = abi.encodePacked(r, s, v);

        bytes32[] memory tamperedHashes = new bytes32[](6);
        for (uint256 i = 0; i < 6; i++) tamperedHashes[i] = keccak256(abi.encodePacked("attack:", i));

        vm.prank(alice);
        vm.expectRevert(AnimaAgentNFT.InvalidTransferProof.selector);
        nft.iTransferFrom(alice, bob, tokenId, tamperedHashes, nonce, sig);
    }

    function test_ITransferFromWithCrossContractReplayReverts() public {
        // A proof signed against THIS contract should not be replayable on another
        // contract with the same tokenId. The hash binds to address(this), so the
        // recomputed msgHash on a different contract wouldn't match the signed one.
        AnimaAgentNFT other = new AnimaAgentNFT("Other", "OTH", oracle);
        uint256 tokenId = nft.mint(alice, _canonicalDatas());
        other.mint(alice, _canonicalDatas());

        bytes32[] memory newHashes = new bytes32[](6);
        for (uint256 i = 0; i < 6; i++) newHashes[i] = keccak256(abi.encodePacked("r:", i));
        bytes32 nonce = keccak256("n1");

        // Sign proof naming `nft` as the binding contract
        bytes32 msgHash =
            keccak256(abi.encode(tokenId, alice, bob, newHashes, block.chainid, nonce, address(nft)));
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", msgHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, ethSigned);
        bytes memory sig = abi.encodePacked(r, s, v);

        // Attempt to use it against `other` — should fail because `other` recomputes
        // the hash with address(other) and gets a different result.
        vm.prank(alice);
        vm.expectRevert(AnimaAgentNFT.InvalidTransferProof.selector);
        other.iTransferFrom(alice, bob, tokenId, newHashes, nonce, sig);
    }
}
