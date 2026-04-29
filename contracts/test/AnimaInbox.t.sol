// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {AnimaInbox} from "../src/AnimaInbox.sol";

/// @dev Used by `test_SendMessage_From_Contract_Caller_PreservesAddress`.
contract MockSender {
    AnimaInbox internal immutable inbox;
    constructor(address inbox_) {
        inbox = AnimaInbox(inbox_);
    }
    function relay(address to, bytes calldata payload, bytes32 dataHash) external {
        inbox.sendMessage(to, payload, dataHash);
    }
}

contract AnimaInboxTest is Test {
    AnimaInbox internal inbox;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    bytes32 internal constant DATA_HASH = bytes32(uint256(0xdeadbeef));
    bytes internal constant SAMPLE_PAYLOAD = hex"01020304";

    /// @dev Re-declared for `vm.expectEmit`. Must mirror the contract event.
    event Message(address indexed from, address indexed to, bytes payload, bytes32 dataHash);

    function setUp() public {
        inbox = new AnimaInbox();
    }

    // ---------- Happy paths ----------

    function test_SendMessage_InlinePayload_EmitsEvent() public {
        vm.prank(alice);
        vm.expectEmit(true, true, true, true, address(inbox));
        emit Message(alice, bob, SAMPLE_PAYLOAD, bytes32(0));
        inbox.sendMessage(bob, SAMPLE_PAYLOAD, bytes32(0));
    }

    function test_SendMessage_StoragePointer_EmitsEvent() public {
        vm.prank(alice);
        vm.expectEmit(true, true, true, true, address(inbox));
        emit Message(alice, bob, "", DATA_HASH);
        inbox.sendMessage(bob, "", DATA_HASH);
    }

    function test_SendMessage_BothPayloadAndHash_EmitsEvent() public {
        vm.prank(alice);
        vm.expectEmit(true, true, true, true, address(inbox));
        emit Message(alice, bob, SAMPLE_PAYLOAD, DATA_HASH);
        inbox.sendMessage(bob, SAMPLE_PAYLOAD, DATA_HASH);
    }

    function test_SendMessage_SelfSend_Works() public {
        vm.prank(alice);
        vm.expectEmit(true, true, true, true, address(inbox));
        emit Message(alice, alice, SAMPLE_PAYLOAD, bytes32(0));
        inbox.sendMessage(alice, SAMPLE_PAYLOAD, bytes32(0));
    }

    function test_SendMessage_AtMaxInlinePayload_Works() public {
        bytes memory big = new bytes(inbox.MAX_INLINE_PAYLOAD());
        for (uint256 i = 0; i < big.length; i++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            big[i] = bytes1(uint8(i % 256));
        }
        vm.prank(alice);
        vm.expectEmit(true, true, true, true, address(inbox));
        emit Message(alice, bob, big, bytes32(0));
        inbox.sendMessage(bob, big, bytes32(0));
    }

    function test_RevertWhen_PayloadOversize() public {
        bytes memory tooBig = new bytes(inbox.MAX_INLINE_PAYLOAD() + 1);
        vm.prank(alice);
        vm.expectRevert(AnimaInbox.PayloadTooLarge.selector);
        inbox.sendMessage(bob, tooBig, bytes32(0));
    }

    function test_SendMessage_From_Contract_Caller_PreservesAddress() public {
        // Verify msg.sender attribution when caller is a contract (not an EOA).
        // Anchors the audit-1 finding that `from` is non-forgeable: the contract
        // sees msg.sender = the calling contract, which is the correct attribution.
        MockSender mock = new MockSender(address(inbox));
        vm.recordLogs();
        mock.relay(bob, SAMPLE_PAYLOAD, bytes32(0));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(address(mock)))), "from = mock");
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(bob))), "to = bob");
    }

    function test_SendMessage_MultipleSends_BothSucceed() public {
        vm.startPrank(alice);
        inbox.sendMessage(bob, SAMPLE_PAYLOAD, bytes32(0));
        inbox.sendMessage(carol, SAMPLE_PAYLOAD, DATA_HASH);
        vm.stopPrank();
    }

    function test_SendMessage_DifferentSendersToSameRecipient() public {
        vm.prank(alice);
        inbox.sendMessage(bob, SAMPLE_PAYLOAD, bytes32(0));

        vm.prank(carol);
        inbox.sendMessage(bob, SAMPLE_PAYLOAD, DATA_HASH);
    }

    function test_SendMessage_OneByte_Payload_Works() public {
        bytes memory one = hex"00";
        vm.prank(alice);
        vm.expectEmit(true, true, true, true, address(inbox));
        emit Message(alice, bob, one, bytes32(0));
        inbox.sendMessage(bob, one, bytes32(0));
    }

    function test_SendMessage_DataHashOnly_OneBit_Works() public {
        // bytes32(uint256(1)) is the smallest non-zero hash; ensure it isn't
        // accidentally treated as zero by some incidental check.
        vm.prank(alice);
        inbox.sendMessage(bob, "", bytes32(uint256(1)));
    }

    // ---------- Revert paths ----------

    function test_RevertWhen_RecipientIsZero() public {
        vm.prank(alice);
        vm.expectRevert(AnimaInbox.InvalidRecipient.selector);
        inbox.sendMessage(address(0), SAMPLE_PAYLOAD, bytes32(0));
    }

    function test_RevertWhen_PayloadEmptyAndHashZero() public {
        vm.prank(alice);
        vm.expectRevert(AnimaInbox.EmptyMessage.selector);
        inbox.sendMessage(bob, "", bytes32(0));
    }

    function test_RevertWhen_RecipientZero_TakesPrecedenceOverEmpty() public {
        // Both checks fail. InvalidRecipient is checked first.
        vm.prank(alice);
        vm.expectRevert(AnimaInbox.InvalidRecipient.selector);
        inbox.sendMessage(address(0), "", bytes32(0));
    }

    function test_RevertWhen_RecipientZero_WithPayload() public {
        vm.prank(alice);
        vm.expectRevert(AnimaInbox.InvalidRecipient.selector);
        inbox.sendMessage(address(0), SAMPLE_PAYLOAD, DATA_HASH);
    }

    // ---------- Event topic verification ----------

    function test_Event_FromAndTo_AreIndexed() public {
        vm.recordLogs();
        vm.prank(alice);
        inbox.sendMessage(bob, SAMPLE_PAYLOAD, bytes32(0));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "exactly one log");
        assertEq(logs[0].topics.length, 3, "sig + from + to");
        assertEq(logs[0].topics[1], bytes32(uint256(uint160(alice))), "from topic");
        assertEq(logs[0].topics[2], bytes32(uint256(uint160(bob))), "to topic");
    }

    function test_Event_DataField_ContainsPayloadAndHash() public {
        vm.recordLogs();
        vm.prank(alice);
        inbox.sendMessage(bob, SAMPLE_PAYLOAD, DATA_HASH);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (bytes memory decodedPayload, bytes32 decodedHash) =
            abi.decode(logs[0].data, (bytes, bytes32));
        assertEq(decodedPayload, SAMPLE_PAYLOAD, "payload roundtrip");
        assertEq(decodedHash, DATA_HASH, "dataHash roundtrip");
    }

    // ---------- Fuzz ----------

    function testFuzz_SendMessage_ValidInputs(
        address to,
        bytes calldata payload,
        bytes32 dataHash
    ) public {
        vm.assume(to != address(0));
        vm.assume(payload.length <= inbox.MAX_INLINE_PAYLOAD());
        // Ensure validity: at least one of payload/dataHash is set.
        if (payload.length == 0 && dataHash == bytes32(0)) {
            dataHash = bytes32(uint256(1));
        }
        vm.prank(alice);
        inbox.sendMessage(to, payload, dataHash);
    }

    function testFuzz_RevertOnOversizedPayload(uint16 oversize) public {
        // Any size strictly above MAX_INLINE_PAYLOAD must revert.
        uint256 size = uint256(inbox.MAX_INLINE_PAYLOAD()) + 1 + (uint256(oversize) % 4096);
        bytes memory pl = new bytes(size);
        vm.prank(alice);
        vm.expectRevert(AnimaInbox.PayloadTooLarge.selector);
        inbox.sendMessage(bob, pl, bytes32(0));
    }

    function testFuzz_RevertOnInvalidRecipient(
        bytes calldata payload,
        bytes32 dataHash
    ) public {
        vm.assume(payload.length > 0 || dataHash != bytes32(0));
        vm.prank(alice);
        vm.expectRevert(AnimaInbox.InvalidRecipient.selector);
        inbox.sendMessage(address(0), payload, dataHash);
    }

    function testFuzz_RevertOnEmpty(address to) public {
        vm.assume(to != address(0));
        vm.prank(alice);
        vm.expectRevert(AnimaInbox.EmptyMessage.selector);
        inbox.sendMessage(to, "", bytes32(0));
    }

    // ---------- Gas snapshots (informational) ----------

    function test_Gas_Inline_100B() public {
        bytes memory pl = new bytes(100);
        vm.prank(alice);
        uint256 g = gasleft();
        inbox.sendMessage(bob, pl, bytes32(0));
        emit log_named_uint("gas inline 100B", g - gasleft());
    }

    function test_Gas_Inline_1KB() public {
        bytes memory pl = new bytes(1024);
        vm.prank(alice);
        uint256 g = gasleft();
        inbox.sendMessage(bob, pl, bytes32(0));
        emit log_named_uint("gas inline 1KB", g - gasleft());
    }

    function test_Gas_Inline_3KB() public {
        bytes memory pl = new bytes(3 * 1024);
        vm.prank(alice);
        uint256 g = gasleft();
        inbox.sendMessage(bob, pl, bytes32(0));
        emit log_named_uint("gas inline 3KB", g - gasleft());
    }

    function test_Gas_StoragePointer_NoPayload() public {
        vm.prank(alice);
        uint256 g = gasleft();
        inbox.sendMessage(bob, "", DATA_HASH);
        emit log_named_uint("gas storage pointer only", g - gasleft());
    }
}
