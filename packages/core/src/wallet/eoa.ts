import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { bytesToHex, hexToBytes } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { type EncryptedKeystore, decryptKey, encryptKey } from './keystore'

/**
 * Library-agnostic agent wallet material. Callers instantiate the right
 * chain library (viem `privateKeyToAccount`, ethers `new Wallet(hex)`, etc.)
 * at point of use.
 */
export interface AgentWalletMaterial {
  /** 0x-prefixed hex private key. */
  privkeyHex: `0x${string}`
  /** EIP-55 address derived from the key. */
  address: `0x${string}`
}

export function generateAgentWallet(): AgentWalletMaterial {
  const privkeyHex = generatePrivateKey()
  const account = privateKeyToAccount(privkeyHex)
  return { privkeyHex, address: account.address }
}

export async function saveKeystore(
  path: string,
  privkeyHex: string,
  passphrase: string,
): Promise<void> {
  const privkey = hexToBytes(privkeyHex as `0x${string}`)
  const encrypted = encryptKey(privkey, passphrase)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(encrypted, null, 2), 'utf8')
}

export async function loadKeystore(path: string, passphrase: string): Promise<AgentWalletMaterial> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Keystore not found at ${path}`)
    }
    throw e
  }
  const encrypted = JSON.parse(raw) as EncryptedKeystore
  const privkey = decryptKey(encrypted, passphrase)
  const privkeyHex = bytesToHex(privkey)
  const account = privateKeyToAccount(privkeyHex)
  return { privkeyHex, address: account.address }
}
