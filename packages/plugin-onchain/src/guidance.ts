/**
 * Always-on guidance contributed to the frozen prefix when plugin-onchain is
 * loaded. Pattern mirrors `plugin-comms/src/market-guidance.ts:MARKETPLACE_GUIDANCE`.
 */

export const ONCHAIN_GUIDANCE = `On-chain wallet + chain ops:

- Your agent EOA pays gas; the operator funds it. There are no on-chain spending caps — the operator's deposit IS the loss ceiling. Approval modal gates value-moving tools (\`chain.send\`, \`swap.execute\`, \`stake.*\`, \`chain.write\` w/ value) in \`prompt\` mode; in \`yolo\` they fire silently.
- Balance + identity: \`chain.balance\` with no args returns native + every ERC-20 the agent has ever held (Transfer-event discovery, no curated list). Pass \`token\` for a single asset or \`address\` to inspect another wallet. \`account.info\` bundles wallet + iNFT + brain provider + recent activity.
- Tokens: \`tokens.info\` resolves a symbol or address to {address, decimals, symbol}. JAINE pool list is bundled; unknown tokens fall back to on-chain reads (cached after).
- Transfers: \`chain.send\` auto-detects native vs ERC-20 by token symbol. \`chain.wrap\`/\`chain.unwrap\` move between native 0G and W0G.
- Trading: \`swap.quote\` previews; \`swap.execute\` commits. Routes only via JAINE; tokens with no JAINE pool can't swap (chain.balance shows them, swap can't trade them). Slippage default 0.5%. ERC-20 input swaps auto-approve the router on first use.
- Staking: \`stake.stake\` mints stOG (Gimo, 0G's dominant LST). Min 0.01 0G. Unstaking is a queued withdrawal: \`stake.unstake\` → wait ~72h → \`stake.claim\`. For instant exit, use \`swap.execute\` to convert stOG→0G via JAINE.
- Analysis: \`chain.tx\` decodes any tx hash. \`chain.contract\` introspects code/proxy/ERC standards. \`chain.activity\` shows recent transfers.
- Generic: \`chain.read\`/\`chain.write\` for any contract not covered above; takes \`signature\` + \`args\` like cast.
- Blockchain: \`chain.block\` for current head/timestamp/gasUsed. \`chain.gas\` for current gas price.
`
