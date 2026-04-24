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
import { type AnimaNetwork, NETWORK_RPC } from '../config'
import type { OperatorSigner } from './signer'

/**
 * Shared base for privkey-backed operator sources. Subclasses only need to
 * implement `loadPrivkey()` — everything else (viem account/wallet/public
 * clients, caching) is identical across keychain / keystore-file / raw
 * privkey, and that shared plumbing lives here.
 *
 * WalletConnect does NOT extend this base: its signing happens on a paired
 * phone, there's no local privkey, so it has its own custom `walletClient`.
 */
export abstract class PrivkeyOperatorSigner implements OperatorSigner {
  abstract readonly source: string
  private cachedPrivkey: Hex | null = null
  private cachedAccount: PrivateKeyAccount | null = null

  /** Subclass hook: yield a 32-byte hex privkey. Caller invoked at most once. */
  protected abstract loadPrivkey(): Promise<Hex>

  protected async getPrivkey(): Promise<Hex> {
    if (!this.cachedPrivkey) this.cachedPrivkey = await this.loadPrivkey()
    return this.cachedPrivkey
  }

  async account(): Promise<PrivateKeyAccount> {
    if (!this.cachedAccount) this.cachedAccount = privateKeyToAccount(await this.getPrivkey())
    return this.cachedAccount
  }

  async address(): Promise<Address> {
    return (await this.account()).address
  }

  async walletClient(network: AnimaNetwork): Promise<WalletClient> {
    return makeViemClients({ network, privkeyHex: await this.getPrivkey() }).walletClient
  }

  async publicClient(network: AnimaNetwork): Promise<PublicClient> {
    return createPublicClient({
      transport: http(NETWORK_RPC[network]),
      chain: ogChain(network),
    })
  }

  chain(network: AnimaNetwork): Chain {
    return ogChain(network)
  }
}
