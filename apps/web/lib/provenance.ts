/**
 * Provenance ledger entries , what actually happened in the substrate
 * (TEE, sandbox, storage, chain) for each cycle. The right-side hero
 * canvas renders these as commentary on the left-side chat.
 *
 * The narration is the headline: a plain-English sentence a non-crypto
 * reader can grasp in 2 seconds. The proof is small mono evidence
 * underneath. Hashes are stylized to look like real 0G mainnet tx /
 * signers / storage roots.
 */

export type StampKind =
  | 'wallet'
  | 'attestation'
  | 'sandbox'
  | 'storage'
  | 'chain'
  | 'inbox'
  | 'market'

/**
 * Tool-specific animated glyph kind. Each one renders a small SVG icon
 * inside the station node , the icon ANIMATES on station activation
 * (the line draws itself, the lock shackle closes, etc.) so the moment
 * of the substrate firing is visible.
 */
export type GlyphKind =
  | 'sign'
  | 'brain'
  | 'browser'
  | 'lock'
  | 'anchor'
  | 'swap'
  | 'stake'
  | 'message'
  | 'gavel'

export type Receipt = {
  id: string
  /** Tool-specific animated glyph for the station node. */
  glyph: GlyphKind
  /** Legacy big-stamp kind , kept for cycles that haven't been migrated. */
  stamp?: StampKind
  /** Title-cased display label rendered in the right-side panel. */
  layer: 'You' | 'Brain' | 'Limbs' | 'Memory' | 'Chain' | 'Comms' | 'Commerce'
  /** Plain-English sentence that EXPLAINS what just happened. */
  narration: string
  /** Optional explorer link , when set, renders a "verify on chain ↗" link below the narration. */
  proofHref?: string
  delayMs: number
}

export type Provenance = {
  /** One-line frame for the whole right panel for this cycle. */
  intro: string
  outcome: string
  receipts: Receipt[]
}

// Real 0G mainnet contract addresses. Each `proofHref` points at the
// chainscan /address/ page for the contract that actually settles the
// station's action , clicking it shows real on-chain activity (recent
// txs, balance, code), not a stylized fake hash.
const CHAINSCAN_ADDR = 'https://chainscan.0g.ai/address/'
const ANIMA_AGENT_NFT = '0x9e71d79f06f956d4d2666b5c93dafab721c84721'
const ANIMA_INBOX = '0xcd92844cc0ec6Be0607B330D4BaCC707339f2589'
const ANIMA_MARKET = '0x3ebD21f5dd67acDeF199fACF28388627212bA2aB'
const JAINE_SWAP_ROUTER = '0x8B598A7C136215A95ba0282b4d832B9f9801f2e2'
const GIMO_POOL = '0xac06d1df23a4fa00981afac0f33a5936bd2135af'

const INTRO = 'every step above leaves a trail on 0G'

// ─── per-cycle provenance ──────────────────────────────────────────────
//
// All cycles follow a 5-station voyage synced to the left-side chat:
//   1. You      , wallet signs the intent
//   2. Brain    , TEE reasons + signs the plan
//   3. [action] , the cycle's headline beat (sandbox / chain / comms+commerce)
//   4. Memory   , receipt encrypted to 0G Storage
//   5. Chain    , storage root sealed into iNFT (omitted for cycle 3, where
//                 the gavel beat IS the chain finale)
//
// `delayMs` for each station is hand-tuned to fire just after the matching
// left-side moment lands. See TuiCanvas.tsx + TgCanvas.tsx for the left-side
// timing constants. `cycle.durationMs` in lib/cycles.ts is derived as
// `last_station_delayMs + ~3000ms outcome hold`.

export const PROVENANCE: Record<string, Provenance> = {
  // ─── Cycle 1 , TUI · research ────────────────────────────────────────
  // TuiCanvas: commit at 2800, tools start at 2800 stagger 700ms each, last
  // tool (memory.save, idx 5) at 6300, reply at 7600.
  research: {
    intro: INTRO,
    outcome: 'Note saved to /user/learnings/0g-chain',
    receipts: [
      {
        id: 'r-sign',
        glyph: 'sign',
        stamp: 'wallet',
        layer: 'You',
        narration: 'Your wallet signed the prompt before it left your laptop.',
        delayMs: 2700, // just after `you · …` row commits
      },
      {
        id: 'r-attest',
        glyph: 'brain',
        stamp: 'attestation',
        layer: 'Brain',
        narration:
          'Reasoning ran inside a TEE. Every completion is signed by the enclave, not the host.',
        delayMs: 3100, // as "thinking…" appears
      },
      {
        id: 'r-sandbox',
        glyph: 'browser',
        stamp: 'sandbox',
        layer: 'Limbs',
        narration:
          "Browser and web tools ran inside a sandbox enclave so code can't touch the host.",
        delayMs: 3500, // first tool block visible
      },
      {
        id: 'r-storage',
        glyph: 'lock',
        stamp: 'storage',
        layer: 'Memory',
        narration: 'The note was encrypted with a wallet-derived key and written to 0G Storage.',
        delayMs: 6700, // memory.save tool block lands
      },
      {
        id: 'r-chain',
        glyph: 'anchor',
        stamp: 'chain',
        layer: 'Chain',
        narration:
          "The storage root was sealed into the agent's iNFT, so the proof survives operator handoff.",
        proofHref: CHAINSCAN_ADDR + ANIMA_AGENT_NFT,
        delayMs: 9000, // ~1.4s after reply lands
      },
    ],
  },

  // ─── Cycle 2 , TG · swap ─────────────────────────────────────────────
  // TgCanvas: greeting 200/800/1500, main user at 2400, think at 3000,
  // tools at 3800 stagger 380ms each. chain.tx (idx 3) lands at 4940.
  // memory.save (idx 4) at 5320. Reply at 6320.
  swap: {
    intro: INTRO,
    outcome: '5 0G → 4.93 USDC.e settled · receipt saved to /user/swaps',
    receipts: [
      {
        id: 's-sign',
        glyph: 'sign',
        stamp: 'wallet',
        layer: 'You',
        narration: 'Your wallet signed the swap intent before it left your laptop.',
        delayMs: 2500, // main user prompt commits
      },
      {
        id: 's-attest',
        glyph: 'brain',
        stamp: 'attestation',
        layer: 'Brain',
        narration: 'A TEE picked the route (0G → W0G → USDC.e via JAINE) and signed the plan.',
        delayMs: 3100, // think bubble visible
      },
      {
        id: 's-chain-swap',
        glyph: 'swap',
        stamp: 'chain',
        layer: 'Chain',
        narration:
          'The swap settled as a real on-chain transaction through the JAINE liquidity pool.',
        proofHref: CHAINSCAN_ADDR + JAINE_SWAP_ROUTER,
        delayMs: 5000, // chain.tx tool ✓ confirms
      },
      {
        id: 's-storage',
        glyph: 'lock',
        stamp: 'storage',
        layer: 'Memory',
        narration: 'The receipt was encrypted with a wallet-derived key and filed for tax records.',
        delayMs: 6000, // memory.save tool ✓ confirms
      },
      {
        id: 's-anchor',
        glyph: 'anchor',
        stamp: 'chain',
        layer: 'Chain',
        narration:
          "The storage root was sealed into the agent's iNFT, so the receipt survives operator handoff.",
        proofHref: CHAINSCAN_ADDR + ANIMA_AGENT_NFT,
        delayMs: 7500, // ~1.2s after reply lands
      },
    ],
  },

  // ─── Cycle 3 , TUI · commerce ────────────────────────────────────────
  // TuiCanvas: commit at 2800, tools at 2800 stagger 700ms.
  // agent.message (idx 2) at 4200. market.acceptResult (idx 4) at 5600.
  // memory.save (idx 5) at 6300. Reply at 7600. No anchor station: the
  // gavel IS the chain finale here (escrow released on chain).
  commerce: {
    intro: INTRO,
    outcome: 'auditor.anima.0g hired · log saved to /user/audits',
    receipts: [
      {
        id: 'c-sign',
        glyph: 'sign',
        stamp: 'wallet',
        layer: 'You',
        narration: 'Your wallet signed the hire intent before it left your laptop.',
        delayMs: 2900, // just after commit
      },
      {
        id: 'c-attest',
        glyph: 'brain',
        stamp: 'attestation',
        layer: 'Brain',
        narration: 'A TEE picked auditor.anima.0g from the market and drafted the bid.',
        delayMs: 3300, // just before tools
      },
      {
        id: 'c-inbox',
        glyph: 'message',
        stamp: 'inbox',
        layer: 'Comms',
        narration:
          'The bid traveled through AnimaInbox as an ECIES envelope. Only the auditor could open it.',
        proofHref: CHAINSCAN_ADDR + ANIMA_INBOX,
        delayMs: 4400, // agent.message tool ✓
      },
      {
        id: 'c-market',
        glyph: 'gavel',
        stamp: 'market',
        layer: 'Commerce',
        narration:
          'AnimaMarket released the escrow on chain the moment the audit report was accepted.',
        proofHref: CHAINSCAN_ADDR + ANIMA_MARKET,
        delayMs: 5800, // market.acceptResult tool ✓
      },
      {
        id: 'c-storage',
        glyph: 'lock',
        stamp: 'storage',
        layer: 'Memory',
        narration: "The audit log was encrypted and filed under the agent's history on 0G Storage.",
        delayMs: 6700, // memory.save tool ✓
      },
    ],
  },

  // ─── Cycle 4 , TG · stake ────────────────────────────────────────────
  // TgCanvas: greeting 200/800/1500, main user at 2400, think at 3000,
  // tools at 3800 stagger 380ms. chain.tx (idx 2) at 4560. memory.save
  // (idx 3) at 4940. Reply at 5940.
  stake: {
    intro: INTRO,
    outcome: '10 0G locked at 9.4% APR · position saved to /user/positions',
    receipts: [
      {
        id: 'st-sign',
        glyph: 'sign',
        stamp: 'wallet',
        layer: 'You',
        narration: 'Your wallet signed the stake intent before it left your laptop.',
        delayMs: 2500, // main user prompt commits
      },
      {
        id: 'st-attest',
        glyph: 'brain',
        stamp: 'attestation',
        layer: 'Brain',
        narration:
          'A TEE chose 0g-validator-1 against your existing positions and signed the plan.',
        delayMs: 3100, // think bubble visible
      },
      {
        id: 'st-chain-stake',
        glyph: 'stake',
        stamp: 'chain',
        layer: 'Chain',
        narration:
          'Stake locked on the validator network. The 14-day unlock is enforced by the validator contract.',
        proofHref: CHAINSCAN_ADDR + GIMO_POOL,
        delayMs: 4500, // chain.tx tool ✓
      },
      {
        id: 'st-storage',
        glyph: 'lock',
        stamp: 'storage',
        layer: 'Memory',
        narration: "Position recorded against the agent's portfolio on 0G Storage.",
        delayMs: 5500, // memory.save tool ✓
      },
      {
        id: 'st-anchor',
        glyph: 'anchor',
        stamp: 'chain',
        layer: 'Chain',
        narration:
          "The storage root was sealed into the agent's iNFT, so the portfolio survives operator handoff.",
        proofHref: CHAINSCAN_ADDR + ANIMA_AGENT_NFT,
        delayMs: 7000, // ~1.1s after reply lands
      },
    ],
  },
}
