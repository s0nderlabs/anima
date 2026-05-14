/**
 * 4 hero cycles. Each cycle has:
 * - surface: TUI vs TG (drives chat aesthetic)
 * - prompt: the natural-language operator prompt
 * - tool stream: ordered list of tool calls + their result indicators
 * - reply: bot's final reply
 * - artifact: the output canvas card type
 * - painting: which Aurelia wash for the canvas backdrop
 * - greeting (TG only): optional warmup turn before the main exchange
 */

export type CycleSurface = 'tui' | 'tg'
export type ToolStreamEntry = { tool: string; args?: string; status: 'ok' | 'failed' }

export type ResearchCard = {
  type: 'research'
  title: string
  sources: Array<{ name: string; url: string; preview: string }>
}
export type SwapCard = {
  type: 'swap'
  fromAmount: string
  fromSymbol: string
  toAmount: string
  toSymbol: string
  txHash: string
  newBalance: string
}
export type AuditCard = {
  type: 'audit'
  jobId: string
  agent: string
  bidAmount: string
  status: string
  reportHash: string
  txHash: string
}
export type StakeCard = {
  type: 'stake'
  position: string
  validator: string
  apr: string
  unlockBlock: number
  txHash: string
}

export type CycleArtifact = ResearchCard | SwapCard | AuditCard | StakeCard

export type CycleGreeting = { prompt: string; reply: string }

export type Cycle = {
  id: string
  surface: CycleSurface
  greeting?: CycleGreeting
  prompt: string
  toolStream: ToolStreamEntry[]
  reply: string
  artifact: CycleArtifact
  painting: 'grove' | 'cloud-islands' | 'mountain-vista' | 'tower'
  durationMs: number
}

export const CYCLES: Cycle[] = [
  // ─── Cycle 1 , TUI · deep research on 0G chain ───────────────────────
  {
    id: 'research',
    surface: 'tui',
    prompt:
      "do a deep research on the 0G chain: stack, tokenomics, ecosystem, current state of mainnet",
    toolStream: [
      { tool: 'browser.navigate', args: '0g.ai', status: 'ok' },
      { tool: 'browser.snapshot', status: 'ok' },
      { tool: 'web.fetch', args: 'docs.0g.ai/concepts', status: 'ok' },
      { tool: 'browser.navigate', args: 'chainscan.0g.ai', status: 'ok' },
      { tool: 'session.search', args: '0g token validators', status: 'ok' },
      { tool: 'memory.save', args: '/user/learnings/0g-chain', status: 'ok' },
    ],
    reply: `0G is a modular AI-first L1 with a 4-layer stack:

**0G Chain** , EVM-compatible L1. Mainnet (chain 16661, evmrpc.0g.ai), Galileo testnet (chain 16602). ~89 active validators, $24M TVL on mainnet today.

**0G Storage** , DA + KV + blob layers. $11/TB/month. Indexer: indexer-storage-turbo.0g.ai.

**0G Compute** , TeeML inference w/ attestation receipts. Multiple open-weight models in the catalog (GLM-5, DeepSeek v3, Qwen3.6, gpt-oss-120b), routed natively via @0glabs/0g-serving-broker v0.7.5+.

**0G Sandbox** , TDX TEE app deployment for hosting agentic harnesses. Galileo-only today (mainnet pending).

**Token**: $0G , 1B supply, native gas + delegation. Validator APR ~9.4% (28d avg).

**Notable**: ERC-7857 iNFT spec for AI agent identity, ERC-8183 for agentic marketplaces. 0G APAC Hackathon active w/ $150K prize pool.

Saved to /user/learnings/0g-chain. 7 sources cited.`,
    artifact: {
      type: 'research',
      title: '0G Chain · field report',
      sources: [
        { name: '0g.ai', url: 'https://0g.ai', preview: 'modular AI L1 · 4-layer stack' },
        { name: 'docs.0g.ai', url: 'https://docs.0g.ai', preview: 'concepts + RPC reference' },
        { name: 'chainscan.0g.ai', url: 'https://chainscan.0g.ai', preview: 'mainnet 16661 · 89 validators' },
        { name: '@0G_labs', url: 'https://x.com/0G_labs', preview: 'GLM-5 + TeeML rollout' },
        { name: '0g-serving-broker', url: 'https://github.com/0gfoundation/0g-serving-broker', preview: 'compute SDK v0.7.5+' },
        { name: 'EIP-7857', url: 'https://eips.ethereum.org/EIPS/eip-7857', preview: 'iNFT identity spec' },
        { name: 'EIP-8183', url: 'https://eips.ethereum.org/EIPS/eip-8183', preview: 'agentic marketplace' },
      ],
    },
    painting: 'grove',
    durationMs: 12000,
  },

  // ─── Cycle 2 , TG · greeting + swap ──────────────────────────────────
  {
    id: 'swap',
    surface: 'tg',
    greeting: {
      prompt: 'gm',
      reply: 'gm ☀️',
    },
    prompt: 'swap 5 0G for USDC.e on JAINE',
    toolStream: [
      { tool: 'chain.balance', args: '0G', status: 'ok' },
      { tool: 'swap.quote', args: '5 0G → USDC.e', status: 'ok' },
      { tool: 'swap.execute', args: 'route: 0G/W0G/USDC.e', status: 'ok' },
      { tool: 'chain.tx', args: '0xa12c…1129', status: 'ok' },
      { tool: 'memory.save', args: '/user/swaps/2026-05-09', status: 'ok' },
    ],
    reply: `Swap settled.

**5.000 0G → 4.93 USDC.e** received.
Route: 0G → W0G → USDC.e via JAINE pool 0x71f3…
Slippage 0.42% · Fees 0.025 0G

Pre-swap balance: 12.563 USDC.e
Post-swap: **17.493 USDC.e**

Tx: chainscan.0g.ai/0xa12c…1129
Saved to /user/swaps/2026-05-09 for tax records.`,
    artifact: {
      type: 'swap',
      fromAmount: '5.000',
      fromSymbol: '0G',
      toAmount: '4.93',
      toSymbol: 'USDC.e',
      txHash: '0xa12c7e9118db44dd8a2e34c10f4bc11129',
      newBalance: '17.493 USDC.e',
    },
    painting: 'cloud-islands',
    // last provenance station fires at 7500ms (s-anchor) + ~3000ms outcome hold
    durationMs: 10500,
  },

  // ─── Cycle 3 , TUI · hire auditor ─────────────────────────────────────
  {
    id: 'commerce',
    surface: 'tui',
    prompt:
      'find an agent to audit this solidity contract and hire them: 0xa1b2c3d4e5f6789012345678901234567890abcd',
    toolStream: [
      { tool: 'market.list', args: 'skill: solidity-audit', status: 'ok' },
      { tool: 'agent.history', args: 'auditor.anima.0g', status: 'ok' },
      { tool: 'agent.message', args: 'auditor.anima.0g', status: 'ok' },
      { tool: 'market.createJob', args: '5 0G escrow', status: 'ok' },
      { tool: 'market.acceptResult', args: 'job 0x3eb…772a', status: 'ok' },
      { tool: 'memory.save', args: '/user/audits/2026-05-09', status: 'ok' },
    ],
    reply: `Hired **auditor.anima.0g** via ERC-8183.

**Their reputation**: 4.7/5 · 12 settled jobs · solidity expert
**Quote**: 5 0G (within budget)
**Turnaround**: 4.5 hours

Audit complete. Findings:
- 1 medium · reentrancy in withdraw()
- 2 low · unchecked transfer return values
- 14 gas optimization spots flagged

Full report on 0G Storage: 0xb7ce…8f0
Settled on chain: chainscan.0g.ai/0x3ebd…772a

Saved to /user/audits/2026-05-09.`,
    artifact: {
      type: 'audit',
      jobId: '0x3ebd9f5cc2118c3ad33c3d50918e2772a',
      agent: 'auditor.anima.0g',
      bidAmount: '5 0G',
      status: 'settled',
      reportHash: '0xb7ce1142e43d17a92c94a8f0',
      txHash: '0x3ebd9f5cc2118c3ad33c3d50918e2772a',
    },
    painting: 'mountain-vista',
    // last provenance station fires at 6700ms (c-storage) + ~3000ms outcome hold
    durationMs: 10500,
  },

  // ─── Cycle 4 , TG · greeting + stake ─────────────────────────────────
  {
    id: 'stake',
    surface: 'tg',
    greeting: {
      prompt: 'hi there',
      reply: 'hi 👋 ready when you are',
    },
    prompt: 'stake 10 0G with the validator network',
    toolStream: [
      { tool: 'stake.position', args: 'current', status: 'ok' },
      { tool: 'stake.delegate', args: '10 0G → 0g-validator-1', status: 'ok' },
      { tool: 'chain.tx', args: '0x771a…c8e0', status: 'ok' },
      { tool: 'memory.save', args: '/user/positions', status: 'ok' },
    ],
    reply: `Stake locked.

**10.000 0G** delegated to **0g-validator-1**
APR: 9.4% (28d avg)
Unlock block: 4,381,201 (~14 days)
Earning: **0.026 0G/day** ≈ 0.78 0G/month

Your portfolio:
- 0g-validator-1: 10.000 0G (just now)
- 0g-validator-3: 4.500 0G (since Apr 18)
- **Total staked: 14.500 0G**

Cumulative rewards earned: 0.247 0G
Tx: chainscan.0g.ai/0x771a…c8e0`,
    artifact: {
      type: 'stake',
      position: '10.000 0G',
      validator: '0g-validator-1',
      apr: '9.4%',
      unlockBlock: 4_381_201,
      txHash: '0x771a8e44c0d3294411fefc7b87c8e0',
    },
    painting: 'tower',
    // last provenance station fires at 7000ms (st-anchor) + ~3000ms outcome hold
    durationMs: 10000,
  },
]
