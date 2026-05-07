/**
 * Always-on guidance contributed to the frozen prefix when plugin-onchain is
 * loaded. Pattern mirrors `plugin-comms/src/market-guidance.ts:MARKETPLACE_GUIDANCE`.
 */

export const ONCHAIN_GUIDANCE = `On-chain wallet + chain ops:

- Your agent EOA pays gas; the operator funds it. There are no on-chain spending caps — the operator's deposit IS the loss ceiling. Approval modal gates value-moving tools (\`chain.send\`, \`swap.execute\`, \`stake.*\`, \`chain.write\` w/ value) in \`prompt\` mode; in \`yolo\` they fire silently.
- Balance + identity: \`chain.balance\` with no args returns native + every ERC-20 the agent has ever held (Transfer-event discovery, no curated list). Pass \`token\` for a single asset or \`address\` to inspect another wallet. \`account.info\` bundles wallet + iNFT + brain provider + recent activity AND the agent's own \`.anima.0g\` subname, A2A pubkey, and the canonical anima singleton addresses (inbox/market/agentNFT). Call it before answering identity / "who are you" / "what's your pubkey" questions instead of guessing.
- Full balance position: \`account.balance\` returns the FULL economic picture — EOA mainnet + EOA testnet + compute ledger total/available/locked + sandbox billing reserve (when sandbox-deployed). Use this for "what's my balance", "how much do we have", "show full position", "total funds" questions. EOA-only answers under-count by up to 10x because compute envelopes (locked in 0G provider sub-accounts) are usually larger than the EOA itself. \`chain.balance\` is for token-level detail; \`account.balance\` is for top-line aggregation.
- Anima singletons (CREATE2-deterministic, same address on testnet and mainnet, introspect via \`chain.contract\`):
  - \`AnimaInbox\` at \`0xcd92844cc0ec6Be0607B330D4BaCC707339f2589\`: singleton A2A encrypted message emitter (ECIES, ERC-7857 inbox, Phase 7).
  - \`AnimaMarket\` at \`0x3ebD21f5dd67acDeF199fACF28388627212bA2aB\`: ERC-8183 native-0G fixed-price escrow marketplace (Phase 8).
  - \`AnimaAgentNFT\` at \`0x9e71d79f06f956d4d2666b5c93dafab721c84721\`: ERC-7857 iNFT identity registry (Phase 4).
  When the user asks for "metadata for X contract" / "tell me about AnimaInbox" / "what does AnimaMarket do", call \`chain.contract\` on the address above (NOT \`shell.run\` to grep the codebase, NOT \`memory.read\`).
- Tokens: \`tokens.info\` resolves a symbol or address to {address, decimals, symbol}. JAINE pool list is bundled; unknown tokens fall back to on-chain reads (cached after).
- Transfers: \`chain.send\` auto-detects native vs ERC-20 by token symbol. \`chain.wrap\`/\`chain.unwrap\` move between native 0G and W0G.
- Trading: \`swap.quote\` previews; \`swap.execute\` commits. Routes only via JAINE; tokens with no JAINE pool can't swap (chain.balance shows them, swap can't trade them). Slippage default 0.5%. ERC-20 input swaps auto-approve the router on first use.
- Staking: \`stake.stake\` mints stOG (Gimo, 0G's dominant LST). Min 0.01 0G. Unstaking is a queued withdrawal: \`stake.unstake\` → wait ~72h → \`stake.claim\`. For instant exit, use \`swap.execute\` to convert stOG→0G via JAINE.
- Analysis: \`chain.tx\` decodes any tx hash. \`chain.contract\` introspects code/proxy/ERC standards. \`chain.activity\` shows recent transfers.
- Generic: \`chain.read\`/\`chain.write\` for any contract not covered above; takes \`signature\` + \`args\` like cast.
- Blockchain: \`chain.block\` for current head/timestamp/gasUsed. \`chain.gas\` for current gas price.
`
