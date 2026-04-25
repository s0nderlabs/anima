# Changelog

All notable changes to the anima monorepo are tracked per-package via [changesets](./.changeset/). Root-level entries live here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.1] - 2026-04-25

### Fixed

- **Chat TUI silently exited on launch.** v0.6.0's `anima` (chat) booted, rendered one frame, and exited within ~7 seconds before the user could send a message. Two compounding causes in `packages/cli/src/commands/chat.tsx`: (1) `clack/prompts` `bootSpinner.stop('Connected')` ran *after* `createCliRenderer`, calling `setRawMode(false) + stdin.pause()` which tore down the stdin handlers opentui's renderer had just installed; (2) `@opentui/solid`'s `render()` resolves once the component mounts (does not block), so on macOS where opentui's animation loop runs in a worker thread, the main thread had no JS task keeping the event loop alive after `runChat` returned. Fix: brain init's spinner now fires *before* `createCliRenderer` (every clack interaction completes before opentui takes the wheel), and an `await new Promise<void>(() => {})` after `render()` keeps the main thread alive until `handleExit` fires `process.exit(0)`. Stray `?1016;2$y` and `Gi=31337;OK` capability-response leakage into the parent shell is also gone (those were the dying TUI's unread responses).

### Added

- **`test/local/_tmux.ts` + 7 `tmux-*.ts` drivers** (`chat`, `cross-session`, `status`, `logs`, `sync`, `topup`, `model`). The drivers spawn real `anima` sessions in detached tmux panes, drive them with `send-keys`, and assert on captured pane content. `tmux-chat.ts` catches the regression class above (TUI alive past boot, real brain reply, real per-turn chain anchor). `tmux-cross-session.ts` is the load-bearing test for the "agent persists across processes" pitch: plant a fact in session A, kill it, start session B, verify the agent recalls the fact via its memory tools. New helpers in `_tmux.ts`: `runTmuxTest`, `runOneShot`, `sleep`. `.gitignore` updated to commit `tmux-*.ts` and `_tmux.ts` while keeping the rest of `test/local/` (phase scripts, fund audits, findings dumps) local-only.

### Changed

- **`/seal` Step 3 e2e gate** is now real. The `tmux-*.ts` drivers under `test/local/` are committed, so future regressions of the chat TUI lifecycle (or any other interactive CLI command) get caught before tagging.

## [0.6.0] - 2026-04-25

### Added

- **Phase 6.6: operator-wallet keystore (drops the passphrase entirely).** Agent privkey is encrypted to a key derived from an EIP-712 signature by the operator wallet (`wallet/operator-keystore-crypto.ts`, sign-derived-key + HKDF-SHA256 + AES-256-GCM, RFC 6979 deterministic). Encrypted blob lives only on 0G Storage; root hash anchored in the iNFT `keystore` slot. Local file at `~/.anima/agents/<id>/keystore.json` is just a download cache. `OperatorSigner.account()` return type narrowed to `LocalAccount` so `signTypedData` is reachable on every implementation.
- **Phase 6.7: per-turn auto-sync of memory + activity-log to 0G Storage and chain.** New `MemorySyncManager` orchestrates: diff against last-anchored plaintext hash → encrypt with agent-privkey-derived AEAD key → upload changed blobs → fire one batched `iNFT.updateSlots` tx. Wired into `chat.tsx` so every brain turn produces at least one chain anchor (activity-log, plus any changed `/agent/*` files). User-partition (`/user/*`) uploads encrypted but never anchors (locked privacy rule).
- **Hermes-style proactive memory saving.** `DEFAULT_SYSTEM_PROMPT` rewritten with strong directives copied from Hermes's `MEMORY_GUIDANCE` ("save durable facts the moment you learn them — DO NOT wait to be asked"; prioritize what reduces future user steering; never save task progress / completed-work logs / ephemeral state). Per-tool guidance blocks (`MEMORY_SAVE_GUIDANCE`, `MEMORY_READ_GUIDANCE`) appended only when the matching tool is loaded.
- **`memory.read` tool** with MEMORY.md-aware lookup: tries direct relative path → MEMORY.md substring match by title or filename → common naming patterns. Path-traversal-checked via `resolve()` + root-prefix guard so a malicious memory entry can't steer the brain into reading out-of-tree files.
- **Tool-call indicators in TUI.** Every tool call renders `▸ name(args)` before dispatch and `↳ name ok · path` (or `↳ name failed · error`) after. Visibility into the agent's actions matches Claude Code / Hermes UX.
- **`MEMORY.md` moved out of cached system prompt** into a per-turn user-message `<system-reminder>` (claude-code style). System-prompt prefix stays stable across MEMORY.md churn so 0G Compute prompt-cache hit rate (~97%) survives memory writes. Identity + persona + per-tool guidance + session timestamp remain in the cached system prefix.
- **New CLI commands**: `anima sync` (force memory + activity-log flush to 0G + anchor on chain), `anima migrate-keystore` (v0.5 passphrase keystore → v2 operator-wallet, one-time upgrade), `anima model` (re-pick brain provider/model), `anima deploy` (Local→Sandbox migration scaffold; full handoff lands with Phase 11 sandbox harness).
- **Slash commands inside chat TUI**: `/sync` force-flush, `/help` lists slash commands.
- **Option 3 ECIES crypto primitive** (`migration/option3-crypto.ts`) for Local→Sandbox keystore handoff: secp256k1 ECDH + HKDF-SHA256 + AES-256-GCM. Used by future `anima deploy` to encrypt the agent privkey to the sandbox container's bootstrap pubkey without ever exposing plaintext on the operator's laptop.
- **Subname validation extracted** to `naming/validate.ts` (`SUBNAME_LABEL_RE`, `validateSubnameLabel`) with a 13-test suite covering length bounds, casing, hyphen edges, char whitelist, unicode rejection.
- **Init wizard now seeds** `/agent/identity.md`, `/agent/persona.md`, `/user/profile.md` and an empty `MEMORY.md`. Without seeded files the canonical iNFT slots (identity, persona, memory-index) stay bootstrap forever.
- **`bun + workspace-cwd` follow-redirects fix.** Polyfilled `Error.captureStackTrace` at the top of `packages/cli/bin/anima` so chat works from inside the workspace cwd (was previously crashing with `fatal: First argument must be an Error object` due to a bun + axios/follow-redirects load incompatibility).

### Changed

- **`anima.config.ts` location moved from cwd to `~/.anima/config.ts`.** Config emitted as a self-contained `export default { ... }` (no `import { defineConfig }`) so it loads from any directory without a workspace context. `findAndLoadConfig` looks at the canonical path first, falls back to a cwd-walk for legacy v0.5.0 setups.
- **`OperatorSigner.account()`** return type narrowed from `Account` to `LocalAccount`.
- **`mintAgent`** drops `keystorePath` param. Mints with `bootstrapHashFor('keystore')` placeholder; agent updates the slot to the real 0G Storage root hash post-upload via the operator's `setApprovalForAll`.
- **`OGComputeBrain.infer`** now correctly threads `tool_calls` through the assistant message in multi-tool turns (was producing HTTP 400 `messages with role "tool" must follow tool_calls` on multi-tool turns).
- **`BrainMessage`** gains `toolCalls?` field on assistant role for round-trip integrity.
- **`AnimaConfig`** gains optional `operator?: OperatorSourceHint` so post-init commands skip the operator picker.
- **`anima topup --agent`** now uses `loadOrPickOperatorSigner` (was inconsistent with `--compute` mode).
- **`/e2e` skill** dropped the requirement for pre-baked `tmux-*.ts` scripts. Phase 4 of `full` mode is now agent-driven: the executor (LLM agent or human) drives each CLI command interactively via `_tmux.ts` helpers.

### Fixed

- **`memory.save` slug double-prefix** — `type: 'user'` now produces `user/operator-likes-rust.md` (not `user/user-operator-likes-rust.md`).
- **`MemorySyncManager.flushTurn` race.** Concurrent flushes from rapid back-to-back turns are now serialized via a tail-promise queue (was coalescing onto the in-flight promise and missing writes from later turns).
- **`MemorySyncManager.init` unsafe cast.** Chain-sourced `dataDescription` is validated against `INTELLIGENT_DATA_SLOTS` before populating the diff cache.
- **`anima init` keystore-upload failure** now cancels the wizard cleanly (was writing config and printing success with an unrecoverable agent EOA).
- **`anima status`** renders the iNFT ref as `#tokenId at contract (network)` (was printing `[object Object]`).
- **`anima deploy`** no longer wastes an operator signature on a stub run — Phase 11 will wire the actual sandbox handoff.
- **`WalletConnect` connect-timeout handle** is now `clearTimeout`'d in a `finally`, preventing a 3-min handle from keeping the loop alive on early connect.
- **`memory.read` path traversal** prevented via `resolve()` + root-prefix guard.

### Removed

- **Passphrase prompts** from `init`, `chat`, `topup --compute`, `init --resume`. Operator wallet handles all decryption now. v0.5 users upgrade via `anima migrate-keystore`.

## [0.5.0] - 2026-04-24

### Added

- **Plural `OperatorSigner` implementations.** Four first-class wallet sources: `WalletConnectOperatorSigner` (QR-pair to any WC v2 mobile wallet via `@walletconnect/ethereum-provider`), `KeystoreFileOperatorSigner` (geth-format encrypted JSON), `RawPrivkeyOperatorSigner` (stdin prompt + `ANIMA_OPERATOR_PRIVKEY` env var for CI), and the polished `KeychainOperatorSigner` (macOS Keychain, now first-class not dev-only). Shared `PrivkeyOperatorSigner` base dedupes the viem plumbing across the three privkey-backed signers. WalletConnect project ID `974ed7663d88e07086104fa9a73b2d87` hardcoded (not a secret, overridable via `ANIMA_WC_PROJECT_ID`).
- **Storage-backed keystore recovery (closes section 22 spec gap).** `persistKeystoreToStorage` uploads the encrypted agent keystore blob to 0G Storage and anchors the storage root hash into the iNFT's `keystore` IntelligentData slot. New `anima restore <iNFT-ref>` command pulls the blob back and rebuilds the agent dir on a fresh machine with only the passphrase.
- **`anima topup` command.** Two modes: `--agent N` (operator sends N 0G to agent EOA) and `--compute N` (agent deposits N 0G into the 0G Compute ledger via `broker.ledger.depositFund`). Default (no flags) prints current balances and asks.
- **0G Compute ledger helpers.** `openComputeLedger` (addLedger or depositFund + acknowledgeProviderSigner), `getLedgerBalance`, `depositToLedger`. Brokers are cached per `network:privkey` so back-to-back calls don't re-handshake.
- **`AnimaAgentNFTReader` read-only client.** No privkey required for reads (`ownerOf`, `getSlotHash`, `getIntelligentData`); `AnimaAgentNFTClient` now extends it. Eliminates dummy-privkey hacks in restore/subname-availability paths.
- **Registrar read helpers.** `isLabelTaken(publicClient, label)` and `mainnetReadOnlyClient()` let the wizard probe subname availability without instantiating a privkey-backed client.
- **`networkFromChainId(id)` helper** for reverse chain-id → AnimaNetwork lookup.
- **Init wizard rewrite (Phase A/B/C/D).** Phase A: pick network, subname (with onchain availability check at pick time), model (moved from chat.tsx lazy first-launch into init), ledger size (Starter 3 / Standard 10 / Extended 30 / Custom), passphrase. Phase B: operator wallet source picker, cost summary with raw per-token pricing and $0.50/0G estimates, funding gate with operator-address QR + balance polling. Phase C: execute with Pattern B resumable state (`.anima-init-state.json` tracks each step, `anima init --resume` picks up at first incomplete step).
- **Persistent test agent.** `test/local/_helpers.ts` provides `loadOrCreateTestAgent()` so integration scripts reuse a funded test EOA across runs instead of generating fresh wallets every time — avoids burning faucet 0G on seed funding (feedback-reuse-test-agents.md).

### Changed

- **`anima init` funding bumped to 10.1 0G** (0.1 infra float + 10 0G compute ledger deposit) to cover the contract-enforced 3 0G minimum plus real runway. The previous 0.03 0G float was two orders of magnitude short.
- **`KeychainOperatorSigner` uses `spawnSync` with array args** instead of `execSync` with template interpolation, closing a command-injection surface introduced by the new wizard flow that prompts for user-chosen service names. Constructor and picker both validate service names against `/^[a-zA-Z0-9._-]{1,128}$/`.
- **`persistKeystoreToStorage`** takes `keystoreBytes: Uint8Array` instead of `keystorePath: string` — caller reads the file once and threads the bytes, avoiding a redundant read.
- **`restoreKeystoreFromStorage`** returns `{ rootHash, encryptedBytes, owner }` in one call via `AnimaAgentNFTReader`, replacing a dummy-privkey + separate `ownerOf` read.

### Fixed

- **Storage keystore persistence closes the "hybrid runtime hot copy + iNFT-metadata cold copy" spec gap** — before this release, the `keystore` iNFT slot held a keccak256 of the bytes (no recovery path). Now it holds a 0G Storage root hash that `anima restore` can resolve back to the encrypted blob.

## [0.4.0] - 2026-04-24

### Added

- **Two-wallet architecture (project-anima.md section 22.1 fully implemented).** Operator wallet (the human; dev pattern = macOS keychain-loaded `dev.deployer`, production = MetaMask/WalletConnect/hardware per `feedback-wallet-source-multi-option.md`) owns the iNFT. Agent EOA is a separate infra key, approved by the operator at mint time via `setApprovalForAll(agent, true)`. Agent pays gas for `update()` calls, subname claims, and memory-sync txs without the operator's key ever leaving its custody.
- **`OperatorSigner` interface + `KeychainOperatorSigner`** (`packages/core/src/operator/`). The interface is the extension point for MetaMask, hardware wallets, keystore files, env vars, etc.
- **`AnimaAgentNFT.update()` widened authorization.** Now accepts owner OR per-token approved OR operator approved for all (standard ERC-721 approval pattern). New tests `test_UpdateByOperatorApprovedForAllSucceeds` + `test_UpdateBySingleApprovalSucceeds` cover it. 27 forge tests, 100% coverage retained.
- **CLI `anima init` refactored:** loads operator via `KeychainOperatorSigner()`, generates fresh agent EOA, operator mints iNFT to itself + auto-approves agent, operator sends 0.03 0G to agent for ongoing infra, agent proceeds to claim subname + write text records with its own key.
- **`AnimaConfig.identity`** gains `operator` + `agent` fields so the config tracks who owns the iNFT separately from who pays infra.

### Changed

- **`AnimaAgentNFT` redeployed via CREATE2** to `0x9e71d79f06f956d4d2666b5c93dafab721c84721` (same address on mainnet + testnet). Required because the `update()` auth change modified bytecode.
- **`mintAgent` API rewritten.** Takes `operator: OperatorSigner` + `agentAddress: Address` instead of a single `privkeyHex`. Returns the operator's address as iNFT owner.
- Core package exports `MIN_GAS_PRICE`, `makeViemClients`, `ogChain`, `waitForReceiptResilient` so callers outside core (CLI, tests) can use the shared helpers.

### Removed

- Old CREATE2 `AnimaAgentNFT` deploy at `0xc2e3d0daac03fa525ebffa3ab0ddb80ef26fcc7f` (v0.3.0 single-wallet design). Tokens minted there are abandoned; new mints go to the v0.4.0 address.

## [0.3.0] - 2026-04-24

### Added

- **`AnimaSubnameRegistrar` contract** — permissionless `.anima.0g` subname issuer. Anyone can call `claim(label, owner)` and self-register under `anima.0g` without anima-inc's private key. dev.deployer pre-approves the registrar once via `SidRegistry.setApprovalForAll`; from then on the contract is fully autonomous.
  - Deployed via CREATE2 at `0x33d9f4ec2bd7e7cb4e288c3bbc3a76be472fdd98` on 0G mainnet.
  - Constructor enforces `registry.owner(ANIMA_NODE) == animaOwner_` (fails loud on namehash drift / wrong-chain deploy).
  - `isOperational()` re-reads the current anima.0g registry owner dynamically (correctly flips false if anima.0g is ever transferred).
  - 10 forge tests + mock registry, 100% coverage.
- **100% contract coverage** — 25 `AnimaAgentNFT` tests (added `test_UpdateLengthMismatchReverts`, `test_ITransferFromWrongFromReverts`, `test_ITransferFromNewHashesLengthMismatchReverts`, `test_ITransferFromByApprovedSucceeds`, `test_ITransferFromByOperatorSucceeds`, `test_TotalSupplyIncrementsAcrossMints`, `test_MintEmitsEvent`, `test_UpdateEmitsEvent`, `test_ITransferFromEmitsTransferredEvent`, `test_SetOracleEmitsOracleRotated`, `test_GetSlotHashMatchesIntelligentData`, `test_NonExistentTokenOwnerOfReverts`, `test_UpdateOnNonExistentTokenReverts`, `test_ITransferFromWithTamperedHashesReverts`, `test_ITransferFromWithCrossContractReplayReverts`) + 8 `AnimaSubnameRegistrar` tests. 33 forge tests total, 100% lines / statements / branches / functions on both contracts.
- **`AnimaRegistrarClient` TypeScript client** (`packages/core/src/naming/registrar.ts`) — viem-based `claim`, `isLabelTaken`, `isOperational`. Exported from `@s0nderlabs/anima-core`.

### Changed

- **CREATE2 for all contract deploys.** `AnimaAgentNFT` redeployed to `0xc2e3d0daac03fa525ebffa3ab0ddb80ef26fcc7f` on both mainnet + Galileo testnet (deterministic same-address). Salt: `keccak256("anima:AnimaAgentNFT:v1")`. `AnimaSubnameRegistrar` salt: `keccak256("anima:AnimaSubnameRegistrar:v1")`.
- **`anima init` subname flow now routes through the permissionless registrar.** Agent's own keystore claims its subname + writes its own text records. No anima-inc key needed on the caller side.
- **`ISidRegistry.setSubnodeRecord` return type corrected** — SANN's implementation returns void, not `bytes32`. Mismatch caused Solidity's ABI decoder to revert the first registrar deploy. Fixed + redeployed.
- **`syncMemory` uploads run sequentially** — reverted the earlier `Promise.all` parallelization because ethers auto-nonce management collides on concurrent writes from the same wallet (`nonce too low`). Correctness > speed; single batched `updateSlots` tx keeps on-chain cost bounded regardless.

### Removed

- Old CREATE-deployed `AnimaAgentNFT` instances (`0xf132201d895f9a5d8b8dc4af2f7f8f9fc45935b1` on testnet, `0x1a60a42c1f8620638c2eac56deb2a4dfa08ab232` on mainnet) are abandoned. They still exist on-chain but are no longer referenced by the CLI.
- Old CREATE-deployed `AnimaSubnameRegistrar` at `0xa22e03f7a4145bf4909a83595c90a38e14d79600`, the first broken CREATE2 deploy at `0x6a8ea050b08917de83883417fa588c76379b16c3`, and the pre-hardening deploy at `0xd32955ff38136bd4d2c62f9235194964b393efdd` are all revoked via `setApprovalForAll(op, false)` and no longer trusted.

## [0.2.1] - 2026-04-24

### Added

- `AnimaAgentNFT` deployed to 0G mainnet at `0x1a60a42c1f8620638c2eac56deb2a4dfa08ab232` (tx `0x81bfec81...`, ~$0.003 gas). Satisfies the hackathon requirement for a mainnet contract address + verifiable on-chain activity.

### Changed

- `ANIMA_AGENT_NFT_ADDRESS` mainnet entry populated; type tightened from `Address | null` to `Address` now that both networks are live.
- `anima init` + `mintAgent` drop the "deployed? fall back to note()" branch since both networks have a canonical address.

## [0.2.0] - 2026-04-24

### Added

- **Phase 4 — iNFT identity layer:**
  - `AnimaAgentNFT.sol` (ERC-7857) with per-token IntelligentData[] storage, owner-gated `update`, ECDSA-verified `iTransferFrom` with replay-protected proof (`consumedProofs` map + tokenId/chainid/contract/nonce in hash), owner-only global oracle rotation, `mint` taking canonical 6-slot `(memory-index, identity, persona, profile, keystore, activity-log)` layout per project-anima.md section 26.3.
  - Foundry tests: 10 cases covering mint, update, iTransfer authorization + replay + unauthorized caller, oracle rotation.
  - Deployed to 0G Galileo testnet at `0xf132201d895f9a5d8b8dc4af2f7f8f9fc45935b1`.
  - TypeScript client `AnimaAgentNFTClient` (viem-based) with `mint`, `updateSlots`, `getIntelligentData`, `ownerOf`.
  - `mintAgent` high-level flow + `iNFTAgentId` derivation.
  - `waitForReceiptResilient` helper tolerates 0G's eventually-consistent receipt RPC.
- **Phase 5 — 0G Storage backend:**
  - `OGStorage` adapter implementing `Storage` interface against `@0gfoundation/0g-ts-sdk` v1.2.4: real `putBlob`/`getBlob` via `Indexer.upload`/`downloadToBlob`, KV + activity-log semantics layered on blob sequence + KV manifest pattern per `0g-storage-sdk-verified.md`.
  - AES-256-GCM envelope encryption (`storage/encryption.ts`) keyed off operator passphrase with scrypt N=2^15, matching keystore parameters.
  - `syncMemory` uploads all changed memory files concurrently via `Promise.all`, then fires one batched `iNFT.update()` tx covering all affected slots.
- **Phase 6 — SPACE ID subname registrar:**
  - `SannClient` (viem, mainnet) with contract addresses discovered + verified on-chain (SANN `0x9af6F1244df...`, Registry `0x5dC881dDA4...`, Base.0g `0x75f7590Def...`, Resolver `0x6D3B3F99...`).
  - SANN-style `sannNamehash` + `subnameNode(label)` helpers for `<label>.anima.0g` namehash derivation.
  - `reclaimSubname` / `setSubnameResolver` / `setText` / `readText` covering subname issue + text record publish.
  - `CARD.md` parser + writer (gray-matter) + text-record mapping (`cardToTextRecords`).
- **Core plumbing:**
  - `packages/core/src/chain.ts` shared viem client factory + `ogChain(network)` + `MIN_GAS_PRICE` constant.
  - `AnimaConfig.identity.iNFT` now an `INFTRef { contract, tokenId, network }` struct instead of a raw string.
- **CLI wiring:**
  - `anima init` extended to detect agent EOA balance, prompt to mint iNFT on chosen network, prompt to register `<subname>.anima.0g` on mainnet, write all three results into `anima.config.ts`.
  - Fresh-wallet/no-balance path shows a helpful "fund me at 0x...; re-run" note and exits cleanly without mint or subname calls.

### Changed

- `biome.json` ignores `contracts/lib`, `broadcast`, and `anima.config.ts` so forge deps + generated artifacts don't pollute lint.
- `foundry.toml` `evm_version` raised to `cancun` (OpenZeppelin 5.x uses `mcopy`).
- Gitignore covers `broadcast/` + `contracts/lib/` so CI + fresh clones don't pick up generated Foundry output.

### Security

- `AnimaAgentNFT.iTransferFrom` now enforces `msg.sender == from || isApprovedForAll(from, msg.sender) || getApproved(tokenId) == msg.sender`, preventing a stranger holding only an oracle signature from moving someone else's iNFT. New regression test covers the stranger-caller case.

## [0.1.0] - 2026-04-24

### Added

- Bun + TypeScript workspace scaffold with biome, changesets, foundry, composite tsconfig, and GitHub Actions CI.
- `@s0nderlabs/anima-core` runtime package with:
  - Event queue + router + listener registry (`core/src/events/`).
  - Symbol-keyed `ToolRegistry` with glob enable/disable rules and precompiled regex cache.
  - Custom zod → OpenAI-compatible JSONSchema emitter (`tools/zod-schema.ts`).
  - `Brain` interface, `StubBrain`, and `OGComputeBrain` — multi-turn OpenAI-compat tool-calling against 0G Compute (broker-backed, ethers scoped to this module only).
  - Frozen prefix builder (`brain/frozen-prefix.ts`) memoized once per brain session for prompt-cache stability.
  - Typed memory layer: frontmatter parser (gray-matter), topic file atomic writes, MEMORY.md index with 200-line / 25KB cap, substring-based edit ops, threat-pattern scan (7 patterns covering injection, exfil, invisible unicode, transfer claims).
  - `memory.save` tool that auto-routes by type prefix to `/agent` or `/user` partition and updates the index atomically.
  - `Storage` interface + `LocalStubStorage` (local-disk KV/Log/Blob stub for phases before 0G Storage wiring).
  - Wallet module: viem-based key gen/derive, AES-256-GCM + scrypt encrypted keystore.
  - `Runtime` class wiring queue + router + brain + tools + memory + activity log.
  - Path resolution via `ANIMA_ROOT` env for test isolation (no more pollution of real `~/.anima`).
- `@s0nderlabs/anima-cli` with:
  - `anima init` clack wizard (network + subname + passphrase → generates agent EOA keystore + `anima.config.ts`).
  - `anima status` — config + agent state + balance probe via viem PublicClient.
  - `anima logs` — activity log tail with timestamp + kind formatting.
  - `anima` default — interactive chat with live model picker from `broker.inference.listService()`.
  - OpenTUI + Solid reactive chat UI (`ui/app.tsx`, `ui/state.ts`) with scrollable rows, bordered input, usage counter.
  - Shared `_agents.ts` and `config/render.ts` utilities consumed by multiple commands.
- Stub packages for future phases: `plugin-onchain`, `plugin-comms`, `plugin-system`.
- 31 unit tests covering memory ops, tool registry, event queue, wallet encryption, runtime boot, frozen prefix.
- End-to-end verified on 0G mainnet: agent init → GLM-5 chat → `memory.save` tool call → memory file + index persisted, with ~57% prompt-cache hit on follow-up turns.

[0.6.1]: https://github.com/s0nderlabs/anima/releases/tag/v0.6.1
[0.6.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.6.0
[0.5.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.5.0
[0.4.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.4.0
[0.3.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.3.0
[0.2.1]: https://github.com/s0nderlabs/anima/releases/tag/v0.2.1
[0.2.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.2.0
[0.1.0]: https://github.com/s0nderlabs/anima/releases/tag/v0.1.0
