// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice Minimal ERC-7857 iNFT for Anima (first on-chain sovereign agent runtime on 0G).
/// Ships the critical surface of the 0gfoundation/0g-agent-nft canonical contract:
/// - per-token IntelligentData[] storage with slot-indexed updates
/// - mint, update, iTransferFrom with ECDSA-signed transfer proofs
/// - global TEE oracle (software-signed for MVP per project-anima.md section 30.6)
/// Per-token oracle rotation + authorizeUsage + iClone are deferred to Phase 11.
contract AnimaAgentNFT is ERC721, Ownable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    struct IntelligentData {
        string dataDescription;
        bytes32 dataHash;
    }

    /// @dev Oracle address authorized to sign transfer proofs. Software-signed in MVP.
    address public teeOracle;

    /// @dev Monotonically increasing token ID counter. First minted tokenId is 1.
    uint256 public totalSupply;

    /// @dev Per-token IntelligentData array. Fixed in length after mint; updates mutate in place.
    mapping(uint256 => IntelligentData[]) private _tokenData;

    /// @dev Replay protection for transfer proofs: hashed proof => consumed flag.
    mapping(bytes32 => bool) public consumedProofs;

    event Minted(uint256 indexed tokenId, address indexed to, IntelligentData[] iDatas);
    event Updated(uint256 indexed tokenId, uint256[] slots, bytes32[] newHashes);
    event Transferred(uint256 indexed tokenId, address indexed from, address indexed to);
    event OracleRotated(address indexed oldOracle, address indexed newOracle);

    error EmptyIntelligentData();
    error InvalidSlotIndex(uint256 slot);
    error LengthMismatch();
    error NotTokenOwner();
    error InvalidTransferProof();
    error ProofAlreadyConsumed();

    constructor(string memory name_, string memory symbol_, address oracle_)
        ERC721(name_, symbol_)
        Ownable(msg.sender)
    {
        teeOracle = oracle_;
    }

    /// @notice Mint a new iNFT with IntelligentData[] populated at mint time.
    /// @dev Anyone can mint. Ownership + operator accountability is tracked off-chain via the oracle.
    function mint(address to, IntelligentData[] calldata iDatas) external returns (uint256 tokenId) {
        if (iDatas.length == 0) revert EmptyIntelligentData();
        unchecked {
            totalSupply += 1;
            tokenId = totalSupply;
        }
        for (uint256 i = 0; i < iDatas.length; i++) {
            _tokenData[tokenId].push(iDatas[i]);
        }
        _safeMint(to, tokenId);
        emit Minted(tokenId, to, iDatas);
    }

    /// @notice Update one or more IntelligentData slots for a token. Callable by
    /// the token owner OR any address the owner has approved via `setApprovalForAll`
    /// or per-token `approve`. This lets the agent's infra EOA (separate from the
    /// operator's wallet that owns the iNFT per project-anima.md section 22.1)
    /// push memory syncs without holding the operator's key.
    function update(uint256 tokenId, uint256[] calldata slots, bytes32[] calldata newHashes) external {
        address tokenOwner = _ownerOf(tokenId);
        if (tokenOwner == address(0)) revert NotTokenOwner();
        if (
            msg.sender != tokenOwner && getApproved(tokenId) != msg.sender
                && !isApprovedForAll(tokenOwner, msg.sender)
        ) revert NotTokenOwner();
        if (slots.length != newHashes.length) revert LengthMismatch();
        IntelligentData[] storage data = _tokenData[tokenId];
        for (uint256 i = 0; i < slots.length; i++) {
            if (slots[i] >= data.length) revert InvalidSlotIndex(slots[i]);
            data[slots[i]].dataHash = newHashes[i];
        }
        emit Updated(tokenId, slots, newHashes);
    }

    /// @notice Intelligent transfer with oracle-signed proof. Replaces the envelope keys
    /// via TEE re-encryption in production; MVP just validates the oracle's ECDSA sig over
    /// keccak256(abi.encode(tokenId, from, to, newHashes, chainid, nonce)).
    function iTransferFrom(
        address from,
        address to,
        uint256 tokenId,
        bytes32[] calldata newHashes,
        bytes32 proofNonce,
        bytes calldata oracleSignature
    ) external {
        if (_ownerOf(tokenId) != from) revert NotTokenOwner();
        if (
            msg.sender != from && getApproved(tokenId) != msg.sender
                && !isApprovedForAll(from, msg.sender)
        ) revert NotTokenOwner();
        if (newHashes.length != _tokenData[tokenId].length) revert LengthMismatch();

        bytes32 msgHash = keccak256(
            abi.encode(tokenId, from, to, newHashes, block.chainid, proofNonce, address(this))
        );
        if (consumedProofs[msgHash]) revert ProofAlreadyConsumed();
        address recovered = msgHash.toEthSignedMessageHash().recover(oracleSignature);
        if (recovered != teeOracle) revert InvalidTransferProof();
        consumedProofs[msgHash] = true;

        IntelligentData[] storage data = _tokenData[tokenId];
        for (uint256 i = 0; i < newHashes.length; i++) {
            data[i].dataHash = newHashes[i];
        }

        _transfer(from, to, tokenId);
        emit Transferred(tokenId, from, to);
    }

    /// @notice Rotate the global TEE oracle. Contract-owner only. In Phase 11 this becomes
    /// per-token via mapping(uint256 => address) and owner-of-token controlled.
    function setOracle(address newOracle) external onlyOwner {
        address old = teeOracle;
        teeOracle = newOracle;
        emit OracleRotated(old, newOracle);
    }

    function getIntelligentData(uint256 tokenId) external view returns (IntelligentData[] memory) {
        return _tokenData[tokenId];
    }

    function getSlotHash(uint256 tokenId, uint256 slot) external view returns (bytes32) {
        return _tokenData[tokenId][slot].dataHash;
    }
}
