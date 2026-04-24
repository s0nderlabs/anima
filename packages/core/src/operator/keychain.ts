import { execSync } from 'node:child_process'
import {
  http,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
  createPublicClient,
} from 'viem'
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'
import { makeViemClients, ogChain } from '../chain'
import type { AnimaNetwork } from '../config'
import type { OperatorSigner } from './signer'

/**
 * Loads the operator privkey from the macOS keychain under a service name.
 * This is elpabl0's dev pattern; it is NOT the only supported operator
 * source. See `feedback-wallet-source-multi-option.md`: production flows
 * will add MetaMask / WalletConnect / hardware / keystore / env-var
 * implementations of `OperatorSigner`.
 */
export class KeychainOperatorSigner implements OperatorSigner {
  readonly source: string
  private cachedPrivkey: Hex | null = null
  private cachedAccount: PrivateKeyAccount | null = null

  constructor(private readonly keychainService: string = 'dev.deployer') {
    this.source = `keychain:${keychainService}`
  }

  private loadPrivkey(): Hex {
    if (this.cachedPrivkey) return this.cachedPrivkey
    const raw = execSync(`security find-generic-password -s ${this.keychainService} -w`)
      .toString()
      .trim()
    this.cachedPrivkey = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex
    return this.cachedPrivkey
  }

  async account(): Promise<PrivateKeyAccount> {
    if (this.cachedAccount) return this.cachedAccount
    this.cachedAccount = privateKeyToAccount(this.loadPrivkey())
    return this.cachedAccount
  }

  async address(): Promise<Address> {
    return (await this.account()).address
  }

  async walletClient(network: AnimaNetwork): Promise<WalletClient> {
    return makeViemClients({ network, privkeyHex: this.loadPrivkey() }).walletClient
  }

  async publicClient(network: AnimaNetwork): Promise<PublicClient> {
    const chain = ogChain(network)
    return createPublicClient({
      transport: http(chain.rpcUrls.default.http[0]),
      chain,
    })
  }

  chain(network: AnimaNetwork): Chain {
    return ogChain(network)
  }
}
