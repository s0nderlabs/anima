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

All contracts are CREATE2-deployed, so testnet + mainnet share the same address.

| Contract | Address | Notes |
|----------|---------|-------|
| `AnimaAgentNFT` (ERC-7857) | `0x9e71d79f06f956d4d2666b5c93dafab721c84721` | Deployed on both testnet + mainnet via CREATE2 |
| `AnimaSubnameRegistrar` | `0x33d9f4ec2bd7e7cb4e288c3bbc3a76be472fdd98` | Mainnet only. Permissionless `<label>.anima.0g` issuer. |

Parent domain `anima.0g` is registered on SPACE ID on mainnet; `anima init` issues `<label>.anima.0g` subnames for new agents.

## Commands

- `anima init` — first-time onboarding wizard (see below)
- `anima` (or `anima chat`) — interactive chat with your agent. Per-turn auto-sync to 0G + chain anchor. Slash commands: `/sync`, `/yolo`, `/help`.
- `anima --yolo` — same chat, but with the approval system disabled for the session (auto-approves dangerous tool calls). Status bar shows `perms: off`.
- `anima status` — agent + wallet + config state
- `anima logs` — tail the activity log (`--tail N`, `--agent <id>`)
- `anima restore <iNFT-ref>` — recover an agent on a new machine from its iNFT (refs: `eip155:16661:0x...:N` or `0g-mainnet:0x...:N`)
- `anima topup --agent N` — operator sends N 0G to the agent EOA (infra gas)
- `anima topup --compute N` — agent deposits N 0G into the 0G Compute ledger
- `anima sync` — force flush memory + activity-log to 0G Storage and anchor on chain
- `anima model` — re-pick brain provider/model
- `anima migrate-keystore` — one-time v0.5 (passphrase) → v0.6 (operator-wallet) keystore upgrade
- `anima deploy` — Local→Sandbox migration via Option 3 ECIES handoff (Phase 11 wires the actual sandbox call)
- `anima init --resume` — pick up a partial init from the last incomplete step

## Tools the agent can call

The brain ships with a battery-included tool surface (Phase 9.0). Each tool runs through a permission gate (`approvals.mode` in `~/.anima/config.ts`, default `prompt`):

| Tool | Description |
|------|-------------|
| `memory.save` / `memory.read` | Durable agent memory on 0G Storage |
| `tool.search` | Hydrate deferred tool schemas (Claude Code-style) |
| `fs.read` / `fs.write` / `fs.patch` / `fs.search` | UTF-8 text filesystem ops scoped to the workspace, refusing credential paths and the agent's own state tree |
| `shell.run` | Run a shell command. Permission-gated; wallet/API-key env vars are stripped from the subprocess |
| `todo` | In-session task list |
| `clarify` | Ask the operator a question |
| `skills.list` / `skills.view` | Discover and read SKILL.md files under `~/.anima/skills/` and (when `imports.claudeCode: true`) `~/.claude/skills/` |

Approval modes:
- `prompt` (default) — dangerous patterns (`rm -rf`, `git reset --hard`, `chmod 777`, fork bomb, etc.) and any `shell.run` request render an in-TUI modal: `[y] allow once  [s] allow session  [n] deny`.
- `strict` — dangerous patterns hard-deny without prompting.
- `off` (YOLO) — auto-approve everything; toggle inline with `/yolo` or boot with `anima --yolo`.

The hard-deny `PathGuard` (credential dirs + agent state tree) applies in every mode, including YOLO.

## Operator wallet sources

Four first-class sources, pick at `anima init`:

- **WalletConnect** — QR-pair with any WC v2 mobile wallet (MetaMask Mobile, Rainbow, Trust, Coinbase Wallet, Zerion, Safe, Ledger Live, etc.). Keys never leave the phone.
- **macOS Keychain** — store privkey in login keychain under a service name (default `anima.operator`). Touch ID biometric gating is planned for 6.5b.
- **Keystore file** — standard geth-format encrypted JSON with passphrase. Portable.
- **Raw private key** — stdin prompt or `ANIMA_OPERATOR_PRIVKEY` env var, for CI/scripting.

Linux/Windows see three sources (keychain is macOS-only for now).

## `anima init`

Runs the onboarding wizard. Two wallets, per project-anima.md section 22.1:

- **Operator wallet** — owns the iNFT. One-shot at init (mint + approve). See "Operator wallet sources" above.
- **Agent EOA** — separate fresh key generated by the wizard. Pays all ongoing infra gas (subname claim, memory sync, storage uploads, compute ledger deposits, future tool txs). v0.6: encrypted to operator wallet via EIP-712 sign-derived-key (HKDF-SHA256 + AES-256-GCM). Stored only as ciphertext on 0G Storage, root hash anchored in iNFT keystore slot. No passphrase; operator wallet decrypts on-demand at session start.

Flow (Phase A → D):

**Phase A (local prompts):**
1. Pick network (mainnet or testnet).
2. Pick subname (optional), with onchain availability check at pick time.
3. Pick a brain model from the live 0G Compute catalog (per-token pricing shown).
4. Pick compute ledger deposit size (Starter 3 0G / Standard 10 0G / Extended 30 0G / Custom).
5. Set keystore passphrase.

**Phase B (wallet gate):**
6. Pick operator wallet source, connect.
7. Review cost summary (real numbers, $0.50/0G estimate).
8. If insufficient balance: operator address rendered as QR + balance polled until threshold met (or skip-ledger / cancel).

**Phase C (execute, incrementally resumable via `.anima-init-state.json`):**
9. Generate fresh agent EOA, save encrypted keystore locally.
10. Operator mints ERC-7857 iNFT with 6 canonical `IntelligentData` slots + `setApprovalForAll(agent, true)` (one tx).
11. Operator funds agent EOA with ~10.1 0G (0.1 infra float + ledger deposit).
12. Agent uploads encrypted keystore blob to 0G Storage and anchors root hash in the `keystore` slot (enables `anima restore`).
13. Agent opens 0G Compute ledger via `broker.ledger.addLedger`.
14. If subname chosen: agent claims `<subname>.anima.0g` via permissionless registrar, writes `address` + `agent:inft` text records.

**Phase D:** writes `anima.config.ts` with `identity.iNFT`, `identity.operator`, `identity.agent`, `brain.provider`, `brain.model` populated.

If any step fails mid-flow, `anima init --resume` picks up from the first incomplete agent-side step (keystore persist, ledger open, subname records).

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
