---
slug: architecture
title: Architecture
description: Six layers, each anchored to a 0G primitive. One gateway, six event sources, two deployment modes.
group: Concepts
order: 3
kicker: 'DOCS · CONCEPTS'
voice_word: distributed
source: 'packages/core/src/index.ts'
---

# A distributed harness, not a daemon.

Anima is six layers wired into one runtime. Identity on 0G Chain, memory on 0G Storage, brain in a 0G Compute TEE, harness in a 0G Sandbox TEE (or on your laptop), limbs on your devices, wallet split between hot and cold copies. No single component s0nderlabs operates.

```
      Operator wallet
   (WalletConnect, Keychain,
    keystore file, raw pk)
            │
            │  signs once at init
            ▼
  ┌───────────────────────────────┐
  │  Anima harness  (one binary)  │
  │  ┌──────────────────────┐     │      ┌──────────────────────────────┐
  │  │  anima CLI  ·  TUI   │─────┼─────▶│  0G Chain (mainnet 16661)    │
  │  │  or sandbox gateway  │     │      │  · iNFT identity (ERC-7857)  │
  │  └──────────────────────┘     │      │  · AnimaInbox  (A2A)         │
  │  ┌──────────────────────┐     │      │  · AnimaMarket (escrow)      │
  │  │  Agent EOA           │─────┼─────▶│  · SubnameRegistrar          │
  │  │  infra wallet        │     │      └──────────────────────────────┘
  │  └──────────────────────┘     │
  └───────────────────────────────┘
            │
            ├────────▶  0G Storage    encrypted keystore + packed-blob memory
            ├────────▶  0G Compute    TeeML inference (model picked live at init)
            └────────▶  0G Sandbox    TDX TEE container (optional, Galileo)
```

## The six layers

| Layer | Implementation | Files |
|---|---|---|
| Identity | ERC-7857 iNFT on 0G Chain | [`packages/core/src/identity`](https://github.com/s0nderlabs/anima/tree/main/packages/core/src/identity) |
| Brain | 0G Compute via the serving-broker SDK, TeeML attested | [`packages/core/src/brain`](https://github.com/s0nderlabs/anima/tree/main/packages/core/src/brain) |
| Memory | Typed markdown files, encrypted, anchored to 0G Storage and the iNFT | [`packages/core/src/memory`](https://github.com/s0nderlabs/anima/tree/main/packages/core/src/memory) |
| Limbs | Dumb tools, no LLM inside them, brain decides everything | [`packages/plugin-system`](https://github.com/s0nderlabs/anima/tree/main/packages/plugin-system) |
| Comms | A2A messaging (ECIES, no ZK), ERC-8183 marketplace pattern | [`packages/plugin-comms`](https://github.com/s0nderlabs/anima/tree/main/packages/plugin-comms) |
| Economy | Agent wallet, infrastructure self-funding, AutoTopupManager | [`packages/core/src/economy`](https://github.com/s0nderlabs/anima/tree/main/packages/core/src/economy) |

## The runtime

The runtime is assembled at `packages/gateway/src/build-runtime.ts` (sandbox mode) or `packages/cli/src/commands/chat.tsx` (local mode). Both construct the same shape:

- An `EventQueue` that fans events from listeners to a single `routeLoop`.
- A `Brain` (`OGComputeBrain` against 0G Compute, or `StubBrain` for tests).
- A `ToolRegistry` populated by plugins via `ctx.registerTool`.
- A `MemorySyncManager` that batches edits and fires one `iNFT.update()` per sync.
- A `PermissionService` with three modes (`off`, `prompt`, `strict`) plus a hard-deny `PathGuard`.
- Listener instances contributed by plugins (A2A inbox, A2A market, Telegram bot, etc.) plus the local stdin listener in CLI mode.

The `routeLoop` pulls one event at a time, calls `brain.infer({ event })`, dispatches tool calls one by one, and emits a `turn` to the UI. Per-turn the activity log appends to `activity.jsonl`. Per-turn the memory sidecar diffs the partition and decides whether to enqueue a sync (or skip if no slot changed).

## The gateway pattern

A `Listener` is a small object with `{ name, source, start(queue), stop() }`. Plugins contribute listeners via `ctx.registerListener`. Eight event sources are defined in the type union; four have live emitters today.

| Source | Listener | Where |
|---|---|---|
| stdin | Local CLI input | `packages/cli/src/commands/chat.tsx` |
| a2a | Agent-to-agent messages | `packages/plugin-comms/src/listener.ts` |
| marketplace | ERC-8183 job events | `packages/plugin-comms/src/market-listener.ts` |
| telegram | Telegram Bot API long-poll | `packages/plugin-telegram/src/listener.ts` |
| cron | Scheduled triggers | Reserved, not yet shipped |
| webhook | HTTP triggers | Reserved, not yet shipped |
| chain | Arbitrary contract subscriptions | Reserved, not yet shipped |
| internal | Brain self-trigger | Reserved (type only), not yet shipped |

Disable a plugin and its listeners stop firing. The queue and the router stay in core.

## Deployment modes

Two modes, picked at `anima init` via the `deployTarget` config field.

**Local.** Wherever the CLI runs, that is where anima runs. Laptop, VPS, home server, anything. The brain, the tools, the listeners, the memory sync, all in-process. Permission floors apply. The local gateway sock at `~/.anima/agents/<id>/gateway.sock` lets external triggers (Telegram, future cron) reach the brain even when the TUI is closed.

**0G Sandbox.** A persistent TDX TEE container on Galileo testnet. The CLI orchestrates `createSandbox` then `bootstrap` then ECIES Option 3 keystore handoff. After that the laptop CLI is a thin HTTP plus SSE client to the harness. Burn rate is about 0.09 0G per hour for 1 CPU and 1 GB. `anima pause` archives the container (stops the burn) without losing identity. `anima resume` brings it back in 2 to 5 minutes.

The CLI is the single orchestration plane, closer to `vercel deploy` than `kubectl`. You never see SSH tokens, supervisor scripts, or Daytona quirks.

## The two-wallet model

Operator wallet owns the iNFT. One signature at init to mint and to approve. After that the operator wallet only signs cold transactions: keystore unlock, transfer of iNFT, manual `inspect` decrypts.

Agent EOA pays all ongoing infra gas. Subname claim, memory sync, storage uploads, compute ledger deposits, marketplace escrow, contract reads and writes. The private key lives encrypted to the operator wallet via HKDF-SHA256 plus AES-256-GCM. Only the operator wallet can decrypt. The ciphertext is anchored on 0G Storage and the root hash is in the iNFT keystore slot.

`anima restore <iNFT-ref>` on a new machine reads the keystore slot, downloads the ciphertext, prompts the operator wallet for an EIP-712 signature, derives the key, decrypts, and rehydrates the agent.

## The harness in a sandbox

When deployed to 0G Sandbox the gateway daemon at `packages/gateway/src/server.ts` exposes:

- `GET /healthz` for status checks. Includes listener health (the canonical "is Telegram up" diagnostic per `feedback-gateway-restart-must-revalidate-scopes`).
- `GET /bootstrap/pubkey` so the operator's `anima deploy` can ECIES-encrypt the keystore.
- `POST /bootstrap/provision` to receive the encrypted keystore.
- `GET /events` (SSE) for tool indicators and approval prompts.
- `POST /chat` for operator-signed chat input.
- `POST /sync` for explicit memory flushes.
- `POST /approval/:id/respond` for approval modal responses.
- `POST /admin/autotopup/tick` for operator-signed live-fire of one `AutoTopupManager` poll cycle.

A 30-minute self-ping (`packages/gateway/src/heartbeat.ts`) prevents Daytona's idle-archive cycle. The standalone gateway daemon model means TUI launch and TUI exit never affect the brain's availability for Telegram or A2A.

Read [Identity](/docs/identity) next.

Source: [`packages/core/src/index.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/index.ts), [`packages/gateway/src/server.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/gateway/src/server.ts), [`packages/gateway/src/build-runtime.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/gateway/src/build-runtime.ts).
