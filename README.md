# anima

First fully on-chain sovereign agent runtime on 0G.

## What it is

Anima is a CLI-hosted agent runtime where the agent's identity, memory, reasoning, and economic life all live on 0G's decentralized infrastructure. Operator runs `anima init` once. After that, the agent persists on chain: close the laptop, walk away, the agent survives. Any operator machine can re-attach via the iNFT.

## Architecture

Six-layer stack, each layer anchored to a 0G primitive:

| Layer | Lives on | How |
|-------|----------|-----|
| Identity | 0G Chain | ERC-7857 iNFT |
| Memory | 0G Storage | KV for mutable state, blob for immutable |
| Brain | 0G Compute (TeeML) | OpenAI-compat inference, any live model |
| Harness | 0G Sandbox (TDX) | Attested orchestration layer |
| Limbs | User machines | Filesystem + shell access via paired daemon |
| Wallet | Hybrid | Runtime hot copy + iNFT-metadata cold copy |

## Packages

```
packages/
├── core                       @s0nderlabs/anima-core            always-on infra
├── cli                        @s0nderlabs/anima-cli             TUI binary
├── plugin-onchain             @s0nderlabs/anima-plugin-onchain  wallet + chain ops
├── plugin-comms               @s0nderlabs/anima-plugin-comms    A2A + marketplace
└── plugin-system              @s0nderlabs/anima-plugin-system   fs + shell + web
```

## Contracts

`contracts/` holds the Foundry project.

| Contract | Network | Address |
|----------|---------|---------|
| `AnimaAgentNFT` (ERC-7857) | 0G Galileo testnet (16602) | `0xf132201d895f9a5d8b8dc4af2f7f8f9fc45935b1` |
| `AnimaAgentNFT` | 0G mainnet (16661) | `0x1a60a42c1f8620638c2eac56deb2a4dfa08ab232` |

Parent domain `anima.0g` is registered on SPACE ID on mainnet; `anima init` issues `<label>.anima.0g` subnames for new agents.

## `anima init`

Runs the first-time onboarding wizard:
1. Pick network (testnet default for dev).
2. Pick a subname (optional).
3. Set keystore passphrase.
4. Generates a fresh agent EOA.
5. If the agent EOA holds gas, mints an ERC-7857 iNFT with 6 canonical `IntelligentData` slots (`memory-index`, `identity`, `persona`, `profile`, `keystore`, `activity-log`).
6. If subname + iNFT are both present, reclaims `<subname>.anima.0g` on mainnet, sets the resolver, and writes `address` + `agent:inft` text records.
7. Writes `anima.config.ts` with the full identity reference.

A fresh agent with zero gas is a no-op for the on-chain steps — CLI prints a "fund me at 0x..., re-run" note and skips mint + subname gracefully.

## Dev

```bash
# TypeScript workspace
bun install
bun run lint
bun run typecheck
bun run test

# Solidity
forge build
forge test
```

## Status

Pre-alpha. Hackathon build in progress. Target: 0G APAC Hackathon, May 16 2026.

## License

MIT
