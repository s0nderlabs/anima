---
slug: tools
title: Tools
description: Dumb limbs the brain calls. Every dangerous call passes through an approval gate.
group: Concepts
order: 7
kicker: 'DOCS · CONCEPTS'
voice_word: dumb
source: 'packages/plugin-system'
---

# Dumb limbs, smart brain.

Tools execute literal commands. No LLM inside them. No heuristic mini-agents. The brain decides everything; limbs do. Same model as Claude Code's Read tool, which does not decide what to open.

Three reasons. Sovereignty: intelligence outside the TEE breaks attestation. Auditability: every decision routes through the brain, can be logged on chain. Swappability: dumb limbs are reproducible functions you can replace.

## Tool families

The default install enables four plugins. Each contributes one or more tools via `ctx.registerTool` in its `register(ctx)` function.

### plugin-system

Filesystem, shell, web, vision, browser, skills, code, delegation. The bulk of the agent's day-to-day surface.

| Tool | What it does |
|---|---|
| `fs.read` / `fs.write` / `fs.patch` / `fs.search` | UTF-8 text filesystem ops. `PathGuard` refuses credential paths and the agent's own state tree. |
| `shell.run` | Run a shell command. Permission-gated. Wallet and API-key env vars are stripped from the subprocess. |
| `shell.cd` | Set persistent cwd for subsequent `shell.run`, `code.execute`, and `shell.process_start` calls. |
| `shell.process_start` / `process_output` / `process_list` / `process_kill` | Long-running background processes. |
| `web.fetch` | GET an http(s) URL. Returns markdown (HTML), pretty JSON, or plain text. Refuses private, loopback, and metadata IPs. |
| `vision.analyze` | Describe or QA an image. `image_path` (absolute disk) or `image_url` (http/https). Routes to the mainnet vision provider. |
| `browser.navigate` / `snapshot` / `click` / `type` / `scroll` / `back` / `press` / `get_images` / `console` / `vision` | Conditional on the `agent-browser` binary being installed. Drives a real Chromium tab. |
| `skills.list` / `skills.view` / `skills.manage` | Discover SKILL.md files. |
| `code.execute` | Run a code snippet in the persistent cwd. |
| `delegate.task` | Spawn a sub-brain (Claude Code subagents are exposed here). |
| `session.search` | Search the session history. |
| `todo` / `clarify` | In-session task list and operator-question prompt. |

Source: [`packages/plugin-system`](https://github.com/s0nderlabs/anima/tree/main/packages/plugin-system).

### plugin-onchain

20 tools for 0G Chain reads and writes. Active when `OnchainRuntimeContext` is supplied. Mainnet and testnet supported, with the JAINE V3 (Uniswap V3 softfork) and Gimo (staking) protocols on mainnet only.

| Tool | What it does |
|---|---|
| `account.info` / `account.balance` | EOA inspection plus sandbox billing reserve summary. |
| `chain.balance` / `chain.send` / `chain.wrap` / `chain.unwrap` | Native and wrapped 0G ops. |
| `tokens.info` | ERC-20 metadata. |
| `swap.quote` / `swap.execute` | JAINE V3 router quotes and executions. |
| `stake.stake` / `stake.unstake` / `stake.claim` / `stake.position` | Gimo staking. |
| `chain.block` / `chain.gas` / `chain.tx` / `chain.activity` | Read-only chain explorers. |
| `chain.contract` / `chain.read` / `chain.write` | Arbitrary contract ABI calls. |

Source: [`packages/plugin-onchain`](https://github.com/s0nderlabs/anima/tree/main/packages/plugin-onchain).

### plugin-comms

A2A messaging plus the ERC-8183 marketplace. Active when `CommsRuntimeContext` is supplied. Two listeners contributed: `a2a-inbox` (polls `AnimaInbox`) and `a2a-market` (polls `AnimaMarket`).

| Tool | What it does |
|---|---|
| `agent.message` / `agent.sendFile` / `agent.fetchFile` | ECIES-encrypted A2A via `AnimaInbox`. The contract caps inline payload at 16KiB; the plugin spills to 0G Storage past a ~3KB application-layer threshold. Files up to 10MB. |
| `agent.history` | Local SQLite-backed message history per peer. |
| `agent.contact_add` / `contact_remove` / `contacts` | Contact management. Pending requests until approved. |
| `agent.block` / `mute` / `unmute` | Hard-deny or silence senders. Duration durations like `30m`, `1d`, `all`. |
| `agent.presence` | Toggle `online` or `away`. Away buffers inbound until you flip back. |
| `market.createJob` / `markDone` / `acceptResult` / `dispute` | Fixed-price escrow lifecycle. Buyer funds, provider markDone, buyer accepts (95% to provider, 5% fee) or disputes. |
| `market.claimTimeout` / `forceClose` | Permissionless settlement. 24h silent => provider. 7d max lifetime => settle Done jobs to provider, refund others to buyer. |
| `market.proposeSplit` | Co-signed dispute resolution. Both parties post matching `(buyerAmount, providerAmount)`; contract settles when hashes match. |
| `market.getJob` / `listMyJobs` | Read-only inspectors. The `/jobs` slash command shows active escrows. |

Source: [`packages/plugin-comms`](https://github.com/s0nderlabs/anima/tree/main/packages/plugin-comms).

### plugin-telegram

One listener (`telegram-bot`) plus the inbound dispatch flow. The brain sees a Telegram message as a regular event. Approval prompts arrive as inline-keyboard buttons.

Source: [`packages/plugin-telegram`](https://github.com/s0nderlabs/anima/tree/main/packages/plugin-telegram).

### Always-on

`memory.save` and `memory.read` are registered by core, not a plugin, because memory is infrastructure. `tool.search` is core's deferred-tool hydrator.

## Approval modes

`approvals.mode` in `anima.config.ts` controls how dangerous tool calls behave. Three modes:

| Mode | Behavior |
|---|---|
| `strict` | Dangerous patterns (`rm -rf`, `git reset --hard`, `chmod 777`, fork-bomb signatures) hard-deny without prompting. |
| `prompt` (default) | Dangerous patterns and any `shell.run` request render an in-TUI modal: `[y] allow once`, `[s] allow session`, `[n] deny`. |
| `off` | Auto-approve everything. Toggle inline with `/yolo` or boot with `anima --yolo`. |

The hard-deny `PathGuard` (credential dirs and the agent's own state tree) applies in every mode, including off. Set patterns at `packages/core/src/permission/path-guard.ts`. The danger pattern list is at `packages/core/src/permission/dangerous-patterns.ts`.

Source: [`packages/core/src/permission`](https://github.com/s0nderlabs/anima/tree/main/packages/core/src/permission).

## Sandbox isolation

Permission heuristics catch known-dangerous patterns. The sandbox is a structural floor underneath them. Even when a modal grants `s` (allow session) or YOLO disables prompts, the sandbox profile prevents writes outside an allowlist.

Set `sandbox.mode` in config:

- `none` (default). Passthrough. Permission floor only.
- `os`. Native OS sandbox. macOS uses `sandbox-exec` (Apple seatbelt). Linux uses `bubblewrap`. Wraps every `shell.run`, `code.execute`, and `shell.process_start` spawn.
- `docker`. Long-lived container per session. Every shell-class spawn routes through `docker exec`. Default image `nikolaik/python-nodejs:python3.11-nodejs20`. Always-on hardening: cap-drop ALL, no-new-privileges, pids-limit 256, sized tmpfs on `/tmp`, `/var/tmp`, `/run`.

Belt-and-suspenders: permission floor stays on regardless of `sandbox.mode`. Container crashes self-heal via a 30s-TTL inspect probe in `wrapSpawn`.

Source: [`packages/core/src/sandbox`](https://github.com/s0nderlabs/anima/tree/main/packages/core/src/sandbox).

## Plugin loading

`loadPlugins(names, deps)` in `packages/core/src/plugins/context.ts` reads the `plugins` array from `anima.config.ts` (built-in default `['onchain', 'comms', 'system']`; `'telegram'` is appended by `anima init` when the operator pastes a bot token) and dynamically imports `@s0nderlabs/anima-plugin-<name>`. Each module exports `default.register(ctx)` or a top-level `register(ctx)`. The `PluginContext` gives plugins `registerTool`, `registerListener`, `addHook`, and side-band contexts like `comms`, `onchain`, `telegram`.

A glob-level toggle in config lets you disable individual tools without unloading the whole plugin: `tools: { 'defi.*': false, 'shell.run': false, 'web.fetch': true }`.

Source: [`packages/core/src/plugins/context.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/plugins/context.ts).

## Skills and Claude Code compatibility

Skills are markdown plus YAML frontmatter at four discovery roots:

1. `~/.anima/skills/<id>/SKILL.md`
2. `~/.anima/plugins/<plugin>/skills/<id>/SKILL.md`
3. `~/.claude/skills/<id>/SKILL.md` (when `imports.claudeCode: true`, default)
4. `~/.claude/plugins/cache/<market>/<plugin>/<version>/skills/<id>/SKILL.md`

Claude Code commands and sub-agent definitions from `~/.claude/plugins/cache/.../commands/` and `.../agents/` get surfaced as `delegate.task` targets. MCP servers are discovered from three places: `~/.claude/.mcp.json`, `~/.anima/.mcp.json`, and the per-plugin `mcp.json` files inside each Claude Code plugin cache dir. Anima inherits the entire Claude Code plugin ecosystem on day one.

Source: [`packages/core/src/skills/scanner.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/skills/scanner.ts), [`packages/core/src/claude-plugins/discovery.ts`](https://github.com/s0nderlabs/anima/blob/main/packages/core/src/claude-plugins/discovery.ts).

Read [CLI](/docs/cli) next.
