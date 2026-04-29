import { secp256k1 } from '@noble/curves/secp256k1.js'
import { type Hex, hexToBytes, toHex } from 'viem'

/**
 * Derive the secp256k1 uncompressed public key (`0x04 + x32 + y32`, 65 bytes /
 * 130 hex chars) from a private key. This is the canonical form used by ECIES
 * libraries (eciesjs, eth-crypto) and is what we publish as the `pubkey` text
 * record on an agent's `.0g` subname so other animas can encrypt to it.
 */
export function derivePubkeyHex(privkeyHex: Hex | string): Hex {
  const priv = privkeyHex.startsWith('0x')
    ? hexToBytes(privkeyHex as Hex)
    : hexToBytes(`0x${privkeyHex}`)
  const pub = secp256k1.getPublicKey(priv, false) // false = uncompressed (65 B)
  return toHex(pub)
}
