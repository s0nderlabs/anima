import {
  SANDBOX_BURN_RATE_OG_PER_HOUR,
  SANDBOX_DEFAULT_INITIAL_DEPOSIT_OG,
} from '@s0nderlabs/anima-core'
import { formatEther } from 'viem'

export { SANDBOX_BURN_RATE_OG_PER_HOUR, SANDBOX_DEFAULT_INITIAL_DEPOSIT_OG }

/** 0G mainnet spot price used for USD estimates. Not authoritative, just a hint. */
const OG_USD = 0.5

export type DeployTarget = 'local' | 'sandbox'

export interface CostBreakdown {
  mintAndApproveGas: bigint
  agentFloat: bigint
  computeLedgerDeposit: bigint
  storageUploadGas: bigint
  subnameAndRecords: bigint
  totalOperator: bigint
  /** Galileo testnet — present only when deployTarget === 'sandbox'. */
  sandboxInitialDepositTestnet: bigint
  /** Galileo testnet burn rate per hour, in wei. */
  sandboxBurnRatePerHourTestnet: bigint
  deployTarget: DeployTarget
}

export function estimateCosts(opts: {
  ledgerSizeOg: number
  withSubname: boolean
  deployTarget: DeployTarget
}): CostBreakdown {
  const mintAndApproveGas = 10_000_000_000_000_000n // ~0.01 0G (mint + setApprovalForAll bundle)
  const agentFloat = 100_000_000_000_000_000n // 0.1 0G — infra float for the agent
  const computeLedgerDeposit = BigInt(Math.round(opts.ledgerSizeOg * 1e18))
  const storageUploadGas = 5_000_000_000_000_000n // ~0.005 0G (storage anchor tx)
  const subnameAndRecords = opts.withSubname
    ? 30_000_000_000_000_000n // ~0.03 0G (claim + 2 text records, paid from agent float)
    : 0n
  const totalOperator = mintAndApproveGas + agentFloat + computeLedgerDeposit + storageUploadGas
  const sandboxInitialDepositTestnet =
    opts.deployTarget === 'sandbox'
      ? BigInt(Math.round(SANDBOX_DEFAULT_INITIAL_DEPOSIT_OG * 1e18))
      : 0n
  const sandboxBurnRatePerHourTestnet =
    opts.deployTarget === 'sandbox' ? BigInt(Math.round(SANDBOX_BURN_RATE_OG_PER_HOUR * 1e18)) : 0n
  return {
    mintAndApproveGas,
    agentFloat,
    computeLedgerDeposit,
    storageUploadGas,
    subnameAndRecords,
    totalOperator,
    sandboxInitialDepositTestnet,
    sandboxBurnRatePerHourTestnet,
    deployTarget: opts.deployTarget,
  }
}

export function formatUsd(valueWei: bigint): string {
  const og = Number(formatEther(valueWei))
  return `$${(og * OG_USD).toFixed(2)}`
}

function formatRunway(depositWei: bigint, burnPerHourWei: bigint): string {
  if (burnPerHourWei === 0n) return ''
  const hours = Number(depositWei) / Number(burnPerHourWei)
  if (hours < 1) return `${Math.round(hours * 60)} min runway`
  if (hours < 48) return `~${hours.toFixed(1)}h runway`
  const days = hours / 24
  return `~${days.toFixed(1)}d runway`
}

export function renderCostSummary(c: CostBreakdown): string {
  const line = (label: string, wei: bigint): string =>
    `    ${label.padEnd(32)}${formatEther(wei).padStart(8)} 0G  (${formatUsd(wei)})`
  const lines = [
    '  operator spend (0G mainnet):',
    line('mint + setApprovalForAll', c.mintAndApproveGas),
    line('storage upload (keystore)', c.storageUploadGas),
    line('agent infra float', c.agentFloat),
    line('compute ledger deposit', c.computeLedgerDeposit),
    `    ${'─'.repeat(32)}${'─'.repeat(18)}`,
    line('total operator spend', c.totalOperator),
    '',
    '  agent spend (from the float):',
    line('subname + text records', c.subnameAndRecords),
  ]
  if (c.deployTarget === 'sandbox') {
    const runway = formatRunway(c.sandboxInitialDepositTestnet, c.sandboxBurnRatePerHourTestnet)
    lines.push(
      '',
      '  sandbox spend (Galileo testnet 0G, free via faucet):',
      `    ${'initial provider deposit'.padEnd(32)}${formatEther(c.sandboxInitialDepositTestnet).padStart(8)} 0G   ($0.00)`,
      `    ${'runtime burn'.padEnd(32)}${formatEther(c.sandboxBurnRatePerHourTestnet).padStart(8)} 0G/h (${runway})`,
      '    fund via       faucet.0g.ai/?token=A0GI → paste operator address',
      '    auto-topup     agent EOA refills sandbox billing from compute ledger',
    )
  }
  return lines.join('\n')
}
