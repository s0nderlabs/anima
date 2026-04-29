// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title AnimaInbox
/// @notice Singleton A2A message emitter for anima agents on 0G Chain.
/// @dev Stateless: the contract owns nothing, stores nothing. Every message
/// is just a chain event. Recipients scan logs filtered by `to`, decrypt
/// the ECIES payload, or fetch the 0G Storage blob via `dataHash` if set.
///
/// Identity: `msg.sender` is the chain-authenticated `from`. Receivers MUST
/// trust `event.from` over any inline plaintext claim. Confidentiality
/// comes from ECIES, authentication comes from `msg.sender`.
///
/// Replay: EVM nonces block literal tx replay. Semantic replay (a different
/// sender re-broadcasting the same ciphertext) is not impersonation, since
/// the new sender is correctly attributed in `event.from`.
contract AnimaInbox {
    /// @notice Hard cap on inline payload bytes. Anima's spillover threshold
    /// is 3 KiB at the application layer; this 16 KiB ceiling gives 5x
    /// headroom for unusual cases while forcing megabyte-scale abuse to
    /// route through 0G Storage (which carries its own write fee).
    uint256 public constant MAX_INLINE_PAYLOAD = 16 * 1024;

    /// @notice Emitted on every successful `sendMessage` call.
    /// @param from Chain-authenticated sender (the tx's `msg.sender`).
    /// @param to Recipient EOA. Listeners filter on this topic.
    /// @param payload Inline ECIES ciphertext (under threshold), or empty.
    /// @param dataHash 0G Storage pointer (over threshold or files), or zero.
    event Message(
        address indexed from,
        address indexed to,
        bytes payload,
        bytes32 dataHash
    );

    error InvalidRecipient();
    error EmptyMessage();
    error PayloadTooLarge();

    /// @notice Send a message. Emits exactly one event, stores nothing.
    /// At least one of `payload` and `dataHash` must be non-empty.
    /// @param to Recipient EOA, cannot be `address(0)`.
    /// @param payload Inline ECIES ciphertext (max `MAX_INLINE_PAYLOAD`), or
    ///        empty if `dataHash` is set.
    /// @param dataHash 0G Storage hash, or `bytes32(0)` if payload is inline.
    function sendMessage(address to, bytes calldata payload, bytes32 dataHash) external {
        if (to == address(0)) revert InvalidRecipient();
        if (payload.length == 0 && dataHash == bytes32(0)) revert EmptyMessage();
        if (payload.length > MAX_INLINE_PAYLOAD) revert PayloadTooLarge();
        emit Message(msg.sender, to, payload, dataHash);
    }
}
