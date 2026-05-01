import {
  type AnimaNetwork,
  type AnimaPlugin,
  NETWORK_CHAIN_ID,
  type OperatorSigner,
  SANDBOX_PROVIDER_GALILEO,
  SANDBOX_PROVIDER_URL_GALILEO,
  SANDBOX_TEE_SIGNER_GALILEO,
  SandboxProviderClient,
  SandboxSettlementClient,
  SannClient,
  agentPaths,
  buildSandboxEndpoint,
  encryptToPubkey,
  fetchAndDecryptKeystore,
  iNFTAgentId,
  subnameNode,
} from '@s0nderlabs/anima-core'
import { buildBootstrapScript } from '@s0nderlabs/anima-harness'
import { type Address, type Hex, hexToBytes, parseEther } from 'viem'
import { SandboxClient } from '../../sandbox/client'
import { withSilencedConsole } from '../../util/silence-console'

export interface SandboxProvisionOpts {
  /** OperatorSigner. Used for both Galileo settlement txs AND provision sig. */
  operator: OperatorSigner
  /** Decrypted agent privkey (already saved to keystore + uploaded to 0G Storage). */
  agentPrivkey: Hex
  /** Agent EOA derived from privkey. Used in iNFTRef + RuntimeConfig.identity.agent. */
  agentAddress: Address
  /** iNFT identity for the harness's RuntimeConfig. */
  iNFTRef: { contract: Address; tokenId: bigint }
  /** Brain provider + model picked during init. */
  brain: { provider: Address; model: string }
  /** Plugins to load in the harness. Defaults to all 3 first-party. */
  plugins?: AnimaPlugin[]
  /** Optional system-prompt append. */
  promptAppend?: string
  /** Network the iNFT lives on (mainnet for hybrid path 1). */
  iNFTNetwork: AnimaNetwork
  /** Sandbox name (sent to provider; surfaces in dashboards). */
  name: string
  /** Git tag the bootstrap script clones (e.g. 'v0.15.0'). */
  ref: string
  /** Override repo URL (defaults to canonical anima repo). */
  repoUrl?: string
  /** Override snapshot. Default `daytonaio/sandbox:0.5.0-slim`. */
  snapshotName?: string
  /** Initial deposit to provider contract (testnet 0G). Default 1.0 0G. */
  depositOg?: number
  /** Optional progress callback for spinner UX. */
  onProgress?: (msg: string) => void
}

export interface SandboxProvisionResult {
  sandboxId: string
  endpoint: string
  providerAddress: Address
  snapshotName: string
  agentAddress: Address
  bootstrapPubkey: Hex
  depositTx?: Hex
  acknowledgeTx?: Hex
}

/**
 * Orchestrate the full sandbox-deploy handoff. Used by `anima init --target
 * sandbox`, `anima deploy`, and `anima upgrade`.
 *
 * Steps:
 *   1. Galileo testnet: deposit + acknowledge TEE signer (skip if already done)
 *   2. provider.createSandbox + wait for state=started
 *   3. provider.execInToolbox(bootstrap-script): apt-get install + bun + git
 *      clone + bun install + nohup harness daemon
 *   4. Poll harness /bootstrap/pubkey via nip.io URL
 *   5. ECIES-encrypt agentPrivkey to bootstrap pubkey + EIP-191-sign envelope
 *   6. POST /bootstrap/provision (operator EIP-191 sig over the request hash)
 *   7. Poll /healthz until state=Ready + runtimeReady=true
 *   8. Return sandboxId + endpoint URL for caller to write into config + subname.
 */
export async function runSandboxProvision(
  opts: SandboxProvisionOpts,
): Promise<SandboxProvisionResult> {
  const progress = opts.onProgress ?? (() => {})
  const snapshotName = opts.snapshotName ?? 'daytonaio/sandbox:0.5.0-slim'
  const repoUrl = opts.repoUrl ?? 'https://github.com/s0nderlabs/anima.git'
  const depositWei = parseEther(String(opts.depositOg ?? 1))

  const operatorAddress = await opts.operator.address()
  const operatorAccount = await opts.operator.account()
  const galileoPublic = await opts.operator.publicClient('0g-testnet')
  const galileoWallet = await opts.operator.walletClient('0g-testnet')

  if (galileoPublic.chain && galileoPublic.chain.id !== NETWORK_CHAIN_ID['0g-testnet']) {
    throw new Error('operator publicClient bound to wrong chain — expected Galileo testnet')
  }

  const settlement = new SandboxSettlementClient({
    publicClient: galileoPublic,
    walletClient: galileoWallet,
  })

  // Reads (deposit balance + TEE ack state) are independent; run in parallel.
  progress('checking provider deposit balance + TEE acknowledgement')
  const [balanceBefore, ackd] = await Promise.all([
    settlement.getBalance(operatorAddress, SANDBOX_PROVIDER_GALILEO),
    settlement.isTEEAcknowledged(operatorAddress, SANDBOX_PROVIDER_GALILEO),
  ])
  let depositTx: Hex | undefined
  if (balanceBefore < depositWei) {
    const need = depositWei - balanceBefore
    progress(`depositing ${formatOg(need)} 0G to provider`)
    depositTx = await settlement.deposit({
      recipient: operatorAddress,
      provider: SANDBOX_PROVIDER_GALILEO,
      amountWei: need,
    })
    await galileoPublic.waitForTransactionReceipt({ hash: depositTx })
  }
  let acknowledgeTx: Hex | undefined
  if (!ackd) {
    progress(`acknowledging TEE signer ${SANDBOX_TEE_SIGNER_GALILEO}`)
    acknowledgeTx = await settlement.acknowledgeTEESigner({
      provider: SANDBOX_PROVIDER_GALILEO,
      acknowledged: true,
    })
    await galileoPublic.waitForTransactionReceipt({ hash: acknowledgeTx })
  }

  // Step 2: createSandbox
  const provider = new SandboxProviderClient({
    endpoint: SANDBOX_PROVIDER_URL_GALILEO,
    operator: operatorAccount,
  })

  progress(`creating sandbox snapshot=${snapshotName}`)
  const created = await provider.createSandbox({ snapshot: snapshotName, name: opts.name })
  if (!created.id) throw new Error('createSandbox returned no id')
  const sandboxId = created.id

  // Wait for sandbox state=started (~10-30s typical, 120s ceiling).
  progress(`waiting for sandbox ${sandboxId} to start`)
  const startDeadline = Date.now() + 120_000
  let lastState = created.state
  let started = false
  while (Date.now() < startDeadline) {
    const sb = await provider.getSandbox(sandboxId).catch(() => null)
    if (sb?.state) lastState = sb.state
    if (sb?.state === 'started') {
      started = true
      break
    }
    await sleep(2000)
  }
  if (!started) {
    throw new Error(
      `sandbox ${sandboxId} did not reach state=started within 120s (last=${lastState})`,
    )
  }

  // Step 3: bootstrap script
  const { script } = buildBootstrapScript({
    sandboxId,
    operatorAddress,
    ref: opts.ref,
    repoUrl,
  })
  progress('running bootstrap script (apt + bun + git clone + harness launch)')
  const bootRes = await provider.execInToolbox(sandboxId, { command: script, timeout: 600 })
  if (bootRes.exitCode !== 0) {
    throw new Error(
      `bootstrap exec failed: exitCode=${bootRes.exitCode} stderr=${bootRes.stderr.slice(0, 400)}`,
    )
  }

  // Step 4: poll /bootstrap/pubkey
  const endpoint = buildSandboxEndpoint({ sandboxId })
  const sandboxClient = new SandboxClient({
    endpoint,
    sandboxId,
    operator: operatorAccount,
  })
  progress(`polling ${endpoint}/bootstrap/pubkey`)
  const pubkeyRes = await pollPubkey(sandboxClient, 60_000)

  // Step 5: build envelope
  const agentPrivkeyBytes = hexToBytes(opts.agentPrivkey)
  const envelope = encryptToPubkey({
    recipientPubkey: pubkeyRes.pubkeyHex,
    plaintext: agentPrivkeyBytes,
  })

  // Step 6: provision
  progress('sending provision envelope to harness')
  const runtimeConfig = {
    network: opts.iNFTNetwork,
    brain: opts.brain,
    identity: {
      iNFT: {
        contract: opts.iNFTRef.contract,
        tokenId: opts.iNFTRef.tokenId.toString(),
      },
      agent: opts.agentAddress,
    },
    plugins: opts.plugins ?? ['system', 'comms', 'onchain'],
    permissions: 'off' as const,
    promptAppend: opts.promptAppend,
  }
  await sandboxClient.provision(
    {
      envelope,
      iNFTRef: { contract: opts.iNFTRef.contract, tokenId: opts.iNFTRef.tokenId.toString() },
      config: runtimeConfig,
    },
    pubkeyRes.pubkeyHex,
  )

  // Step 7: wait until runtime ready
  progress(`polling ${endpoint}/healthz for Ready`)
  await sandboxClient.waitReady({ timeoutMs: 180_000 })

  return {
    sandboxId,
    endpoint,
    providerAddress: SANDBOX_PROVIDER_GALILEO,
    snapshotName,
    agentAddress: opts.agentAddress,
    bootstrapPubkey: pubkeyRes.pubkeyHex,
    depositTx,
    acknowledgeTx,
  }
}

async function pollPubkey(
  client: SandboxClient,
  timeoutMs: number,
): Promise<Awaited<ReturnType<SandboxClient['pubkey']>>> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await client.pubkey()
    } catch {
      await sleep(2000)
    }
  }
  throw new Error(`/bootstrap/pubkey did not respond within ${timeoutMs}ms`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function formatOg(wei: bigint): string {
  const og = Number(wei) / 1e18
  return og.toFixed(4)
}

/**
 * Decrypt the agent keystore via the operator wallet. Used by both
 * `anima deploy` (Local→Sandbox migration) and `anima upgrade` (re-handoff
 * to a new container). The keystore lives encrypted on 0G Storage; the
 * operator's signature derives the AEAD key (Phase 6.6).
 */
export async function unlockAgentKeystore(params: {
  operator: OperatorSigner
  network: AnimaNetwork
  contractAddress: Address
  tokenId: bigint
  agentAddress: Address
}): Promise<Hex> {
  const agentId = iNFTAgentId({
    contractAddress: params.contractAddress,
    tokenId: params.tokenId,
  })
  const paths = agentPaths.agent(agentId)
  const decrypted = await withSilencedConsole(() =>
    fetchAndDecryptKeystore({
      network: params.network,
      contractAddress: params.contractAddress,
      tokenId: params.tokenId,
      signer: params.operator,
      agentAddress: params.agentAddress,
      cachePath: paths.keystore,
    }),
  )
  return decrypted.privkeyHex
}

/**
 * Publish or update the `agent:endpoint` text record on the agent's
 * `<subname>.anima.0g`. Idempotent: writes the latest endpoint URL each
 * call. Best-effort — caller decides whether to surface the failure.
 */
export async function publishSandboxEndpoint(params: {
  subname: string
  agentPrivkey: Hex
  endpoint: string
}): Promise<Hex> {
  return withSilencedConsole(async () => {
    const sann = new SannClient({ privkeyHex: params.agentPrivkey })
    const tx = await sann.setText(subnameNode(params.subname), 'agent:endpoint', params.endpoint)
    await sann.waitForReceipt(tx)
    return tx
  })
}
