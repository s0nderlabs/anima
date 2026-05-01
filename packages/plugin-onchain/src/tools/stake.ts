/**
 * Gimo staking limbs: stake.stake / stake.unstake / stake.claim / stake.position.
 *
 * Unstake is QUEUED, not instant. After ~72h the agent calls stake.claim
 * (or `chain.write` on pool.withdraw()) to receive the native 0G. For
 * instant exit the brain should use `swap.execute` to convert stOG→0G via
 * JAINE.
 */

import type { ToolDef } from '@s0nderlabs/anima-core'
import { type Address, formatEther, formatUnits, parseEther } from 'viem'
import { z } from 'zod'
import { ensureAllowance } from '../allowance'
import { GIMO_BY_NETWORK, GIMO_COOLDOWN_SECS, MIN_STAKE_WEI, requireMainnet } from '../constants'
import {
  CooldownNotElapsedError,
  StakeBelowMinError,
  claimWithdrawal,
  estimateCooldownEta,
  findLatestUnstake,
  getStogBalance,
  getStogRate,
  stakeNative,
  unstakeStog,
} from '../gimo'
import type { OnchainRuntimeContext } from '../types'

const StakeSchema = z.object({
  amount: z.string().describe('Native 0G to stake (e.g. "0.05"). Min 0.01 0G.'),
})
type StakeArgs = z.infer<typeof StakeSchema>

export function makeStakeStake(ctx: OnchainRuntimeContext): ToolDef<StakeArgs> {
  return {
    name: 'stake.stake',
    description:
      'Stake native 0G into Gimo, mint stOG. Min 0.01 0G. stOG accrues value vs 0G via Gimo.getRate(). Use chain.balance to see your stOG holdings.',
    searchHint: 'stake gimo lst stog mint earn yield',
    schema: StakeSchema,
    handler: async args => {
      try {
        requireMainnet(ctx.network)
        const amountWei = parseEther(args.amount)
        const result = await stakeNative({
          publicClient: ctx.publicClient,
          walletClient: ctx.walletClient,
          network: ctx.network,
          amountWei,
        })
        const rate = await getStogRate({ publicClient: ctx.publicClient, network: ctx.network })
        return {
          ok: true,
          data: {
            txHash: result.txHash,
            blockNumber: result.blockNumber,
            gasUsed: result.gasUsed.toString(),
            staked0G: args.amount,
            stogMinted: formatEther(result.stogMinted),
            rate0gPerStog: formatEther(rate),
          },
        }
      } catch (e) {
        if (e instanceof StakeBelowMinError) {
          return {
            ok: false,
            error: `Gimo minimum stake is ${formatEther(MIN_STAKE_WEI)} 0G; got ${args.amount}`,
          }
        }
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

const UnstakeSchema = z.object({
  amountStog: z
    .string()
    .describe('stOG amount to unstake (e.g. "0.05"), or "all" for full balance.'),
})
type UnstakeArgs = z.infer<typeof UnstakeSchema>

export function makeStakeUnstake(ctx: OnchainRuntimeContext): ToolDef<UnstakeArgs> {
  return {
    name: 'stake.unstake',
    description:
      'Queue a stOG → 0G withdrawal in Gimo. NOT instant: cooldown ~72h, then call stake.claim. For instant exit use swap.execute. Auto-approves stOG to the pool on first use.',
    searchHint: 'unstake gimo stog withdraw queue',
    schema: UnstakeSchema,
    handler: async args => {
      try {
        requireMainnet(ctx.network)
        const pool = GIMO_BY_NETWORK[ctx.network]!.pool as Address
        const stog = GIMO_BY_NETWORK[ctx.network]!.stog as Address
        let amountWei: bigint
        if (args.amountStog === 'all') {
          amountWei = await getStogBalance({
            publicClient: ctx.publicClient,
            network: ctx.network,
            address: ctx.agentEoa,
          })
          if (amountWei === 0n) {
            return { ok: false, error: 'no stOG balance to unstake' }
          }
        } else {
          amountWei = parseEther(args.amountStog)
        }
        const allow = await ensureAllowance({
          publicClient: ctx.publicClient,
          walletClient: ctx.walletClient,
          token: stog,
          owner: ctx.agentEoa,
          spender: pool,
          amount: amountWei,
        })
        const result = await unstakeStog({
          publicClient: ctx.publicClient,
          walletClient: ctx.walletClient,
          network: ctx.network,
          amountStog: amountWei,
        })
        return {
          ok: true,
          data: {
            ...(allow.txHash ? { approveTxHash: allow.txHash } : {}),
            txHash: result.txHash,
            blockNumber: result.blockNumber,
            gasUsed: result.gasUsed.toString(),
            unstakedStog: formatEther(amountWei),
            queuedAt: result.queuedAt,
            estimatedClaimAt: result.estimatedClaimAt,
            cooldownSecs: Number(GIMO_COOLDOWN_SECS),
            note: 'Queued. Call stake.claim after ~72h to withdraw native 0G.',
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

const ClaimSchema = z.object({})
type ClaimArgs = z.infer<typeof ClaimSchema>

export function makeStakeClaim(ctx: OnchainRuntimeContext): ToolDef<ClaimArgs> {
  return {
    name: 'stake.claim',
    description:
      'Claim queued Gimo unstake to native 0G. Reverts with cooldown ETA if not yet elapsed.',
    searchHint: 'claim withdraw gimo cooldown queued',
    schema: ClaimSchema,
    handler: async () => {
      try {
        requireMainnet(ctx.network)
        const result = await claimWithdrawal({
          publicClient: ctx.publicClient,
          walletClient: ctx.walletClient,
          network: ctx.network,
        })
        const native = await ctx.publicClient.getBalance({ address: ctx.agentEoa })
        return {
          ok: true,
          data: {
            txHash: result.txHash,
            blockNumber: result.blockNumber,
            gasUsed: result.gasUsed.toString(),
            nativeBalance: formatEther(native),
          },
        }
      } catch (e) {
        if (e instanceof CooldownNotElapsedError) {
          return {
            ok: false,
            error: `cooldown not elapsed; ~${Math.round(e.etaSeconds / 3600)}h remaining`,
            data: { etaSeconds: e.etaSeconds, claimable: false },
          }
        }
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

const PositionSchema = z.object({})
type PositionArgs = z.infer<typeof PositionSchema>

export function makeStakePosition(ctx: OnchainRuntimeContext): ToolDef<PositionArgs> {
  return {
    name: 'stake.position',
    description:
      'Snapshot of your Gimo stake: stOG balance, native equivalent at current rate, queued withdrawal (if any) with claim ETA.',
    searchHint: 'stake position stog balance queued cooldown rate',
    schema: PositionSchema,
    handler: async () => {
      try {
        requireMainnet(ctx.network)
        const [stogBal, rate, latestUnstake, eta] = await Promise.all([
          getStogBalance({
            publicClient: ctx.publicClient,
            network: ctx.network,
            address: ctx.agentEoa,
          }),
          getStogRate({ publicClient: ctx.publicClient, network: ctx.network }),
          findLatestUnstake({
            publicClient: ctx.publicClient,
            network: ctx.network,
            agentEoa: ctx.agentEoa,
            mintBlock: ctx.mintBlock,
          }),
          estimateCooldownEta({
            publicClient: ctx.publicClient,
            network: ctx.network,
            agentEoa: ctx.agentEoa,
          }),
        ])
        const native0gValue = (stogBal * rate) / 10n ** 18n
        const queued =
          latestUnstake !== null
            ? {
                txHash: latestUnstake.txHash,
                amountStog: formatUnits(latestUnstake.amountStog, 18),
                amount0g: formatUnits(latestUnstake.amount0g, 18),
                queuedAt: latestUnstake.queuedAt,
                etaSeconds: eta,
                claimable: eta === 0,
                claimEtaHours: Math.round(eta / 3600),
              }
            : null
        return {
          ok: true,
          data: {
            stogBalance: formatEther(stogBal),
            native0gValue: formatEther(native0gValue),
            rate0gPerStog: formatEther(rate),
            queued,
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
