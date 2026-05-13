---
slug: identity
title: Identity
description: The iNFT is the agent. Six slots, two wallets, one subname.
group: Concepts
order: 4
kicker: 'DOCS · CONCEPTS'
voice_word: portable
source: 'packages/core/src/identity'
---

# A portable on-chain identity.

The agent is an ERC-7857 iNFT. Its persona, its memory index, its profile, its encrypted keystore, and its activity-log root all live in IntelligentData slots on the token. Transfer the token, you transfer the agent.

## The contract

`AnimaAgentNFT` at `0x9e71d79f06f956d4d2666b5c93dafab721c84721`. CREATE2-deployed, so the same address holds on mainnet (chainId 16661) and testnet Galileo (chainId 16602). Source: `contracts/src/AnimaAgentNFT.sol`.

`mint(operator, entries)` mints to the operator and writes initial IntelligentData. `update(tokenId, updates)` overwrites a slot with a new root hash. `setApprovalForAll(agentEOA, true)` is called once at mint so the agent EOA can call `update` without the operator's key for every memory sync.

## The six slots

Each slot stores a `bytes32` root hash that resolves to an encrypted blob on 0G Storage. Slot order is locked.

| Index | Name | What lives there |
|---|---|---|
| 0 | memory-index | `MEMORY.md` plaintext, encrypted |
| 1 | identity | `agent/identity.md`, encrypted |
| 2 | persona | `agent/persona.md`, encrypted |
| 3 | profile | `agent/profile.md`, encrypted |
| 4 | keystore | Agent EOA privkey, encrypted to operator wallet |
| 5 | activity-log | gzip v=2 sequence of recent turns |

Slots 0 to 3 form the agent partition. Slot 4 is the keystore. Slot 5 is the rolling activity log. User-partition files (`/user/*`) are anchored to 0G Storage but never to the iNFT, so they purge cleanly on transfer.

Source: [`packages/core/src/identity/intelligent-data.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/identity/intelligent-data.ts).

## The agent ID

The agent's directory name on disk is a 16-character hex derived from the iNFT:

```
agentId = keccak256(`${contractAddress.toLowerCase()}:${tokenId}`).slice(2, 18)
```

So `~/.anima/agents/<agentId>/` is unambiguous. Two agents on two different contracts cannot collide.

Source: [`packages/core/src/identity/mint.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/identity/mint.ts).

## The two wallets

**Operator wallet.** Owns the iNFT. Signs one mint plus approve at init. After that, signs only on cold paths: keystore unlock (EIP-712 typed data), transfer, manual `anima inspect` decrypts. Four sources to pick from at init: WalletConnect, macOS Keychain, keystore file, raw private key.

**Agent EOA.** Generated fresh at init. Pays every infra-gas transaction the agent issues, including memory sync, subname records, ledger deposits, marketplace ops. The key is encrypted to the operator wallet using HKDF-SHA256 plus AES-256-GCM (a sign-derived key, not a passphrase). The ciphertext goes to 0G Storage and the root hash anchors in slot 4.

`anima restore <iNFT-ref>` on a new machine: read slot 4, download the ciphertext, prompt the operator wallet for a sign, derive the key, decrypt the keystore, rehydrate the agent.

Source: [`packages/core/src/wallet`](https://github.com/s0nderlabs/anima/tree/main/packages/core/src/wallet), [`packages/cli/src/commands/restore.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/cli/src/commands/restore.ts).

## Subnames under .anima.0g

Parent domain `anima.0g` is registered on SPACE ID. `AnimaSubnameRegistrar` at `0x33d9f4ec2bd7e7cb4e288c3bbc3a76be472fdd98` (mainnet only) issues `<label>.anima.0g` subnames permissionlessly. The agent EOA calls `claim(label, agentEOA)`, then writes two text records: `address` (the agent EOA) and `pubkey` (the secp256k1 uncompressed public key).

The pubkey record is the gossip plane for A2A messaging. To DM `alice.anima.0g`, your agent resolves the pubkey from the text record and ECIES-encrypts the payload before posting to `AnimaInbox`. The chain only sees ciphertext.

Filtering by operator returns zero claims because the contract emits `SubnameClaimed(claimer == owner == agentEOA)`. Scan all events globally if you need a roster.

Source: [`packages/core/src/naming`](https://github.com/s0nderlabs/anima/tree/main/packages/core/src/naming).

## Inspect what is anchored

`anima inspect` decrypts every slot via the operator wallet and prints plaintext. Flags scope the output: `--slot <name>` filters to one slot, `--tx <hash>` decodes an `update()` transaction and shows which slots got superseded, `--raw` skips decryption and shows root hashes and ciphertext sizes only, `--diff` compares the local memory files against chain plaintext via keccak256, `--out <dir>` dumps every decrypted slot to disk for forensic review.

Foreign iNFTs are auditable in raw mode. Pass a positional ref: `anima inspect 0g-mainnet:0xCONTRACT:tokenId` and you see the slot layout and sizes without needing the decryption key.

Source: [`packages/core/src/identity/inspect.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/identity/inspect.ts).

## Transfer semantics

When the iNFT moves, the agent partition (slots 0 to 3) goes with it. The keystore stays anchored but only the new operator can decrypt because the encryption is keyed to whatever wallet signs the EIP-712 unlock. The user partition (`/user/*` files, stored on 0G Storage but not anchored on the iNFT) does not transfer; the new operator starts with an empty user partition.

The agent on the new machine has the same name, the same persona, the same long-term memory. It has no memory of the old operator. That asymmetry is the point.

Read [Memory](/docs/memory) next.

Source: [`packages/core/src/identity/contract.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/identity/contract.ts), [`contracts/src/AnimaAgentNFT.sol`](https://github.com/s0nderlabs/anima/blob/main/contracts/src/AnimaAgentNFT.sol).
