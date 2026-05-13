---
slug: configuration
title: Configuration
description: One TS module, fully typed via defineConfig. Every key, every default.
group: Reference
order: 9
kicker: 'DOCS · REFERENCE'
voice_word: typed
source: 'packages/core/src/config.ts'
---

# One typed config module.

`anima.config.ts` lives at the project root (or `~/.anima/config.ts` for runtime). It is a TS module that exports `defineConfig({ ... })`. The type lives at `packages/core/src/config.ts`. The wizard writes it at init; you can edit it any time.

## Minimal example

```ts
import { defineConfig } from '@s0nderlabs/anima-core'

export default defineConfig({
  network: '0g-mainnet',
  identity: {
    iNFT: {
      contract: '0x9e71d79f06f956d4d2666b5c93dafab721c84721',
      tokenId: '42',
      network: '0g-mainnet',
    },
    operator: '0xOPERATOR...',
    agent: '0xAGENT...',
  },
  brain: {
    provider: '0xPROVIDER...',
    model: 'qwen3-coder-plus',
  },
  plugins: ['onchain', 'comms', 'system', 'telegram'],  // 'telegram' opt-in; default is just the first three
})
```

`network` is required. Everything else has defaults.

## Top-level keys

| Key | Type | Default | What it controls |
|---|---|---|---|
| `network` | `'0g-mainnet' \| '0g-testnet'` | required | Chain to use for identity and on-chain reads. Mainnet `16661`, testnet `16602`. |
| `storage.network` | `AnimaNetwork` | mirrors `network` | 0G Storage indexer to use. |
| `identity.iNFT` | `INFTRef \| null` | `null` | Once minted, holds `{ contract, tokenId, network, mintBlock? }`. |
| `identity.operator` | `string \| null` | `null` | Wallet that owns the iNFT. |
| `identity.agent` | `string \| null` | `null` | Agent EOA address. |
| `brain.provider` | `string \| null` | `null` | Provider EOA selected from the 0G Compute catalog. |
| `brain.model` | `string \| null` | `null` | Model string from the catalog. |
| `brain.maxOutputTokens` | `number` | `4096` | Assistant output cap per turn. |
| `brain.contextWindow` | `number` | `1_000_000` | Used by the compaction trigger. |
| `brain.compaction` | `{ threshold, keepRecent } \| null` | `{ 0.5, 8 }` | Pre-flight summarize-fold when running estimate breaches `threshold * contextWindow`. |
| `brain.persistConversations` | `boolean` | `true` | Save channel history to JSONL under `conversations/`. |
| `plugins` | `AnimaPlugin[]` | `['onchain','comms','system']` | Which plugins to load. Add `'telegram'` to enable the bridge. |
| `tools` | `Record<string, boolean>` | `{}` | Glob-level allow/deny. Right-most match wins. |
| `imports.claudeCode` | `boolean` | `true` | Inherit skills, plugins, agents, MCP from `~/.claude/`. |
| `operator` | `OperatorSourceHint \| null` | `null` | Reconnect hint for the operator wallet source. |
| `subname` | `string \| null` | `null` | `<label>.anima.0g` label (no suffix). Init writes this. |
| `approvals.mode` | `'strict' \| 'prompt' \| 'off'` | `'prompt'` | Permission gate behavior. |
| `approvals.allowlist` | `string[]` | `[]` | Regex patterns matched against `kind|command|path` signatures. |
| `skills.disabled` | `string[]` | `[]` | Skill ids never to auto-load or index. |
| `prompt.append` | `string \| null` | `null` | Operator-supplied additions to the system prompt under `# Operator instructions`. |
| `vision.provider` | `string \| null` | mainnet default | Vision provider EOA. Set `null` to disable vision tools. |
| `economy.autoTopup` | `AutoTopupConfig` | disabled | Self-funding behavior. See below. |
| `deployTarget` | `'local' \| 'sandbox'` | `'local'` | Where the harness runs. |
| `sandbox` | `SandboxConfig` | `{ mode: 'none' }` | Sandbox container details when `deployTarget === 'sandbox'`, plus the per-spawn structural sandbox `mode`. |

## Tool toggles

Globs apply right-to-left. Specific keys win over broader keys:

```ts
tools: {
  'defi.*': false,        // disable every defi.* tool
  'shell.*': false,       // disable every shell tool
  'shell.run': true,      // ...except shell.run
  'web.fetch': true,
}
```

A tool blocked at the config layer never appears in the tool list the brain sees. A tool allowed at config still passes through the permission gate at call time.

## Approval modes

`approvals.mode` decides what happens when a tool call matches a dangerous pattern (`rm -rf`, `git reset --hard`, `chmod 777`, fork-bomb signatures) or is a generic `shell.run` request:

- `strict`: hard-deny. The brain sees an error.
- `prompt` (default): modal in the TUI. `[y]` allow once, `[s]` allow session, `[n]` deny.
- `off`: auto-approve. Toggle with `/yolo` or boot with `anima --yolo`.

`approvals.allowlist` skips the gate for specific signatures. Useful for trusted workflows. Example:

```ts
approvals: {
  mode: 'prompt',
  allowlist: ['^shell\\.run\\|git status', '^web\\.fetch\\|https://api\\.example\\.com'],
}
```

The `PathGuard` hard-deny (credential dirs, the agent state tree) applies in every mode including `off`.

## Auto-topup

When enabled, the agent self-funds its compute envelope from its EOA. Defaults are tuned for hackathon use:

```ts
economy: {
  autoTopup: {
    enabled: true,
    pollIntervalMs: 5 * 60_000,   // every 5 min
    compute: {
      lowThreshold: 1.7,           // 0G; raised from 0.5 to absorb a single qwen3.6-plus inference lock
      topUpAmount: 1.0,            // 0G
      maxPerDay: 5,                // 0G
    },
    wallet: {
      notifyThreshold: 2.0,        // notify operator when EOA drops below
      minRetainedAfterTopup: 0.1,  // never spend below this in a top-up
    },
  },
}
```

A 10-minute cooldown was added in v0.21.14 to kill the insufficient-wallet spam loop. Operator gets a notification via Telegram and TUI when topup fires, when wallet drops below `wallet.notifyThreshold`, and when topup fails (RPC error, insufficient agent balance, daily cap reached).

## Sandbox

Two distinct concerns under `sandbox`:

**Where the harness runs** (`deployTarget` plus `sandbox.id`, `providerAddress`, `endpoint`, `snapshotName`). Local mode ignores all of these. Sandbox mode requires them; they get written by `anima deploy`.

**How limb spawns are isolated** (`sandbox.mode`):

| Mode | Behavior |
|---|---|
| `none` (default) | Passthrough. Permission floor only. |
| `os` | Native OS sandbox. macOS `sandbox-exec`, Linux `bubblewrap`. Wraps every shell-class spawn. Falls back to passthrough with a warning if `bwrap` is missing on Linux. |
| `docker` | Long-lived container per session. Default image `nikolaik/python-nodejs:python3.11-nodejs20`. Hardening always on: cap-drop ALL, no-new-privileges, pids-limit 256, sized tmpfs. |

Docker mode additionally exposes `dockerImage`, `dockerMountWorkspace`, `dockerRuntimePath`, `dockerCpu`, `dockerMemoryMb`, `dockerDiskMb`, `dockerNoNetwork` for fine control. Defaults are unbounded so the container competes fairly with host work without OOM surprises.

## Operator hint

When you re-run a command that needs the operator wallet (chat, topup, restore), `anima` reads `operator` to skip the picker. Set by the init wizard:

```ts
operator: {
  source: 'keystore-file',
  keystorePath: '~/wallets/operator.json',
}
```

Sources: `walletconnect`, `keychain` (macOS only, plus `keychainService`), `keystore-file` (plus `keystorePath`), `raw-privkey`.

## Networks

`NETWORK_RPC` and `NETWORK_CHAIN_ID` are exported at `packages/core/src/config.ts`:

| Network | Chain ID | RPC |
|---|---|---|
| `0g-mainnet` | 16661 | `https://evmrpc.0g.ai` |
| `0g-testnet` | 16602 | `https://evmrpc-testnet.0g.ai` |

Block explorers: `chainscan.0g.ai` (mainnet), `chainscan-galileo.0g.ai` (testnet). Storage indexer (mainnet): `https://indexer-storage-turbo.0g.ai`.

Read [Console](/docs/console) next.

Source: [`packages/core/src/config.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/config.ts).
