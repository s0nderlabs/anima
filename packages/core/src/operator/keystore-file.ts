import { readFile } from 'node:fs/promises'
import { Wallet as EthersWallet } from 'ethers'
import type { Hex } from 'viem'
import { PrivkeyOperatorSigner } from './privkey-base'

/**
 * Operator source backed by a standard geth-format encrypted JSON keystore.
 * Portable across machines, no network dependency, no OS-specific keystore.
 *
 * Caller is responsible for prompting the user for the passphrase; the signer
 * just decrypts lazily on first use and caches the privkey in memory.
 */
export class KeystoreFileOperatorSigner extends PrivkeyOperatorSigner {
  readonly source: string

  constructor(
    private readonly opts: {
      /** Absolute path to the encrypted JSON keystore (geth format). */
      path: string
      /** Pre-collected passphrase. CLI prompts; core decrypts. */
      passphrase: string
    },
  ) {
    super()
    this.source = `keystore:${opts.path}`
  }

  protected async loadPrivkey(): Promise<Hex> {
    const json = await readFile(this.opts.path, 'utf8')
    const wallet = await EthersWallet.fromEncryptedJson(json, this.opts.passphrase)
    return wallet.privateKey as Hex
  }
}
