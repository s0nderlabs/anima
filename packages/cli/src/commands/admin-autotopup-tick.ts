import { existsSync } from 'node:fs'
import { agentPaths, iNFTAgentId, placeholderAgentId } from '@s0nderlabs/anima-core'
import { type Address, getAddress } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { SandboxClient } from '../sandbox/client'
import { loadOrPickOperatorSigner } from './init/operator-picker'

export async function runAdminAutotopupTick(): Promise<void> {
  const found = await findAndLoadConfig()
  if (!found) {
    console.error('No anima.config.ts found. Run `anima init` first.')
    process.exit(1)
  }
  const { config } = found

  if (config.deployTarget === 'sandbox' && config.sandbox?.endpoint && config.sandbox.id) {
    const signer = await loadOrPickOperatorSigner({
      network: config.network,
      hint: config.operator,
    })
    if (!signer) {
      console.error('failed to load operator signer (cancelled or no key)')
      process.exit(1)
    }
    const operatorAccount = await signer.account()
    const client = new SandboxClient({
      endpoint: config.sandbox.endpoint,
      sandboxId: config.sandbox.id,
      operator: operatorAccount,
    })
    try {
      const result = await client.triggerAutoTopupTick()
      console.log(JSON.stringify(result, null, 2))
      if (!result.ok) process.exitCode = 1
    } catch (e) {
      console.error(`autotopup-tick failed: ${(e as Error).message.slice(0, 240)}`)
      process.exit(1)
    }
    return
  }

  if (!config.identity.agent) {
    console.error('No agent address in config. Run `anima init` first.')
    process.exit(1)
  }
  // Slug derivation must match gateway-stop.ts (iNFT-based when minted, else
  // address-placeholder); the daemon writes its sock under the same dir.
  const slug = config.identity.iNFT
    ? iNFTAgentId({
        contractAddress: getAddress(config.identity.iNFT.contract as Address),
        tokenId: BigInt(config.identity.iNFT.tokenId),
      })
    : placeholderAgentId(config.identity.agent)
  const sockPath = `${agentPaths.agent(slug).dir}/gateway.sock`
  if (!existsSync(sockPath)) {
    console.error(
      `Gateway socket not found at ${sockPath}. Start the gateway with \`anima gateway start\` or run \`anima\` first.`,
    )
    process.exit(1)
  }
  const r = await fetch('http://localhost/admin/autotopup/tick', {
    method: 'POST',
    unix: sockPath,
  } as RequestInit & { unix: string })
  if (!r.ok) {
    const detail = await r.text().catch(() => '')
    console.error(`autotopup-tick failed (${r.status}): ${detail}`)
    process.exit(1)
  }
  const body = (await r.json()) as { ok: boolean; reason?: string }
  console.log(JSON.stringify(body, null, 2))
  if (!body.ok) process.exitCode = 1
}
