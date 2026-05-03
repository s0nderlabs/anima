# anima

First fully on-chain sovereign agent harness on 0G.

## Install

```bash
bun add -g @s0nderlabs/anima
anima init
```

Requires [bun](https://bun.sh) ≥ 1.1. The wizard mints your iNFT, opens a 0G Compute ledger, and brings up the agent. After that, just type `anima` to chat. See [Commands](#commands) below for the full surface.

For development from source, see [Development](#development).

## What it is

Anima is a CLI-hosted agent harness where the agent's identity, memory, reasoning, and economic life all live on 0G's decentralized infrastructure. Operator runs `anima init` once. After that, the agent persists on chain: close the laptop, walk away, the agent survives. Any operator machine can re-attach via the iNFT.

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
├── cli                        @s0nderlabs/anima                 TUI binary
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
| `AnimaInbox` (Phase 7) | `0xcd92844cc0ec6Be0607B330D4BaCC707339f2589` | Stateless message-emit singleton for agent-to-agent comms. ECIES ciphertext + 16KiB inline cap with 0G Storage spillover. |
| `AnimaMarket` (Phase 8) | `0x3ebD21f5dd67acDeF199fACF28388627212bA2aB` | Native-0G fixed-price escrow. Funded → Done → (Accepted \| Disputed) → Settled. 24h acceptance, 7d max lifetime, immutable 5% fee. Co-signed `proposeSplit` for disputes; default-refund-to-buyer at MAX_LIFETIME. |

Parent domain `anima.0g` is registered on SPACE ID on mainnet; `anima init` issues `<label>.anima.0g` subnames for new agents and publishes the agent's secp256k1 uncompressed pubkey as a `pubkey` text record so other animas can ECIES-encrypt to them.

## Commands

- `anima init` — first-time onboarding wizard (see below). Phase 11 adds a deploy-target select: `local` (this machine, default) or `sandbox` (0G Sandbox TDX TEE on Galileo testnet, persistent through laptop closure).
- `anima` (or `anima chat`) — interactive chat with your agent. Per-turn auto-sync to 0G + chain anchor. Slash commands: `/sync`, `/yolo`, `/jobs`, `/model`, `/exit`, `/help`. Keybinds: `Esc` aborts the current turn mid-flight, `Ctrl+U` / `Ctrl+D` (or `Opt+U` / `Opt+D` if your terminal sends Opt as Alt) scroll the history without leaving the input bar. In sandbox mode, the laptop CLI is a thin client to the harness HTTP server; tool indicators arrive over SSE.
- `anima --yolo` — same chat, but with the approval system disabled for the session (auto-approves dangerous tool calls). Status bar shows `perms: off`.
- `anima status` — agent + wallet + config state. In sandbox mode also probes `/healthz` + provider sandbox state in parallel.
- `anima logs` — tail the activity log (`--tail N`, `--agent <id>`). In sandbox mode tails `/var/log/anima-harness.log` inside the container via the provider's toolbox exec.
- `anima restore <iNFT-ref>` — recover an agent on a new machine from its iNFT (refs: `eip155:16661:0x...:N` or `0g-mainnet:0x...:N`)
- `anima topup --agent N` — operator sends N 0G to the agent EOA (infra gas)
- `anima topup --compute N` — agent deposits N 0G into the 0G Compute ledger
- `anima topup --provider N`: operator deposits N 0G into the Galileo SandboxServing contract (testnet runtime fees: ~0.09 0G/hour per active sandbox)
- `anima resume`: wake a stopped or archived sandbox + re-handoff the agent privkey to the (newly restarted) harness. Same sandbox UUID + endpoint preserved. Use when the harness goes offline (Daytona auto-archive after 60min idle, or INSUFFICIENT_BALANCE settlement event)
- `anima pause`: archive a started sandbox to stop the runtime burn during dev gaps. Sandbox UUID + endpoint preserved; resume with `anima resume` (~2-5 min cold restore). Does NOT require operator-keystore unlock, only the operator wallet to sign the archive request. Burn rate ~0.09 0G/hour means a 12 h/day idle window saves ~1.1 0G/day on testnet runtime fees.
- `anima ledger [balance | refund | retrieve | close]` — drain the 0G Compute ledger of a retiring agent. `balance` shows main + per-provider sub-account state. `retrieve` calls `retrieveFund('inference')` to start the per-provider lock window (call again after the window to actually pull). `refund [--amount N | --all]` withdraws from the main account back to the agent EOA. `close --yes` deletes the ledger entirely.
- `anima drain --to <addr>` — sweep the agent EOA's native balance to a target address. Defaults to `config.identity.operator` if `--to` omitted. Reserves 21000 × live gas price for the sweep tx; sends the rest. Use after `anima ledger refund` to finish recovering funds from a retired agent.
- `anima sync` — force flush memory + activity-log to 0G Storage and anchor on chain. In sandbox mode proxies to the harness's `POST /sync` (no laptop-side keystore decrypt).
- `anima inspect` — read what's anchored on chain for an iNFT. Default decrypts every IntelligentData slot via the operator wallet and prints the plaintext. Flags: `--slot <name>` (filter), `--tx <hash>` (decode an `update()` tx + show which slots have been superseded), `--raw` (no decrypt, root hashes + ciphertext sizes only), `--diff` (compare local memory files vs chain plaintext via keccak256), `--json` (structured output), `--full` (skip the 40-line truncation), `--out <dir>` (dump every decrypted slot to disk). Foreign iNFTs auditable via positional ref: `anima inspect 0g-mainnet:0xCONTRACT:tokenId` (raw view only).
- `anima model` — re-pick brain provider/model
- `anima migrate-keystore` — one-time v0.5 (passphrase) → v0.6 (operator-wallet) keystore upgrade
- `anima deploy` — Local→Sandbox migration. Decrypts existing keystore via operator wallet, runs Galileo deposit + acknowledge → createSandbox → bootstrap → Option 3 ECIES handoff → publish `agent:endpoint` text record on subname. Operator never plaintexts the privkey on the laptop after handoff.
- `anima upgrade [<ref>] [--ref vX.Y.Z] [--yes] [--reprovision]` — roll the sandbox harness to a new git ref while preserving identity + memory. With no args (or `latest`), resolves the latest published release via GitHub API; positional or `--ref` accepts an explicit tag. The CLI pre-flights tag visibility against GitHub before invoking the upgrade and post-flights `package.json version` against the resolved ref so silent-success regressions can't slip through. Default = in-place: `git fetch + checkout + bun install + harness restart` inside the existing Daytona container (~30-60s downtime, $0). `--reprovision` opts into a fresh-container swap (~2-5 min, ~0.9 0G testnet) for the future when sealed mode is real.
- `anima init --resume` — pick up a partial init from the last incomplete step

### Sandbox lifecycle (deploy target = sandbox)

Once an agent is deployed to 0G Sandbox, it burns ~0.09 0G/hour (Galileo testnet) for the underlying compute (1 CPU + 1 GB). The harness self-pings its public proxy URL every 30 minutes (override via `HARNESS_HEARTBEAT_INTERVAL_MS` env at boot) so that healthy `started` sandboxes don't accidentally enter Daytona's `stopped → archived` cycle. Use `anima pause` between dev sessions to stop the burn cleanly; `anima resume` brings the same container back online (~2-5 min for the filesystem restore from object storage). Refill the runtime budget with `anima topup --provider N`.

## Tools the agent can call

The brain ships with a battery-included tool surface (Phase 9.0). Each tool runs through a permission gate (`approvals.mode` in `~/.anima/config.ts`, default `prompt`):

| Tool | Description |
|------|-------------|
| `memory.save` / `memory.read` | Durable agent memory on 0G Storage |
| `tool.search` | Hydrate deferred tool schemas (Claude Code-style) |
| `fs.read` / `fs.write` / `fs.patch` / `fs.search` | UTF-8 text filesystem ops scoped to the workspace, refusing credential paths and the agent's own state tree |
| `shell.run` | Run a shell command. Permission-gated; wallet/API-key env vars are stripped from the subprocess |
| `shell.cd` | Set persistent cwd for subsequent shell.run / code.execute / shell.process_start calls. Refuses credential dirs and the agent state tree. |
| `web.fetch` | GET an http(s) URL and return body as markdown (HTML), pretty JSON, or plain text. GET-only; refuses private/loopback/metadata IPs. |
| `vision.analyze` | Describe / answer questions about an image. Pass `image_path` (absolute disk path) OR `image_url` (http/https). Routes to `qwen/qwen3-vl-30b-a3b-instruct` on 0G Compute mainnet via a multi-provider broker pool. Same `PathGuard` deny list as fs.* |
| `browser.vision` | Screenshot the agent-browser tab and route through the same vision provider |
| `agent.message` / `agent.sendFile` / `agent.fetchFile` | A2A messaging via `AnimaInbox` singleton. ECIES-encrypted to recipient's `.0g pubkey` text record; chain only sees ciphertext. Inline up to ~3KB; spillover via 0G Storage. Files up to 10MB. PathGuard on `agent.fetchFile`. |
| `agent.history` | Local sqlite-backed message history with per-peer filter |
| `agent.contact_add` / `agent.contact_remove` / `agent.contacts` | Contact management. First message from a non-contact lands in pending; brain approves with `agent.contact_add`. |
| `agent.block` / `agent.mute` / `agent.unmute` | Hard-deny senders (block) or silence notifications (mute, optional duration like `30m`/`1d`/`all`) |
| `agent.presence` | Toggle `online` / `away`. Away buffers inbound messages until you flip back. |
| `market.createJob` / `market.markDone` / `market.acceptResult` / `market.dispute` | Fixed-price escrow on `AnimaMarket`. Buyer funds with native 0G; provider markDone after 24h acceptance window; buyer accept (95% to provider, 5% fee) or dispute. |
| `market.claimTimeout` / `market.forceClose` | Permissionless settlement triggers. claimTimeout releases to provider after 24h silent; forceClose at 7d settles a Done job to provider, refunds buyer otherwise. |
| `market.proposeSplit` | Co-signed dispute resolution. Both parties post matching `(buyerAmount, providerAmount)`; contract auto-settles when hashes match. |
| `market.getJob` / `market.listMyJobs` | Read-only inspectors. /jobs slash command in TUI lists active escrows. |
| `todo` | In-session task list |
| `clarify` | Ask the operator a question |
| `skills.list` / `skills.view` | Discover and read SKILL.md files under `~/.anima/skills/` and (when `imports.claudeCode: true`) `~/.claude/skills/` |

Approval modes:
- `prompt` (default) — dangerous patterns (`rm -rf`, `git reset --hard`, `chmod 777`, fork bomb, etc.) and any `shell.run` request render an in-TUI modal: `[y] allow once  [s] allow session  [n] deny`.
- `strict` — dangerous patterns hard-deny without prompting.
- `off` (YOLO) — auto-approve everything; toggle inline with `/yolo` or boot with `anima --yolo`.

The hard-deny `PathGuard` (credential dirs + agent state tree) applies in every mode, including YOLO.

### Sandbox (Phase 9.5, opt-in)

Permission heuristics catch known-dangerous patterns. The sandbox is a structural layer beneath them — even when the modal grants `s` (allow session) or yolo disables prompts entirely, the sandbox profile prevents writes outside an allowlist. Set `sandbox.mode` in `~/.anima/config.ts`:

- `none` (default) — passthrough. Permission floor only.
- `os` — native OS sandbox. macOS uses `sandbox-exec` (Apple seatbelt); Linux uses `bubblewrap` (`bwrap`). Wraps every shell.run / code.execute / shell.process_start spawn. Allows writes to agentDir + cwd + `/tmp/anima-*` (+ `/var/folders` on macOS). Denies reads of `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.config/anthropic`, `~/.gnupg` (+ `~/Library/Keychains` on macOS). Falls back to passthrough with a stderr warning if `bwrap` isn't installed on Linux.
- `docker` — long-lived container per session, every shell-class spawn routes through `docker exec`. Auto-detects Docker Desktop or Podman. Default image `nikolaik/python-nodejs:python3.11-nodejs20` (matches hermes; bash + python3 + node + npm + git on standard PATH). Container has its own filesystem; host is invisible unless `sandbox.dockerMountWorkspace: true`. Always-on hardening (cap-drop ALL + selective re-add, no-new-privileges, pids-limit 256, sized tmpfs at /tmp /var/tmp /run, --init for zombie reaping). Optional resource caps: `dockerCpu`, `dockerMemoryMb`, `dockerDiskMb`, `dockerNoNetwork`. Mirrors hermes-agent's `TERMINAL_ENV=docker` isolation.

Belt-and-suspenders: permission floor stays on regardless of `sandbox.mode`. Container crashes (external `podman kill`, OOM, daemon restart) self-heal via a 30s-TTL `inspect` probe in `wrapSpawn`.

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
