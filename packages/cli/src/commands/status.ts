import { existsSync, statSync } from 'node:fs'
import {
  NETWORK_CHAIN_ID,
  NETWORK_RPC,
  SANDBOX_PROVIDER_URL_GALILEO,
  SandboxProviderClient,
  agentPaths,
} from '@s0nderlabs/anima-core'
import { http, createPublicClient } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { SandboxClient } from '../sandbox/client'
import { listAgentIds } from './_agents'
import { loadOrPickOperatorSigner } from './init/operator-picker'

export async function runStatus(opts?: { cwd?: string }): Promise<void> {
  const cwd = opts?.cwd ?? process.cwd()
  const found = await findAndLoadConfig(cwd)
  if (!found) {
    console.log('No anima.config.ts found. Run `anima init` first.')
    process.exit(1)
  }
  const { config, path } = found
  console.log(`config    ${path}`)
  console.log(`network   ${config.network} (chain ${NETWORK_CHAIN_ID[config.network]})`)
  console.log(`rpc       ${NETWORK_RPC[config.network]}`)
  console.log(`plugins   ${config.plugins.join(', ')}`)
  console.log(`target    ${config.deployTarget ?? 'local'}`)
  if (config.identity.iNFT) {
    const { contract, tokenId, network } = config.identity.iNFT
    console.log(`iNFT      #${tokenId} at ${contract} (${network})`)
  } else {
    console.log('iNFT      (not minted)')
  }
  if (config.identity.operator) console.log(`operator  ${config.identity.operator}`)
  if (config.identity.agent) console.log(`agent EOA ${config.identity.agent}`)
  console.log(`brain     ${config.brain.provider ?? '(not picked)'}`)

  // Phase 11 sandbox-mode status: fetch /healthz + provider record + show
  // sandbox-side state instead of per-agent local dirs (those don't exist
  // on the laptop in sandbox mode).
  if (config.deployTarget === 'sandbox' && config.sandbox?.endpoint && config.sandbox.id) {
    console.log('')
    console.log(`sandbox   ${config.sandbox.id}`)
    console.log(`endpoint  ${config.sandbox.endpoint}`)
    console.log(`snapshot  ${config.sandbox.snapshotName ?? '(default)'}`)

    const operator = await loadOrPickOperatorSigner({
      network: config.network,
      hint: config.operator,
    }).catch(() => null)
    if (!operator) {
      console.log('harness   skipped (no operator wallet to sign /healthz auth)')
      return
    }
    const operatorAccount = await operator.account()

    const probe = new SandboxClient({
      endpoint: config.sandbox.endpoint,
      sandboxId: config.sandbox.id,
      operator: operatorAccount,
    })
    const providerClient = new SandboxProviderClient({
      endpoint: SANDBOX_PROVIDER_URL_GALILEO,
      operator: operatorAccount,
    })

    // Both reads are independent network calls; run in parallel.
    const [healthRes, sandboxRes] = await Promise.allSettled([
      probe.health(),
      providerClient.getSandbox(config.sandbox.id),
    ])
    if (healthRes.status === 'fulfilled') {
      const h = healthRes.value
      console.log(`harness   state=${h.state} runtimeReady=${h.runtimeReady}`)
      console.log(`uptime    ${(h.uptimeMs / 1000 / 60).toFixed(1)} min`)
      console.log(`pending   ${h.pendingApprovals} approvals`)
      console.log(`subs      ${h.subscribers}`)
      console.log(`events    seq ${h.eventsLastSeq}`)
    } else {
      console.log(
        `harness   UNREACHABLE: ${healthRes.reason.message?.slice(0, 120) ?? healthRes.reason}`,
      )
    }
    if (sandboxRes.status === 'fulfilled') {
      const sb = sandboxRes.value
      console.log(
        `provider  state=${sb.state}${sb.cpu ? ` cpu=${sb.cpu}` : ''}${sb.mem ? ` mem=${sb.mem}` : ''}${sb.disk ? ` disk=${sb.disk}` : ''}`,
      )
    } else {
      console.log(
        `provider  UNREACHABLE: ${sandboxRes.reason.message?.slice(0, 120) ?? sandboxRes.reason}`,
      )
    }
    await operator.close?.()
    return
  }

  const ids = await listAgentIds()
  if (ids.length === 0) {
    console.log('\nNo agents found in ~/.anima/agents. Re-run `anima init`.')
    return
  }

  const client = createPublicClient({
    transport: http(NETWORK_RPC[config.network]),
  })

  for (const id of ids) {
    console.log('')
    console.log(`agent     ${id}`)
    console.log(`dir       ${agentPaths.agent(id).dir}`)
    const activityPath = agentPaths.agent(id).activityLog
    if (existsSync(activityPath)) {
      const sz = statSync(activityPath).size
      console.log(`activity  ${sz} bytes`)
    }
    void client
  }
}
