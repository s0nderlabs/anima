export { SANDBOX_SERVING_ABI, SANDBOX_SETTLEMENT_GALILEO } from './abi'

export {
  type SignedRequest,
  type SignedHeaders,
  type SignRequestOpts,
  signRequest,
} from './auth'

export {
  type SandboxResources,
  type CreateSandboxBody,
  type SandboxRecord,
  type ToolboxExecBody,
  type ToolboxExecResponse,
  type ProviderInfo,
  type ProviderListing,
  type SandboxProviderClientOpts,
  SandboxProviderClient,
} from './provider-client'

export {
  type SettlementClientOpts,
  SandboxSettlementClient,
  getSandboxBillingReserve,
} from './settlement'

/**
 * Galileo testnet provider's PROXY_DOMAIN. Inbound HTTP to a sandbox arrives
 * at `<port>-<sandboxId>.<HOST>` (verified Apr 23 2026; provider IP
 * `43.106.147.28` resolves through nip.io directly).
 *
 * If the provider rotates IPs or domain, update this constant. Anima callers
 * should always go through `buildSandboxEndpoint` rather than hand-rolling.
 */
export const SANDBOX_NIP_IO_HOST = '43.106.147.28.nip.io:4000'

/**
 * Galileo testnet provider's TEE signer (v3). Stable per signer-version; the
 * settlement contract only accepts deposits AFTER the operator acknowledges
 * this signer once. v3 signed-headers (`X-Wallet-Address`,
 * `X-Signed-Message`, `X-Wallet-Signature`) require it.
 */
export const SANDBOX_TEE_SIGNER_GALILEO = '0x2567a8b81305e1D9070B551314f7354185a412e3' as const

/**
 * Galileo testnet provider's wallet address. Returned by `/api/providers`.
 */
export const SANDBOX_PROVIDER_GALILEO = '0xB831371eb2703305f1d9F8542163633D0675CEd7' as const

/**
 * Galileo testnet provider's HTTP base URL. The `/info`, `/api/providers`,
 * `/api/sandbox`, etc endpoints all hang off this root.
 */
export const SANDBOX_PROVIDER_URL_GALILEO =
  'https://provider-private-sandbox-testnet.0g.ai' as const

/**
 * Galileo testnet sandbox runtime billing rate, in 0G/hour. Surfaced in the
 * init wizard's cost summary and by `anima topup --sandbox` for the runway
 * estimate `balance / rate`. Galileo testnet 0G is faucet-funded; the rate
 * is real but the dollar cost is $0.
 */
export const SANDBOX_BURN_RATE_OG_PER_HOUR = 0.09

/**
 * Default initial deposit on the Galileo SandboxSettlement contract when
 * `anima init --target sandbox` provisions a fresh container. Mirrors the
 * `depositOg ?? 1` fallback in `runSandboxProvision`.
 */
export const SANDBOX_DEFAULT_INITIAL_DEPOSIT_OG = 1

export interface BuildSandboxEndpointOpts {
  sandboxId: string
  /** Default 8080 — anima harness binds 8080 inside the container. */
  port?: number
}

/**
 * Compose the full inbound URL for a sandbox-resident HTTP server. Operator's
 * laptop hits `${endpoint}/healthz`, `/chat`, `/events`, etc; the provider's
 * reverse proxy decodes the `<port>-<id>` prefix and routes to the correct
 * container.
 */
export function buildSandboxEndpoint(opts: BuildSandboxEndpointOpts): string {
  const port = opts.port ?? 8080
  return `http://${port}-${opts.sandboxId}.${SANDBOX_NIP_IO_HOST}`
}
