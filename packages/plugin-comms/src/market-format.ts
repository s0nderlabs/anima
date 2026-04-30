/**
 * Market protocol helpers — pure functions over JobEvent. Lives next to
 * the listener so harness consumers (TUI, web, headless) share semantics.
 */
import { type Address, formatEther } from 'viem'
import type { JobEvent } from './market-listener'

function shortAddr(a: string): string {
  if (!a || a.length < 10) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export function formatJobEvent(e: JobEvent): string {
  switch (e.kind) {
    case 'created':
      return `job#${e.jobId} created · ${shortAddr(e.buyer)} → ${shortAddr(e.provider)} · ${formatEther(e.amount)} 0G`
    case 'markedDone':
      return `job#${e.jobId} marked done`
    case 'accepted':
      return `job#${e.jobId} accepted`
    case 'disputed':
      return `job#${e.jobId} disputed`
    case 'settled':
      return `job#${e.jobId} settled · ${shortAddr(e.recipient)} +${formatEther(e.payout)} 0G · fee ${formatEther(e.fee)} 0G`
    case 'splitProposed':
      return `job#${e.jobId} split proposed by ${shortAddr(e.proposer)} · buyer ${formatEther(e.buyerAmount)} / provider ${formatEther(e.providerAmount)}`
    case 'splitResolved':
      return `job#${e.jobId} split resolved · buyer +${formatEther(e.buyerPayout)} / provider +${formatEther(e.providerPayout)} · fee ${formatEther(e.fee)}`
    case 'forceClosed':
      return `job#${e.jobId} force-closed`
    default: {
      const _exhaustive: never = e
      return `job event: ${(_exhaustive as { kind: string }).kind}`
    }
  }
}

/**
 * Channel prompt for the brain. The agent receives one of these whenever a
 * market event wakes a turn; format mirrors agent.message channel blocks so
 * the brain treats it as authenticated structured context.
 */
export function formatJobEventForBrain(e: JobEvent): string {
  switch (e.kind) {
    case 'created':
      return `<channel source="market" kind="job-offered" job_id="${e.jobId}" buyer="${e.buyer}" amount="${formatEther(e.amount)} 0G" description_hash="${e.descriptionHash}">
You were offered job #${e.jobId} by ${e.buyer} for ${formatEther(e.amount)} 0G. The full description was likely sent earlier via agent.message — check agent.history with that buyer. Decide whether to accept (do work + market.markDone) or ignore (auto-refunds buyer at 7d).
</channel>`
    case 'markedDone':
      return `<channel source="market" kind="job-marked-done" job_id="${e.jobId}">
Provider marked job #${e.jobId} done. 24h to accept (market.acceptResult) or dispute (market.dispute). Silent → auto-release to provider via claimTimeout.
</channel>`
    case 'accepted':
      // Intermediate kind; settled fires immediately after via _settle. Not
      // expected to wake the brain, but render a channel for completeness.
      return `<channel source="market" kind="job-accepted" job_id="${e.jobId}">Job #${e.jobId} accepted; settle event will follow.</channel>`
    case 'disputed':
      return `<channel source="market" kind="job-disputed" job_id="${e.jobId}">
Buyer disputed job #${e.jobId}. Funds locked. Negotiate via agent.message; both parties call market.proposeSplit with matching amounts to settle. 7d default-refund to buyer if unresolved.
</channel>`
    case 'splitProposed':
      return `<channel source="market" kind="split-proposed" job_id="${e.jobId}" proposer="${e.proposer}" buyer_amount="${formatEther(e.buyerAmount)} 0G" provider_amount="${formatEther(e.providerAmount)} 0G">
${e.proposer} proposed split on job #${e.jobId}: buyer ${formatEther(e.buyerAmount)} 0G / provider ${formatEther(e.providerAmount)} 0G. Match via market.proposeSplit with same amounts to settle.
</channel>`
    case 'settled':
      return `<channel source="market" kind="settled" job_id="${e.jobId}" recipient="${e.recipient}" payout="${formatEther(e.payout)} 0G" fee="${formatEther(e.fee)} 0G">
Job #${e.jobId} settled. You received ${formatEther(e.payout)} 0G (fee ${formatEther(e.fee)} 0G). Optional: send a brief closing agent.message to the buyer.
</channel>`
    case 'splitResolved':
      return `<channel source="market" kind="split-resolved" job_id="${e.jobId}" buyer_payout="${formatEther(e.buyerPayout)} 0G" provider_payout="${formatEther(e.providerPayout)} 0G" fee="${formatEther(e.fee)} 0G">
Dispute on job #${e.jobId} resolved. Buyer +${formatEther(e.buyerPayout)} 0G, provider +${formatEther(e.providerPayout)} 0G, fee ${formatEther(e.fee)} 0G.
</channel>`
    case 'forceClosed':
      return `<channel source="market" kind="force-closed" job_id="${e.jobId}">
Job #${e.jobId} hit MAX_JOB_LIFETIME and force-closed. Refund/settle handled per status; no further action needed.
</channel>`
    default: {
      const _exhaustive: never = e
      return `<channel source="market" kind="${(_exhaustive as { kind: string }).kind}" job_id="${(_exhaustive as { jobId: bigint }).jobId}">${formatJobEvent(_exhaustive)}</channel>`
    }
  }
}

export function isParticipant(
  agent: Address,
  e: JobEvent,
  job: { buyer: Address; provider: Address } | null,
): boolean {
  const lower = agent.toLowerCase()
  if (e.kind === 'created') {
    return e.buyer.toLowerCase() === lower || e.provider.toLowerCase() === lower
  }
  if (!job) return false
  return job.buyer.toLowerCase() === lower || job.provider.toLowerCase() === lower
}

/**
 * Identify the agent that triggered the on-chain action. Suppressing wake on
 * the actor avoids redundant turns (they already saw the tool response).
 * Returns false on events where the actor isn't carried by the event payload
 * (claimTimeout, splitResolved, forceClosed) — over-wake on those rather than
 * miss the non-actor.
 */
export function isActor(
  agent: Address,
  e: JobEvent,
  job: { buyer: Address; provider: Address } | null,
): boolean {
  const lower = agent.toLowerCase()
  switch (e.kind) {
    case 'created':
      return e.buyer.toLowerCase() === lower
    case 'markedDone':
      return job?.provider.toLowerCase() === lower
    case 'accepted':
    case 'disputed':
      return job?.buyer.toLowerCase() === lower
    case 'splitProposed':
      return e.proposer.toLowerCase() === lower
    case 'settled':
      return e.recipient.toLowerCase() !== lower
    case 'splitResolved':
    case 'forceClosed':
      return false
  }
}

/**
 * Wake-decision table. Accepted is intermediate (settled fires immediately
 * after via _settle), so suppress to avoid double turns.
 */
const WAKE_KINDS = new Set<JobEvent['kind']>([
  'created',
  'markedDone',
  'disputed',
  'splitProposed',
  'settled',
  'splitResolved',
  'forceClosed',
])

export function jobEventShouldWakeBrain(
  e: JobEvent,
  agent: Address,
  job: { buyer: Address; provider: Address } | null,
): boolean {
  if (!isParticipant(agent, e, job)) return false
  if (isActor(agent, e, job)) return false
  return WAKE_KINDS.has(e.kind)
}

/** True if `kind` indicates the job's escrow has terminated. */
export function isJobTerminalKind(kind: JobEvent['kind']): boolean {
  return kind === 'settled' || kind === 'splitResolved' || kind === 'forceClosed'
}
