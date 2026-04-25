import { EthereumProvider } from '@walletconnect/ethereum-provider'
import qrcode from 'qrcode-terminal'
import {
  http,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  custom,
} from 'viem'
import { type LocalAccount, toAccount } from 'viem/accounts'
import { ogChain } from '../chain'
import { NETWORK_CHAIN_ID } from '../config'
import type { AnimaNetwork } from '../config'
import type { OperatorSigner } from './signer'

/**
 * s0nderlabs-registered WalletConnect v2 project ID. Not a secret (WC project
 * IDs are public client-side identifiers, same category as Stripe publishable
 * keys). Users can override with `ANIMA_WC_PROJECT_ID` env var if they want
 * their own project for isolated rate-limits/analytics.
 */
export const ANIMA_WC_PROJECT_ID =
  process.env.ANIMA_WC_PROJECT_ID ?? '974ed7663d88e07086104fa9a73b2d87'

type EthProvider = Awaited<ReturnType<typeof EthereumProvider.init>>

export interface WalletConnectOperatorSignerOptions {
  /** WC project ID. Defaults to the anima-bundled one. */
  projectId?: string
  /** Networks to expose to the wallet. Default: both 0G mainnet and testnet. */
  networks?: AnimaNetwork[]
  /** Render the pairing QR to stdout automatically. Default true. */
  showQr?: boolean
  /** Callback with the pairing URI for custom rendering (copy-to-clipboard, etc). */
  onDisplayUri?: (uri: string) => void
  /** Max time to wait for user to connect (ms). Default 180000 (3 min). */
  connectTimeoutMs?: number
}

/**
 * Operator source backed by WalletConnect v2. QR-pair with any WC-compatible
 * mobile wallet (MetaMask Mobile, Rainbow, Trust, Coinbase Wallet, Zerion,
 * Safe, Ledger Live, Phantom, OKX, Binance Wallet — 300+ wallets total).
 *
 * Signing flows: the CLI generates a pairing URI, renders it as an ASCII QR
 * in the terminal, user scans with their phone. Subsequent signing requests
 * pop up on the phone; the user approves, signed tx comes back over the WC
 * relay. Keys never leave the phone. Fully non-custodial.
 *
 * Session is NOT persisted across `anima` invocations in MVP. For the init
 * flow that's fine (one-shot). Post-MVP: persist session to
 * `~/.anima/wc-session.json` so `anima topup` reuses the pair.
 */
export class WalletConnectOperatorSigner implements OperatorSigner {
  readonly source: string
  private provider: EthProvider | null = null
  private connectedAddress: Address | null = null
  private readonly options: Required<WalletConnectOperatorSignerOptions>

  constructor(options: WalletConnectOperatorSignerOptions = {}) {
    const networks = options.networks ?? (['0g-mainnet', '0g-testnet'] as AnimaNetwork[])
    this.options = {
      projectId: options.projectId ?? ANIMA_WC_PROJECT_ID,
      networks,
      showQr: options.showQr ?? true,
      onDisplayUri: options.onDisplayUri ?? (() => {}),
      connectTimeoutMs: options.connectTimeoutMs ?? 180_000,
    }
    this.source = 'walletconnect'
  }

  private chainIds(): number[] {
    return this.options.networks.map(n => NETWORK_CHAIN_ID[n])
  }

  private async ensureProvider(): Promise<EthProvider> {
    if (this.provider && this.connectedAddress) return this.provider

    const chains = this.chainIds() as [number, ...number[]]
    const provider = await EthereumProvider.init({
      projectId: this.options.projectId,
      chains,
      showQrModal: false,
    })

    if (provider.session && provider.accounts.length > 0) {
      this.provider = provider
      this.connectedAddress = provider.accounts[0] as Address
      return provider
    }

    const uriPromise = new Promise<string>(resolve => {
      provider.once('display_uri', resolve)
    })

    const connectPromise = provider.connect({ chains })
    const uri = await uriPromise
    this.options.onDisplayUri(uri)
    if (this.options.showQr) {
      qrcode.generate(uri, { small: true })
      console.log(`\nScan with any WalletConnect-compatible mobile wallet.\nOr copy URI:\n${uri}\n`)
    }

    let timeoutHandle: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () =>
          reject(
            new Error(`WalletConnect pair timeout after ${this.options.connectTimeoutMs / 1000}s`),
          ),
        this.options.connectTimeoutMs,
      )
    })
    try {
      await Promise.race([connectPromise, timeoutPromise])
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }

    if (!provider.accounts || provider.accounts.length === 0) {
      throw new Error('WalletConnect paired but no accounts returned')
    }

    this.provider = provider
    this.connectedAddress = provider.accounts[0] as Address
    return provider
  }

  async address(): Promise<Address> {
    await this.ensureProvider()
    if (!this.connectedAddress) throw new Error('WalletConnect: not connected')
    return this.connectedAddress
  }

  async account(): Promise<LocalAccount> {
    const provider = await this.ensureProvider()
    const addr = await this.address()

    return toAccount({
      address: addr,
      async signMessage({ message }) {
        const raw =
          typeof message === 'string' ? message : `0x${Buffer.from(message.raw).toString('hex')}`
        const result = await provider.request({
          method: 'personal_sign',
          params: [raw, addr],
        })
        return result as `0x${string}`
      },
      async signTransaction(tx) {
        const result = await provider.request({
          method: 'eth_signTransaction',
          params: [tx],
        })
        return result as `0x${string}`
      },
      async signTypedData(typedData) {
        const result = await provider.request({
          method: 'eth_signTypedData_v4',
          params: [addr, JSON.stringify(typedData)],
        })
        return result as `0x${string}`
      },
    })
  }

  async walletClient(network: AnimaNetwork): Promise<WalletClient> {
    const provider = await this.ensureProvider()
    const account = await this.account()
    const chain = ogChain(network)
    return createWalletClient({
      account,
      chain,
      transport: custom({
        async request({ method, params }) {
          return provider.request({ method, params: params as unknown[] })
        },
      }),
    })
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

  async close(): Promise<void> {
    if (this.provider) {
      try {
        await this.provider.disconnect()
      } catch {
        // Idempotent close; disconnect on an already-closed session throws.
      }
      this.provider = null
      this.connectedAddress = null
    }
  }
}
