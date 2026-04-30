import type { ToolDef } from '@s0nderlabs/anima-core'
import { type Address, formatEther, keccak256, parseEther, toHex } from 'viem'
import { z } from 'zod'
import type { ContactStore } from './contacts'
import { type AnimaMarketClient, JOB_STATUS, JOB_STATUS_LABEL, type Job } from './market'
import type { PubkeyResolver } from './pubkey-resolver'
import { resolveAddrOrName } from './tools'

export interface MarketDeps {
  market: AnimaMarketClient
  resolver: PubkeyResolver
  contacts: ContactStore
  agentEoa: Address
}

function jobView(jobId: bigint, j: Job, agentEoa: Address) {
  const role =
    j.buyer.toLowerCase() === agentEoa.toLowerCase()
      ? 'buyer'
      : j.provider.toLowerCase() === agentEoa.toLowerCase()
        ? 'provider'
        : 'observer'
  const counterparty = role === 'buyer' ? j.provider : role === 'provider' ? j.buyer : null
  return {
    jobId: jobId.toString(),
    role,
    counterparty,
    amount0g: formatEther(j.amount),
    status: JOB_STATUS_LABEL[j.status],
    createdAt: Number(j.createdAt),
    doneAt: Number(j.doneAt),
    descriptionHash: j.descriptionHash,
  }
}

// ─── 1. market.createJob ────────────────────────────────────────────────────

const CreateJobSchema = z.object({
  provider: z
    .string()
    .min(1)
    .describe('Counterparty doing the work: an .anima.0g name, raw 0x address, or contact label.'),
  amount: z
    .string()
    .min(1)
    .describe('Escrow amount in 0G (e.g. "0.05" or "1.5"). Minimum 0.001 0G.'),
  description: z
    .string()
    .min(1)
    .max(2000)
    .describe('Plain-text description of the job. Hashed on-chain; full text stays off-chain.'),
})
type CreateJobArgs = z.infer<typeof CreateJobSchema>

export function makeMarketCreateJob(deps: MarketDeps): ToolDef<CreateJobArgs> {
  return {
    name: 'market.createJob',
    description:
      'Create + fund a fixed-price escrow job for another anima. Atomic: one tx funds the job, locks 0G in AnimaMarket, emits JobCreated. Provider does the work, calls market.markDone, then you call market.acceptResult or market.dispute. 5% protocol fee at settle. 24h acceptance window after markDone, 7-day max lifetime.',
    searchHint: 'hire pay escrow contract gig task work',
    schema: CreateJobSchema,
    handler: async args => {
      try {
        const r = await resolveAddrOrName(deps, args.provider)
        if (!r) {
          return {
            ok: false,
            error: `unrecognized provider: ${args.provider}. Use a .anima.0g name, 0x address, or contact label.`,
          }
        }
        if (r.addr.toLowerCase() === deps.agentEoa.toLowerCase()) {
          return { ok: false, error: 'self-trade not allowed' }
        }
        let amountWei: bigint
        try {
          amountWei = parseEther(args.amount)
        } catch {
          return { ok: false, error: `invalid amount: ${args.amount}` }
        }
        const descriptionHash = keccak256(toHex(args.description))
        const txHash = await deps.market.createJob(r.addr, amountWei, descriptionHash)
        return {
          ok: true,
          data: {
            txHash,
            provider: r.name ?? r.addr,
            amount0g: args.amount,
            descriptionHash,
            note: 'Job created. Wait for provider to call market.markDone, then accept or dispute.',
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// ─── 2. market.markDone ─────────────────────────────────────────────────────

const JobIdSchema = z.object({
  jobId: z.string().describe('Numeric job id (e.g. "0", "12"). Listed via market.listMyJobs.'),
})
type JobIdArgs = z.infer<typeof JobIdSchema>

function parseJobId(raw: string): bigint | null {
  try {
    if (!/^\d+$/.test(raw)) return null
    return BigInt(raw)
  } catch {
    return null
  }
}

export function makeMarketMarkDone(deps: MarketDeps): ToolDef<JobIdArgs> {
  return {
    name: 'market.markDone',
    description:
      'Provider signals work is complete on a job. Starts the 24h acceptance window. Only the provider on the job can call this. After 24h of buyer silence, anyone can call market.claimTimeout to release funds.',
    searchHint: 'mark done complete finish provider deliver',
    schema: JobIdSchema,
    handler: async args => {
      const jobId = parseJobId(args.jobId)
      if (jobId === null) return { ok: false, error: `invalid jobId: ${args.jobId}` }
      try {
        const txHash = await deps.market.markDone(jobId)
        return { ok: true, data: { txHash, jobId: args.jobId } }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// ─── 3. market.acceptResult ─────────────────────────────────────────────────

export function makeMarketAcceptResult(deps: MarketDeps): ToolDef<JobIdArgs> {
  return {
    name: 'market.acceptResult',
    description:
      'Buyer accepts the result on a Done job. Releases payout to provider (95%) + protocol fee (5%). Only the buyer can call this. Must be in Done status.',
    searchHint: 'accept release pay provider settle',
    schema: JobIdSchema,
    handler: async args => {
      const jobId = parseJobId(args.jobId)
      if (jobId === null) return { ok: false, error: `invalid jobId: ${args.jobId}` }
      try {
        const txHash = await deps.market.acceptResult(jobId)
        return { ok: true, data: { txHash, jobId: args.jobId } }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// ─── 4. market.dispute ──────────────────────────────────────────────────────

export function makeMarketDispute(deps: MarketDeps): ToolDef<JobIdArgs> {
  return {
    name: 'market.dispute',
    description:
      'Buyer disputes a Done job within the 24h acceptance window. Funds lock until both parties co-sign a split (market.proposeSplit) or the 7d max lifetime triggers a buyer refund (market.forceClose). Only the buyer can call this.',
    searchHint: 'dispute reject contest unhappy escalate',
    schema: JobIdSchema,
    handler: async args => {
      const jobId = parseJobId(args.jobId)
      if (jobId === null) return { ok: false, error: `invalid jobId: ${args.jobId}` }
      try {
        const txHash = await deps.market.dispute(jobId)
        return { ok: true, data: { txHash, jobId: args.jobId } }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// ─── 5. market.claimTimeout ─────────────────────────────────────────────────

export function makeMarketClaimTimeout(deps: MarketDeps): ToolDef<JobIdArgs> {
  return {
    name: 'market.claimTimeout',
    description:
      'After 24h of buyer silence on a Done job, anyone can call this to release funds to the provider (95%) + fee (5%). Permissionless settlement trigger. Provider can call this themselves to ensure payout if buyer is unresponsive.',
    searchHint: 'timeout claim release settle 24h auto',
    schema: JobIdSchema,
    handler: async args => {
      const jobId = parseJobId(args.jobId)
      if (jobId === null) return { ok: false, error: `invalid jobId: ${args.jobId}` }
      try {
        const txHash = await deps.market.claimTimeout(jobId)
        return { ok: true, data: { txHash, jobId: args.jobId } }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// ─── 6. market.forceClose ───────────────────────────────────────────────────

export function makeMarketForceClose(deps: MarketDeps): ToolDef<JobIdArgs> {
  return {
    name: 'market.forceClose',
    description:
      'After 7 days from job creation, anyone can force-close. Funded jobs (provider never engaged) refund the buyer fully, no fee. Done jobs (buyer never finalized) settle to provider per claimTimeout semantics. Disputed jobs default to buyer refund (no fee). Safety valve when neither party engages.',
    searchHint: 'force close abandon expire 7 day',
    schema: JobIdSchema,
    handler: async args => {
      const jobId = parseJobId(args.jobId)
      if (jobId === null) return { ok: false, error: `invalid jobId: ${args.jobId}` }
      try {
        const txHash = await deps.market.forceClose(jobId)
        return { ok: true, data: { txHash, jobId: args.jobId } }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// ─── 7. market.proposeSplit ─────────────────────────────────────────────────

const ProposeSplitSchema = z.object({
  jobId: z.string().describe('Numeric job id, must be in Disputed status.'),
  buyerAmount: z
    .string()
    .describe(
      'Amount in 0G the buyer should receive in this split. Sum with providerAmount must equal job amount.',
    ),
  providerAmount: z.string().describe('Amount in 0G the provider should receive in this split.'),
})
type ProposeSplitArgs = z.infer<typeof ProposeSplitSchema>

export function makeMarketProposeSplit(deps: MarketDeps): ToolDef<ProposeSplitArgs> {
  return {
    name: 'market.proposeSplit',
    description:
      'Either disputing party proposes a payout split. When the OTHER party also calls proposeSplit with the SAME (buyerAmount, providerAmount), the contract settles automatically: 5% fee taken, remainder split pro-rata. Last write per party wins; either can re-propose by calling again.',
    searchHint: 'split propose settle dispute negotiate compromise',
    schema: ProposeSplitSchema,
    handler: async args => {
      const jobId = parseJobId(args.jobId)
      if (jobId === null) return { ok: false, error: `invalid jobId: ${args.jobId}` }
      try {
        const buyerAmount = parseEther(args.buyerAmount)
        const providerAmount = parseEther(args.providerAmount)
        const txHash = await deps.market.proposeSplit(jobId, buyerAmount, providerAmount)
        return {
          ok: true,
          data: {
            txHash,
            jobId: args.jobId,
            note: 'Proposal posted. The other party must call proposeSplit with the same amounts to settle.',
          },
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// ─── 8. market.getJob ───────────────────────────────────────────────────────

export function makeMarketGetJob(deps: MarketDeps): ToolDef<JobIdArgs> {
  return {
    name: 'market.getJob',
    description:
      'Read-only inspector for a job. Returns buyer, provider, amount in 0G, status (funded/done/disputed/settled), createdAt, doneAt timestamps, and the descriptionHash.',
    searchHint: 'get job inspect view read details',
    schema: JobIdSchema,
    handler: async args => {
      const jobId = parseJobId(args.jobId)
      if (jobId === null) return { ok: false, error: `invalid jobId: ${args.jobId}` }
      try {
        const j = await deps.market.getJob(jobId)
        return { ok: true, data: jobView(jobId, j, deps.agentEoa) }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}

// ─── 9. market.listMyJobs ───────────────────────────────────────────────────

const ListJobsSchema = z.object({
  role: z.enum(['all', 'buyer', 'provider']).optional().describe('Filter by role. Default: all.'),
  status: z
    .enum(['all', 'active', 'settled', 'funded', 'done', 'disputed'])
    .optional()
    .describe(
      'Filter by status. "active" = funded|done|disputed (anything not settled). Default: all.',
    ),
  limit: z.number().int().min(1).max(50).optional().describe('Max jobs to return. Default: 10.'),
})
type ListJobsArgs = z.infer<typeof ListJobsSchema>

export function makeMarketListMyJobs(deps: MarketDeps): ToolDef<ListJobsArgs> {
  return {
    name: 'market.listMyJobs',
    description:
      "List jobs where the agent is buyer or provider. Filter by role and status. Returns most-recent-first up to the limit. Useful for 'what jobs am I currently working on' or 'show me my completed jobs'.",
    searchHint: 'list my jobs active recent escrow status',
    schema: ListJobsSchema,
    handler: async args => {
      const role = args.role ?? 'all'
      const status = args.status ?? 'all'
      const limit = args.limit ?? 10
      try {
        const total = await deps.market.jobCount()
        if (total === 0n) return { ok: true, data: { jobs: [], total: 0 } }

        const wantStatus = (s: number): boolean => {
          if (status === 'all') return true
          if (status === 'active') return s !== JOB_STATUS.Settled
          if (status === 'funded') return s === JOB_STATUS.Funded
          if (status === 'done') return s === JOB_STATUS.Done
          if (status === 'disputed') return s === JOB_STATUS.Disputed
          if (status === 'settled') return s === JOB_STATUS.Settled
          return false
        }

        // Walk newest → oldest until limit
        const out: ReturnType<typeof jobView>[] = []
        const lower = deps.agentEoa.toLowerCase()
        for (let i = total - 1n; i >= 0n; i--) {
          const j = await deps.market.getJob(i)
          const isBuyer = j.buyer.toLowerCase() === lower
          const isProvider = j.provider.toLowerCase() === lower
          if (!isBuyer && !isProvider) {
            if (i === 0n) break
            continue
          }
          if (role === 'buyer' && !isBuyer) {
            if (i === 0n) break
            continue
          }
          if (role === 'provider' && !isProvider) {
            if (i === 0n) break
            continue
          }
          if (!wantStatus(j.status)) {
            if (i === 0n) break
            continue
          }
          out.push(jobView(i, j, deps.agentEoa))
          if (out.length >= limit) break
          if (i === 0n) break
        }
        return { ok: true, data: { jobs: out, totalChecked: Number(total) } }
      } catch (e) {
        return { ok: false, error: (e as Error).message.slice(0, 240) }
      }
    },
  }
}
