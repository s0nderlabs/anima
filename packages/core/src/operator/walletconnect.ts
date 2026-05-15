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
  getTypesForEIP712Domain,
  numberToHex,
} from 'viem'
import { type LocalAccount, toAccount } from 'viem/accounts'
import { ogChain } from '../chain'
import { NETWORK_CHAIN_ID, NETWORK_RPC } from '../config'
import type { AnimaNetwork } from '../config'
import type { OperatorSigner } from './signer'

/**
 * Recursively replace BigInt values with hex strings ("0x..."). Standard
 * Ethereum JSON-RPC encoding for `gas`, `value`, `nonce`, `maxFeePerGas`,
 * `maxPriorityFeePerGas`, etc. Used at the WC transport boundary because
 * the universal-provider JSON.stringifies its payload before sending over
 * the relay, and JSON.stringify throws on BigInt.
 */
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return numberToHex(value)
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v)
    return out
  }
  return value
}

/**
 * Ephemeral in-memory storage adapter for WC v2. WC's default storage uses
 * a disk-persisted cache that leaks session state across CLI runs: old
 * sessions trigger `No matching key` errors AND `session_event` chainChanged
 * messages get replayed, which crashes EthereumProvider's default handler
 * when the chain isn't in our active config. By using a fresh Map per
 * provider instance, every `anima init` / `anima restore` starts WC with a
 * clean slate.
 */
class EphemeralWcStorage {
  private store = new Map<string, unknown>()
  async getKeys(): Promise<string[]> {
    return Array.from(this.store.keys())
  }
  async getEntries<T = unknown>(): Promise<[string, T][]> {
    return Array.from(this.store.entries()) as [string, T][]
  }
  async getItem<T = unknown>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined
  }
  async setItem<T = unknown>(key: string, value: T): Promise<void> {
    this.store.set(key, value as unknown)
  }
  async removeItem(key: string): Promise<void> {
    this.store.delete(key)
  }
}

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

    // Reown (WalletConnect v2) best-practice init: optionalChains + rpcMap.
    // Per docs (docs.reown.com/advanced/providers/ethereum, verified Apr 27
    // 2026): "We recommend using optionalChains (optional namespaces) over
    // chains (required namespaces). Required namespaces will block wallets
    // from connecting if any of the chains are not supported by the wallet."
    // 0G is not in MM Mobile's built-in chain registry, so 0G in REQUIRED
    // returns `User rejected methods` at session establishment.
    //
    // `rpcMap` is required for chains not in WalletConnect's Blockchain API
    // catalog (which excludes 0G). Without it, universal-provider falls back
    // to a non-existent endpoint and chain-aware methods fail silently.
    //
    // `optionalMethods` is left to defaults; WC includes the full EIP-1193
    // method list automatically (eth_sendTransaction, eth_signTypedData_v4,
    // wallet_switchEthereumChain, wallet_addEthereumChain, etc.).
    // Session chains config: `chains: [1]` is the REQUIRED handshake anchor.
    // Every WC wallet supports Ethereum mainnet, so the session never fails
    // on "wallet doesn't know this chain". `optionalChains: [16661, ...]` is
    // where the actual work happens, MM accepts each that it has in its
    // chain registry. When the user has 0G pre-added in MM Mobile,
    // 16661 lands in the session's approved namespaces alongside chain 1.
    //
    // Pure `optionalChains` without `chains` was tested and produced a
    // session whose namespace was empty/chain-1-only, so `eth_sendTransaction`
    // for 16661 silently failed at WC layer with `-32004 Method not supported`
    // before reaching MM (no popup). The required handshake on chain 1 is
    // what gives WC enough state to route requests correctly.
    //
    // `rpcMap` provides a custom RPC for 0G chains since they're not in
    // WC's Blockchain API catalog.
    const optionalChains = this.chainIds() as [number, ...number[]]
    const rpcMap: Record<number, string> = {}
    for (const net of this.options.networks) rpcMap[NETWORK_CHAIN_ID[net]] = NETWORK_RPC[net]
    const provider = await EthereumProvider.init({
      projectId: this.options.projectId,
      chains: [1],
      optionalChains,
      rpcMap,
      showQrModal: false,
      // biome-ignore lint/suspicious/noExplicitAny: WC's IKeyValueStorage has loose generics
      storage: new EphemeralWcStorage() as any,
      metadata: {
        name: 'Anima',
        description: 'Sovereign agent harness on 0G',
        url: 'https://anima.s0nderlabs.xyz',
        icons: [],
      },
    })

    // Replace WC's default `setChainId` with one that updates internal
    // chainId WITHOUT calling switchEthereumChain back to the wallet. WC's
    // default handler does:
    //   if (isCompatibleChainId(t)) {
    //     this.chainId = parseChainId(t)
    //     this.switchEthereumChain(parseChainId(t))   // ← crashes
    //   }
    // The crash: `switchEthereumChain` calls `this.request(...)` which routes
    // through `getProvider(namespace).request`, but for chains we never
    // configured a provider for, `getProvider(...)` returns undefined and
    // the `.request` dereference is an uncaught TypeError that kills the
    // process. We still need the `this.chainId = ...` part; without it,
    // `eth_sendTransaction` routes to the wrong namespace and MM hangs.
    type ProvWithChainState = {
      isCompatibleChainId?: (id: string) => boolean
      chainId?: number
    }
    const provInternal = provider as unknown as ProvWithChainState
    type WithSetChainId = { setChainId?: (chainId: string) => void }
    const provWithChainId = provider as unknown as WithSetChainId
    provWithChainId.setChainId = (chainId: string) => {
      if (!provInternal.isCompatibleChainId?.(chainId)) return
      const parsed = Number(chainId.split(':')[1])
      if (Number.isFinite(parsed)) provInternal.chainId = parsed
    }

    if (provider.session && provider.accounts.length > 0) {
      this.provider = provider
      this.connectedAddress = provider.accounts[0] as Address
      return provider
    }

    const uriPromise = new Promise<string>(resolve => {
      provider.once('display_uri', resolve)
    })

    const connectPromise = provider.connect({ chains: [1], optionalChains })
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
    } catch (e) {
      // Surface the underlying WC error in a form the wizard can display.
      // Tear down listeners/session before throwing so any tail relay events
      // (chainChanged for unknown chains, disconnect from a lingering peer
      // session) can't crash the process after we've already given up.
      try {
        provider.events.removeAllListeners()
        provider.signer?.events?.removeAllListeners?.()
      } catch {}
      try {
        await provider.disconnect()
      } catch {}
      const msg = (e as Error).message ?? String(e)
      if (/User rejected/i.test(msg)) {
        throw new Error(
          'WalletConnect: wallet rejected the session request. Approve in your wallet app and retry.',
        )
      }
      if (/timeout/i.test(msg)) {
        throw new Error(
          `WalletConnect: pairing timed out after ${this.options.connectTimeoutMs / 1000}s. Scan the QR within the timeout window or rerun.`,
        )
      }
      if (/No matching key/i.test(msg)) {
        throw new Error(
          'WalletConnect: stale session detected (likely from a previous interrupted run). Disconnect anima from your wallet app and retry.',
        )
      }
      throw new Error(`WalletConnect connect failed: ${msg}`)
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

    const account = toAccount({
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
          params: [jsonSafe(tx)],
        })
        return result as `0x${string}`
      },
      async signTypedData(typedData) {
        // v0.24.9: inject canonical `EIP712Domain` into `types` so the
        // domain separator matches viem's `hashTypedData`. Without this MM's
        // `sanitizeData` adds `EIP712Domain: []` (empty) and the resulting
        // sig diverges from LocalAccount sigs over the same payload.
        // `signTypedDataLegacyEmptyDomain` (attached below) preserves the
        // pre-v0.24.9 verbatim shape so legacy WC-init'd keystores still
        // decrypt via the keystore-crypto fallback. See
        // feedback-wc-signTypedData-eip712domain-trap.md.
        const td = typedData as Parameters<typeof getTypesForEIP712Domain>[0] & {
          types?: Record<string, unknown>
          primaryType: string
          message: Record<string, unknown>
        }
        const withDomain = {
          ...td,
          types: {
            EIP712Domain: getTypesForEIP712Domain({ domain: td.domain }),
            ...(td.types ?? {}),
          },
        }
        const result = await provider.request({
          method: 'eth_signTypedData_v4',
          params: [addr, JSON.stringify(withDomain)],
        })
        return result as `0x${string}`
      },
    })
    // Attach the legacy variant as a sibling method on the Account. The
    // keystore-crypto fallback path discovers it via duck-typing and calls
    // it only after canonical-key decrypt fails AES-GCM (i.e. when a
    // pre-v0.24.9 WC-init'd keystore is being unlocked). LocalAccount
    // signers (raw-privkey, keystore-file, keychain) never expose this
    // method, so canonical-only behavior is preserved for them.
    Object.defineProperty(account, 'signTypedDataLegacyEmptyDomain', {
      value: async (typedData: unknown) => {
        const result = await provider.request({
          method: 'eth_signTypedData_v4',
          params: [addr, JSON.stringify(typedData)],
        })
        return result as `0x${string}`
      },
      enumerable: false,
      writable: false,
    })
    return account
  }

  /**
   * Ensure the wallet has the target 0G chain in its registry and active.
   * MM does NOT support `eth_signTransaction`, so the wallet itself has to
   * broadcast via `eth_sendTransaction`; that requires the chain to be
   * configured wallet-side. Idempotent, safe to call before every tx.
   */
  private async addAndSwitchChain(network: AnimaNetwork): Promise<void> {
    const provider = this.provider
    if (!provider) return
    const chainId = numberToHex(NETWORK_CHAIN_ID[network])
    const chain = ogChain(network)
    try {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId,
            chainName: chain.name,
            nativeCurrency: chain.nativeCurrency,
            rpcUrls: chain.rpcUrls.default.http,
            blockExplorerUrls:
              network === '0g-mainnet'
                ? ['https://chainscan.0g.ai']
                : ['https://chainscan-galileo.0g.ai'],
          },
        ],
      })
    } catch {
      // Already added: benign.
    }
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId }],
      })
    } catch {
      // Switch failed; eth_sendTransaction will surface a clearer error.
    }
  }

  async walletClient(network: AnimaNetwork): Promise<WalletClient> {
    const provider = await this.ensureProvider()
    await this.addAndSwitchChain(network)
    const addr = await this.address()
    const chain = ogChain(network)
    // Account MUST be type 'json-rpc' so viem routes via eth_sendTransaction;
    // see walletconnect.test.ts for the regression that pins this contract.
    return createWalletClient({
      account: { address: addr, type: 'json-rpc' as const },
      chain,
      transport: custom({
        async request({ method, params }) {
          // jsonSafe normalizes BigInts to hex; WC's universal-provider
          // JSON.stringifies the payload and BigInt has no JSON encoding.
          const normalized = jsonSafe(params) as unknown[]
          return provider.request({ method, params: normalized })
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
      const p = this.provider
      // Strip ALL listeners before disconnect: WC's universal-provider keeps
      // emitting `session_event` (chainChanged, accountsChanged) up until
      // `disconnect()` resolves, and the EthereumProvider's default handler
      // calls `wallet_switchEthereumChain` against `getProvider(chain)` which
      // can return undefined for chains we never configured. The result is
      // an uncaught TypeError that crashes the process AFTER the caller has
      // already decided to bail. Pulling listeners first is the only way to
      // reliably suppress those tail events.
      // EthereumProvider attaches its real listeners on `signer.events`
      // (the universal-provider's emitter), not on `p.events`. Strip both.
      try {
        p.events.removeAllListeners()
        p.signer?.events?.removeAllListeners?.()
      } catch {
        // events bag might already be torn down; non-fatal.
      }
      try {
        await p.disconnect()
      } catch {
        // Idempotent close; disconnect on an already-closed session throws.
      }
      this.provider = null
      this.connectedAddress = null
    }
  }
}
