import {
  type AnimaNetwork,
  NETWORK_RPC,
  format0G,
  getLedgerDetailReadOnly,
  getSandboxBillingReserve,
} from '@s0nderlabs/anima-core'
import { http, type Address, createPublicClient } from 'viem'
import { findAndLoadConfig } from '../config/load'

export interface BalanceOpts {
  agent?: string
  cwd?: string
}

/**
 * Operator-facing aggregator for the agent's full economic position. Mirrors
 * `account.balance` brain tool but renders for terminals.
 *
 * Why: pre-v0.21.9, getting a full picture took `cast balance` × 2 networks +
 * `anima ledger balance` (needs unlock) + a separate cast for sandbox billing.
 * Operators kept under-counting by ~10x because the locked-in-providers split
 * wasn't surfaced anywhere.
 */
export async function runBalance(opts: BalanceOpts): Promise<void> {
  const found = await findAndLoadConfig(opts.cwd)
  if (!found) {
    console.error('No anima.config.ts found. Run `anima init` first.')
    process.exit(1)
  }
  const { config } = found
  const agentAddress = (opts.agent ?? config.identity.agent) as Address | undefined
  if (!agentAddress) {
    console.error('No agent address. Run `anima init` first or pass `--agent 0x...`.')
    process.exit(1)
  }

  const network = config.network as AnimaNetwork
  const operatorAddress = config.identity.operator as Address | undefined
  const isSandbox = config.deployTarget === 'sandbox'

  const mainnetClient = createPublicClient({ transport: http(NETWORK_RPC['0g-mainnet']) })
  const testnetClient = createPublicClient({ transport: http(NETWORK_RPC['0g-testnet']) })

  const [eoaMainnetWei, eoaTestnetWei, ledger, sandboxReserve] = await Promise.all([
    mainnetClient.getBalance({ address: agentAddress }).catch(() => 0n),
    testnetClient.getBalance({ address: agentAddress }).catch(() => 0n),
    getLedgerDetailReadOnly({ network, agentAddress }).catch(() => null),
    isSandbox && operatorAddress
      ? getSandboxBillingReserve({ recipient: operatorAddress }).catch(() => 0n)
      : Promise.resolve(null),
  ])

  console.log('')
  console.log(`agent       ${agentAddress}${config.subname ? ` (${config.subname}.anima.0g)` : ''}`)
  console.log(`network     ${network}`)
  console.log(`target      ${config.deployTarget ?? 'local'}`)
  console.log('')
  console.log('mainnet (chain 16661)')
  console.log(`  EOA balance               ${format0G(eoaMainnetWei)} 0G`)
  if (ledger) {
    console.log(`  compute ledger total      ${format0G(ledger.totalBalance)} 0G`)
    console.log(`    available               ${format0G(ledger.availableBalance)} 0G`)
    console.log(`    locked in providers     ${format0G(ledger.lockedBalance)} 0G`)
  } else {
    console.log('  compute ledger            (not opened — call `anima topup --compute N` to seed)')
  }
  console.log('')
  console.log('testnet/galileo (chain 16602)')
  console.log(`  EOA balance               ${format0G(eoaTestnetWei)} 0G`)
  if (isSandbox && operatorAddress) {
    if (sandboxReserve !== null) {
      console.log(
        `  sandbox billing reserve   ${format0G(sandboxReserve)} 0G  (operator ${operatorAddress})`,
      )
    } else {
      console.log('  sandbox billing reserve   (unavailable — RPC error)')
    }
  } else if (isSandbox) {
    console.log('  sandbox billing reserve   (operator address missing in config)')
  }

  console.log('')
  console.log('position summary')
  const mainnetTotal = eoaMainnetWei + (ledger?.totalBalance ?? 0n)
  const testnetTotal = eoaTestnetWei + (sandboxReserve ?? 0n)
  console.log(`  mainnet total             ${format0G(mainnetTotal)} 0G  (EOA + ledger)`)
  console.log(`  testnet total             ${format0G(testnetTotal)} 0G  (EOA + sandbox reserve)`)

  const warnings: string[] = []
  if (eoaMainnetWei < 2_000_000_000_000_000_000n) {
    warnings.push(
      'EOA mainnet below 2 0G notify threshold — auto-topup will fire wallet-low events',
    )
  }
  if (ledger && ledger.availableBalance < 500_000_000_000_000_000n) {
    warnings.push(
      'Compute ledger available below 0.5 0G — auto-topup may transfer from EOA into provider envelopes',
    )
  }
  if (isSandbox && sandboxReserve !== null && sandboxReserve < 1_000_000_000_000_000_000n) {
    warnings.push(
      'Sandbox billing reserve below 1 0G — top up via `anima topup --sandbox N` to extend container runtime',
    )
  }
  if (warnings.length) {
    console.log('')
    console.log('warnings')
    for (const w of warnings) console.log(`  · ${w}`)
  }
  console.log('')
}
