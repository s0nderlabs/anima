import type { LocalAccount } from 'viem/accounts'
import { type SignedHeaders, signRequest } from './auth'

export interface SandboxResources {
  cpu?: number
  memory?: number
  disk?: number
  class?: 'small' | 'medium' | 'large'
}

export interface CreateSandboxBody {
  /** Pre-baked snapshot name (e.g. `daytonaio/sandbox:0.5.0-slim`). */
  snapshot?: string
  /** Raw Docker image ref (e.g. `ubuntu:22.04`). */
  image?: string
  name?: string
  sealed?: boolean
  env?: Record<string, string>
  resources?: SandboxResources
}

export interface SandboxRecord {
  id: string
  state: string
  /** Operator-supplied unique name (when provided to createSandbox). */
  name?: string
  imageName?: string
  cpu?: number
  mem?: number
  disk?: number
  createdAt?: number
  labels?: Record<string, string>
}

export interface ToolboxExecBody {
  command: string
  /** Seconds. Provider caps at ~600. */
  timeout?: number
  cwd?: string
  env?: Record<string, string>
}

/**
 * Daytona's `process/execute` returns `{exitCode, result}` (combined stdout +
 * stderr) — NOT separate stdout / stderr streams. Older docs imply both
 * shapes exist depending on endpoint, so we type all three as optional and
 * callers should prefer `result` when present.
 */
export interface ToolboxExecResponse {
  exitCode: number
  result?: string
  stdout?: string
  stderr?: string
  durationMs?: number
}

export interface ProviderInfo {
  contract_address: string
  provider_address: string
  rpc_url: string
  chain_id: number
  create_fee: string
  compute_price_per_sec: string
  voucher_interval_sec: number
  min_balance: string
}

export interface ProviderListing {
  address: string
  url: string
  tee_signer: string
  price_per_cpu_per_min: string
  price_per_cpu_per_sec: string
  price_per_mem_gb_per_min: string
  price_per_mem_gb_per_sec: string
  create_fee: string
  signer_version: string
}

export interface SandboxProviderClientOpts {
  /** Provider base URL (e.g. https://provider-private-sandbox-testnet.0g.ai). */
  endpoint: string
  operator: LocalAccount
  fetchImpl?: typeof fetch
  /**
   * Optional retry policy for 504 / 502 / 503 / network errors. Defaults: 3
   * retries with 2s base + linear backoff. Daytona's upstream periodically
   * hits 60s timeouts; without retry, every request that races the upstream
   * timeout fails the deploy. POST + PUT methods retry too because the only
   * non-idempotent endpoint is `createSandbox`, and 504 there means the
   * upstream never received the request (no orphan side-effect).
   */
  retries?: number
  /** Default 2000ms. Each attempt waits attempt * baseMs. */
  retryBaseMs?: number
  /**
   * Per-request fetch deadline (ms), applied via `AbortSignal.timeout` per
   * attempt. Without these, a stuck Daytona backend can hang the CLI for
   * minutes. Defaults: 30s for read, 60s for write/exec.
   */
  requestTimeoutMs?: { read?: number; write?: number }
}

/**
 * HTTP client for the 0G Sandbox provider proxy. Wraps EIP-191 signed-header
 * auth and the routes documented in `0g-sandbox/API_REFERENCE.md`.
 *
 * Auth model: every authenticated request carries an EIP-191 signed
 * SignedRequest as headers. Public reads (info, providers, registry) need no auth.
 *
 * The Galileo testnet provider runs at
 *   https://provider-private-sandbox-testnet.0g.ai
 * with provider address 0xB831371eb2703305f1d9F8542163633D0675CEd7.
 */
/**
 * Statuses worth retrying. Daytona's upstream periodically times out at 60s
 * and surfaces 504 Gateway Timeout; provider proxy returns 502/503 during
 * Daytona restarts. Anima's deploy/poll flow is idempotent for these so a
 * short retry loop saves the operator from "redeploy from scratch" cycles.
 */
const RETRYABLE_STATUSES = new Set([502, 503, 504])

export class SandboxProviderClient {
  endpoint: string
  operator: LocalAccount
  #fetch: typeof fetch
  #retries: number
  #retryBaseMs: number
  #readTimeoutMs: number
  #writeTimeoutMs: number

  constructor(opts: SandboxProviderClientOpts) {
    this.endpoint = opts.endpoint.replace(/\/$/, '')
    this.operator = opts.operator
    this.#fetch = opts.fetchImpl ?? globalThis.fetch
    this.#retries = opts.retries ?? 3
    this.#retryBaseMs = opts.retryBaseMs ?? 2000
    this.#readTimeoutMs = opts.requestTimeoutMs?.read ?? 30_000
    this.#writeTimeoutMs = opts.requestTimeoutMs?.write ?? 60_000
  }

  /**
   * Retry helper. Each attempt re-runs the `buildInit` closure to mint a
   * FRESH signed-request envelope (fresh nonce + fresh expiry). This is
   * critical: Daytona's auth middleware rejects nonce reuse (`401 nonce
   * already used`) and stale expiries (`401 request expired`), so retrying
   * with the same headers after a 504 always fails. Public reads (no headers)
   * pass `() => undefined`.
   *
   * Each attempt also injects a fresh `AbortSignal.timeout(timeoutMs)` so a
   * stuck backend cannot hang the CLI indefinitely. AbortError from the
   * timeout is treated as retryable (caller's loop will see lastErr).
   */
  async #fetchWithRetry(
    url: string,
    buildInit: () => Promise<RequestInit | undefined> | RequestInit | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    let attempt = 0
    let lastErr: unknown
    let lastResponse: Response | null = null
    while (attempt <= this.#retries) {
      try {
        const init = await buildInit()
        const signal = AbortSignal.timeout(timeoutMs)
        const r = await this.#fetch(url, { ...init, signal })
        if (!RETRYABLE_STATUSES.has(r.status)) return r
        lastResponse = r
        lastErr = new Error(`${init?.method ?? 'GET'} ${url}: ${r.status} (retryable)`)
      } catch (e) {
        lastErr = e
      }
      attempt += 1
      if (attempt > this.#retries) break
      await new Promise(r => setTimeout(r, this.#retryBaseMs * attempt))
    }
    // If the final attempt was a retryable status, surface that Response to
    // the caller so they can read .text() / .status. Otherwise re-throw.
    if (lastResponse) return lastResponse
    throw lastErr
  }

  async info(): Promise<ProviderInfo> {
    return this.#getPublic('/info')
  }

  async providers(): Promise<ProviderListing[]> {
    return this.#getPublic('/api/providers')
  }

  async registryImages(): Promise<string[]> {
    return this.#getPublic('/api/registry/images')
  }

  async snapshots(): Promise<unknown[]> {
    return this.#getPublic('/api/snapshots')
  }

  async createSandbox(body: CreateSandboxBody): Promise<SandboxRecord> {
    return this.#postSigned('/api/sandbox', body, () =>
      signRequest({
        operator: this.operator,
        action: 'create',
        payload: body as Record<string, unknown>,
      }),
    )
  }

  async getSandbox(id: string): Promise<SandboxRecord> {
    return this.#getSigned(`/api/sandbox/${encodeURIComponent(id)}`, () =>
      signRequest({ operator: this.operator, action: 'list', resourceId: id }),
    )
  }

  async listSandboxes(): Promise<SandboxRecord[]> {
    return this.#getSigned('/api/sandbox', () =>
      signRequest({ operator: this.operator, action: 'list' }),
    )
  }

  async deleteSandbox(id: string): Promise<void> {
    const r = await this.#fetchWithRetry(
      `${this.endpoint}/api/sandbox/${encodeURIComponent(id)}`,
      async () => ({
        method: 'DELETE',
        headers: await signRequest({
          operator: this.operator,
          action: 'delete',
          resourceId: id,
        }),
      }),
      this.#writeTimeoutMs,
    )
    if (!r.ok) throw new Error(`deleteSandbox(${id}) failed: ${r.status} ${await safeText(r)}`)
  }

  async stopSandbox(id: string): Promise<void> {
    await this.#postSignedVoid(`/api/sandbox/${encodeURIComponent(id)}/stop`, {}, () =>
      signRequest({ operator: this.operator, action: 'stop', resourceId: id }),
    )
  }

  /**
   * Archive a sandbox. Daytona moves the container's filesystem to cold object
   * storage and frees the compute slot. Burn stops. Wake via `startSandbox`
   * (transition `archived → restoring → started`, ~2-5 min for FS restore).
   *
   * Used by `anima pause` to pause a sandbox during dev gaps. The sandbox
   * UUID + endpoint URL are preserved across pause / resume cycles.
   */
  async archiveSandbox(id: string): Promise<void> {
    await this.#postSignedVoid(`/api/sandbox/${encodeURIComponent(id)}/archive`, {}, () =>
      signRequest({ operator: this.operator, action: 'archive', resourceId: id }),
    )
  }

  async startSandbox(id: string): Promise<void> {
    await this.#postSignedVoid(`/api/sandbox/${encodeURIComponent(id)}/start`, {}, () =>
      signRequest({ operator: this.operator, action: 'start', resourceId: id }),
    )
  }

  async ensureBilling(id: string): Promise<void> {
    await this.#postSignedVoid(`/api/sandbox/${encodeURIComponent(id)}/ensure-billing`, {}, () =>
      signRequest({ operator: this.operator, action: 'ensure-billing', resourceId: id }),
    )
  }

  async sshAccess(id: string): Promise<{ sshCommand: string; token: string }> {
    return this.#postSigned<{ sshCommand: string; token: string }>(
      `/api/sandbox/${encodeURIComponent(id)}/ssh-access`,
      {},
      () => signRequest({ operator: this.operator, action: 'ssh-access', resourceId: id }),
    )
  }

  async execInToolbox(id: string, body: ToolboxExecBody): Promise<ToolboxExecResponse> {
    return this.#postSigned<ToolboxExecResponse>(
      `/api/toolbox/${encodeURIComponent(id)}/toolbox/process/execute`,
      body,
      () =>
        signRequest({
          operator: this.operator,
          action: 'toolbox',
          resourceId: id,
          payload: body as unknown as Record<string, unknown>,
        }),
    )
  }

  async #getPublic<T>(path: string): Promise<T> {
    const r = await this.#fetchWithRetry(
      `${this.endpoint}${path}`,
      () => undefined,
      this.#readTimeoutMs,
    )
    if (!r.ok) throw new Error(`GET ${path}: ${r.status}`)
    return (await r.json()) as T
  }

  async #getSigned<T>(path: string, sign: () => Promise<SignedHeaders>): Promise<T> {
    const r = await this.#fetchWithRetry(
      `${this.endpoint}${path}`,
      async () => ({ headers: await sign() }),
      this.#readTimeoutMs,
    )
    if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await safeText(r)}`)
    return (await r.json()) as T
  }

  async #postSigned<T>(
    path: string,
    body: unknown,
    sign: () => Promise<SignedHeaders>,
  ): Promise<T> {
    const r = await this.#fetchWithRetry(
      `${this.endpoint}${path}`,
      async () => ({
        method: 'POST',
        headers: { ...(await sign()), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      this.#writeTimeoutMs,
    )
    if (!r.ok) throw new Error(`POST ${path}: ${r.status} ${await safeText(r)}`)
    return (await r.json()) as T
  }

  async #postSignedVoid(
    path: string,
    body: unknown,
    sign: () => Promise<SignedHeaders>,
  ): Promise<void> {
    const r = await this.#fetchWithRetry(
      `${this.endpoint}${path}`,
      async () => ({
        method: 'POST',
        headers: { ...(await sign()), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      this.#writeTimeoutMs,
    )
    if (!r.ok) throw new Error(`POST ${path}: ${r.status} ${await safeText(r)}`)
  }
}

async function safeText(r: Response): Promise<string> {
  try {
    return await r.text()
  } catch {
    return ''
  }
}
