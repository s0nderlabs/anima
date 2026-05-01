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

export interface ToolboxExecResponse {
  exitCode: number
  stdout: string
  stderr: string
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
export class SandboxProviderClient {
  endpoint: string
  operator: LocalAccount
  #fetch: typeof fetch

  constructor(opts: SandboxProviderClientOpts) {
    this.endpoint = opts.endpoint.replace(/\/$/, '')
    this.operator = opts.operator
    this.#fetch = opts.fetchImpl ?? globalThis.fetch
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
    const headers = await signRequest({
      operator: this.operator,
      action: 'create',
      payload: body as Record<string, unknown>,
    })
    return this.#post('/api/sandbox', body, headers)
  }

  async getSandbox(id: string): Promise<SandboxRecord> {
    const headers = await signRequest({
      operator: this.operator,
      action: 'list',
      resourceId: id,
    })
    return this.#getAuth(`/api/sandbox/${encodeURIComponent(id)}`, headers)
  }

  async listSandboxes(): Promise<SandboxRecord[]> {
    const headers = await signRequest({ operator: this.operator, action: 'list' })
    return this.#getAuth('/api/sandbox', headers)
  }

  async deleteSandbox(id: string): Promise<void> {
    const headers = await signRequest({
      operator: this.operator,
      action: 'delete',
      resourceId: id,
    })
    const r = await this.#fetch(`${this.endpoint}/api/sandbox/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers,
    })
    if (!r.ok) throw new Error(`deleteSandbox(${id}) failed: ${r.status} ${await safeText(r)}`)
  }

  async stopSandbox(id: string): Promise<void> {
    const headers = await signRequest({
      operator: this.operator,
      action: 'stop',
      resourceId: id,
    })
    await this.#postRaw(`/api/sandbox/${encodeURIComponent(id)}/stop`, {}, headers)
  }

  async startSandbox(id: string): Promise<void> {
    const headers = await signRequest({
      operator: this.operator,
      action: 'start',
      resourceId: id,
    })
    await this.#postRaw(`/api/sandbox/${encodeURIComponent(id)}/start`, {}, headers)
  }

  async ensureBilling(id: string): Promise<void> {
    const headers = await signRequest({
      operator: this.operator,
      action: 'ensure-billing',
      resourceId: id,
    })
    await this.#postRaw(`/api/sandbox/${encodeURIComponent(id)}/ensure-billing`, {}, headers)
  }

  async sshAccess(id: string): Promise<{ sshCommand: string; token: string }> {
    const headers = await signRequest({
      operator: this.operator,
      action: 'ssh-access',
      resourceId: id,
    })
    return this.#post<{ sshCommand: string; token: string }>(
      `/api/sandbox/${encodeURIComponent(id)}/ssh-access`,
      {},
      headers,
    )
  }

  /**
   * Run a command inside the sandbox via the toolbox proxy. Returns when the
   * command exits or the timeout is reached.
   */
  async execInToolbox(id: string, body: ToolboxExecBody): Promise<ToolboxExecResponse> {
    const headers = await signRequest({
      operator: this.operator,
      action: 'toolbox',
      resourceId: id,
      payload: body as unknown as Record<string, unknown>,
    })
    return this.#post<ToolboxExecResponse>(
      `/api/toolbox/${encodeURIComponent(id)}/toolbox/process/execute`,
      body,
      headers,
    )
  }

  async #getPublic<T>(path: string): Promise<T> {
    const r = await this.#fetch(`${this.endpoint}${path}`)
    if (!r.ok) throw new Error(`GET ${path}: ${r.status}`)
    return (await r.json()) as T
  }

  async #getAuth<T>(path: string, headers: SignedHeaders): Promise<T> {
    const r = await this.#fetch(`${this.endpoint}${path}`, { headers })
    if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await safeText(r)}`)
    return (await r.json()) as T
  }

  async #post<T>(path: string, body: unknown, headers: SignedHeaders): Promise<T> {
    const r = await this.#fetch(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) throw new Error(`POST ${path}: ${r.status} ${await safeText(r)}`)
    return (await r.json()) as T
  }

  async #postRaw(path: string, body: unknown, headers: SignedHeaders): Promise<void> {
    const r = await this.#fetch(`${this.endpoint}${path}`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
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
