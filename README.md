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

## Dev

```bash
bun install
bun run lint
bun run typecheck
bun run test
```

## Status

Pre-alpha. Hackathon build in progress. Target: 0G APAC Hackathon, May 16 2026.

## License

MIT
