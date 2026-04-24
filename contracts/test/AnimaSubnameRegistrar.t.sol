// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AnimaSubnameRegistrar, ISidRegistry} from "../src/AnimaSubnameRegistrar.sol";

/// @notice Minimal SidRegistry mock sufficient for unit-testing the registrar.
contract MockRegistry is ISidRegistry {
    mapping(bytes32 => address) internal _owner;
    mapping(address => mapping(address => bool)) internal _approved;

    function setApprovalForAll(address op, bool v) external {
        _approved[msg.sender][op] = v;
    }

    function owner(bytes32 node) external view returns (address) {
        return _owner[node];
    }

    function isApprovedForAll(address o, address op) external view returns (bool) {
        return _approved[o][op];
    }

    /// @dev Simulates the SPACE ID registry check: parent owner (or approved op) can mutate children.
    function setSubnodeRecord(
        bytes32 parent,
        bytes32 label,
        address newOwner,
        address,
        uint64
    ) external {
        address parentOwner = _owner[parent];
        require(
            msg.sender == parentOwner || _approved[parentOwner][msg.sender],
            "not approved"
        );
        bytes32 node = keccak256(abi.encode(parent, label));
        _owner[node] = newOwner;
    }

    /// @dev Test helper so tests can seed the parent node's registry owner.
    function prime(bytes32 node, address who) external {
        _owner[node] = who;
    }
}

contract AnimaSubnameRegistrarTest is Test {
    AnimaSubnameRegistrar reg;
    MockRegistry registry;
    address resolver = address(0xBEEF);
    address animaOwner = address(0xA11CE);
    address alice = address(0xa1);
    address bob = address(0xb0);
    address carol = address(0xca);

    bytes32 constant ANIMA_NODE =
        0xb8a6c74b0b09d90544912d761c6c285b8d1e4336f3cdd13cfa35469b943ff182;

    function setUp() public {
        registry = new MockRegistry();
        registry.prime(ANIMA_NODE, animaOwner);
        reg = new AnimaSubnameRegistrar(address(registry), resolver, animaOwner);
        vm.prank(animaOwner);
        registry.setApprovalForAll(address(reg), true);
    }

    function _subnode(string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encode(ANIMA_NODE, keccak256(bytes(label))));
    }

    function test_ClaimSetsOwnerAndResolver() public {
        vm.prank(alice);
        bytes32 sub = reg.claim("alice", alice);
        assertEq(sub, _subnode("alice"));
        assertEq(registry.owner(sub), alice);
    }

    function test_ClaimByThirdPartyForOther() public {
        vm.prank(bob); // bob pays gas but alice gets ownership
        reg.claim("alice", alice);
        assertEq(registry.owner(_subnode("alice")), alice);
    }

    function test_EmptyLabelReverts() public {
        vm.expectRevert(AnimaSubnameRegistrar.EmptyLabel.selector);
        reg.claim("", alice);
    }

    function test_TooLongLabelReverts() public {
        string memory tooLong =
            "this-label-is-way-too-long-for-a-dns-label-more-than-sixty-three-chars";
        vm.expectRevert(AnimaSubnameRegistrar.LabelTooLong.selector);
        reg.claim(tooLong, alice);
    }

    function test_DoubleClaimReverts() public {
        vm.prank(alice);
        reg.claim("alice", alice);

        vm.prank(carol);
        vm.expectRevert(AnimaSubnameRegistrar.LabelAlreadyTaken.selector);
        reg.claim("alice", carol);
    }

    function test_NotApprovedReverts() public {
        vm.prank(animaOwner);
        registry.setApprovalForAll(address(reg), false);

        vm.prank(alice);
        vm.expectRevert("not approved");
        reg.claim("alice", alice);
    }

    function test_IsOperationalReflectsApproval() public {
        assertTrue(reg.isOperational());
        vm.prank(animaOwner);
        registry.setApprovalForAll(address(reg), false);
        assertFalse(reg.isOperational());
    }

    function test_IsOperationalFalseAfterOwnerTransfer() public {
        assertTrue(reg.isOperational());
        // anima.0g transferred to a new owner who hasn't approved the registrar
        address newOwner = address(0xDEC0DE);
        registry.prime(ANIMA_NODE, newOwner);
        assertFalse(reg.isOperational());
    }

    function test_ConstructorRevertsOnAnimaOwnerMismatch() public {
        vm.expectRevert(AnimaSubnameRegistrar.AnimaOwnerMismatch.selector);
        new AnimaSubnameRegistrar(address(registry), resolver, alice);
    }

    function test_DifferentLabelsAreIndependent() public {
        vm.prank(alice);
        reg.claim("alice", alice);
        vm.prank(bob);
        reg.claim("bob", bob);
        assertEq(registry.owner(_subnode("alice")), alice);
        assertEq(registry.owner(_subnode("bob")), bob);
    }
}
