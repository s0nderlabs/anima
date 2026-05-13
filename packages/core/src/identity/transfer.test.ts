import { describe, expect, test } from 'bun:test'
import {
  type Address,
  type Hex,
  encodeAbiParameters,
  hashMessage,
  keccak256,
  recoverAddress,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { RawPrivkeyOperatorSigner } from '../operator/raw-privkey'
import { decryptAgentKey, encryptAgentKey } from '../wallet/operator-keystore-crypto'
import { bootstrapHashFor } from './contract'
import { INTELLIGENT_DATA_SLOTS, slotIndex } from './intelligent-data'
import { buildTransferHashes, signTransferProof, transferProofPreimage } from './transfer'

const ORACLE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex // anvil acct #1
const ORACLE_ADDR = privateKeyToAccount(ORACLE_KEY).address

const SAMPLE: Parameters<typeof transferProofPreimage>[0] = {
  tokenId: 7n,
  from: '0xC635e6Eb223aE14143E23cEEa9440bC773dc87Ec' as Address,
  to: '0x06B74fe8070C96D92e3a2A8A871849Ac81e4c09e' as Address,
  newHashes: Array.from({ length: 6 }, (_, i) => keccak256(new TextEncoder().encode(`slot-${i}`))),
  chainId: 16661,
  proofNonce: keccak256(new TextEncoder().encode('test-nonce-1')),
  contractAddress: '0x9e71d79f06f956d4d2666b5c93dafab721c84721' as Address,
}

describe('transferProofPreimage', () => {
  test('matches the abi.encode(...) formula from AnimaAgentNFT.sol:109-113', () => {
    const expected = keccak256(
      encodeAbiParameters(
        [
          { type: 'uint256' },
          { type: 'address' },
          { type: 'address' },
          { type: 'bytes32[]' },
          { type: 'uint256' },
          { type: 'bytes32' },
          { type: 'address' },
        ],
        [
          SAMPLE.tokenId,
          SAMPLE.from,
          SAMPLE.to,
          [...SAMPLE.newHashes],
          BigInt(SAMPLE.chainId),
          SAMPLE.proofNonce,
          SAMPLE.contractAddress,
        ],
      ),
    )
    expect(transferProofPreimage(SAMPLE)).toBe(expected)
  })

  test('changes when any input changes', () => {
    const base = transferProofPreimage(SAMPLE)
    expect(transferProofPreimage({ ...SAMPLE, tokenId: 8n })).not.toBe(base)
    expect(transferProofPreimage({ ...SAMPLE, to: SAMPLE.from })).not.toBe(base)
    expect(transferProofPreimage({ ...SAMPLE, chainId: 16602 })).not.toBe(base)
  })

  test('throws when newHashes length != 6', () => {
    expect(() =>
      transferProofPreimage({ ...SAMPLE, newHashes: SAMPLE.newHashes.slice(0, 5) }),
    ).toThrow(/must have 6 elements/)
  })
})

describe('signTransferProof', () => {
  test('signature recovers to oracle address (matches contract recover step)', async () => {
    const oracleSigner = new RawPrivkeyOperatorSigner({ privkey: ORACLE_KEY })
    const sig = await signTransferProof(SAMPLE, oracleSigner)
    expect(sig.length).toBe(132) // 0x + 65 bytes hex

    // Replicate the contract's recover: msgHash.toEthSignedMessageHash().recover(sig)
    const preimage = transferProofPreimage(SAMPLE)
    const ethSigned = hashMessage({ raw: preimage })
    const recovered = await recoverAddress({ hash: ethSigned, signature: sig })
    expect(recovered.toLowerCase()).toBe(ORACLE_ADDR.toLowerCase())
  })

  test('different oracles produce different sigs', async () => {
    const ALT_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex // anvil #2
    const sigA = await signTransferProof(
      SAMPLE,
      new RawPrivkeyOperatorSigner({ privkey: ORACLE_KEY }),
    )
    const sigB = await signTransferProof(SAMPLE, new RawPrivkeyOperatorSigner({ privkey: ALT_KEY }))
    expect(sigA).not.toBe(sigB)
  })
})

describe('buildTransferHashes', () => {
  const currentHashes: Hex[] = INTELLIGENT_DATA_SLOTS.map(s =>
    keccak256(new TextEncoder().encode(`current:${s}`)),
  )
  const newKeystoreHash = keccak256(new TextEncoder().encode('new-keystore-blob')) as Hex

  test('returns 6 elements in canonical slot order', () => {
    const out = buildTransferHashes({ currentHashes, newKeystoreHash })
    expect(out.length).toBe(INTELLIGENT_DATA_SLOTS.length)
  })

  test('replaces only the keystore slot when other slots are passthrough', () => {
    const out = buildTransferHashes({ currentHashes, newKeystoreHash, purgeProfile: false })
    expect(out[slotIndex('keystore')]).toBe(newKeystoreHash)
    expect(out[slotIndex('memory-index')]).toBe(currentHashes[slotIndex('memory-index')])
    expect(out[slotIndex('identity')]).toBe(currentHashes[slotIndex('identity')])
    expect(out[slotIndex('persona')]).toBe(currentHashes[slotIndex('persona')])
    expect(out[slotIndex('activity-log')]).toBe(currentHashes[slotIndex('activity-log')])
    expect(out[slotIndex('profile')]).toBe(currentHashes[slotIndex('profile')])
  })

  test('purges profile slot to bootstrap by default', () => {
    const out = buildTransferHashes({ currentHashes, newKeystoreHash })
    expect(out[slotIndex('profile')]).toBe(bootstrapHashFor('profile'))
  })

  test('throws when currentHashes length != 6', () => {
    expect(() =>
      buildTransferHashes({ currentHashes: currentHashes.slice(0, 5), newKeystoreHash }),
    ).toThrow(/must have 6 elements/)
  })
})

/**
 * Re-encryption round-trip: simulates what `reEncryptKeystoreForRecipient`
 * does cryptographically, without going through 0G Storage. Proves:
 *  - keystore encrypted to operator A is decryptable by A
 *  - re-encrypting that keystore to operator B yields a blob B can decrypt
 *  - the new blob is NOT decryptable by A (key separation works)
 *  - the recovered agent privkey matches across both decrypt paths
 */
describe('keystore re-encryption round-trip (operator A → B)', () => {
  test('B can decrypt the re-encrypted keystore; A cannot', async () => {
    // Throwaway operator A + B, throwaway agent EOA.
    const opAKey = generatePrivateKey()
    const opBKey = generatePrivateKey()
    const agentKey = generatePrivateKey()
    const opA = new RawPrivkeyOperatorSigner({ privkey: opAKey })
    const opB = new RawPrivkeyOperatorSigner({ privkey: opBKey })
    const agentAddress = privateKeyToAccount(agentKey).address

    // 1. Encrypt agent privkey with operator A's signature.
    const blobA = await encryptAgentKey({
      signer: opA,
      agentAddress,
      agentPrivkey: agentKey,
    })

    // 2. Decrypt with A — sanity check baseline.
    const recoveredByA = await decryptAgentKey({
      signer: opA,
      agentAddress,
      keystore: blobA,
    })
    expect(recoveredByA).toBe(agentKey)

    // 3. Re-encrypt with operator B.
    const blobB = await encryptAgentKey({
      signer: opB,
      agentAddress,
      agentPrivkey: recoveredByA,
    })
    expect(blobB.blob).not.toBe(blobA.blob) // different IV + different key

    // 4. B can decrypt B's blob.
    const recoveredByB = await decryptAgentKey({
      signer: opB,
      agentAddress,
      keystore: blobB,
    })
    expect(recoveredByB).toBe(agentKey)

    // 5. A CANNOT decrypt B's blob — auth tag mismatch.
    let aCannotDecrypt = false
    try {
      await decryptAgentKey({
        signer: opA,
        agentAddress,
        keystore: blobB,
      })
    } catch {
      aCannotDecrypt = true
    }
    expect(aCannotDecrypt).toBe(true)
  })
})
