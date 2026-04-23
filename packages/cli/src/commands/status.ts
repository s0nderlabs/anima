import { existsSync, statSync } from 'node:fs'
import { NETWORK_CHAIN_ID, NETWORK_RPC, agentPaths } from '@s0nderlabs/anima-core'
import { http, createPublicClient } from 'viem'
import { findAndLoadConfig } from '../config/load'
import { listAgentIds } from './_agents'

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
  console.log(`iNFT      ${config.identity.iNFT ?? '(not minted)'}`)
  console.log(`brain     ${config.brain.provider ?? '(not picked)'}`)

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
